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
  const video = document.getElementById('vid');     // act 1: the tanker
  const video2 = document.getElementById('vid2');   // act 2: the fleet at anchor
  const body = document.body;

  // Glyph colours. Greys for the sea, white and tanker purple for the ship and wake
  // (the ship in the clip is a tanker, so its hue is the tanker hue).
  const GREYS = ['#1d2024', '#26292e', '#30343a', '#3c4047', '#4b4f56', '#5f6369', '#787b80', '#96989b'];
  // the ship is a tanker, so its bright glyphs mix white with the tanker orange
  const BRIGHT = ['#f2f2f0', '#f08a3c', '#ffffff', '#f26b1d', '#f2f2f0'];
  // a little of the accent blue, only in the glyphs riding on the ships
  const BLUE = ['#4c8dff', '#8fb6ff'];
  // under the cursor the glyphs light up in every vessel colour, like the loading screen
  const VIVID = ['#46b36f', '#f08a3c', '#8f82f2', '#ea86b5', '#e9c84b', '#4c8dff', '#f26b1d', '#6f62d8'];
  const COLOURS = GREYS.concat(BRIGHT, BLUE, VIVID);
  const N_SHAPES = 10;

  let W = 0, H = 0, DPR = 1, cell = 10, cols = 0, rows = 0;
  let atlas = null;           // pre-drawn glyph sprites: [colour][shape]
  let sample = null, sctx = null;
  let rnd = new Float32Array(0);
  const mouse = { x: -9999, y: -9999, s: 0 };
  let t0 = null, leaving = 0, uiShown = false, target = 'web/';

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
  // zoom > 1 pushes in, < 1 pulls back (the edges then fall off into black).
  const coverRect = (vw, vh, w, h, zoom = 1) => {
    const s = Math.max(w / vw, h / vh) * zoom;
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

  // separable box blur: src -> tmp (rows) -> out (columns)
  let lumL = null, blurA = null, blurB = null;
  const boxBlur = (src, tmp, out, w, h, r) => {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * w + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / (2 * r + 1);
        acc += src[y * w + clamp(x + r + 1, 0, w - 1)] - src[y * w + clamp(x - r, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
      }
    }
  };

  /* ---------- the frame ---------- */
  // Act 1: tanker. Glyphs build it, then the footage opens out from the ship.
  // Act 2: at SWITCH_AT the matrix closes over the tanker while the camera pulls back,
  //        then reopens on the fleet at anchor with HEADWAY over route arcs.
  const REVEAL_AT = 1.6, REVEAL_FOR = 2.6;
  // the second act (fleet clip) is switched off: the tanker is the whole landing page
  const SWITCH_AT = Infinity, CLOSE_FOR = 1.0, OPEN2_FOR = 2.8;
  let act = 1;

  const frame = now => {
    if (t0 === null) { requestAnimationFrame(frame); return; }   // still on the loading screen
    const t = (now - t0) / 1000;

    // which act, which clip, how far the footage is open, how zoomed the camera is
    let src = video, open, zoom = 1, cyK = 0.43, ellX = 0.62, frontK;
    if (t < SWITCH_AT) {
      open = ease((t - REVEAL_AT) / REVEAL_FOR) * (0.66 + 0.025 * Math.sin(t * 0.5));
      frontK = 0.12 + 0.88 * (1 - smooth(REVEAL_AT + REVEAL_FOR * 0.7, REVEAL_AT + REVEAL_FOR + 1.2, t));
    } else if (t < SWITCH_AT + CLOSE_FOR) {
      // closing over the tanker while the camera pulls back from it
      const u = (t - SWITCH_AT) / CLOSE_FOR;
      open = 0.66 * (1 - ease(u));
      zoom = 1 - 0.38 * ease(u);
      frontK = 0.6;
    } else {
      // the fleet: start pushed in, keep pulling back as the footage opens
      src = video2;
      const u = (t - SWITCH_AT - CLOSE_FOR) / OPEN2_FOR;
      open = ease(u) * (0.78 + 0.02 * Math.sin(t * 0.45));
      zoom = 1.55 - 0.5 * ease((t - SWITCH_AT - CLOSE_FOR) / 6);
      cyK = 0.5; ellX = 0.5;
      frontK = 0.12 + 0.88 * (1 - smooth(0.7, 1.4, u));
      if (act === 1) {
        act = 2;
        body.classList.add('act2');
        if (video2.paused) video2.play().catch(() => {});
      }
    }
    const ready = src.readyState >= 2 && src.videoWidth > 0;

    // smooth the cursor lens in and out
    // the cursor doesn't open a lens any more; it only colours the glyphs near it
    mouse.h = (mouse.h || 0) + ((mouse.x > -999 ? 1 : 0) - (mouse.h || 0)) * 0.12;
    mouse.s = 0;

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    // Radius is in "ellipse units": wider than tall, because the ship runs across the frame.
    const halfDiag = Math.hypot(W * 0.5 * ellX, H * 0.5);
    if (leaving) open *= 1 - ease((now - leaving) / 850);
    const R = open * halfDiag;
    const band = 0.3 * halfDiag;

    let lum = null;
    if (ready) {
      const [x, y, w, h] = coverRect(src.videoWidth, src.videoHeight, W, H, zoom);
      if (R > 1) {
        ctx.drawImage(src, x, y, w, h);
        // mostly muted: take about half the colour out of the footage
        ctx.globalCompositeOperation = 'saturation';
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      // one pixel per cell (clear first, so a pulled-back frame has black edges)
      sctx.fillStyle = '#000';
      sctx.fillRect(0, 0, cols, rows);
      sctx.drawImage(src, x / cell, y / cell, w / cell, h / cell);
      lum = sctx.getImageData(0, 0, cols, rows).data;
      // Ships stand out from the water around them: compare each cell's brightness with
      // a blurred copy (a box 7 cells wide). Big differences are hulls, decks and wakes.
      if (!lumL || lumL.length !== cols * rows) { lumL = new Float32Array(cols * rows); blurA = new Float32Array(cols * rows); blurB = new Float32Array(cols * rows); }
      for (let q = 0, p = 0; q < cols * rows; q++, p += 4) lumL[q] = (0.2126 * lum[p] + 0.7152 * lum[p + 1] + 0.0722 * lum[p + 2]) / 255;
      boxBlur(lumL, blurA, blurB, cols, rows, 3);
    }

    if (!uiShown && t > REVEAL_AT + 0.9) {
      uiShown = true;
      body.classList.add('on');
    }

    const px = Math.ceil(cell * DPR);
    const cx = W / 2, cy = H * cyK;
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
        const d = Math.hypot((x - cx) * ellX, y - cy);
        let m = d >= R ? 1 : d > R - band ? (d - (R - band)) / band : 0;
        const front = R > 1 ? frontK * Math.max(0, 1 - Math.abs(d - R) / (band * 0.35)) : 0;   // bright scan edge

        // 3. the lens around the cursor turns footage back into glyphs
        if (mouse.s > 0.01) {
          const dl = Math.hypot(x - mouse.x, y - mouse.y);
          m = Math.max(m, mouse.s * (1 - smooth(lensR - lensEdge, lensR, dl)));
        }
        // the glyph pattern rides on the ships, shimmering in place
        let ship = 0;
        if (lumL && R > 1) {
          ship = smooth(0.07, 0.2, Math.abs(lumL[idx] - blurB[idx]));
          m = Math.max(m, ship * 0.85);
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
        if (act === 1 && L > 0.5) {
          const cw = wave(i + 300, j - 100, t, 0.05, 0.3);
          ci = GREYS.length + clamp(Math.floor(((cw + 4) / 8) * BRIGHT.length), 0, BRIGHT.length - 1);
        } else {
          ci = clamp(Math.floor(L * 2 * GREYS.length + g * 0.4), 0, GREYS.length - 1);
        }
        if (Math.sin(t * 2.3 + r * 60) > 0.992) ci = GREYS.length;   // the odd glint
        // on the ships, small patches drift through the accent blue
        if (ship > 0.4 && wave(i + 90, j - 40, t, 0.09, 0.45) > 1.3) ci = GREYS.length + BRIGHT.length + (r > 0.5 ? 1 : 0);
        // near the cursor: patches of every vessel colour, shifting in place (Gaussian falloff)
        if (mouse.h > 0.02) {
          const dx = x - mouse.x, dy = y - mouse.y, d2 = dx * dx + dy * dy;
          if (d2 < 32000 && Math.exp(-d2 / 9000) * mouse.h > 0.25 + 0.5 * r) {
            const cw = wave(i - 200, j + 50, t, 0.13, 0.5);
            ci = GREYS.length + BRIGHT.length + BLUE.length + clamp(Math.floor(((cw + 4) / 8) * VIVID.length), 0, VIVID.length - 1);
            k = Math.max(k, 3);
          }
        }

        // black out the footage under the glyph, then draw it
        if (R > 1) {
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

  /* ---------- loading screen ----------
     Shows how much of the tanker clip has downloaded. The intro starts once the clip
     can play through (or after 9 seconds, whatever happens), so nobody sees half of it. */
  const loader = document.getElementById('loader');
  const lfill = document.getElementById('lfill'), lpct = document.getElementById('lpct'), lmsg = document.getElementById('lmsg');
  const MSGS = ['LOADING FOOTAGE', 'CONNECTING TO LIVE AIS', 'READING PORTWATCH', 'PRICING STRAITS'];
  const shownAt = performance.now();
  let started = false;
  const progress = () => {
    let p = 0;
    try {
      if (video.duration && video.buffered.length) p = video.buffered.end(video.buffered.length - 1) / video.duration;
    } catch (e) { /* not ready yet */ }
    if (video.readyState >= 3) p = Math.max(p, 0.9);
    return clamp(p, 0, 1);
  };
  const begin = () => {
    if (started) return;
    started = true;
    lfill.style.width = '100%';
    lpct.textContent = '100%';
    setTimeout(() => {
      loader.classList.add('done');
      t0 = performance.now();
      video.currentTime = 0;
      video.play().catch(() => {});
    }, 250);
  };
  const tickLoader = () => {
    if (started) return;
    const p = progress(), waited = performance.now() - shownAt;
    lfill.style.width = (p * 100).toFixed(0) + '%';
    lpct.textContent = Math.round(p * 100) + '%';
    lmsg.textContent = MSGS[Math.floor(waited / 900) % MSGS.length];
    if ((video.readyState >= 4 || p >= 0.98) && waited > 3500) begin();
    else if (waited > 10000 && video.readyState >= 2) begin();
    else setTimeout(tickLoader, 120);
  };
  video.addEventListener('canplaythrough', () => { if (performance.now() - shownAt > 3500) begin(); });
  tickLoader();

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
  // run fn a moment after the page text has faded in (after the loading screen and reveal)
  const whenOn = (fn, delay) => { if (body.classList.contains('on')) setTimeout(fn, delay); else setTimeout(() => whenOn(fn, delay), 200); };
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
    whenOn(later, 500);
  }).catch(() => {});

  fetch(SERVER + '/api/ships?max_age_minutes=45&moving_only=true&limit=20000')
    .then(r => r.json())
    .then(d => {
      const list = Array.isArray(d) ? d : d.ships || [];
      if (list.length) whenOn(() => set('vShips', list.length.toLocaleString('en-US')), 800);
    })
    .catch(() => {});
})();
