/* Motion on the globe (Kimball's, Nov 15): things that move so the page feels alive.

   globe.js calls HW.drawFx(ctx, {...}) once a frame, after the routes and the strait rings.
     - Traffic pulses: short bright streaks that run along each route, more of them and
       faster on the routes more ships use this week. Blocked routes get none.
     - Satellites on tilted orbits just above the globe, with short trails.
     - Sonar rings: a strait running well under its normal traffic sends out slow rings,
       quicker the worse it is.
   Pulses are accent blue and the text colour; the rings are the straits' amber. */

(() => {
  const HW = window.HW;
  const pulses = new Map();   // lane id -> [{ s (0..1 along the lane), v (speed) }]
  let clock = 0;
  // Satellites: a handful on tilted orbits just above the surface. Each is a small body with two
  // solar panels and a short fading trail. They pass in front of the globe and disappear behind it.
  const SATS = [];
  for (let i = 0; i < 9; i++) {
    const inc = (20 + (i * 47) % 78) * Math.PI / 180, node = i * 2.399, alt = 1.1 + (i % 4) * 0.055;
    // orbit plane: two unit vectors u (along the equator at the node) and w (tilted by the inclination)
    const u = [Math.sin(node), 0, Math.cos(node)], w = [Math.cos(node) * Math.cos(inc), Math.sin(inc), -Math.sin(node) * Math.cos(inc)];
    SATS.push({ u, w, alt, ph: i * 1.7, sp: (0.11 + (i % 3) * 0.03) * (i % 2 ? 1 : -1) });
  }
  const satAt = (s, a, view, out) => {
    const c = Math.cos(a), n = Math.sin(a), q = view([s.u[0] * c + s.w[0] * n, s.u[1] * c + s.w[1] * n, s.u[2] * c + s.w[2] * n]);
    out[0] = q[0] * s.alt; out[1] = q[1] * s.alt; out[2] = q[2] * s.alt; return out;
  };
  const drawSats = (ctx, { view, cx, cy, R, quiet }) => {
    const C = HW.C, p = [0, 0, 0], q = [0, 0, 0];
    const seen = v => v[2] > 0 || v[0] * v[0] + v[1] * v[1] > 1.0;   // in front, or past the globe's edge
    for (const s of SATS) {
      const a = s.ph + clock * s.sp;
      satAt(s, a, view, p); if (!seen(p)) continue;
      const x = cx + p[0] * R, y = cy - p[1] * R, far = p[2] < 0 ? 0.45 : 1;
      // trail
      let lx = x, ly = y;
      for (let k = 1; k <= 14; k++) {
        satAt(s, a - Math.sign(s.sp) * k * 0.022, view, q); if (!seen(q)) break;
        const tx = cx + q[0] * R, ty = cy - q[1] * R;
        ctx.globalAlpha = 0.5 * (1 - k / 14) * far * quiet; ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(tx, ty); ctx.stroke(); lx = tx; ly = ty;
      }
      // body and two panels, turned along the direction of travel
      satAt(s, a + Math.sign(s.sp) * 0.02, view, q);
      let dx = cx + q[0] * R - x, dy = cy - q[1] * R - y; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      ctx.globalAlpha = far * quiet; ctx.strokeStyle = C.fg; ctx.fillStyle = C.fg; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(x - dy * 6, y + dx * 6); ctx.lineTo(x - dy * 2.4, y + dx * 2.4); ctx.moveTo(x + dy * 2.4, y - dx * 2.4); ctx.lineTo(x + dy * 6, y - dx * 6); ctx.stroke();
      ctx.fillRect(x - 1.6, y - 1.6, 3.2, 3.2);
    }
    ctx.globalAlpha = 1;
  };
  HW.drawFx = (ctx, { lanes, straits, straitRatio, laneBlocked, dt, zoom, quiet, view, cx, cy, R }) => {
    const C = HW.C;
    clock += dt;
    ctx.save();
    ctx.lineCap = 'round';
    /* traffic pulses */
    for (const L of lanes) {
      const busy = L.busy || 0, n = L.pts.length;
      if (busy < 0.12 || n < 8 || (laneBlocked && laneBlocked(L) > 0.3)) continue;
      let ps = pulses.get(L.id);
      if (!ps) {
        ps = []; const k = 1 + Math.round(busy * 3);
        for (let i = 0; i < k; i++) ps.push({ s: (i + Math.random() * 0.6) / k, v: (0.035 + 0.05 * busy) * (0.8 + Math.random() * 0.4) / Math.max(0.6, L.len) });
        pulses.set(L.id, ps);
      }
      const TAIL = Math.max(5, Math.min(14, Math.round(n * 0.07)));
      for (const p of ps) {
        p.s += p.v * dt; if (p.s > 1) p.s -= 1;
        const head = p.s * (n - 1), j0 = Math.floor(head);
        for (let k = 0; k < TAIL; k++) {
          const a = j0 - k, b = a - 1; if (b < 0) break;
          if (!L.sv[a] || !L.sv[b]) continue;
          const f = 1 - k / TAIL;
          ctx.globalAlpha = 0.85 * f * f * quiet;
          ctx.strokeStyle = k < 2 ? C.fg : C.accent;
          ctx.lineWidth = (1.2 + 1.6 * busy) * (0.5 + 0.5 * f);
          ctx.beginPath(); ctx.moveTo(L.sx[a], L.sy[a]); ctx.lineTo(L.sx[b], L.sy[b]); ctx.stroke();
        }
      }
    }
    /* sonar rings on the straits that are well down on a normal week */
    const base = 9 + 2.2 * Math.sqrt(zoom);
    for (const s of straits) {
      if (!s.vis) continue;
      const r = straitRatio(s); if (!(r < 0.75) || s.status.baseline_per_week < 50) continue;
      const sev = HW.clamp(1 - r, 0, 1), period = 3.4 - 1.8 * sev, reach = 26 + 34 * sev;
      for (let k = 0; k < 2; k++) {
        const ph = ((clock + (s.lat + s.lon) * 0.01) / period + k * 0.5) % 1;
        ctx.globalAlpha = 0.7 * (1 - ph) * (1 - ph) * sev;
        ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(s.sx, s.sy, base + reach * ph, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (view) drawSats(ctx, { view, cx, cy, R, quiet });
    ctx.restore();
  };
})();
