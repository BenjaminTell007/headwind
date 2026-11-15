/* The ship scene. A drone-style top-down view of the clicked ship on a procedurally
   rendered sea, with a side profile view as the second camera. Everything about the
   environment comes from the live weather at the ship's position:
     sea temperature   water colour (cold slate to warm turquoise)
     waves and swell   wave amplitude, whitecaps, how much the ship pitches and rolls
     wind              direction the foam and spray drift, streaks on the water
     cloud cover       cloud shadows sliding across the sea, a greyer light
     weather code      rain, fog, snow, lightning
     day or night      the whole palette
   The ship itself is drawn to match its AIS type and length: tanker, container,
   bulk, passenger/ro-ro or general. */

(() => {
  const HW = window.HW, RAD = Math.PI / 180;

  /* weather -> environment parameters */
  const envFrom = (w, ship) => {
    w = w || {};
    const code = +w.weather_code || 0;
    const sst = w.sea_surface_temperature != null ? +w.sea_surface_temperature : (w.temperature_2m != null ? +w.temperature_2m : 18);
    const wave = w.wave_height != null ? +w.wave_height : HW.clamp((+w.wind_speed_10m || 8) / 14, 0.2, 3);
    return {
      code, sst, wave,
      period: +w.wave_period || 6,
      waveDir: (w.wave_direction != null ? +w.wave_direction : (+w.wind_direction_10m || 0)) * RAD,
      swell: +w.swell_wave_height || wave * 0.6,
      wind: +w.wind_speed_10m || 8,
      windDir: (+w.wind_direction_10m || 0) * RAD,
      gust: +w.wind_gusts_10m || 0,
      cloud: w.cloud_cover != null ? +w.cloud_cover / 100 : (code >= 3 ? 0.8 : code >= 1 ? 0.35 : 0.1),
      rain: (code >= 51 && code <= 67) || (code >= 80 && code <= 82) ? (code >= 63 || code === 82 ? 1 : 0.55) : code >= 95 ? 1 : 0,
      snow: (code >= 71 && code <= 77) || code === 85 || code === 86 ? 1 : 0,
      fog: code === 45 || code === 48 ? 1 : (w.visibility != null && +w.visibility < 3000 ? 0.7 : 0),
      storm: code >= 95 ? 1 : 0,
      night: w.is_day === 0 ? 1 : 0,
      airT: w.temperature_2m,
      speed: ship && ship.sog ? +ship.sog : 12,
    };
  };

  /* water colour: cold deep slate -> temperate teal -> warm turquoise; night and cloud darken */
  const waterRGB = env => {
    const t = HW.clamp((env.sst - 4) / 26, 0, 1);
    const cold = [28, 52, 66], mid = [24, 86, 102], warm = [22, 128, 138];
    const c = t < 0.5 ? cold.map((v, i) => HW.lerp(v, mid[i], t * 2)) : mid.map((v, i) => HW.lerp(v, warm[i], (t - 0.5) * 2));
    const dim = (1 - 0.32 * env.cloud) * (env.night ? 0.32 : 1) * (env.storm ? 0.75 : 1);
    const grey = 0.35 * env.cloud + 0.3 * env.fog;
    const g = (c[0] + c[1] + c[2]) / 3;
    return c.map(v => HW.lerp(v, g, grey) * dim);
  };

  /* ---------- ship drawings, top-down, bow pointing up, centred on (0,0), length L ---------- */
  const hullPath = (ctx, L, B, bowSharp) => {
    const h = L / 2, b = B / 2;
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.bezierCurveTo(b * 0.55, -h + L * 0.02, b, -h + L * bowSharp * 0.55, b, -h + L * bowSharp);
    ctx.lineTo(b, h - L * 0.06);
    ctx.quadraticCurveTo(b, h, b * 0.55, h);
    ctx.lineTo(-b * 0.55, h);
    ctx.quadraticCurveTo(-b, h, -b, h - L * 0.06);
    ctx.lineTo(-b, -h + L * bowSharp);
    ctx.bezierCurveTo(-b, -h + L * bowSharp * 0.55, -b * 0.55, -h + L * 0.02, 0, -h);
    ctx.closePath();
  };
  const superstructure = (ctx, L, B, y, len, white = '#e9e7e2') => {
    const w = B * 0.86;
    ctx.fillStyle = white; ctx.fillRect(-w / 2, y, w, len);
    ctx.fillStyle = '#c9c6bf'; ctx.fillRect(-w / 2, y + len * 0.72, w, len * 0.28);
    ctx.fillStyle = '#2b3138'; for (let i = 0; i < 6; i++) ctx.fillRect(-w / 2 + w * (0.08 + i * 0.15), y + len * 0.12, w * 0.09, len * 0.08);
    ctx.fillStyle = '#d23b2b'; ctx.fillRect(-B * 0.12, y + len * 0.55, B * 0.24, len * 0.22);   // funnel band
    ctx.fillStyle = '#1b1b1b'; ctx.fillRect(-B * 0.08, y + len * 0.6, B * 0.16, len * 0.1);
  };
  const drawTanker = (ctx, L, B) => {
    ctx.fillStyle = '#5d1e1a'; hullPath(ctx, L, B, 0.12); ctx.fill();
    ctx.save(); hullPath(ctx, L * 0.97, B * 0.9, 0.12); ctx.clip();
    ctx.fillStyle = '#8f2e25'; ctx.fillRect(-B, -L / 2, B * 2, L);
    ctx.strokeStyle = 'rgba(30,10,8,0.45)'; ctx.lineWidth = Math.max(0.6, B * 0.02);
    for (let y = -L / 2 + L * 0.12; y < L * 0.3; y += L * 0.045) { ctx.beginPath(); ctx.moveTo(-B * 0.45, y); ctx.lineTo(B * 0.45, y); ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle = '#d9d4c8'; ctx.lineWidth = Math.max(1, B * 0.05);   // pipe rack down the centreline
    ctx.beginPath(); ctx.moveTo(0, -L * 0.42); ctx.lineTo(0, L * 0.28); ctx.stroke();
    ctx.lineWidth = Math.max(0.6, B * 0.02);
    for (let i = 0; i < 3; i++) { const y = -L * 0.05 + i * L * 0.03; ctx.beginPath(); ctx.moveTo(-B * 0.42, y); ctx.lineTo(B * 0.42, y); ctx.stroke(); }   // manifold
    ctx.fillStyle = '#efc23c'; ctx.beginPath(); ctx.arc(0, -L * 0.36, B * 0.13, 0, 6.2832); ctx.fill();   // forecastle mark
    superstructure(ctx, L, B, L * 0.3, L * 0.13);
  };
  const CONT = ['#9b3a2e', '#2f5d8a', '#c9c6bf', '#6f7d55', '#b7772e', '#3c3f47', '#8a8f96', '#a1463b', '#24476b'];
  const drawContainer = (ctx, L, B, seed) => {
    const rnd = HW.rng(seed || 11);
    ctx.fillStyle = '#1f2630'; hullPath(ctx, L, B, 0.16); ctx.fill();
    ctx.save(); hullPath(ctx, L * 0.97, B * 0.92, 0.16); ctx.clip();
    ctx.fillStyle = '#2a323d'; ctx.fillRect(-B, -L / 2, B * 2, L);
    const rows = 10, bayL = L * 0.058, top = -L * 0.36;
    for (let bay = 0; bay < 12; bay++) {
      const y = top + bay * (bayL + L * 0.006); if (y + bayL > L * 0.34 && y < L * 0.22) continue;
      if (bay === 3) continue;   // gap where the bridge sits on big ships
      for (let r = 0; r < rows; r++) {
        if (rnd() < 0.07) continue;
        ctx.fillStyle = CONT[(rnd() * CONT.length) | 0];
        const w = (B * 0.88) / rows; ctx.fillRect(-B * 0.44 + r * w + w * 0.06, y, w * 0.88, bayL);
      }
    }
    ctx.restore();
    superstructure(ctx, L, B, -L * 0.36 + 3 * (L * 0.064), L * 0.05);
    ctx.fillStyle = '#e9e7e2'; ctx.fillRect(-B * 0.4, L * 0.36, B * 0.8, L * 0.07);
  };
  const drawBulk = (ctx, L, B) => {
    ctx.fillStyle = '#26262a'; hullPath(ctx, L, B, 0.1); ctx.fill();
    ctx.save(); hullPath(ctx, L * 0.97, B * 0.9, 0.1); ctx.clip(); ctx.fillStyle = '#7a2c22'; ctx.fillRect(-B, -L / 2, B * 2, L); ctx.restore();
    for (let i = 0; i < 7; i++) {
      const y = -L * 0.36 + i * L * 0.088;
      ctx.fillStyle = '#9c8f74'; ctx.fillRect(-B * 0.34, y, B * 0.68, L * 0.068);
      ctx.strokeStyle = 'rgba(40,34,26,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(-B * 0.34, y, B * 0.68, L * 0.068);
      if (i % 2 === 1) { ctx.fillStyle = '#d6b23a'; ctx.fillRect(B * 0.36, y - L * 0.01, B * 0.08, L * 0.02); }   // crane posts
    }
    superstructure(ctx, L, B, L * 0.3, L * 0.13);
  };
  const drawPassenger = (ctx, L, B) => {
    ctx.fillStyle = '#e9edf0'; hullPath(ctx, L, B * 1.05, 0.2); ctx.fill();
    ctx.fillStyle = '#d5dade'; ctx.fillRect(-B * 0.42, -L * 0.3, B * 0.84, L * 0.72);
    ctx.fillStyle = '#1e5a8c'; for (let i = 0; i < 9; i++) ctx.fillRect(-B * 0.38, -L * 0.26 + i * L * 0.075, B * 0.76, L * 0.012);
    ctx.fillStyle = '#4aa6c8'; ctx.fillRect(-B * 0.18, L * 0.02, B * 0.36, L * 0.09);   // pool
    ctx.fillStyle = '#c23a2b'; ctx.fillRect(-B * 0.12, L * 0.2, B * 0.24, L * 0.08);
  };
  const drawGeneral = (ctx, L, B) => {
    ctx.fillStyle = '#2d3a3f'; hullPath(ctx, L, B, 0.14); ctx.fill();
    ctx.save(); hullPath(ctx, L * 0.96, B * 0.88, 0.14); ctx.clip(); ctx.fillStyle = '#4c6a63'; ctx.fillRect(-B, -L / 2, B * 2, L); ctx.restore();
    for (let i = 0; i < 4; i++) { ctx.fillStyle = '#6f6656'; ctx.fillRect(-B * 0.32, -L * 0.33 + i * L * 0.14, B * 0.64, L * 0.1); }
    superstructure(ctx, L, B, L * 0.26, L * 0.14);
  };
  const drawTop = (ctx, kind, L, B, seed) => {
    if (kind === 'tanker') drawTanker(ctx, L, B);
    else if (kind === 'cargo') drawContainer(ctx, L, B, seed);
    else if (kind === 'bulk') drawBulk(ctx, L, B);
    else if (kind === 'passenger') drawPassenger(ctx, L, B);
    else drawGeneral(ctx, L, B);
  };

  /* side profile, waterline at y=0, bow to the right, length L */
  const drawSide = (ctx, kind, L, seed, draughtFrac) => {
    const H = L * 0.085, fb = H * (0.55 - 0.25 * draughtFrac);   // freeboard: deeper loaded ships sit lower
    const hull = kind === 'tanker' ? '#6a2219' : kind === 'cargo' ? '#1f2630' : kind === 'passenger' ? '#eef1f3' : kind === 'bulk' ? '#26262a' : '#2d3a3f';
    ctx.fillStyle = '#7b2a22'; ctx.fillRect(-L / 2 + L * 0.03, -2, L * 0.94, H * 0.18);   // antifouling just at the waterline
    ctx.fillStyle = hull;
    ctx.beginPath(); ctx.moveTo(-L / 2, -fb); ctx.lineTo(L / 2 - L * 0.05, -fb - H * 0.08); ctx.quadraticCurveTo(L / 2 + L * 0.02, -fb, L / 2 - L * 0.01, 0); ctx.lineTo(-L / 2 + L * 0.02, 0); ctx.closePath(); ctx.fill();
    const deck = -fb - H * 0.04;
    if (kind === 'cargo') {
      const rnd = HW.rng(seed || 3);
      for (let bay = 0; bay < 16; bay++) {
        const x = -L * 0.36 + bay * L * 0.048; if (bay === 4) continue;
        const tiers = 3 + ((rnd() * 4) | 0);
        for (let t = 0; t < tiers; t++) { ctx.fillStyle = CONT[(rnd() * CONT.length) | 0]; ctx.fillRect(x, deck - (t + 1) * H * 0.22, L * 0.044, H * 0.2); }
      }
      bridge(ctx, -L * 0.36 + 4 * L * 0.048, deck, L * 0.04, H * 1.9);
      bridge(ctx, -L * 0.45, deck, L * 0.07, H * 0.9);
    } else if (kind === 'passenger') {
      ctx.fillStyle = '#f4f6f7'; ctx.fillRect(-L * 0.42, deck - H * 1.6, L * 0.78, H * 1.6);
      ctx.fillStyle = '#1e5a8c'; for (let i = 0; i < 5; i++) ctx.fillRect(-L * 0.4, deck - H * (0.3 + i * 0.3), L * 0.74, H * 0.07);
      ctx.fillStyle = '#c23a2b'; ctx.fillRect(-L * 0.25, deck - H * 2.1, L * 0.06, H * 0.5);
    } else {
      if (kind === 'tanker') { ctx.strokeStyle = '#d9d4c8'; ctx.lineWidth = Math.max(1, H * 0.06); ctx.beginPath(); ctx.moveTo(-L * 0.3, deck - H * 0.12); ctx.lineTo(L * 0.42, deck - H * 0.12); ctx.stroke(); }
      if (kind === 'bulk') { for (let i = 0; i < 7; i++) { ctx.fillStyle = '#9c8f74'; ctx.fillRect(-L * 0.3 + i * L * 0.1, deck - H * 0.18, L * 0.08, H * 0.18); } ctx.strokeStyle = '#d6b23a'; ctx.lineWidth = Math.max(1, H * 0.05); for (let i = 0; i < 4; i++) { const x = -L * 0.25 + i * L * 0.18; ctx.beginPath(); ctx.moveTo(x, deck); ctx.lineTo(x, deck - H * 0.9); ctx.lineTo(x + L * 0.07, deck - H * 0.5); ctx.stroke(); } }
      bridge(ctx, -L * 0.44, deck, L * 0.11, H * 1.5);
    }
  };
  const bridge = (ctx, x, deck, w, h) => {
    ctx.fillStyle = '#e9e7e2'; ctx.fillRect(x, deck - h, w, h);
    ctx.fillStyle = '#2b3138'; ctx.fillRect(x + w * 0.05, deck - h * 0.92, w * 0.9, h * 0.08);
    for (let i = 1; i < 4; i++) ctx.fillRect(x + w * 0.1, deck - h * (0.92 - i * 0.2), w * 0.8, h * 0.04);
    ctx.fillStyle = '#d23b2b'; ctx.fillRect(x + w * 0.25, deck - h * 1.25, w * 0.3, h * 0.3);
    ctx.fillStyle = '#1b1b1b'; ctx.fillRect(x + w * 0.25, deck - h * 1.3, w * 0.3, h * 0.07);
  };

  /* ---------- the scene ---------- */
  HW.makeShipScene = (canvas) => {
    const lowW = 220;
    const low = document.createElement('canvas'), lctx = low.getContext('2d');
    let img = null;
    const S = { on: false, mode: 'top', modeT: 0, intro: 0, ship: null, env: envFrom(null), kind: 'cargo', L: 300, seed: 1, foam: [], spray: [], rain: [], clouds: [], flash: 0, travel: 0 };

    const resetParticles = () => {
      const rnd = HW.rng(S.seed);
      S.clouds = Array.from({ length: 5 }, () => ({ x: rnd(), y: rnd(), r: 0.25 + rnd() * 0.35 }));
      S.rain = Array.from({ length: 260 }, () => ({ x: rnd(), y: rnd(), z: 0.4 + rnd() * 0.6 }));
      S.foam = []; S.spray = [];
    };

    const obj = {
      resize(st) {
        const lowH = Math.max(40, Math.round(lowW * st.H / Math.max(1, st.W)));
        low.width = lowW; low.height = lowH; img = lctx.createImageData(lowW, lowH);
      },
      frame(st, dt) {
        if (!S.on) return;
        const { ctx, W, H } = st, env = S.env, t = st.t;
        S.intro = Math.min(1, S.intro + dt / 3.2);
        S.modeT += ((S.mode === 'side' ? 1 : 0) - S.modeT) * (1 - Math.exp(-2.6 * dt));
        S.travel += dt * (0.6 + env.speed / 14);

        if (S.modeT < 0.995) drawTopView(st, dt, 1 - S.modeT);
        if (S.modeT > 0.005) { ctx.globalAlpha = S.modeT; drawSideView(st, dt); ctx.globalAlpha = 1; }

        /* weather over everything */
        if (env.fog > 0) { ctx.globalAlpha = 0.32 * env.fog; ctx.fillStyle = env.night ? '#3a4044' : '#cfd6da'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
        if (env.rain > 0 || env.snow > 0) {
          const wx = Math.sin(env.windDir + Math.PI) * env.wind * 0.02, n = Math.round(S.rain.length * Math.max(env.rain, env.snow));
          ctx.strokeStyle = ctx.fillStyle = env.snow ? 'rgba(240,244,246,0.8)' : 'rgba(210,222,230,0.35)'; ctx.lineWidth = 1;
          for (let i = 0; i < n; i++) {
            const p = S.rain[i]; p.y += dt * (env.snow ? 0.12 : 1.4) * p.z; p.x += dt * wx * (env.snow ? 2 : 1); if (p.y > 1) { p.y -= 1; p.x = Math.random(); } if (p.x > 1) p.x -= 1; if (p.x < 0) p.x += 1;
            const x = p.x * W, y = p.y * H;
            if (env.snow) { ctx.globalAlpha = 0.7 * p.z; ctx.beginPath(); ctx.arc(x, y, 1.4 * p.z, 0, 6.2832); ctx.fill(); }
            else { ctx.globalAlpha = 0.6 * p.z; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - wx * 30, y - 16 * p.z); ctx.stroke(); }
          }
          ctx.globalAlpha = 1;
        }
        if (env.storm) {
          if (S.flash <= 0 && Math.random() < dt * 0.15) S.flash = 1;
          if (S.flash > 0) { ctx.globalAlpha = 0.5 * S.flash * (Math.random() < 0.5 ? 1 : 0.4); ctx.fillStyle = '#f2f4ff'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; S.flash -= dt * 3; }
        }
        // vignette and the intro: start bright and high (as if dropping out of the globe view), then settle
        const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
        ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
        if (S.intro < 1) { ctx.globalAlpha = 1 - HW.smooth(S.intro * 1.6); ctx.fillStyle = HW.C.bg; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
      },
    };

    /* top-down: low-res wave field, then glints, cloud shadows, wake, ship */
    const drawTopView = (st, dt, alpha) => {
      const { ctx, W, H, t } = st, env = S.env;
      const descend = HW.ease(S.intro);
      const alt = HW.lerp(5.5, 1, descend);   // camera altitude: higher = smaller ship, broader sea
      const base = waterRGB(env), amp = HW.clamp(env.wave / 2.5, 0.12, 1.4);
      const lw = low.width, lh = low.height, d = img.data;
      const k1 = 0.09 / alt * (6 / env.period), k2 = k1 * 1.9, k3 = k1 * 3.7;
      const a1 = env.waveDir, a2 = env.windDir + 0.6, a3 = env.waveDir - 0.9;
      const c1 = Math.cos(a1), s1 = Math.sin(a1), c2 = Math.cos(a2), s2 = Math.sin(a2), c3 = Math.cos(a3), s3 = Math.sin(a3);
      const om = 1.3 * Math.sqrt(6 / env.period), ty = S.travel * 3.2 / alt;
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          const X = x - lw / 2, Y = y - lh / 2 + ty * 10;
          let h = Math.sin((X * c1 + Y * s1) * k1 - t * om) * 0.55
                + Math.sin((X * c2 + Y * s2) * k2 - t * om * 1.4) * 0.3
                + Math.sin((X * c3 + Y * s3) * k3 - t * om * 1.9) * 0.18
                + Math.sin((X * 0.7 + Y * 1.3) * k1 * 0.37 + t * 0.2) * 0.4;
          h *= amp;
          const spec = h > 0.55 ? (h - 0.55) * 90 : 0;
          const o = (y * lw + x) * 4;
          d[o] = base[0] + h * 18 + spec; d[o + 1] = base[1] + h * 22 + spec; d[o + 2] = base[2] + h * 24 + spec; d[o + 3] = 255;
        }
      }
      lctx.putImageData(img, 0, 0);
      ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = true; ctx.drawImage(low, 0, 0, W, H);

      // whitecaps scattered over the sea, more with wind and waves, drifting downwind
      const caps = Math.round(HW.clamp((env.wind - 8) * 6 + env.wave * 20, 6, 220));
      const rnd = HW.rng(S.seed + 99), wdx = Math.sin(env.windDir + Math.PI), wdy = -Math.cos(env.windDir + Math.PI);
      ctx.fillStyle = '#f4f7f8';
      for (let i = 0; i < caps; i++) {
        const life = (t * 0.35 + rnd()) % 1, fade = Math.sin(life * Math.PI);
        const x = ((rnd() * W + wdx * life * 40) % W + W) % W, y = ((rnd() * H + S.travel * 32 / alt + wdy * life * 40) % H + H) % H;
        ctx.globalAlpha = alpha * fade * 0.5; ctx.beginPath(); ctx.ellipse(x, y, 2.4 / alt + 1, 0.9, env.windDir, 0, 6.2832); ctx.fill();
      }

      // the ship: size from AIS length, heading up the screen, slight yaw with the swell
      const L = HW.clamp(S.L, 60, 420) / 400 * Math.min(W, H) * 0.95 / alt, B = L * (S.kind === 'tanker' || S.kind === 'bulk' ? 0.16 : S.kind === 'passenger' ? 0.13 : 0.14);
      const cx = W / 2 + Math.sin(t * 0.13) * W * 0.02, cy = H * 0.52 + Math.cos(t * 0.11) * H * 0.015;
      const yaw = Math.sin(t * 0.5) * 0.015 * amp + Math.sin(t * 0.07) * 0.03;

      // wake: Kelvin V of foam from the bow and stern, plus turbulent propwash behind
      const sternX = cx - Math.sin(yaw) * L / 2, sternY = cy + Math.cos(yaw) * L / 2;
      const bowX = cx + Math.sin(yaw) * L / 2, bowY = cy - Math.cos(yaw) * L / 2;
      const emit = Math.round(dt * (60 + env.speed * 8));
      for (let i = 0; i < emit; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        S.foam.push({ x: sternX + (Math.random() - 0.5) * B * 0.6, y: sternY, vx: side * (0.12 + Math.random() * 0.25), vy: 1, life: 1, r: B * (0.06 + Math.random() * 0.1), kind: 0 });
        if (Math.random() < 0.5) S.foam.push({ x: bowX + side * B * 0.3, y: bowY + L * 0.04, vx: side * 0.36, vy: 1, life: 1, r: B * 0.05, kind: 1 });
      }
      const flow = (env.speed / 12) * L * 0.55;
      for (const f of S.foam) { f.x += f.vx * flow * dt * 0.6 + wdx * env.wind * dt * 0.3; f.y += f.vy * flow * dt; f.life -= dt * (f.kind ? 0.55 : 0.32); f.r += dt * B * 0.06; }
      S.foam = S.foam.filter(f => f.life > 0 && f.y < H + 40);
      for (const f of S.foam) { ctx.globalAlpha = alpha * f.life * (f.kind ? 0.55 : 0.7); ctx.fillStyle = '#f2f6f7'; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.2832); ctx.fill(); }

      // soft shadow on the water, then the ship
      ctx.save(); ctx.translate(cx + L * 0.03, cy + L * 0.03); ctx.rotate(yaw); ctx.globalAlpha = alpha * 0.25; ctx.fillStyle = '#000'; hullPath(ctx, L, B * 1.05, 0.14); ctx.fill(); ctx.restore();
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(yaw); ctx.globalAlpha = alpha; drawTop(ctx, S.kind, L, B, S.seed); ctx.restore();

      // cloud shadows sliding downwind
      if (env.cloud > 0.25) {
        for (const c of S.clouds) {
          c.x += wdx * dt * 0.006 * (1 + env.wind / 10); c.y += (wdy * dt * 0.006 + dt * 0.004) * (1 + env.wind / 10);
          if (c.x > 1.4) c.x -= 1.8; if (c.x < -0.4) c.x += 1.8; if (c.y > 1.4) c.y -= 1.8; if (c.y < -0.4) c.y += 1.8;
          const g = ctx.createRadialGradient(c.x * W, c.y * H, 0, c.x * W, c.y * H, c.r * Math.max(W, H));
          g.addColorStop(0, `rgba(0,0,0,${0.22 * env.cloud})`); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = alpha; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }
      }
      ctx.globalAlpha = 1;
    };

    /* side view: sky, horizon, layered swell, the ship pitching and rolling on it */
    const drawSideView = (st, dt) => {
      const { ctx, W, H, t } = st, env = S.env, a = ctx.globalAlpha;
      const hz = H * 0.5;
      const sky = ctx.createLinearGradient(0, 0, 0, hz);
      if (env.night) { sky.addColorStop(0, '#05070c'); sky.addColorStop(1, '#1a2230'); }
      else { const gr = env.cloud * 0.7 + env.fog * 0.3; sky.addColorStop(0, `rgb(${HW.lerp(70, 120, gr)},${HW.lerp(120, 126, gr)},${HW.lerp(170, 130, gr)})`); sky.addColorStop(1, `rgb(${HW.lerp(200, 170, gr)},${HW.lerp(214, 174, gr)},${HW.lerp(224, 176, gr)})`); }
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, hz + 2);
      if (env.night) { const r = HW.rng(5); ctx.fillStyle = '#fff'; for (let i = 0; i < 120; i++) { ctx.globalAlpha = a * r() * 0.8; ctx.fillRect(r() * W, r() * hz * 0.9, 1, 1); } ctx.globalAlpha = a; }
      // clouds as soft bands
      if (env.cloud > 0.15) { for (let i = 0; i < 6; i++) { const y = hz * (0.15 + i * 0.12), x = ((t * (4 + env.wind * 0.6) + i * 230) % (W + 600)) - 300; const g = ctx.createRadialGradient(x, y, 0, x, y, 260); g.addColorStop(0, `rgba(${env.night ? 60 : 235},${env.night ? 64 : 238},${env.night ? 70 : 240},${0.35 * env.cloud})`); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(x - 300, y - 120, 600, 240); } }

      const base = waterRGB(env), amp = HW.clamp(env.wave, 0.2, 6) * H * 0.012, swell = HW.clamp(env.swell, 0.1, 6) * H * 0.01;
      const surf = x => Math.sin(x * 0.012 - t * 1.1) * amp + Math.sin(x * 0.031 + t * 1.7) * amp * 0.35 + Math.sin(x * 0.004 - t * 0.5) * swell;
      // sea: back layers to front
      for (let layer = 0; layer < 3; layer++) {
        const y0 = hz + layer * H * 0.05, k = 1 - layer * 0.18;
        ctx.fillStyle = `rgb(${base[0] * k + 10 * layer},${base[1] * k + 8 * layer},${base[2] * k + 6 * layer})`;
        ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 8) ctx.lineTo(x, y0 + surf(x + layer * 300) * (0.4 + layer * 0.3));
        ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      }
      // ship riding the front surface
      const L = Math.min(W * 0.62, 900) * HW.clamp(S.L / 300, 0.45, 1.2), shipX = W * 0.5, wl = hz + H * 0.1;
      const yA = surf(shipX - L * 0.4), yB = surf(shipX + L * 0.4), pitch = Math.atan2(yB - yA, L * 0.8) * 0.7, heave = (yA + yB) / 2 * 0.7;
      const draughtFrac = S.ship && S.ship.draught && S.ship.length ? HW.clamp(+S.ship.draught / (+S.ship.length * 0.055), 0, 1) : 0.6;
      ctx.save(); ctx.translate(shipX, wl + heave); ctx.rotate(pitch); drawSide(ctx, S.kind, L, S.seed, draughtFrac); ctx.restore();
      // bow spray and the front water layer over the hull bottom
      const bow = shipX + L * 0.46, spr = HW.clamp(env.wave, 0.3, 4);
      for (let i = 0; i < 8 * spr; i++) { const r = HW.rng((t * 10 | 0) + i)(); ctx.globalAlpha = a * 0.5 * r; ctx.fillStyle = '#f2f6f7'; ctx.beginPath(); ctx.arc(bow + r * 30, wl + heave - r * spr * 18, 2 + r * 4, 0, 6.2832); ctx.fill(); }
      ctx.globalAlpha = a;
      ctx.fillStyle = `rgba(${base[0] * 0.8},${base[1] * 0.8},${base[2] * 0.8},0.92)`;
      ctx.beginPath(); ctx.moveTo(0, H); for (let x = 0; x <= W; x += 8) ctx.lineTo(x, wl + 6 + surf(x + 900) * 0.6); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      // foam line
      ctx.strokeStyle = 'rgba(240,246,247,0.35)'; ctx.lineWidth = 1.2; ctx.beginPath(); for (let x = 0; x <= W; x += 8) ctx.lineTo(x, wl + 6 + surf(x + 900) * 0.6); ctx.stroke();
    };

    const api = {
      S,
      open(ship, weather) {
        S.ship = ship; S.on = true; S.intro = 0; S.mode = 'top'; S.modeT = 0;
        const g = ship.type_group || HW.vesselGroup(ship.type);
        // AIS "cargo" covers container ships and bulk carriers; long, deep cargo ships with no container-style name lean bulk
        S.kind = g === 'cargo' && /BULK|ORE|COAL|GRAIN|CAPE/i.test(ship.name || '') ? 'bulk' : g;
        S.L = +ship.length || (g === 'tanker' ? 240 : 280);
        S.seed = (+ship.mmsi % 997) + 3;
        S.env = envFrom(weather, ship);
        resetParticles();
        api.stage.pause(false);
      },
      setWeather(w) { S.env = envFrom(w, S.ship); },
      setMode(m) { S.mode = m; },
      close() { S.on = false; api.stage.pause(true); },
      envFrom,
    };
    api.stage = HW.stage(canvas, obj);
    api.stage.pause(true);
    return api;
  };
})();
