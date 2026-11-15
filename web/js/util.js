/* Shared pieces: palette, formatting, the canvas stage and a few small helpers.
   Colour rule from BRIEF.md: hue only ever means vessel type. Everything else
   (efficiency, shortfall, odds) uses brightness, opacity, thickness or length. */

const HW = window.HW = window.HW || {};

HW.C = {
  container: '#46b36f', tanker: '#f08a3c', bulk: '#8f82f2',   // cargo green, tankers orange (Sam, Nov 15)
  general: '#ea86b5', roro: '#e9c84b', other: '#f2f2f2',
  yes: '#f2f2f2', no: '#6b6b6b',
};

/* Light and dark themes for everything that isn't a vessel colour. The page CSS has the
   same values under :root and :root[data-theme="light"]. Dark is the default. */
HW.THEMES = {
  dark: {
    bg: '#0a0a0a', land: '#2c2f34', line: '#1c1c1e', fg: '#f2f2f0', dim: '#8a8a8a', faint: '#4a4a4a',
    accent: '#4c8dff', laneHi: '#9cc0ff', glow: '76,141,255', halo: 'rgba(10,10,10,0.85)',
    sphere: ['#16171a', '#111214', '#0d0d0f'], rim: 'rgba(242,242,240,0.16)', border: 'rgba(242,242,240,0.28)',
  },
  light: {
    bg: '#f4f4f1', land: '#d6d9df', line: '#e2e2de', fg: '#141414', dim: '#6a6a6a', faint: '#a9a9a9',
    accent: '#2f6fe0', laneHi: '#0b3fa8', glow: '47,111,224', halo: 'rgba(250,250,248,0.9)',
    sphere: ['#ffffff', '#f1f4f8', '#e6ebf2'], rim: 'rgba(20,20,20,0.2)', border: 'rgba(20,20,20,0.3)',
  },
};
HW.setTheme = t => {
  if (!HW.THEMES[t]) t = 'dark';
  Object.assign(HW.C, HW.THEMES[t]); HW.C.theme = t;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('hw-theme', t); } catch { /* private window: just don't remember */ }
};
// dark mode only (Kimball, Nov 15): the light theme is kept in THEMES but never used
HW.setTheme = (orig => () => orig('dark'))(HW.setTheme);
HW.setTheme('dark');
HW.MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
HW.SANS = '-apple-system, BlinkMacSystemFont, "Inter", "Helvetica Neue", Arial, sans-serif';

/* AIS ship type code -> our vessel group. AIS only says cargo (70-79) or tanker
   (80-89); it can't tell container from bulk, so "cargo" takes the container colour. */
HW.vesselGroup = code => {
  const n = +code;
  if (n >= 70 && n <= 79) return 'cargo';
  if (n >= 80 && n <= 89) return 'tanker';
  if (n >= 60 && n <= 69) return 'passenger';
  if (!n) return 'unknown';
  return 'other';
};
HW.groupColour = g => ({ cargo: HW.C.container, tanker: HW.C.tanker, passenger: HW.C.roro, bulk: HW.C.bulk, general: HW.C.general })[g] || HW.C.other;
HW.groupLabel = g => ({ cargo: 'CARGO / CONTAINER', tanker: 'TANKER', passenger: 'PASSENGER / RO-RO', other: 'OTHER', unknown: 'UNKNOWN' })[g] || g.toUpperCase();

HW.clamp = (v, a, b) => v < a ? a : v > b ? b : v;
HW.lerp = (a, b, t) => a + (b - a) * t;
HW.smooth = t => { t = HW.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
HW.ease = t => { t = HW.clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
HW.fInt = v => Math.round(v).toLocaleString('en-US');
HW.fPct = (v, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%';
HW.fUSD = v => v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'K' : '$' + Math.round(v);
HW.fDate = s => { const d = new Date(s + (s.length === 10 ? 'T00:00:00Z' : '')); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).toUpperCase(); };
HW.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* deterministic random, so dot patterns don't shimmer between reloads */
HW.rng = seed => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

/* canvas text with a dark halo so it reads over dots */
HW.label = (ctx, s, x, y, col, align, size, weight) => {
  ctx.globalAlpha = 1;
  ctx.font = (weight || 400) + ' ' + (size || 11) + 'px ' + HW.MONO;
  ctx.textAlign = align || 'left';
  ctx.lineJoin = 'round'; ctx.lineWidth = 3.5; ctx.strokeStyle = HW.C.halo;
  ctx.strokeText(s, x, y);
  ctx.fillStyle = col || HW.C.dim;
  ctx.fillText(s, x, y);
};

/* A canvas that sizes itself, animates only while visible, and reports pointer input.
   obj may define frame(st, dt), resize(st), down, drag(st, dx, dy), up, click, move, wheel(st, dy). */
HW.stage = (canvas, obj) => {
  const ctx = canvas.getContext('2d');
  const st = { canvas, ctx, W: 0, H: 0, dpr: 1, t: 0, paused: false, ptr: { x: -1e4, y: -1e4, inside: false, down: false, moved: 0 } };
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    st.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * st.dpr));
    canvas.height = Math.max(1, Math.round(r.height * st.dpr));
    st.W = r.width; st.H = r.height;
    if (obj.resize) obj.resize(st);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  let visible = true, raf = 0, last = 0;
  const loop = now => {
    raf = 0;
    if (!visible || st.paused) return;
    const dt = HW.clamp((now - last) / 1000 || 0.016, 0.001, 0.05);
    last = now; st.t += dt;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    obj.frame(st, dt);
    raf = requestAnimationFrame(loop);
  };
  st.start = () => { if (!raf && visible && !st.paused) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  st.pause = p => { st.paused = p; if (!p) st.start(); };
  new IntersectionObserver(es => { visible = es[0].isIntersecting; st.start(); }, { threshold: 0.01 }).observe(canvas);
  st.step = dt => { st.t += dt; ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); obj.frame(st, dt); };   // advance one frame by hand (testing)
  (window.__stages = window.__stages || {})[canvas.id] = st;

  const P = st.ptr;
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => {
    const [x, y] = pos(e); P.x = x; P.y = y; P.down = true; P.inside = true; P.moved = 0;
    canvas.setPointerCapture(e.pointerId);
    if (obj.down) obj.down(st);
  });
  canvas.addEventListener('pointermove', e => {
    const [x, y] = pos(e), dx = x - P.x, dy = y - P.y;
    P.x = x; P.y = y; P.inside = true;
    if (P.down) { P.moved += Math.abs(dx) + Math.abs(dy); if (obj.drag) obj.drag(st, dx, dy); }
    else if (obj.move) obj.move(st);
  });
  const release = e => {
    if (!P.down) return;
    P.down = false;
    if (obj.up) obj.up(st);
    if (P.moved < 5 && obj.click) obj.click(st);
    if (e.pointerType !== 'mouse') { P.inside = false; P.x = P.y = -1e4; }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { if (!P.down) { P.inside = false; P.x = P.y = -1e4; } });
  canvas.addEventListener('wheel', e => { if (obj.wheel) { e.preventDefault(); obj.wheel(st, e.deltaY); } }, { passive: false });
  st.start();
  return st;
};

/* small SVG sparkline (values array) used in panels; bright line, dim area */
HW.spark = (vals, w, h, opts = {}) => {
  const v = vals.filter(x => x != null && isFinite(x));
  if (!v.length) return '';
  const lo = opts.min != null ? opts.min : Math.min(...v), hi = opts.max != null ? opts.max : Math.max(...v), span = hi - lo || 1;
  const n = vals.length, X = i => (i / (n - 1)) * w, Y = x => h - 2 - ((x - lo) / span) * (h - 4);
  let d = '';
  vals.forEach((x, i) => { if (x == null || !isFinite(x)) return; d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x).toFixed(1); });
  const col = opts.colour || HW.C.fg;
  const base = opts.base != null ? `<line x1="0" x2="${w}" y1="${Y(opts.base)}" y2="${Y(opts.base)}" stroke="${HW.C.dim}" stroke-dasharray="2 3" stroke-width="1"/>` : '';
  const mark = opts.mark != null ? `<line x1="${X(opts.mark)}" x2="${X(opts.mark)}" y1="0" y2="${h}" stroke="${HW.C.fg}" stroke-width="1" opacity=".5"/>` : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${base}<path d="${d}L${w} ${h}L0 ${h}Z" fill="${col}" opacity=".07"/><path d="${d}" fill="none" stroke="${col}" stroke-width="1.3" vector-effect="non-scaling-stroke"/>${mark}</svg>`;
};
