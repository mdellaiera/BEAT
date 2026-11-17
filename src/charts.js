// Minimal single-series SVG line chart with a hover crosshair, optional point
// markers, a labelled peak and a movable playhead.

const NS = 'http://www.w3.org/2000/svg';
const tip = () => document.getElementById('tip');

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

/**
 * @param host container element
 * @param opt.x, opt.y      data arrays
 * @param opt.xTicks        tick positions in data units
 * @param opt.xFormat       tick label formatter
 * @param opt.tooltip       (index) => string
 * @param opt.markers       [{x, y}] dots drawn on the line
 * @param opt.peak          {x, y, text} direct label
 * @param opt.zeroBased     y axis starts at 0 (for power), else symmetric
 */
export function lineChart(host, opt) {
  let playheadX = null;
  let playhead = null;
  let sx = () => 0;

  function draw() {
    const W = Math.max(240, host.clientWidth), H = 150;
    const m = { l: 4, r: 4, t: 18, b: 20 };
    host.replaceChildren();
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': opt.label }, host);
    const { x, y } = opt;
    const x0 = x[0], x1 = x[x.length - 1];
    let lo = Infinity, hi = -Infinity;
    for (const v of y) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (opt.zeroBased) lo = 0;
    if (!(hi > lo)) hi = lo + 1;
    sx = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
    const sy = (v) => H - m.b - ((v - lo) / (hi - lo)) * (H - m.t - m.b);

    el('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }, svg);
    for (const t of opt.xTicks) {
      const label = el('text', { x: sx(t), y: H - 5, 'text-anchor': t === x0 ? 'start' : t === x1 ? 'end' : 'middle' }, svg);
      label.textContent = opt.xFormat(t);
    }
    let d = '';
    for (let i = 0; i < x.length; i++) d += `${i ? 'L' : 'M'}${sx(x[i]).toFixed(1)},${sy(y[i]).toFixed(1)}`;
    el('path', { class: 'line', d }, svg);
    for (const p of opt.markers ?? []) el('circle', { class: 'dot', cx: sx(p.x), cy: sy(p.y), r: 4 }, svg);
    if (opt.peak) {
      const px = sx(opt.peak.x);
      const label = el('text', { class: 'label', x: px + 8, y: m.t + 4, 'text-anchor': px > W - 110 ? 'end' : 'start' }, svg);
      if (px > W - 110) label.setAttribute('x', px - 8);
      label.textContent = opt.peak.text;
    }
    playhead = el('line', { class: 'playhead', y1: m.t - 6, y2: H - m.b, visibility: 'hidden' }, svg);
    const cross = el('line', { class: 'cross', y1: m.t - 6, y2: H - m.b, visibility: 'hidden' }, svg);
    setPlayhead(playheadX);

    svg.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const v = x0 + ((e.clientX - box.left - m.l) / (box.width - m.l - m.r)) * (x1 - x0);
      let i = Math.round(((v - x0) / (x1 - x0)) * (x.length - 1));
      i = Math.min(x.length - 1, Math.max(0, i));
      cross.setAttribute('x1', sx(x[i])); cross.setAttribute('x2', sx(x[i]));
      cross.setAttribute('visibility', 'visible');
      const t = tip();
      t.textContent = opt.tooltip(i);
      t.hidden = false;
      const left = Math.min(window.innerWidth - t.offsetWidth - 8, e.clientX + 12);
      t.style.left = `${left}px`;
      t.style.top = `${e.clientY - 32}px`;
    });
    svg.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      tip().hidden = true;
    });
  }

  function setPlayhead(v) {
    playheadX = v;
    if (!playhead) return;
    if (v == null) { playhead.setAttribute('visibility', 'hidden'); return; }
    playhead.setAttribute('x1', sx(v)); playhead.setAttribute('x2', sx(v));
    playhead.setAttribute('visibility', 'visible');
  }

  draw();
  const observer = new ResizeObserver(draw);
  observer.observe(host);
  return { setPlayhead, destroy: () => observer.disconnect() };
}
