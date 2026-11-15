/* The markets page: every market from the server's /api/markets as a card, a detail drawer
   with the data behind the question, and a trade box wired to Xavi's web/chain helpers
   (burner wallet, buy, sell, redeem on Monad testnet). Odds update live as anyone trades. */

import { makePortfolio } from './portfolio.js';

const HW = window.HW;
const $ = id => document.getElementById(id);
const SAMPLE = new URLSearchParams(location.search).has('sample');   // preview "my trades" with made-up positions
const SERVER = location.search.includes('local') ? 'http://localhost:8787' : 'https://headway-production-83bb4bd7.up.railway.app';
const esc = HW.esc;

/* ---------- state ---------- */
let list = [];                 // markets from the server
let tab = 'all', query = '', sort = 'close';   // tab: all | live | strait | route | trade | soon | settled | mine
let chain = null;              // { mk, wl, cfg, m, wallet } once web/chain has loaded
let onchain = [];              // every onchain market (for positions on past live windows)
const pos = {};                // chain id -> { yes, no } share balances (bigint wei)
let openId = null;             // market shown in the drawer
let side = true, amount = '0.02';
let series = null;             // the data files behind the charts, loaded once
let placed = null;             // the bet just placed, while its confirmation is on screen
let hedged = null;             // same for a hedge
let busy = false;              // one of our own trades is landing (the dashboard waits before reconciling)

/* ---------- small helpers ---------- */
const STRAIT_GROUPS = ['weekly', 'collapse', 'vessel'];
const isSettled = m => !!(m.chain && m.chain.outcome != null);
const closeMs = m => {
  const t = m.live && m.live.trading && m.live.trading.trading_closes || (m.chain && m.chain.close) || m.closes;
  return t ? Date.parse(t) : NaN;
};
const isOpen = m => m.chainId != null && !isSettled(m) && closeMs(m) > Date.now();
const prob = m => m.probYes != null ? m.probYes : m.prior_yes != null ? m.prior_yes : 0.5;
const pool = m => (m.chain && m.chain.pool_mon) || 0;
const fMon = v => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' MON';
const left = ms => {
  if (!isFinite(ms)) return '';
  const s = Math.floor((ms - Date.now()) / 1000);
  if (s <= 0) return 'CLOSED';
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}D ${h}H LEFT` : h ? `${h}H ${String(m).padStart(2, '0')}M LEFT` : `${m}:${String(s % 60).padStart(2, '0')} LEFT`;
};
const sourceTag = m => m.group === 'live' ? 'LIVE · AIS GATE' : m.group === 'trade' ? 'TRADE · US CENSUS' : m.group === 'route' ? 'ROUTE · PORTWATCH' : 'STRAIT · PORTWATCH';
const outcomeText = o => o == null ? '' : typeof o === 'number' ? ['', 'YES', 'NO', 'INVALID'][o] || String(o) : String(o).toUpperCase();

/* ---------- "my trades": the dashboard (js/portfolio.js) ---------- */
/* What has to happen for a side to win, in plain words: "at least 297 ships", "under 35.0 days". */
const condition = (m, yes) => {
  const base = String(m.threshold_display || '').replace(/^under\s+/i, '');
  if (!base) return yes ? 'the answer to be yes' : 'the answer to be no';
  return (yes === (m.is_above !== false) ? 'at least ' : 'under ') + base;
};
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const utc = iso => new Date(iso).toISOString().slice(11, 16);   // the questions name their windows in UTC, so the page does too
/* The same for an onchain market, which may be an older one the server no longer lists. */
const need = (c, sideName, live) => {
  const yes = sideName === 'yes';
  const m = list.find(x => x.chainId != null && Number(x.chainId) === Number(c.id)) || list.find(x => x.question === c.question);
  if (m && m.threshold_display) return cap(condition(m, yes));
  const a = c.about || {}, n = Number(c.threshold), word = yes === c.isAbove ? 'At least ' : 'Under ';
  if (a.kind === 'live') return word + (live && live.threshold ? live.threshold : n) + ' ships';
  if (a.kind === 'arrival') return yes ? 'The ship to arrive late' : 'The ship to arrive on time';
  if (a.kind === 'strait') return word + n.toLocaleString('en-US') + (a.measure === 'weekly_tanker' ? ' tankers' : a.measure === 'weekly_container' ? ' container ships' : ' ships');
  if (a.kind === 'route' && a.measure === 'expected_days') return word + (n / 1000).toFixed(1) + ' days';
  return yes ? 'The answer to be yes' : 'The answer to be no';
};
const pf = makePortfolio({
  HW, left, sample: SAMPLE, pos, need,
  list: () => list, chain: () => chain, onchain: () => onchain, busy: () => busy,
  changed: () => { pill(); if (tab === 'mine') render(); },
});
const pill = () => {   // the small up/down figure on the "My trades" tab
  const T = pf.totals(), el = $('pfBadge'); if (!el) return;
  if (!T || !T.count) { el.textContent = ''; el.className = ''; return; }
  const d = T.openPnl > 0.00005 ? 'up' : T.openPnl < -0.00005 ? 'down' : 'flat';
  el.textContent = `${T.count} open · ${d === 'up' ? '▲ +' : d === 'down' ? '▼ −' : ''}${Math.abs(T.openPnl).toFixed(4)}`;
  el.className = d;
};

/* ---------- the data behind a market, for the sparkline and the chart ---------- */
const getJSON = async f => { for (const u of ['../data/processed/' + f, SERVER + '/data/' + f]) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch { /* next */ } } return null; };
const loadSeries = async () => {
  const [weekly, routes, index] = await Promise.all([getJSON('chokepoint_weekly.json'), getJSON('route_efficiency.json'), getJSON('efficiency_index.json')]);
  series = { weekly, routes, index };
  render();
};
const thresholdOf = m => { const n = parseFloat(String(m.threshold_display || '').replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
const dataFor = m => {
  if (!series) return null;
  const [kind, a, b] = (m.series || '').split(':');
  let vals = null, unit = '';
  if (kind === 'portwatch' && series.weekly && series.weekly[a]) {
    const key = b === 'weekly_transits' ? 'total' : b.replace('weekly_', '');
    vals = series.weekly[a][key]; unit = key === 'total' ? 'ships a week' : key + 's a week';
  } else if (kind === 'route_efficiency' && series.routes) {
    const c = series.routes.corridors[a];
    if (c && c[b]) { vals = c[b]; unit = b === 'expected_days' ? 'days' : 'efficiency'; }
    else if (b === 'index' && series.index) { vals = series.index[a] || series.index.world; unit = 'index'; }
  }
  if (!vals || !vals.length) return null;
  return { vals, unit, thr: thresholdOf(m) };
};
const spark = (m, w, h) => {
  const d = dataFor(m); if (!d) return '';
  const v = d.vals.slice(-26), thr = d.thr;
  const lo = Math.min(...v, thr ?? Infinity), hi = Math.max(...v, thr ?? -Infinity), span = hi - lo || 1;
  const X = i => i / (v.length - 1) * w, Y = x => h - 3 - (x - lo) / span * (h - 6);
  const path = v.map((x, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x).toFixed(1)).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${thr != null ? `<line x1="0" x2="${w}" y1="${Y(thr).toFixed(1)}" y2="${Y(thr).toFixed(1)}" stroke="var(--dim)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>` : ''}
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
};
const chart = m => {
  const d = dataFor(m); if (!d) return '';
  const v = d.vals.slice(-104), thr = d.thr, W = 600, H = 200, L = 44, B = 22, T = 10;
  const lo0 = Math.min(...v, thr ?? Infinity), hi0 = Math.max(...v, thr ?? -Infinity), pad = (hi0 - lo0) * 0.08 || 1, lo = lo0 - pad, hi = hi0 + pad;
  const X = i => L + i / (v.length - 1) * (W - L - 8), Y = x => T + (1 - (x - lo) / (hi - lo)) * (H - T - B);
  const path = v.map((x, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x).toFixed(1)).join('');
  const f = x => Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(x < 10 ? 2 : 1);
  const ticks = [lo0, (lo0 + hi0) / 2, hi0].map(t => `<line x1="${L}" x2="${W - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line2)"/><text x="${L - 6}" y="${Y(t) + 3}" text-anchor="end">${f(t)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="The last two years of ${esc(d.unit)}, with the market's threshold">
    ${ticks}
    <path d="${path}L${X(v.length - 1)} ${H - B}L${L} ${H - B}Z" fill="var(--accent)" opacity=".08"/>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>
    ${thr != null ? `<line x1="${L}" x2="${W - 8}" y1="${Y(thr)}" y2="${Y(thr)}" stroke="var(--fg)" stroke-dasharray="4 4"/><text x="${W - 10}" y="${Y(thr) - 5}" text-anchor="end" style="fill:var(--fg)">THRESHOLD ${esc(m.threshold_display || '')}</text>` : ''}
    <circle cx="${X(v.length - 1)}" cy="${Y(v[v.length - 1])}" r="3.5" fill="var(--accent)"/>
    <text x="${L}" y="${H - 6}">2 YEARS AGO</text><text x="${W - 8}" y="${H - 6}" text-anchor="end">LATEST WEEK · ${f(v[v.length - 1])} ${esc(d.unit.toUpperCase())}</text></svg>`;
};

/* ---------- the one-line summary ---------- */
const renderSum = () => {
  const open = list.filter(isOpen), day = Date.now() + 864e5, soon = open.filter(m => closeMs(m) < day).length;
  $('sum').textContent = list.length ? `${open.length} open ${open.length === 1 ? 'market' : 'markets'} · ${fMon(open.reduce((a, m) => a + pool(m), 0))} pooled · ${soon ? soon + (soon === 1 ? ' closes' : ' close') + ' in the next 24 hours' : 'none closing today'}` : '';
};

/* ---------- cards ---------- */
const GROUP_OF = m => m.group === 'live' ? 'live' : STRAIT_GROUPS.includes(m.group) ? 'strait' : m.group === 'route' ? 'route' : 'trade';
const inTab = m => {
  if (tab === 'all') return isOpen(m);
  if (tab === 'soon') return m.chainId == null;
  if (tab === 'settled') return isSettled(m);
  return GROUP_OF(m) === tab && !isSettled(m);
};
/* The home view: open markets in four plain groups, instead of one long list. */
const SECTIONS = [
  ['live', 'Live', 'Ships crossing a gate in the next hour. Settles the same day.'],
  ['strait', 'Straits', 'How many ships pass a strait this week, counted by IMF PortWatch.'],
  ['route', 'Routes', 'How long a shipping route takes this week.'],
  ['trade', 'Trade', 'Monthly US trade with one partner, from the official release.'],
];
const card = m => {
  const p = prob(m), open = isOpen(m), settled = isSettled(m), live = m.group === 'live';
  const cn = m.live && m.live.counting;
  const foot = settled ? `<span class="tag">SETTLED ${outcomeText(m.chain.outcome)}</span>` : m.chainId == null ? '<span class="tag">NOT OPEN YET</span>' : `<span class="tag">POOL ${fMon(pool(m))}</span>`;
  const mine = pos[m.chainId];
  const action = settled ? `<div class="won">RESULT: ${outcomeText(m.chain.outcome)}</div>`
    : `<div class="btns"><button data-side="yes" ${open ? '' : 'disabled'}>YES ${Math.round(p * 100)}¢</button><button data-side="no" ${open ? '' : 'disabled'}>NO ${Math.round((1 - p) * 100)}¢</button></div>`;
  return `<article class="kc${live ? ' is-live' : ''}" data-id="${esc(m.id)}" tabindex="0">
    <div class="top"><span class="tag src">${sourceTag(m)}</span><span class="tag" data-end="${closeMs(m) || ''}">${m.chainId == null ? '' : left(closeMs(m))}</span></div>
    <div class="q">${esc(m.question)}</div>
    <div class="mid"><div class="pct">${Math.round(p * 100)}%<small>YES</small></div>${spark(m, 120, 36)}</div>
    <div class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
    <div class="foot">${foot}<span class="tag">${cn && cn.count_so_far != null ? `WINDOW BEFORE: ${cn.count_so_far} OF ${cn.threshold}` : mine && (mine.yes || mine.no) ? 'YOU HOLD A POSITION' : ''}</span></div>
    ${action}</article>`;
};
const render = () => {
  renderSum();
  const grid = $('grid'), q = query.trim().toLowerCase();
  const by = { close: (a, b) => (isOpen(b) - isOpen(a)) || ((closeMs(a) || 9e15) - (closeMs(b) || 9e15)), pool: (a, b) => pool(b) - pool(a), yes: (a, b) => prob(b) - prob(a), no: (a, b) => prob(a) - prob(b) }[sort];
  if (tab === 'mine') { grid.className = 'mk-grid pf'; grid.innerHTML = pf.html(); pf.afterRender(); }
  else if (q) {   // searching looks everywhere, open markets first
    const rows = list.filter(m => m.question.toLowerCase().includes(q)).sort(by);
    grid.className = 'mk-grid';
    grid.innerHTML = rows.map(card).join('') || `<div class="mk-empty">No market mentions “${esc(query.trim())}”.</div>`;
  } else if (tab === 'all') {
    const open = list.filter(isOpen).sort(by), later = list.filter(m => m.chainId == null).length;
    grid.className = 'mk-grid secs';
    grid.innerHTML = (SECTIONS.map(([key, title, blurb]) => {
      const rows = open.filter(m => GROUP_OF(m) === key); if (!rows.length) return '';
      return `<div class="sec"><div class="sec-h"><h2>${title}</h2><p>${blurb}</p>${rows.length > 6 ? `<button data-t="${key}">SEE ALL ${rows.length} →</button>` : ''}</div><div class="cards">${rows.slice(0, 6).map(card).join('')}</div></div>`;
    }).join('') || (list.length ? '<div class="mk-empty">No markets are open right now.</div>' : '<div class="mk-empty">Loading markets…</div>'))
      + (later ? `<p class="mk-later">${later} more markets open later. <button data-t="soon">SEE WHAT IS COMING UP →</button></p>` : '');
  } else {
    const rows = list.filter(inTab).sort(by);
    grid.className = 'mk-grid';
    grid.innerHTML = rows.map(card).join('') || '<div class="mk-empty">No markets here right now.</div>';
  }
  $('note').textContent = 'Markets settle onchain on Monad testnet against public data. Stakes are testnet MON, which has no real value. Each share pays 1 MON if you are right.';
  if (openId != null && !hedgeOpen) renderDrawer();
};

/* ---------- the confirmation after a bet lands: a tick that draws itself, then what you stand to win or lose ---------- */
const donePanel = d => `<div class="tb done">
    <div class="tickwrap"><span class="ring"></span><svg class="tick" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="23"/><path d="M15.5 27l7.5 7.5 14-16"/></svg></div>
    <h3>${d.title}</h3>
    <p class="donesum">${d.line}</p>
    <div class="outcomes">
      <div class="oc win"><span>IF YOU'RE RIGHT</span><b>+${(d.shares - d.amt).toFixed(4)} MON</b><small>you get ${d.shares.toFixed(4)} back</small></div>
      <div class="oc lose"><span>IF YOU'RE WRONG</span><b>−${d.amt.toFixed(4)} MON</b><small>you lose your stake</small></div>
    </div>
    <button class="go" data-watch="1">WATCH IT IN MY TRADES</button>
    <button class="pill wide" data-again="1">${d.again}</button>
    <div class="msg">${d.sample ? 'Sample view: nothing was sent.' : d.tx && chain && chain.cfg ? `<a href="${chain.cfg.txUrl(d.tx)}" target="_blank" rel="noopener">View the transaction</a>` : ''}</div>
  </div>`;

/* ---------- drawer ---------- */
const current = () => list.find(m => m.id === openId);
const renderDrawer = () => {
  const m = current(); if (!m) return;
  const p = prob(m), open = isOpen(m), settled = isSettled(m), c = m.chain || {};
  const cn = m.live && m.live.counting, tr = m.live && m.live.trading;
  const ch = chart(m);
  const cfg = chain && chain.cfg;
  const mine = pos[m.chainId];
  // keep what the person typed while the drawer re-renders on a live odds update
  const box = $('dbody'), justPlaced = placed && placed.id === m.id;
  if (justPlaced && box.dataset.placed === String(placed.t)) return;   // leave the confirmation as it is: redrawing would replay its animation
  const amtEl = $('amt'); if (amtEl) amount = amtEl.value;
  const focused = document.activeElement && document.activeElement.id === 'amt';
  $('dbody').innerHTML = `
    <div class="tag src">${sourceTag(m)} · <span data-end="${closeMs(m) || ''}">${m.chainId == null ? 'NOT OPEN YET' : left(closeMs(m))}</span></div>
    <h1>${esc(m.question)}</h1>
    <div class="dcols">
      <div>
        ${cn ? `<div class="dsec"><h3>THE WINDOW BEFORE THIS ONE · BEING COUNTED NOW</h3><div class="count"><b>${cn.count_so_far} / ${cn.threshold}</b><span class="tag">SHIPS SO FAR · <span data-end="${Date.parse(cn.window_end)}">${left(Date.parse(cn.window_end))}</span></span></div>
          <p style="margin-top:8px">This is the ${utc(cn.window_start)} to ${utc(cn.window_end)} UTC window, shown so you can see the pace at this gate.${tr ? ` Your bet is on the next one, ${utc(tr.window_start)} to ${utc(tr.window_end)} UTC. Betting closes when it starts.` : ''}</p></div>` : ''}
        ${ch ? `<div class="dsec"><h3>THE DATA BEHIND IT</h3>${ch}</div>` : ''}
        <div class="dsec"><h3>WHY THIS THRESHOLD</h3><p>${esc(m.why || '—')}</p></div>
        <div class="dsec"><h3>RULES</h3><dl class="rules">
          <dt>PAYS YES IF</dt><dd>The result is ${m.is_above === false ? 'below' : 'at or above'} ${esc(m.threshold_display || String(m.threshold))}.</dd>
          <dt>SOURCE</dt><dd>${esc(m.settles_on || '—')}</dd>
          <dt>TRADING CLOSES</dt><dd>${isFinite(closeMs(m)) ? new Date(closeMs(m)).toLocaleString() : '—'}</dd>
          <dt>SETTLES BY</dt><dd>${c.resolve_by ? new Date(c.resolve_by).toLocaleString() : '—'}</dd>
          <dt>RESOLVER</dt><dd>The Headway keeper posts the result from the source. If it has not settled by then, anyone can void the market and stakes are returned.</dd>
          <dt>FEE</dt><dd>${c.fee_bps != null ? (c.fee_bps / 100).toFixed(1) + '% per trade, paid to the pool' : '—'}</dd>
          <dt>ONCHAIN</dt><dd>${m.chainId != null ? `Market #${m.chainId}` + (cfg && chain.m ? ` · <a href="${cfg.addressUrl(chain.m.address)}" target="_blank" rel="noopener">contract</a>` : '') : 'Not opened onchain yet'}</dd>
        </dl></div>
      </div>
      ${justPlaced ? donePanel({ title: 'Bet placed', line: `You bet <b>${placed.amt.toFixed(4)} MON</b> on <b>${placed.yes ? 'YES' : 'NO'}</b>: ${esc(condition(m, placed.yes))}.`, shares: placed.shares, amt: placed.amt, tx: placed.tx, sample: placed.sample, again: 'PLACE ANOTHER BET' }) : `
      <div class="tb">
        <div class="odds2"><span class="tag">CHANCE OF YES</span><b>${Math.round(p * 100)}%</b></div>
        <div class="kc" style="padding:0;border:0;box-shadow:none;background:none;cursor:default;transform:none"><div class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></div></div>
        ${settled ? `<p class="msg">This market settled ${outcomeText(c.outcome)}.</p>` : `
        <label>PICK A SIDE</label>
        <div class="side"><button data-s="yes" class="${side ? 'on' : ''}">YES ${Math.round(p * 100)}¢</button><button data-s="no" class="${side ? '' : 'on'}">NO ${Math.round((1 - p) * 100)}¢</button></div>
        <p class="sidewhy"><b>${side ? 'YES' : 'NO'}</b> wins with ${esc(condition(m, side))}.</p>
        <label for="amt">HOW MUCH</label>
        <div class="amt"><input id="amt" inputmode="decimal" value="${esc(amount)}" autocomplete="off"><span>MON</span></div>
        <div class="quick">${['0.01', '0.02', '0.05', '0.1'].map(a => `<button data-q="${a}">${a}</button>`).join('')}</div>
        <div class="outcomes">
          <div class="oc win"><span>IF YOU'RE RIGHT</span><b id="eWin">—</b><small id="eBack">&nbsp;</small></div>
          <div class="oc lose"><span>IF YOU'RE WRONG</span><b id="eLose">—</b><small>you lose your stake</small></div>
        </div>
        <p class="fine" id="eFine">&nbsp;</p>
        <button class="go" id="go" ${open ? '' : 'disabled'}>${open ? 'PLACE BET · ' + (side ? 'YES' : 'NO') : m.chainId == null ? 'NOT OPEN YET' : 'TRADING CLOSED'}</button>`}
        <div class="msg" id="tmsg"></div>
        ${mine && (mine.yes > 0n || mine.no > 0n) ? `<div class="mine"><span class="tag">YOU ALREADY HOLD</span>
          ${mine.yes > 0n ? `<div><span>${chain.mk.formatMon(mine.yes, 3)} YES shares</span></div>` : ''}
          ${mine.no > 0n ? `<div><span>${chain.mk.formatMon(mine.no, 3)} NO shares</span></div>` : ''}
          <div><span>Cash out or collect under My trades</span><button data-watch="1">MY TRADES</button></div></div>` : ''}
      </div>`}
    </div>`;
  box.dataset.placed = justPlaced ? String(placed.t) : '';
  if (focused && $('amt')) { const a = $('amt'); a.focus(); a.setSelectionRange(a.value.length, a.value.length); }
  quote();
};
const openDrawer = (id, s) => { hedgeOpen = false; placed = null; openId = id; if (s != null) side = s; document.body.classList.add('drawer-open'); $('drawer').setAttribute('aria-hidden', 'false'); renderDrawer(); ensureChain(); };
const closeDrawer = () => { hedgeOpen = false; placed = null; hedged = null; openId = null; document.body.classList.remove('drawer-open'); $('drawer').setAttribute('aria-hidden', 'true'); };

/* ---------- hedge a ship: price a late arrival, then open the market and buy cover in one transaction ---------- */
let hedgeOpen = false, hq = null;   // hq: the signed quote on screen
const hv = { ship: '', port: '', deadline: '', cargo: '500000' };
const USD_PER_MON = 100000;         // demo rate, so the cover fits in a burner wallet (0.25 MON from the faucet)
const localInput = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const openHedge = (ship, port) => {
  openId = null; hedgeOpen = true; hq = null; hedged = null; $('dbody').dataset.placed = '';
  if (ship != null) hv.ship = ship; if (port != null) hv.port = port;
  if (!hv.deadline) hv.deadline = localInput(new Date(Date.now() + 19 * 3600e3));
  document.body.classList.add('drawer-open'); $('drawer').setAttribute('aria-hidden', 'false');
  renderHedge(); ensureChain();
};
const renderHedge = () => {
  const q = hq, md = q && q.model, inp = md && md.inputs || {}, hg = q && q.hedge || {};
  const stake = q ? Math.min(0.05, (hg.fair_premium_mon || 0.01) * 1.2) : 0;
  const when = t => t ? new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : '—';
  $('dbody').innerHTML = `
    <div class="tag src">HEDGE A SHIP · ARRIVAL MARKET</div>
    <h1>${q ? esc(q.quote.question) : 'Cover a shipment against arriving late'}</h1>
    <div class="dcols">
      <div>
        <div class="dsec"><h3>YOUR SHIPMENT</h3>
          <div class="hf">
            <label class="f"><span>SHIP (NAME, IMO OR MMSI)</span><input id="hShip" value="${esc(hv.ship)}" placeholder="NYK DIANA" autocomplete="off"></label>
            <label class="f"><span>ARRIVING AT (PORT)</span><input id="hPort" value="${esc(hv.port)}" placeholder="Hamburg" autocomplete="off"></label>
            <label class="f"><span>MUST ARRIVE BY (YOUR TIME)</span><input id="hDead" type="datetime-local" value="${esc(hv.deadline)}"></label>
            <label class="f"><span>CARGO VALUE (USD)</span><input id="hCargo" inputmode="numeric" value="${esc(hv.cargo)}"></label>
          </div>
          <p class="hfine">The server prices the chance the ship is late from its live position and speed, the weather on the way, straits on the route and how busy the port is. Nothing is spent until you open the market.</p>
        </div>
        ${q ? `<div class="dsec"><h3>WHAT THE MODEL SEES</h3><div class="facts">
            <div><b>${when(md.expected_arrival)}</b><span>EXPECTED ARRIVAL</span></div>
            <div><b>± ${md.sigma_hours != null ? (+md.sigma_hours).toFixed(1) : '—'} h</b><span>UNCERTAINTY</span></div>
            <div><b>${md.hours_to_spare != null ? (+md.hours_to_spare).toFixed(1) + ' h' : '—'}</b><span>TIME TO SPARE</span></div>
            <div><b>${inp.distance_nm != null ? HW.fInt(inp.distance_nm) + ' nm' : '—'}</b><span>DISTANCE LEFT</span></div>
            <div><b>${inp.speed_kn != null ? (+inp.speed_kn).toFixed(1) + ' kn' : '—'}</b><span>SPEED NOW</span></div>
            <div><b>${inp.weather ? (+inp.weather.wave_m).toFixed(1) + ' m · ' + Math.round(inp.weather.wind_kn) + ' kn' : '—'}</b><span>WAVES · WIND</span></div>
            <div><b>${inp.port_wait_hours != null ? (+inp.port_wait_hours).toFixed(1) + ' h' : '—'}</b><span>PORT WAIT</span></div>
            <div><b>${inp.strait_delay_hours != null ? (+inp.strait_delay_hours).toFixed(1) + ' h' : '—'}</b><span>STRAIT DELAYS${(inp.straits || []).length ? ' · ' + esc(inp.straits.join(', ')).toUpperCase() : ''}</span></div>
            <div><b>${inp.delay_cost_pct_per_day != null ? inp.delay_cost_pct_per_day + '%' : '—'}</b><span>CARGO VALUE LOST PER DAY LATE</span></div>
          </div>
          <p class="hfine">${esc(inp.eta || '')}${inp.delay_cost_source ? ' · Delay cost from ' + esc(inp.delay_cost_source) : ''}</p></div>` : ''}
      </div>
      ${hedged ? donePanel({ title: 'Cover bought', line: `Market #${hedged.id} is open. You paid <b>${hedged.amt.toFixed(4)} MON</b> for cover that pays if the ship is late.`, shares: hedged.shares, amt: hedged.amt, tx: hedged.tx, again: 'HEDGE ANOTHER SHIP' }) : `
      <div class="tb">
        ${q ? `<div class="odds2"><span class="tag">CHANCE IT IS LATE</span><b>${Math.round(md.p_yes * 100)}%</b></div>
          <div class="kc" style="padding:0;border:0;box-shadow:none;background:none;cursor:default;transform:none"><div class="bar"><i style="width:${(md.p_yes * 100).toFixed(1)}%"></i></div></div>
          <div class="est">
            <div><span>Estimated loss if late</span><b>${hg.loss_usd != null ? HW.fUSD(hg.loss_usd) : '—'}</b></div>
            <div><span>Suggested cover</span><b>${hg.cover_mon != null ? (+hg.cover_mon).toFixed(3) + ' MON' : '—'}</b></div>
            <div><span>Fair price for it</span><b>${hg.fair_premium_mon != null ? (+hg.fair_premium_mon).toFixed(4) + ' MON' : '—'}</b></div>
            <div><span>You pay now (cover + 0.01 fee)</span><b>${(stake + 0.01).toFixed(4)} MON</b></div>
          </div>
          <button class="go" id="hGo">OPEN MARKET AND HEDGE</button>
          <button class="pill" id="hAgain" style="width:100%;margin-top:8px">PRICE IT AGAIN</button>`
        : `<p class="msg" style="margin:0 0 14px">Fill in the shipment, then get a price. If the ship arrives after your deadline, your cover pays out.</p>
          <button class="go" id="hQuote">GET A PRICE</button>`}
        <div class="msg" id="tmsg"></div>
        <p class="hfine">Demo rate: $${HW.fInt(USD_PER_MON)} of cargo risk per MON, so the cover fits a test wallet.</p>
      </div>`}
    </div>`;
};
const readHedge = () => { for (const [k, id] of [['ship', 'hShip'], ['port', 'hPort'], ['deadline', 'hDead'], ['cargo', 'hCargo']]) if ($(id)) hv[k] = $(id).value.trim(); };
const getQuote = async () => {
  readHedge();
  if (!hv.ship || !hv.port || !hv.deadline) return say('Fill in the ship, the port and the deadline.');
  const deadline = new Date(hv.deadline);
  if (!(deadline.getTime() > Date.now() + 3600e3)) return say('The deadline has to be more than an hour away.');
  const btn = $('hQuote') || $('hAgain'); if (btn) btn.disabled = true;
  say('Pricing your shipment…');
  await ensureChain(); if (!chain) return say('The chain helpers did not load. Refresh and try again.');
  try {
    hq = await chain.mk.requestQuote({ ship: hv.ship, port: hv.port, deadline, cargoUsd: +String(hv.cargo).replace(/[^0-9.]/g, '') || 500000, usdPerMon: USD_PER_MON });
    renderHedge();
  } catch (e) {
    // the server answers with {"detail": "..."}; show that sentence
    let msg = String(e.message || e); const j = msg.match(/\{.*\}$/s);
    if (j) { try { msg = JSON.parse(j[0]).detail || msg; } catch { /* keep the raw text */ } }
    say(esc(msg)); if (btn) btn.disabled = false;
  }
};
const openHedgeMarket = async () => {
  if (!hq) return;
  if (SAMPLE) return say(SAMPLE_NOTE);
  $('hGo').disabled = true; $('hGo').classList.add('loading'); $('hGo').textContent = 'OPENING THE MARKET';
  say('Getting your wallet ready…');
  const w = await connect(); if (!w) { renderHedge(); return say('Could not set up a wallet.'); }
  say('Opening the market and buying your cover…');
  try {
    const stakeMon = +Math.min(0.05, (hq.hedge.fair_premium_mon || 0.01) * 1.2).toFixed(4), stake = chain.mk.parseMon(String(stakeMon));
    busy = true;
    const r = await chain.m.create(w, hq, { buyYes: true, stake });
    const got = r.trade ? num(r.trade.shares) : 0;
    hedged = { id: Number(r.id), shares: got, amt: stakeMon, tx: r.receipt.hash || r.receipt.transactionHash };
    renderHedge(); celebrate();
    await afterTrade(r, '', { kind: 'buy', id: Number(r.id), side: 'yes', q: hq.quote.question, mon: stakeMon, shares: got });
  } catch (e) { busy = false; renderHedge(); say(esc(chain.mk.explain(e))); }
};

/* ---------- chain: Xavi's helpers, loaded when first needed ---------- */
let chainP = null;
const ensureChain = () => chainP || (chainP = (async () => {
  try {
    const [mk, wl, cfg, ev] = await Promise.all([import('../chain/markets.js'), import('../chain/wallet.js'), import('../chain/config.js'), import('../chain/events.js')]);
    const m = await mk.markets();
    chain = { mk, wl, cfg, m, wallet: null };
    onchain = await m.list(); lastList = Date.now();
    pairOdds();
    ev.watchOdds(({ id, probYes, resolved, created }) => {
      const row = list.find(x => x.chainId != null && Number(x.chainId) === Number(id));
      const oc = onchain.find(x => Number(x.id) === Number(id));
      if (probYes != null) { if (row) row.probYes = probYes; if (oc) { oc.probYes = probYes; oc.liveAt = Date.now(); } }
      if (resolved || created || !row) refresh(true); else render();
      pf.schedule();
    }).catch(() => {});
    render();
  } catch (e) { chain = null; chainP = null; console.warn('chain not available', e); }
  return chain;
})());
const pairOdds = (fromChain = true) => {   // fromChain: the onchain list was read just now
  if (!chain) return;
  for (const m of list) {
    // the server's own pairing wins (Ben: matching can land on an old live window); findMarket is the fallback
    const c = m.chainId != null ? onchain.find(x => Number(x.id) === Number(m.chainId)) : chain.mk.findMarket(onchain, m);
    if (!c) continue;
    m.chainId = Number(c.id);
    // newest odds win: a fresh chain read or a live trade we just heard, else the server's number
    if (fromChain || m.probYes == null || (c.liveAt && Date.now() - c.liveAt < 20000)) m.probYes = c.probYes; else c.probYes = m.probYes;
    // the server has not caught up on this market yet: fill in its numbers from the chain
    if (!m.chain) m.chain = {
      pool_mon: Number(chain.mk.formatMon(c.yesReserve + c.noReserve, 6)), close: new Date(c.closeTime * 1000).toISOString(),
      resolve_by: new Date(c.resolveBy * 1000).toISOString(), fee_bps: c.feeBps, outcome: c.resolved ? c.outcome : null,
    };
  }
};
/* Positions only change when this wallet trades, so read them all when the wallet connects and after
   each of its trades. The timer reads markets it has not seen yet, and everything every few minutes
   (a trade made from the globe page in another tab). The public RPC rate-limits, so keep reads few. */
let lastFullRead = 0;
const readPositions = async (all = true) => {
  if (all) lastFullRead = Date.now();
  const todo = onchain.filter(c => all || !(Number(c.id) in pos));
  for (let i = 0; i < todo.length; i += 5) {   // five markets at a time (two reads each), to stay under the RPC's rate limit
    await Promise.all(todo.slice(i, i + 5).map(async c => { try { const p = await chain.m.position(c.id, chain.wallet.address); pos[Number(c.id)] = { yes: p.yes, no: p.no }; } catch { /* skip */ } }));
  }
};
const loadPositions = async (all = true) => {
  if (!chain || !chain.wallet || SAMPLE || busy) return;
  await readPositions(all || Date.now() - lastFullRead > 180000);
  render();
  await pf.compute();
};
const showWallet = async () => {
  const a = chain.wallet.address, bal = await chain.wallet.balance().catch(() => null);
  $('wallet').textContent = a.slice(0, 6) + '…' + a.slice(-4) + (bal != null ? ' · ' + chain.mk.formatMon(bal, 3) + ' MON' : '');
};
const connect = async () => {
  await ensureChain();
  if (!chain) { $('wallet').textContent = 'CHAIN UNAVAILABLE'; return null; }
  if (!chain.wallet) {
    $('wallet').textContent = 'CONNECTING…';
    try { chain.wallet = await chain.wl.getWallet(); } catch (e) { $('wallet').textContent = 'WALLET ERROR'; return null; }
    loadPositions();
  }
  showWallet();
  return chain.wallet;
};
/* A burner wallet already saved in this browser: show its trades straight away. Reading it sends
   nothing and asks the faucet for nothing; a new wallet is only ever made when you press a button. */
const resumeWallet = async () => {
  let saved = null; try { saved = localStorage.getItem('headway.burner.v1'); } catch { /* blocked */ }
  if (!saved || SAMPLE) return;
  await ensureChain(); if (!chain || chain.wallet) return;
  try { chain.wallet = await chain.wl.getWallet({ fund: false }); showWallet(); loadPositions(); } catch { /* connect by hand instead */ }
};

/* ---------- quote and trade ---------- */
let quoteN = 0;
const quote = async () => {
  const m = current(), n = ++quoteN;
  const set = (win, back, lose, fine) => { if ($('eWin')) { $('eWin').textContent = win; $('eBack').innerHTML = back; $('eLose').textContent = lose; $('eFine').innerHTML = fine; } };
  const blank = () => set('—', '&nbsp;', '—', '&nbsp;');
  if (!m || !$('amt')) return;
  const amt = parseFloat($('amt').value);
  if (!(amt > 0) || m.chainId == null || !isOpen(m)) return blank();
  set('…', '&nbsp;', '−' + amt.toFixed(4) + ' MON', '&nbsp;');
  await ensureChain(); if (!chain || n !== quoteN) return;
  try {
    const shares = await chain.m.quoteBuy(m.chainId, side, chain.mk.parseMon(String(amt)));
    if (n !== quoteN) return;
    const sh = Number(chain.mk.formatMon(shares, 6));
    if (!(sh > 0)) return blank();
    set('+' + (sh - amt).toFixed(4) + ' MON', `you get ${sh.toFixed(4)} back · ${(sh / amt).toFixed(2)}× your money`, '−' + amt.toFixed(4) + ' MON',
      `${Math.round(amt / sh * 100)}¢ a share, fee included. Each share pays 1 MON if you are right.`);
  } catch (e) { if (n === quoteN) blank(); }
};
/* the "My trades" tab gives a short pulse when a bet lands */
const celebrate = () => { const b = document.querySelector('#views [data-t="mine"]'); if (!b) return; b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); };
const say = html => { if ($('tmsg')) $('tmsg').innerHTML = html; if (tab === 'mine' && openId == null && !hedgeOpen) pf.setMsg(html); };
const num = wei => Number(chain.mk.formatMon(wei, 6));
const txLink = r => `<a href="${chain.cfg.txUrl(r.receipt.hash || r.receipt.transactionHash)}" target="_blank" rel="noopener">View transaction</a>`;
const SAMPLE_NOTE = 'This is the sample view, so nothing was sent. Remove “?sample” from the address to trade.';
/* After every trade: write it to the cost record, re-read the chain, then let the dashboard catch up. */
const afterTrade = async (r, text, entry) => {
  const html = text ? `${text} ${txLink(r)}` : '';
  say(html);
  try {
    if (entry) pf.record({ ...entry, tx: r.receipt.hash || r.receipt.transactionHash });
    onchain = await chain.m.list(); pairOdds();
    await readPositions();
  } finally { busy = false; }
  render(); showWallet();
  await pf.compute();
  say(html);
};
const place = async () => {
  const m = current(); if (!m) return;
  const amt = parseFloat($('amt').value), yes = side;
  if (!(amt > 0)) return say('Enter an amount first.');
  const btn = $('go'); btn.disabled = true; btn.classList.add('loading'); btn.textContent = 'PLACING YOUR BET';
  const fail = text => { placed = null; $('dbody').dataset.placed = ''; renderDrawer(); say(text); };
  if (SAMPLE) {   // the sample view walks through the same steps without sending anything
    try {
      await ensureChain();
      const got = num(await chain.m.quoteBuy(m.chainId, yes, chain.mk.parseMon(String(amt)))), k = yes ? 'yes' : 'no', cur = pos[m.chainId] || { yes: 0n, no: 0n };
      pf.record({ kind: 'buy', id: m.chainId, side: k, q: m.question, mon: amt, shares: got, tx: null });
      pos[m.chainId] = { ...cur, [k]: cur[k] + chain.mk.parseMon(got.toFixed(6)) };
      placed = { id: m.id, yes, shares: got, amt, tx: null, sample: true, t: Date.now() };
      renderDrawer(); celebrate(); pf.compute();
    } catch (e) { fail('Could not price that right now.'); }
    return;
  }
  say('Getting your wallet ready…');
  const w = await connect(); if (!w) return fail('Could not set up a wallet.');
  say('Sending your bet…');
  busy = true;
  try {
    const r = await chain.m.buy(w, m.chainId, yes, chain.mk.parseMon(String(amt)));
    const got = r.trade ? num(r.trade.shares) : 0;
    // show the confirmation the moment the receipt is back; the bookkeeping follows
    placed = { id: m.id, yes, shares: got, amt, tx: r.receipt.hash || r.receipt.transactionHash, t: Date.now() };
    renderDrawer(); celebrate();
    await afterTrade(r, '', { kind: 'buy', id: m.chainId, side: yes ? 'yes' : 'no', q: m.question, mon: amt, shares: got });
  } catch (e) { busy = false; fail(esc(chain.mk.explain(e))); }
};
const sell = async (id, yes) => {
  if (SAMPLE) return say(SAMPLE_NOTE);
  const w = await connect(); if (!w) return;
  const p = pos[Number(id)]; if (!p) return;
  const shares = yes ? p.yes : p.no, c = onchain.find(x => Number(x.id) === Number(id));
  say('Cashing out…');
  busy = true;
  try {
    const r = await chain.m.sell(w, id, yes, shares), out = r.trade ? num(r.trade.amount) : 0;
    await afterTrade(r, `Cashed out for ${out.toFixed(4)} MON.`, { kind: 'sell', id: Number(id), side: yes ? 'yes' : 'no', q: c && c.question, mon: out, shares: num(shares) });
  } catch (e) { busy = false; say(esc(chain.mk.explain(e))); }
};
const claim = async id => {
  if (SAMPLE) return say(SAMPLE_NOTE);
  const w = await connect(); if (!w) return;
  const c = onchain.find(x => Number(x.id) === Number(id));
  say('Claiming…');
  busy = true;
  try {
    const r = await chain.m.redeem(w, id), ev = r.events.find(e => e.eventName === 'Redeemed'), out = ev ? num(ev.args.amount) : 0;
    await afterTrade(r, `Claimed ${out.toFixed(4)} MON.`, { kind: 'claim', id: Number(id), side: 'both', q: c && c.question, mon: out, shares: 0 });
  } catch (e) { busy = false; say(esc(chain.mk.explain(e))); }
};

/* ---------- loading and refreshing ---------- */
let lastList = 0;
const refresh = async force => {
  try {
    const r = await fetch(SERVER + '/api/markets'); if (!r.ok) throw new Error(r.status);
    const d = await r.json(), fresh = d.markets || d;
    // keep odds we already heard live for markets the server has not caught up on
    list = fresh;
    // the server already carries each listed market's onchain numbers and live odds arrive by
    // websocket, so the full onchain list is only re-read once a minute (or when a market opens or settles)
    let listed = false;
    if (chain && (force === true || Date.now() - lastList > 55000)) { try { onchain = await chain.m.list(); lastList = Date.now(); listed = true; } catch { /* keep what we have */ } }
    if (chain) pairOdds(listed);
    render();
    pf.schedule();
  } catch (e) { if (!list.length) $('grid').innerHTML = '<div class="mk-empty">Could not reach the markets server. Retrying…</div>'; }
};

/* ---------- events ---------- */
const setTab = t => {
  tab = t; document.body.classList.toggle('tab-mine', t === 'mine');
  document.querySelectorAll('#tabs button').forEach(o => o.classList.toggle('on', o.dataset.t === t));
  document.querySelectorAll('#views button[data-t]').forEach(o => o.classList.toggle('on', (o.dataset.t === 'mine') === (t === 'mine')));
  pf.setMsg(''); pill(); render(); window.scrollTo({ top: 0 });
  if (t === 'mine') pf.schedule(0);
};
$('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) setTab(b.dataset.t); });
$('views').addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) setTab(b.dataset.t); });
$('find').addEventListener('input', e => { query = e.target.value; render(); });
$('sort').addEventListener('change', e => { sort = e.target.value; render(); });
$('grid').addEventListener('click', e => {
  const go = e.target.closest('button[data-go]'); if (go) return openDrawer(go.dataset.go);
  const more = e.target.closest('button[data-t]'); if (more) return setTab(more.dataset.t);
  const act = e.target.closest('button[data-act]'), pc = e.target.closest('[data-chain]');
  if (act && act.dataset.act === 'connect') return connect();
  if (pc) {   // a row on "my trades"
    const id = Number(pc.dataset.chain), yes = pc.dataset.side === 'yes', m = list.find(x => x.chainId != null && Number(x.chainId) === id);
    if (!act || act.dataset.act === 'add') { if (m) openDrawer(m.id, yes); return; }
    if (act.dataset.act === 'claim') return claim(BigInt(id));
    if (act.dataset.act === 'cash') {   // two clicks: the first shows what you would get
      if (pf.arm(id + ':' + pc.dataset.side)) return sell(BigInt(id), yes);
      return render();
    }
    return;
  }
  const c = e.target.closest('.kc[data-id]'); if (!c) return;
  const b = e.target.closest('button[data-side]');
  openDrawer(c.dataset.id, b ? b.dataset.side === 'yes' : null);
});
$('grid').addEventListener('keydown', e => { if (e.key === 'Enter') { const c = e.target.closest('.kc[data-id]'); if (c) openDrawer(c.dataset.id); } });
$('dbody').addEventListener('click', e => {
  if (e.target.closest('[data-watch]')) { closeDrawer(); return setTab('mine'); }
  if (hedgeOpen) {
    if (e.target.closest('[data-again]')) { hedged = null; hq = null; return renderHedge(); }
    if (e.target.closest('#hQuote') || e.target.closest('#hAgain')) return getQuote();
    if (e.target.closest('#hGo')) return openHedgeMarket();
    return;
  }
  const m = current(); if (!m) return;
  if (e.target.closest('[data-again]')) { placed = null; return renderDrawer(); }
  const s = e.target.closest('button[data-s]'), q = e.target.closest('button[data-q]');
  if (s) { side = s.dataset.s === 'yes'; return renderDrawer(); }
  if (q) { amount = q.dataset.q; $('amt').value = amount; return quote(); }
  if (e.target.closest('#go')) return place();
  const sl = e.target.closest('button[data-sell]'); if (sl) return sell(BigInt(m.chainId), sl.dataset.sell === 'yes');
  if (e.target.closest('button[data-claim]')) return claim(BigInt(m.chainId));
});
let qt = 0;
$('dbody').addEventListener('input', e => { if (e.target.id === 'amt') { amount = e.target.value; clearTimeout(qt); qt = setTimeout(quote, 250); } });
$('dbody').addEventListener('keydown', e => { if (hedgeOpen && e.key === 'Enter' && e.target.closest('.hf')) getQuote(); });
$('hedgeBtn').addEventListener('click', () => openHedge());
$('dx').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
$('wallet').addEventListener('click', connect);
const themeBtn = () => { $('theme').textContent = HW.C.theme === 'light' ? '☾' : '☀'; };
themeBtn();
$('theme').addEventListener('click', () => { HW.setTheme(HW.C.theme === 'light' ? 'dark' : 'light'); themeBtn(); });

// countdowns tick without redrawing the cards
setInterval(() => document.querySelectorAll('[data-end]').forEach(el => { const t = +el.dataset.end; if (t && el.textContent !== 'NOT OPEN YET' && el.textContent !== '') el.textContent = left(t); }), 1000);

await refresh();
{ // arriving from the globe's ship panel: markets.html?hedge=SHIP&port=PORT
  const qs = new URLSearchParams(location.search);
  if (qs.has('hedge')) openHedge(qs.get('hedge') || '', qs.get('port') || '');
  if (qs.get('q')) { query = qs.get('q'); $('find').value = query; render(); }   // from a strait or route panel on the globe
}
loadSeries();
if (location.hash === '#trades') setTab('mine');
if (SAMPLE) { await ensureChain(); if (chain) { pf.seedSample(); showWallet(); setTab('mine'); await pf.compute(); } }
else { ensureChain(); resumeWallet(); }
setInterval(refresh, 15000);
setInterval(() => loadPositions(false), 60000);
window.__mk = { get list() { return list; }, get chain() { return chain; }, openDrawer, pf };
