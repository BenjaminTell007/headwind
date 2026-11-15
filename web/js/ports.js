/* Major ports on the globe: the 30 big container and energy ports in
   data/processed/ports.csv, drawn as small square markers. Names show when you zoom in;
   hovering one shows how many live cargo ships and tankers are within 40 km of it.

   globe.js calls HW.drawPorts(ctx, {...}) every frame, after the weather and before the
   routes. Clicking near a port flies the globe to it. */

(() => {
  const HW = window.HW, RAD = Math.PI / 180;
  const vec = (lat, lon) => { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]; };
  let ports = [];
  const load = async () => {
    for (const url of ['../data/processed/ports.csv', `${HW.SERVER}/data/ports.csv`]) {
      try {
        const txt = await fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); });
        ports = txt.trim().split('\n').slice(1).map((line, i) => {
          const [name, lon, lat] = line.split(',');
          return { name, lat: +lat, lon: +lon, v: vec(+lat, +lon), rank: i, near: 0 };
        }).filter(p => isFinite(p.lat) && isFinite(p.lon));
        return;
      } catch { /* try the next source */ }
    }
  };
  load();

  // count live ships near each port every 30 s (cheap: ~2,000 ships x 30 ports)
  const countNear = () => {
    const g = window.__hw && window.__hw.globe; if (!g || !ports.length) return;
    for (const p of ports) {
      let n = 0;
      for (const s of g.S.ships) {
        const dLat = (s.lat - p.lat) * 111, dLon = (s.lon - p.lon) * 111 * Math.cos(p.lat * RAD);
        if (dLat * dLat + dLon * dLon < 1600) n++;
      }
      p.near = n;
    }
  };
  setInterval(countNear, 30000); setTimeout(countNear, 8000);

  let hover = null;
  HW.drawPorts = (ctx, { cx, cy, R, view, P, zoom }) => {
    if (!ports.length) return;
    const C = HW.C;
    let best = null, bestD = 150;
    for (const p of ports) {
      const q = view(p.v); if (q[2] < 0.05) continue;
      const x = cx + q[0] * R, y = cy - q[1] * R, fade = q[2] < 0.3 ? q[2] / 0.3 : 1;
      const big = p.rank < 10, s = (big ? 5 : 4) + Math.min(2.5, Math.sqrt(zoom));
      ctx.globalAlpha = 0.9 * fade;
      ctx.strokeStyle = C.fg; ctx.lineWidth = 1.2;
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      ctx.fillStyle = C.accent; ctx.fillRect(x - s * 0.18, y - s * 0.18, s * 0.36, s * 0.36);
      if ((zoom > 1.9 || (big && zoom > 1.25)) && p !== hover) HW.label(ctx, p.name.toUpperCase(), x + s, y - s, C.dim, 'left', 9.5);
      if (P.inside && !P.down) { const d = (x - P.x) ** 2 + (y - P.y) ** 2; if (d < bestD) { bestD = d; best = { p, x, y }; } }
    }
    hover = best ? best.p : null;
    if (best) {
      ctx.globalAlpha = 1;
      HW.label(ctx, best.p.name.toUpperCase() + ' · MAJOR PORT', best.x + 10, best.y - 12, C.fg, 'left', 11, 500);
      HW.label(ctx, `${best.p.near} CARGO SHIPS + TANKERS WITHIN 40 KM · CLICK TO ZOOM`, best.x + 10, best.y + 3, C.fg, 'left', 10);
    }
    ctx.globalAlpha = 1;
  };
  // click a port: fly in close (capture phase, before the globe's own click picks a lane)
  window.addEventListener('click', e => {
    if (!hover || !e.target || e.target.id !== 'globe') return;
    const g = window.__hw && window.__hw.globe; if (!g) return;
    const p = hover;
    // the globe handles the same click (it may pick a route underneath), so fly after it
    setTimeout(() => { g.select(null); g.flyTo(p.lat, p.lon, 6); }, 0);
  }, true);
})();
