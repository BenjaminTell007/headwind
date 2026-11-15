/* Weather overlay for the globe: live conditions over the whole planet, drawn in the
   same glyph language as the logo and loading screen.

   Data: Open-Meteo (free, no key), current conditions on a 10° grid (504 points): wind,
   gusts, rain and weather code from the forecast API first, then wave height from the
   marine API a minute later (the free tier allows about 600 point-lookups a minute).
   Kept in the browser for 15 minutes, refreshed after that while the overlay is on.

   Each point is a glyph:
     shape  = what kind of weather it is: filled circle rain, plus wind, ring waves,
              square-in-square thunderstorm, small square calm
     colour = how rough it is: faint grey (calm) -> blue -> purple -> pink -> orange (severe)
     size   = roughness too; rough spots also get a soft see-through halo
   Shapes and colours shimmer in place like the logo. Hover a glyph for the numbers.

   Turned on and off with the WEATHER button (HW.wx.toggle()). globe.js calls
   HW.drawWeather(ctx, {...}) every frame; it draws nothing while the overlay is off. */

(() => {
  const HW = window.HW, RAD = Math.PI / 180;
  const vec = (lat, lon) => { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]; };
  const STEP = 10;
  const PTS = [];
  for (let lat = -60; lat <= 70; lat += STEP) for (let lon = -180; lon < 180; lon += STEP) PTS.push({ lat, lon, v: vec(lat, lon), w: null });

  const SEV = ['rgba(242,242,240,0.28)', '#4c8dff', '#8f82f2', '#ea86b5', '#f08a3c'];
  const HALO = ['', '76,141,255', '143,130,242', '234,134,181', '240,138,60'];
  const wave = (x, y, t) => Math.sin(x * 0.7 + t * 0.6) + Math.sin(y * 0.9 - t * 0.45) + Math.sin((x + y) * 0.5 + t * 0.3);

  const wx = HW.wx = { on: false, loading: false, loadedAt: 0, fade: 0, hover: null };

  /* ---------- fetch ---------- */
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const CACHE = 'hw-weather-grid-v1';
  const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const fetchAll = async () => {
    if (wx.loading) return;
    // fresh enough copy in this browser? use it
    try {
      const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
      if (c && Date.now() - c.at < 15 * 60e3 && c.w.length === PTS.length) {
        c.w.forEach((w, i) => { PTS[i].w = w; if (w) classify(PTS[i]); });
        wx.loadedAt = c.at; summary(); return;
      }
    } catch { /* no storage: just fetch */ }
    wx.loading = true; status('LOADING LIVE WEATHER…');
    const groups = chunk(PTS, 126);
    // 1. wind, gusts, rain, weather code
    for (const g of groups) {
      try {
        const f = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${g.map(p => p.lat).join(',')}&longitude=${g.map(p => p.lon).join(',')}&current=wind_speed_10m,wind_gusts_10m,precipitation,weather_code,cloud_cover&wind_speed_unit=kn`);
        (Array.isArray(f) ? f : [f]).forEach((r, i) => {
          const c = r && r.current; if (!c) return;
          g[i].w = { wind: c.wind_speed_10m, gust: c.wind_gusts_10m, rain: c.precipitation, code: c.weather_code, cloud: c.cloud_cover, wave: g[i].w ? g[i].w.wave : null };
          classify(g[i]);
        });
      } catch { /* leave these points empty */ }
    }
    wx.loadedAt = Date.now(); summary(' · WAVES IN A MINUTE');
    // 2. wave heights, a minute later so we stay inside the free rate limit
    setTimeout(async () => {
      for (const g of groups) {
        try {
          const m = await getJSON(`https://marine-api.open-meteo.com/v1/marine?latitude=${g.map(p => p.lat).join(',')}&longitude=${g.map(p => p.lon).join(',')}&current=wave_height`);
          (Array.isArray(m) ? m : [m]).forEach((r, i) => { if (g[i].w && r && r.current) { g[i].w.wave = r.current.wave_height; classify(g[i]); } });
        } catch { /* no waves for these */ }
      }
      wx.loading = false; summary();
      try { localStorage.setItem(CACHE, JSON.stringify({ at: wx.loadedAt, w: PTS.map(p => p.w) })); } catch { /* fine */ }
    }, 61000);
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
      <div class="wx-keys">${[['rain', 'RAIN'], ['wind', 'WIND'], ['waves', 'WAVES'], ['storm', 'THUNDERSTORM'], ['calm', 'CALM']].map(([k, l]) => `<span><svg width="14" height="14">${glyphSvg(k, '#f2f2f0')}</svg>${l}</span>`).join('')}</div>
      <div class="wx-ramp">${SEV.map((c, i) => `<i style="background:${i ? c : '#5a5a5a'}"></i>`).join('')}</div>
      <div class="wx-ramp-l"><span>CALM</span><span>SEVERE</span></div>
      <div class="tag wx-status">—</div>`;
    document.body.appendChild(legend);
  };
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
  HW.drawWeather = (ctx, { cx, cy, R, view, dt, P, zoom }) => {
    t += dt;
    wx.fade += ((wx.on ? 1 : 0) - wx.fade) * (1 - Math.exp(-5 * dt));
    if (wx.fade < 0.01) { wx.hover = null; return; }
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
      drawn.push([x, y, s, lvl, p.kind, edge]);
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
