/* The globe. Filled countries, every corridor between world regions drawn as a blue lane whose
   brightness is its efficiency this week (static, no animation), a ring at every
   strait whose gap is its traffic vs 2023, and the live cargo ships and tankers from the
   server as arrows pointing along their course. Buttons and keys reorient it (see api).
   Drag left/right to spin and up/down to tilt, all the way over the poles (it keeps its momentum), scroll to zoom, click a strait, lane or ship. */

(() => {
  const HW = window.HW, C = HW.C, RAD = Math.PI / 180;
  const vec = (lat, lon) => { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]; };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const toLatLon = v => [Math.asin(HW.clamp(v[1], -1, 1)) / RAD, Math.atan2(v[0], v[2]) / RAD];
  const slerp = (a, b, t) => {
    const om = Math.acos(HW.clamp(dot3(a, b), -1, 1));
    if (om < 1e-6) return a;
    const s = Math.sin(om), wa = Math.sin((1 - t) * om) / s, wb = Math.sin(t * om) / s;
    return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
  };
  const VESSELS = ['container', 'tanker', 'dry_bulk', 'general_cargo', 'roro'];
  const VCOL = { container: C.container, tanker: C.tanker, dry_bulk: C.bulk, general_cargo: C.general, roro: C.roro };

  HW.makeGlobe = (canvas, D, opts = {}) => {
    const rnd = HW.rng(7);

    /* ---------- geometry built once ---------- */
    const ld = D.land.dots, nL = ld.length / 2;
    const LX = new Float32Array(nL), LY = new Float32Array(nL), LZ = new Float32Array(nL), LB = new Float32Array(nL);
    for (let i = 0; i < nL; i++) { const v = vec(ld[2 * i] / 100, ld[2 * i + 1] / 100); LX[i] = v[0]; LY[i] = v[1]; LZ[i] = v[2]; LB[i] = rnd(); }
    // country of each land dot and each border ring (-1 = none), from web/tools/build_land.py
    const LC = new Int16Array(nL).fill(-1);
    (D.land.dot_country || []).forEach((c, i) => { if (i < nL) LC[i] = c; });
    const COUNTRIES = D.land.countries || [];
    const nO = 5200, OX = new Float32Array(nO), OY = new Float32Array(nO), OZ = new Float32Array(nO);
    for (let i = 0; i < nO; i++) { const y = 1 - 2 * (i + 0.5) / nO, r = Math.sqrt(1 - y * y), a = i * 2.399963; OX[i] = r * Math.cos(a); OY[i] = y; OZ[i] = r * Math.sin(a); }
    // country rings, densified to every 2 degrees so the part clipped to the rim follows its curve
    const rings = D.land.borders.map(r => {
      const out = [], n = r.length / 2;
      let prev = null;
      for (let i = 0; i < n; i++) {
        const v = vec(r[2 * i + 1] / 10, r[2 * i] / 10);
        if (prev) { const om = Math.acos(HW.clamp(dot3(prev, v), -1, 1)), k = Math.ceil(om / (2 * RAD)); for (let j = 1; j < k; j++) out.push(...slerp(prev, v, j / k)); }
        out.push(...v); prev = v;
      }
      return new Float32Array(out);
    });
    const RC = Int16Array.from(D.land.ring_country || D.land.borders.map(() => -1));

    // corridors: densified 3D polylines with cumulative length, for drawing and particles
    const weeks = D.status.weeks, nW = weeks.length;
    const rWeeks = D.routes.weeks, rOff = rWeeks.indexOf(weeks[0]) >= 0 ? rWeeks.indexOf(weeks[0]) : 0;
    const lanes = D.corridors.features.map(f => {
      const raw = f.geometry.coordinates.map(([lon, lat]) => vec(lat, lon));
      const pts = [raw[0]];
      for (let i = 1; i < raw.length; i++) {
        const a = raw[i - 1], b = raw[i], om = Math.acos(HW.clamp(dot3(a, b), -1, 1)), n = Math.max(1, Math.ceil(om / (1.6 * RAD)));
        for (let k = 1; k <= n; k++) pts.push(slerp(a, b, k / n));
      }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.acos(HW.clamp(dot3(pts[i - 1], pts[i]), -1, 1)));
      const id = f.properties.corridor_id, r = D.routes.corridors[id];
      return { id, p: f.properties, pts, cum, len: cum[cum.length - 1], r, sx: new Float32Array(pts.length), sy: new Float32Array(pts.length), sv: new Uint8Array(pts.length) };
    });
    const laneAt = (L, s) => {   // point at arc length s along a lane
      let lo = 0, hi = L.cum.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L.cum[m] <= s) lo = m; else hi = m; }
      const seg = L.cum[hi] - L.cum[lo] || 1, t = (s - L.cum[lo]) / seg, a = L.pts[lo], b = L.pts[hi];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    };

    // how travelled each lane is: ships this week through the straits it passes, scaled 0 to 1
    {
      const latest = {}; for (const st of D.straits) { const t = st.weekly && st.weekly.total; latest[st.name] = t && t.length ? t[t.length - 1] : 0; }
      for (const L of lanes) L.traffic = (L.p.chokepoints || []).reduce((a, n) => a + (latest[n] || 0), 0);
      const top = Math.max(1, ...lanes.map(L => L.traffic));
      for (const L of lanes) L.busy = Math.sqrt(L.traffic / top);
    }

    // straits
    const straits = D.straits.map(s => ({ ...s, v: vec(s.lat, s.lon), sx: 0, sy: 0, vis: false }));

    /* ---------- state ---------- */
    const S = {
      ti: nW - 1, zoom: 1, zoomT: 1, idle: 9, wAxis: [0, 1, 0], wSpeed: 0, dragAng: 0, fly: null,
      hover: null, country: -1, countryFade: 0, sel: null, quiet: 1, autoSpin: false, anim: null, ships: [], shipsAt: 0, shipsFade: 0, showShips: true, dive: null,
    };
    const rotM = (axis, ang) => {
      const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
      return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
    };
    const mul = (a, b) => { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; return o; };
    const HOME = () => mul(rotM([1, 0, 0], 18 * RAD), rotM([0, 1, 0], -58 * RAD));   // over the Indian Ocean: Suez, Hormuz and Malacca in view
    let M = HOME();
    const spin = (axis, ang) => { if (ang) M = mul(rotM(axis, ang), M); };
    const view = v => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
    const unview = v => [M[0] * v[0] + M[3] * v[1] + M[6] * v[2], M[1] * v[0] + M[4] * v[1] + M[7] * v[2], M[2] * v[0] + M[5] * v[1] + M[8] * v[2]];

    let cx = 0, cy = 0, R = 1;

    /* values at the current week */
    const wi = () => Math.round(HW.clamp(S.ti, 0, nW - 1));
    const laneEff = L => { const e = L.r && L.r.efficiency; if (!e) return 1; return e[HW.clamp(wi() + rOff, 0, e.length - 1)]; };
    const laneBlocked = L => { const b = L.r && L.r.blocked_share; if (!b) return 0; return b[HW.clamp(wi() + rOff, 0, b.length - 1)]; };
    const straitRatio = s => { const r = s.status.ratio; return r[HW.clamp(wi(), 0, r.length - 1)]; };
    const straitMix = s => {   // vessel-type shares at the strait this week
      const w = s.weekly, i = HW.clamp(wi() - (nW - w.total.length), 0, w.total.length - 1), tot = w.total[i] || 1;
      return VESSELS.map(k => (w[k] ? w[k][i] : 0) / tot);
    };
    // world vessel mix this week, for flow particles
    let mixWeek = -1, mix = [0.35, 0.25, 0.25, 0.1, 0.05];
    const worldMix = () => {
      if (mixWeek === wi()) return mix;
      const acc = [0, 0, 0, 0, 0];
      for (const s of straits) { const m = straitMix(s), t = s.weekly.total[HW.clamp(wi() - (nW - s.weekly.total.length), 0, s.weekly.total.length - 1)]; m.forEach((x, k) => acc[k] += x * t); }
      const tot = acc.reduce((a, b) => a + b, 0) || 1;
      mix = acc.map(x => x / tot); mixWeek = wi();
      return mix;
    };
    const pickVessel = r => { const m = worldMix(); let a = 0; for (let k = 0; k < 5; k++) { a += m[k]; if (r <= a) return VESSELS[k]; } return 'container'; };

    /* ---------- drawing ---------- */
    const obj = {
      down() { S.wSpeed = 0; S.dragAng = 0; S.fly = null; S.anim = null; S.idle = 0; },
      drag(st, dx, dy) {
        // left/right spins about the screen's vertical axis, up/down tilts about its horizontal
        // axis, with no limit, so you can roll the globe over the poles and upside down
        const l = Math.hypot(dx, dy); if (l < 1e-6) return;
        const ang = l / R;
        S.wAxis = [dy / l, dx / l, 0]; S.dragAng += ang; spin(S.wAxis, ang); S.idle = 0;
      },
      wheel(st, dy) { S.zoomT = HW.clamp(S.zoomT * Math.exp(-dy * 0.0016), 0.85, 9); S.idle = 0; },
      click() {
        const h = S.hover;
        if (!h) { api.select(null); return; }
        api.select(h);
      },
      frame(st, dt) {
        const { ctx, W, H } = st, P = st.ptr;
        ctx.clearRect(0, 0, W, H);
        S.zoom += (S.zoomT - S.zoom) * (1 - Math.exp(-6 * dt));
        const panelShift = S.sel && W > 960 ? -Math.min(190, W * 0.13) : 0;
        S.shift = (S.shift || 0) + (panelShift - (S.shift || 0)) * (1 - Math.exp(-5 * dt));
        cx = W / 2 + S.shift; cy = H * 0.53; R = Math.min(W * 0.33, H * 0.36) * S.zoom;

        /* rotation: momentum, fly-to, slow idle drift */
        S.idle += dt;
        if (P.down) { S.wSpeed = HW.lerp(S.wSpeed, S.dragAng / dt, 0.45); S.dragAng = 0; }
        else {
          spin(S.wAxis, S.wSpeed * dt); S.wSpeed *= Math.exp(-2.1 * dt);
          if (S.fly) {
            const cur = view(S.fly.v), to = [0, 0, 1], ax = cross(cur, to), l = Math.hypot(ax[0], ax[1], ax[2]), rem = Math.atan2(l, dot3(cur, to));
            if (S.fly.zoom) S.zoomT = S.fly.zoom;
            if (rem < 0.003 || l < 1e-7) { if (S.fly.done) S.fly.done(); S.fly = null; }
            else spin([ax[0] / l, ax[1] / l, ax[2] / l], rem * (1 - Math.exp(-(S.fly.rate || 3.4) * dt)));
          } else if (S.anim) {
            // a button turn: ease the remaining angle down
            const step = S.anim.left * (1 - Math.exp(-7 * dt));
            if (Math.abs(S.anim.left) < 0.002) { spin(S.anim.axis, S.anim.left); S.anim = null; }
            else { spin(S.anim.axis, step); S.anim.left -= step; }
          } else if (S.autoSpin && !P.down) spin([0, 1, 0], 0.12 * dt);
        }
        const m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], m4 = M[4], m5 = M[5], m6 = M[6], m7 = M[7], m8 = M[8];
        const proj = (v, out) => { out[0] = cx + (m0 * v[0] + m1 * v[1] + m2 * v[2]) * R; out[1] = cy - (m3 * v[0] + m4 * v[1] + m5 * v[2]) * R; return m6 * v[0] + m7 * v[1] + m8 * v[2]; };
        const tmp = [0, 0];
        S.quiet += ((S.sel ? 0.35 : 1) - S.quiet) * (1 - Math.exp(-6 * dt));

        /* the sky behind the globe: stars, shooting stars, the Sun, Moon and Mars (js/sky.js) */
        if (HW.drawSky) HW.drawSky(ctx, { W, H, cx, cy, view, dt, light: C.theme === 'light' });

        /* sphere body and rim */
        const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
        g.addColorStop(0, C.sphere[0]); g.addColorStop(0.7, C.sphere[1]); g.addColorStop(1, C.sphere[2]);
        ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fill();
        const halo = ctx.createRadialGradient(cx, cy, R * 0.99, cx, cy, R * 1.16);
        halo.addColorStop(0, `rgba(${C.glow},0.1)`); halo.addColorStop(1, `rgba(${C.glow},0)`);
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.16, 0, 6.2832); ctx.arc(cx, cy, R, 0, 6.2832, true); ctx.fill();
        ctx.strokeStyle = C.rim; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.stroke();

        /* ocean grid dots */
        ctx.fillStyle = C.fg; ctx.globalAlpha = 0.045; ctx.beginPath();
        for (let i = 0; i < nO; i++) {
          const z = m6 * OX[i] + m7 * OY[i] + m8 * OZ[i]; if (z < 0.05) continue;
          ctx.rect(cx + (m0 * OX[i] + m1 * OY[i] + m2 * OZ[i]) * R - 0.5, cy - (m3 * OX[i] + m4 * OY[i] + m5 * OZ[i]) * R - 0.5, 1, 1);
        }
        ctx.fill();

        /* land as dots (Kimball wants these back over filled countries), in three brightness
           buckets so the texture breathes, brighter near the cursor. Drawn in the theme's text
           colour at low opacity, so it works in light and dark mode. */
        const ds = HW.clamp(1.25 * Math.sqrt(S.zoom), 1.2, 2.6), hs = ds / 2, px = P.inside ? P.x : -1e4, py = P.y;
        const BUCKET_ALPHA = [0.24, 0.36, 0.58];
        // the country under the cursor (like the 423 globe): its dots light up and its outline shows
        const hc = S.country;
        let nearDot = -1, nearD = 50;

        // The bulge under the cursor: a Gaussian bump. Dots near the cursor spread outward
        // (like a lens), lift up a few pixels, grow and brighten, with a faint shadow left
        // where they sat. The bump follows the cursor smoothly and sinks when it leaves.
        const onIt = P.inside && !P.down;
        if (onIt) {
          if (!S.bs) { S.bx = P.x; S.by = P.y; }
          S.bx += (P.x - S.bx) * (1 - Math.exp(-18 * dt));
          S.by += (P.y - S.by) * (1 - Math.exp(-18 * dt));
        }
        S.bs = (S.bs || 0) + ((onIt ? 1 : 0) - (S.bs || 0)) * (1 - Math.exp(-7 * dt));
        const SIG = 15 + 3 * Math.sqrt(S.zoom), TWO_SIG2 = 2 * SIG * SIG, REACH2 = 9 * SIG * SIG;   // a small bump
        const SPREAD = 0.3, LIFT = 4;
        const raised = [];   // dots inside the bump: drawn last, on top, one by one
        const bumpOf = (sx, sy) => {
          if (S.bs < 0.01) return 0;
          const dx = sx - S.bx, dy = sy - S.by, d2 = dx * dx + dy * dy;
          return d2 < REACH2 ? S.bs * Math.exp(-d2 / TWO_SIG2) : 0;
        };
        ctx.fillStyle = C.fg;
        for (let b = 0; b < 3; b++) {
          ctx.globalAlpha = BUCKET_ALPHA[b]; ctx.beginPath();
          for (let i = 0; i < nL; i++) {
            const Z = m6 * LX[i] + m7 * LY[i] + m8 * LZ[i]; if (Z < 0) continue;
            const sx = cx + (m0 * LX[i] + m1 * LY[i] + m2 * LZ[i]) * R, sy = cy - (m3 * LX[i] + m4 * LY[i] + m5 * LZ[i]) * R;
            if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) continue;
            const dx = sx - px, dy = sy - py, d2 = dx * dx + dy * dy, near = d2 < 2200 ? Math.exp(-d2 / 700) : 0;
            if (b === 0 && d2 < nearD) { nearD = d2; nearDot = i; }
            if (hc >= 0 && LC[i] === hc) continue;   // drawn bright below
            const lum = (Z < 0.2 ? Z * 5 : 1) * (0.55 + 0.45 * LB[i]) + near * 1.2;
            const bucket = lum > 1.05 ? 2 : lum > 0.72 ? 1 : 0;
            if (bucket !== b) continue;
            const gb = bumpOf(sx, sy);
            if (gb > 0.03) { raised.push([i, sx, sy, gb, BUCKET_ALPHA[b], false]); continue; }
            ctx.rect(sx - hs, sy - hs, ds, ds);
          }
          ctx.fill();
        }
        if (hc >= 0) {
          ctx.fillStyle = C.accent;   // the hovered country lights up in the accent blue
          ctx.globalAlpha = 0.95 * S.countryFade; ctx.beginPath();
          const hd = ds * 1.25, hh = hd / 2;
          for (let i = 0; i < nL; i++) {
            if (LC[i] !== hc) continue;
            const Z = m6 * LX[i] + m7 * LY[i] + m8 * LZ[i]; if (Z < 0) continue;
            const sx = cx + (m0 * LX[i] + m1 * LY[i] + m2 * LZ[i]) * R, sy = cy - (m3 * LX[i] + m4 * LY[i] + m5 * LZ[i]) * R;
            const gb = bumpOf(sx, sy);
            if (gb > 0.03) { raised.push([i, sx, sy, gb, 0.95 * S.countryFade, true]); continue; }
            ctx.rect(sx - hh, sy - hh, hd, hd);
          }
          ctx.fill();
        }
        if (raised.length) {
          // shadows first (where the dots sat), then the lifted dots, back to front
          ctx.fillStyle = C.bg;
          for (const [, sx, sy, gb] of raised) {
            ctx.globalAlpha = 0.5 * gb;
            const sd = ds * (1 + 0.6 * gb);
            ctx.fillRect(sx - sd / 2, sy - sd / 2 + 1.5, sd, sd);
          }
          raised.sort((a, b) => a[3] - b[3]);
          for (const [, sx, sy, gb, alpha, inCountry] of raised) {
            const x = sx + (sx - S.bx) * SPREAD * gb, y = sy + (sy - S.by) * SPREAD * gb - LIFT * gb;
            const sd = (inCountry ? ds * 1.25 : ds) * (1 + 0.7 * gb);
            ctx.fillStyle = inCountry ? C.accent : C.fg;
            ctx.globalAlpha = Math.min(1, alpha + 0.55 * gb);
            ctx.fillRect(x - sd / 2, y - sd / 2, sd, sd);
          }
        }
        // which country the cursor is over: the nearest land dot within ~7 px
        const overCountry = P.inside && !P.down && nearDot >= 0 ? LC[nearDot] : -1;
        if (overCountry !== S.country) { S.country = overCountry; S.countryFade = 0; }
        S.countryFade += (1 - S.countryFade) * (1 - Math.exp(-10 * dt));

        /* country outlines, faint; the hovered country's outline brighter */
        if (hc >= 0) {
          ctx.globalAlpha = 0.9 * S.countryFade; ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.beginPath();
          rings.forEach((f, k) => {
            if (RC[k] !== hc) return;
            let pen = false;
            for (let i = 0; i < f.length; i += 3) {
              const x0 = f[i], y0 = f[i + 1], z0 = f[i + 2], Z = m6 * x0 + m7 * y0 + m8 * z0;
              if (Z < 0.02) { pen = false; continue; }
              const x = cx + (m0 * x0 + m1 * y0 + m2 * z0) * R, y = cy - (m3 * x0 + m4 * y0 + m5 * z0) * R;
              if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
            }
          });
          ctx.stroke();
        }
        // country outlines, clearly visible (Kimball wants them back)
        ctx.globalAlpha = 0.26 * S.quiet + 0.06; ctx.strokeStyle = C.fg; ctx.lineWidth = 0.7; ctx.beginPath();
        for (const f of rings) {
          let pen = false;
          for (let i = 0; i < f.length; i += 3) {
            const x0 = f[i], y0 = f[i + 1], z0 = f[i + 2], Z = m6 * x0 + m7 * y0 + m8 * z0;
            if (Z < 0.02) { pen = false; continue; }
            const x = cx + (m0 * x0 + m1 * y0 + m2 * z0) * R, y = cy - (m3 * x0 + m4 * y0 + m5 * z0) * R;
            if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
          }
        }
        ctx.stroke();

        /* lanes: brightness is efficiency, blocked share turns the lane into a dotted grey line */
        const hovLane = S.hover && S.hover.kind === 'lane' ? S.hover.L : null, selLane = S.sel && S.sel.kind === 'lane' ? S.sel.L : null;
        let lanePick = null, laneD = 60;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const L of lanes) {
          const n = L.pts.length;
          for (let j = 0; j < n; j++) {
            const Z = proj(L.pts[j], tmp); L.sx[j] = tmp[0]; L.sy[j] = tmp[1]; L.sv[j] = Z > 0.01 ? 1 : 0;
            if (L.sv[j] && P.inside && !P.down && j % 2 === 0) { const d2 = (tmp[0] - px) ** 2 + (tmp[1] - py) ** 2; if (d2 < laneD) { laneD = d2; lanePick = L; } }
          }
          const eff = laneEff(L), blk = laneBlocked(L), hi = L === hovLane || L === selLane;
          // blue lines that glow more the more ships use the route this week (L.busy, 0 to 1,
          // from the traffic through its straits); a blocked route is a dotted grey line
          const busy = L.busy, blocked = blk > 0.3;
          if (!blocked && !hi && busy > 0.25) {   // the glow: a wide, soft stroke under the line
            ctx.setLineDash([]);
            ctx.strokeStyle = C.accent; ctx.lineWidth = 3 + 6 * busy; ctx.globalAlpha = 0.10 * busy * S.quiet;
            ctx.beginPath(); let pg = false;
            for (let j = 0; j < n; j++) { if (!L.sv[j]) { pg = false; continue; } if (pg) ctx.lineTo(L.sx[j], L.sy[j]); else { ctx.moveTo(L.sx[j], L.sy[j]); pg = true; } }
            ctx.stroke();
          }
          ctx.strokeStyle = hi ? C.laneHi : blocked ? C.dim : C.accent;
          ctx.lineWidth = hi ? 2 : 0.7 + 0.9 * busy;
          ctx.globalAlpha = hi ? 1 : (blocked ? 0.3 : 0.22 + 0.6 * busy) * S.quiet;
          ctx.setLineDash(blk > 0.3 ? [2, 4] : []);
          ctx.beginPath(); let pen = false;
          for (let j = 0; j < n; j++) { if (!L.sv[j]) { pen = false; continue; } if (pen) ctx.lineTo(L.sx[j], L.sy[j]); else { ctx.moveTo(L.sx[j], L.sy[j]); pen = true; } }
          ctx.stroke();
        }
        ctx.setLineDash([]);

        /* live ships, only at "now" */
        const atNow = S.ti >= nW - 1.01;
        S.shipsFade += ((atNow && S.showShips ? 1 : 0) - S.shipsFade) * (1 - Math.exp(-4 * dt));
        let shipPick = null, shipD = 64;
        if (S.shipsFade > 0.02 && S.ships.length) {
          // cargo ships and tankers only (every one is underway, 3 kn or more), drawn as an arrow
          // pointing along its course. Zoomed in, each gets a pin whose tip sits on its position.
          const pins = S.zoom >= 2.2, len = pins ? 6 : 3.6 + 0.8 * Math.sqrt(S.zoom);
          for (const s of S.ships) {
            const Z = proj(s.v, tmp); if (Z < 0.03) continue;
            const x = tmp[0], y = tmp[1]; if (x < -14 || x > W + 14 || y < -24 || y > H + 8) continue;
            const col = HW.groupColour(s.g);
            // course on screen: clockwise from north, using the local north and east at the ship
            const c = (s.cog || 0) * RAD, sl = Math.sin(s.lat * RAD), cl = Math.cos(s.lat * RAD), so = Math.sin(s.lon * RAD), co = Math.cos(s.lon * RAD);
            const north = view([-sl * so, cl, -sl * co]), east = view([co, 0, -so]);
            let vx = Math.sin(c) * east[0] + Math.cos(c) * north[0], vy = -(Math.sin(c) * east[1] + Math.cos(c) * north[1]);
            const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
            ctx.globalAlpha = S.shipsFade * (Z < 0.2 ? Z * 5 : 1);
            const hx = x, hy = pins ? y - 15 : y;   // where the arrow sits
            if (pins) {
              ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(hx, hy + 7); ctx.stroke();
              ctx.fillStyle = C.bg; ctx.beginPath(); ctx.arc(hx, hy, 7.5, 0, 6.2832); ctx.fill();
              ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
              ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 6.2832); ctx.fill();
            }
            // arrow: tip ahead along course, two back corners
            const px2 = -vy, py2 = vx, w = len * 0.55;
            ctx.fillStyle = col; ctx.strokeStyle = C.bg; ctx.lineWidth = pins ? 0 : 0.8;
            ctx.beginPath();
            ctx.moveTo(hx + vx * len, hy + vy * len);
            ctx.lineTo(hx - vx * len * 0.7 + px2 * w, hy - vy * len * 0.7 + py2 * w);
            ctx.lineTo(hx - vx * len * 0.35, hy - vy * len * 0.35);
            ctx.lineTo(hx - vx * len * 0.7 - px2 * w, hy - vy * len * 0.7 - py2 * w);
            ctx.closePath();
            if (!pins) ctx.stroke();
            ctx.fill();
            if (P.inside && !P.down) { const d2 = (hx - px) ** 2 + (hy - py) ** 2; if (d2 < shipD) { shipD = d2; shipPick = s; } }
          }
        }

        /* strait rings: two arcs whose gap is the traffic vs 2023 (wide open = normal) */
        let straitPick = null, straitD = 260;
        const vr = HW.clamp(7 + 2.2 * Math.sqrt(S.zoom), 8, 15);
        for (const s of straits) {
          const Z = proj(s.v, tmp); s.vis = Z > 0.05; if (!s.vis) continue;
          const x = tmp[0], y = tmp[1]; s.sx = x; s.sy = y;
          const ratio = straitRatio(s), open = HW.clamp(ratio, 0, 1.2), hi = (S.hover && S.hover.s === s) || (S.sel && S.sel.s === s);
          const busy = s.status.baseline_per_week > 250 || hi;
          ctx.globalAlpha = (hi ? 1 : busy ? 0.9 : 0.45) * (Z < 0.25 ? Z * 4 : 1);
          ctx.strokeStyle = ratio < 0.6 ? C.dim : C.fg; ctx.lineWidth = hi ? 1.8 : 1.3;
          const gap = 0.12 + 0.95 * HW.clamp(open, 0, 1);   // radians of opening on each side
          ctx.beginPath(); ctx.arc(x, y, vr, -Math.PI / 2 + gap, Math.PI / 2 - gap); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, vr, Math.PI / 2 + gap, Math.PI * 1.5 - gap); ctx.stroke();
          if (P.inside && !P.down) { const d2 = (x - px) ** 2 + (y - py) ** 2; if (d2 < straitD) { straitD = d2; straitPick = s; } }
          if (Math.abs(ratio - 1) > 0.2 && !hi && S.zoom < 3.5) {   // label only the disrupted ones; the rest on hover
            const pct = (ratio - 1) * 100, right = x >= cx;
            HW.label(ctx, (right ? '' : '') + s.name.replace(' Strait', '').replace(' Canal', '').toUpperCase() + ' ' + HW.fPct(pct), x + (right ? vr + 5 : -vr - 5), y + 4, ratio < 0.6 ? C.fg : C.dim, right ? 'left' : 'right', 10.5);
          }
        }

        /* hover: strait first, then ship, then lane */
        if (!P.down) {
          const was = S.hover && (S.hover.s || S.hover.L || S.hover.ship);
          S.hover = straitPick ? { kind: 'strait', s: straitPick } : shipPick ? { kind: 'ship', ship: shipPick } : lanePick ? { kind: 'lane', L: lanePick } : null;
          const now = S.hover && (S.hover.s || S.hover.L || S.hover.ship);
          if (now !== was) canvas.style.cursor = S.hover ? 'pointer' : 'grab';
        }

        /* the hovered country's name, when nothing else is under the cursor */
        if (!S.hover && S.country >= 0 && !P.down && COUNTRIES[S.country]) {
          ctx.globalAlpha = S.countryFade;
          HW.label(ctx, COUNTRIES[S.country].name.toUpperCase(), P.x + 14, P.y - 10, C.laneHi, 'left', 11, 500);
          ctx.globalAlpha = 1;
        }

        /* callout */
        const h = S.hover;
        if (h && !P.down) {
          let x, y, title, sub, sub2;
          if (h.kind === 'strait') {
            const r = straitRatio(h.s); x = h.s.sx; y = h.s.sy; title = h.s.name.toUpperCase();
            sub = `${HW.fPct((r - 1) * 100)} VS 2023 · ${HW.fInt(r * h.s.status.baseline_per_week)} SHIPS/WK`;
          } else if (h.kind === 'ship') {
            proj(h.ship.v, tmp); x = tmp[0]; y = tmp[1] - (S.zoom >= 2.2 ? 15 : 0); title = (h.ship.name || 'MMSI ' + h.ship.mmsi).toUpperCase();
            sub = `${HW.groupLabel(h.ship.g)} · ${h.ship.sog != null ? h.ship.sog.toFixed(1) + ' KN' : ''}`; sub2 = h.ship.destination ? '→ ' + h.ship.destination.toUpperCase() : '';
          } else {
            const L = h.L, mid = L.pts[Math.floor(L.pts.length / 2)]; proj(mid, tmp); x = P.x; y = P.y;
            const e = laneEff(L); title = (L.p.region_a + ' → ' + L.p.region_b).toUpperCase();
            sub = `${(L.r ? L.r.expected_days[HW.clamp(wi() + rOff, 0, L.r.expected_days.length - 1)] : L.p.days).toFixed(1)} DAYS · EFFICIENCY ${e.toFixed(2)}`;
          }
          const right = x < W - 300, lx = x + (right ? 42 : -42), ly = Math.max(70, y - 48);
          ctx.globalAlpha = 0.8; ctx.strokeStyle = C.dim; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly + 4); ctx.stroke();
          ctx.globalAlpha = 1; ctx.fillStyle = C.fg; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 6.2832); ctx.fill();
          const al = right ? 'left' : 'right', tx = lx + (right ? 6 : -6);
          HW.label(ctx, title, tx, ly - 12, C.fg, al, 12, 500);
          HW.label(ctx, sub, tx, ly + 3, C.fg, al, 10.5);
          if (sub2) HW.label(ctx, sub2, tx, ly + 17, C.dim, al, 10.5);
        }

        if (opts.onFrame) opts.onFrame(S);
      },
    };

    const api = {
      S, lanes, straits, weeks, rOff,
      laneEff, straitRatio, straitMix, worldMix,
      setWeek(f) { S.ti = HW.clamp(f, 0, nW - 1); },
      setShips(list) {
        S.ships = list.map(s => ({ ...s, v: vec(s.lat, s.lon), g: s.type_group || HW.vesselGroup(s.type) }))
          .filter(s => (s.g === 'cargo' || s.g === 'tanker') && s.sog >= 3);
        S.shipsAt = Date.now();
      },
      flyTo(lat, lon, zoom, done, rate) { S.fly = { v: vec(lat, lon), zoom, done, rate }; S.wSpeed = 0; S.idle = 0; },
      select(item) {
        S.sel = item;
        if (item && item.kind === 'strait') api.flyTo(item.s.lat, item.s.lon, Math.max(S.zoomT, 1.7));
        if (item && item.kind === 'lane') { const v = item.L.pts[Math.floor(item.L.pts.length / 2)]; const [la, lo] = toLatLon(v); api.flyTo(la, lo, Math.max(1, Math.min(S.zoomT, 1.4))); }
        if (opts.onSelect) opts.onSelect(item);
      },
      zoomBy(f) { S.zoomT = HW.clamp(S.zoomT * f, 0.85, 9); },
      /* orientation: each turn eases in over a moment. Angles in degrees. */
      turn(deg) { S.fly = null; S.wSpeed = 0; S.anim = { axis: [0, 1, 0], left: deg * RAD }; },    // + spins the front to the right
      tilt(deg) { S.fly = null; S.wSpeed = 0; S.anim = { axis: [1, 0, 0], left: deg * RAD }; },    // + rolls the top toward you (see more of the north)
      roll(deg) { S.fly = null; S.wSpeed = 0; S.anim = { axis: [0, 0, 1], left: -deg * RAD }; },   // + turns the picture clockwise
      northUp() {   // turn the picture so north points straight up
        const n = view([0, 1, 0]); if (Math.hypot(n[0], n[1]) < 1e-3) return;
        S.fly = null; S.wSpeed = 0; S.anim = { axis: [0, 0, 1], left: Math.atan2(n[0], n[1]) };
      },
      flip() { api.roll(180); },
      home() { M = HOME(); S.fly = null; S.anim = null; S.wSpeed = 0; S.zoomT = 1; api.select(null); },
      setAutoSpin(on) { S.autoSpin = on; },
      isUpsideDown() { return view([0, 1, 0])[1] < 0; },
      screenOf(lat, lon) { const out = [0, 0]; const v = vec(lat, lon); const Z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2]; out[0] = cx + (M[0] * v[0] + M[1] * v[1] + M[2] * v[2]) * R; out[1] = cy - (M[3] * v[0] + M[4] * v[1] + M[5] * v[2]) * R; return { x: out[0], y: out[1], visible: Z > 0 }; },
    };
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    api.stage = HW.stage(canvas, obj);
    return api;
  };
})();
