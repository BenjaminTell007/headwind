/* The globe page's story (Kimball's, Nov 15). Three things, all on top of what main.js builds:

   1. Story card: the globe opens turned to the most disrupted strait, with one quiet card
      that says what's wrong there. Click it to open that strait.
   2. Hedge card in the ship view: the server's real price for "this ship arrives late",
      and one button that opens the market on Monad and buys the cover in one transaction.
      Same server call and contract call as the hedge panel on the markets page
      (js/markets-page.js), and the trade is written to the same record (js/ledger.js),
      so it shows up under My trades.
   3. Demo mode, index.html?demo: picks a ship the server can price, gets the test wallet
      and its faucet MON ready before anyone clicks, and offers that ship on the story card.

   main.js sets window.__hw = { D, globe, scene, dive } and fires "headway:dive" with the ship. */

const HW = window.HW, $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DEMO = new URLSearchParams(location.search).has('demo');
const DEMO_SHIPS = [['CMA CGM VELA', 'Antwerp'], ['NYK DIANA', 'Hamburg']];
const USD_PER_MON = 100000;   // same demo rate as the markets page, so the cover fits a test wallet
const TOO_LATE = 0.9;         // a market that opens this sure of "late" is not a useful hedge
const sleep = ms => new Promise(r => setTimeout(r, ms));

const css = document.createElement('style');
css.textContent = `
  .story { position:absolute; left:24px; top:84px; z-index:5; width:300px; padding:16px 18px 14px; border-radius:14px; text-align:left;
    background:var(--glass, rgba(22,22,23,.62)); backdrop-filter:blur(14px); border:1px solid rgba(236,236,236,.12); color:var(--fg);
    opacity:0; transform:translateY(6px); transition:opacity .8s ease, transform .8s ease, border-color .2s; cursor:pointer; }
  .story.in { opacity:1; transform:none; }
  .story:hover { border-color:rgba(76,141,255,.7); }
  .story .tag { display:flex; justify-content:space-between; align-items:center; color:var(--dim); font:300 10px/1.3 var(--mono); letter-spacing:.18em; text-transform:uppercase; }
  .story .x { color:var(--dim); font:300 15px/1 var(--sans); padding:2px 4px; margin:-4px -6px -4px 0; }
  .story .x:hover { color:var(--fg); }
  .story h3 { font:500 22px/1.15 var(--sans); letter-spacing:-.01em; margin:10px 0 2px; }
  .story .big { font:300 54px/1 var(--sans); letter-spacing:-.03em; color:var(--accent); font-variant-numeric:tabular-nums; margin:6px 0 8px; }
  .story p { font:400 12.5px/1.45 var(--sans); color:#cfcfcf; margin:0; }
  .story .go { margin-top:12px; color:var(--accent); font:400 10.5px/1.3 var(--mono); letter-spacing:.18em; }
  .story .demo { margin-top:12px; padding-top:12px; border-top:1px solid rgba(236,236,236,.1); }
  .story .demo b { display:block; font:500 14px/1.3 var(--sans); }
  body:has(#dive.on) .story, body:has(#panel.open) .story { opacity:0; pointer-events:none; }
  @media (max-width: 900px) { .story { left:16px; right:16px; width:auto; top:auto; bottom:76px; } .story .big { font-size:40px; } }

  .hud .hedgecard { right:24px; top:96px; width:300px; }
  .hud:has(.hedgecard) .strip a.hedge { display:none; }
  .hedgecard h4 { font:500 15px/1.3 var(--sans); margin:8px 0 0; }
  .hedgecard .late { display:flex; align-items:baseline; gap:10px; margin:10px 0 2px; }
  .hedgecard .late b { font:300 46px/1 var(--sans); letter-spacing:-.03em; color:var(--accent); font-variant-numeric:tabular-nums; }
  .hedgecard .late span { color:#a8a8a8; font:300 10px/1.3 var(--mono); letter-spacing:.16em; text-transform:uppercase; }
  .hedgecard .bar { height:3px; background:rgba(236,236,236,.14); border-radius:2px; overflow:hidden; margin:8px 0 12px; }
  .hedgecard .bar i { display:block; height:100%; background:var(--accent); transition:width .6s ease; }
  .hedgecard dl { display:grid; grid-template-columns:1fr auto; gap:6px 12px; margin:0; font:400 12.5px/1.3 var(--sans); }
  .hedgecard dt { color:#a8a8a8; } .hedgecard dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
  .hedgecard button.buy, .hedgecard a.buy { display:block; width:100%; margin-top:14px; padding:11px 12px; border-radius:10px; background:var(--accent); color:#fff;
    font:500 11.5px/1.2 var(--mono); letter-spacing:.14em; text-align:center; text-decoration:none; border:0; cursor:pointer; }
  .hedgecard button.buy:hover, .hedgecard a.buy:hover { background:#6aa0ff; }
  .hedgecard button.buy:disabled { opacity:.6; cursor:default; }
  .hedgecard .msg { margin-top:10px; font:400 12px/1.45 var(--sans); color:#cfcfcf; }
  .hedgecard .msg a { color:var(--accent); }
  .hedgecard .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .hedgecard .chips button { background:rgba(76,141,255,.14); border:1px solid rgba(76,141,255,.5); color:#f2f2f0; border-radius:16px; padding:6px 11px; font:400 12.5px/1.2 var(--sans); cursor:pointer; }
  .hedgecard .chips button:hover { background:var(--accent); }
  .hedgecard .chips small { color:#a8a8a8; margin-left:6px; font-size:10.5px; }
  .hedgecard .try { display:flex; gap:8px; margin-top:12px; }
  .hedgecard .try input { flex:1; min-width:0; background:rgba(236,236,236,.07); border:1px solid rgba(236,236,236,.16); border-radius:9px; padding:9px 10px; color:#f2f2f0; font:400 13px/1.2 var(--sans); outline:none; }
  .hedgecard .try input:focus { border-color:var(--accent); }
  .hedgecard .try button { background:var(--accent); color:#fff; border:0; border-radius:9px; padding:0 14px; font:500 11px/1 var(--mono); letter-spacing:.14em; cursor:pointer; }
  .hedgecard .ok { color:#35c97b; font:500 11px/1.3 var(--mono); letter-spacing:.16em; }
  @media (max-width: 1180px) { .hud .hedgecard { top:auto; bottom:24px; right:24px; } .hud:has(.hedgecard) .wx { display:none; } }
  @media (max-width: 820px) { .hud .hedgecard { left:16px; right:16px; width:auto; bottom:auto; top:150px; } }`;
document.head.appendChild(css);

/* ---------- the chain helpers (Xavi's web/chain), loaded only when a hedge is on screen ---------- */
let chainP = null;
const chain = () => chainP || (chainP = (async () => {
  const [mk, wl, cfg, lg] = await Promise.all([import('../chain/markets.js'), import('../chain/wallet.js'), import('../chain/config.js'), import('./ledger.js')]);
  return { mk, wl, cfg, lg, m: null, wallet: null };
})().catch(e => { chainP = null; throw e; }));
// the public RPC rate-limits (HTTP 429): try a read or a send a few times before giving up
const retry = async (fn, n = 3) => { let err; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { err = e; if (!/429|rate|limit|fetch|network|timeout/i.test(String(e && e.message || e))) break; await sleep(700 * (i + 1)); } } throw err; };
const wallet = async () => {
  const c = await chain();
  if (!c.wallet) {
    let kind = 'burner'; try { if (localStorage.getItem('headway.wallet.kind') === 'injected' && c.wl.hasInjected()) kind = 'injected'; } catch { /* burner */ }
    c.wallet = await c.wl.getWallet({ prefer: kind });
  }
  return c.wallet;
};

/* ---------- the price: same request as the markets page's hedge panel ---------- */
const etaDate = eta => {   // AIS ETA "MM-DD HH:MM" (UTC, year implied) as a Date, or null
  const m = /^(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(eta || ''); if (!m) return null;
  const now = new Date(); let t = Date.UTC(now.getUTCFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]);
  if (t < Date.now() - 180 * 864e5) t = Date.UTC(now.getUTCFullYear() + 1, +m[1] - 1, +m[2], +m[3], +m[4]);
  return new Date(t);
};
const openPrice = q => Number(q.quote.priorYesBps) / 1e4;
// MON to buy `cover` YES shares in the pool the quote opens (same maths as markets-page.js coverCost)
const coverCost = (q, cover) => {
  const s = Number(q.quote.seed) / 1e18, p = openPrice(q), f = Number(q.quote.feeBps) / 1e4;
  const a = p >= 0.5 ? s * (1 - p) / p : s, b = p >= 0.5 ? s : s * p / (1 - p);
  if (!(cover > 0) || cover >= a + b) return null;
  const k = a + b - cover;
  return (Math.sqrt(k * k + 4 * b * cover) - k) / 2 / (1 - f);
};
const stakeOf = q => {
  const cover = +(q.hedge && q.hedge.cover_mon) || 0, cost = cover > 0 ? coverCost(q, cover) : null;
  const s = cost != null ? cost * 1.02 : cover > 0 ? 0.05 : 0.01;
  return Math.min(0.05, Math.max(0.001, Math.ceil(s * 1e4) / 1e4));
};
const priceShip = async (ship, port) => {
  const c = await chain();
  const ask = deadline => c.mk.requestQuote({ ship: String(ship.imo || ship.mmsi || ship.name), port, deadline, cargoUsd: 500000, usdPerMon: USD_PER_MON });
  // deadline: the crew's own ETA when it's a sensible one, otherwise this time tomorrow
  const eta = etaDate(ship.eta), ms = eta ? eta.getTime() - Date.now() : 0;
  let deadline = ms > 2 * 3600e3 && ms < 12 * 864e5 ? eta : new Date(Math.ceil((Date.now() + 19 * 3600e3) / 3600e3) * 3600e3);
  let q = await ask(deadline);
  if (openPrice(q) >= TOO_LATE && q.model && q.model.expected_arrival) {   // the model already expects it late: move the deadline out
    deadline = new Date(Math.ceil((Date.parse(q.model.expected_arrival) + (+q.model.sigma_hours || 1) * 3600e3) / 3600e3) * 3600e3);
    if (deadline.getTime() > Date.now() + 3600e3) q = await ask(deadline);
  }
  return q;
};
const serverSays = e => {   // the server answers {"detail": "..."}; show that sentence
  let msg = String(e && e.message || e); const j = msg.match(/\{.*\}$/s);
  if (j) { try { msg = JSON.parse(j[0]).detail || msg; } catch { /* raw text */ } }
  return msg.replace(/^quote failed: \d+ /, '');
};

/* ---------- ports the model knows (IMF PortWatch, about 2,000), for suggestions ---------- */
let portsP = null;
const loadPorts = () => portsP || (portsP = (async () => {
  for (const u of ['../data/processed/portwatch_ports.json', `${HW.SERVER}/data/portwatch_ports.json`]) {
    try { const r = await fetch(u); if (r.ok) return (await r.json()).filter(p => p.name && isFinite(p.lat) && isFinite(p.lon)); } catch { /* next */ }
  }
  return [];
})());
const RADg = Math.PI / 180;
const nmBetween = (la1, lo1, la2, lo2) => { const a = Math.sin((la2 - la1) * RADg / 2) ** 2 + Math.cos(la1 * RADg) * Math.cos(la2 * RADg) * Math.sin((lo2 - lo1) * RADg / 2) ** 2; return 3440 * 2 * Math.asin(Math.sqrt(a)); };
const bearing = (la1, lo1, la2, lo2) => { const y = Math.sin((lo2 - lo1) * RADg) * Math.cos(la2 * RADg), x = Math.cos(la1 * RADg) * Math.sin(la2 * RADg) - Math.sin(la1 * RADg) * Math.cos(la2 * RADg) * Math.cos((lo2 - lo1) * RADg); return (Math.atan2(y, x) / RADg + 360) % 360; };
/* Ports worth offering for a ship whose own destination the model doesn't know: busy ports in the
   country its destination code names (US CDE -> United States) if it gives one, otherwise busy
   ports ahead of it on its course. Nearer and busier first. */
const suggestPorts = async (ship, dest) => {
  const all = await loadPorts(); if (!all.length) return [];
  const last = String(dest || '').split(/[>=]+/).pop().trim().toUpperCase(), m = /^([A-Z]{2}) ?[A-Z]{3}$/.exec(last), cc = m ? m[1] : null;
  const lat = +ship.lat, lon = +ship.lon, cog = ship.cog != null ? +ship.cog : null;
  let pool = cc ? all.filter(p => (p.locode || '').toUpperCase().startsWith(cc)) : [];
  const scored = (pool.length >= 2 ? pool : all).map(p => {
    const d = nmBetween(lat, lon, p.lat, p.lon); let off = cog == null ? 0 : Math.abs(bearing(lat, lon, p.lat, p.lon) - cog); if (off > 180) off = 360 - off;
    return { p, d, off, score: Math.sqrt((p.vessels || 0) + 50) / (d + 250) * (off <= 70 ? 1 : pool.length >= 2 ? 0.45 : 0.1) };
  }).filter(x => x.d > 3 && x.d < 9000).sort((a, b) => b.score - a.score);
  return scored.slice(0, 4).map(x => ({ name: x.p.name, code: x.p.locode || x.p.name, nm: Math.round(x.d) }));
};

/* ---------- the hedge card in the ship view ---------- */
let card = null, hs = null;   // hs: { ship, port, q, state, msg, done }
const quoteCache = new Map();
const marketsLink = s => `markets.html?hedge=${encodeURIComponent(s.ship.name || s.ship.mmsi || '')}${s.port ? '&port=' + encodeURIComponent(s.port) : ''}`;
const when = t => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
const paintHedge = () => {
  if (!card || !hs) return;
  const s = hs, q = s.q;
  const head = `<div class="tag">HEDGE THIS SHIP · LIVE PRICE ON MONAD</div>`;
  if (s.state === 'none') {   // no price: say why, and offer ports the model does know
    const sug = s.sug || [];
    card.innerHTML = `${head}<div class="msg">${esc(s.msg || 'This ship reports no destination, so there is no arrival to price.')}</div>
      ${sug.length ? `<div class="tag" style="margin-top:12px">${s.sugWhy || 'Price it to a port nearby instead'}</div><div class="chips">${sug.map(p => `<button data-port="${esc(p.code)}" data-name="${esc(p.name)}">${esc(p.name)}<small>${p.nm.toLocaleString('en-US')} nm</small></button>`).join('')}</div>` : ''}
      <div class="try"><input id="hcPort" list="hcPorts" placeholder="Or type any port" autocomplete="off"><button id="hcTry">PRICE</button></div>
      <datalist id="hcPorts">${(s.names || []).map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="msg" style="color:#8a8a8a">Arrival prices cover the 2,000 or so ports IMF PortWatch tracks. Start typing and pick one from the list.</div>`;
    return;
  }
  if (s.state === 'pricing' || !q) { card.innerHTML = `${head}<h4>Pricing a late arrival…</h4><div class="bar"><i style="width:35%"></i></div><div class="msg">Distance, speed, weather on the way and the wait at the port.</div>`; return; }
  const p = openPrice(q), md = q.model || {}, inp = md.inputs || {}, hg = q.hedge || {}, stake = stakeOf(q), fee = Number(q.quote.creationFee) / 1e18;
  const body = `${head}<h4>${esc(q.quote.question)}</h4>
    <div class="late"><b>${p < 0.01 ? '<1' : Math.round(p * 100)}%</b><span>chance it's late<br>${md.expected_arrival ? 'expected ' + esc(when(md.expected_arrival)) : ''}</span></div>
    <div class="bar"><i style="width:${Math.max(2, p * 100).toFixed(0)}%"></i></div>
    <dl>
      <dt>Pays if it's late</dt><dd>${(+hg.cover_mon || 0).toFixed(4)} MON</dd>
      <dt>Covers a loss of</dt><dd>$${Math.round(+hg.loss_usd || 0).toLocaleString('en-US')}</dd>
      <dt>Cover costs</dt><dd>${stake.toFixed(4)} MON</dd>
      <dt>Opening fee</dt><dd>${fee.toFixed(4)} MON</dd>
      ${inp.distance_nm != null ? `<dt>To go</dt><dd>${Math.round(inp.distance_nm)} nm at ${(+inp.speed_kn || 0).toFixed(1)} kn</dd>` : ''}
    </dl>`;
  if (s.done) {
    card.innerHTML = `${body}<div class="msg"><span class="ok">✓ COVER BOUGHT</span><br>Market #${s.done.id} is open on Monad${s.done.block ? ', block ' + Number(s.done.block).toLocaleString('en-US') : ''}, in ${s.done.secs.toFixed(1)} s.
      ${s.done.url ? `<a href="${s.done.url}" target="_blank" rel="noopener">View transaction</a>` : ''}</div><a class="buy" href="markets.html#trades">SEE IT IN MY TRADES →</a>`;
    return;
  }
  card.innerHTML = `${body}<button class="buy" id="hcBuy" ${s.state === 'buying' ? 'disabled' : ''}>${s.state === 'buying' ? 'OPENING THE MARKET…' : `BUY COVER · ${(stake + fee).toFixed(4)} MON`}</button>
    ${s.msg ? `<div class="msg">${s.msg}</div>` : ''}`;
};
const buy = async () => {
  const s = hs; if (!s || !s.q || s.state === 'buying' || s.done) return;
  s.state = 'buying'; s.msg = 'Getting the wallet ready…'; paintHedge();
  try {
    const c = await chain(), w = await wallet();
    if (!c.m) c.m = await retry(() => c.mk.markets());
    // a quote is only signed for a few minutes: get a fresh one if this one is about to run out
    if (Number(s.q.quote.expiry) * 1000 < Date.now() + 20e3) { s.q = await priceShip(s.ship, s.port); quoteCache.set(s.key, s.q); }
    const stake = stakeOf(s.q), need = stake + Number(s.q.quote.creationFee) / 1e18 + 0.02;
    const bal = await retry(() => w.balance()).then(b => Number(c.mk.formatMon(b, 6))).catch(() => null);
    if (bal != null && bal < need) throw new Error(`This wallet has ${bal.toFixed(3)} MON and the hedge needs about ${need.toFixed(3)}. <a href="${marketsLink(s)}">Open it on the markets page</a> to top up or use your own wallet.`);
    s.msg = 'Opening the market and buying the cover, one transaction…'; paintHedge();
    const t0 = performance.now();
    const r = await retry(() => c.m.create(w, s.q, { buyYes: true, stake: c.mk.parseMon(stake.toFixed(4)) }), 2);
    const tx = r.receipt.hash || r.receipt.transactionHash, shares = r.trade ? Number(c.mk.formatMon(r.trade.shares, 6)) : 0;
    try { c.lg.recordTrade(w.address, { kind: 'buy', id: Number(r.id), side: 'yes', q: s.q.quote.question, mon: stake, shares, tx }); } catch { /* My trades will book it from the chain */ }
    s.done = { id: Number(r.id), block: r.receipt.blockNumber, secs: (performance.now() - t0) / 1000, url: c.cfg.txUrl(tx) };
    s.state = 'quoted'; s.msg = ''; quoteCache.delete(s.key);
  } catch (e) {
    let c = null; try { c = await chain(); } catch { /* no helpers */ }
    const raw = String(e && e.message || e), busy = /429|rate limit/i.test(raw);
    s.state = 'quoted';
    s.msg = raw.includes('<a ') ? raw : busy ? `Monad's public node is busy right now. Press again in a moment, or <a href="${marketsLink(s)}">open it on the markets page</a>.`
      : `${esc(c ? c.mk.explain(e) : raw)} <a href="${marketsLink(s)}">Try it on the markets page</a>.`;
  }
  if (hs === s) paintHedge();
};
const addSuggestions = async s => {
  try {
    s.sug = await suggestPorts(s.ship, s.orig || s.port);
    const cc = /^([A-Z]{2}) ?[A-Z]{3}$/.exec(String(s.orig || s.port).split(/[>=]+/).pop().trim().toUpperCase());
    s.sugWhy = cc ? 'Busy ports in the same country' : 'Busy ports ahead of this ship';
    s.names = (await loadPorts()).slice().sort((a, b) => (b.vessels || 0) - (a.vessels || 0)).map(p => p.name);
  } catch { s.sug = []; }
};
const tryPort = () => { const el = document.getElementById('hcPort'), v = el && el.value.trim(); if (v && hs) showHedge({ ...hs.ship, destination: v }); };
const showHedge = async ship => {
  const hud = document.querySelector('#dive .hud'); if (!hud) return;
  if (!card) { card = document.createElement('div'); card.className = 'card hedgecard'; hud.appendChild(card); card.addEventListener('click', e => { if (e.target.closest('#hcBuy')) buy(); if (e.target.closest('#hcTry')) tryPort(); const chip = e.target.closest('[data-port]'); if (chip && hs) showHedge({ ...hs.ship, destination: chip.dataset.port, portName: chip.dataset.name }); });
    card.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && e.target.id === 'hcPort') tryPort(); });   /* typing here must not trigger the page's shortcut keys */ }
  const port = String(ship.destination || '').trim(), key = (ship.mmsi || ship.name) + '|' + port;
  const s = hs = { ship, port, key, q: null, state: 'pricing', msg: '', done: null, orig: ship.origDest || port };
  ship.origDest = s.orig;
  if (!port) { s.state = 'none'; paintHedge(); await addSuggestions(s); if (hs === s) paintHedge(); return; }
  const had = quoteCache.get(key);
  if (had && Number(had.quote.expiry) * 1000 > Date.now() + 30e3) { s.q = had; s.state = 'quoted'; return paintHedge(); }
  paintHedge();
  try { s.q = await priceShip(ship, port); quoteCache.set(key, s.q); s.state = 'quoted'; }
  catch (e) { const m = serverSays(e); s.state = 'none'; s.msg = /unknown port/i.test(m) ? `The pricing model doesn't know the port “${port}”.` : m; }
  if (s.state === 'none') { if (hs === s) paintHedge(); await addSuggestions(s); }
  if (hs === s) paintHedge();
};
window.addEventListener('headway:dive', e => showHedge(e.detail));

/* ---------- the story card on the globe: a slow tour of what's happening ---------- */
const ready = async () => { while (!window.__hw) await sleep(120); return window.__hw; };
const { globe, dive } = await ready();
// straits that still have ships (none at all this week is a data gap or a closed route, like Kerch), worst first
const lastWeek = s => { const w = s.weekly && s.weekly.total; return w ? w[w.length - 1] : 0; };
const ranked = globe.straits.filter(s => s.status.baseline_per_week >= 50 && lastWeek(s) > 0).map(s => ({ s, r: globe.straitRatio(s) })).filter(x => x.r > 0.005).sort((a, b) => a.r - b.r);
const worst = ranked[0];
let story = null, demoShip = null, at = 0, touring = true, tourT = null;
const TOUR_MS = 9000;
const straitItem = (x, tag) => {
  const s = x.s, drop = (x.r - 1) * 100;
  return { tag, title: s.name, big: `${drop >= 0 ? '+' : '−'}${Math.abs(Math.round(drop))}%`,
    text: `${HW.fInt(lastWeek(s))} ships went through this week. A normal 2023 week is ${HW.fInt(s.status.baseline_per_week)}.`,
    go: 'OPEN THE STRAIT →', lat: +s.lat, lon: +s.lon, zoom: 1.9, act: () => globe.select({ kind: 'strait', s }) };
};
const shipItem = (ship, tag) => ({ tag, title: ship.name || 'MMSI ' + ship.mmsi, big: ship.sog != null ? (+ship.sog).toFixed(1) + '<small> kn</small>' : '—',
  text: `${ship.g === 'tanker' ? 'Tanker' : 'Cargo ship'}${ship.destination ? ', bound for ' + esc(ship.portName || ship.destination) : ''}. Live position from AIS.`,
  go: 'DIVE TO THE SHIP AND HEDGE IT →', lat: +ship.lat, lon: +ship.lon, zoom: 3.2, act: () => dive(ship) });
const liveShip = () => {   // a big ship that's moving and says where it's going
  const list = (globe.S.ships || []).filter(s => s.name && s.destination && +s.length >= 250 && +s.sog >= 8);
  return list.length ? list[(Math.random() * list.length) | 0] : null;
};
const items = () => {
  const out = [];
  if (demoShip) out.push(shipItem(demoShip, 'Hedge a live ship'));
  if (ranked[0]) out.push(straitItem(ranked[0], ranked[0].r < 0.9 ? 'Biggest disruption this week' : 'Quietest strait this week'));
  const ls = liveShip(); if (ls && !demoShip) out.push(shipItem(ls, 'Live right now'));
  if (ranked[1] && ranked[1].r < 0.85) out.push(straitItem(ranked[1], 'Also disrupted'));
  const top = ranked[ranked.length - 1]; if (top && top.r > 1.08) out.push(straitItem(top, 'Busier than normal'));
  if (ranked[2] && ranked[2].r < 0.85) out.push(straitItem(ranked[2], 'Also disrupted'));
  return out;
};
let list = [];
const paintStory = () => {
  if (!story) return;
  if (!list.length) list = items();
  const it = list[at % list.length]; if (!it) return;
  story.innerHTML = `<div class="tag"><span>${esc(it.tag)}</span><span class="x" data-x title="Hide">×</span></div>
    <h3>${esc(it.title)}</h3><div class="big">${it.big}</div><p>${it.text}</p>
    <div class="go">${it.go}</div>
    <div class="steps">${list.map((_, i) => `<i data-i="${i}" class="${i === at % list.length ? 'on' : ''}"></i>`).join('')}</div>
    ${touring ? `<div class="prog"><i style="animation-duration:${TOUR_MS}ms"></i></div>` : ''}`;
};
const show = (i, fly = true) => {
  list = items(); at = ((i % list.length) + list.length) % list.length; paintStory();
  const it = list[at]; if (it && fly && !globe.S.sel && !document.querySelector('#dive.on')) globe.flyTo(it.lat, it.lon, it.zoom, null, 1.0);
};
const stopTour = () => { if (!touring) return; touring = false; clearInterval(tourT); paintStory(); };
if (worst) {
  const st = document.createElement('style');
  st.textContent = `.story .big small { font-size:20px; color:#a8a8a8; letter-spacing:0; }
    .story .steps { display:flex; gap:6px; margin-top:12px; } .story .steps i { width:14px; height:3px; border-radius:2px; background:rgba(236,236,236,.2); cursor:pointer; }
    .story .steps i.on { background:var(--accent); width:26px; }
    .story .prog { position:absolute; left:0; right:0; bottom:0; height:2px; overflow:hidden; border-radius:0 0 14px 14px; }
    .story .prog i { display:block; height:100%; width:100%; background:var(--accent); opacity:.7; transform-origin:left; animation:story-prog linear forwards; }
    @keyframes story-prog { from { transform:scaleX(0); } to { transform:scaleX(1); } }`;
  document.head.appendChild(st);
  story = document.createElement('div'); story.className = 'story'; story.setAttribute('role', 'button');
  $('app') ? $('app').appendChild(story) : document.body.appendChild(story);
  paintStory();
  story.addEventListener('click', e => {
    if (e.target.closest('[data-x]')) { stopTour(); story.remove(); story = null; return; }
    const step = e.target.closest('[data-i]');
    if (step) { stopTour(); show(+step.dataset.i); return; }
    stopTour(); const it = list[at]; if (it) it.act();
  });
  // the tour stops for good the moment you take the globe yourself
  const g = $('globe'); if (g) { g.addEventListener('pointerdown', stopTour); g.addEventListener('wheel', stopTour, { passive: true }); }
  // once the intro has cleared: turn the globe to the first stop, show the card, then move on every 9 s
  const start = () => {
    show(0); setTimeout(() => story && story.classList.add('in'), 900);
    tourT = setInterval(() => { if (!story || !touring || document.hidden || story.matches(':hover') || globe.S.sel || document.querySelector('#dive.on')) return; show(at + 1); }, TOUR_MS);
  };
  const intro = $('intro');
  if (!intro) start();
  else new MutationObserver((_, obs) => { if (!document.body.contains(intro) || intro.classList.contains('out')) { obs.disconnect(); setTimeout(start, 600); } }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

/* ---------- demo mode: a ship the server can price, and a wallet that's already funded ---------- */
if (DEMO) (async () => {
  for (const [name, portName] of DEMO_SHIPS) {
    try {
      const s = await HW.findShip(name); if (!s) continue;
      const ship = { ...s, g: s.type_group, destination: s.destination || portName, portName };
      const q = await priceShip(ship, ship.destination);
      quoteCache.set((ship.mmsi || ship.name) + '|' + String(ship.destination).trim(), q);
      if (!demoShip || (openPrice(q) > 0.05 && openPrice(q) < TOO_LATE)) demoShip = ship;
      if (openPrice(q) > 0.05 && openPrice(q) < TOO_LATE) break;   // a price worth showing
    } catch { /* try the next ship */ }
  }
  if (story) show(0, !!touring);
  // the test wallet and its faucet MON, and the contract address, before anyone clicks
  try { const c = await chain(); await wallet(); if (!c.m) c.m = await retry(() => c.mk.markets()); } catch (e) { console.warn('demo warm-up', e); }
})();
window.__hw.story = { showHedge, get hs() { return hs; }, get demoShip() { return demoShip; } };
