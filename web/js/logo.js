/* The HEADWAY glyph-matrix logo (same design as design/logo.html): the word built
   from a grid of small glyphs in the vessel palette, with patches of shape and
   colour shifting in place. Works at any canvas size. */

(() => {
  const HW = window.HW;
  const COLOURS = ['#f08a3c', '#f26b1d', '#8f82f2', '#6f62d8', '#46b36f', '#1f7a45', '#ea86b5', '#e9c84b', '#b39a2a', '#f3d0b4', '#e6f4ec'];
  const wave = (x, y, t, f, s) => Math.sin(x * f + t * s) + Math.sin(y * f * 1.3 - t * s * 0.8) + Math.sin((x + y) * f * 0.7 + t * s * 0.6) + Math.sin((x - y) * f * 0.9 - t * s * 0.5);

  const glyph = (ctx, k, x, y, s, col) => {
    ctx.fillStyle = col; ctx.strokeStyle = col; const h = s / 2;
    switch (k) {
      case 0: ctx.fillRect(x - h, y - h, s, s); break;
      case 1: ctx.beginPath(); ctx.arc(x, y, h, 0, 6.2832); ctx.fill(); break;
      case 2: ctx.lineWidth = Math.max(1.2, s * 0.2); ctx.beginPath(); ctx.arc(x, y, h * 0.78, 0, 6.2832); ctx.stroke(); break;
      case 3: { const w = Math.max(1.4, s * 0.3); ctx.fillRect(x - h, y - w / 2, s, w); ctx.fillRect(x - w / 2, y - h, w, s); break; }
      case 4: ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + h, y); ctx.lineTo(x, y + h); ctx.lineTo(x - h, y); ctx.closePath(); ctx.fill(); break;
      case 5: ctx.beginPath(); ctx.arc(x, y, h * 0.42, 0, 6.2832); ctx.fill(); break;
      case 6: { const lh = Math.max(1, s * 0.16); for (let i = 0; i < 3; i++) ctx.fillRect(x - h, y - h + i * (s - lh) / 2, s, lh); break; }
      case 7: ctx.lineWidth = Math.max(1.1, s * 0.16); ctx.beginPath(); ctx.arc(x, y, h * 0.8, 0, 6.2832); ctx.stroke(); ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ctx.arc(x, y, h * 0.32, 0, 6.2832); ctx.fill(); break;
      default: ctx.lineWidth = Math.max(1.1, s * 0.16); ctx.strokeRect(x - h * 0.85, y - h * 0.85, s * 0.85, s * 0.85); ctx.fillRect(x - h * 0.35, y - h * 0.35, s * 0.35, s * 0.35);
    }
  };

  /* canvas: intrinsic size is the drawing size. step: grid cell in canvas px. */
  HW.glyphLogo = (canvas, { step = 12, bg = '#222222', animate = true } = {}) => {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const c = off.getContext('2d');
    c.fillStyle = '#fff';
    const fontPx = Math.round(H * 0.62);
    c.font = `700 ${fontPx}px "SF Mono", Menlo, Consolas, monospace`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    try { c.letterSpacing = Math.round(fontPx * 0.11) + 'px'; } catch (e) { /* older browsers */ }
    c.fillText('HEADWAY', W / 2 + fontPx * 0.055, H / 2 + fontPx * 0.04);
    const px = c.getImageData(0, 0, W, H).data, cells = [];
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) {
      const a = px[(Math.round(y) * W + Math.round(x)) * 4 + 3];
      if (a > 90) cells.push({ x, y, cov: a / 255, r: Math.random() });
    }
    let raf = 0, stopped = false;
    const draw = now => {
      const t = now / 1000;
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); } else ctx.clearRect(0, 0, W, H);
      for (const cell of cells) {
        const g = wave(cell.x * 12 / step, cell.y * 12 / step, t, 0.011, 0.32);
        const k = Math.floor(((g + 4) / 8) * 9.999 + cell.r * 0.6) % 9;
        const cw = wave(cell.x * 12 / step + 400, cell.y * 12 / step - 200, t, 0.008, 0.22);
        const ci = HW.clamp(Math.floor(((cw + 4) / 8) * COLOURS.length * 0.999), 0, COLOURS.length - 1);
        const sw = wave(cell.x * 12 / step - 300, cell.y * 12 / step + 100, t, 0.02, 0.5);
        const s = step * (0.5 + 0.32 * ((sw + 4) / 8)) * (0.75 + 0.25 * cell.cov);
        glyph(ctx, k, cell.x, cell.y, s, Math.sin(t * 2.1 + cell.r * 40) > 0.985 ? '#ffffff' : COLOURS[ci]);
      }
      if (animate && !stopped) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return { stop() { stopped = true; cancelAnimationFrame(raf); } };
  };
})();
