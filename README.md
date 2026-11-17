# BEAT

Measure a heart rate from an ordinary video of a face, and watch the pulse amplified.

BEAT is a small web app that runs entirely in the browser: no build step, no
dependencies, no upload. It reproduces *Eulerian Video Magnification* (Wu et al.,
MIT, SIGGRAPH 2012), measures the heart rate with three published estimators and
one new one, and adds a pulse-locked magnification that needs no hand-picked
frequency band.

## Run it

```sh
npm start          # python3 -m http.server 8000
```

Then open <http://localhost:8000>. The MIT `face` clip loads automatically; use
**Open a video…** for your own clip (at least 4 seconds, a steady and evenly lit
face; the first 30 seconds are used).

To publish on GitHub Pages: commit `index.html`, `style.css`, `src/` and
`data/face.mp4`, then in the repository settings choose *Pages → Deploy from a
branch → main / root*.

## What it does

| View | What you see |
|---|---|
| Original | The clip as recorded. |
| MIT 2012 | Eulerian Video Magnification with the published settings. |
| BEAT | Only what follows the measured pulse is amplified. |
| Pulse map | Where a pulse was found, and how much each region is trusted. |

Next to the video: the heart rate, the pulse wave with each detected beat, its
spectrum, and a table comparing the four estimators.

## Method

Every frame is reduced to a coarse grid (Gaussian pyramid, level 4 for the demo
clip), which averages away sensor noise. Everything else works on that grid.

**MIT 2012 reproduction** (`src/core/magnify.js`, `magnifyEVM`). YIQ colour
space, ideal temporal band-pass 0.83–1 Hz, amplification 50, as published for
this clip. Two details of the reference MATLAB code matter for matching its
output and are reproduced: the filter keeps only the positive-frequency half of
the spectrum (which halves the effective gain), and the script drops the last
10 frames.

**Baselines** (`src/core/rppg.js`). GREEN (Verkruysse 2008), CHROM (de Haan &
Jeanne 2013) and POS (Wang et al. 2017), each on the mean skin colour.

**BEAT fusion** (new). Instead of trusting the whole face equally:

1. each skin cell gives its own pulse candidate (POS projection);
2. cells with abnormal in-band energy are set aside and the rest form a first
   consensus;
3. each cell is weighted by how well it follows the consensus, using
   maximum-ratio-combining weights `c / (1 − c²)`, with cells below a noise
   floor dropped; this is iterated;
4. the weighted colour traces are combined and projected once more;
5. if the result is not better than the starting point, the starting point is
   kept.

**BEAT magnification** (new, `magnifyPulse`). For every cell and colour channel,
fit how much of its variation follows the measured pulse (least squares), and
amplify only that part, gated by the cell's agreement with the consensus. There
is no band to choose and regions without a pulse stay untouched.

## Results

Reproduce with `npm run validate` and `node tools/benchmark.mjs` (both need
`ffmpeg`).

On the MIT `face` clip (10 s, 30 fps):

| Method | Rate (bpm) | Pulse SNR (dB) |
|---|---|---|
| GREEN | 52.8 | 9.4 |
| CHROM | 52.9 | 7.3 |
| POS | 52.7 | 9.3 |
| BEAT | 52.6 | 9.6 |

- **Reproduction.** Our EVM output correlates 0.89 with MIT's published result
  video (compared at pyramid resolution; amplitude ratio 1.13).
- **Magnification.** At the same amplification, MIT's method adds almost as
  much change outside the skin as on it (RMS 3.2 vs 4.1 grey levels). BEAT puts
  it on the skin (8.8) and leaves the rest nearly untouched (0.9).
- **Heart rate.** On this easy clip all four estimators agree. In a stress test
  that adds synthetic disturbances to the clip (50 trials each), BEAT matches
  POS under sensor noise and lighting flicker and is somewhat better when part
  of the frame is disturbed (72 % of trials within 3 bpm, against 66 % for POS,
  50 % for CHROM and 24 % for GREEN). Without the skin prior it has no
  advantage over POS. The clear gain over the 2012 work is in the
  magnification, not in the rate estimate.

## Moving faces: face stabilization

`tools/stabilize.py` unwraps the face of every frame onto a fixed flat map: the
478-point MediaPipe face mesh is tracked, and each of its triangles is warped onto
the mesh's canonical UV layout. In the output, the eyes, nose, mouth and every
patch of skin stay at the same pixels however the head moves, so the fixed grid
used by BEAT keeps tracking the same skin.

```sh
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/stabilize.py my-clip.mp4            # -> my-clip-stabilized.mp4
.venv/bin/python tools/stabilize.py my-clip.mp4 --preview  # input + mesh beside the output
node tools/measure.mjs my-clip.mp4 my-clip-stabilized.mp4  # compare the heart rates
```

The stabilized video can also be opened in the app. Details:

- Landmarks are smoothed in time (`--smooth`, Gaussian sigma in frames) so that
  tracking jitter does not turn into fake colour changes.
- Triangles turned away from the camera (below `--min-visibility` of their best
  size in the clip) are blacked out rather than smeared.
- The output is near-lossless H.264 (`--size`, 256 px by default), since the
  pulse lives in very faint colour changes.
- `--landmarks out.npy` saves the smoothed landmarks.

Test on the demo clip with synthetic head motion added (rotation up to ±17°,
shift up to ±95 px, zoom ±15 %):

| Clip | GREEN | CHROM | POS | BEAT |
|---|---|---|---|---|
| Still, as recorded | 52.8 / 9.4 | 52.9 / 7.3 | 52.7 / 9.3 | 52.6 / 9.6 |
| Still, stabilized | 52.5 / 6.6 | 52.7 / 5.1 | 52.6 / 8.6 | 52.6 / 9.3 |
| Moving, as recorded | 50.7 / 0.9 | 55.5 / 0.2 | 44.0 / −0.8 | 52.8 / 5.6 |
| Moving, stabilized | 51.1 / 1.1 | 52.6 / 6.5 | 52.8 / 8.5 | 52.6 / 8.8 |

(bpm / pulse SNR in dB). Without stabilization, motion breaks the published
estimators; after it, POS and BEAT are nearly as good as on the still clip. At
twice that motion the rates are still right after stabilization (52.1–52.6
bpm) but the SNR drops to 1–4 dB: at large poses the landmarks are a few pixels
off, so each map pixel slides slightly over the skin. This synthetic motion is
2D only; real head turns also change lighting and hide parts of the face, and
have not been tested yet.

## Limitations

- The demo clip has no contact-sensor ground truth; the estimators are checked
  against each other, not against an ECG.
- In the app, the face must stay roughly still: cells are fixed in the frame.
  Stabilize moving clips first with `tools/stabilize.py`.
- This is a demonstration, not a medical device.

## Roadmap

- **Moving faces in the app.** Run the stabilization in the browser
  (MediaPipe has a web version), and remove motion residue from the signal.
- Test on real head motion, with lighting changes.
- Live webcam input with a sliding window.
- Validation on a public dataset with ground truth (e.g. UBFC-rPPG).

## Layout

```
index.html, style.css   the page
src/app.js              UI wiring
src/extract.js          video → low-resolution clip
src/charts.js           SVG charts
src/core/               dsp, pyramid, rppg, magnify (shared with Node)
tools/                  validate.mjs, benchmark.mjs, measure.mjs,
                        stabilize.py (+ face_uv.json mesh layout)
```

## Reference

H.-Y. Wu, M. Rubinstein, E. Shih, J. Guttag, F. Durand, W. Freeman.
[Eulerian Video Magnification for Revealing Subtle Changes in the World](https://people.csail.mit.edu/mrub/evm/).
ACM Transactions on Graphics (SIGGRAPH), 2012. The demo clip and reference
result in `data/` come from that project.
