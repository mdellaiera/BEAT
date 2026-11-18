"""Unwrap the face of every frame onto a fixed flat map.

Each frame is warped, triangle by triangle, from MediaPipe's 478-point face mesh
onto the mesh's canonical UV layout. The output is a square video in which
every facial feature stays at the same pixel however the head moves, so a fixed
grid cell keeps looking at the same patch of skin.

    python tools/stabilize.py data/face.mp4                   # -> face-stabilized.mp4
    python tools/stabilize.py clip.mp4 -o out.mp4 --size 384 --preview

Needs: mediapipe, opencv-python(-headless), numpy, and ffmpeg on PATH.
Landmarks are smoothed over time (zero-phase) to remove jitter, which would
otherwise show up as fake colour changes. Triangles seen edge-on or from behind
(head turned away) are blacked out instead of being smeared.
"""

import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np

MODEL_URL = ('https://storage.googleapis.com/mediapipe-models/face_landmarker/'
             'face_landmarker/float16/latest/face_landmarker.task')
MESH = Path(__file__).resolve().parent.parent / 'src' / 'core' / 'face-mesh.json'


def model_path(path):
    if path:
        return Path(path)
    cached = Path.home() / '.cache' / 'beat' / 'face_landmarker.task'
    if not cached.exists():
        cached.parent.mkdir(parents=True, exist_ok=True)
        print(f'Downloading the face landmark model to {cached}', file=sys.stderr)
        urllib.request.urlretrieve(MODEL_URL, cached)
    return cached


def frames(path):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        sys.exit(f'Cannot open {path}')
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                return
            yield frame
    finally:
        cap.release()


def track(path, fps, model):
    """Face landmarks of every frame in pixels, shape (T, 468, 2); NaN where no face."""
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    options = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model)),
        running_mode=vision.RunningMode.VIDEO, num_faces=1)
    out = []
    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        for t, frame in enumerate(frames(path)):
            h, w = frame.shape[:2]
            image = mp.Image(image_format=mp.ImageFormat.SRGB,
                             data=np.ascontiguousarray(frame[:, :, ::-1]))
            result = landmarker.detect_for_video(image, int(round(t * 1000 / fps)))
            if result.face_landmarks:
                # The first 468 points are the mesh; the last 10 are the irises.
                pts = result.face_landmarks[0][:468]
                out.append([(p.x * w, p.y * h) for p in pts])
            else:
                out.append(np.full((468, 2), np.nan))
            if t % 30 == 0:
                print(f'\rTracking frame {t}', end='', file=sys.stderr)
    print(file=sys.stderr)
    return np.asarray(out, dtype=np.float64)


def fill_and_smooth(lm, sigma):
    """Interpolate frames without a face, then apply a zero-phase Gaussian in time."""
    T = len(lm)
    found = ~np.isnan(lm[:, 0, 0])
    if not found.any():
        sys.exit('No face was found in this video.')
    idx = np.arange(T)
    flat = lm.reshape(T, -1)
    for j in range(flat.shape[1]):
        flat[:, j] = np.interp(idx, idx[found], flat[found, j])
    if sigma > 0:
        r = int(np.ceil(3 * sigma))
        k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
        k /= k.sum()
        padded = np.pad(flat, ((r, r), (0, 0)), mode='reflect')
        flat = np.stack([np.convolve(padded[:, j], k, mode='valid') for j in range(flat.shape[1])], 1)
    return flat.reshape(lm.shape), found


class Unwrapper:
    """Piecewise-affine warp from the tracked mesh to the canonical UV square."""

    def __init__(self, size):
        mesh = json.loads(MESH.read_text())
        self.tri = np.asarray(mesh['triangles'])
        uv = np.asarray(mesh['uv']) * (size - 1)
        self.size = size
        # Which triangle covers each output pixel (-1: outside the face)...
        ids = np.full((size, size), -1, np.int32)
        for k, t in enumerate(self.tri):
            cv2.fillConvexPoly(ids, np.round(uv[t] * 16).astype(np.int32), int(k), cv2.LINE_8, shift=4)
        self.ids = ids
        inside = ids >= 0
        self.inside = inside
        tk = ids[inside]
        # ...and its barycentric weights there. Both never change.
        ys, xs = np.nonzero(inside)
        a, b, c = (uv[self.tri[tk, i]] for i in range(3))
        v0, v1, v2 = b - a, c - a, np.stack([xs, ys], 1) - a
        d = v0[:, 0] * v1[:, 1] - v0[:, 1] * v1[:, 0]
        wb = (v2[:, 0] * v1[:, 1] - v2[:, 1] * v1[:, 0]) / d
        wc = (v0[:, 0] * v2[:, 1] - v0[:, 1] * v2[:, 0]) / d
        self.bary = np.stack([1 - wb - wc, wb, wc], 1)
        self.tk = tk
        self.uv_area = self._area(uv)

    def _area(self, pts):
        a, b, c = (pts[self.tri[:, i]] for i in range(3))
        return 0.5 * ((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0]))

    def visible_area(self, lm):
        """Image area of every triangle over UV area, shape (T, triangles); negative from behind."""
        return np.stack([self._area(pts) / self.uv_area for pts in lm])

    def __call__(self, frame, pts, visibility, min_visibility):
        size = self.size
        corners = pts[self.tri[self.tk]]                      # (N, 3, 2)
        src = np.einsum('nk,nkd->nd', self.bary, corners)
        mapx = np.full((size, size), -1, np.float32)
        mapy = np.full((size, size), -1, np.float32)
        mapx[self.inside] = src[:, 0]
        mapy[self.inside] = src[:, 1]
        # Blur before sampling when the face is larger than the output, so
        # that fine texture does not alias into flicker.
        scale = (np.ptp(pts[:, 0]) + np.ptp(pts[:, 1])) / (2 * 0.8 * size)
        if scale > 1.2:
            frame = cv2.GaussianBlur(frame, (0, 0), 0.4 * scale)
        out = cv2.remap(frame, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        hidden = np.zeros((size, size), bool)
        hidden[self.inside] = visibility[self.tk] < min_visibility
        out[hidden] = 0
        return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video')
    ap.add_argument('-o', '--output', help='output video (default: <name>-stabilized.mp4 next to the input)')
    ap.add_argument('--size', type=int, default=256, help='side of the square output in pixels (default 256)')
    ap.add_argument('--smooth', type=float, default=1.5,
                    help='temporal smoothing of the landmarks, Gaussian sigma in frames (default 1.5, 0 = off)')
    ap.add_argument('--min-visibility', type=float, default=0.35,
                    help='black out triangles seen at less than this fraction of their best size in the clip (default 0.35)')
    ap.add_argument('--preview', action='store_true', help='put the input with the tracked mesh beside the output')
    ap.add_argument('--landmarks', help='also save the smoothed landmarks (T x 468 x 2, pixels) to this .npy file')
    ap.add_argument('--model', help='path to face_landmarker.task (downloaded and cached if omitted)')
    args = ap.parse_args()

    src = Path(args.video)
    dst = Path(args.output) if args.output else src.with_name(f'{src.stem}-stabilized.mp4')
    size = args.size + args.size % 2
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    lm, found = fill_and_smooth(track(src, fps, model_path(args.model)), args.smooth)
    if args.landmarks:
        np.save(args.landmarks, lm.astype(np.float32))
    unwrap = Unwrapper(size)
    # Each triangle is compared with its own best view in the clip, since some
    # (sides of the nose) are foreshortened even in a frontal view.
    area = unwrap.visible_area(lm)
    best = np.percentile(area, 95, axis=0)
    visibility = np.where(best > 0, area / np.maximum(best, 1e-9), 0)

    if args.preview:
        ph = size
        pw = int(round(W * ph / H)) // 2 * 2
        out_w = pw + size
    else:
        out_w = size
    # Near-lossless H.264 keeps the faint colour changes the pulse is made of.
    enc = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{out_w}x{size}',
         '-r', f'{fps}', '-i', '-', '-c:v', 'libx264', '-crf', '8', '-preset', 'slow',
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(dst)],
        stdin=subprocess.PIPE)
    for t, frame in enumerate(frames(src)):
        if t >= len(lm):
            break
        flat = unwrap(frame, lm[t], visibility[t], args.min_visibility)
        if args.preview:
            view = frame.copy()
            color = (80, 200, 80) if found[t] else (60, 60, 230)
            for tri in unwrap.tri[::3]:
                cv2.polylines(view, [np.round(lm[t][tri] * 4).astype(np.int32)], True, color, 1, cv2.LINE_AA, shift=2)
            flat = np.hstack([cv2.resize(view, (pw, size), interpolation=cv2.INTER_AREA), flat])
        enc.stdin.write(np.ascontiguousarray(flat).tobytes())
        if t % 30 == 0:
            print(f'\rWriting frame {t}', end='', file=sys.stderr)
    enc.stdin.close()
    enc.wait()
    missing = int((~found).sum())
    print(f'\nWrote {dst} ({len(lm)} frames, {size}x{size}'
          f'{f", face not found in {missing} frames (interpolated)" if missing else ""})', file=sys.stderr)


if __name__ == '__main__':
    main()
