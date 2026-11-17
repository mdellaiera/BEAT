// Gaussian pyramid reduction, matching the `blurDnClr` step of the MIT
// reference code: separable binomial [1 4 6 4 1]/16 blur, edges reflected about
// the border pixel, then decimation by 2 keeping even indices.

const K = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

function reflect(i, n) {
  if (i < 0) i = -i;
  if (i >= n) i = 2 * n - 2 - i;
  return i < 0 ? 0 : i;
}

/** One blur + decimate step on an interleaved 3-channel float image. */
export function blurDown(src, w, h) {
  const w2 = (w + 1) >> 1, h2 = (h + 1) >> 1;
  const tmp = new Float32Array(w2 * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x2 = 0; x2 < w2; x2++) {
      let r = 0, g = 0, b = 0;
      for (let k = -2; k <= 2; k++) {
        const i = (y * w + reflect(2 * x2 + k, w)) * 3;
        const c = K[k + 2];
        r += c * src[i]; g += c * src[i + 1]; b += c * src[i + 2];
      }
      const o = (y * w2 + x2) * 3;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
  }
  const dst = new Float32Array(w2 * h2 * 3);
  for (let y2 = 0; y2 < h2; y2++) {
    for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -2; k <= 2; k++) {
        const i = (reflect(2 * y2 + k, h) * w2 + x) * 3;
        const c = K[k + 2];
        r += c * tmp[i]; g += c * tmp[i + 1]; b += c * tmp[i + 2];
      }
      const o = (y2 * w2 + x) * 3;
      dst[o] = r; dst[o + 1] = g; dst[o + 2] = b;
    }
  }
  return { data: dst, w: w2, h: h2 };
}

/**
 * Reduce an 8-bit frame (RGB or RGBA, `stride` bytes per pixel) to pyramid
 * level `levels`. Output is float RGB in [0, 1].
 */
export function reduceFrame(pixels, w, h, stride, levels) {
  let img = new Float32Array(w * h * 3);
  for (let i = 0, o = 0; o < img.length; i += stride, o += 3) {
    img[o] = pixels[i] / 255;
    img[o + 1] = pixels[i + 1] / 255;
    img[o + 2] = pixels[i + 2] / 255;
  }
  let cur = { data: img, w, h };
  for (let l = 0; l < levels; l++) cur = blurDown(cur.data, cur.w, cur.h);
  return cur;
}

/** Size of a w x h image after `levels` reductions. */
export function reducedSize(w, h, levels) {
  for (let l = 0; l < levels; l++) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
  return { w, h };
}
