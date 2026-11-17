// Turn a <video> into the low-resolution clip the analysis works on.
//
// Frames are first grabbed while the video plays at double speed, which is much quicker
// than seeking. Playback may skip frames, so any that were missed are then
// fetched one by one with exact seeks.

import { reduceFrame } from './core/pyramid.js';

function seek(video, time) {
  return new Promise((resolve, reject) => {
    const done = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); resolve(); };
    const fail = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); reject(new Error('The video could not be decoded.')); };
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    video.currentTime = time;
  });
}

/**
 * @returns {{low: {data, T, w, h}, fs, width, height}} where width x height is
 *          the size frames were read at (and should be displayed at).
 */
export async function extractClip(video, { fs = 30, maxSeconds = 30, maxSide = 640, onProgress } = {}) {
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
  // Aim for cells of roughly 1/40 of the longer side, as in the MIT setting
  // (level 4 on a 528 x 592 clip).
  const levels = Math.max(1, Math.round(Math.log2(Math.max(width, height) / 40)));
  const T = Math.floor(Math.min(video.duration, maxSeconds) * fs + 1e-6);
  if (!(T >= 4 * fs)) throw new Error('The clip is too short: at least 4 seconds are needed.');

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let low = null;
  const have = new Uint8Array(T);
  let count = 0;
  const grab = (t) => {
    ctx.drawImage(video, 0, 0, width, height);
    const r = reduceFrame(ctx.getImageData(0, 0, width, height).data, width, height, 4, levels);
    low ??= { data: new Float32Array(T * r.w * r.h * 3), T, w: r.w, h: r.h };
    low.data.set(r.data, t * r.w * r.h * 3);
    have[t] = 1;
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
        if (!have[t]) grab(t);
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
  return { low, fs, width, height };
}
