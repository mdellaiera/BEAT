// Colour magnification. Both variants produce a low-resolution RGB "delta"
// clip that is upsampled and added to the original frames at display time.

import { bandpass, standardize } from './dsp.js';

// NTSC YIQ, as used by MATLAB's rgb2ntsc / ntsc2rgb.
const RGB2YIQ = [0.299, 0.587, 0.114, 0.596, -0.274, -0.322, 0.211, -0.523, 0.312];
const YIQ2RGB = [1, 0.956, 0.621, 1, -0.272, -0.647, 1, -1.106, 1.703];

/**
 * Eulerian Video Magnification as published (Wu et al., SIGGRAPH 2012), colour
 * variant: Gaussian-pyramid level -> ideal temporal band-pass -> amplify in
 * YIQ -> add back.
 *
 * Faithful to the reference MATLAB code, including the fact that its ideal
 * filter keeps positive DFT bins only and then takes the real part, which
 * halves the amplitude (alpha = 50 acts like a gain of 25).
 *
 * `frames` limits the filter to the first N frames; the reference script
 * dropped the last 10 frames of each clip.
 */
export function magnifyEVM(low, fs, { fLow, fHigh, alpha, chromAttenuation = 1, frames = low.T }) {
  const { data, T, h, w } = low;
  const n = h * w;
  const N = Math.min(frames, T);
  const bins = [];
  for (let k = 0; k < N; k++) {
    const f = (k * fs) / N;
    if (f > fLow && f < fHigh) bins.push(k);
  }
  const delta = new Float32Array(T * n * 3);
  const cosT = bins.map((k) => Float64Array.from({ length: N }, (_, t) => Math.cos((2 * Math.PI * k * t) / N)));
  const sinT = bins.map((k) => Float64Array.from({ length: N }, (_, t) => Math.sin((2 * Math.PI * k * t) / N)));
  const yiq = new Float64Array(3), out = new Float64Array(3);
  const gain = [alpha, alpha * chromAttenuation, alpha * chromAttenuation];
  for (let i = 0; i < n; i++) {
    for (let b = 0; b < bins.length; b++) {
      // DFT coefficient of each YIQ channel at this bin.
      const re = [0, 0, 0], im = [0, 0, 0];
      for (let t = 0; t < N; t++) {
        const o = (t * n + i) * 3;
        const r = data[o], g = data[o + 1], bl = data[o + 2];
        for (let c = 0; c < 3; c++) {
          const v = RGB2YIQ[c * 3] * r + RGB2YIQ[c * 3 + 1] * g + RGB2YIQ[c * 3 + 2] * bl;
          re[c] += v * cosT[b][t];
          im[c] -= v * sinT[b][t];
        }
      }
      for (let t = 0; t < N; t++) {
        for (let c = 0; c < 3; c++) {
          yiq[c] = (gain[c] * (re[c] * cosT[b][t] - im[c] * sinT[b][t])) / N;
        }
        const o = (t * n + i) * 3;
        for (let c = 0; c < 3; c++) {
          out[c] = YIQ2RGB[c * 3] * yiq[0] + YIQ2RGB[c * 3 + 1] * yiq[1] + YIQ2RGB[c * 3 + 2] * yiq[2];
          delta[o + c] += out[c];
        }
      }
    }
  }
  return delta;
}

function smooth3(src, w, h) {
  const dst = new Float32Array(src.length);
  const k = [0.25, 0.5, 0.25];
  const tmp = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -1; d <= 1; d++) s += k[d + 1] * src[y * w + Math.min(w - 1, Math.max(0, x + d))];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -1; d <= 1; d++) s += k[d + 1] * tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x];
      dst[y * w + x] = s;
    }
  }
  return dst;
}

/**
 * Pulse-locked magnification (BEAT).
 *
 * Instead of amplifying whatever each pixel does inside a hand-picked band,
 * amplify only the part of each pixel that follows the measured pulse:
 *
 *   delta_c(x, t) = alpha * gate(x) * beta_c(x) * p(t)
 *
 * p is the fused pulse wave, beta_c(x) the least-squares gain of channel c of
 * cell x on p, and gate(x) fades out cells whose own signal does not correlate
 * with the pulse. Noise that is merely in-band is not amplified, no frequency
 * band has to be chosen, and the waveform keeps its harmonics and its
 * beat-to-beat variation.
 */
export function magnifyPulse(low, fs, analysis, { alpha }) {
  const { data, T, h, w } = low;
  const n = h * w;
  const f0 = analysis.bpm / 60;
  // Fundamental plus second harmonic: keeps the pulse shape, drops the rest.
  const p = standardize(bandpass(analysis.pulse, fs, Math.max(0.5, 0.6 * f0), 2.6 * f0));
  const gateRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = analysis.corr[i];
    const u = Math.min(1, Math.max(0, (c - 0.15) / 0.25));
    gateRaw[i] = analysis.weights[i] > 0 ? u * u * (3 - 2 * u) : 0;
  }
  const gate = smooth3(gateRaw, w, h);
  const beta = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    if (gate[i] === 0) continue;
    let br = 0, bg = 0, bb = 0;
    for (let t = 0; t < T; t++) {
      const o = (t * n + i) * 3;
      br += data[o] * p[t]; bg += data[o + 1] * p[t]; bb += data[o + 2] * p[t];
    }
    // p is zero-mean with unit variance, so sum(p^2) = T.
    beta[0][i] = br / T; beta[1][i] = bg / T; beta[2][i] = bb / T;
  }
  const delta = new Float32Array(T * n * 3);
  for (let c = 0; c < 3; c++) {
    const b = smooth3(beta[c], w, h);
    for (let i = 0; i < n; i++) {
      const a = alpha * gate[i] * b[i];
      if (a === 0) continue;
      for (let t = 0; t < T; t++) delta[(t * n + i) * 3 + c] = a * p[t];
    }
  }
  return { delta, gate };
}

/**
 * Bilinear upsampler for low-resolution delta frames. Build once per output
 * size, then call apply() per frame.
 */
export function makeCompositor(w, h, W, H) {
  const x0 = new Int32Array(W), x1 = new Int32Array(W), fx = new Float32Array(W);
  const y0 = new Int32Array(H), y1 = new Int32Array(H), fy = new Float32Array(H);
  for (let X = 0; X < W; X++) {
    const u = Math.min(w - 1, Math.max(0, ((X + 0.5) * w) / W - 0.5));
    x0[X] = Math.floor(u); x1[X] = Math.min(w - 1, x0[X] + 1); fx[X] = u - x0[X];
  }
  for (let Y = 0; Y < H; Y++) {
    const v = Math.min(h - 1, Math.max(0, ((Y + 0.5) * h) / H - 0.5));
    y0[Y] = Math.floor(v); y1[Y] = Math.min(h - 1, y0[Y] + 1); fy[Y] = v - y0[Y];
  }
  /**
   * Add frame `t` of `delta` (scaled by `gain`) to 8-bit RGBA `pixels` in place.
   */
  function apply(pixels, delta, t, gain = 1) {
    const base = t * w * h * 3;
    const s = 255 * gain;
    for (let Y = 0; Y < H; Y++) {
      const ra = base + y0[Y] * w * 3, rb = base + y1[Y] * w * 3, wy = fy[Y];
      for (let X = 0; X < W; X++) {
        const a = x0[X] * 3, b = x1[X] * 3, wx = fx[X];
        const o = (Y * W + X) * 4;
        for (let c = 0; c < 3; c++) {
          const top = delta[ra + a + c] + wx * (delta[ra + b + c] - delta[ra + a + c]);
          const bot = delta[rb + a + c] + wx * (delta[rb + b + c] - delta[rb + a + c]);
          // Uint8ClampedArray clamps and rounds on assignment.
          pixels[o + c] += s * (top + wy * (bot - top));
        }
      }
    }
  }
  return { apply };
}
