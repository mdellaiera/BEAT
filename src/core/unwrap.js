// Face projection: warp a face, triangle by triangle, between the image and a
// fixed flat map (the UV layout of MediaPipe's canonical face mesh), so that
// every patch of skin keeps the same place on the map however the head moves.
//
// `mesh` is src/core/face-mesh.json: { uv, xy, triangles }.
// `pts` are the 468 tracked landmarks in image pixels, as a flat [x0, y0, x1, ...].

function signedArea(ax, ay, bx, by, cx, cy) {
  return 0.5 * ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

/**
 * Per-triangle visibility in [0, 1]: the triangle's image area relative to
 * what it would have in a frontal view of the same face. Near 0 when seen
 * edge-on, 0 when facing away.
 */
export function makeVisibility(mesh) {
  const tri = mesh.triangles;
  const front = Float64Array.from(tri, ([a, b, c]) =>
    signedArea(...mesh.xy[a], ...mesh.xy[b], ...mesh.xy[c]));
  const ratio = new Float64Array(tri.length);
  const vis = new Float32Array(tri.length);
  return (pts) => {
    for (let k = 0; k < tri.length; k++) {
      const [a, b, c] = tri[k];
      ratio[k] = signedArea(pts[2 * a], pts[2 * a + 1], pts[2 * b], pts[2 * b + 1], pts[2 * c], pts[2 * c + 1]) / front[k];
    }
    // The median ratio is the face's overall scale (and sign, which depends
    // on the image orientation convention).
    const scale = Float64Array.from(ratio).sort()[tri.length >> 1];
    for (let k = 0; k < tri.length; k++) vis[k] = Math.min(1, Math.max(0, ratio[k] / scale));
    return vis;
  };
}

/** Image -> flat map. The map is `size` x `size` RGBA. */
export function makeUnwrapper(mesh, size) {
  const tri = mesh.triangles;
  const uv = mesh.uv.map(([u, v]) => [u * (size - 1), v * (size - 1)]);
  // Which triangle covers each map pixel, and its barycentric weights there.
  // The map never changes, so this is computed once.
  const owner = new Int32Array(size * size).fill(-1);
  const bary = new Float32Array(size * size * 2);
  // How the first two weights change per map pixel in x and y (they are affine).
  const step = new Float32Array(tri.length * 4);
  tri.forEach(([a, b, c], k) => {
    const [ax, ay] = uv[a], [bx, by] = uv[b], [cx, cy] = uv[c];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (d === 0) return;
    step.set([(by - cy) / d, (cx - bx) / d, (cy - ay) / d, (ax - cx) / d], k * 4);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * size + x;
        if (owner[i] >= 0) continue;
        const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
        const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
        if (l0 < -1e-6 || l1 < -1e-6 || 1 - l0 - l1 < -1e-6) continue;
        owner[i] = k;
        bary[i * 2] = l0; bary[i * 2 + 1] = l1;
      }
    }
  });
  const inside = Int32Array.from(owner.keys()).filter((i) => owner[i] >= 0);
  const visibility = makeVisibility(mesh);

  /**
   * Sample `src` (RGBA, W x H) onto the map. Triangles below `minVisibility`
   * are left transparent. With `supersample`, each map pixel averages four
   * samples, which avoids aliasing when the face is larger than the map.
   */
  function warp(src, W, H, pts, { out = new Uint8ClampedArray(size * size * 4), minVisibility = 0, supersample = false } = {}) {
    out.fill(0);
    const vis = minVisibility > 0 ? visibility(pts) : null;
    const offsets = supersample ? [-0.25, 0.25] : [0];
    const n = offsets.length * offsets.length;
    const sample = (x, y, acc) => {
      x = Math.min(W - 1, Math.max(0, x)); y = Math.min(H - 1, Math.max(0, y));
      const x0 = Math.min(W - 2, Math.floor(x)), y0 = Math.min(H - 2, Math.floor(y));
      const fx = x - x0, fy = y - y0;
      const p = (y0 * W + x0) * 4, q = p + W * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[p + c] + fx * (src[p + 4 + c] - src[p + c]);
        const bot = src[q + c] + fx * (src[q + 4 + c] - src[q + c]);
        acc[c] += top + fy * (bot - top);
      }
    };
    const acc = [0, 0, 0];
    for (const i of inside) {
      const k = owner[i];
      if (vis && vis[k] < minVisibility) continue;
      const [a, b, c] = tri[k];
      acc[0] = acc[1] = acc[2] = 0;
      for (const dy of offsets) {
        for (const dx of offsets) {
          const l0 = bary[i * 2] + dx * step[k * 4] + dy * step[k * 4 + 1];
          const l1 = bary[i * 2 + 1] + dx * step[k * 4 + 2] + dy * step[k * 4 + 3];
          const l2 = 1 - l0 - l1;
          sample(l0 * pts[2 * a] + l1 * pts[2 * b] + l2 * pts[2 * c],
            l0 * pts[2 * a + 1] + l1 * pts[2 * b + 1] + l2 * pts[2 * c + 1], acc);
        }
      }
      const o = i * 4;
      out[o] = acc[0] / n; out[o + 1] = acc[1] / n; out[o + 2] = acc[2] / n; out[o + 3] = 255;
    }
    return out;
  }

  return { size, warp };
}

/**
 * Flat map -> image: add a delta that lives on the reduced flat map
 * (gw x gh cells, from a `size` map) onto the face in the image, following
 * the tracked mesh.
 */
export function makeFaceCompositor(mesh, size, gw, gh, W, H) {
  const tri = mesh.triangles;
  // Map pixel -> cell coordinates, matching the pyramid's cell centres.
  const gu = mesh.uv.map(([u, v]) => [
    ((u * (size - 1) + 0.5) * gw) / size - 0.5,
    ((v * (size - 1) + 0.5) * gh) / size - 0.5,
  ]);
  const visibility = makeVisibility(mesh);
  const stamp = new Uint32Array(W * H);
  let pass = 0;

  function apply(pixels, delta, t, gain, pts, minVisibility = 0.35) {
    const base = t * gw * gh * 3;
    const s = 255 * gain;
    const vis = visibility(pts);
    pass++;
    for (let k = 0; k < tri.length; k++) {
      if (vis[k] < minVisibility) continue;
      const [a, b, c] = tri[k];
      const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1], cx = pts[2 * c], cy = pts[2 * c + 1];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (d === 0) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let Y = y0; Y <= y1; Y++) {
        const y = Y + 0.5;
        for (let X = x0; X <= x1; X++) {
          const i = Y * W + X;
          // Shared edges belong to one triangle only.
          if (stamp[i] === pass) continue;
          const x = X + 0.5;
          const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
          const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          stamp[i] = pass;
          const u = Math.min(gw - 1, Math.max(0, l0 * gu[a][0] + l1 * gu[b][0] + l2 * gu[c][0]));
          const v = Math.min(gh - 1, Math.max(0, l0 * gu[a][1] + l1 * gu[b][1] + l2 * gu[c][1]));
          const u0 = Math.min(gw - 2, Math.floor(u)), v0 = Math.min(gh - 2, Math.floor(v));
          const fu = u - u0, fv = v - v0;
          const p = base + (v0 * gw + u0) * 3, q = p + gw * 3;
          const o = i * 4;
          for (let ch = 0; ch < 3; ch++) {
            const top = delta[p + ch] + fu * (delta[p + 3 + ch] - delta[p + ch]);
            const bot = delta[q + ch] + fu * (delta[q + 3 + ch] - delta[q + ch]);
            pixels[o + ch] += s * (top + fv * (bot - top));
          }
        }
      }
    }
  }
  return { apply };
}
