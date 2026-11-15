/* Wires the page together: intro, overview strip, globe, replay timeline, markets,
   the detail panel, ship search and the dive into the ship scene. */

import { recordTrade } from './ledger.js';   // what each trade cost, for "My trades" on the markets page

const HW = window.HW, C = HW.C;
const $ = id => document.getElementById(id);
const VESSELS = [['container', C.container, 'CONTAINER'], ['tanker', C.tanker, 'TANKER'], ['dry_bulk', C.bulk, 'DRY BULK'], ['general_cargo', C.general, 'GENERAL'], ['roro', C.roro, 'RO-RO']];

/* ---------- intro and brand ---------- */
// fall back to the static logo if an old cached logo.js has no glyphIntro
const intro = (HW.glyphIntro || HW.glyphLogo)($('introcv'), { step: 12, bg: C.bg });
const introStart = performance.now();

/* ---------- chain (Xavi's web/chain): used when it's merged in and contracts are deployed ---------- */
let chain = null;
const loadChain = async () => {
  try {
    const dep = await import('../chain/deployments.js').catch(() => import('./chain/deployments.js'));
    if (!dep.DEPLOYMENTS) return null;
    const mk = await import('../chain/markets.js').catch(() => import('./chain/markets.js'));
    const wl = await import('../chain/wallet.js').catch(() => import('./chain/wallet.js'));
    const m = await mk.markets();
    return { mk, wl, m, wallet: null };
  } catch { return null; }
};

/* ---------- boot ---------- */
let panelItem = null;
let D, globe, scene, weeks, nW, markets = { list: [], source: 'seeds' }, mGroup = 'live';
try {
  D = await HW.loadAll();
} catch (e) {
  $('introtag').textContent = 'COULD NOT LOAD DATA · ' + String(e.message || e).toUpperCase().slice(0, 80);
  throw e;
}
weeks = D.status.weeks; nW = weeks.length;
$('introtag').textContent = `SYS.ROUTES: ${D.corridors.features.length} · STRAITS: ${D.straits.length} · DATA TO ${HW.fDate(D.overview.as_of)}`;

globe = HW.makeGlobe($('globe'), D, { onSelect: item => showPanel(item) });
// the 3D ship scene (js/ship3d.js, three.js) when WebGL works; the 2D one otherwise
const webglOK = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
scene = (HW.makeShipScene3D && webglOK ? HW.makeShipScene3D : HW.makeShipScene)($('shipcv'));

// let the logo play for a moment, then reveal the globe
setTimeout(() => { $('intro').classList.add('out'); setTimeout(() => { intro.stop(); $('intro').remove(); $('overview').classList.add('in'); }, 1000); }, Math.max(0, 3800 - (performance.now() - introStart)));

/* ---------- live ships ---------- */
const refreshShips = async () => {
  try {
    const ships = await HW.loadShips();
    globe.setShips(ships);
    D.liveMain = globe.S.ships.length;   // cargo ships and tankers underway (the globe keeps only those)
    $('sysShips').textContent = HW.fInt(D.liveMain);
    $('sysLive').classList.remove('off');
    renderOverview(true);
  } catch { $('sysLive').classList.add('off'); }
};
refreshShips(); setInterval(refreshShips, 60000);

/* ---------- overview strip ---------- */
const lane = id => globe.lanes.find(L => L.id === id);
const EA_NE = lane('east_asia__north_europe');
const strait = name => globe.straits.find(s => s.name === name);
const weeklyAt = (s, k, i) => { const w = s.weekly, j = HW.clamp(i - (nW - w.total.length), 0, w.total.length - 1); return w[k][j]; };
let lastOverviewWeek = -1;
const renderOverview = force => {
  const i = Math.round(globe.S.ti);
  if (i === lastOverviewWeek && !force) return;
  lastOverviewWeek = i;
  const idx = D.index.world, eff = idx[HW.clamp(i, 0, idx.length - 1)];
  // the most disrupted strait right now, among the ones with real traffic
  const worst = globe.straits.filter(s => s.status.baseline_per_week >= 50).map(s => ({ s, r: globe.straitRatio(s) })).sort((a, b) => a.r - b.r)[0];
  const cells = [
    ['lead', 'WORLD ROUTE EFFICIENCY', eff.toFixed(2), '1.00 = every route normal'],
    ['', 'CARGO SHIPS + TANKERS UNDERWAY', D.liveMain ? HW.fInt(D.liveMain) : '—', 'Live, from the free AIS feed'],
    ['', 'MOST DISRUPTED STRAIT', worst ? HW.fPct((worst.r - 1) * 100) : '—', worst ? `${worst.s.name} vs a normal 2023 week` : ''],
  ];
  $('overview').innerHTML = cells.map(([cls, k, v, sub], n) => `<div class="cell ${cls}"${n === 2 && worst ? ` data-strait="${HW.esc(worst.s.name)}"` : ''}><div class="tag">${k}</div><div class="num">${v}</div><div class="sub">${sub}</div></div>`).join('');
};
renderOverview(true);

/* ---------- right now: the page always shows the latest week ---------- */
const setWeek = () => { globe.setWeek(nW - 1); renderOverview(); if (panelItem) showPanel(panelItem, true); };
setWeek();

/* ---------- globe controls: buttons, the go-to list and keys ---------- */
const ACT = {
  zin: () => globe.zoomBy(1.5), zout: () => globe.zoomBy(1 / 1.5),
  left: () => globe.turn(-30), right: () => globe.turn(30),
  up: () => globe.tilt(20), down: () => globe.tilt(-20),
  rollL: () => globe.roll(-45), rollR: () => globe.roll(45),
  north: () => globe.northUp(), flip: () => globe.flip(),
  spin: () => { globe.setAutoSpin(!globe.S.autoSpin); document.querySelector('[data-a="spin"]').classList.toggle('on', globe.S.autoSpin); },
  home: () => globe.home(),
};
$('ctl').addEventListener('click', e => { const b = e.target.closest('button[data-a]'); if (b) ACT[b.dataset.a](); });
$('goto').innerHTML += globe.straits.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => `<option>${HW.esc(s.name)}</option>`).join('');
$('goto').addEventListener('change', e => { const s = strait(e.target.value); if (s) globe.select({ kind: 'strait', s }); e.target.value = ''; e.target.blur(); });
const KEYS = { '+': 'zin', '=': 'zin', '-': 'zout', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '[': 'rollL', ']': 'rollR', n: 'north', N: 'north', f: 'flip', F: 'flip', r: 'home', R: 'home', ' ': 'spin' };
document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || $('dive').classList.contains('on')) return;
  const a = KEYS[e.key]; if (a) { e.preventDefault(); ACT[a](); }
});
$('overview').addEventListener('click', e => { const c = e.target.closest('[data-strait]'); if (c) globe.select({ kind: 'strait', s: strait(c.dataset.strait) }); });

/* ---------- light / dark, and the markets drawer ---------- */
const themeBtn = () => { $('theme').textContent = HW.C.theme === 'light' ? '☾' : '☀'; };
themeBtn();
$('theme').addEventListener('click', () => { HW.setTheme(HW.C.theme === 'light' ? 'dark' : 'light'); themeBtn(); if (HW.drawLogo) HW.drawLogo($('brandcv')); if (panelItem) showPanel(panelItem, true); });
$('mtoggle').addEventListener('click', () => {
  const open = !document.body.classList.toggle('nomarkets');
  $('mtoggle').setAttribute('aria-expanded', open); $('mtoggle').classList.toggle('on', open);
});
$('mtoggle').classList.add('on');

/* ---------- detail panel ---------- */
const mixBar = shares => `<div class="mix">${shares.map((x, k) => `<i style="width:${(x * 100).toFixed(1)}%;background:${VESSELS[k][1]}"></i>`).join('')}</div><div class="key">${VESSELS.map(([, c, l], k) => `<span><i style="background:${c}"></i>${l} ${Math.round(shares[k] * 100)}%</span>`).join('')}</div>`;
const relatedMarkets = pred => markets.list.filter(pred).slice(0, 3).map(m => `<p style="font-size:12.5px">${HW.esc(m.question)}</p>`).join('');
const showPanel = (item, quiet) => {
  panelItem = item;
  const p = $('panel'), b = $('pbody');
  if (!item) { p.classList.remove('open'); return; }
  const i = Math.round(globe.S.ti);
  if (item.kind === 'strait') {
    const s = item.s, r = globe.straitRatio(s), mix = globe.straitMix(s);
    const lanesThrough = globe.lanes.filter(L => (L.p.chokepoints || []).includes(s.name));
    b.innerHTML = `<div class="tag">STRAIT · THIS WEEK</div><h2>${HW.esc(s.name)}</h2>
      <div class="stats">
        <div><b>${HW.fPct((r - 1) * 100)}</b><span>VS A NORMAL 2023 WEEK</span></div>
        <div><b>${HW.fInt(weeklyAt(s, 'total', i))}</b><span>SHIPS THIS WEEK</span></div>
        <div><b>${HW.fInt(s.status.baseline_per_week)}</b><span>SHIPS IN A NORMAL WEEK</span></div>
        <div><b>${lanesThrough.length}</b><span>ROUTES THROUGH IT</span></div>
      </div>
      <h3>WHO GOES THROUGH</h3>${mixBar(mix)}
      <h3>MARKETS</h3>${relatedMarkets(m => (m.series || '').includes(s.name) || (m.gate && D.gates.chokepoint_gate && D.gates.chokepoint_gate[s.name] === m.gate)) || '<p>No open market on this strait yet.</p>'}`;
  } else if (item.kind === 'lane') {
    const L = item.L, ri = HW.clamp(i + globe.rOff, 0, L.r.expected_days.length - 1);
    const days = L.r.expected_days[ri], eff = L.r.efficiency[ri], blk = L.r.blocked_share[ri];
    b.innerHTML = `<div class="tag">ROUTE · THIS WEEK</div><h2>${HW.esc(L.p.region_a)} → ${HW.esc(L.p.region_b)}</h2>
      <div class="stats">
        <div><b>${days.toFixed(1)} d</b><span>EXPECTED TRANSIT</span></div>
        <div><b>${L.r.normal_days.toFixed(1)} d</b><span>WHEN EVERYTHING'S OPEN</span></div>
        <div><b>${eff.toFixed(2)}</b><span>EFFICIENCY</span></div>
        <div><b>${Math.round(blk * 100)}%</b><span>TRAFFIC BLOCKED</span></div>
      </div>
      <h3>PASSES THROUGH</h3><p>${(L.p.chokepoints || []).map(HW.esc).join(' · ') || 'Open water only'}</p>
      <h3>MARKETS</h3>${relatedMarkets(m => (m.series || '').includes(L.id)) || '<p>No open market on this route yet.</p>'}`;
  } else if (item.kind === 'ship') {
    const s = item.ship, g = s.g || s.type_group || HW.vesselGroup(s.type);
    b.innerHTML = `<div class="tag"><span class="dot" style="background:${HW.groupColour(g)}"></span>${HW.groupLabel(g)} · UNDERWAY</div><h2>${HW.esc(s.name || 'MMSI ' + s.mmsi)}</h2>
      <div class="stats">
        <div><b>${s.sog != null ? (+s.sog).toFixed(1) + ' kn' : '—'}</b><span>SPEED</span></div>
        <div><b>${s.cog != null ? Math.round(s.cog) + '°' : '—'}</b><span>COURSE</span></div>
        <div><b>${HW.esc(s.destination || '—')}</b><span>DESTINATION</span></div>
        <div><b>${HW.esc(s.eta || '—')}</b><span>ETA</span></div>
      </div>
      <p class="fine">IMO ${HW.esc(s.imo || '—')} · MMSI ${HW.esc(s.mmsi)} · ${(+s.lat).toFixed(3)}, ${(+s.lon).toFixed(3)}</p>
      <button class="cta" id="diveBtn">DIVE TO SHIP</button>
      <a class="cta" style="text-decoration:none;margin-top:8px" href="markets.html?hedge=${encodeURIComponent(s.name || s.mmsi)}&port=${encodeURIComponent(s.destination || '')}">HEDGE THIS SHIP</a>`;
    $('diveBtn').addEventListener('click', () => dive(s));
  }
  p.classList.add('open');
  if (!quiet) p.scrollTop = 0;
};
$('px').addEventListener('click', () => globe.select(null));

/* ---------- markets ---------- */
const liveState = {};   // live gate counts by market id
const windowStart = minutes => { const now = Date.now(), ms = minutes * 60000; return new Date(Math.floor(now / ms) * ms); };
const renderMarkets = () => {
  const list = markets.list.filter(m => (m.group || 'route') === mGroup);
  $('mlist').innerHTML = list.map(m => {
    const live = m.group === 'live', st = liveState[m.id];
    const p = m.probYes != null ? m.probYes : live && m.historical_yes_share != null ? m.historical_yes_share : 0.5;
    const tagCol = m.group === 'weekly' ? C.fg : C.dim;
    let meta = '';
    if (live) {
      // the server says when this window stops taking trades; fall back to the clock-aligned window
      const tr = m.live && m.live.trading, cn = m.live && m.live.counting, mins = +m.minutes || 30;
      // count down to closes (when positions close, from the server), then the window's trading close, then the clock
      const end = m.closes ? Date.parse(m.closes) : tr && tr.trading_closes ? Date.parse(tr.trading_closes) : windowStart(mins).getTime() + mins * 60000;
      const left = Math.max(0, end - Date.now());
      const count = cn && cn.count_so_far != null ? cn.count_so_far + ' / ' + (cn.threshold ?? m.threshold) + ' CROSSED' : st ? st.count + ' / ' + m.threshold + ' CROSSED' : m.chainId == null ? 'NOT OPEN YET' : 'COUNTING…';
      meta = `<span class="tag">${count}</span><span class="tag">${m.chainId == null && !tr ? '' : left > 0 ? Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0') + ' LEFT' : 'CLOSED'}</span>`;
    } else meta = `<span class="tag" style="color:${tagCol}">${(m.group || '').toUpperCase()}</span><span class="tag">${m.closes ? 'CLOSES ' + HW.fDate(m.closes) : ''}</span>`;
    const can = !!(chain && m.chainId != null);
    return `<div class="mcard" data-id="${HW.esc(m.id)}"><div class="meta">${meta}</div><div class="q">${HW.esc(m.question)}</div>
      <div class="odds"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
      <div class="row"><span class="p">${Math.round(p * 100)}%</span><span class="tag">YES</span>
        <button class="y" data-side="yes" ${can ? '' : 'disabled'}>YES</button><button data-side="no" ${can ? '' : 'disabled'}>NO</button></div></div>`;
  }).join('') || '<p class="note">No markets in this group.</p>';
  $('mnote').textContent = chain ? 'Positions settle onchain on Monad testnet.' : markets.source === 'server' ? 'Markets from the server. Trading opens once the contracts are deployed.' : 'Seed markets with thresholds from the data. Trading opens once the contracts are deployed.';
};
document.querySelectorAll('#mtabs button').forEach(b => b.addEventListener('click', () => {
  mGroup = b.dataset.g; document.querySelectorAll('#mtabs button').forEach(o => o.classList.toggle('on', o === b)); renderMarkets();
}));
$('mlist').addEventListener('click', async e => {
  const card = e.target.closest('.mcard'); if (!card) return;
  const m = markets.list.find(x => x.id === card.dataset.id); if (!m) return;
  const btn = e.target.closest('button[data-side]');
  if (btn && chain) {
    btn.textContent = '…';
    try {
      if (!chain.wallet) chain.wallet = await chain.wl.getWallet();
      const yes = btn.dataset.side === 'yes', r = await chain.m.buy(chain.wallet, m.chainId, yes, chain.mk.parseMon('0.01'));
      if (r.trade) recordTrade(chain.wallet.address, { kind: 'buy', id: Number(m.chainId), side: yes ? 'yes' : 'no', q: m.question, mon: 0.01, shares: Number(chain.mk.formatMon(r.trade.shares, 6)), tx: r.receipt.hash });
      await syncChainOdds();
    } catch (err) { alert(chain.mk.explain ? chain.mk.explain(err) : String(err)); }
    renderMarkets();
    return;
  }
  // otherwise, show what the market is about on the globe
  const series = m.series || '';
  const sName = series.startsWith('portwatch:') ? series.split(':')[1] : null;
  const lId = series.startsWith('route_efficiency:') ? series.split(':')[1] : null;
  if (sName && strait(sName)) globe.select({ kind: 'strait', s: strait(sName) });
  else if (lId && lane(lId)) globe.select({ kind: 'lane', L: lane(lId) });
  else if (m.gate) {
    const gl = D.gates.lines.find(g => g.id === m.gate) || D.gates.boxes.find(g => g.id === m.gate);
    if (gl) { const lat = gl.a ? (gl.a[1] + gl.b[1]) / 2 : (gl.lat[0] + gl.lat[1]) / 2, lon = gl.a ? (gl.a[0] + gl.b[0]) / 2 : (gl.lon[0] + gl.lon[1]) / 2; globe.flyTo(lat, lon, 5.5); }
  }
});
const pollLive = async () => {
  for (const m of markets.list.filter(x => x.group === 'live')) {
    try {
      const since = windowStart(+m.minutes || 30).toISOString();
      const r = await fetch(`${HW.SERVER}/api/gates/${m.gate}/count?since=${encodeURIComponent(since)}`);
      if (r.ok) { const d = await r.json(); liveState[m.id] = { count: d.count }; }
    } catch { /* server unreachable: card keeps "counting" */ }
  }
  if (mGroup === 'live') renderMarkets();
};
const syncChainOdds = async () => {
  if (!chain) return;
  const onchain = await chain.m.list();
  for (const m of markets.list) {
    // The server already knows which onchain market each card is (Ben's keeper opens them),
    // so its chainId wins. Matching by question/series is only a fallback for markets it hasn't
    // paired, because several markets share a series and old live windows linger onchain.
    if (m.serverChainId != null) {
      const c = onchain.find(x => BigInt(x.id) === BigInt(m.serverChainId));
      m.chainId = m.serverChainId;
      if (c && c.probYes != null) m.probYes = c.probYes;
      continue;
    }
    const c = chain.mk.findMarket(onchain, m);
    if (c) { m.chainId = c.id; m.probYes = c.probYes; }
  }
};
// Refresh the list from the server: live windows roll every 30 minutes into new onchain
// markets, and the keeper opens new ones, so chainId, probYes and closes change under us.
const remember = list => list.forEach(m => { if (m.chainId != null) m.serverChainId = m.chainId; });
const refreshMarkets = async () => {
  if (markets.source !== 'server') return;
  try {
    const fresh = await HW.loadMarkets(D.seeds);
    if (fresh.source !== 'server') return;
    remember(fresh.list);
    const byId = new Map(markets.list.map(m => [m.id, m]));
    markets.list = fresh.list.map(f => {
      const old = byId.get(f.id);
      // keep a newer onchain probability from the live feed if the server hasn't caught up
      return old && f.serverChainId === old.serverChainId && f.probYes == null ? { ...f, probYes: old.probYes } : f;
    });
    await syncChainOdds().catch(() => {});
    renderMarkets();
  } catch { /* keep what we have */ }
};
(async () => {
  markets = await HW.loadMarkets(D.seeds);
  remember(markets.list);
  chain = await loadChain();
  if (chain) {
    await syncChainOdds().catch(() => {}); $('wallet').textContent = 'WALLET';
    // live odds: one callback per trade from anyone, so the bars move while people trade
    try {
      const ev = await import('../chain/events.js').catch(() => import('./chain/events.js'));
      ev.watchOdds(({ id, probYes, resolved }) => {
        const m = markets.list.find(x => x.chainId != null && BigInt(x.chainId) === BigInt(id));
        if (!m) return syncChainOdds().then(renderMarkets);
        if (probYes != null) m.probYes = probYes;
        if (resolved) syncChainOdds().then(renderMarkets); else renderMarkets();
      });
    } catch { /* no live feed: odds still refresh after each trade */ }
  }
  else $('wallet').title = 'Contracts are not deployed yet';
  renderMarkets(); pollLive();
  setInterval(pollLive, 20000);
  setInterval(refreshMarkets, 30000);
  setInterval(() => { if (mGroup === 'live') renderMarkets(); }, 1000);
})();
$('wallet').addEventListener('click', async () => {
  if (!chain) { $('wallet').textContent = 'CONTRACTS NOT DEPLOYED YET'; setTimeout(() => $('wallet').textContent = 'CONNECT WALLET', 2200); return; }
  try { chain.wallet = await chain.wl.getWallet(); const a = chain.wallet.address || ''; $('wallet').textContent = a.slice(0, 6) + '…' + a.slice(-4); } catch (e) { $('wallet').textContent = 'WALLET ERROR'; }
});

/* ---------- find your ship ---------- */
$('search').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  $('qerr').textContent = '…';
  const s = await HW.findShip(q);
  if (!s) { $('qerr').textContent = 'NOT FOUND'; return; }
  $('qerr').textContent = '';
  const ship = { ...s, g: s.type_group };
  globe.flyTo(+s.lat, +s.lon, 5);
  globe.select({ kind: 'ship', ship });
});

/* ---------- the dive ---------- */
const SKY = c => c === 0 ? 'CLEAR' : c <= 2 ? 'PARTLY CLOUDY' : c === 3 ? 'OVERCAST' : c === 45 || c === 48 ? 'FOG' : c <= 57 ? 'DRIZZLE' : c <= 67 ? 'RAIN' : c <= 77 ? 'SNOW' : c <= 82 ? 'SHOWERS' : c <= 86 ? 'SNOW SHOWERS' : 'THUNDERSTORM';
const COMPASS = d => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((+d % 360) + 360) % 360 / 45) % 8];
const dive = async ship => {
  const lat = +ship.lat, lon = +ship.lon;
  globe.flyTo(lat, lon, 9, null, 2.2);
  const wxP = HW.weatherAt(lat, lon).catch(() => null);
  await new Promise(r => setTimeout(r, 1500));
  $('dive').classList.add('on');
  scene.open(ship, null);
  renderHUD(ship, null);
  const w = await wxP;
  if (w) { scene.setWeather(w); renderHUD(ship, w); }
  setTimeout(() => $('cross').classList.add('on'), 2400);
};
const renderHUD = (s, w) => {
  const g = s.g || s.type_group || HW.vesselGroup(s.type), kind = scene.S.kind;
  renderStrip(s, w);
  $('ident').innerHTML = `<div class="tag"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${HW.groupColour(g)};margin-right:7px"></span>${HW.groupLabel(g)}</div>
    <h2>${HW.esc(s.name || 'MMSI ' + s.mmsi)}</h2><div class="tag">${s.destination ? 'BOUND FOR ' + HW.esc(s.destination) : 'NO DESTINATION REPORTED'}</div>
    <div class="grid">
      <div><b>${s.sog != null ? (+s.sog).toFixed(1) + ' kn' : '—'}</b><span>SPEED</span></div>
      <div><b>${s.cog != null ? Math.round(s.cog) + '° ' + COMPASS(s.cog) : '—'}</b><span>COURSE</span></div>
      <div><b>${s.length ? s.length + ' m' : '—'}</b><span>LENGTH</span></div>
      <div><b>${s.draught ? s.draught + ' m' : '—'}</b><span>DRAUGHT</span></div>
      <div><b>${HW.esc(s.eta || '—')}</b><span>ETA</span></div>
      <div><b>${(+s.lat).toFixed(2)}, ${(+s.lon).toFixed(2)}</b><span>POSITION</span></div>
    </div>`;
  if (!w) { $('wx').innerHTML = '<div class="tag">WEATHER AT THE SHIP</div><p style="color:#bbb;font:13px var(--sans);margin:10px 0 0">Loading live conditions…</p>'; }
  else {
    const f = (v, u, d = 1) => v == null ? '—' : (+v).toFixed(d) + u;
    $('wx').innerHTML = `<div class="tag">WEATHER AT THE SHIP · LIVE</div>
      <div class="num" style="margin-top:8px">${SKY(+w.weather_code)}${w.is_day === 0 ? ' · NIGHT' : ''}</div>
      <div class="grid">
        <div><b>${f(w.wind_speed_10m, ' kn')}</b><span>WIND FROM ${w.wind_direction_10m != null ? COMPASS(w.wind_direction_10m) : '—'}</span></div>
        <div><b>${f(w.wind_gusts_10m, ' kn')}</b><span>GUSTS</span></div>
        <div><b>${f(w.wave_height, ' m')}</b><span>WAVES</span></div>
        <div><b>${f(w.swell_wave_height, ' m')}</b><span>SWELL</span></div>
        <div><b>${f(w.sea_surface_temperature, '°C')}</b><span>SEA</span></div>
        <div><b>${f(w.temperature_2m, '°C')}</b><span>AIR</span></div>
      </div>
      <div class="tag" style="margin-top:12px;letter-spacing:.1em">OPEN-METEO · DRAWN AS ${kind === 'cargo' ? 'CONTAINER SHIP' : kind.toUpperCase()}</div>`;
  }
  // compass: north up, ship course and where the wind comes from
  const cog = s.cog != null ? +s.cog : 0, wd = w && w.wind_direction_10m != null ? +w.wind_direction_10m : null;
  // the drone view keeps the bow pointing up, so the compass card turns with the ship
  $('compass').innerHTML = `<g transform="rotate(${-cog} 31 31)"><circle cx="31" cy="31" r="28" fill="none" stroke="#ececec" stroke-opacity=".35"/><text x="31" y="11" fill="#ececec" font-size="8" text-anchor="middle" font-family="${HW.MONO}">N</text>
    <line x1="31" y1="31" x2="${31 + 22 * Math.sin(cog * Math.PI / 180)}" y2="${31 - 22 * Math.cos(cog * Math.PI / 180)}" stroke="${HW.groupColour(g)}" stroke-width="2"/>
    ${wd != null ? `<line x1="${31 + 26 * Math.sin(wd * Math.PI / 180)}" y1="${31 - 26 * Math.cos(wd * Math.PI / 180)}" x2="${31 + 14 * Math.sin(wd * Math.PI / 180)}" y2="${31 - 14 * Math.cos(wd * Math.PI / 180)}" stroke="#ececec" stroke-dasharray="2 2"/>` : ''}</g>`;
};
/* the strip of big readouts along the bottom of the ship view */
const BEAUFORT = [[1, 'CALM'], [4, 'LIGHT AIR'], [7, 'LIGHT BREEZE'], [11, 'GENTLE BREEZE'], [17, 'MODERATE BREEZE'], [22, 'FRESH BREEZE'], [28, 'STRONG BREEZE'], [34, 'NEAR GALE'], [41, 'GALE'], [48, 'STRONG GALE'], [56, 'STORM'], [64, 'VIOLENT STORM'], [1e9, 'HURRICANE']];
const SEA = [[0.1, 'GLASSY'], [0.5, 'RIPPLED'], [1.25, 'SLIGHT'], [2.5, 'MODERATE'], [4, 'ROUGH'], [6, 'VERY ROUGH'], [9, 'HIGH'], [14, 'VERY HIGH'], [1e9, 'PHENOMENAL']];
const sunElev = (lat, lon) => {   // degrees above the horizon at the ship, right now
  const RAD = Math.PI / 180, d = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * RAD, L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD, e = 23.439 * RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const ha = (280.46061837 + 360.98564736629 * d) * RAD + lon * RAD - ra, la = lat * RAD;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / RAD;
};
const etaHours = eta => {   // AIS ETA is "MM-DD HH:MM" in UTC, year implied
  const m = /^(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(eta || ''); if (!m) return null;
  const now = new Date(); let t = Date.UTC(now.getUTCFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]);
  if (t < Date.now() - 180 * 864e5) t = Date.UTC(now.getUTCFullYear() + 1, +m[1] - 1, +m[2], +m[3], +m[4]);
  return (t - Date.now()) / 3600e3;
};
let hudShip = null;
const renderStrip = (s, w) => {
  hudShip = s;
  const kn = s.sog != null ? +s.sog : null, wind = w && w.wind_speed_10m != null ? +w.wind_speed_10m : null, wave = w && w.wave_height != null ? +w.wave_height : null;
  const bf = wind == null ? null : BEAUFORT.findIndex(([v]) => wind < v);
  const sea = wave == null ? null : SEA.findIndex(([v]) => wave < v);
  const el = sunElev(+s.lat, +s.lon), eh = etaHours(s.eta);
  const dest = (s.destination || '').trim();
  const cell = (big, unit, label, sub) => `<div><b>${big}${unit ? `<small>${unit}</small>` : ''}</b><span>${label}</span>${sub ? `<em>${sub}</em>` : ''}</div>`;
  $('strip').innerHTML =
    cell(kn != null ? kn.toFixed(1) : '—', 'kn', 'Speed', kn != null ? (kn * 1.852).toFixed(0) + ' km/h · ' + (kn * 24).toFixed(0) + ' nm a day' : '') +
    cell(bf != null ? bf : '—', '', 'Beaufort', bf != null ? BEAUFORT[bf][1] : 'loading') +
    cell(sea != null ? sea : '—', '', 'Sea state', sea != null ? SEA[sea][1] + ' · ' + wave.toFixed(1) + ' m' : 'loading') +
    cell(el.toFixed(0) + '°', '', 'Sun height', el > 0 ? 'Day at the ship' : el > -6 ? 'Twilight' : 'Night at the ship') +
    cell(eh == null ? '—' : eh < 0 ? 'DUE' : eh < 48 ? eh.toFixed(0) : (eh / 24).toFixed(1), eh == null || eh < 0 ? '' : eh < 48 ? 'h' : 'd', 'To ETA', eh == null ? 'no ETA reported' : eh < 0 ? 'past its reported ETA' : (dest ? 'to ' + HW.esc(dest).slice(0, 18) : '')) +
    `<a class="hedge" href="markets.html?hedge=${encodeURIComponent(s.name || '')}${dest ? '&port=' + encodeURIComponent(dest) : ''}"><b>HEDGE THIS SHIP →</b><span>Cover a late arrival</span></a>`;
};
setInterval(() => {
  if (!scene.S.on || !hudShip) return;
  const now = new Date(), local = new Date(now.getTime() + (+hudShip.lon / 15) * 3600e3);
  const f = d => String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  $('hudClock').innerHTML = `UTC ${f(now)} · LOCAL ${f(local)}<br>${(+hudShip.lat).toFixed(3)}°, ${(+hudShip.lon).toFixed(3)}°`;
}, 1000);
document.querySelectorAll('#cams button').forEach(b => b.addEventListener('click', () => {
  scene.setMode(b.dataset.m); document.querySelectorAll('#cams button').forEach(o => o.classList.toggle('on', o === b));
}));
$('back').addEventListener('click', () => {
  scene.close(); $('dive').classList.remove('on'); $('cross').classList.remove('on');
  document.querySelectorAll('#cams button').forEach(o => o.classList.toggle('on', o.dataset.m === 'top'));
  globe.zoomBy(0.35);
});
const altTick = () => {
  if (scene.S.on) $('hudScale').textContent = 'ALT ' + Math.round(scene.S.alt != null ? scene.S.alt : HW.lerp(1800, 320, HW.ease(scene.S.intro))).toLocaleString('en-US') + ' M · ' + (scene.S.mode === 'top' ? 'DRONE' : 'PROFILE');
  requestAnimationFrame(altTick);
};
altTick();
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (scene.S.on) $('back').click(); else globe.select(null); } });

window.__hw = { D, globe, scene, dive };
