/* Motion on the globe (Kimball's, Nov 15): things that move so the page feels alive.

   globe.js calls HW.drawFx(ctx, {...}) once a frame, after the routes and the strait rings.
     - Traffic pulses: short bright streaks that run along each route, more of them and
       faster on the routes more ships use this week. Blocked routes get none.
     - Sonar rings: a strait running well under its normal traffic sends out slow rings,
       quicker the worse it is.
   Colours follow the rules: accent blue and the text colour only. */

(() => {
  const HW = window.HW;
  const pulses = new Map();   // lane id -> [{ s (0..1 along the lane), v (speed) }]
  let clock = 0;
  HW.drawFx = (ctx, { lanes, straits, straitRatio, laneBlocked, dt, zoom, quiet }) => {
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
        ctx.globalAlpha = 0.55 * (1 - ph) * (1 - ph) * sev;
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(s.sx, s.sy, base + reach * ph, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  };
})();
