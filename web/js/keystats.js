/* Key numbers, moved here from the globe page (Ben, Nov 15): world route efficiency, cargo ships
   and tankers underway, and the most disrupted strait. A compact row on the forecasts page,
   placed just above the forecast KPIs that js/stats.js builds. Same numbers the globe's
   overview strip showed, except the strait one skips straits with no transits at all this
   week (a data gap or a closed route, like Kerch), which read as -100%. */
(() => {
  const SERVER = location.search.includes('local') ? 'http://localhost:8787' : 'https://headway-production-83bb4bd7.up.railway.app';
  const json = async (urls) => {
    for (const u of urls) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch { /* next */ } }
    return null;
  };
  const processed = f => json(['../data/processed/' + f, SERVER + '/data/' + f]);
  const pct = v => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v)) + '%';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const style = document.createElement('style');
  style.textContent = `
    .keystats { display:flex; flex-wrap:wrap; gap:8px 28px; margin:18px 0 6px; padding:12px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
    .keystats .k { display:flex; align-items:baseline; gap:10px; min-width:0; }
    .keystats .k span { color:var(--dim); font:10px/1.3 var(--mono); letter-spacing:.14em; text-transform:uppercase; }
    .keystats .k b { color:var(--accent); font:500 17px/1.2 var(--sans); white-space:nowrap; }
    .keystats .k i { color:var(--dim); font:normal 12px/1.3 var(--sans); }
    .keystats .live { width:6px; height:6px; border-radius:50%; background:#3ecf6e; display:inline-block; margin-right:2px; }`;
  document.head.appendChild(style);

  const row = document.createElement('div');
  row.className = 'keystats';
  row.setAttribute('aria-label', 'Key numbers right now');
  const cell = (label, value, note) => `<div class="k"><span>${label}</span><b>${value}</b>${note ? `<i>${esc(note)}</i>` : ''}</div>`;
  const paint = (eff, live, worst) => {
    row.innerHTML =
      cell('World route efficiency', eff != null ? eff.toFixed(2) : '—', '1.00 = every route normal') +
      cell('<em class="live"></em>Cargo + tankers underway', live != null ? live.toLocaleString('en-US') : '—', 'live AIS') +
      cell('Most disrupted strait', worst ? pct((worst.r - 1) * 100) : '—', worst ? `${worst.name} vs a normal 2023 week` : '');
  };
  paint(null, null, null);

  // stats.js builds #stats with a #kpis block; put the row just above it.
  const place = () => {
    const kpis = document.getElementById('kpis');
    if (!kpis) return false;
    kpis.parentNode.insertBefore(row, kpis);
    return true;
  };
  if (!place()) new MutationObserver((_, obs) => { if (place()) obs.disconnect(); }).observe(document.body, { childList: true, subtree: true });

  (async () => {
    const [idx, status] = await Promise.all([processed('efficiency_index.json'), processed('chokepoint_status.json')]);
    const eff = idx && idx.world ? idx.world[idx.world.length - 1] : null;
    let worst = null;
    if (status && status.chokepoints) {
      for (const [name, s] of Object.entries(status.chokepoints)) {
        const r = s.ratio && s.ratio.length ? s.ratio[s.ratio.length - 1] : null;
        if (r == null || s.baseline_per_week < 50 || r <= 0) continue;  // no traffic at all: a gap, not a disruption
        if (!worst || r < worst.r) worst = { name, r };
      }
    }
    const liveCount = async () => {
      const d = await json([SERVER + '/api/ships?types=cargo,tanker&moving_only=true&max_age_minutes=45&count_only=true']);
      return d ? d.count : null;
    };
    paint(eff, await liveCount(), worst);
    setInterval(async () => paint(eff, await liveCount(), worst), 60000);
  })();
})();
