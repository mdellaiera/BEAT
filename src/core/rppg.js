// Remote photoplethysmography: recover the cardiac pulse from skin colour.
//
// Three published baselines (GREEN, CHROM, POS) run on the spatial mean of the
// skin region. The BEAT estimator instead treats every low-resolution cell as
// its own sensor and fuses them by how well each one agrees with the others.

import {
  mean, std, standardize, corrStd, bandpass, periodogram,
  pulseFrequency, pulseSnr, detectBeats,
} from './dsp.js';

export const BAND = { low: 0.7, high: 3.5 }; // 42 - 210 bpm

/** Loose skin-tone test in YCbCr on the temporal mean colour of each cell. */
function skinMask(low) {
  const { data, T, h, w } = low;
  const n = h * w;
  const mask = new Uint8Array(n);
  const avg = new Float64Array(n * 3);
  for (let t = 0; t < T; t++) {
    const base = t * n * 3;
    for (let i = 0; i < n * 3; i++) avg[i] += data[base + i];
  }
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = (avg[i * 3] / T) * 255, g = (avg[i * 3 + 1] / T) * 255, b = (avg[i * 3 + 2] / T) * 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (y > 40 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) { mask[i] = 1; count++; }
  }
  // Without a usable skin prior every cell stays a candidate; the fusion
  // weights then do all of the selection.
  if (count < Math.max(8, 0.01 * n)) mask.fill(1);
  return mask;
}

function cellTrace(low, i) {
  const { data, T, h, w } = low;
  const n = h * w;
  const r = new Float64Array(T), g = new Float64Array(T), b = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const o = (t * n + i) * 3;
    r[t] = data[o]; g[t] = data[o + 1]; b[t] = data[o + 2];
  }
  return { r, g, b };
}

function regionTrace(low, mask) {
  const { data, T, h, w } = low;
  const n = h * w;
  const r = new Float64Array(T), g = new Float64Array(T), b = new Float64Array(T);
  let count = 0;
  for (let i = 0; i < n; i++) count += mask[i];
  for (let t = 0; t < T; t++) {
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const o = (t * n + i) * 3;
      sr += data[o]; sg += data[o + 1]; sb += data[o + 2];
    }
    r[t] = sr / count; g[t] = sg / count; b[t] = sb / count;
  }
  return { r, g, b };
}

/** GREEN (Verkruysse et al., 2008): the green channel alone. */
export function green({ g }) {
  const m = mean(g);
  return g.map((v) => v / m - 1);
}

/** CHROM (de Haan & Jeanne, 2013): chrominance difference signal. */
export function chrom({ r, g, b }, fs) {
  const mr = mean(r), mg = mean(g), mb = mean(b);
  const T = r.length;
  const xs = new Float64Array(T), ys = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const rn = r[t] / mr, gn = g[t] / mg, bn = b[t] / mb;
    xs[t] = 3 * rn - 2 * gn;
    ys[t] = 1.5 * rn + gn - 1.5 * bn;
  }
  const xf = bandpass(xs, fs, BAND.low, BAND.high);
  const yf = bandpass(ys, fs, BAND.low, BAND.high);
  const alpha = std(xf) / (std(yf) || 1);
  return xf.map((v, t) => v - alpha * yf[t]);
}

/** POS (Wang et al., 2017): plane-orthogonal-to-skin, 1.6 s sliding windows. */
export function pos({ r, g, b }, fs) {
  const T = r.length;
  const l = Math.min(T, Math.max(2, Math.round(1.6 * fs)));
  const out = new Float64Array(T);
  const s1 = new Float64Array(l), s2 = new Float64Array(l);
  for (let t0 = 0; t0 + l <= T; t0++) {
    let mr = 0, mg = 0, mb = 0;
    for (let k = 0; k < l; k++) { mr += r[t0 + k]; mg += g[t0 + k]; mb += b[t0 + k]; }
    if (mr <= 0 || mg <= 0 || mb <= 0) continue;
    let m1 = 0, m2 = 0;
    for (let k = 0; k < l; k++) {
      const rn = (r[t0 + k] * l) / mr, gn = (g[t0 + k] * l) / mg, bn = (b[t0 + k] * l) / mb;
      s1[k] = gn - bn;
      s2[k] = gn + bn - 2 * rn;
      m1 += s1[k]; m2 += s2[k];
    }
    m1 /= l; m2 /= l;
    let v1 = 0, v2 = 0;
    for (let k = 0; k < l; k++) {
      v1 += (s1[k] - m1) * (s1[k] - m1);
      v2 += (s2[k] - m2) * (s2[k] - m2);
    }
    const a = v2 > 0 ? Math.sqrt(v1 / v2) : 0;
    for (let k = 0; k < l; k++) out[t0 + k] += s1[k] - m1 + a * (s2[k] - m2);
  }
  return out;
}

function summarize(raw, fs) {
  const signal = standardize(bandpass(raw, fs, BAND.low, BAND.high));
  const spectrum = periodogram(signal, fs);
  const f0 = pulseFrequency(spectrum, BAND.low, BAND.high);
  return { signal, spectrum, bpm: 60 * f0, snr: pulseSnr(spectrum, f0) };
}

/**
 * BEAT fusion.
 *
 * Model: every skin cell i observes the same pulse p(t) with its own gain and
 * its own noise. Each cell is first projected with POS on its own, giving a
 * standardized candidate s_i that is already insensitive to brightness
 * changes. Given p, the correlation c_i = corr(s_i, p) measures that cell's
 * quality, and the maximum-ratio-combining weight for a standardized signal
 * is c_i / (1 - c_i^2). Given the weights, the cells' normalized colour traces
 * are averaged and projected once more to give a better p. Alternating the
 * two converges in a few rounds.
 *
 * The starting point matters, because a strong disturbance shared by part of
 * the frame is also a consistent signal. Disturbances are much larger than a
 * pulse, so the first estimate uses only cells whose in-band energy is not an
 * outlier (at most 3x the median cell).
 *
 * Averaging colour before the final projection keeps the estimator linear in
 * the cells, so it degrades towards plain POS instead of chasing noise. Two
 * guards make that explicit: cells whose correlation is within the noise floor
 * get zero weight, and if no more cells clear the floor than chance alone
 * would explain, the weights are abandoned and the starting estimate is kept.
 * The same happens if the fused wave ends up with a lower pulse SNR.
 */
function fuse(low, mask, fs) {
  const { T } = low;
  const n = low.h * low.w;
  const cells = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const trace = cellTrace(low, i);
    const raw = bandpass(pos(trace, fs), fs, BAND.low, BAND.high);
    const energy = std(raw);
    if (!(energy > 0)) continue;
    for (const ch of [trace.r, trace.g, trace.b]) {
      const m = mean(ch);
      for (let t = 0; t < T; t++) ch[t] /= m;
    }
    cells.push({ i, s: standardize(raw), trace, energy });
  }
  const project = (weightOf) => {
    const r = new Float64Array(T), g = new Float64Array(T), b = new Float64Array(T);
    let used = 0;
    for (const cell of cells) {
      const wgt = weightOf(cell);
      if (wgt === 0) continue;
      used++;
      for (let t = 0; t < T; t++) {
        r[t] += wgt * cell.trace.r[t]; g[t] += wgt * cell.trace.g[t]; b[t] += wgt * cell.trace.b[t];
      }
    }
    return { used, pulse: used ? standardize(bandpass(pos({ r, g, b }, fs), fs, BAND.low, BAND.high)) : null };
  };
  if (!cells.length) return { pulse: new Float64Array(T), weights: new Float32Array(n), corr: new Float32Array(n), fused: false };
  const sorted = cells.map((c) => c.energy).sort((a, b) => a - b);
  const limit = 3 * sorted[sorted.length >> 1];
  const init = project((cell) => (cell.energy <= limit ? 1 : 0)).pulse;
  // Correlation of pure band-limited noise has std ~ 1/sqrt(2*B*duration).
  const dof = Math.max(4, 2 * (BAND.high - BAND.low) * (T / fs));
  const floor = 2 / Math.sqrt(dof);
  // About 2% of pure-noise cells clear a two-sigma floor by chance, so fewer
  // than 10% of cells in agreement is not evidence of anything.
  const minSupport = Math.max(3, 0.1 * cells.length);
  const refine = (start) => {
    const weights = new Float32Array(n), corr = new Float32Array(n);
    let p = start, support = 0;
    for (let iter = 0; iter < 8; iter++) {
      const next = project((cell) => {
        const c = Math.min(corrStd(cell.s, p), 0.98);
        corr[cell.i] = c;
        return (weights[cell.i] = c > floor ? c / (1 - c * c) : 0);
      });
      support = next.used;
      if (support < minSupport) return null;
      p = next.pulse;
    }
    return { pulse: p, weights, corr, support, fused: true };
  };
  const best = refine(init);
  // Do no harm: keep the fused wave only if it is at least as clean a pulse
  // as the starting estimate.
  const quality = (x) => {
    const spec = periodogram(x, fs);
    return pulseSnr(spec, pulseFrequency(spec, BAND.low, BAND.high));
  };
  if (best && quality(best.pulse) >= quality(init)) return best;
  const weights = new Float32Array(n);
  for (const cell of cells) weights[cell.i] = cell.energy <= limit ? 1 : 0;
  return { pulse: init, weights, corr: new Float32Array(n), fused: false };
}

/**
 * Full analysis of a low-resolution clip.
 * @param low {data: Float32Array(T*h*w*3) RGB in [0,1], T, h, w}
 * @param fs  frames per second
 * @param opts.skinPrior set false to treat every cell as a candidate
 */
export function analyze(low, fs, { skinPrior = true } = {}) {
  const skin = skinPrior ? skinMask(low) : new Uint8Array(low.h * low.w).fill(1);
  const region = regionTrace(low, skin);
  const methods = {
    green: summarize(green(region), fs),
    chrom: summarize(chrom(region, fs), fs),
    pos: summarize(pos(region, fs), fs),
  };
  const fused = fuse(low, skin, fs);
  methods.beat = summarize(fused.pulse, fs);
  const f0 = methods.beat.bpm / 60;
  const beats = Number.isFinite(f0) ? detectBeats(methods.beat.signal, fs, f0) : [];
  return {
    fs, skin, methods,
    weights: fused.weights,
    fused: fused.fused,
    corr: fused.corr,
    pulse: methods.beat.signal,
    bpm: methods.beat.bpm,
    snr: methods.beat.snr,
    beats,
  };
}
