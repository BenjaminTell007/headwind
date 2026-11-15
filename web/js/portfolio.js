/* "My trades": the dashboard on the markets page.

   Each trade is one row that answers three things in plain words: what you need to happen,
   where it stands right now, and what you win or lose. On top: how your open trades are
   doing since you placed them, what you staked, and what you could win.

   Where the numbers come from
   - Shares come from the chain. What they cost comes from ledger.js (this browser's record
     of the trades made here).
   - "Up or down since you bet" compares the odds now with the price you paid:
     shares x today's price, minus your stake. It is not money you have until the result.
   - "Cash out now" is the contract's own sell quote. It is a little lower than the odds
     suggest, because every trade pays a 1% fee and moves the price. So a brand-new bet
     can be cashed out for slightly less than you put in, even when nothing has changed. */

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
  const pc = p => Math.round(p * 100) + '%';
  const pct = v => Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0) + '%';
  const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; };
  const key = h => h.id + ':' + h.side;
  const clock = ms => new Date(ms).toISOString().slice(11, 16);   // UTC, like the questions

  /* the live gate window a market id belongs to, if any */
  const liveFor = id => {
    for (const m of ctx.list()) {
      const L = m.live; if (!L) continue;
      if (L.counting && Number(L.counting.market_id) === id) return { phase: 'counting', count: +L.counting.count_so_far || 0, threshold: +L.counting.threshold || +m.threshold, start: Date.parse(L.counting.window_start), end: Date.parse(L.counting.window_end) };
      if (L.trading && Number(L.trading.market_id) === id) return { phase: 'waiting', start: Date.parse(L.trading.window_start), end: Date.parse(L.trading.window_end), threshold: +m.threshold };
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
      if (!ctx.busy() && !ctx.sample) {
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

      await Promise.all(held.map(async h => {
        const c = h.c, e = b.get(key(h)) || { cost: 0, shares: 0, est: true };
        // the record can briefly hold more or fewer shares than the chain: cost follows the shares held
        // (shares with no recorded cost yet count at today's price, so they show no profit or loss)
        h.cost = (e.shares > 1e-9 ? e.cost * Math.min(1, h.shares / e.shares) : 0) + Math.max(0, h.shares - e.shares) * h.price;
        h.est = !!e.est || h.shares - e.shares > 1e-5;
        h.entry = h.shares > 0 ? h.cost / h.shares : 0;   // what you paid per share = the chance you bought at
        h.value = h.shares * h.price;                      // at the odds now (or the payout, once settled)
        h.cash = null;                                     // what the contract would pay to sell right now
        if (h.win !== null) h.state = h.win === 'void' ? 'void' : h.win ? 'won' : 'lost';
        else if (c.open && c.closeTime * 1000 > now) {
          h.state = 'open';
          try { h.cash = num(await chain.m.quoteSell(c.id, h.side === 'yes', h.wei)); } catch { /* no quote: leave it out */ }
        } else h.state = 'locked';
        h.pnl = h.value - h.cost;
        h.pct = h.cost > 1e-9 ? h.pnl / h.cost : null;
        h.ifWin = h.shares - h.cost; h.ifLose = -h.cost;
        h.live = h.win !== null ? null : liveFor(h.id);
        h.need = ctx.need(c, h.side, h.live);
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
      const openPnl = sum(active, h => h.pnl);
      rows = held;
      totals = {
        pnl: realized + sum(held, h => h.pnl), openPnl, realized, staked,
        putIn: sum(active, h => h.cost), worth: sum(active, h => h.value),
        pct: sum(active, h => h.cost) > 1e-9 ? openPnl / sum(active, h => h.cost) : null,
        cash: sum(active.filter(h => h.cash != null), h => h.cash), cashCount: active.filter(h => h.cash != null).length,
        toClaim: sum(held.filter(h => h.state === 'won' || h.state === 'void'), h => h.value),
        ifAllWin: sum(active, h => h.ifWin), count: active.length,
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
        if (ctx.sample && equity.length < 2) equity = madeUpPath(openPnl, now);
        const last = equity[equity.length - 1];
        if (!last || Math.abs(last[1] - openPnl) >= EPS || now - last[0] > 60000) { equity.push([now, +openPnl.toFixed(5)]); if (equity.length > 720) equity.splice(0, equity.length - 720); }
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
    // the chance of YOUR side over time, so up is always good; the dashed line is where you bought
    let pts = (odds[h.id] || []).map(([t, p]) => [t, h.side === 'yes' ? p : 1 - p]);
    if (pts.length < 2) pts = [[Date.now() - 60000, h.entry || h.price], [Date.now(), h.price]];
    return line(pts, 150, 36, { base: h.entry || null, colour: colourOf(h.pnl) });
  };
  function madeUpPath(end, now) {   // sample mode only: a believable two hours ending at today's number
    const r = HW.rng(23), out = []; let v = 0;
    for (let i = 0; i < 48; i++) { v += (r() - 0.5) * 0.004; out.push([now - (48 - i) * 150000, +(v * (1 - i / 47) + end * (i / 47)).toFixed(5)]); }
    return out;
  }

  /* ---------- one trade ---------- */
  /* "Right now": for a live gate, the ships counted against the number needed; otherwise the
     chance today against the chance you bought at. */
  const nowBox = h => {
    const L = h.live, yes = h.side === 'yes';
    if (h.state === 'won') return `<b class="good">You were right.</b><p>It settled your way.</p>`;
    if (h.state === 'lost') return `<b class="bad">It went the other way.</b><p>This one settled against you.</p>`;
    if (h.state === 'void') return `<b>The market was voided.</b><p>Half of each share is paid back.</p>`;
    if (L && L.phase === 'counting') {
      const done = L.count >= L.threshold, frac = clamp((Date.now() - L.start) / (L.end - L.start), 0, 1), pace = frac >= 0.15 ? Math.round(L.count / frac) : null;
      const good = done ? yes : pace == null ? null : (pace >= L.threshold) === yes;
      const word = done ? (yes ? 'Enough ships have crossed. You are winning.' : 'Too many ships crossed. This one is lost unless voided.')
        : `${Math.max(0, L.threshold - L.count)} more needed for YES${pace != null ? ` · on pace for about ${pace}` : ''}`;
      return `<b class="${good == null ? '' : good ? 'good' : 'bad'}">${L.count} of ${L.threshold} ships so far</b>
        <div class="pr-meter ${done ? (yes ? 'good' : 'bad') : ''}"><i style="width:${clamp(L.count / L.threshold * 100, 0, 100).toFixed(1)}%"></i></div>
        <p>${word} · <span data-end="${L.end}">${ctx.left(L.end)}</span></p>`;
    }
    const d = dir(h.price - h.entry), moved = h.cost > 0 && Math.abs(h.price - h.entry) >= 0.005;
    const head = `<b class="${d === 'up' ? 'good' : d === 'down' ? 'bad' : ''}">${pc(h.price)} chance you win</b>`;
    const was = h.cost > 0 ? (moved ? `${arrow(h.price - h.entry)} ${d === 'up' ? 'up' : 'down'} from ${pc(h.entry)} when you bet` : `about the same as when you bet (${pc(h.entry)})`) : '';
    const wait = L && L.phase === 'waiting' ? `Ships are counted ${clock(L.start)} to ${clock(L.end)} UTC.` : h.state === 'locked' ? 'Trading has closed. Waiting for the result.' : '';
    return `${head}<div class="pr-spark">${rowSpark(h)}</div><p>${[was, wait].filter(Boolean).join(' · ')}</p>`;
  };
  const rowHtml = h => {
    const c = h.c, k = key(h), flash = h.tick && Date.now() - h.tickAt < 1600 ? ' tick-' + h.tick : '';
    const isArmed = armed && armed.k === k && Date.now() - armed.t < 6000;
    const tone = h.state === 'won' ? 'up' : h.state === 'lost' ? 'down' : h.state === 'void' ? 'flat' : dir(h.pnl);
    const status = { open: `<span class="tag">YOU CAN STILL TRADE · <span data-end="${c.closeTime * 1000}">${ctx.left(c.closeTime * 1000)}</span></span>`, locked: '<span class="tag">LOCKED IN · WAITING FOR THE RESULT</span>',
      won: '<span class="tag">SETTLED · YOU WON</span>', lost: '<span class="tag">SETTLED · YOU LOST</span>', void: '<span class="tag">VOIDED</span>' }[h.state];
    const money = h.state === 'won' || h.state === 'void'
      ? `<div class="m-row big"><span>${h.state === 'won' ? 'You won' : 'Paid back'}</span><b class="${h.pnl >= 0 ? 'good' : 'bad'}">${signed(h.pnl)}</b></div><div class="m-row"><span>To collect</span><b>${h.value.toFixed(4)}</b></div>`
      : h.state === 'lost' ? `<div class="m-row big"><span>You lost</span><b class="bad">${signed(-h.cost)}</b></div>`
      : `<div class="m-row"><span>You staked</span><b>${h.cost.toFixed(4)}</b></div>
         <div class="m-row big"><span>If you win</span><b class="good">+${h.ifWin.toFixed(4)}</b></div>
         <div class="m-row big"><span>If you lose</span><b class="bad">−${h.cost.toFixed(4)}</b></div>`;
    const foot = h.state === 'open'
      ? `<span class="cashline">${h.cash != null ? `Cash out now for <b>${h.cash.toFixed(4)} MON</b> <i class="${dir(h.cash - h.cost)}">(${signed(h.cash - h.cost)} against your stake)</i>` : 'Cash-out price unavailable right now.'}</span>
         <span class="pr-act">${h.cash != null ? `<button data-act="cash" class="${isArmed ? 'armed' : ''}">${isArmed ? 'CONFIRM CASH OUT' : 'CASH OUT'}</button>` : ''}<button data-act="add">ADD MORE</button></span>`
      : h.state === 'won' || h.state === 'void' ? `<span class="cashline">Your payout is waiting.</span><span class="pr-act"><button data-act="claim" class="claim">COLLECT ${h.value.toFixed(4)} MON</button></span>`
      : h.state === 'locked' ? `<span class="cashline">No more trading on this one. It pays out by itself once the result is in.</span>` : '';
    return `<article class="pr ${tone} st-${h.state}" data-chain="${h.id}" data-side="${h.side}">
      <div class="pr-top"><span class="chip ${h.side}">YOU BET ${h.side.toUpperCase()}</span>${status}<span class="tag upd${flash}">${h.state === 'open' || h.state === 'locked' ? `${arrow(h.pnl)} ${signed(h.pnl)} SINCE YOU BET` : ''}</span></div>
      <div class="pr-q">${esc(c.question)}</div>
      <div class="pr-cols">
        <div class="pr-box"><span class="tag">YOU NEED</span><b>${esc(h.need)}</b><p>${h.shares.toFixed(3)} shares${h.est ? ' · cost estimated' : ''}</p></div>
        <div class="pr-box"><span class="tag">RIGHT NOW</span>${nowBox(h)}</div>
        <div class="pr-box money"><span class="tag">YOUR MONEY · MON</span>${money}</div>
      </div>
      ${foot ? `<div class="pr-foot">${foot}</div>` : ''}
    </article>`;
  };
  const activity = chain => {
    const real = trades.filter(t => !t.est).slice(-6).reverse(); if (!real.length) return '';
    const verb = t => t.kind === 'buy' ? `Bet ${String(t.side).toUpperCase()}` : t.kind === 'sell' ? `Cashed out ${String(t.side).toUpperCase()}` : 'Collected winnings';
    return `<h2 class="pf-h">RECENT ACTIVITY</h2><div class="pf-feed">${real.map(t => `<div class="pf-item">
      <span class="what ${t.kind}">${verb(t)}</span><span class="q">${esc(t.q || 'Market #' + t.id)}</span>
      <span class="amt">${t.kind === 'buy' ? '−' : '+'}${(+t.mon).toFixed(4)} MON</span><span class="when">${ago(t.t)}${t.tx && chain.cfg ? ` · <a href="${chain.cfg.txUrl(t.tx)}" target="_blank" rel="noopener">receipt</a>` : ''}</span></div>`).join('')}</div>`;
  };
  const starter = text => {
    const picks = ctx.list().filter(m => m.chainId != null && m.chain && m.chain.outcome == null && Date.parse(m.closes) > Date.now()).slice(0, 3);
    return `<div class="pf-empty"><h2>No trades yet</h2><p>${text}</p>
      ${picks.length ? `<div class="pf-picks">${picks.map(m => `<button data-go="${esc(m.id)}"><span>${esc(m.question)}</span><b>${Math.round((m.probYes ?? 0.5) * 100)}% YES →</b></button>`).join('')}</div>` : ''}</div>`;
  };

  function html() {
    const chain = ctx.chain();
    if (!chain) return `<div class="mk-empty">${ctx.chainDown() ? 'The Monad test network is not answering right now. Trying again every few seconds.' : 'Loading…'}</div>`;
    if (!chain.wallet) return `<div class="pf-empty"><h2>Your trades</h2><p>Each trade you place shows up here with what you need, how it is going, and what you win or lose.</p><div class="pf-picks one"><button data-act="connect"><span>Connect your wallet to see them</span><b>CONNECT →</b></button></div></div>`;
    if (!totals) return '<div class="mk-empty">Loading your trades…</div>';
    if (!rows.length && !trades.some(t => !t.est)) return starter('Pick a market, choose YES or NO, and it will show up here.');
    const T = totals, d = dir(T.openPnl);
    const live = rows.filter(h => h.state === 'open' || h.state === 'locked'), claim = rows.filter(h => h.state === 'won' || h.state === 'void'), lost = rows.filter(h => h.state === 'lost').slice(-4);
    const chart = equity && equity.length > 1 ? line(equity, 600, 110, { base: 0, colour: colourOf(T.openPnl), fill: true }) : '<p class="pf-wait">This line fills in as the odds move.</p>';
    return `${ctx.sample ? '<div class="pf-sample">SAMPLE TRADES · made-up bets on the real markets, to preview this page. Nothing here was bought. Remove “?sample” from the address to see your own.</div>' : ''}
      <section class="pf-hero ${d}">
        <div class="pf-left">
          <div class="tag">${T.count} OPEN ${T.count === 1 ? 'TRADE' : 'TRADES'} · SINCE YOU PLACED ${T.count === 1 ? 'IT' : 'THEM'}</div>
          <div class="pf-big ${d}" id="pfBig">${signed(T.openPnl)} MON</div>
          <div class="pf-pct ${d}">${T.count ? `${arrow(T.openPnl)} ${d === 'flat' ? 'No change' : (d === 'up' ? 'Up ' : 'Down ') + (T.pct != null ? pct(T.pct) : '')} at today's odds${T.est ? ' · some costs estimated' : ''}` : 'Nothing in play right now.'}</div>
          <p class="pf-why">This compares the odds now with the odds when you bet. It only becomes real money when a market settles.</p>
        </div>
        <div class="pf-chart">${chart}</div>
        <div class="pf-stats">
          <div><span>STAKED</span><b>${T.putIn.toFixed(4)}</b><small>what you put in</small></div>
          <div><span>IF THEY ALL WIN</span><b class="good">+${T.ifAllWin.toFixed(4)}</b><small>on top of your stake</small></div>
          <div><span>IF THEY ALL LOSE</span><b class="bad">−${T.putIn.toFixed(4)}</b><small>the most you can lose</small></div>
          <div><span>${T.toClaim > EPS ? 'READY TO COLLECT' : 'CASH OUT ALL NOW'}</span><b>${T.toClaim > EPS ? T.toClaim.toFixed(4) : T.cashCount ? T.cash.toFixed(4) : '—'}</b><small>${T.toClaim > EPS ? 'from trades you won' : 'after fees, for trades still open'}</small></div>
        </div>
      </section>
      <div class="pf-msg" id="pfMsg">${msg}</div>
      ${claim.length ? `<h2 class="pf-h">READY TO COLLECT</h2>${claim.map(rowHtml).join('')}` : ''}
      ${live.length ? `<h2 class="pf-h">OPEN TRADES</h2>${live.map(rowHtml).join('')}` : ''}
      ${lost.length ? `<h2 class="pf-h">FINISHED</h2>${lost.map(rowHtml).join('')}` : ''}
      ${activity(chain)}`;
  }

  /* after the HTML is in the page: count the big number up or down to its new value */
  function afterRender() {
    const el = document.getElementById('pfBig'); if (!el || !totals) return;
    const to = totals.openPnl, from = shownTotal == null ? to : shownTotal;
    if (prevTotal != null && Math.abs(to - prevTotal) > EPS) el.classList.add(to > prevTotal ? 'tick-up' : 'tick-down');
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
    const picks = [...open.slice(0, 3).map((c, i) => [c, i % 2 ? 'no' : 'yes', [0.9, 1.12, 0.95][i]]), ...closed.slice(-1).map(c => [c, 'yes', 1.04]), ...done.slice(-1).map(c => [c, 'yes', 1])];
    const sizes = [0.035, 0.05, 0.02, 0.03, 0.04], hist = {}, r = HW.rng(5);
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
    /* cash out takes two clicks: the first asks you to confirm */
    arm(k) { const hot = armed && armed.k === k && Date.now() - armed.t < 6000; armed = hot ? null : { k, t: Date.now() }; return hot; },
    row: (id, side) => rows.find(h => h.id === Number(id) && h.side === side),
  };
}
