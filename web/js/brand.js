/* The brand on every page: the same animated, colourful glyph HEADWAY in the top-left
   logo and on one shared loading screen.

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
  const css = `
  .hw-loader { position:fixed; inset:0; z-index:60; background:#0a0a0a; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:22px; transition:opacity .9s ease, visibility .9s; }
  .hw-loader.done, .hw-loader.out { opacity:0; visibility:hidden; pointer-events:none; }
  .hw-loader canvas.hw-word { width:min(720px, 82vw); height:auto; aspect-ratio:1360/320; display:block; }
  .hw-loader .hw-bar { width:min(320px, 64vw); height:1px; background:#2a2a2c; position:relative; overflow:hidden; }
  .hw-loader .hw-bar i { position:absolute; left:0; top:0; bottom:0; width:0; background:#4c8dff; transition:width .35s ease; }
  .hw-loader .hw-row { width:min(320px, 64vw); display:flex; justify-content:space-between; gap:12px; font:300 10.5px/1.3 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing:.2em; text-transform:uppercase; color:#8a8a8a; }
  .hw-loader .hw-row span:first-child { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hw-logo { display:block; width:220px; height:42px; }
  @media (max-width: 820px) { .hw-logo { width:150px; height:28px; } }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------- the logo ---------- */
  const mountLogo = host => {
    if (!HW.glyphIntro || host.querySelector('canvas.hw-logo')) return;
    const cv = document.createElement('canvas');
    cv.className = 'hw-logo';
    cv.width = 440; cv.height = 84;             // 2x the shown size; chunky cells so the letters read small
    cv.setAttribute('aria-label', 'Headway');
    host.textContent = '';
    host.appendChild(cv);
    HW.glyphIntro(cv, { step: 5, bg: null });
  };

  /* ---------- the loader ---------- */
  const MSGS = ['LOADING ROUTES', 'CONNECTING TO LIVE AIS', 'READING PORTWATCH', 'PRICING STRAITS'];
  let L = null;

  // turn an element into the shared loader (keeps any ids pages already use)
  const build = (el, { barId, pctId, msgId } = {}) => {
    el.classList.add('hw-loader');
    let cv = el.querySelector('canvas');
    if (!cv) { cv = document.createElement('canvas'); el.prepend(cv); }
    cv.classList.add('hw-word');
    cv.width = 1360; cv.height = 320;
    // drop anything that isn't the canvas, then add the bar and the status row
    [...el.children].forEach(c => { if (c !== cv) c.style.display = 'none'; });
    const bar = document.createElement('div'); bar.className = 'hw-bar';
    const fill = document.createElement('i'); if (barId) fill.id = barId; bar.appendChild(fill);
    const row = document.createElement('div'); row.className = 'hw-row';
    const msg = document.createElement('span'); if (msgId) msg.id = msgId; msg.textContent = MSGS[0];
    const pct = document.createElement('span'); if (pctId) pct.id = pctId; pct.textContent = '0%';
    row.append(msg, pct);
    el.append(bar, row);
    // the map page's main.js already animates its own #introcv, so don't start a second one
    const anim = cv.id !== 'introcv' && HW.glyphIntro ? HW.glyphIntro(cv, { step: 12, bg: '#0a0a0a' }) : null;
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
