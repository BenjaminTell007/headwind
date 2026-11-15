/* The single ship view. An outlined, flat-colour ship drawn as SVG from a three-quarter
   angle off the bow, bobbing on a moving sea. The drawing is built from simple boxes in
   ship space (x along the length from the bow, y across the beam, z up) and projected
   to the screen, so the cargo can change with the ship: containers for a cargo ship,
   a pipe deck for a tanker. Colour follows the vessel type.

   HW.makeDive(svg) -> { open(ship), setWeather(w), close(), S } */

(() => {
  const HW = window.HW, NS = 'http://www.w3.org/2000/svg';

  /* projection: bow at lower left, stern at upper right, seen from above the near (starboard) bow */
  const O = [150, 590], U = [6.6, -2.75], V = [3.9, 3.15], WZ = 6.4;
  const P = (x, y, z) => [O[0] + x * U[0] + y * V[0], O[1] + x * U[1] + y * V[1] - z * WZ];
  const pts = a => a.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');

  /* colour helpers */
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const mix = (a, b, t) => { const A = hex(a), B = hex(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); };

  const L = 100, B = 9, H = 6.5;   // length, half beam, deck height above the water
  const half = x => x < 20 ? B * Math.pow(x / 20, 0.62) : x > 95 ? B * (1 - 0.18 * (x - 95) / 5) : B;         // deck edge
  const halfW = x => x < 26 ? B * Math.pow(Math.max(0, x - 3) / 23, 0.75) : x > 95 ? B * (1 - 0.3 * (x - 95) / 5) : B;   // waterline, finer at the bow

  HW.makeDive = svg => {
    const S = { on: false, ship: null, kind: 'cargo', wave: 1, period: 7, wind: 8, t: 0 };
    let raf = 0, last = 0, shipG = null, waveEls = [], foam = null;

    const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); (parent || svg).appendChild(e); return e; };

    const build = () => {
      svg.innerHTML = '';
      const C = HW.C, dark = C.theme !== 'light';
      const ink = dark ? '#0b0d11' : '#1b1d21';                 // outlines
      const type = HW.groupColour(S.kind === 'tanker' ? 'tanker' : S.ship.g === 'passenger' ? 'passenger' : 'cargo');
      const sea = dark ? ['#0e1826', '#13233a'] : ['#dbe7f5', '#c9daee'];
      const hullCol = dark ? '#3f444c' : '#4a4f57', deckCol = dark ? '#b9bcc0' : '#d5d7da', white = '#f2f2f0', grey = '#c2c4c7';
      const stroke = { stroke: ink, 'stroke-width': 1.3, 'stroke-linejoin': 'round' };

      /* sea: a flat field with rows of short wave marks that drift */
      const defs = el('defs', {});
      const grad = el('linearGradient', { id: 'seaG', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      el('stop', { offset: 0, 'stop-color': sea[0] }, grad); el('stop', { offset: 1, 'stop-color': sea[1] }, grad);
      el('rect', { x: -2000, y: -1500, width: 5000, height: 3700, fill: 'url(#seaG)' });
      waveEls = [];
      const rnd = HW.rng(11);
      for (let row = 0; row < 26; row++) {
        const y = -120 + row * 38;
        for (let k = 0; k < 9; k++) {
          const x = -700 + k * 300 + rnd() * 220, w = 26 + rnd() * 46;
          const e = el('path', { fill: 'none', stroke: C.accent, 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: (0.16 + rnd() * 0.22).toFixed(2) });
          waveEls.push({ e, x, y: y + rnd() * 22, w, ph: rnd() * 6.28, sp: 0.6 + rnd() * 0.8 });
        }
      }

      /* the ship: everything that bobs */
      shipG = el('g', {});
      const g = shipG;
      const poly = (p, fill, extra) => el('polygon', { points: pts(p), fill, ...stroke, ...extra }, g);
      // a box with its three visible faces: top, near side (+y), bow end (-x)
      const box = (x0, x1, y0, y1, z0, z1, col, o = {}) => {
        poly([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], o.top || mix(col, '#ffffff', 0.28));
        poly([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], col);
        poly([P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1)], mix(col, '#000000', 0.22));
      };
      const xs = n => Array.from({ length: n + 1 }, (_, i) => i * L / n);

      // soft shadow on the water under the hull
      el('polygon', { points: pts(xs(40).map(x => P(x, halfW(x) + 2.4, 0)).concat(xs(40).reverse().map(x => P(x + 1, -halfW(x), 0)))), fill: '#000', opacity: dark ? 0.35 : 0.12 }, g);

      // far side of the hull (shows at the bow), then the near side, with a boot stripe in the vessel colour
      poly(xs(40).map(x => P(x, -half(x), H)).concat(xs(40).reverse().map(x => P(x, -halfW(x), 0))), mix(hullCol, '#000000', 0.3));
      const nearTop = xs(40).map(x => P(x, half(x), H)), nearLow = xs(40).reverse().map(x => P(x, halfW(x), 0));
      poly(nearTop.concat(nearLow), hullCol);
      poly(xs(40).map(x => P(x, halfW(x) + (half(x) - halfW(x)) * 0.2, 1.3)).concat(nearLow), type);
      // stern end
      poly([P(L, -half(L), H), P(L, half(L), H), P(L, halfW(L), 0), P(L, -halfW(L), 0)], mix(hullCol, '#000000', 0.15));

      // deck
      poly(xs(40).map(x => P(x, half(x), H)).concat(xs(40).reverse().map(x => P(x, -half(x), H))), deckCol);
      // bulwark line along the near edge
      el('polyline', { points: pts(xs(40).map(x => P(x, half(x) * 0.93, H))), fill: 'none', stroke: ink, 'stroke-width': 0.8, opacity: 0.55 }, g);

      // forecastle: a small raised deck, mast and winches at the bow
      box(13, 15.5, -1.4, 1.4, H, H + 1.2, grey);
      el('line', { x1: P(9, 0, H)[0], y1: P(9, 0, H)[1], x2: P(9, 0, H + 13)[0], y2: P(9, 0, H + 13)[1], ...stroke, 'stroke-width': 2.2 }, g);
      el('line', { x1: P(9, -2, H + 10.5)[0], y1: P(9, -2, H + 10.5)[1], x2: P(9, 2, H + 10.5)[0], y2: P(9, 2, H + 10.5)[1], ...stroke, 'stroke-width': 1.6 }, g);

      /* cargo */
      const len = +S.ship.length || 0;
      if (S.kind === 'tanker') {
        // tank deck: a raised trunk, a pipe run down the middle, a manifold amidships, tank hatches
        box(20, 80, -6.5, 6.5, H, H + 1.1, mix(type, '#3a3d42', 0.55), { top: mix(type, '#8b8f96', 0.6) });
        for (let x = 25; x < 78; x += 9) for (const y of [-3.6, 3.6]) {
          const c = P(x, y, H + 1.1);
          el('ellipse', { cx: c[0], cy: c[1], rx: 9, ry: 4.6, fill: grey, ...stroke }, g);
          el('ellipse', { cx: c[0], cy: c[1] - 3, rx: 9, ry: 4.6, fill: white, ...stroke }, g);
        }
        box(21, 79, -0.7, 0.7, H + 1.1, H + 2.6, white);
        box(47, 53, -7.4, 7.4, H + 1.1, H + 3.4, type);
        for (const x of [36, 64]) { el('line', { x1: P(x, 0, H + 2.6)[0], y1: P(x, 0, H + 2.6)[1], x2: P(x, 0, H + 15)[0], y2: P(x, 0, H + 15)[1], ...stroke, 'stroke-width': 2 }, g); }
      } else {
        // containers: bays along the length, six across, stacked; drawn far to near so the outlines overlap properly
        const bays = HW.clamp(Math.round((len || 220) / 26), 6, 10), x0 = 18, x1 = 80, bl = (x1 - x0) / bays, rows = 6, rw = (2 * B - 2.4) / rows, th = 2.7;
        const rnd = HW.rng((+S.ship.mmsi || 7) % 9973 + 3);
        const cols = [white, grey, type, mix(type, '#ffffff', 0.35), white, mix(type, '#000000', 0.18)];
        for (let b = bays - 1; b >= 0; b--) {
          const bx0 = x0 + b * bl + 0.45, bx1 = x0 + (b + 1) * bl - 0.45;
          const tiers = b === 0 ? 2 : b === bays - 1 ? 3 : 3 + (rnd() < 0.55 ? 1 : 0);
          for (let r = 0; r < rows; r++) {
            const y0 = -B + 1.2 + r * rw, tall = Math.max(1, tiers - (rnd() < 0.18 ? 1 : 0));
            for (let t = 0; t < tall; t++) box(bx0, bx1, y0, y0 + rw, H + t * th, H + (t + 1) * th, cols[Math.floor(rnd() * cols.length)]);
          }
        }
      }

      /* superstructure at the stern: accommodation block, windows, bridge with wings, funnel and mast */
      const a0 = 83, a1 = 93, top = H + 17.5;
      box(94.5, 98, -3, 3, H, H + 14.5, mix(hullCol, '#000000', 0.1), { top: type });                 // funnel, behind the block
      box(a0, a1, -7.2, 7.2, H, top, white);
      for (let k = 0; k < 3; k++) {      // window rows on the face that looks forward
        const z = H + 4.2 + k * 4.1;
        for (let j = 0; j < 6; j++) { const y = -5.9 + j * 2.1; el('polygon', { points: pts([P(a0, y, z), P(a0, y + 1.1, z), P(a0, y + 1.1, z + 1.5), P(a0, y, z + 1.5)]), fill: ink }, g); }
        for (let j = 0; j < 3; j++) { const x = a0 + 1.6 + j * 2.9; el('polygon', { points: pts([P(x, 7.2, z), P(x + 1.3, 7.2, z), P(x + 1.3, 7.2, z + 1.5), P(x, 7.2, z + 1.5)]), fill: ink }, g); }
      }
      box(a0 - 1, a1 - 1.5, -9.6, 9.6, top, top + 3.4, white, { top: type });                       // bridge and wings
      poly([P(a0 - 1, -8.6, top + 1), P(a0 - 1, 8.6, top + 1), P(a0 - 1, 8.6, top + 2.6), P(a0 - 1, -8.6, top + 2.6)], ink);   // bridge windows
      const m0 = P(88, 0, top + 3.4), m1 = P(88, 0, top + 12);
      el('line', { x1: m0[0], y1: m0[1], x2: m1[0], y2: m1[1], ...stroke, 'stroke-width': 2.4 }, g);
      el('line', { x1: P(88, -2.6, top + 9)[0], y1: P(88, -2.6, top + 9)[1], x2: P(88, 2.6, top + 9)[0], y2: P(88, 2.6, top + 9)[1], ...stroke, 'stroke-width': 1.6 }, g);

      /* foam along the near waterline; stays with the ship, drawn last */
      foam = el('path', { fill: 'none', stroke: dark ? '#e9f1ff' : '#ffffff', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9 }, g);
    };

    /* animation: the ship heaves, pitches and rolls a little; wave marks drift and flex */
    const frame = now => {
      raf = 0; if (!S.on) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now; S.t += dt;
      const t = S.t, amp = HW.clamp(0.6 + S.wave * 0.9, 0.8, 3.4), w = 6.2832 / HW.clamp(S.period, 4, 11);
      const heave = Math.sin(t * w) * 4.2 * amp, pitch = Math.sin(t * w + 1.1) * 0.55 * amp, sway = Math.sin(t * w * 0.5 + 0.4) * 2.2 * amp;
      const c = P(L / 2, 0, 0);
      shipG.setAttribute('transform', `translate(${sway.toFixed(2)} ${heave.toFixed(2)}) rotate(${pitch.toFixed(3)} ${c[0].toFixed(0)} ${c[1].toFixed(0)})`);
      // foam follows the waterline, rising and falling against the hull as it heaves
      let d = '';
      for (let i = 0; i <= 44; i++) {
        const x = i * L / 44, lap = Math.sin(x * 0.42 - t * 2.2) * 0.45 + 0.35 + heave / WZ * 0.5, p = P(x, halfW(x) + 0.25, HW.clamp(lap, -0.2, 2.2));
        d += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
      }
      foam.setAttribute('d', d);
      const drift = 9 + S.wind * 0.9;
      for (const m of waveEls) {
        m.x -= drift * m.sp * dt; if (m.x < -760) m.x += 2700;
        const k = Math.sin(t * 1.3 + m.ph) * 4.5 * Math.min(2, amp);
        m.e.setAttribute('d', `M${m.x.toFixed(1)} ${m.y.toFixed(1)}q${(m.w / 4).toFixed(1)} ${(-k).toFixed(1)} ${(m.w / 2).toFixed(1)} 0t${(m.w / 2).toFixed(1)} 0`);
      }
      raf = requestAnimationFrame(frame);
    };

    return {
      S,
      open(ship) {
        S.ship = ship; S.kind = (ship.g || ship.type_group) === 'tanker' ? 'tanker' : 'cargo';
        S.on = true; S.t = 0; S.wave = 1; S.period = 7; S.wind = 8;
        build(); last = performance.now(); if (!raf) raf = requestAnimationFrame(frame);
      },
      setWeather(w) {
        if (w.wave_height != null) S.wave = +w.wave_height;
        if (w.wave_period != null) S.period = +w.wave_period;
        if (w.wind_speed_10m != null) S.wind = +w.wind_speed_10m;
      },
      redraw() { if (S.on) build(); },
      close() { S.on = false; cancelAnimationFrame(raf); raf = 0; svg.innerHTML = ''; },
    };
  };
})();
