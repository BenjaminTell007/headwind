/* The sky behind the globe: stars, the odd shooting star, and the Sun, Moon and Mars.

   Everything is a direction from the Earth's centre in the same Earth-fixed frame the
   globe uses, so when you turn the globe the sky turns with it and the Earth passes in
   front of whatever is behind it. The Sun, Moon and Mars are placed where they really
   are right now, from the standard low-precision almanac formulas (good to a degree or
   so, plenty for a picture). Only the half of the sky behind the globe is drawn.

   globe.js calls HW.drawSky(ctx, {...}) first thing each frame. Dark theme only. */

(() => {
  const HW = window.HW, RAD = Math.PI / 180;
  const vec = (lat, lon) => { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]; };
  const wrap = deg => ((deg + 540) % 360) - 180;

  /* ---------- where things are, right now ---------- */
  // days since 2000-01-01 12:00 UTC, and Greenwich sidereal time
  const days = date => (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const gmstDeg = d => (280.46061837 + 360.98564736629 * d) % 360;
  const obliq = d => (23.439 - 0.0000004 * d) * RAD;

  // ecliptic longitude/latitude (radians) -> direction in the Earth-fixed frame
  const fromEcliptic = (lam, beta, d) => {
    const e = obliq(d);
    const x = Math.cos(beta) * Math.cos(lam);
    const y = Math.cos(e) * Math.cos(beta) * Math.sin(lam) - Math.sin(e) * Math.sin(beta);
    const z = Math.sin(e) * Math.cos(beta) * Math.sin(lam) + Math.cos(e) * Math.sin(beta);
    const ra = Math.atan2(y, x), dec = Math.asin(z);
    return vec(dec / RAD, wrap(ra / RAD - gmstDeg(d)));   // the point on Earth it's overhead
  };

  const sunLon = d => {
    const g = (357.529 + 0.98560028 * d) * RAD, q = 280.459 + 0.98564736 * d;
    return (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  };
  const sunDir = d => fromEcliptic(sunLon(d), 0, d);

  const moonDir = d => {
    const L = 218.316 + 13.176396 * d, M = (134.963 + 13.064993 * d) * RAD, F = (93.272 + 13.229350 * d) * RAD;
    return fromEcliptic((L + 6.289 * Math.sin(M)) * RAD, 5.128 * Math.sin(F) * RAD, d);
  };

  // Mars: circular orbits are enough here (a few degrees off at worst)
  const marsDir = d => {
    const le = sunLon(d) + Math.PI;                      // Earth's heliocentric longitude
    const lm = (355.433 + 0.5240207766 * d) * RAD;       // Mars' mean longitude
    const x = 1.524 * Math.cos(lm) - Math.cos(le), y = 1.524 * Math.sin(lm) - Math.sin(le);
    return fromEcliptic(Math.atan2(y, x), 0, d);
  };

  /* ---------- the stars ---------- */
  const rnd = HW.rng(42);
  const N = 1100;
  const SX = new Float32Array(N), SY = new Float32Array(N), SZ = new Float32Array(N), SM = new Float32Array(N), SP = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const y = 1 - 2 * rnd(), r = Math.sqrt(1 - y * y), a = rnd() * 6.2832;
    SX[i] = r * Math.cos(a); SY[i] = y; SZ[i] = r * Math.sin(a);
    SM[i] = Math.pow(rnd(), 3.2);       // most stars faint, a few bright
    SP[i] = rnd() * 6.2832;             // twinkle phase
  }

  const shooting = [];
  let nextShot = 4, t = 0, bodies = null, bodiesAt = 0;

  HW.drawSky = (ctx, { W, H, cx, cy, view, dt, light }) => {
    if (light) return;
    t += dt;
    const Rs = Math.hypot(W, H) * 0.36;   // how far out the sky's rim sits on screen

    // a direction behind the globe -> screen; null if it's in front of us
    const place = v => {
      const p = view(v);
      if (p[2] > 0.02) return null;
      return { x: cx + p[0] * Rs, y: cy - p[1] * Rs, fade: Math.min(1, -p[2] * 6 + 0.12) };
    };

    /* stars */
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < N; i++) {
      const p = view([SX[i], SY[i], SZ[i]]);
      if (p[2] > 0) continue;
      const x = cx + p[0] * Rs, y = cy - p[1] * Rs;
      if (x < -2 || x > W + 2 || y < -2 || y > H + 2) continue;
      const tw = 0.75 + 0.25 * Math.sin(t * (1.3 + SM[i] * 2) + SP[i]);
      ctx.globalAlpha = (0.28 + 0.72 * SM[i]) * tw * Math.min(1, -p[2] * 4 + 0.25);
      const s = SM[i] > 0.6 ? 2 : SM[i] > 0.25 ? 1.5 : 1.1;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }

    /* the Sun, Moon and Mars (positions recomputed once a minute) */
    if (!bodies || performance.now() - bodiesAt > 60000) {
      const d = days(new Date());
      bodies = { sun: sunDir(d), moon: moonDir(d), mars: marsDir(d) };
      bodiesAt = performance.now();
    }
    const sun = place(bodies.sun), moon = place(bodies.moon), mars = place(bodies.mars);

    if (sun) {
      const g = ctx.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, 120);
      g.addColorStop(0, 'rgba(255,246,224,0.55)');
      g.addColorStop(0.12, 'rgba(255,236,200,0.22)');
      g.addColorStop(1, 'rgba(255,236,200,0)');
      ctx.globalAlpha = sun.fade;
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sun.x, sun.y, 120, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#fff8ea'; ctx.beginPath(); ctx.arc(sun.x, sun.y, 9, 0, 6.2832); ctx.fill();
      label(ctx, 'SUN', sun.x + 16, sun.y + 4, sun.fade);
    }

    if (moon) {
      const r = 13;
      ctx.globalAlpha = moon.fade;
      // dark disc, then the lit part: a second disc shifted toward the Sun, clipped to the Moon
      ctx.fillStyle = '#2a2b2e'; ctx.beginPath(); ctx.arc(moon.x, moon.y, r, 0, 6.2832); ctx.fill();
      const sv = view(bodies.sun), mv = view(bodies.moon);
      const phase = Math.acos(HW.clamp(sv[0] * mv[0] + sv[1] * mv[1] + sv[2] * mv[2], -1, 1));   // 0 = new moon, pi = full
      let dx = sv[0] - mv[0], dy = -(sv[1] - mv[1]); const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      const shift = r * 2 * (1 - phase / Math.PI);
      ctx.save();
      ctx.beginPath(); ctx.arc(moon.x, moon.y, r, 0, 6.2832); ctx.clip();
      ctx.fillStyle = '#d9d8d2'; ctx.beginPath(); ctx.arc(moon.x + dx * shift, moon.y + dy * shift, r, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = moon.fade * 0.18; ctx.fillStyle = '#000';
      [[-4, -3, 3.2], [3, 4, 2.4], [5, -5, 1.6], [-2, 6, 1.8]].forEach(([ox, oy, cr]) => { ctx.beginPath(); ctx.arc(moon.x + ox, moon.y + oy, cr, 0, 6.2832); ctx.fill(); });
      ctx.restore();
      label(ctx, 'MOON', moon.x + r + 7, moon.y + 4, moon.fade);
    }

    if (mars) {
      ctx.globalAlpha = mars.fade * 0.35;
      ctx.fillStyle = '#c1502a'; ctx.beginPath(); ctx.arc(mars.x, mars.y, 7, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = mars.fade;
      ctx.beginPath(); ctx.arc(mars.x, mars.y, 3.2, 0, 6.2832); ctx.fill();
      label(ctx, 'MARS', mars.x + 10, mars.y + 4, mars.fade);
    }

    /* shooting stars: one every several seconds, a quick streak that fades */
    nextShot -= dt;
    if (nextShot <= 0) {
      nextShot = 5 + Math.random() * 9;
      const ang = (Math.random() < 0.5 ? 1 : -1) * (0.35 + Math.random() * 0.5) + Math.PI / 2;
      shooting.push({ x: Math.random() * W, y: Math.random() * H * 0.45, vx: Math.cos(ang) * 900 * (Math.random() < 0.5 ? 1 : -1), vy: Math.abs(Math.sin(ang)) * 420, life: 0, max: 0.7 + Math.random() * 0.5 });
    }
    for (let k = shooting.length - 1; k >= 0; k--) {
      const s = shooting[k];
      s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.life > s.max) { shooting.splice(k, 1); continue; }
      const a = Math.sin(Math.PI * s.life / s.max);
      const tail = 0.12;
      const g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * tail, s.y - s.vy * tail);
      g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = a; ctx.strokeStyle = g; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * tail, s.y - s.vy * tail); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  const label = (ctx, text, x, y, a) => {
    ctx.globalAlpha = 0.55 * a;
    ctx.font = `300 10px ${HW.MONO}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#bdbdbb';
    ctx.fillText(text, x, y);
  };
})();
