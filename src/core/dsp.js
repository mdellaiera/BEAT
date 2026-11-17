// Small, dependency-free signal-processing toolbox shared by the browser app
// and the Node validation tools.

export function mean(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / x.length;
}

export function std(x) {
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - m) * (x[i] - m);
  return Math.sqrt(s / x.length);
}

/** Zero-mean, unit-variance copy of x (all zeros if x is constant). */
export function standardize(x) {
  const m = mean(x);
  const s = std(x);
  const y = new Float64Array(x.length);
  if (s > 0) for (let i = 0; i < x.length; i++) y[i] = (x[i] - m) / s;
  return y;
}

/** Pearson correlation of two standardized signals. */
export function corrStd(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 FFT. re/im lengths must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// 2nd-order Butterworth sections (bilinear transform).
function biquad(type, fc, fs) {
  const K = Math.tan((Math.PI * fc) / fs);
  const norm = 1 / (1 + Math.SQRT2 * K + K * K);
  const a1 = 2 * (K * K - 1) * norm;
  const a2 = (1 - Math.SQRT2 * K + K * K) * norm;
  if (type === 'low') return { b0: K * K * norm, b1: 2 * K * K * norm, b2: K * K * norm, a1, a2 };
  return { b0: norm, b1: -2 * norm, b2: norm, a1, a2 };
}

function runBiquad(c, x) {
  const y = new Float64Array(x.length);
  // Start in steady state for the first sample to limit the edge transient.
  const g = (c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2);
  let x1 = x[0], x2 = x[0], y1 = g * x[0], y2 = g * x[0];
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * Zero-phase Butterworth band-pass (forward-backward, odd-reflection padding).
 * Effective order is 4 on each edge.
 */
export function bandpass(x, fs, fLow, fHigh) {
  const n = x.length;
  const pad = Math.min(n - 1, Math.round((3 * fs) / fLow));
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    ext[i] = 2 * x[0] - x[pad - i];
    ext[n + pad + i] = 2 * x[n - 1] - x[n - 2 - i];
  }
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  const sections = [biquad('high', fLow, fs), biquad('low', fHigh, fs)];
  let y = ext;
  for (const c of sections) y = runBiquad(c, y);
  y.reverse();
  for (const c of sections) y = runBiquad(c, y);
  y.reverse();
  return y.slice(pad, pad + n);
}

/**
 * Hann-windowed, zero-padded periodogram.
 * Returns { freq, power } for bins up to fMax.
 */
export function periodogram(x, fs, { nfft = 4096, fMax = 5 } = {}) {
  const n = x.length;
  const N = Math.max(nfft, nextPow2(n));
  const re = new Float64Array(N), im = new Float64Array(N);
  const m = mean(x);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    re[i] = (x[i] - m) * w;
  }
  fft(re, im);
  const bins = Math.min(N / 2, Math.floor((fMax * N) / fs) + 1);
  const freq = new Float64Array(bins), power = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    freq[k] = (k * fs) / N;
    power[k] = re[k] * re[k] + im[k] * im[k];
  }
  return { freq, power };
}

function interpPower(spec, f) {
  const df = spec.freq[1] - spec.freq[0];
  const p = f / df;
  const i = Math.floor(p);
  if (i < 0 || i + 1 >= spec.power.length) return 0;
  return spec.power[i] + (p - i) * (spec.power[i + 1] - spec.power[i]);
}

/**
 * Pick the pulse frequency from a periodogram.
 * Strong local maxima in [fLow, fHigh] are scored by their own power plus half
 * the power at their second harmonic, which a real pulse wave has and most
 * disturbances do not. The winner is refined by parabolic interpolation.
 */
export function pulseFrequency(spec, fLow = 0.7, fHigh = 3.5) {
  const { freq, power } = spec;
  let pMax = 0;
  for (let k = 1; k < freq.length - 1; k++) {
    if (freq[k] >= fLow && freq[k] <= fHigh && power[k] > pMax) pMax = power[k];
  }
  if (!(pMax > 0)) return NaN;
  let best = -1, bestScore = -1;
  for (let k = 1; k < freq.length - 1; k++) {
    if (freq[k] < fLow || freq[k] > fHigh) continue;
    if (power[k] < power[k - 1] || power[k] < power[k + 1]) continue;
    if (power[k] < 0.5 * pMax) continue;
    const score = power[k] + 0.5 * interpPower(spec, 2 * freq[k]);
    if (score > bestScore) { bestScore = score; best = k; }
  }
  if (best < 0) return NaN;
  const a = power[best - 1], b = power[best], c = power[best + 1];
  const d = a - 2 * b + c;
  const shift = d !== 0 ? (0.5 * (a - c)) / d : 0;
  return freq[best] + shift * (freq[1] - freq[0]);
}

/**
 * Pulse signal-to-noise ratio in dB (de Haan & Jeanne, 2013): power around the
 * fundamental (+-0.1 Hz) and second harmonic (+-0.2 Hz) over the remaining
 * power in [fLow, fHigh].
 */
export function pulseSnr(spec, f0, fLow = 0.7, fHigh = 4) {
  let sig = 0, noise = 0;
  for (let k = 0; k < spec.freq.length; k++) {
    const f = spec.freq[k];
    if (f < fLow || f > fHigh) continue;
    if (Math.abs(f - f0) <= 0.1 || Math.abs(f - 2 * f0) <= 0.2) sig += spec.power[k];
    else noise += spec.power[k];
  }
  return 10 * Math.log10(sig / Math.max(noise, 1e-30));
}

/**
 * Locate individual beats as peaks of the pulse wave, with sub-frame timing.
 * The wave is first narrowed around the fundamental so that the dicrotic
 * notch cannot produce double detections.
 */
export function detectBeats(pulse, fs, f0) {
  const x = bandpass(pulse, fs, Math.max(0.5, 0.6 * f0), 1.6 * f0);
  const minGap = (0.6 * fs) / f0;
  const peaks = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] <= 0 || x[i] < x[i - 1] || x[i] <= x[i + 1]) continue;
    const d = x[i - 1] - 2 * x[i] + x[i + 1];
    const t = i + (d !== 0 ? (0.5 * (x[i - 1] - x[i + 1])) / d : 0);
    if (peaks.length && t - peaks[peaks.length - 1].t < minGap) {
      if (x[i] > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { t, v: x[i] };
    } else {
      peaks.push({ t, v: x[i] });
    }
  }
  return peaks.map((p) => p.t / fs);
}
