/* Wires the page together: intro, overview strip, globe, replay timeline, markets,
   the detail panel, ship search and the dive into the ship scene. */

const HW = window.HW, C = HW.C;
const $ = id => document.getElementById(id);
const VESSELS = [['container', C.container, 'CONTAINER'], ['tanker', C.tanker, 'TANKER'], ['dry_bulk', C.bulk, 'DRY BULK'], ['general_cargo', C.general, 'GENERAL'], ['roro', C.roro, 'RO-RO']];

/* ---------- intro and brand ---------- */
const intro = HW.glyphLogo($('introcv'), { step: 12, bg: C.bg });
HW.glyphLogo($('brandcv'), { step: 7, bg: null });
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
$('sysAsOf').textContent = HW.fDate(D.overview.as_of);
$('sysStraits').textContent = D.straits.length;
$('sysRoutes').textContent = D.corridors.features.length;
$('introtag').textContent = `SYS.ROUTES: ${D.corridors.features.length} · STRAITS: ${D.straits.length} · DATA TO ${HW.fDate(D.overview.as_of)}`;

globe = HW.makeGlobe($('globe'), D, { onSelect: item => showPanel(item) });
scene = HW.makeShipScene($('shipcv'));

// let the logo play for a moment, then reveal the globe
setTimeout(() => { $('intro').classList.add('out'); setTimeout(() => { intro.stop(); $('intro').remove(); $('overview').classList.add('in'); }, 1000); }, Math.max(0, 2600 - (performance.now() - introStart)));

/* ---------- live ships ---------- */
const refreshShips = async () => {
  try {
    const ships = await HW.loadShips();
    globe.setShips(ships);
    const main = ships.filter(s => s.type_group === 'cargo' || s.type_group === 'tanker').length;
    $('sysShips').textContent = HW.fInt(ships.length);
    $('sysLive').classList.remove('off');
    D.liveMain = main;
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
  const idx = D.index.world, iw = HW.clamp(i, 0, idx.length - 1), eff = idx[iw];
    const suez = strait('Suez Canal'), hormuz = strait('Strait of Hormuz'), cape = strait('Cape of Good Hope');
  const rS = globe.straitRatio(suez), rH = globe.straitRatio(hormuz);
  const capeShare = weeklyAt(cape, 'total', i) / (weeklyAt(cape, 'total', i) + weeklyAt(suez, 'total', i)) * 100;
  const ri = HW.clamp(i + globe.rOff, 0, EA_NE.r.expected_days.length - 1), days = EA_NE.r.expected_days[ri], extra = Math.max(0, days - EA_NE.r.normal_days);
  const cells = [
    ['lead', 'WORLD ROUTE EFFICIENCY', eff.toFixed(2), '', '1.00 = EVERY ROUTE NORMAL'],
    ['', 'SUEZ VS 2023', HW.fPct((rS - 1) * 100), '', `${HW.fInt(weeklyAt(suez, 'total', i))} SHIPS THIS WEEK`],
    ['', 'HORMUZ VS 2023', HW.fPct((rH - 1) * 100), '', `${HW.fInt(weeklyAt(hormuz, 'total', i))} SHIPS THIS WEEK`],
    ['', 'CAPE SHARE OF SUEZ+CAPE', capeShare.toFixed(0) + '%', '', 'SHIPS GOING THE LONG WAY'],
    ['', 'ASIA → N. EUROPE', days.toFixed(1) + ' D', '', `NORMAL ${EA_NE.r.normal_days.toFixed(1)} · +${extra.toFixed(1)} DAYS`],
    ['', 'TIME COST PER $1M CARGO', extra > 0.05 ? HW.fUSD(extra * 0.006 * 1e6) + '–' + HW.fUSD(extra * 0.021 * 1e6) : '$0', '', 'HUMMELS & SCHAUR RANGE'],
    ['', 'CARGO + TANKERS UNDERWAY', D.liveMain ? HW.fInt(D.liveMain) : '—', '', 'LIVE · FREE AIS FEED'],
  ];
  $('overview').innerHTML = cells.map(([cls, k, v, svg, sub]) => `<div class="cell ${cls}"><div class="tag">${k}</div><div class="num">${v}</div>${svg}<div class="sub">${sub}</div></div>`).join('');
};
renderOverview(true);

/* ---------- right now: the page always shows the latest week ---------- */
const setWeek = () => { globe.setWeek(nW - 1); renderOverview(); if (panelItem) showPanel(panelItem, true); };
setWeek();

$('zin').addEventListener('click', () => globe.zoomBy(1.5));
$('zout').addEventListener('click', () => globe.zoomBy(1 / 1.5));

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
    const worst = lanesThrough.map(L => ({ L, e: globe.laneEff(L) })).sort((a, b) => a.e - b.e).slice(0, 4);
    b.innerHTML = `<div class="tag">STRAIT · THIS WEEK</div><h2>${HW.esc(s.name)}</h2>
      <div class="stats">
        <div><b>${HW.fPct((r - 1) * 100)}</b><span>VS 2023 BASELINE</span></div>
        <div><b>${HW.fInt(weeklyAt(s, 'total', i))}</b><span>SHIPS THIS WEEK</span></div>
        <div><b>${HW.fInt(s.status.baseline_per_week)}</b><span>NORMAL WEEK (2023)</span></div>
        <div><b>${lanesThrough.length}</b><span>ROUTES THROUGH IT</span></div>
      </div>
      <h3>WHO GOES THROUGH, THIS WEEK</h3>${mixBar(mix)}
      ${worst.length ? `<h3>ROUTES THAT DEPEND ON IT</h3>${worst.map(({ L, e }) => `<div style="display:flex;justify-content:space-between;margin-top:6px"><span>${HW.esc(L.p.region_a)} → ${HW.esc(L.p.region_b)}</span><span class="tag" style="letter-spacing:.08em">EFF ${e.toFixed(2)}</span></div>`).join('')}` : ''}
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
      <p style="font-size:12px;color:var(--dim)">Efficiency is a model built from PortWatch transits: traffic missing from a strait on this route, times the extra days of going around it.</p>
      <h3>MARKETS</h3>${relatedMarkets(m => (m.series || '').includes(L.id)) || '<p>No open market on this route yet.</p>'}`;
  } else if (item.kind === 'ship') {
    const s = item.ship, g = s.g || s.type_group || HW.vesselGroup(s.type);
    b.innerHTML = `<div class="tag"><span class="dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${HW.groupColour(g)};margin-right:6px"></span>${HW.groupLabel(g)} · LIVE</div><h2>${HW.esc(s.name || 'MMSI ' + s.mmsi)}</h2>
      <div class="stats">
        <div><b>${s.sog != null ? (+s.sog).toFixed(1) + ' kn' : '—'}</b><span>SPEED</span></div>
        <div><b>${s.cog != null ? Math.round(s.cog) + '°' : '—'}</b><span>COURSE</span></div>
        <div><b>${HW.esc(s.destination || '—')}</b><span>DESTINATION (AS TYPED BY CREW)</span></div>
        <div><b>${HW.esc(s.eta || '—')}</b><span>ETA</span></div>
        <div><b>${s.length ? s.length + ' m' : '—'}</b><span>LENGTH</span></div>
        <div><b>${s.draught ? s.draught + ' m' : '—'}</b><span>DRAUGHT</span></div>
      </div>
      <p style="font-size:12px;color:var(--dim)">IMO ${HW.esc(s.imo || '—')} · MMSI ${HW.esc(s.mmsi)} · ${(+s.lat).toFixed(3)}, ${(+s.lon).toFixed(3)}</p>
      <button class="cta" id="diveBtn">DIVE TO SHIP</button>`;
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
      const ws = windowStart(m.minutes), left = Math.max(0, ws.getTime() + m.minutes * 60000 - Date.now());
      meta = `<span class="tag">${st ? st.count + ' / ' + m.threshold + ' CROSSED' : 'COUNTING…'}</span><span class="tag">${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')} LEFT</span>`;
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
      await chain.m.buy(chain.wallet, m.chainId, btn.dataset.side === 'yes', chain.mk.parseMon('0.01'));
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
      const since = windowStart(m.minutes).toISOString();
      const r = await fetch(`${HW.SERVER}/api/gates/${m.gate}/count?since=${encodeURIComponent(since)}`);
      if (r.ok) { const d = await r.json(); liveState[m.id] = { count: d.count }; }
    } catch { /* server unreachable: card keeps "counting" */ }
  }
  if (mGroup === 'live') renderMarkets();
};
const syncChainOdds = async () => {
  if (!chain) return;
  const onchain = await chain.m.list();
  for (const m of markets.list) { const c = onchain.find(x => x.series === m.series || x.question === m.question); if (c) { m.chainId = c.id; m.probYes = c.probYes; } }
};
(async () => {
  markets = await HW.loadMarkets(D.seeds);
  chain = await loadChain();
  if (chain) { await syncChainOdds().catch(() => {}); $('wallet').textContent = 'WALLET'; }
  else $('wallet').title = 'Contracts are not deployed yet';
  renderMarkets(); pollLive();
  setInterval(pollLive, 20000);
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
document.querySelectorAll('#cams button').forEach(b => b.addEventListener('click', () => {
  scene.setMode(b.dataset.m); document.querySelectorAll('#cams button').forEach(o => o.classList.toggle('on', o === b));
}));
$('back').addEventListener('click', () => {
  scene.close(); $('dive').classList.remove('on'); $('cross').classList.remove('on');
  document.querySelectorAll('#cams button').forEach(o => o.classList.toggle('on', o.dataset.m === 'top'));
  globe.zoomBy(0.35);
});
const altTick = () => {
  if (scene.S.on) $('hudScale').textContent = 'ALT ' + Math.round(HW.lerp(1800, 320, HW.ease(scene.S.intro))) + ' M · ' + (scene.S.mode === 'top' ? 'DRONE' : 'PROFILE');
  requestAnimationFrame(altTick);
};
altTick();
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (scene.S.on) $('back').click(); else globe.select(null); } });

window.__hw = { D, globe, scene, dive };
