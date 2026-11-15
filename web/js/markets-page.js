/* The markets page: every market from the server's /api/markets as a card, a detail drawer
   with the data behind the question, and a trade box wired to Xavi's web/chain helpers
   (burner wallet, buy, sell, redeem on Monad testnet). Odds update live as anyone trades. */

const HW = window.HW;
const $ = id => document.getElementById(id);
const SERVER = location.search.includes('local') ? 'http://localhost:8787' : 'https://headway-production-83bb4bd7.up.railway.app';
const esc = HW.esc;

/* ---------- state ---------- */
let list = [];                 // markets from the server
let tab = 'open', query = '', sort = 'close';
let chain = null;              // { mk, wl, cfg, m, wallet } once web/chain has loaded
let onchain = [];              // every onchain market (for positions on past live windows)
const pos = {};                // chain id -> { yes, no } share balances (bigint wei)
let openId = null;             // market shown in the drawer
let side = true, amount = '0.02';
let series = null;             // the data files behind the charts, loaded once

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

/* ---------- summary strip ---------- */
const renderSum = () => {
  const open = list.filter(isOpen), day = Date.now() + 864e5;
  const cells = [
    ['OPEN MARKETS', open.length, `${list.length - open.length} more coming up or settled`],
    ['TOTAL POOLED', fMon(open.reduce((a, m) => a + pool(m), 0)), 'In open markets, on Monad testnet'],
    ['CLOSING IN 24 HOURS', open.filter(m => closeMs(m) < day).length, 'Last chance to take a side'],
  ];
  $('sum').innerHTML = cells.map(([k, v, s]) => `<div class="cell"><div class="tag">${k}</div><div class="num">${v}</div><div class="sub">${s}</div></div>`).join('');
};

/* ---------- cards ---------- */
const inTab = m => {
  if (tab === 'open') return isOpen(m);
  if (tab === 'live') return m.group === 'live';
  if (tab === 'strait') return STRAIT_GROUPS.includes(m.group);
  if (tab === 'route') return m.group === 'route';
  if (tab === 'trade') return m.group === 'trade';
  if (tab === 'soon') return m.chainId == null;
  if (tab === 'settled') return isSettled(m);
  return true;
};
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
    <div class="foot">${foot}<span class="tag">${cn && cn.count_so_far != null ? `NOW COUNTING ${cn.count_so_far} / ${cn.threshold}` : mine && (mine.yes || mine.no) ? 'YOU HOLD A POSITION' : ''}</span></div>
    ${action}</article>`;
};
const positionCard = c => {
  const p = pos[Number(c.id)], mk = chain.mk, settled = c.resolved;
  const rows = [['YES', p.yes], ['NO', p.no]].filter(([, v]) => v > 0n).map(([k, v]) => `<span class="tag">${mk.formatMon(v, 3)} ${k} SHARES</span>`).join('');
  return `<article class="kc" data-chain="${c.id}" tabindex="0">
    <div class="top"><span class="tag src">${settled ? 'SETTLED ' + outcomeText(c.outcome) : c.open ? 'OPEN' : 'WAITING TO SETTLE'}</span><span class="tag">${settled ? '' : left(c.closeTime * 1000)}</span></div>
    <div class="q">${esc(c.question)}</div>
    <div class="mid"><div class="pct">${Math.round(c.probYes * 100)}%<small>YES</small></div></div>
    <div class="bar"><i style="width:${(c.probYes * 100).toFixed(1)}%"></i></div>
    <div class="foot">${rows}</div>
    <div class="btns">${settled ? `<button data-act="claim">CLAIM</button><span></span>` : `<button data-act="sell-yes" ${c.open && p.yes > 0n ? '' : 'disabled'}>SELL YES</button><button data-act="sell-no" ${c.open && p.no > 0n ? '' : 'disabled'}>SELL NO</button>`}</div></article>`;
};
const render = () => {
  renderSum();
  const grid = $('grid');
  if (tab === 'mine') {
    if (!chain || !chain.wallet) { grid.innerHTML = '<div class="mk-empty">Connect your wallet (top right) to see your positions.</div>'; }
    else {
      const mine = onchain.filter(c => { const p = pos[Number(c.id)]; return p && (p.yes > 0n || p.no > 0n); });
      grid.innerHTML = mine.map(positionCard).join('') || '<div class="mk-empty">No positions yet. Pick a market and take a side.</div>';
    }
  } else {
    const q = query.trim().toLowerCase();
    const rows = list.filter(inTab).filter(m => !q || m.question.toLowerCase().includes(q));
    const by = { close: (a, b) => (isOpen(b) - isOpen(a)) || ((closeMs(a) || 9e15) - (closeMs(b) || 9e15)), pool: (a, b) => pool(b) - pool(a), yes: (a, b) => prob(b) - prob(a), no: (a, b) => prob(a) - prob(b) }[sort];
    grid.innerHTML = rows.sort(by).map(card).join('') || '<div class="mk-empty">No markets here right now.</div>';
  }
  $('note').textContent = 'Markets settle onchain on Monad testnet against public data. Stakes are testnet MON, which has no real value. Each share pays 1 MON if you are right.';
  if (openId != null && !hedgeOpen) renderDrawer();
};

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
  const amtEl = $('amt'); if (amtEl) amount = amtEl.value;
  const focused = document.activeElement && document.activeElement.id === 'amt';
  $('dbody').innerHTML = `
    <div class="tag src">${sourceTag(m)} · <span data-end="${closeMs(m) || ''}">${m.chainId == null ? 'NOT OPEN YET' : left(closeMs(m))}</span></div>
    <h1>${esc(m.question)}</h1>
    <div class="dcols">
      <div>
        ${cn ? `<div class="dsec"><h3>CROSSING THE GATE RIGHT NOW</h3><div class="count"><b>${cn.count_so_far} / ${cn.threshold}</b><span class="tag">SHIPS COUNTED · WINDOW ENDS <span data-end="${Date.parse(cn.window_end)}">${left(Date.parse(cn.window_end))}</span></span></div>
          <p style="margin-top:8px">${esc(cn.question || '')}</p>${tr ? `<p>The window you can trade now runs ${new Date(tr.window_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to ${new Date(tr.window_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Trading closes when it starts.</p>` : ''}</div>` : ''}
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
      <div class="tb">
        <div class="odds2"><span class="tag">CHANCE OF YES</span><b>${Math.round(p * 100)}%</b></div>
        <div class="kc" style="padding:0;border:0;box-shadow:none;background:none;cursor:default;transform:none"><div class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></div></div>
        ${settled ? `<p class="msg">This market settled ${outcomeText(c.outcome)}.</p>` : `
        <div class="side"><button data-s="yes" class="${side ? 'on' : ''}">YES ${Math.round(p * 100)}¢</button><button data-s="no" class="${side ? '' : 'on'}">NO ${Math.round((1 - p) * 100)}¢</button></div>
        <label for="amt">AMOUNT</label>
        <div class="amt"><input id="amt" inputmode="decimal" value="${esc(amount)}" autocomplete="off"><span>MON</span></div>
        <div class="quick">${['0.01', '0.02', '0.05', '0.1'].map(a => `<button data-q="${a}">${a}</button>`).join('')}</div>
        <div class="est"><div><span>Shares you get</span><b id="eShares">—</b></div><div><span>Average price</span><b id="ePrice">—</b></div><div><span>Paid out if you are right</span><b id="ePay">—</b></div></div>
        <button class="go" id="go" ${open ? '' : 'disabled'}>${open ? 'PLACE ' + (side ? 'YES' : 'NO') : m.chainId == null ? 'NOT OPEN YET' : 'TRADING CLOSED'}</button>`}
        <div class="msg" id="tmsg"></div>
        ${mine && (mine.yes > 0n || mine.no > 0n) ? `<div class="mine"><span class="tag">YOUR POSITION</span>
          ${mine.yes > 0n ? `<div><span>${chain.mk.formatMon(mine.yes, 3)} YES shares</span>${settled ? '' : '<button data-sell="yes">SELL</button>'}</div>` : ''}
          ${mine.no > 0n ? `<div><span>${chain.mk.formatMon(mine.no, 3)} NO shares</span>${settled ? '' : '<button data-sell="no">SELL</button>'}</div>` : ''}
          ${settled ? '<div><span>Collect your payout</span><button data-claim="1">CLAIM</button></div>' : ''}</div>` : ''}
      </div>
    </div>`;
  if (focused && $('amt')) { const a = $('amt'); a.focus(); a.setSelectionRange(a.value.length, a.value.length); }
  quote();
};
const openDrawer = (id, s) => { hedgeOpen = false; openId = id; if (s != null) side = s; document.body.classList.add('drawer-open'); $('drawer').setAttribute('aria-hidden', 'false'); renderDrawer(); ensureChain(); };
const closeDrawer = () => { hedgeOpen = false; openId = null; document.body.classList.remove('drawer-open'); $('drawer').setAttribute('aria-hidden', 'true'); };

/* ---------- hedge a ship: price a late arrival, then open the market and buy cover in one transaction ---------- */
let hedgeOpen = false, hq = null;   // hq: the signed quote on screen
const hv = { ship: '', port: '', deadline: '', cargo: '500000' };
const USD_PER_MON = 100000;         // demo rate, so the cover fits in a burner wallet (0.25 MON from the faucet)
const localInput = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const openHedge = (ship, port) => {
  openId = null; hedgeOpen = true; hq = null;
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
      </div>
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
  $('hGo').disabled = true; say('Getting your wallet ready…');
  const w = await connect(); if (!w) { $('hGo').disabled = false; return say('Could not set up a wallet.'); }
  say('Opening the market and buying your cover…');
  try {
    const stake = chain.mk.parseMon(Math.min(0.05, (hq.hedge.fair_premium_mon || 0.01) * 1.2).toFixed(4));
    const r = await chain.m.create(w, hq, { buyYes: true, stake });
    const got = r.trade ? chain.mk.formatMon(r.trade.shares, 3) : '';
    say(`Done. Market #${r.id} is open and you hold ${got} MON of cover. <a href="${chain.cfg.txUrl(r.receipt.transactionHash || r.receipt.hash)}" target="_blank" rel="noopener">View transaction</a>. It is listed under My positions.`);
    const msg = $('tmsg').innerHTML;
    onchain = await chain.m.list(); pairOdds(); await loadPositions(); connect();
    if ($('tmsg')) $('tmsg').innerHTML = msg;
  } catch (e) { say(esc(chain.mk.explain(e))); if ($('hGo')) $('hGo').disabled = false; }
};

/* ---------- chain: Xavi's helpers, loaded when first needed ---------- */
let chainP = null;
const ensureChain = () => chainP || (chainP = (async () => {
  try {
    const [mk, wl, cfg, ev] = await Promise.all([import('../chain/markets.js'), import('../chain/wallet.js'), import('../chain/config.js'), import('../chain/events.js')]);
    const m = await mk.markets();
    chain = { mk, wl, cfg, m, wallet: null };
    onchain = await m.list();
    pairOdds();
    ev.watchOdds(({ id, probYes, resolved, created }) => {
      const row = list.find(x => x.chainId != null && Number(x.chainId) === Number(id));
      const oc = onchain.find(x => Number(x.id) === Number(id));
      if (probYes != null) { if (row) row.probYes = probYes; if (oc) oc.probYes = probYes; }
      if (resolved || created || !row) refresh(); else render();
    }).catch(() => {});
    render();
  } catch (e) { chain = null; chainP = null; console.warn('chain not available', e); }
  return chain;
})());
const pairOdds = () => {
  if (!chain) return;
  for (const m of list) {
    const c = chain.mk.findMarket(onchain, m); if (!c) continue;
    m.chainId = Number(c.id); m.probYes = c.probYes;
    // the server has not caught up on this market yet: fill in its numbers from the chain
    if (!m.chain) m.chain = {
      pool_mon: Number(chain.mk.formatMon(c.yesReserve + c.noReserve, 6)), close: new Date(c.closeTime * 1000).toISOString(),
      resolve_by: new Date(c.resolveBy * 1000).toISOString(), fee_bps: c.feeBps, outcome: c.resolved ? c.outcome : null,
    };
  }
};
const loadPositions = async () => {
  if (!chain || !chain.wallet) return;
  await Promise.all(onchain.map(async c => { try { const p = await chain.m.position(c.id, chain.wallet.address); pos[Number(c.id)] = { yes: p.yes, no: p.no }; } catch { /* skip */ } }));
  render();
};
const connect = async () => {
  await ensureChain();
  if (!chain) { $('wallet').textContent = 'CHAIN UNAVAILABLE'; return null; }
  if (!chain.wallet) {
    $('wallet').textContent = 'CONNECTING…';
    try { chain.wallet = await chain.wl.getWallet(); } catch (e) { $('wallet').textContent = 'WALLET ERROR'; return null; }
  }
  const a = chain.wallet.address, bal = await chain.wallet.balance().catch(() => null);
  $('wallet').textContent = a.slice(0, 6) + '…' + a.slice(-4) + (bal != null ? ' · ' + chain.mk.formatMon(bal, 3) + ' MON' : '');
  loadPositions();
  return chain.wallet;
};

/* ---------- quote and trade ---------- */
let quoteN = 0;
const quote = async () => {
  const m = current(), n = ++quoteN;
  const set = (a, b, c) => { if ($('eShares')) { $('eShares').textContent = a; $('ePrice').textContent = b; $('ePay').textContent = c; } };
  if (!m || !$('amt')) return;
  const amt = parseFloat($('amt').value);
  if (!(amt > 0) || m.chainId == null || !isOpen(m)) return set('—', '—', '—');
  await ensureChain(); if (!chain || n !== quoteN) return;
  try {
    const shares = await chain.m.quoteBuy(m.chainId, side, chain.mk.parseMon(String(amt)));
    if (n !== quoteN) return;
    const sh = Number(chain.mk.formatMon(shares, 6));
    set(sh.toFixed(3), sh > 0 ? Math.round(amt / sh * 100) + '¢ a share' : '—', sh.toFixed(3) + ' MON');
  } catch (e) { if (n === quoteN) set('—', '—', '—'); }
};
const say = html => { if ($('tmsg')) $('tmsg').innerHTML = html; };
const afterTrade = async (r, text) => {
  const m = current();
  say(`${text} <a href="${chain.cfg.txUrl(r.receipt.transactionHash || r.receipt.hash)}" target="_blank" rel="noopener">View transaction</a>`);
  const msg = $('tmsg').innerHTML;
  onchain = await chain.m.list(); pairOdds(); await loadPositions(); connect();
  if (m && $('tmsg')) $('tmsg').innerHTML = msg;
};
const place = async () => {
  const m = current(); if (!m) return;
  const amt = parseFloat($('amt').value);
  if (!(amt > 0)) return say('Enter an amount first.');
  $('go').disabled = true; say('Getting your wallet ready…');
  const w = await connect(); if (!w) { $('go').disabled = false; return say('Could not set up a wallet.'); }
  say('Sending your trade…');
  try {
    const r = await chain.m.buy(w, m.chainId, side, chain.mk.parseMon(String(amt)));
    const got = r.trade ? chain.mk.formatMon(r.trade.shares, 3) : '';
    await afterTrade(r, `Done. You bought ${got} ${side ? 'YES' : 'NO'} shares.`);
  } catch (e) { say(esc(chain.mk.explain(e))); if ($('go')) $('go').disabled = false; }
};
const sell = async (id, yes) => {
  const w = await connect(); if (!w) return;
  const p = pos[Number(id)]; if (!p) return;
  say('Selling…');
  try { const r = await chain.m.sell(w, id, yes, yes ? p.yes : p.no); await afterTrade(r, 'Sold.'); }
  catch (e) { say(esc(chain.mk.explain(e))); alertIfNoDrawer(e); }
};
const claim = async id => {
  const w = await connect(); if (!w) return;
  say('Claiming…');
  try { const r = await chain.m.redeem(w, id); await afterTrade(r, 'Claimed.'); }
  catch (e) { say(esc(chain.mk.explain(e))); alertIfNoDrawer(e); }
};
const alertIfNoDrawer = e => { if (openId == null) $('note').textContent = chain.mk.explain(e); };

/* ---------- loading and refreshing ---------- */
const refresh = async () => {
  try {
    const r = await fetch(SERVER + '/api/markets'); if (!r.ok) throw new Error(r.status);
    const d = await r.json(), fresh = d.markets || d;
    // keep odds we already heard live for markets the server has not caught up on
    list = fresh;
    if (chain) { try { onchain = await chain.m.list(); pairOdds(); } catch { /* keep the server's numbers */ } }
    render();
  } catch (e) { if (!list.length) $('grid').innerHTML = '<div class="mk-empty">Could not reach the markets server. Retrying…</div>'; }
};

/* ---------- events ---------- */
$('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (!b) return; tab = b.dataset.t; document.querySelectorAll('#tabs button').forEach(o => o.classList.toggle('on', o === b)); if (tab === 'mine') connect(); render(); });
$('find').addEventListener('input', e => { query = e.target.value; render(); });
$('sort').addEventListener('change', e => { sort = e.target.value; render(); });
$('grid').addEventListener('click', e => {
  const act = e.target.closest('button[data-act]'), pc = e.target.closest('[data-chain]');
  if (act && pc) { const id = BigInt(pc.dataset.chain); return act.dataset.act === 'claim' ? claim(id) : sell(id, act.dataset.act === 'sell-yes'); }
  const c = e.target.closest('.kc[data-id]'); if (!c) return;
  const b = e.target.closest('button[data-side]');
  openDrawer(c.dataset.id, b ? b.dataset.side === 'yes' : null);
});
$('grid').addEventListener('keydown', e => { if (e.key === 'Enter') { const c = e.target.closest('.kc[data-id]'); if (c) openDrawer(c.dataset.id); } });
$('dbody').addEventListener('click', e => {
  if (hedgeOpen) {
    if (e.target.closest('#hQuote') || e.target.closest('#hAgain')) return getQuote();
    if (e.target.closest('#hGo')) return openHedgeMarket();
    return;
  }
  const m = current(); if (!m) return;
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
}
loadSeries();
ensureChain();
setInterval(refresh, 15000);
window.__mk = { get list() { return list; }, get chain() { return chain; }, openDrawer };
