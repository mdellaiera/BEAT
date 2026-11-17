import { extractClip } from './extract.js';
import { analyze } from './core/rppg.js';
import { magnifyEVM, magnifyPulse, makeCompositor } from './core/magnify.js';
import { lineChart } from './charts.js';

const DEMO = 'data/face.mp4';
// Settings MIT used for this clip (Wu et al. 2012, Table 1 and result file name).
const DEMO_EVM = { fLow: 50 / 60, fHigh: 60 / 60 };

const $ = (id) => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d', { willReadFrequently: true });
const video = document.createElement('video');
video.muted = true;
video.loop = true;
video.playsInline = true;
video.preload = 'auto';

const METHOD_NAMES = {
  green: ['GREEN', 'Verkruysse 2008'],
  chrom: ['CHROM', 'de Haan 2013'],
  pos: ['POS', 'Wang 2017'],
  beat: ['BEAT', 'this project'],
};

let state = null; // everything derived from the current clip
let mode = 'beat';
let charts = [];
let jobId = 0;
let objectUrl = null;
let lastTime = 0;

function setStatus(text, progress = null) {
  $('status').hidden = text == null;
  if (text == null) return;
  $('statusText').textContent = text;
  $('statusBar').parentElement.hidden = progress == null;
  $('statusBar').style.width = `${Math.round((progress ?? 0) * 100)}%`;
}

const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function load(src, isDemo) {
  const job = ++jobId;
  video.pause();
  state = null;
  setStatus('Loading clip…');
  try {
    // Read the whole file into memory first: frame-accurate seeking then
    // works even when the web server does not support range requests.
    if (!src.startsWith('blob:')) {
      const response = await fetch(src);
      if (!response.ok) throw new Error('The demo clip could not be downloaded.');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(await response.blob());
      src = objectUrl;
    }
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('This file could not be opened as a video.'));
      video.src = src;
      video.load();
    });
    const clip = await extractClip(video, {
      onProgress: (p) => { if (job === jobId) setStatus('Reading frames…', p); },
    });
    if (job !== jobId) return;
    setStatus('Measuring pulse…');
    await nextPaint();

    const { low, fs, width, height } = clip;
    const analysis = analyze(low, fs);
    const found = Number.isFinite(analysis.bpm);
    const f0 = analysis.bpm / 60;
    const band = isDemo || !found ? DEMO_EVM : { fLow: f0 - 5 / 60, fHigh: f0 + 5 / 60 };
    // Deltas are computed at unit gain; the slider scales them at display time.
    const evm = magnifyEVM(low, fs, { ...band, alpha: 1 });
    const pulse = found
      ? magnifyPulse(low, fs, analysis, { alpha: 1 })
      : { delta: new Float32Array(low.data.length), gate: new Float32Array(low.w * low.h) };
    const map = new Float32Array(low.w * low.h * 3);
    for (let i = 0; i < pulse.gate.length; i++) {
      map[i * 3] = -0.3 * pulse.gate[i]; map[i * 3 + 1] = -0.05 * pulse.gate[i]; map[i * 3 + 2] = 0.35 * pulse.gate[i];
    }
    if (job !== jobId) return;

    view.width = width; view.height = height;
    state = {
      low, fs, analysis, found, band, isDemo,
      deltas: { evm, beat: pulse.delta, map },
      compositor: makeCompositor(low.w, low.h, width, height),
    };
    showResults();
    setMode(mode);
    setStatus(null);
    video.currentTime = 0;
    await video.play().catch(() => {});
    setPlayLabel();
  } catch (err) {
    if (job === jobId) setStatus(err.message || 'Something went wrong while reading this video.');
  }
}

function showResults() {
  const { analysis, fs, low, found } = state;
  $('bpm').textContent = found ? analysis.bpm.toFixed(0) : '–';
  const snr = analysis.snr;
  const grade = !found ? 'No pulse found. Try a steadier, evenly lit clip of a face.'
    : snr >= 6 ? 'Strong signal' : snr >= 2 ? 'Fair signal' : 'Weak signal: treat this rate with caution';
  $('quality').textContent = found
    ? `${grade} · SNR ${snr.toFixed(1)} dB · ${analysis.beats.length} beats in ${(low.T / fs).toFixed(1)} s`
    : grade;

  const body = $('methods').tBodies[0];
  body.replaceChildren();
  for (const [key, m] of Object.entries(analysis.methods)) {
    const row = body.insertRow();
    if (key === 'beat') row.className = 'ours';
    const name = row.insertCell();
    name.textContent = METHOD_NAMES[key][0];
    const ref = document.createElement('small');
    ref.textContent = METHOD_NAMES[key][1];
    name.appendChild(ref);
    row.insertCell().textContent = Number.isFinite(m.bpm) ? m.bpm.toFixed(1) : '–';
    row.insertCell().textContent = Number.isFinite(m.snr) ? m.snr.toFixed(1) : '–';
  }

  charts.forEach((c) => c.destroy());
  charts = [];
  const time = Float64Array.from({ length: low.T }, (_, i) => i / fs);
  const wave = analysis.pulse;
  const duration = (low.T - 1) / fs;
  const step = duration > 20 ? 5 : 2;
  const ticks = [];
  for (let t = 0; t < duration - step / 2; t += step) ticks.push(t);
  ticks.push(time[low.T - 1]);
  const beatBpm = analysis.beats.map((t, i) => (i ? 60 / (t - analysis.beats[i - 1]) : null));
  charts.push(lineChart($('waveChart'), {
    label: 'Pulse wave over time',
    x: time, y: wave, xTicks: ticks,
    xFormat: (t) => `${t.toFixed(t % 1 ? 1 : 0)} s`,
    markers: analysis.beats.map((t) => {
      const i = Math.min(low.T - 2, Math.floor(t * fs));
      const frac = t * fs - i;
      return { x: t, y: wave[i] + frac * (wave[i + 1] - wave[i]) };
    }),
    tooltip: (i) => {
      // Rate of the beat interval the cursor is in.
      const k = analysis.beats.findIndex((b) => b >= time[i]);
      const bpm = k > 0 ? beatBpm[k] : null;
      return bpm ? `${time[i].toFixed(2)} s · this beat ${bpm.toFixed(0)} bpm` : `${time[i].toFixed(2)} s`;
    },
  }));

  const spec = analysis.methods.beat.spectrum;
  const sx = [], sy = [];
  for (let k = 0; k < spec.freq.length; k++) {
    const bpm = spec.freq[k] * 60;
    if (bpm >= 40 && bpm <= 200) { sx.push(bpm); sy.push(spec.power[k]); }
  }
  let peak = 0;
  for (let i = 1; i < sy.length; i++) if (Math.abs(sx[i] - analysis.bpm) < Math.abs(sx[peak] - analysis.bpm)) peak = i;
  charts.push(lineChart($('specChart'), {
    label: 'Power spectrum of the pulse wave',
    x: sx, y: sy, zeroBased: true,
    xTicks: [sx[0], 80, 120, 160, sx[sx.length - 1]],
    xFormat: (v) => `${v.toFixed(0)} bpm`,
    markers: found ? [{ x: sx[peak], y: sy[peak] }] : [],
    peak: found ? { x: sx[peak], y: sy[peak], text: `${analysis.bpm.toFixed(1)} bpm` } : null,
    tooltip: (i) => `${sx[i].toFixed(1)} bpm`,
  }));
}

function setMode(next) {
  mode = next;
  for (const b of document.querySelectorAll('.segmented button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  }
  $('gain').disabled = mode === 'original' || mode === 'map';
  if (!state) return;
  const { band, isDemo, found } = state;
  const range = `${(band.fLow * 60).toFixed(0)}–${(band.fHigh * 60).toFixed(0)} bpm`;
  $('modeNote').textContent = {
    original: 'The clip as recorded. The pulse is there, but far too faint to see.',
    evm: isDemo
      ? `Eulerian Video Magnification with the published settings for this clip: every pixel's ${range} band is amplified, wherever it comes from.`
      : `Eulerian Video Magnification: every pixel's ${range} band is amplified. The band was centred on the measured rate; the original method needs it chosen by hand.`,
    beat: found
      ? 'Only the part of each pixel that follows the measured pulse is amplified. No band to choose, and regions without a pulse stay untouched.'
      : 'No pulse was found, so there is nothing to amplify.',
    map: 'Blue marks the skin where a pulse was found, and how strongly it is trusted.',
  }[mode];
  if (video.paused) paint(video.currentTime);
}

function paint(time) {
  if (!state) return;
  const { low, fs, deltas, compositor, analysis } = state;
  ctx.drawImage(video, 0, 0, view.width, view.height);
  const frame = Math.min(low.T - 1, Math.max(0, Math.floor(time * fs + 0.01)));
  if (mode !== 'original') {
    const img = ctx.getImageData(0, 0, view.width, view.height);
    const gain = Number($('gain').value);
    // The reference EVM filter halves the amplitude; match it so that both
    // modes are compared at the same nominal amplification.
    if (mode === 'evm') compositor.apply(img.data, deltas.evm, frame, gain);
    else if (mode === 'beat') compositor.apply(img.data, deltas.beat, frame, gain / 2);
    else compositor.apply(img.data, deltas.map, 0, 1);
    ctx.putImageData(img, 0, 0);
  }
  const shown = Math.min(time, (low.T - 1) / fs);
  charts[0]?.setPlayhead(shown);
  // Pulse the heart when playback crosses a detected beat.
  if (analysis.beats.some((b) => b > lastTime && b <= time)) {
    const heart = $('heart');
    heart.classList.remove('beat');
    void heart.getBoundingClientRect();
    heart.classList.add('beat');
  }
  lastTime = time;
}

function tick() {
  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback((_, meta) => { paint(meta.mediaTime); tick(); });
  } else {
    requestAnimationFrame(() => { if (!video.paused) paint(video.currentTime); tick(); });
  }
}

function setPlayLabel() {
  $('play').textContent = video.paused ? 'Play' : 'Pause';
  $('play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
}

for (const b of document.querySelectorAll('.segmented button')) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}
$('gain').addEventListener('input', () => {
  $('gainOut').textContent = `×${$('gain').value}`;
  if (video.paused) paint(video.currentTime);
});
$('play').addEventListener('click', async () => {
  if (!state) return;
  if (video.paused) await video.play().catch(() => {}); else video.pause();
  setPlayLabel();
});
$('demo').addEventListener('click', () => load(DEMO, true));
$('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  load(objectUrl, false);
  e.target.value = '';
});

tick();
load(DEMO, true);
