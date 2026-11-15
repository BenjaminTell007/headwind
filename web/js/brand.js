/* The brand on every page: one HEADWAY wordmark (Unbounded Light, widely spaced,
   off-white with a slow light sweep in the accent blue), used in the top-left logo, on
   the landing page and on one shared loading screen.

   Needs js/util.js and js/logo.js loaded first (HW.glyphIntro is the animated word).

   - Logo: every `.brand` link (map page, markets page) and the landing header's `.logo`
     get a small canvas running the glyph animation. Hovering it speeds it up a little.
   - Loader: one look everywhere. The map page's #intro and the landing's #loader are
     restyled into it; any page with <body data-hw-loader> gets one injected, which
     hides itself once the page has loaded (at least 3.5 s, at most 9 s).
     Pages can drive it with HW.loader.set(fraction, message) and HW.loader.done(). */

(() => {
  const HW = window.HW = window.HW || {};

  /* ---------- shared styles, injected so every page looks the same ---------- */
  // the wordmark's typeface (Unbounded, SIL Open Font Licence, from Google Fonts)
  if (!document.querySelector('link[data-hw-font]')) {
    const f = document.createElement('link');
    f.rel = 'stylesheet'; f.dataset.hwFont = '1';
    f.href = 'https://fonts.googleapis.com/css2?family=Unbounded:wght@300&display=block';
    document.head.appendChild(f);
  }
  const css = `
  .hw-wordmark { display:inline-block; font-family:'Unbounded', ui-sans-serif, system-ui, sans-serif; font-weight:300; text-transform:uppercase;
    letter-spacing:.3em; padding-left:.3em; line-height:1; white-space:nowrap; text-decoration:none;
    background:linear-gradient(100deg, #f2f2f0 0%, #f2f2f0 38%, #a9c8ff 47%, #4c8dff 50%, #a9c8ff 53%, #f2f2f0 62%, #f2f2f0 100%);
    background-size:320% 100%; background-position:100% 0; -webkit-background-clip:text; background-clip:text; color:transparent;
    animation:hw-sweep 7s cubic-bezier(.45,0,.2,1) infinite; }
  @keyframes hw-sweep { 0% { background-position:100% 0; } 55%, 100% { background-position:0% 0; } }
  /* one weight (300) and one letter-spacing (.3em) at every size */
  .hw-wordmark.sm { font-size:21px; }
  .hw-wordmark.lg { font-size:clamp(44px, 8.4vw, 132px); }
  @media (max-width: 820px) { .hw-wordmark.sm { font-size:15px; } }
  /* colour pixels over the letters: a second copy of the word, filled with a tile of scattered
     vessel-coloured squares that jumps in steps, so pixels flicker in place inside the strokes */
  .hw-wordmark { position:relative; }
  .hw-wordmark::after { content:'HEADWAY'; position:absolute; left:0; top:0; padding-left:inherit; white-space:nowrap; pointer-events:none;
    background-image:var(--hw-px); background-size:96px 96px; -webkit-background-clip:text; background-clip:text; color:transparent;
    animation:hw-px 3.2s steps(8) infinite; }
  .hw-wordmark.sm::after { background-size:36px 36px; }
  @keyframes hw-px { to { background-position:96px 192px; } }
  @media (prefers-reduced-motion: reduce) { .hw-wordmark, .hw-wordmark::after { animation:none; background-position:0 0; } }
  .hw-loader { position:fixed; inset:0; z-index:60; background:#0a0a0a; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:22px; transition:opacity .9s ease, visibility .9s; }
  .hw-loader.done, .hw-loader.out { opacity:0; visibility:hidden; pointer-events:none; }
  .hw-loader { gap:30px; }
  .hw-loader .hw-bar { width:min(320px, 64vw); height:1px; background:#2a2a2c; position:relative; overflow:hidden; }
  .hw-loader .hw-bar i { position:absolute; left:0; top:0; bottom:0; width:0; background:#4c8dff; transition:width .35s ease; }
  .hw-loader .hw-row { width:min(320px, 64vw); display:flex; justify-content:space-between; gap:12px; font:300 10.5px/1.3 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing:.2em; text-transform:uppercase; color:#8a8a8a; }
  .hw-loader .hw-row span:first-child { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hw-logo { display:block; width:380px; height:72px; }
  @media (max-width: 1180px) { .hw-logo { width:280px; height:53px; } }
  @media (max-width: 820px) { .hw-logo { width:170px; height:32px; } }
  `;
  // the pixel tile: a 16 x 16 grid where about one cell in six is a vessel colour or the accent blue
  (() => {
    const c = document.createElement('canvas'); c.width = c.height = 96;
    const g = c.getContext('2d'), cols = ['#46b36f', '#f08a3c', '#8f82f2', '#ea86b5', '#e9c84b', '#4c8dff', '#4c8dff'];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (Math.random() > 0.17) continue;
      g.fillStyle = cols[(Math.random() * cols.length) | 0];
      g.fillRect(x * 6, y * 6, 6, 6);
    }
    document.documentElement.style.setProperty('--hw-px', `url(${c.toDataURL()})`);
  })();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------- the logo ---------- */
  const mountLogo = host => {
    if (host.querySelector('.hw-wordmark')) return;
    host.textContent = '';
    const w = document.createElement('span');
    w.className = 'hw-wordmark sm'; w.textContent = 'HEADWAY';
    host.appendChild(w);
  };

  /* ---------- the loader ---------- */
  const MSGS = ['LOADING ROUTES', 'CONNECTING TO LIVE AIS', 'READING PORTWATCH', 'PRICING STRAITS'];
  let L = null;

  // turn an element into the shared loader (keeps any ids pages already use)
  const build = (el, { barId, pctId, msgId } = {}) => {
    el.classList.add('hw-loader');
    // hide whatever the page put in (the map page's old glyph canvas), then add the wordmark,
    // the bar and the status row
    [...el.children].forEach(c => { c.style.display = 'none'; });
    const cv = document.createElement('div');
    cv.className = 'hw-wordmark lg'; cv.textContent = 'HEADWAY';
    el.appendChild(cv);
    const bar = document.createElement('div'); bar.className = 'hw-bar';
    const fill = document.createElement('i'); if (barId) fill.id = barId; bar.appendChild(fill);
    const row = document.createElement('div'); row.className = 'hw-row';
    const msg = document.createElement('span'); if (msgId) msg.id = msgId; msg.textContent = MSGS[0];
    const pct = document.createElement('span'); if (pctId) pct.id = pctId; pct.textContent = '0%';
    row.append(msg, pct);
    el.append(bar, row);
    const anim = null;
    return { el, fill, msg, pct, anim, p: 0, t0: performance.now(), auto: true, finished: false };
  };

  const setP = (p, text) => {
    if (!L) return;
    L.p = Math.max(L.p, Math.min(1, p));
    L.fill.style.width = (L.p * 100).toFixed(0) + '%';
    L.pct.textContent = Math.round(L.p * 100) + '%';
    if (text) L.msg.textContent = text;
  };
  const finish = () => {
    if (!L || L.finished) return;
    L.finished = true;
    setP(1);
    setTimeout(() => {
      L.el.classList.add('done');
      setTimeout(() => { if (L.anim) L.anim.stop(); }, 1000);
    }, 250);
  };
  // without a page telling us progress, creep toward 90% and rotate the messages
  const creep = () => {
    if (!L || L.finished) return;
    const s = (performance.now() - L.t0) / 1000;
    if (L.auto) setP(0.9 * (1 - Math.exp(-s / 1.6)));
    if (L.auto || !L.msgLocked) L.msg.textContent = L.msg.dataset.fixed || MSGS[Math.floor(s / 0.9) % MSGS.length];
    if (L.el.classList.contains('out')) { finish(); return; }   // the map page hides #intro itself
    setTimeout(creep, 120);
  };

  HW.loader = {
    set(p, text) { if (L) { L.auto = false; setP(p, text); } },
    message(text) { if (L) { L.msg.dataset.fixed = text; L.msg.textContent = text; } },
    done: finish,
  };

  /* ---------- wire up whatever this page has ---------- */
  const init = () => {
    document.querySelectorAll('.brand .word, header .logo').forEach(mountLogo);


    const landing = document.getElementById('loader');
    const intro = document.getElementById('intro');
    if (landing) {
      // the landing drives its own progress (video buffering) through these ids
      L = build(landing, { barId: 'lfill', pctId: 'lpct', msgId: 'lmsg' });
      L.auto = false;
    } else if (intro) {
      L = build(intro);
      // the map page writes its status into #introtag; show it on the loader's left
      const tag = document.getElementById('introtag');
      if (tag) {
        const copy = () => { if (tag.textContent) { L.msg.dataset.fixed = tag.textContent.replace(/^SYS\.ROUTES: \d+ · STRAITS: \d+ · /, ''); } };
        new MutationObserver(copy).observe(tag, { childList: true, characterData: true, subtree: true });
      }
      creep();
    } else if (document.body && document.body.hasAttribute('data-hw-loader')) {
      const el = document.createElement('div');
      document.body.appendChild(el);
      L = build(el);
      creep();
      const t0 = performance.now();
      const end = () => setTimeout(finish, Math.max(0, 3500 - (performance.now() - t0)));
      if (document.readyState === 'complete') end(); else window.addEventListener('load', end);
      setTimeout(finish, 9000);
    }
  };
  // scripts sit at the end of <body>, so the page is already there: set up now, before
  // page scripts (like landing.js) look for the loader's ids
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
