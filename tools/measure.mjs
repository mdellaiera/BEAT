// Heart rate of any clip, with every estimator. Needs ffmpeg on PATH.
//
//   node tools/measure.mjs clip.mp4 [clip2.mp4 ...]
//
// Use it to compare a raw clip with its stabilized version (tools/stabilize.py).

import { execFileSync } from 'node:child_process';
import { reduceFrame } from '../src/core/pyramid.js';
import { analyze } from '../src/core/rppg.js';

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', file]).toString().trim();
  const [w, h, rate] = out.split(',');
  const [num, den] = rate.split('/').map(Number);
  return { w: +w, h: +h, fs: num / (den || 1) };
}

function load(file) {
  const { w, h, fs } = probe(file);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { maxBuffer: 4 * 1024 ** 3 });
  const size = w * h * 3, T = Math.floor(raw.length / size);
  // Same cell size rule as the app: about 1/40 of the longer side.
  const levels = Math.max(1, Math.round(Math.log2(Math.max(w, h) / 40)));
  let low;
  for (let t = 0; t < T; t++) {
    const r = reduceFrame(raw.subarray(t * size, (t + 1) * size), w, h, 3, levels);
    low ??= { data: new Float32Array(T * r.w * r.h * 3), T, w: r.w, h: r.h };
    low.data.set(r.data, t * r.w * r.h * 3);
  }
  return { low, fs };
}

for (const file of process.argv.slice(2)) {
  const { low, fs } = load(file);
  const a = analyze(low, fs);
  const cells = Object.entries(a.methods)
    .map(([k, m]) => `${k} ${m.bpm.toFixed(1)} bpm ${m.snr.toFixed(1)} dB`).join(' | ');
  console.log(`${file.split('/').pop()}: ${cells}`);
}
