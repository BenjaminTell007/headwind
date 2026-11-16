/* Loading. Processed data comes from the repo (served next to the page) and
   falls back to the shared server; live ships and lookups come from the server. */

(() => {
  const HW = window.HW;

  // The shared server on Railway. Add ?local to the page URL to use one on this machine.
  HW.SERVER = location.search.includes('local') ? 'http://localhost:8787' : 'https://headway-production-83bb4bd7.up.railway.app';

  const getJSON = async (urls) => {
    let err;
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (r.ok) return await r.json();
        err = new Error(u + ' ' + r.status);
      } catch (e) { err = e; }
    }
    throw err;
  };
  const processed = f => getJSON(['../data/processed/' + f, HW.SERVER + '/data/' + f]);

  HW.loadAll = async () => {
    const [land, corridors, status, weekly, index, routes, overview, seeds, events, regions, legs, weather, gates] = await Promise.all([
      getJSON(['data/land.json']),
      processed('corridors.geojson'),
      processed('chokepoint_status.json'),
      processed('chokepoint_weekly.json'),
      processed('efficiency_index.json'),
      processed('route_efficiency.json'),
      processed('overview.json'),
      processed('market_seeds.json'),
      processed('events.json'),
      processed('regions.json'),
      processed('network_legs.geojson'),
      processed('weather_snapshot.json'),
      getJSON(['../data/gates.json', HW.SERVER + '/data/gates.json']),
    ]);

    // Chokepoints with positions (the weather snapshot lists every PortWatch chokepoint with lat/lon).
    const straits = weather.places.filter(p => p.kind === 'chokepoint').map(p => ({
      name: p.name, lat: p.lat, lon: p.lon,
      status: status.chokepoints[p.name],
      weekly: weekly[p.name],
    })).filter(s => s.status);

    return { land, corridors, status, weekly, index, routes, overview, seeds, events, regions, legs, weather, gates, straits };
  };

  /* live ships: cargo ships and tankers underway, plus everything else for the dim layer */
  HW.loadShips = async () => {
    const r = await fetch(HW.SERVER + '/api/ships?max_age_minutes=45&moving_only=true&limit=20000');
    if (!r.ok) throw new Error('ships ' + r.status);
    return (await r.json()).ships;
  };

  HW.findShip = async q => {
    const r = await fetch(HW.SERVER + '/api/ship/' + encodeURIComponent(q));
    if (!r.ok) return null;
    return r.json();
  };

  HW.serverHealth = async () => {
    try { const r = await fetch(HW.SERVER + '/api/health'); return r.ok ? r.json() : null; } catch { return null; }
  };

  /* markets: the server's list if it has one (teammates are building it), else the seed file */
  HW.loadMarkets = async (seeds) => {
    try {
      const r = await fetch(HW.SERVER + '/api/markets');
      if (r.ok) { const d = await r.json(); if (d && (d.markets || Array.isArray(d))) return { source: 'server', list: d.markets || d }; }
    } catch { /* fall through */ }
    const list = [];
    for (const group of ['live', 'route', 'weekly', 'trade']) for (const m of seeds[group] || []) list.push({ ...m, group });
    return { source: 'seeds', list };
  };

  /* Live weather at a point, straight from Open-Meteo (free, no key). */
  /* Weather at one point, live from Open-Meteo. Open-Meteo limits how often one address can ask,
     so a refused call is tried twice more, and if it still fails the nearest point of the
     weather snapshot (web/data/weather_grid.json, the globe overlay's file) is used instead,
     marked approx so the ship view can say so. */
  let gridP = null;
  const fromGrid = async (lat, lon) => {
    gridP = gridP || fetch('data/weather_grid.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const g = await gridP; if (!g || !g.points) return null;
    let best = null, bd = 1e9;
    for (const p of g.points) {
      if (p.wind == null) continue;
      let dl = Math.abs(p.lon - lon); if (dl > 180) dl = 360 - dl;
      const d = (p.lat - lat) ** 2 + dl * dl; if (d < bd) { bd = d; best = p; }
    }
    if (!best) return null;
    return { wind_speed_10m: best.wind, wind_gusts_10m: best.gust, weather_code: best.code, cloud_cover: best.cloud, precipitation: best.rain, wave_height: best.wave, approx: true, time: g.at };
  };
  const getJson = async url => {
    for (let i = 0; i < 3; i++) {
      try { const r = await fetch(url); if (r.ok) return await r.json(); if (r.status !== 429 && r.status < 500) return null; } catch { /* network: try again */ }
      await new Promise(res => setTimeout(res, 900 * (i + 1)));
    }
    return null;
  };
  HW.weatherAt = async (lat, lon) => {
    const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`;
    const [w, m] = await Promise.all([
      getJson(`https://api.open-meteo.com/v1/forecast?${q}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,weather_code,cloud_cover,precipitation,visibility,is_day&wind_speed_unit=kn`),
      getJson(`https://marine-api.open-meteo.com/v1/marine?${q}&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,sea_surface_temperature`),
    ]);
    if (!w || !w.current) return fromGrid(lat, lon);
    return { ...w.current, ...(m && m.current ? m.current : {}) };
  };
})();
