/* Weather overlay for the globe: live conditions over the whole planet, drawn in the
   same glyph language as the logo and loading screen.

   Data: Open-Meteo (free, no key), current conditions on a 5° grid (1,944 points): wind,
   gusts, rain and weather code from the forecast API first, then wave height from the
   marine API a minute later (the free tier allows about 600 point-lookups a minute).
   Kept in the browser for 15 minutes, refreshed after that while the overlay is on.

   Each point is a glyph:
     shape  = what kind of weather it is: filled circle rain, plus wind, ring waves,
              square-in-square thunderstorm, small square calm
     colour = how rough it is: faint grey (calm) -> blue -> purple -> pink -> orange (severe)
     size   = roughness too; rough spots also get a soft see-through halo
   Shapes and colours shimmer in place like the logo. Hover a glyph for the numbers.

   On top of the glyphs (which now mark only the rough spots) sits a weather-app style
   field: the grid is interpolated onto 3° cells and drawn as a smooth, see-through colour
   gradient, blurred and clipped to the globe. Pick the layer in the legend: WIND, RAIN or
   WAVES. Calm areas stay clear.

   Where the data comes from: the server first (GET {SERVER}/api/weather/grid, shared by
   everyone, see the note to Ben in web/team/kimball.md), then Open-Meteo directly.

   Turned on and off with the WEATHER button (HW.wx.toggle()). globe.js calls
   HW.drawWeather(ctx, {...}) every frame; it draws nothing while the overlay is off. */

(() => {
  const HW = window.HW, RAD = Math.PI / 180;
  const vec = (lat, lon) => { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]; };
  const STEP = 5;   // 5° grid: 1,944 points (the coarse 10° ones load first)
  const PTS = [];
  for (let lat = -60; lat <= 70; lat += STEP) for (let lon = -180; lon < 180; lon += STEP) PTS.push({ lat, lon, v: vec(lat, lon), w: null });

  const SEV = ['rgba(242,242,240,0.28)', '#4c8dff', '#8f82f2', '#ea86b5', '#f08a3c'];
  const HALO = ['', '76,141,255', '143,130,242', '234,134,181', '240,138,60'];
  const wave = (x, y, t) => Math.sin(x * 0.7 + t * 0.6) + Math.sin(y * 0.9 - t * 0.45) + Math.sin((x + y) * 0.5 + t * 0.3);

  const wx = HW.wx = { on: false, loading: false, loadedAt: 0, fade: 0, hover: null };

  /* ---------- fetch ---------- */
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const CACHE = 'hw-weather-grid-v2';
  const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const save = () => { try { localStorage.setItem(CACHE, JSON.stringify({ at: wx.loadedAt, w: PTS.map(p => p.w) })); } catch { /* fine */ } };

  // Open-Meteo's free tier allows ~600 point-lookups a minute, so spend at most 500 a
  // minute: remember what we used and wait before a batch that would go over.
  const used = [];
  const budget = async n => {
    for (;;) {
      const now = Date.now();
      while (used.length && now - used[0][0] > 61000) used.shift();
      const sum = used.reduce((a, u) => a + u[1], 0);
      if (sum + n <= 500) { used.push([now, n]); return; }
      await new Promise(r => setTimeout(r, 2000));
    }
  };
  const fetchForecast = async g => {
    await budget(g.length);
    const f = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${g.map(p => p.lat).join(',')}&longitude=${g.map(p => p.lon).join(',')}&current=wind_speed_10m,wind_gusts_10m,precipitation,weather_code,cloud_cover&wind_speed_unit=kn`);
    (Array.isArray(f) ? f : [f]).forEach((r, i) => {
      const c = r && r.current; if (!c) return;
      g[i].w = { wind: c.wind_speed_10m, gust: c.wind_gusts_10m, rain: c.precipitation, code: c.weather_code, cloud: c.cloud_cover, wave: g[i].w ? g[i].w.wave : null };
      classify(g[i]);
    });
  };
  const fetchMarine = async g => {
    await budget(g.length);
    const m = await getJSON(`https://marine-api.open-meteo.com/v1/marine?latitude=${g.map(p => p.lat).join(',')}&longitude=${g.map(p => p.lon).join(',')}&current=wave_height`);
    (Array.isArray(m) ? m : [m]).forEach((r, i) => { if (g[i].w && r && r.current) { g[i].w.wave = r.current.wave_height; g[i].hasWave = true; classify(g[i]); } });
  };

  const fetchAll = async () => {
    if (wx.loading) return;
    wx.loading = true;
    // a fresh enough copy in this browser? start from it and only fetch what's missing
    let fresh = false;
    try {
      const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
      if (c && Date.now() - c.at < 15 * 60e3 && c.w.length === PTS.length) {
        c.w.forEach((w, i) => { PTS[i].w = w; PTS[i].hasWave = !!(w && w.wave != null); if (w) classify(PTS[i]); });
        wx.loadedAt = c.at; fresh = true; fieldDirty = true; summary();
      }
    } catch { /* no storage: just fetch */ }
    if (!fresh) {
      PTS.forEach(p => { p.w = null; p.hasWave = false; });
      status('LOADING LIVE WEATHER…');
      // 0. our server's shared copy, if it has one
      try {
        const d = await getJSON(`${HW.SERVER}/api/weather/grid`);
        const byKey = new Map((d.points || []).map(q => [q.lat + ',' + q.lon, q]));
        let n = 0;
        PTS.forEach(p => { const q = byKey.get(p.lat + ',' + p.lon); if (q) { p.w = { wind: q.wind, gust: q.gust, rain: q.rain, code: q.code, cloud: q.cloud, wave: q.wave }; p.hasWave = true; classify(p); n++; } });
        if (n > PTS.length * 0.2) { wx.loadedAt = Date.parse(d.at) || Date.now(); fieldDirty = true; summary(' · FROM OUR SERVER'); save(); }
      } catch { /* server doesn't have it (yet): ask Open-Meteo directly */ }
      wx.loadedAt = wx.loadedAt || Date.now();
    }
    // 1. coarse 10° points first so the map fills in fast, then the in-between 5° points
    const coarse = PTS.filter(p => p.lat % 10 === 0 && p.lon % 10 === 0), fine = PTS.filter(p => !(p.lat % 10 === 0 && p.lon % 10 === 0));
    const order = [...coarse, ...fine];
    const jobs = [];
    chunk(order.filter(p => !p.w), 120).forEach(g => jobs.push(['f', g]));
    chunk(order.filter(p => !p.hasWave), 120).forEach(g => jobs.push(['m', g]));
    // run waves for the coarse points right after their forecast, then the rest
    jobs.sort((a, b) => (order.indexOf(a[1][0]) - order.indexOf(b[1][0])) || (a[0] === 'f' ? -1 : 1));
    let done = 0;
    for (const [kind, g] of jobs) {
      try { if (kind === 'f') await fetchForecast(g); else await fetchMarine(g); } catch { /* skip this batch */ }
      done++; fieldDirty = true; save();
      summary(done < jobs.length ? ` · REFINING ${Math.round(done / jobs.length * 100)}%` : '');
    }
    wx.loading = false; fieldDirty = true; summary(); save();
  };
  const summary = (extra = '') => {
    const n = PTS.filter(p => p.w).length, rough = PTS.filter(p => p.w && p.sev >= 0.5).length;
    status(n ? `${n} POINTS · ${rough} ROUGH · OPEN-METEO, LIVE${extra}` : 'WEATHER UNAVAILABLE RIGHT NOW');
  };

  // what kind of weather, and how rough (0 calm .. 1 severe)
  const classify = p => {
    const w = p.w, code = +w.code || 0;
    const sWind = Math.max((w.wind || 0) / 45, (w.gust || 0) / 65);
    const sRain = (w.rain || 0) / 5;
    const sWave = w.wave != null ? w.wave / 7 : 0;
    const storm = code >= 95, snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
    p.sev = Math.min(1, Math.max(sWind, sRain, sWave, storm ? 0.85 : 0, snow ? 0.35 : 0));
    p.kind = storm ? 'storm' : sRain >= Math.max(sWind, sWave) && sRain > 0.05 ? 'rain' : sWave > sWind && sWave > 0.15 ? 'waves' : sWind > 0.15 ? 'wind' : 'calm';
    p.level = p.sev < 0.2 ? 0 : p.sev < 0.4 ? 1 : p.sev < 0.6 ? 2 : p.sev < 0.8 ? 3 : 4;
  };

  /* ---------- the gradient field ---------- */
  // colour ramps per layer: [value, r, g, b, alpha]; below the first stop it's clear
  const LAYERS = {
    wind: { label: 'WIND', unit: 'KN', get: w => w.wind, stops: [[8, 76, 141, 255, 0.00], [14, 76, 141, 255, 0.50], [22, 143, 130, 242, 0.71], [32, 234, 134, 181, 0.90], [44, 240, 138, 60, 0.90], [60, 255, 226, 170, 0.90]] },
    rain: { label: 'RAIN', unit: 'MM/H', get: w => w.rain, stops: [[0.05, 76, 141, 255, 0.00], [0.3, 76, 141, 255, 0.62], [1, 143, 130, 242, 0.81], [3, 234, 134, 181, 0.90], [7, 240, 138, 60, 0.90], [15, 255, 226, 170, 0.90]] },
    waves: { label: 'WAVES', unit: 'M', get: w => w.wave, stops: [[0.6, 76, 141, 255, 0.00], [1.2, 76, 141, 255, 0.46], [2.2, 143, 130, 242, 0.68], [3.5, 234, 134, 181, 0.87], [5, 240, 138, 60, 0.90], [8, 255, 226, 170, 0.90]] },
  };
  wx.layer = 'wind';
  let fieldDirty = true;
  const rampAt = (stops, v) => {
    if (v == null || !(v > stops[0][0])) return null;
    for (let k = 1; k < stops.length; k++) {
      if (v <= stops[k][0]) {
        const a = stops[k - 1], b = stops[k], u = (v - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u, a[4] + (b[4] - a[4]) * u];
      }
    }
    const z = stops[stops.length - 1]; return [z[1], z[2], z[3], z[4]];
  };
  // grid value at any lat/lon: bilinear between the 10° points, wrapping in longitude
  const ROWS = Math.round((70 - -60) / STEP) + 1, COLS = 360 / STEP;
  const gridVal = (get, lat, lon) => gridAt(get, lat, lon, STEP) ?? gridAt(get, lat, lon, 10);
  const gridAt = (get, lat, lon, step) => {
    const k = step / STEP, R2 = Math.round((70 - -60) / step) + 1, C2 = 360 / step;
    const r = (lat + 60) / step, c = ((lon + 180) % 360 + 360) % 360 / STEP;
    const c2 = ((lon + 180) % 360 + 360) % 360 / step;
    const r0 = Math.max(0, Math.min(R2 - 1, Math.floor(r))), r1 = Math.min(R2 - 1, r0 + 1), c0 = Math.floor(c2) % C2, c1 = (c0 + 1) % C2;
    const fr = Math.max(0, Math.min(1, r - r0)), fc = c2 - Math.floor(c2);
    let sum = 0, wsum = 0;
    [[r0, c0, (1 - fr) * (1 - fc)], [r0, c1, (1 - fr) * fc], [r1, c0, fr * (1 - fc)], [r1, c1, fr * fc]].forEach(([rr, cc, wt]) => {
      const p = PTS[(rr * k) * COLS + cc * k]; const v = p && p.w ? get(p.w) : null;
      if (v != null && wt > 0) { sum += v * wt; wsum += wt; }
    });
    return wsum > 0.6 ? sum / wsum : null;
  };
  // 3° cells over the globe, corners as 3D unit vectors
  const CS = 2, CLAT0 = -72, CLAT1 = 78, NR = (CLAT1 - CLAT0) / CS, NC = 360 / CS;
  const VX = new Float32Array((NR + 1) * (NC + 1)), VY = new Float32Array(VX.length), VZ = new Float32Array(VX.length);
  for (let i = 0; i <= NR; i++) for (let j = 0; j <= NC; j++) { const v = vec(CLAT0 + i * CS, -180 + j * CS), k = i * (NC + 1) + j; VX[k] = v[0]; VY[k] = v[1]; VZ[k] = v[2]; }
  const PX = new Float32Array(VX.length), PY = new Float32Array(VX.length), PZ = new Float32Array(VX.length);
  let cellFill = new Array(NR * NC).fill(null);
  const buildField = () => {
    const L = LAYERS[wx.layer];
    for (let i = 0; i < NR; i++) for (let j = 0; j < NC; j++) {
      const lat = CLAT0 + (i + 0.5) * CS, lon = -180 + (j + 0.5) * CS;
      let c = rampAt(L.stops, gridVal(L.get, lat, lon));
      if (c && (lat < -60 || lat > 70)) c[3] *= Math.max(0, 1 - Math.min(Math.abs(lat + 60), Math.abs(lat - 70)) / 8);   // fade past the data
      cellFill[i * NC + j] = c && c[3] > 0.02 ? `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(3)})` : null;
    }
    fieldDirty = false;
  };
  const off = document.createElement('canvas'), octx = off.getContext('2d');
  const drawField = (ctx, W, H, cx, cy, R, view, alpha) => {
    if (fieldDirty) buildField();
    const sc = 0.5, w = Math.ceil(W * sc), h = Math.ceil(H * sc);
    if (off.width !== w || off.height !== h) { off.width = w; off.height = h; }
    octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, w, h);
    for (let k = 0; k < VX.length; k++) {
      const q = view([VX[k], VY[k], VZ[k]]);
      PX[k] = (cx + q[0] * R) * sc; PY[k] = (cy - q[1] * R) * sc; PZ[k] = q[2];
    }
    for (let i = 0; i < NR; i++) for (let j = 0; j < NC; j++) {
      const f = cellFill[i * NC + j]; if (!f) continue;
      const a = i * (NC + 1) + j, b = a + 1, c = a + NC + 2, d = a + NC + 1;
      if (PZ[a] + PZ[b] + PZ[c] + PZ[d] < 0.05) continue;   // on the far side
      octx.fillStyle = f; octx.beginPath();
      octx.moveTo(PX[a], PY[a]); octx.lineTo(PX[b], PY[b]); octx.lineTo(PX[c], PY[c]); octx.lineTo(PX[d], PY[d]); octx.closePath(); octx.fill();
    }
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.filter = `blur(${Math.max(2, R / 140).toFixed(1)}px) saturate(1.25)`;   // soften the cells into a smooth gradient
    ctx.drawImage(off, 0, 0, W, H);
    ctx.filter = 'none';
    ctx.restore();
  };

  /* ---------- the button, the legend and the status line ---------- */
  let legend = null;
  const status = text => { const el = legend && legend.querySelector('.wx-status'); if (el) el.textContent = text; };
  const glyphSvg = (k, col) => ({
    rain: `<circle cx="7" cy="7" r="4.5" fill="${col}"/>`,
    wind: `<path d="M2 7h10M7 2v10" stroke="${col}" stroke-width="2.4"/>`,
    waves: `<circle cx="7" cy="7" r="4.3" fill="none" stroke="${col}" stroke-width="2"/>`,
    storm: `<rect x="2" y="2" width="10" height="10" fill="none" stroke="${col}" stroke-width="1.8"/><rect x="5" y="5" width="4" height="4" fill="${col}"/>`,
    calm: `<rect x="5" y="5" width="4" height="4" fill="${col}"/>`,
  })[k];
  const makeLegend = () => {
    legend = document.createElement('div');
    legend.className = 'wx-legend';
    legend.innerHTML = `<div class="tag">WEATHER ON THE GLOBE</div>
      <div class="wx-layers">${Object.entries(LAYERS).map(([k, L]) => `<button data-l="${k}" class="${k === wx.layer ? 'on' : ''}">${L.label}</button>`).join('')}</div>
      <div class="wx-grad"></div><div class="wx-grad-l"></div>
      <div class="tag" style="margin-top:12px">ROUGH SPOTS</div>
      <div class="wx-keys">${[['rain', 'RAIN'], ['wind', 'WIND'], ['waves', 'WAVES'], ['storm', 'THUNDERSTORM'], ['calm', 'CALM']].map(([k, l]) => `<span><svg width="14" height="14">${glyphSvg(k, '#f2f2f0')}</svg>${l}</span>`).join('')}</div>
      <div class="wx-ramp">${SEV.map((c, i) => `<i style="background:${i ? c : '#5a5a5a'}"></i>`).join('')}</div>
      <div class="wx-ramp-l"><span>CALM</span><span>SEVERE</span></div>
      <div class="tag wx-status">—</div>`;
    document.body.appendChild(legend);
    legend.querySelectorAll('.wx-layers button').forEach(b => b.addEventListener('click', () => setLayer(b.dataset.l)));
    paintRamp();
  };
  const paintRamp = () => {
    if (!legend) return;
    const L = LAYERS[wx.layer], st = L.stops;
    legend.querySelector('.wx-grad').style.background = `linear-gradient(90deg, ${st.map((s2, k) => `rgba(${s2[1]},${s2[2]},${s2[3]},${Math.max(0.08, s2[4])}) ${(k / (st.length - 1) * 100).toFixed(0)}%`).join(', ')})`;
    legend.querySelector('.wx-grad-l').innerHTML = `<span>${st[0][0]} ${L.unit}</span><span>${st[Math.floor(st.length / 2)][0]}</span><span>${st[st.length - 1][0]}+</span>`;
    legend.querySelectorAll('.wx-layers button').forEach(b => b.classList.toggle('on', b.dataset.l === wx.layer));
  };
  const setLayer = k => { if (!LAYERS[k]) return; wx.layer = k; fieldDirty = true; paintRamp(); };
  wx.setLayer = setLayer;
  const style = document.createElement('style');
  style.textContent = `
    .wx-legend { position:fixed; right:24px; bottom:64px; z-index:6; width:250px; background:rgba(14,14,15,.72); backdrop-filter:blur(12px); border:1px solid #2a2a2c; border-radius:14px; padding:14px 16px; opacity:0; transform:translateY(8px); transition:opacity .4s, transform .4s; pointer-events:none; font:300 10px/1.4 ui-monospace,"SF Mono",Menlo,monospace; letter-spacing:.14em; color:#a8a8a8; }
    body.wx-on .wx-legend { opacity:1; transform:none; pointer-events:auto; }
    .wx-legend .wx-keys { display:flex; flex-wrap:wrap; gap:8px 14px; margin:10px 0 12px; color:#e6e6e4; }
    .wx-legend .wx-keys span { display:inline-flex; align-items:center; gap:6px; }
    .wx-legend .wx-ramp { display:flex; height:6px; border-radius:3px; overflow:hidden; }
    .wx-legend .wx-ramp i { flex:1; }
    .wx-legend .wx-ramp-l { display:flex; justify-content:space-between; margin:5px 0 10px; }
    .wx-legend .wx-status { color:#8a8a8a; font-size:9.5px; }
    .wx-legend .wx-layers { display:flex; gap:4px; margin:10px 0 10px; }
    .wx-legend .wx-layers button { flex:1; font:400 10px/1 ui-monospace,"SF Mono",Menlo,monospace; letter-spacing:.14em; color:#cfcfcf; padding:7px 0; border:1px solid #2a2a2c; border-radius:999px; background:none; cursor:pointer; }
    .wx-legend .wx-layers button.on { background:#f2f2f0; color:#0a0a0a; border-color:#f2f2f0; }
    .wx-legend .wx-grad { height:8px; border-radius:4px; }
    .wx-legend .wx-grad-l { display:flex; justify-content:space-between; margin-top:5px; }
    #wxBtn.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  `;
  document.head.appendChild(style);

  wx.toggle = on => {
    wx.on = on == null ? !wx.on : on;
    if (!legend) makeLegend();
    document.body.classList.toggle('wx-on', wx.on);
    const b = document.getElementById('wxBtn'); if (b) b.classList.toggle('on', wx.on);
    if (wx.on && (!wx.loadedAt || Date.now() - wx.loadedAt > 15 * 60e3)) fetchAll();
    else if (wx.on) summary();
  };
  setInterval(() => { if (wx.on && !wx.loading && Date.now() - wx.loadedAt > 15 * 60e3) fetchAll(); }, 60e3);
  document.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'w' && !e.target.closest('input, textarea') && !e.metaKey && !e.ctrlKey) wx.toggle();
  });
  const hook = () => { const b = document.getElementById('wxBtn'); if (b) b.addEventListener('click', () => wx.toggle()); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook); else hook();

  /* ---------- drawing ---------- */
  let t = 0;
  HW.drawWeather = (ctx, { W, H, cx, cy, R, view, dt, P, zoom }) => {
    t += dt;
    wx.fade += ((wx.on ? 1 : 0) - wx.fade) * (1 - Math.exp(-5 * dt));
    if (wx.fade < 0.01) { wx.hover = null; return; }
    drawField(ctx, W, H, cx, cy, R, view, wx.fade * (0.92 + 0.08 * Math.sin(t * 0.8)));
    const base = 3.4 + 1.2 * Math.sqrt(zoom);
    let best = null, bestD = 400;
    const drawn = [];
    for (let i = 0; i < PTS.length; i++) {
      const p = PTS[i];
      if (!p.w) continue;
      const q = view(p.v);
      if (q[2] < 0.04) continue;
      const x = cx + q[0] * R, y = cy - q[1] * R;
      const edge = q[2] < 0.25 ? q[2] * 4 : 1;
      // shimmer: rough cells pulse, every cell's level flickers a step now and then
      const sh = wave(p.lon / 6, p.lat / 6, t);
      const lvl = Math.max(0, Math.min(4, p.level + (sh > 2.6 && p.level < 4 ? 1 : 0)));
      const s = base + p.sev * 9 * Math.sqrt(zoom) * (1 + 0.12 * Math.sin(t * 2 + i));
      if (p.level >= 2) {
        const r = s * (2.2 + p.sev * 1.4);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${HALO[p.level]},${0.32 * p.sev})`); g.addColorStop(1, `rgba(${HALO[p.level]},0)`);
        ctx.globalAlpha = wx.fade * edge; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
      }
      if (p.level >= 2) drawn.push([x, y, s, lvl, p.kind, edge]);   // the field shows the rest; glyphs mark rough spots
      if (P.inside && !P.down) { const d = (x - P.x) ** 2 + (y - P.y) ** 2; if (d < bestD) { bestD = d; best = { p, x, y }; } }
    }
    for (const [x, y, s, lvl, kind, edge] of drawn) {
      const col = SEV[lvl], h = s / 2;
      ctx.globalAlpha = wx.fade * edge * (lvl ? 0.92 : 1);
      ctx.fillStyle = col; ctx.strokeStyle = col;
      if (kind === 'rain') { ctx.beginPath(); ctx.arc(x, y, h, 0, 6.2832); ctx.fill(); }
      else if (kind === 'wind') { const w = Math.max(1.2, s * 0.24); ctx.fillRect(x - h, y - w / 2, s, w); ctx.fillRect(x - w / 2, y - h, w, s); }
      else if (kind === 'waves') { ctx.lineWidth = Math.max(1.2, s * 0.2); ctx.beginPath(); ctx.arc(x, y, h * 0.8, 0, 6.2832); ctx.stroke(); }
      else if (kind === 'storm') { ctx.lineWidth = Math.max(1.1, s * 0.15); ctx.strokeRect(x - h, y - h, s, s); ctx.fillRect(x - h * 0.4, y - h * 0.4, s * 0.4, s * 0.4); }
      else { const c = Math.max(1.4, s * 0.38); ctx.fillRect(x - c / 2, y - c / 2, c, c); }
    }
    wx.hover = best;
    if (best && wx.fade > 0.5) {
      const w = best.p.w, f = (v, u, d = 0) => v == null ? null : (+v).toFixed(d) + u;
      const parts = [f(w.wind, ' KN WIND'), f(w.gust, ' KN GUSTS'), w.wave != null ? f(w.wave, ' M WAVES', 1) : null, w.rain ? f(w.rain, ' MM RAIN', 1) : null].filter(Boolean);
      ctx.globalAlpha = 1;
      HW.label(ctx, `${Math.abs(best.p.lat)}°${best.p.lat >= 0 ? 'N' : 'S'} ${Math.abs(best.p.lon)}°${best.p.lon >= 0 ? 'E' : 'W'} · ${best.p.kind.toUpperCase()}`, best.x + 12, best.y - 14, HW.C.fg, 'left', 11, 500);
      HW.label(ctx, parts.join(' · '), best.x + 12, best.y + 1, HW.C.fg, 'left', 10.5);
    }
    ctx.globalAlpha = 1;
  };
})();
