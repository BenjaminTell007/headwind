/* Landing page: real drone footage of a tanker, drawn live as a glyph matrix.

   Every frame the video is shrunk to one pixel per grid cell. Each cell's
   brightness picks a glyph (dark sea = tiny dots, bright hull and wake = solid
   shapes) and a slow wave field nudges shapes and colours in place, so the
   matrix shimmers without anything swirling. A mask decides, cell by cell,
   whether you see the glyph or the real footage underneath:

     1. glyphs fade in over black
     2. the footage opens out from the ship (the "decrypt")
     3. the edges stay glyph, and a lens around the cursor turns footage back into glyphs
     4. Enter closes the matrix over everything and loads the map */

(() => {
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const video = document.getElementById('vid');
  const body = document.body;

  // Glyph colours. Greys for the sea, white and tanker purple for the ship and wake
  // (the ship in the clip is a tanker, so its hue is the tanker hue).
  const GREYS = ['#1d2024', '#26292e', '#30343a', '#3c4047', '#4b4f56', '#5f6369', '#787b80', '#96989b'];
  const BRIGHT = ['#f2f2f0', '#8f82f2', '#6f62d8', '#f2f2f0', '#d9d6ff'];
  const COLOURS = GREYS.concat(BRIGHT);
  const N_SHAPES = 10;

  let W = 0, H = 0, DPR = 1, cell = 10, cols = 0, rows = 0;
  let atlas = null;           // pre-drawn glyph sprites: [colour][shape]
  let sample = null, sctx = null;
  let rnd = new Float32Array(0);
  const mouse = { x: -9999, y: -9999, s: 0 };
  let t0 = performance.now(), leaving = 0, uiShown = false, target = 'web/';

  /* ---------- one glyph, drawn into the sprite atlas ---------- */
  const drawGlyph = (c, k, x, y, s, col) => {
    c.fillStyle = col;
    c.strokeStyle = col;
    const h = s / 2;
    if (k === 0) {
      return;                                                     // nothing: deep dark sea
    } else if (k === 1) {
      c.beginPath(); c.arc(x, y, s * 0.09, 0, 6.2832); c.fill();   // speck
    } else if (k === 2) {
      c.beginPath(); c.arc(x, y, s * 0.2, 0, 6.2832); c.fill();    // dot
    } else if (k === 3) {
      const w = Math.max(1, s * 0.16);                             // plus
      c.fillRect(x - h * 0.8, y - w / 2, s * 0.8, w);
      c.fillRect(x - w / 2, y - h * 0.8, w, s * 0.8);
    } else if (k === 4) {
      c.lineWidth = Math.max(1, s * 0.13);                         // ring
      c.beginPath(); c.arc(x, y, h * 0.62, 0, 6.2832); c.stroke();
    } else if (k === 5) {
      c.beginPath();                                               // diamond
      c.moveTo(x, y - h * 0.82); c.lineTo(x + h * 0.82, y); c.lineTo(x, y + h * 0.82); c.lineTo(x - h * 0.82, y);
      c.closePath(); c.fill();
    } else if (k === 6) {
      c.lineWidth = Math.max(1, s * 0.12);                         // ring with a dot
      c.beginPath(); c.arc(x, y, h * 0.72, 0, 6.2832); c.stroke();
      c.beginPath(); c.arc(x, y, h * 0.26, 0, 6.2832); c.fill();
    } else if (k === 7) {
      const lh = Math.max(1, s * 0.15);                            // striped square
      for (let i = 0; i < 3; i++) c.fillRect(x - h * 0.84, y - h * 0.84 + i * (s * 0.84 - lh) / 2, s * 0.84, lh);
    } else if (k === 8) {
      c.lineWidth = Math.max(1, s * 0.12);                         // square in a square
      c.strokeRect(x - h * 0.78, y - h * 0.78, s * 0.78, s * 0.78);
      c.fillRect(x - h * 0.32, y - h * 0.32, s * 0.32, s * 0.32);
    } else {
      c.fillRect(x - h * 0.86, y - h * 0.86, s * 0.86, s * 0.86); // solid square
    }
  };

  const buildAtlas = () => {
    const px = Math.ceil(cell * DPR);
    atlas = document.createElement('canvas');
    atlas.width = px * N_SHAPES;
    atlas.height = px * COLOURS.length;
    const a = atlas.getContext('2d');
    for (let ci = 0; ci < COLOURS.length; ci++) {
      for (let k = 0; k < N_SHAPES; k++) {
        drawGlyph(a, k, k * px + px / 2, ci * px + px / 2, px * 0.92, COLOURS[ci]);
      }
    }
  };

  /* ---------- layout ---------- */
  const resize = () => {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    cell = Math.max(8, Math.min(13, Math.round(W / 150)));
    cols = Math.ceil(W / cell);
    rows = Math.ceil(H / cell);
    sample = document.createElement('canvas');
    sample.width = cols;
    sample.height = rows;
    sctx = sample.getContext('2d', { willReadFrequently: true });
    rnd = new Float32Array(cols * rows);
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.random();
    buildAtlas();
  };
  window.addEventListener('resize', resize);
  resize();

  // Crop the 16:9 clip to cover any screen shape, like CSS object-fit: cover.
  const coverRect = (vw, vh, w, h) => {
    const s = Math.max(w / vw, h / vh);
    // lift the frame a little so the ship sits above the headline
    const sh = Math.min(h * 0.07, (vh * s - h) / 2 + h * 0.07);
    return [(w - vw * s) / 2, (h - vh * s) / 2 - sh, vw * s, vh * s];
  };

  /* ---------- helpers ---------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const ease = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const wave = (x, y, t, f, s) =>
    Math.sin(x * f + t * s) + Math.sin(y * f * 1.3 - t * s * 0.8) +
    Math.sin((x + y) * f * 0.7 + t * s * 0.6) + Math.sin((x - y) * f * 0.9 - t * s * 0.5);

  /* ---------- the frame ---------- */
  const REVEAL_AT = 1.6, REVEAL_FOR = 2.6;

  const frame = now => {
    const t = (now - t0) / 1000;
    const ready = video.readyState >= 2 && video.videoWidth > 0;

    // smooth the cursor lens in and out
    mouse.s += ((mouse.x > -999 ? 1 : 0) - mouse.s) * 0.12;

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    // How far the footage has opened. Radius is in "ellipse units": wider than tall,
    // because the ship runs across the frame.
    const halfDiag = Math.hypot(W * 0.5 * 0.62, H * 0.5);
    let open = ease((t - REVEAL_AT) / REVEAL_FOR) * (0.66 + 0.025 * Math.sin(t * 0.5));
    if (leaving) open *= 1 - ease((now - leaving) / 850);
    const R = open * halfDiag;
    const band = 0.3 * halfDiag;
    // the scan edge is bright while it moves, then calms down once the reveal settles
    const frontK = 0.12 + 0.88 * (1 - smooth(REVEAL_AT + REVEAL_FOR * 0.7, REVEAL_AT + REVEAL_FOR + 1.2, t));

    let lum = null;
    if (ready) {
      const [x, y, w, h] = coverRect(video.videoWidth, video.videoHeight, W, H);
      if (R > 1) ctx.drawImage(video, x, y, w, h);
      // one pixel per cell
      sctx.drawImage(video, x / cell, y / cell, w / cell, h / cell);
      lum = sctx.getImageData(0, 0, cols, rows).data;
    }

    if (!uiShown && t > REVEAL_AT + 0.9) {
      uiShown = true;
      body.classList.add('on');
    }

    const px = Math.ceil(cell * DPR);
    const cx = W / 2, cy = H * 0.43;
    const lensR = 120, lensEdge = 46;

    for (let j = 0; j < rows; j++) {
      const y = j * cell + cell / 2;
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        const x = i * cell + cell / 2;
        const r = rnd[idx];

        // 1. glyphs appear over the first second, in random order
        const appear = clamp((t - r * 1.1) / 0.35, 0, 1);
        if (appear <= 0) continue;

        // 2. the footage opens out from the ship
        const d = Math.hypot((x - cx) * 0.62, y - cy);
        let m = d >= R ? 1 : d > R - band ? (d - (R - band)) / band : 0;
        const front = R > 1 ? frontK * Math.max(0, 1 - Math.abs(d - R) / (band * 0.35)) : 0;   // bright scan edge

        // 3. the lens around the cursor turns footage back into glyphs
        if (mouse.s > 0.01) {
          const dl = Math.hypot(x - mouse.x, y - mouse.y);
          m = Math.max(m, mouse.s * (1 - smooth(lensR - lensEdge, lensR, dl)));
        }
        m *= appear;
        if (m < 0.03) continue;

        // brightness of this cell of the footage (or a soft pattern while it loads)
        let L;
        if (lum) {
          const p = idx * 4;
          L = (0.2126 * lum[p] + 0.7152 * lum[p + 1] + 0.0722 * lum[p + 2]) / 255;
        } else {
          L = 0.12 + 0.05 * wave(i, j, t, 0.12, 0.6);
        }
        L = clamp(L * 1.15 + front * 0.35, 0, 1);

        // shape: brightness picks the ink level, the wave field shifts it a step in place
        const g = wave(i, j, t, 0.09, 0.55);
        let k = Math.floor(L * 11 + g * 0.45 + r * 0.6);
        k = clamp(k, L < 0.07 ? 0 : 1, N_SHAPES - 1);
        if (k === 0) continue;

        // colour: greys by brightness for the sea, white/purple patches on the bright ship
        let ci;
        if (L > 0.5) {
          const cw = wave(i + 300, j - 100, t, 0.05, 0.3);
          ci = GREYS.length + clamp(Math.floor(((cw + 4) / 8) * BRIGHT.length), 0, BRIGHT.length - 1);
        } else {
          ci = clamp(Math.floor(L * 2 * GREYS.length + g * 0.4), 0, GREYS.length - 1);
        }
        if (Math.sin(t * 2.3 + r * 60) > 0.992) ci = GREYS.length;   // the odd glint

        // black out the footage under the glyph, then draw it
        if (R > 1 || mouse.s > 0.01) {
          ctx.globalAlpha = m;
          ctx.fillStyle = '#0a0a0a';
          ctx.fillRect(x - cell / 2, y - cell / 2, cell, cell);
        }
        ctx.globalAlpha = m;
        ctx.drawImage(atlas, k * px, ci * px, px, px, x - cell / 2, y - cell / 2, cell, cell);
      }
    }
    ctx.globalAlpha = 1;

    if (leaving && now - leaving > 950) {
      window.location.href = target;
      return;
    }
    requestAnimationFrame(frame);
  };

  /* ---------- input ---------- */
  cv.addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  cv.addEventListener('pointerleave', () => { mouse.x = -9999; mouse.y = -9999; });

  const enter = e => {
    if (e) {
      e.preventDefault();
      target = e.currentTarget.getAttribute('href') || 'web/';
    }
    if (leaving) return;
    leaving = performance.now();
    body.classList.add('leaving');
  };
  document.querySelectorAll('[data-enter]').forEach(a => a.addEventListener('click', enter));
  window.addEventListener('keydown', e => { if (e.key === 'Enter') enter(); });

  // autoplay needs muted + playsinline; if the browser still blocks it, start on first touch
  video.play().catch(() => {
    const go = () => { video.play(); window.removeEventListener('pointerdown', go); };
    window.addEventListener('pointerdown', go);
  });

  requestAnimationFrame(frame);

  /* ---------- live numbers in the readout ---------- */
  const SERVER = 'https://headway-production-83bb4bd7.up.railway.app';
  const GLYPHS = '#%&*+=<>/\\|0123456789';

  // numbers "decode": random characters that settle into the real value
  const decode = (el, text) => {
    const start = performance.now();
    const step = () => {
      const p = (performance.now() - start) / 700;
      let out = '';
      for (let i = 0; i < text.length; i++) {
        out += p * text.length > i || text[i] === ' ' ? text[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (p < 1) requestAnimationFrame(step);
    };
    step();
  };
  const pct = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)) + '%';
  const set = (id, text) => { const el = document.getElementById(id); if (el) decode(el, text); };

  fetch('data/processed/overview.json').then(r => r.json()).then(o => {
    const cp = name => o.chokepoints.find(c => c.chokepoint === name);
    const suez = cp('Suez Canal'), hormuz = cp('Strait of Hormuz');
    const later = () => {
      if (suez) set('vSuez', pct(suez.pct_vs_2023_precrisis));
      if (hormuz) set('vHormuz', pct(hormuz.pct_vs_2023_precrisis));
      set('vCape', Math.round(o.cape_share.this_week_pct) + '%');
      const d = new Date(o.as_of + 'T00:00:00Z');
      document.getElementById('asof').textContent =
        'PORTWATCH DATA TO ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
    };
    setTimeout(later, (REVEAL_AT + 1.4) * 1000);
  }).catch(() => {});

  fetch(SERVER + '/api/ships?max_age_minutes=45&moving_only=true&limit=20000')
    .then(r => r.json())
    .then(d => {
      const list = Array.isArray(d) ? d : d.ships || [];
      if (list.length) setTimeout(() => set('vShips', list.length.toLocaleString('en-US')), (REVEAL_AT + 1.7) * 1000);
    })
    .catch(() => {});
})();
