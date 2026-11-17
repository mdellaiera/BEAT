// Offline check of the core algorithms on the MIT clip. Needs ffmpeg on PATH.
//
//   node tools/validate.mjs [clip] [mit-result]
//
// Prints the heart rate and pulse SNR of every estimator, then compares our
// re-implementation of Eulerian Video Magnification, and the BEAT
// magnification, against the result video published by MIT.

import { execFileSync } from 'node:child_process';
import { reduceFrame } from '../src/core/pyramid.js';
import { analyze } from '../src/core/rppg.js';
import { magnifyEVM, magnifyPulse } from '../src/core/magnify.js';

const clip = process.argv[2] ?? 'data/face.mp4';
const reference = process.argv[3] ?? 'data/face-ideal-from-0.83333-to-1-alpha-50-level-4-chromAtn-1.mp4';
const LEVELS = 4;

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', file]).toString().trim();
  const [w, h, rate] = out.split(',');
  const [num, den] = rate.split('/').map(Number);
  return { w: +w, h: +h, fs: num / (den || 1) };
}

function decode(file, { w, h }) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { maxBuffer: 4 * 1024 ** 3 });
  const size = w * h * 3;
  return Array.from({ length: Math.floor(raw.length / size) }, (_, t) => raw.subarray(t * size, (t + 1) * size));
}

function reduceClip(frames, w, h) {
  let low;
  frames.forEach((frame, t) => {
    const r = reduceFrame(frame, w, h, 3, LEVELS);
    low ??= { data: new Float32Array(frames.length * r.w * r.h * 3), T: frames.length, w: r.w, h: r.h };
    low.data.set(r.data, t * r.w * r.h * 3);
  });
  return low;
}

const info = probe(clip);
const frames = decode(clip, info);
const low = reduceClip(frames, info.w, info.h);
console.log(`${clip}: ${frames.length} frames, ${info.w}x${info.h} @ ${info.fs} fps -> ${low.w}x${low.h} cells`);

const t0 = performance.now();
const res = analyze(low, info.fs);
console.log(`analysis took ${(performance.now() - t0).toFixed(0)} ms\n`);

console.log('method   bpm     SNR (dB)');
for (const [name, m] of Object.entries(res.methods)) {
  console.log(`${name.padEnd(8)} ${m.bpm.toFixed(1).padStart(5)}   ${m.snr.toFixed(1).padStart(6)}`);
}
const used = res.weights.reduce((s, v) => s + (v > 0), 0);
const skin = res.skin.reduce((s, v) => s + v, 0);
const ibi = res.beats.slice(1).map((t, i) => 60 / (t - res.beats[i]));
console.log(`\nskin cells ${skin}, cells kept by fusion ${used}`);
console.log(`${res.beats.length} beats, beat-to-beat bpm: ${ibi.map((v) => v.toFixed(0)).join(' ')}`);

// --- Magnification ---------------------------------------------------------
const ref = decode(reference, info);
const N = ref.length; // the reference script dropped the last 10 frames
const evm = magnifyEVM(low, info.fs, { fLow: 50 / 60, fHigh: 60 / 60, alpha: 50, frames: N });
const beat = magnifyPulse(low, info.fs, res, { alpha: 50 });

// Agreement between what MIT added to the clip and what we add, measured at
// pyramid resolution. The published file carries a constant brightness offset
// from its encoding chain, so the temporal mean is removed first.
const lowRef = reduceClip(ref, info.w, info.h);
const n = low.w * low.h;
let sxy = 0, sxx = 0, syy = 0;
for (let j = 0; j < n * 3; j++) {
  let m = 0;
  for (let t = 0; t < N; t++) m += lowRef.data[t * n * 3 + j] - low.data[t * n * 3 + j];
  m /= N;
  for (let t = 0; t < N; t++) {
    const a = lowRef.data[t * n * 3 + j] - low.data[t * n * 3 + j] - m;
    const b = evm[t * n * 3 + j];
    sxy += a * b; sxx += a * a; syy += b * b;
  }
}
console.log(`\nEVM reproduction vs MIT result (${N} frames):`);
console.log(`  correlation of added signal: ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`);
console.log(`  amplitude ratio ours / MIT:  ${Math.sqrt(syy / sxx).toFixed(3)}`);

// Where does the amplification go? RMS of the added signal on fused skin
// cells versus everywhere else, at pyramid resolution.
function split(delta) {
  let on = 0, off = 0, nOn = 0, nOff = 0;
  for (let t = 0; t < N; t++) {
    for (let i = 0; i < n; i++) {
      const o = (t * n + i) * 3;
      const e = delta[o] ** 2 + delta[o + 1] ** 2 + delta[o + 2] ** 2;
      if (res.weights[i] > 0) { on += e; nOn++; } else { off += e; nOff++; }
    }
  }
  return { skin: 255 * Math.sqrt(on / nOn / 3), rest: 255 * Math.sqrt(off / nOff / 3) };
}
for (const [name, d] of [['EVM (MIT 2012)', evm], ['BEAT', beat.delta]]) {
  const s = split(d);
  console.log(`${name.padEnd(15)} added RMS: pulsing skin ${s.skin.toFixed(2)}, elsewhere ${s.rest.toFixed(2)} (8-bit levels)`);
}
