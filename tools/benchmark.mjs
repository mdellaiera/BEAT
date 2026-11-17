// Stress test: degrade the MIT clip in controlled ways and see which
// estimators still find the heart rate. Needs ffmpeg on PATH.
//
//   node tools/benchmark.mjs [clip]
//
// There is no contact sensor recording for this clip, so the reference is the
// rate on which all four estimators agree on the clean clip. Each condition is
// repeated with fresh random disturbances; a trial counts as a hit when the
// estimate lands within 3 bpm of the reference.

import { execFileSync } from 'node:child_process';
import { reduceFrame } from '../src/core/pyramid.js';
import { analyze } from '../src/core/rppg.js';

const clip = process.argv[2] ?? 'data/face.mp4';
const TRIALS = 50;

const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', clip]).toString().trim().split(',');
const W = +out[0], H = +out[1], fs = eval(out[2]);
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
  { maxBuffer: 4 * 1024 ** 3 });
const T = Math.floor(raw.length / (W * H * 3));
let clean;
for (let t = 0; t < T; t++) {
  const r = reduceFrame(raw.subarray(t * W * H * 3, (t + 1) * W * H * 3), W, H, 3, 4);
  clean ??= { data: new Float32Array(T * r.w * r.h * 3), T, w: r.w, h: r.h };
  clean.data.set(r.data, t * r.w * r.h * 3);
}
const n = clean.w * clean.h;

// Deterministic random numbers so runs are repeatable.
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const copy = () => ({ ...clean, data: clean.data.slice() });

const conditions = {
  'clean clip': () => copy(),
  // Sensor noise, independent per cell and frame (sigma in 8-bit levels).
  'sensor noise, sigma 2': () => noise(2),
  'sensor noise, sigma 4': () => noise(4),
  'sensor noise, sigma 8': () => noise(8),
  // Room light wobbling by 1% at a random in-band rate.
  'light flicker 1%': () => {
    const low = copy();
    const f = 1.1 + 1.5 * rand(), ph = 2 * Math.PI * rand();
    for (let t = 0; t < T; t++) {
      const g = 1 + 0.01 * Math.sin((2 * Math.PI * f * t) / fs + ph);
      for (let i = 0; i < n * 3; i++) low.data[t * n * 3 + i] *= g;
    }
    return low;
  },
  // 40% of the frame picks up a coloured in-band disturbance of 2 levels,
  // as a moving shadow, a screen reflection or a badly tracked region would.
  'disturbed region, 40% of cells': () => {
    const low = copy();
    const x0 = Math.floor(rand() * clean.w), span = Math.ceil(0.4 * clean.w);
    const f = 1.1 + 1.5 * rand(), ph = 2 * Math.PI * rand();
    const amp = [gauss(), gauss(), gauss()].map((v) => (2 * v) / 255);
    for (let i = 0; i < n; i++) {
      if (((i % clean.w) - x0 + clean.w) % clean.w >= span) continue;
      for (let t = 0; t < T; t++) {
        const s = Math.sin((2 * Math.PI * f * t) / fs + ph);
        for (let c = 0; c < 3; c++) low.data[(t * n + i) * 3 + c] += amp[c] * s;
      }
    }
    return low;
  },
};

function noise(sigma) {
  const low = copy();
  for (let i = 0; i < low.data.length; i++) low.data[i] += (sigma / 255) * gauss();
  return low;
}

const reference = analyze(clean, fs).bpm;
console.log(`${clip}: reference ${reference.toFixed(1)} bpm, ${TRIALS} trials per condition`);
console.log('hit rate within 3 bpm (mean absolute error in bpm)\n');
const names = ['green', 'chrom', 'pos', 'beat'];
for (const prior of [true, false]) {
  console.log(prior ? '-- skin region found by colour --' : '-- no skin detection: every cell is a candidate --');
  console.log(''.padEnd(32) + names.map((s) => s.padStart(14)).join(''));
  for (const [label, make] of Object.entries(conditions)) {
    const hits = Object.fromEntries(names.map((k) => [k, 0]));
    const err = Object.fromEntries(names.map((k) => [k, 0]));
    const trials = label === 'clean clip' ? 1 : TRIALS;
    for (let k = 0; k < trials; k++) {
      const res = analyze(make(), fs, { skinPrior: prior });
      for (const m of names) {
        const e = Math.abs(res.methods[m].bpm - reference);
        err[m] += Number.isFinite(e) ? e : 100;
        if (e <= 3) hits[m]++;
      }
    }
    const cells = names.map((m) =>
      `${((100 * hits[m]) / trials).toFixed(0).padStart(4)}% (${(err[m] / trials).toFixed(1).padStart(4)})`.padStart(14));
    console.log(label.padEnd(32) + cells.join(''));
  }
  console.log();
}
