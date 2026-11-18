// Face tracking in the browser with MediaPipe Face Landmarker, loaded on
// demand from a CDN. Everything still runs on the device.

const VERSION = '1.1.1';
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let mesh = null;

/** The face mesh layout (src/core/face-mesh.json). */
export async function loadMesh() {
  mesh ??= fetch(new URL('./core/face-mesh.json', import.meta.url)).then((r) => {
    if (!r.ok) throw new Error('The face mesh could not be loaded.');
    return r.json();
  });
  return mesh;
}

async function create(vision, fileset, delegate) {
  return vision.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
  });
}

/**
 * A face tracker, or null when it cannot be loaded (offline, old browser).
 * `track(image)` returns the 468 mesh landmarks in image pixels as a flat
 * Float32Array [x0, y0, x1, y1, ...], or null when no face is found. Frames
 * should be given roughly in order: the tracker follows the face from one
 * frame to the next and searches the whole image again only when it is lost.
 */
export async function loadTracker() {
  try {
    const vision = await import(`${BASE}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    // The CPU path takes a few milliseconds per frame and, unlike the GPU
    // path, does not stall on reading frames back from a 2D canvas.
    const landmarker = await create(vision, fileset, 'CPU');
    let clock = 0;
    return {
      track(image, width, height) {
        // Timestamps only need to increase; frames read out of order are
        // still tracked, just with less help from the previous frame.
        clock += 33;
        const result = landmarker.detectForVideo(image, clock);
        const face = result.faceLandmarks?.[0];
        if (!face) return null;
        const pts = new Float32Array(468 * 2);
        for (let i = 0; i < 468; i++) {
          pts[2 * i] = face[i].x * width;
          pts[2 * i + 1] = face[i].y * height;
        }
        return pts;
      },
      close() { landmarker.close(); },
    };
  } catch (err) {
    console.warn('Face tracking unavailable:', err);
    return null;
  }
}
