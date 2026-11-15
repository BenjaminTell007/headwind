/* The HEADWAY logo: the word in the site's light monospace, white, wide letter
   spacing, no animation. Drawn on a canvas so the existing <canvas> slots keep
   working; it fits the word to whatever size the canvas is.

   HW.glyphLogo is kept as the old name so callers don't need to change. */

(() => {
  const HW = window.HW;
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  HW.drawLogo = (canvas, { colour = '#f2f2f0', bg = null, weight = 300, spacing = 0.42 } = {}) => {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const word = 'HEADWAY';

    // Find the biggest font size where the spaced-out word still fits the canvas.
    let size = H * 0.7;
    const widthAt = px => {
      ctx.font = `${weight} ${px}px ${FONT}`;
      // letter spacing goes between letters, so 6 gaps for 7 letters
      return ctx.measureText(word).width + px * spacing * (word.length - 1);
    };
    while (size > 4 && widthAt(size) > W * 0.98) {
      size -= 0.5;
    }

    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.clearRect(0, 0, W, H);
    }

    // Draw letter by letter so the spacing is exact in every browser.
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = colour;
    ctx.textBaseline = 'middle';
    let x = (W - widthAt(size)) / 2;
    for (const letter of word) {
      ctx.fillText(letter, x, H / 2);
      x += ctx.measureText(letter).width + size * spacing;
    }
  };

  // Old name, same call shape as before: HW.glyphLogo(canvas, {bg}). Returns {stop}.
  HW.glyphLogo = (canvas, opts = {}) => {
    HW.drawLogo(canvas, { bg: opts.bg || null });
    return { stop() {} };
  };
})();
