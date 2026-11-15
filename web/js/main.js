/* Wires the globe page together: intro, overview strip, globe, controls, the detail panel,
   ship search and the dive into the ship scene. This page is only about the globe: trading
   lives on markets.html and the forecasts on forecasts.html. */

const HW = window.HW, C = HW.C;
const $ = id => document.getElementById(id);
const VESSELS = [['container', C.container, 'CONTAINER'], ['tanker', C.tanker, 'TANKER'], ['dry_bulk', C.bulk, 'DRY BULK'], ['general_cargo', C.general, 'GENERAL'], ['roro', C.roro, 'RO-RO']];

/* ---------- intro and brand ---------- */
// fall back to the static logo if an old cached logo.js has no glyphIntro
const intro = (HW.glyphIntro || HW.glyphLogo)($('introcv'), { step: 16, bg: C.bg });   // same glyph size as the other pages' loaders
const introStart = performance.now();

/* ---------- boot ---------- */
let panelItem = null;
let D, globe, scene, weeks, nW;
try {
  D = await HW.loadAll();
} catch (e) {
  $('introtag').textContent = 'COULD NOT LOAD DATA · ' + String(e.message || e).toUpperCase().slice(0, 80);
  throw e;
}
weeks = D.status.weeks; nW = weeks.length;
$('introtag').textContent = `SYS.ROUTES: ${D.corridors.features.length} · STRAITS: ${D.straits.length} · DATA TO ${HW.fDate(D.overview.as_of)}`;

globe = HW.makeGlobe($('globe'), D, { onSelect: item => showPanel(item) });
// the ship view: a satellite zoom into real drone footage, dressed in the live weather (js/shipvideo.js)
scene = HW.makeShipSceneVideo($('shipcv'));

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

/* ---------- light / dark ---------- */
const themeBtn = () => { $('theme').textContent = HW.C.theme === 'light' ? '☾' : '☀'; };
themeBtn();
$('theme').addEventListener('click', () => { HW.setTheme(HW.C.theme === 'light' ? 'dark' : 'light'); themeBtn(); if (panelItem) showPanel(panelItem, true); });

/* ---------- detail panel ---------- */
const mixBar = shares => `<div class="mix">${shares.map((x, k) => `<i style="width:${(x * 100).toFixed(1)}%;background:${VESSELS[k][1]}"></i>`).join('')}</div><div class="key">${VESSELS.map(([, c, l], k) => `<span><i style="background:${c}"></i>${l} ${Math.round(shares[k] * 100)}%</span>`).join('')}</div>`;
const tradeLink = (label, q) => `<a class="cta" style="text-decoration:none" href="markets.html?q=${encodeURIComponent(q)}">${label} →</a>`;
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
      ${tradeLink('MARKETS ON THIS STRAIT', s.name.replace(' Strait', '').replace(' Canal', '').replace('Strait of ', ''))}`;
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
      ${tradeLink('MARKETS ON THIS ROUTE', L.p.region_a + ' to ' + L.p.region_b)}`;
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
  await new Promise(r => setTimeout(r, 1100));   // let the globe fly most of the way, then the footage fades in over it
  $('dive').classList.add('on');
  scene.open(ship, null);
  window.dispatchEvent(new CustomEvent('headway:dive', { detail: ship }));   // js/story.js prices a hedge for it
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

// the 3D scene lets you click another ship's name tag: show that ship's details and weather
window.addEventListener('headway:shipfocus', async e => {
  const s = { ...e.detail, g: e.detail.type_group || HW.vesselGroup(e.detail.type) };
  renderHUD(s, null);
  const w = await HW.weatherAt(+s.lat, +s.lon).catch(() => null);
  if (w) renderHUD(s, w);
});
window.__hw = { D, globe, scene, dive };
