/* Live demo round on the markets page (Ben, Nov 15).

   A strip above the market list: START A DEMO ROUND opens one short market on the
   Singapore gate through the server (POST /api/demo/start). Then it follows the round:
   betting (a countdown and BET ON THIS ROUND, which opens the round's card), counting
   (real cargo ships and tankers crossing, live), settling, and the result. The round is
   also the first card in the Live section, so betting, claiming and My trades work the
   same as for any market. One round runs at a time; the server refuses a second.

   Self-contained: it reads /api/demo and adds its own element above #grid, which
   markets-page.js redraws, so nothing here touches that file. */
(() => {
  const SERVER = location.search.includes('local') ? 'http://localhost:8787' : 'https://headway-production-83bb4bd7.up.railway.app';
  const STEPS = ['betting', 'counting', 'settling', 'settled'];
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const style = document.createElement('style');
  style.textContent = `
    .dr { margin:6px 0 18px; padding:16px 18px; border:1px solid var(--line2, #2a2a2c); border-radius:14px; background:var(--glass, rgba(18,18,20,.86)); display:grid; grid-template-columns:1fr auto; gap:6px 24px; align-items:center; }
    .dr .dr-tag { color:var(--dim); font:11px/1.3 var(--mono); letter-spacing:.16em; text-transform:uppercase; }
    .dr .dr-tag b { color:var(--accent); font-weight:400; }
    .dr .dr-q { font:15px/1.4 var(--sans); color:var(--fg); margin-top:4px; }
    .dr .dr-sub { color:var(--dim); font:12px/1.4 var(--sans); margin-top:4px; }
    .dr .dr-right { display:flex; align-items:center; gap:18px; }
    .dr .dr-clock { font:500 30px/1 var(--sans); color:var(--accent); font-variant-numeric:tabular-nums; min-width:3.2em; text-align:right; }
    .dr .dr-steps { grid-column:1 / -1; display:flex; gap:6px; margin-top:8px; }
    .dr .dr-steps div { flex:1; }
    .dr .dr-steps i { display:block; height:3px; border-radius:2px; background:var(--line2, #2a2a2c); }
    .dr .dr-steps i.on { background:var(--accent); }
    .dr .dr-steps span { display:block; margin-top:5px; color:var(--dim); font:10px/1 var(--mono); letter-spacing:.14em; text-transform:uppercase; }
    .dr button { font:12px/1 var(--mono); letter-spacing:.14em; padding:11px 16px; border-radius:10px; border:1px solid var(--accent); background:var(--accent); color:var(--on-accent, #fff); cursor:pointer; white-space:nowrap; }
    .dr button.ghost { background:transparent; color:var(--accent); }
    .dr button:disabled { opacity:.5; cursor:default; }
    .dr .dr-err { grid-column:1 / -1; color:#f08a3c; font:12px/1.4 var(--sans); }
    @media (max-width:640px) { .dr { grid-template-columns:1fr; } .dr .dr-right { justify-content:space-between; } }`;
  document.head.appendChild(style);

  const box = document.createElement('section');
  box.className = 'dr';
  box.setAttribute('aria-label', 'Live demo round');
  let round = null, skew = 0, err = '', busy = false;

  const left = iso => {
    const s = Math.max(0, Math.round((Date.parse(iso) - (Date.now() + skew)) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  const paint = () => {
    const r = round, ph = r ? r.phase : null, at = STEPS.indexOf(ph);
    let tag, q, sub, clock = '', action = '';
    if (!r || ph === 'settled') {
      tag = '<b>●</b> Live demo round';
      q = r ? `Last round: ${esc(r.outcome || '')}, ${r.value} of ${r.threshold} crossed. ${esc(r.question)}` :
        'Bet on real ships crossing the Singapore Strait, then watch the round settle onchain in about five minutes.';
      sub = r ? 'Winners can claim in My trades. Start another any time.' :
        '2 minutes to bet, 3 minutes counting cargo ships and tankers from the live AIS feed, settled on Monad about 30 seconds later.';
      action = `<button id="drGo" ${busy ? 'disabled' : ''}>${busy ? 'OPENING…' : 'START A DEMO ROUND'}</button>`;
    } else if (ph === 'betting') {
      tag = '<b>●</b> Demo round · betting open';
      q = esc(r.question);
      sub = `Starting odds ${Math.round(r.prior_yes * 100)}% yes, from this gate's pace over the last hour (${r.ships_per_hour} ships an hour). Market #${r.market_id}.`;
      clock = left(r.bet_closes);
      action = '<button id="drBet">BET ON THIS ROUND</button>';
    } else if (ph === 'counting') {
      tag = '<b>●</b> Demo round · counting ships';
      q = esc(r.question);
      sub = `${r.count_so_far == null ? '—' : r.count_so_far} of ${r.threshold} crossed so far. Betting is closed.`;
      clock = left(r.count_end);
      action = '<button class="ghost" id="drBet">SEE THE CARD</button>';
    } else {
      tag = '<b>●</b> Demo round · settling onchain';
      q = esc(r.question);
      sub = `Final count ${r.count_so_far == null ? '—' : r.count_so_far} of ${r.threshold}. The server is posting it to the contract.`;
      clock = '…';
    }
    box.innerHTML = `
      <div><div class="dr-tag">${tag}</div><div class="dr-q">${q}</div><div class="dr-sub">${sub}</div></div>
      <div class="dr-right">${clock ? `<div class="dr-clock">${clock}</div>` : ''}${action}</div>
      ${r ? `<div class="dr-steps">${STEPS.map((s, i) => `<div><i class="${at >= i ? 'on' : ''}"></i><span>${s}</span></div>`).join('')}</div>` : ''}
      ${err ? `<div class="dr-err">${esc(err)}</div>` : ''}`;
  };

  const poll = async () => {
    try {
      const d = await (await fetch(SERVER + '/api/demo')).json();
      round = d.round;
      if (round && round.now) skew = Date.parse(round.now) - Date.now();
      if (!d.keeper_running && !round) err = 'Demo rounds need the keeper, which is not running on this server.';
    } catch { /* server unreachable: keep the last state */ }
    paint();
  };

  // Open the round's card (its drawer has the bet box), or scroll to it.
  const openCard = () => {
    const card = document.querySelector('#grid article[data-id^="demo_"]');
    if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.click(); return; }
    const live = document.querySelector('#tabs [data-t="live"], #tabs [data-t="all"]');
    if (live) live.click();
    setTimeout(() => { const c = document.querySelector('#grid article[data-id^="demo_"]'); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.click(); } }, 400);
  };

  box.addEventListener('click', async e => {
    if (e.target.closest('#drBet')) { openCard(); return; }
    if (!e.target.closest('#drGo') || busy) return;
    busy = true; err = ''; paint();
    try {
      const r = await fetch(SERVER + '/api/demo/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) err = d.detail || `Could not start a round (${r.status}).`;
    } catch (x) { err = 'Could not reach the server.'; }
    busy = false;
    await poll();   // the round's card joins the list on markets-page.js's next refresh (every 15 s)
  });

  const place = () => {
    const grid = $('grid');
    if (!grid) return false;
    grid.parentNode.insertBefore(box, grid);
    return true;
  };
  if (!place()) document.addEventListener('DOMContentLoaded', place);
  paint(); poll();
  setInterval(poll, 3000);
  setInterval(() => { if (round && round.phase !== 'settled') paint(); }, 500);
})();
