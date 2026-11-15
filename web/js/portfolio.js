/* "My trades": the dashboard on the markets page.

   One big number (profit so far), a chart of it over time, and a row per trade showing
   what you paid, what it is worth right now if you cashed out, and how it is moving.
   Live gate trades show the ships crossing against the number you need.

   Shares come from the chain. What they cost comes from ledger.js (this browser's record
   of the trades made here). "Worth now" for an open market is the contract's own sell
   quote, so the profit shown is what you would actually get by cashing out. */

import { loadTrades, recordTrade, loadStore, saveStore, book, useMemory } from './ledger.js';

export function makePortfolio(ctx) {
  const { HW } = ctx, esc = HW.esc, clamp = HW.clamp;
  let rows = [], totals = null, trades = [];
  let computing = false, again = false, timer = 0;
  let odds = null, equity = null, oddsFor = null;   // histories, loaded per wallet
  const prev = {}, mismatch = {};
  let prevTotal = null, shownTotal = null, armed = null, msg = '';

  /* ---------- formatting ---------- */
  const EPS = 0.00005;
  const dir = v => v > EPS ? 'up' : v < -EPS ? 'down' : 'flat';
  const signed = v => (v > EPS ? '+' : v < -EPS ? '−' : '') + Math.abs(v).toFixed(4);
  const arrow = v => ({ up: '▲', down: '▼', flat: '•' })[dir(v)];
  const mon = v => v.toFixed(4) + ' MON';
  const cents = p => Math.round(p * 100) + '¢';
  const pct = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0) + '%';
  const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; };
  const key = h => h.id + ':' + h.side;

  /* the live gate window a market id belongs to, if any */
  const liveFor = id => {
    for (const m of ctx.list()) {
      const L = m.live; if (!L) continue;
      if (L.counting && Number(L.counting.market_id) === id) return { phase: 'counting', count: +L.counting.count_so_far || 0, threshold: +L.counting.threshold || +m.threshold, end: Date.parse(L.counting.window_end) };
      if (L.trading && Number(L.trading.market_id) === id) return { phase: 'waiting', start: Date.parse(L.trading.window_start), threshold: +m.threshold };
    }
    return null;
  };

  /* ---------- work out every row ---------- */
  async function compute() {
    const chain = ctx.chain();
    if (!chain || !chain.wallet) { rows = []; totals = null; ctx.changed(); return; }
    if (computing) { again = true; return; }
    computing = true;
    try {
      const addr = chain.wallet.address, mk = chain.mk, O = mk.OUTCOME, num = w => Number(mk.formatMon(w, 6)), now = Date.now();
      if (oddsFor !== addr) { odds = loadStore('odds', addr) || {}; equity = loadStore('equity', addr) || []; oddsFor = addr; }

      const collect = () => {
        const out = [];
        for (const c of ctx.onchain()) {
          const p = ctx.pos[Number(c.id)]; if (!p) continue;
          for (const side of ['yes', 'no']) if (p[side] > 0n) {
            const win = !c.resolved ? null : c.outcome === O.YES ? side === 'yes' : c.outcome === O.NO ? side === 'no' : 'void';
            out.push({ c, id: Number(c.id), side, wei: p[side], shares: num(p[side]), win,
              price: win === null ? (side === 'yes' ? c.probYes : 1 - c.probYes) : win === 'void' ? 0.5 : win ? 1 : 0 });
          }
        }
        return out;
      };
      let held = collect();

      /* Make the cost record agree with the chain. Shares that are in the wallet but not in the
         record (bought somewhere else) are booked at the price now and marked as estimated.
         Only after the difference has held for two looks and a fresh read, and never while one
         of our own trades is still landing. */
      trades = loadTrades(addr);
      let b = book(trades);
      if (!ctx.busy()) {
        const have = k => (b.get(k) || { shares: 0 }).shares;
        const off = held.filter(h => Math.abs(h.shares - have(key(h))) > 1e-5);
        for (const k of Object.keys(mismatch)) if (!off.some(h => key(h) === k)) delete mismatch[k];
        let fixed = false;
        for (const h of off) {
          const k = key(h), m0 = mismatch[k];
          if (!m0) { mismatch[k] = now; continue; }
          if (now - m0 < 10000) continue;
          try { const p = await chain.m.position(h.c.id, addr); ctx.pos[h.id] = { yes: p.yes, no: p.no }; } catch { continue; }
          const fresh = num(ctx.pos[h.id][h.side]), diff = fresh - have(k);
          if (diff > 1e-5) trades = recordTrade(addr, { kind: 'seen', est: true, id: h.id, side: h.side, q: h.c.question, shares: diff, mon: diff * h.price });
          else if (diff < -1e-5) trades = recordTrade(addr, { kind: 'sell', est: true, id: h.id, side: h.side, q: h.c.question, shares: -diff, mon: -diff * h.price });
          delete mismatch[k]; fixed = true;
        }
        if (fixed) { b = book(trades); held = collect(); }
      }

      const balance = await chain.wallet.balance().then(num).catch(() => null);
      await Promise.all(held.map(async h => {
        const c = h.c, e = b.get(key(h)) || { cost: 0, shares: 0, est: true };
        // the record can briefly hold more or fewer shares than the chain: cost follows the shares held
        // (shares with no recorded cost yet count at today's price, so they show no profit or loss)
        h.cost = (e.shares > 1e-9 ? e.cost * Math.min(1, h.shares / e.shares) : 0) + Math.max(0, h.shares - e.shares) * h.price;
        h.est = !!e.est || h.shares - e.shares > 1e-5;
        h.entry = h.shares > 0 ? h.cost / h.shares : 0;
        if (h.win !== null) { h.state = h.win === 'void' ? 'void' : h.win ? 'won' : 'lost'; h.value = h.shares * h.price; }
        else if (c.open && c.closeTime * 1000 > now) {
          h.state = 'open';
          try { h.value = num(await chain.m.quoteSell(c.id, h.side === 'yes', h.wei)); } catch { h.value = h.shares * h.price; }
        } else { h.state = 'locked'; h.value = h.shares * h.price; }
        h.pnl = h.value - h.cost;
        h.pct = h.cost > 1e-9 ? h.pnl / h.cost : null;
        h.live = h.state === 'won' || h.state === 'lost' || h.state === 'void' ? null : liveFor(h.id);
        const p0 = prev[key(h)];
        h.tick = p0 == null ? '' : h.pnl - p0 > EPS ? 'up' : h.pnl - p0 < -EPS ? 'down' : '';
        if (h.tick) h.tickAt = now;
        prev[key(h)] = h.pnl;
      }));

      const active = held.filter(h => h.state === 'open' || h.state === 'locked');
      const rank = h => ({ open: 0, locked: 0, won: 1, void: 1, lost: 2 })[h.state];
      held.sort((a, c) => rank(a) - rank(c) || (c.live ? 1 : 0) - (a.live ? 1 : 0) || a.c.closeTime - c.c.closeTime || a.id - c.id);
      const realized = [...b.values()].reduce((a, e) => a + e.realized, 0);
      const staked = trades.reduce((a, t) => a + (t.kind === 'buy' || t.kind === 'seen' ? t.mon : 0), 0);
      const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
      const pnl = realized + sum(held, h => h.pnl);
      rows = held;
      totals = {
        pnl, staked, balance, pct: staked > 1e-9 ? pnl / staked : null,
        worth: sum(active, h => h.value), putIn: sum(active, h => h.cost),
        toClaim: sum(held.filter(h => h.state === 'won' || h.state === 'void'), h => h.value),
        ifAllWin: sum(active, h => h.shares - h.cost), count: active.length,
        est: held.some(h => h.est),
      };

      /* history, so the lines have something to draw */
      for (const h of active) {
        const a = odds[h.id] = odds[h.id] || [], last = a[a.length - 1], p = +h.c.probYes.toFixed(4);
        if (!last || Math.abs(last[1] - p) >= 0.002 || now - last[0] > 60000) { a.push([now, p]); if (a.length > 240) a.splice(0, a.length - 240); }
      }
      for (const id of Object.keys(odds)) if (!held.some(h => h.id === +id)) delete odds[id];
      saveStore('odds', addr, odds);
      if (staked > 0) {
        if (ctx.sample && equity.length < 2) equity = madeUpPath(pnl, now);
        const last = equity[equity.length - 1];
        if (!last || Math.abs(last[1] - pnl) >= EPS || now - last[0] > 60000) { equity.push([now, +pnl.toFixed(5)]); if (equity.length > 720) equity.splice(0, equity.length - 720); }
        saveStore('equity', addr, equity);
      }
    } catch (e) { console.warn('portfolio', e); }
    computing = false;
    ctx.changed();
    if (again) { again = false; schedule(); }
  }
  const schedule = (ms = 350) => { clearTimeout(timer); timer = setTimeout(compute, ms); };

  /* ---------- small charts ---------- */
  const line = (pts, w, h, { base, colour, fill = false } = {}) => {
    if (pts.length < 2) return '';
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]).concat(base != null ? [base] : []);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1e-6, pad = 4;
    const X = t => (t - x0) / (x1 - x0 || 1) * w, Y = v => pad + (1 - (v - lo) / span) * (h - 2 * pad);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
    const lastP = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      ${fill && base != null ? `<path d="${d}L${w} ${Y(base).toFixed(1)}L0 ${Y(base).toFixed(1)}Z" fill="${colour}" opacity=".12"/>` : ''}
      ${base != null ? `<line x1="0" x2="${w}" y1="${Y(base).toFixed(1)}" y2="${Y(base).toFixed(1)}" stroke="var(--dim)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>` : ''}
      <path d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${X(lastP[0]).toFixed(1)}" cy="${Y(lastP[1]).toFixed(1)}" r="3" fill="${colour}" class="pf-dot"/></svg>`;
  };
  const colourOf = v => `var(--${dir(v) === 'down' ? 'down' : dir(v) === 'up' ? 'up' : 'dim'})`;
  const rowSpark = h => {
    // the price of YOUR side over time, so up is always good; the dashed line is what you paid
    let pts = (odds[h.id] || []).map(([t, p]) => [t, h.side === 'yes' ? p : 1 - p]);
    if (pts.length < 2) pts = [[Date.now() - 60000, h.entry || h.price], [Date.now(), h.price]];
    return line(pts, 150, 44, { base: h.entry || null, colour: colourOf(h.pnl) });
  };
  function madeUpPath(end, now) {   // sample mode only: a believable two hours ending at today's number
    const r = HW.rng(23), out = []; let v = 0;
    for (let i = 0; i < 48; i++) { v += (r() - 0.5) * 0.004; out.push([now - (48 - i) * 150000, +(v * (1 - i / 47) + end * (i / 47)).toFixed(5)]); }
    return out;
  }

  /* ---------- the page ---------- */
  const liveBlock = h => {
    const L = h.live; if (!L) return '';
    if (L.phase === 'waiting') return `<div class="pr-live"><span class="tag">COUNTING STARTS <span data-end="${L.start}">${ctx.left(L.start).replace(' LEFT', '')}</span> FROM NOW · NEEDS ${L.threshold} SHIPS</span></div>`;
    const need = Math.max(0, L.threshold - L.count), yes = h.side === 'yes', done = L.count >= L.threshold;
    const word = yes ? (done ? 'YOU HAVE ENOUGH SHIPS' : `NEEDS ${need} MORE`) : (done ? 'TOO MANY SHIPS CROSSED' : `HOLDS IF FEWER THAN ${L.threshold} CROSS`);
    return `<div class="pr-live"><div class="pr-meter ${done === yes ? 'good' : done ? 'bad' : ''}"><i style="width:${clamp(L.count / L.threshold * 100, 0, 100).toFixed(1)}%"></i></div>
      <span class="tag"><b>${L.count}</b> OF ${L.threshold} SHIPS · ${word} · <span data-end="${L.end}">${ctx.left(L.end)}</span></span></div>`;
  };
  const rowHtml = h => {
    const c = h.c, k = key(h), d = dir(h.pnl), flash = h.tick && Date.now() - h.tickAt < 1600 ? ' tick-' + h.tick : '';
    const isArmed = armed && armed.k === k && Date.now() - armed.t < 6000;
    const status = { open: `<span class="tag" data-end="${c.closeTime * 1000}">${ctx.left(c.closeTime * 1000)}</span>`, locked: '<span class="tag">TRADING CLOSED · WAITING FOR THE RESULT</span>',
      won: '<span class="tag">YOU WON</span>', lost: '<span class="tag">SETTLED AGAINST YOU</span>', void: '<span class="tag">MARKET VOIDED · HALF BACK</span>' }[h.state];
    const act = h.state === 'open' ? `<button data-act="cash" class="${isArmed ? 'armed' : ''}">${isArmed ? 'CONFIRM · ' + h.value.toFixed(4) : 'CASH OUT'}</button><button data-act="add">ADD MORE</button>`
      : h.state === 'won' || h.state === 'void' ? `<button data-act="claim" class="claim">CLAIM ${h.value.toFixed(4)}</button>` : '';
    const worth = h.state === 'won' || h.state === 'void' ? 'READY TO CLAIM' : h.state === 'lost' ? 'WORTH NOTHING NOW' : 'WORTH ' + h.value.toFixed(4) + ' NOW';
    return `<article class="pr ${d} st-${h.state}" data-chain="${h.id}" data-side="${h.side}">
      <div class="pr-main">
        <div class="pr-top"><span class="chip ${h.side}">${h.side.toUpperCase()}</span>${status}</div>
        <div class="pr-q">${esc(c.question)}</div>
        ${liveBlock(h)}
        <div class="pr-sub">${h.shares.toFixed(3)} shares · paid ${h.cost > 0 ? cents(h.entry) : '—'} each${h.state === 'open' || h.state === 'locked' ? ` · now ${cents(h.price)} · pays ${h.shares.toFixed(4)} MON if right` : ''}${h.est ? ' · cost estimated' : ''}</div>
      </div>
      <div class="pr-spark">${h.state === 'open' || h.state === 'locked' ? rowSpark(h) : ''}</div>
      <div class="pr-pnl${flash}"><b>${signed(h.pnl)}</b><span>${arrow(h.pnl)} ${h.pct != null ? pct(h.pct).replace(/^[+−]/, '') : ''}</span><small>${worth}</small></div>
      <div class="pr-act">${act}</div>
    </article>`;
  };
  const activity = chain => {
    const real = trades.filter(t => !t.est).slice(-8).reverse(); if (!real.length) return '';
    const verb = t => t.kind === 'buy' ? `Bought ${t.shares.toFixed(3)} ${String(t.side).toUpperCase()}` : t.kind === 'sell' ? `Cashed out ${t.shares.toFixed(3)} ${String(t.side).toUpperCase()}` : 'Claimed winnings';
    return `<h2 class="pf-h">RECENT ACTIVITY</h2><div class="pf-feed">${real.map(t => `<div class="pf-item">
      <span class="what ${t.kind}">${verb(t)}</span><span class="q">${esc(t.q || 'Market #' + t.id)}</span>
      <span class="amt">${t.kind === 'buy' ? '−' : '+'}${(+t.mon).toFixed(4)} MON</span><span class="when">${ago(t.t)}${t.tx && chain.cfg ? ` · <a href="${chain.cfg.txUrl(t.tx)}" target="_blank" rel="noopener">tx</a>` : ''}</span></div>`).join('')}</div>`;
  };
  const starter = text => {
    const picks = ctx.list().filter(m => m.chainId != null && m.chain && m.chain.outcome == null && Date.parse(m.closes) > Date.now()).slice(0, 3);
    return `<div class="pf-empty"><div class="pf-big flat">0.0000 MON</div><p>${text}</p>
      ${picks.length ? `<div class="pf-picks">${picks.map(m => `<button data-go="${esc(m.id)}"><span>${esc(m.question)}</span><b>${Math.round((m.probYes ?? 0.5) * 100)}% YES →</b></button>`).join('')}</div>` : ''}</div>`;
  };

  function html() {
    const chain = ctx.chain();
    if (!chain) return '<div class="mk-empty">Loading…</div>';
    if (!chain.wallet) return `<div class="pf-empty"><p>Your trades show up here, with what each one is worth right now.</p><div class="pf-picks one"><button data-act="connect"><span>Connect your wallet to see them</span><b>CONNECT →</b></button></div></div>`;
    if (!totals) return '<div class="mk-empty">Loading your trades…</div>';
    if (!rows.length && !trades.some(t => !t.est)) return starter('No trades yet. Pick a market, take a side, and watch it here.');
    const T = totals, d = dir(T.pnl);
    const live = rows.filter(h => h.state === 'open' || h.state === 'locked'), claim = rows.filter(h => h.state === 'won' || h.state === 'void'), lost = rows.filter(h => h.state === 'lost').slice(-6);
    const chart = equity && equity.length > 1 ? line(equity, 600, 120, { base: 0, colour: colourOf(T.pnl), fill: true }) : '<p class="pf-wait">The chart fills in as prices move.</p>';
    return `${ctx.sample ? '<div class="pf-sample">SAMPLE TRADES · made-up positions on the real markets, to preview this page. Nothing here was bought. Remove “?sample” from the address to see your own.</div>' : ''}
      <section class="pf-hero ${d}">
        <div class="pf-left">
          <div class="tag">YOUR TRADES · PROFIT SO FAR</div>
          <div class="pf-big ${d}" id="pfBig">${signed(T.pnl)} MON</div>
          <div class="pf-pct ${d}">${arrow(T.pnl)} ${T.pct != null ? pct(T.pct).replace(/^[+−]/, '') : '0%'} on ${T.staked.toFixed(4)} MON put in${T.est ? ' · some costs estimated' : ''}</div>
          <div class="pf-win">${T.count ? `If every open trade wins: <b>+${T.ifAllWin.toFixed(4)} MON</b>` : 'No open trades right now.'}</div>
        </div>
        <div class="pf-chart">${chart}</div>
        <div class="pf-stats">
          <div><b>${T.worth.toFixed(4)}</b><span>WORTH NOW · ${T.count} OPEN</span></div>
          <div><b>${T.putIn.toFixed(4)}</b><span>PUT IN</span></div>
          <div><b>${T.toClaim.toFixed(4)}</b><span>READY TO CLAIM</span></div>
          <div><b>${T.balance != null ? T.balance.toFixed(3) : '—'}</b><span>WALLET · MON</span></div>
        </div>
      </section>
      <div class="pf-msg" id="pfMsg">${msg}</div>
      ${claim.length ? `<h2 class="pf-h">READY TO CLAIM</h2>${claim.map(rowHtml).join('')}` : ''}
      ${live.length ? `<h2 class="pf-h">IN PLAY</h2>${live.map(rowHtml).join('')}` : ''}
      ${lost.length ? `<h2 class="pf-h">FINISHED</h2>${lost.map(rowHtml).join('')}` : ''}
      ${activity(chain)}`;
  }

  /* after the HTML is in the page: count the big number up or down to its new value */
  function afterRender() {
    const el = document.getElementById('pfBig'); if (!el || !totals) return;
    const to = totals.pnl, from = shownTotal == null ? to : shownTotal;
    if (prevTotal != null && Math.abs(to - prevTotal) > EPS) { el.classList.add(to > prevTotal ? 'tick-up' : 'tick-down'); }
    prevTotal = to;
    if (Math.abs(to - from) < EPS) { shownTotal = to; return; }
    const t0 = performance.now(), step = now => {
      const k = Math.min(1, (now - t0) / 700), v = from + (to - from) * (1 - Math.pow(1 - k, 3));
      const cur = document.getElementById('pfBig'); if (!cur) return;
      cur.textContent = signed(v) + ' MON'; shownTotal = v;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- sample mode: made-up positions on real markets, to preview the page ---------- */
  function seedSample() {
    const chain = ctx.chain(), mk = chain.mk, addr = '0x5a3b1e0000000000000000000000000000c0ffee', now = Date.now();
    useMemory();
    chain.wallet = { kind: 'sample', address: addr, balance: async () => mk.parseMon('0.171') };
    const all = ctx.onchain(), open = all.filter(c => c.open), closed = all.filter(c => !c.open && !c.resolved), done = all.filter(c => c.resolved);
    const picks = [...open.slice(0, 4).map((c, i) => [c, i % 2 ? 'no' : 'yes', [0.84, 1.3, 0.92, 1.12][i]]), ...closed.slice(-1).map(c => [c, 'yes', 1.06]), ...done.slice(-2).map((c, i) => [c, i ? 'no' : 'yes', 1])];
    const sizes = [0.035, 0.05, 0.02, 0.06, 0.03, 0.04, 0.025], hist = {}, r = HW.rng(5);
    picks.forEach(([c, side, k], i) => {
      const id = Number(c.id), shares = sizes[i], w = mk.parseMon(String(shares));
      ctx.pos[id] = { yes: side === 'yes' ? w : 0n, no: side === 'no' ? w : 0n };
      const price = side === 'yes' ? c.probYes : 1 - c.probYes, entry = c.resolved ? 0.5 : clamp(price * k, 0.04, 0.96), t = now - (140 - i * 19) * 60000;
      recordTrade(addr, { t, kind: 'buy', id, side, q: c.question, shares, mon: shares * entry, tx: null });
      const y0 = side === 'yes' ? entry : 1 - entry, n = 30, a = hist[id] = [];
      for (let j = 0; j < n; j++) a.push([t + (now - t) * j / (n - 1), +clamp(y0 + (c.probYes - y0) * (j / (n - 1)) + (r() - 0.5) * 0.03 * Math.sin(Math.PI * j / (n - 1)), 0.01, 0.99).toFixed(4)]);
    });
    saveStore('odds', addr, hist); saveStore('equity', addr, []);
    oddsFor = null;
  }

  return {
    compute, schedule, html, afterRender, seedSample,
    totals: () => totals, rows: () => rows,
    record(trade) { const chain = ctx.chain(); if (chain && chain.wallet) trades = recordTrade(chain.wallet.address, trade); },
    setMsg(h) { msg = h; const el = document.getElementById('pfMsg'); if (el) el.innerHTML = h; },
    /* cash out takes two clicks: the first shows what you would get */
    arm(k) { const hot = armed && armed.k === k && Date.now() - armed.t < 6000; armed = hot ? null : { k, t: Date.now() }; return hot; },
    row: (id, side) => rows.find(h => h.id === Number(id) && h.side === side),
  };
}
