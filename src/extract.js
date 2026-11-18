// Turn a <video> into the low-resolution clip the analysis works on.
//
// Frames are first grabbed while the video plays, which is much quicker than
// seeking. Playback runs as fast as frames can be processed (up to double
// speed) and may still skip some, so any that were missed are then fetched
// one by one with exact seeks.
//
// With a face tracker, every frame is also projected onto the flat face map
// (see core/unwrap.js) and reduced in the same way, so that the analysis can
// follow the skin when the head moves.

import { reduceFrame } from './core/pyramid.js';
import { makeUnwrapper } from './core/unwrap.js';

const FACE_MAP = 256;

function seek(video, time) {
  return new Promise((resolve, reject) => {
    const done = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); resolve(); };
    const fail = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); reject(new Error('The video could not be decoded.')); };
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    video.currentTime = time;
  });
}

const levelsFor = (side) => Math.max(1, Math.round(Math.log2(side / 40)));

/**
 * @param tracker  optional face tracker (face.js) and `mesh` its layout
 * @returns {{low: {data, T, w, h}, fs, width, height, face}} where width x height is
 *          the size frames were read at (and should be displayed at), and
 *          `face` is null or {low, landmarks, found, size}: the clip on the
 *          flat face map, the 468 landmarks of every frame in pixels
 *          (Float32Array, T x 936), and which frames had a face.
 */
export async function extractClip(video, { fs = 30, maxSeconds = 30, maxSide = 640, tracker = null, mesh = null, onProgress } = {}) {
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
  // Aim for cells of roughly 1/40 of the longer side, as in the MIT setting
  // (level 4 on a 528 x 592 clip).
  const levels = levelsFor(Math.max(width, height));
  const T = Math.floor(Math.min(video.duration, maxSeconds) * fs + 1e-6);
  if (!(T >= 4 * fs)) throw new Error('The clip is too short: at least 4 seconds are needed.');

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let low = null;
  const have = new Uint8Array(T);
  let count = 0;

  const unwrapper = tracker && mesh ? makeUnwrapper(mesh, FACE_MAP) : null;
  const face = unwrapper && {
    low: null, size: FACE_MAP,
    landmarks: new Float32Array(T * 936), found: new Uint8Array(T),
  };
  const flat = unwrapper && new Uint8ClampedArray(FACE_MAP * FACE_MAP * 4);
  const project = (t, pixels) => {
    unwrapper.warp(pixels, width, height, face.landmarks.subarray(t * 936, (t + 1) * 936), { out: flat, supersample: true });
    const r = reduceFrame(flat, FACE_MAP, FACE_MAP, 4, levelsFor(FACE_MAP));
    face.low ??= { data: new Float32Array(T * r.w * r.h * 3), T, w: r.w, h: r.h };
    face.low.data.set(r.data, t * r.w * r.h * 3);
  };

  let cost = 0; // smoothed processing time per frame, ms
  const grab = (t) => {
    const start = performance.now();
    ctx.drawImage(video, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const r = reduceFrame(pixels, width, height, 4, levels);
    low ??= { data: new Float32Array(T * r.w * r.h * 3), T, w: r.w, h: r.h };
    low.data.set(r.data, t * r.w * r.h * 3);
    if (face) {
      const pts = tracker.track(canvas, width, height);
      if (pts) {
        face.landmarks.set(pts, t * 936);
        face.found[t] = 1;
        project(t, pixels);
      }
    }
    have[t] = 1;
    cost = cost ? 0.8 * cost + 0.2 * (performance.now() - start) : performance.now() - start;
    onProgress?.(++count / T);
  };

  if ('requestVideoFrameCallback' in video) {
    const wasLooping = video.loop;
    video.loop = false;
    await seek(video, 0);
    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        video.removeEventListener('ended', finish);
        video.removeEventListener('error', finish);
        video.pause();
        resolve();
      };
      const onFrame = (_, meta) => {
        if (finished) return;
        const t = Math.floor(meta.mediaTime * fs + 0.01);
        if (t >= T) return finish();
        if (!have[t]) {
          grab(t);
          // Leave some slack for decoding and the page itself.
          video.playbackRate = Math.min(2, Math.max(0.25, (0.6 * 1000) / (fs * cost)));
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.addEventListener('ended', finish);
      video.addEventListener('error', finish);
      video.requestVideoFrameCallback(onFrame);
      video.playbackRate = 2;
      video.play().catch(finish);
    });
    video.playbackRate = 1;
    video.loop = wasLooping;
  }
  for (let t = 0; t < T; t++) {
    if (have[t]) continue;
    await seek(video, (t + 0.5) / fs);
    grab(t);
  }

  // Frames where the face was missed get landmarks interpolated from their
  // neighbours, and are read once more to be projected with them.
  if (face) {
    const hits = [];
    face.found.forEach((f, t) => { if (f) hits.push(t); });
    if (hits.length < 0.5 * T) return { low, fs, width, height, face: null };
    const missing = [];
    for (let t = 0, j = 0; t < T; t++) {
      if (face.found[t]) continue;
      while (j + 1 < hits.length && hits[j + 1] < t) j++;
      const a = hits[j], b = hits[Math.min(j + 1, hits.length - 1)];
      const p = a > t ? a : b < t ? b : null;
      for (let i = 0; i < 936; i++) {
        face.landmarks[t * 936 + i] = p != null ? face.landmarks[p * 936 + i]
          : face.landmarks[a * 936 + i] + ((t - a) / (b - a)) * (face.landmarks[b * 936 + i] - face.landmarks[a * 936 + i]);
      }
      missing.push(t);
    }
    for (const t of missing) {
      await seek(video, (t + 0.5) / fs);
      ctx.drawImage(video, 0, 0, width, height);
      project(t, ctx.getImageData(0, 0, width, height).data);
    }
  }
  return { low, fs, width, height, face };
}
