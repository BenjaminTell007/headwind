/* The forecasts screen under the globe.

   Scroll down while the globe is zoomed all the way out (or click FORECASTS at the
   bottom) and this screen slides up while the globe falls back behind it. Scroll up
   at the top, or click back, to return.

   Everything here comes from web/data/forecast.json, made by web/tools/forecast.py:
   gradient-boosted trees (LightGBM-style) forecasting weekly ships through each strait
   for the next 8 weeks, with calibrated ranges, the model's odds on each weekly strait
   market, a backtest, and two years of history. */

(() => {
  const HW = window.HW;
  const $ = (sel, el = document) => el.querySelector(sel);
  const VESSELS = [['container', 'container', 'CONTAINER'], ['tanker', 'tanker', 'TANKER'], ['dry_bulk', 'bulk', 'DRY BULK'], ['general_cargo', 'general', 'GENERAL'], ['roro', 'roro', 'RO-RO']];
  const KEY = ['Suez Canal', 'Strait of Hormuz', 'Bab el-Mandeb Strait', 'Panama Canal', 'Malacca Strait', 'Cape of Good Hope', 'Gibraltar Strait', 'Bosporus Strait'];
  const EVENTS = [['2021-03-28', 'EVER GIVEN'], ['2023-12-17', 'RED SEA ATTACKS'], ['2026-03-01', 'HORMUZ']];

  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const col = name => cssVar('--' + name) || '#f2f2f0';
  const short = name => name.replace(' Strait', '').replace(' Canal', '').replace('Strait of ', '').replace(' Passage', '').replace(' Channel', '');
  const fDay = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase();
  const fInt = v => Math.round(v).toLocaleString('en-US');
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ease = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);

  let F = null, sel = 'Suez Canal', open = false;

  /* ---------- build the screen ---------- */
  const root = document.createElement('div');
  root.id = 'stats';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="back"><span class="hw-wordmark sm">HEADWAY</span><button id="statsBack">↑ BACK TO THE GLOBE</button></div>
    <div class="wrap">
      <section class="rh">
        <div class="rh-main">
          <div class="rh-head">
            <div class="tag" id="rhTag">STRAIT · SHIPS PER WEEK</div>
            <h1 id="rhName">—</h1>
            <div class="rh-num" id="rhNum">—</div>
            <div class="rh-chg" id="rhChg">—</div>
          </div>
          <div class="rh-chart" id="rhChart"></div>
          <div class="rh-ranges" id="rhRanges">${['1M', '3M', '6M', '1Y', '2Y'].map(r => `<button data-r="${r}"${r === '6M' ? ' class="on"' : ''}>${r}</button>`).join('')}<span class="tag">+ 8-WEEK FORECAST</span></div>
          <div class="rh-facts" id="rhFacts"></div>
        </div>
        <aside class="rh-side">
          <div class="tag">TOP MOVERS · NEXT WEEK'S FORECAST</div>
          <div class="rh-movers" id="rhMovers"></div>
          <div class="tag" style="margin-top:22px">ALL STRAITS</div>
          <div class="rh-list" id="rhList"></div>
        </aside>
      </section>

      <section class="wheelSec">
        <div class="wheelText">
          <div class="tag">THE FORECAST WHEEL · HOVER A STRAIT, CLICK TO OPEN IT</div>
          <h2>Every strait, <em>at once.</em></h2>
          <p class="lede">Each slice is one strait: the last six months of weekly ships drawn outward from the ring, then the model's eight-week forecast as a cone beyond it. Green is heading up, red is heading down.</p>
          <div class="wheelRead" id="wheelRead"></div>
        </div>
        <canvas id="wheel"></canvas>
      </section>

      <section>
        <div class="tag rv" id="sTag">FORECASTS</div>
        <h2 class="rv">The next eight weeks, <em>strait by strait.</em></h2>
        <p class="lede rv">A gradient-boosted tree model (the same family as LightGBM) reads every strait's recent traffic, its usual level, its mix of ships, the time of year and how well the world's routes are flowing, then forecasts weekly transits up to eight weeks out with a range around each number.</p>
        <div class="kpis rv" id="kpis"></div>
      </section>

      <section style="display:none">
        <div class="tag rv">FORECAST · PICK A STRAIT BELOW</div>
        <div class="feature rv">
          <div class="chart" id="featChart"></div>
          <div class="side" id="featSide"></div>
        </div>
        <div class="multiples" id="multiples"></div>
      </section>

      <section>
        <div class="tag rv">MODEL ODDS ON THIS WEEK'S MARKETS</div>
        <h2 class="rv">Where the model <em>leans.</em></h2>
        <p class="lede rv">Each weekly strait market asks whether at least some number of ships will pass in a given week. Reading the model's forecast range as a probability gives its own odds of YES. Sorted by how strongly it leans. It's a signal to weigh, not advice.</p>
        <div class="signals" id="signals"></div>
      </section>

      <section>
        <div class="tag rv">EVERY WEEK SINCE 2019 · DRAG TO ORBIT · MOVE TO MAKE WAVES · CLICK TO SPLASH</div>
        <h2 class="rv">Sixteen straits, <em>three crises.</em></h2>
        <p class="lede rv">Weekly ships through the sixteen busiest straits, each scaled to its own peak. Blue marks every week a strait ran under 60% of a normal 2023 week, so the Ever Given blockage, the Red Sea attacks and the Hormuz closure show as scars across the surface.</p>
        <div class="ridgeWrap rv"><canvas id="ridge"></canvas><div class="readout" id="ridgeRead"></div></div>
      </section>

      <section>
        <div class="tag rv">THE DISRUPTION TAPE · EVERY WEEK SINCE 2019 VS A NORMAL 2023 WEEK</div>
        <h2 class="rv">Seven years of traffic, <em>one strip.</em></h2>
        <p class="lede rv">One row per strait, one cell per week. Red is traffic below normal, green above. The crises read as red bands: move across it for the numbers.</p>
        <div class="tapeWrap rv"><canvas id="tape"></canvas><div class="readout" id="tapeRead"></div></div>
      </section>

      <section style="display:none">
        <div class="two">
          <div class="rv">
            <div class="tag">WHAT THE MODEL LOOKS AT</div>
            <h3>How much worse the one-week forecast gets if each input is scrambled</h3>
            <div class="dots" id="importance"></div>
          </div>
          <div class="rv">
            <div class="tag">HOW IT DID · LAST 26 WEEKS, NOT SEEN IN TRAINING</div>
            <h3>Error vs "same as last week", by weeks ahead</h3>
            <div class="dots" id="backtest"></div>
            <p class="note" style="margin-top:12px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--fg);vertical-align:-1px"></span> model &nbsp; <span style="display:inline-block;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--dim);vertical-align:-2px"></span> same as last week &nbsp;·&nbsp; error = total miss over total ships (WAPE)</p>
          </div>
        </div>
      </section>

      <section class="foot">
        <p class="note" id="method"></p>
      </section>
    </div>`;
  document.body.appendChild(root);

  const btn = document.createElement('button');
  btn.className = 'statsBtn';
  btn.innerHTML = 'FORECASTS <span class="chev">↓</span>';
  document.body.appendChild(btn);

  /* ---------- open and close ---------- */
  const setOpen = on => {
    if (open === on) return;
    open = on;
    document.body.classList.toggle('statsOpen', on);
    root.setAttribute('aria-hidden', on ? 'false' : 'true');
    const app = document.getElementById('app');
    if (app) app.classList.toggle('away', on);
    if (on) {
      root.scrollTop = 0;
      // the screen is still sliding up, so check what's in view as it arrives
      [250, 600, 950].forEach(ms => setTimeout(revealCheck, ms));
    }
  };
  btn.addEventListener('click', () => setOpen(true));
  $('#statsBack', root).addEventListener('click', () => setOpen(false));
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && open) setOpen(false);
  });

  // Wheel: scrolling down past the globe's furthest zoom opens this screen;
  // scrolling up at the top of this screen closes it.
  let push = 0, pushAt = 0;
  window.addEventListener('wheel', e => {
    const now = performance.now();
    if (now - pushAt > 400) push = 0;
    pushAt = now;
    if (!open) {
      const dive = document.getElementById('dive');
      if (dive && dive.classList.contains('on')) return;
      if (e.deltaY <= 0) return;
      const g = window.__hw && window.__hw.globe;
      const onGlobe = e.target && e.target.id === 'globe';
      const zoomedOut = !g || g.S.zoomT <= 0.86;
      const overPanel = e.target && e.target.closest && e.target.closest('.panel, .mlist, .rail, .drawer, #panel');
      if (overPanel) return;
      if (onGlobe && !zoomedOut) return;
      push += e.deltaY;
      if (onGlobe) { e.preventDefault(); e.stopImmediatePropagation(); }
      if (push > 140) { push = 0; setOpen(true); }
    } else if (root.scrollTop <= 0 && e.deltaY < 0) {
      push += -e.deltaY;
      if (push > 160) { push = 0; setOpen(false); }
    }
  }, { capture: true, passive: false });

  /* ---------- reveal on scroll ---------- */
  const revealCheck = () => {
    const h = root.clientHeight;
    root.querySelectorAll('.rv:not(.in)').forEach(el => {
      const r = el.getBoundingClientRect(), top = r.top - root.getBoundingClientRect().top;
      if (top < h * 0.9) el.classList.add('in');
    });
  };
  root.addEventListener('scroll', revealCheck, { passive: true });

  /* ---------- fan chart ---------- */
  // History (last `histN` weeks) as a line, then the forecast as two nested bands
  // (5–95% and 25–75%) with the median dashed. Returns svg markup and the scales.
  const fan = (s, { w, h, histN, axes }) => {
    const hist = s.total.slice(-histN), weeks = s.weeks.slice(-histN), fc = s.forecast;
    const n = hist.length + fc.length;
    let lo = Infinity, hi = -Infinity;
    hist.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
    fc.forEach(f => { lo = Math.min(lo, f.q[0]); hi = Math.max(hi, f.q[4]); });
    const pad = (hi - lo) * 0.12 || 1;
    lo = Math.max(0, lo - pad); hi += pad;
    const L = axes ? 46 : 2, Rr = axes ? 10 : 2, T = 8, B = axes ? 26 : 4;
    const X = i => L + (i / (n - 1)) * (w - L - Rr);
    const Y = v => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
    const last = hist.length - 1;
    const line = hist.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    const band = (a, b) => {
      const top = fc.map((f, k) => `L${X(last + 1 + k).toFixed(1)},${Y(f.q[b]).toFixed(1)}`).join('');
      const bot = fc.slice().reverse().map((f, k) => `L${X(last + fc.length - k).toFixed(1)},${Y(f.q[a]).toFixed(1)}`).join('');
      return `M${X(last).toFixed(1)},${Y(hist[last]).toFixed(1)}${top}${bot}Z`;
    };
    const med = `M${X(last).toFixed(1)},${Y(hist[last]).toFixed(1)}` + fc.map((f, k) => `L${X(last + 1 + k).toFixed(1)},${Y(f.q[2]).toFixed(1)}`).join('');
    let ax = '';
    if (axes) {
      for (let k = 0; k <= 3; k++) {
        const v = lo + (hi - lo) * k / 3, y = Y(v);
        ax += `<line x1="${L}" x2="${w - Rr}" y1="${y}" y2="${y}" stroke="var(--fg)" stroke-opacity=".07"/><text x="${L - 8}" y="${y + 3.5}" text-anchor="end" class="ax">${fInt(v)}</text>`;
      }
      let lastMonth = '';
      weeks.forEach((wk, i) => {
        const m = wk.slice(0, 7);
        if (m !== lastMonth && (wk.slice(5, 7) === '01' || wk.slice(5, 7) === '07') && wk.slice(8) <= '07') {
          ax += `<text x="${X(i)}" y="${h - 6}" text-anchor="middle" class="ax">${new Date(wk + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).toUpperCase()}</text>`;
        }
        lastMonth = m;
      });
      ax += `<text x="${X(last)}" y="${T + 2}" text-anchor="middle" class="ax">NOW</text>`;
    }
    const svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <style>.ax{font:300 10px ${HW.MONO};letter-spacing:.08em;fill:var(--dim)}</style>
      ${ax}
      <line x1="${X(last)}" x2="${X(last)}" y1="${T + 8}" y2="${h - B}" stroke="var(--fg)" stroke-opacity=".25" stroke-dasharray="2 3"/>
      <path d="${band(0, 4)}" fill="var(--fg)" fill-opacity=".09"/>
      <path d="${band(1, 3)}" fill="var(--fg)" fill-opacity=".16"/>
      <path class="draw" d="${line}" fill="none" stroke="var(--fg)" stroke-width="${axes ? 1.6 : 1.2}" stroke-linejoin="round" pathLength="1"/>
      <path d="${med}" fill="none" stroke="var(--accent)" stroke-width="${axes ? 2 : 1.4}" stroke-dasharray="4 3"/>
      <circle cx="${X(last)}" cy="${Y(hist[last])}" r="${axes ? 3.5 : 2.2}" fill="var(--fg)"/>
      ${axes ? '<line class="hx" x1="0" x2="0" y1="' + T + '" y2="' + (h - B) + '" stroke="var(--fg)" stroke-opacity="0"/><circle class="hp" r="4" fill="var(--accent)" opacity="0"/>' : ''}
    </svg>`;
    return { svg, X, Y, n, last, hist, weeks, fc, L, Rr, w };
  };

  // the vessel mix over the last 52 weeks, as stacked shares
  const mixStream = (s, w, h) => {
    const n = s.mix.container.length;
    const tot = Array.from({ length: n }, (_, i) => VESSELS.reduce((a, [k]) => a + (s.mix[k][i] || 0), 0) || 1);
    let base = new Array(n).fill(0), out = '';
    const X = i => (i / (n - 1)) * w;
    VESSELS.forEach(([k, c]) => {
      const top = base.map((b, i) => b + (s.mix[k][i] || 0) / tot[i]);
      const d = top.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${(h - v * h).toFixed(1)}`).join('') +
        base.slice().reverse().map((v, i) => `L${X(n - 1 - i).toFixed(1)},${(h - v * h).toFixed(1)}`).join('') + 'Z';
      out += `<path d="${d}" fill="${col(c)}" fill-opacity=".85"/>`;
      base = top;
    });
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;display:block;border-radius:4px">${out}</svg>`;
  };

  const renderFeature = () => {
    const s = F.straits[sel];
    if (!s) return;
    const box = $('#featChart', root);
    const w = 860, h = 360;
    const f = fan(s, { w, h, histN: 78, axes: true });
    box.innerHTML = f.svg + '<div class="readout" id="featRead"></div>';
    requestAnimationFrame(() => box.querySelector('.draw').classList.add('go'));
    const svg = box.querySelector('svg'), read = $('#featRead', box), hx = svg.querySelector('.hx'), hp = svg.querySelector('.hp');
    svg.addEventListener('mousemove', e => {
      const r = svg.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * w;
      const i = clamp(Math.round((vx - f.L) / (w - f.L - f.Rr) * (f.n - 1)), 0, f.n - 1);
      let label, value, extra = '';
      if (i <= f.last) {
        label = 'WEEK ENDING ' + fDay(f.weeks[i]); value = fInt(f.hist[i]) + ' SHIPS';
      } else {
        const q = f.fc[i - f.last - 1];
        label = 'FORECAST · WEEK ENDING ' + fDay(q.week); value = fInt(q.q[2]) + ' SHIPS';
        extra = `<br>LIKELY ${fInt(q.q[1])}–${fInt(q.q[3])} · 90% RANGE ${fInt(q.q[0])}–${fInt(q.q[4])}`;
      }
      const yv = i <= f.last ? f.hist[i] : f.fc[i - f.last - 1].q[2];
      hx.setAttribute('x1', f.X(i)); hx.setAttribute('x2', f.X(i)); hx.setAttribute('stroke-opacity', '.35');
      hp.setAttribute('cx', f.X(i)); hp.setAttribute('cy', f.Y(yv)); hp.setAttribute('opacity', '1');
      read.innerHTML = `<span style="color:var(--dim)">${label}</span><br><b>${value}</b>${extra}`;
      const px = f.X(i) / w * r.width;
      read.style.left = (px > r.width * 0.6 ? px - read.offsetWidth - 14 : px + 14) + 'px';
      read.style.top = Math.max(0, f.Y(yv) / h * r.height - 50) + 'px';
      read.style.opacity = 1;
    });
    svg.addEventListener('mouseleave', () => { read.style.opacity = 0; hx.setAttribute('stroke-opacity', '0'); hp.setAttribute('opacity', '0'); });

    const nx = s.forecast[0].q, now = s.total[s.total.length - 1], chg = (nx[2] / Math.max(1, now) - 1) * 100;
    $('#featSide', root).innerHTML = `
      <div class="tag">${sel.toUpperCase()} · NEXT WEEK</div>
      <div class="big">${fInt(nx[2])}</div>
      <div class="tag" style="letter-spacing:.12em">SHIPS EXPECTED · ${chg >= 0 ? '+' : '−'}${Math.abs(chg).toFixed(1)}% VS THIS WEEK</div>
      <div class="gauge"><div class="tag" style="display:flex;justify-content:space-between"><span>CHANCE TRAFFIC RISES</span><span>${Math.round(s.p_up_next_week * 100)}%</span></div>
        <div class="bar"><i style="width:${(s.p_up_next_week * 100).toFixed(1)}%"></i></div></div>
      <div class="row"><span>This week</span><span>${fInt(now)}</span></div>
      <div class="row"><span>Likely next week</span><span>${fInt(nx[1])}–${fInt(nx[3])}</span></div>
      <div class="row"><span>90% range</span><span>${fInt(nx[0])}–${fInt(nx[4])}</span></div>
      <div class="row"><span>In 8 weeks</span><span>${fInt(s.forecast[7].q[2])}</span></div>
      <div class="tag" style="margin:20px 0 8px">WHO GOES THROUGH · LAST 52 WEEKS</div>
      ${mixStream(s, 300, 54)}
      <div class="tag" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px 12px;letter-spacing:.1em">${VESSELS.map(([, c, l]) => `<span><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${col(c)};margin-right:5px"></i>${l}</span>`).join('')}</div>`;
    root.querySelectorAll('.mini').forEach(m => m.classList.toggle('on', m.dataset.s === sel));
  };

  const renderMultiples = () => {
    const names = KEY.filter(n => F.straits[n]);
    $('#multiples', root).innerHTML = names.map(n => {
      const s = F.straits[n], f = fan(s, { w: 260, h: 80, histN: 40, axes: false });
      const now = s.total[s.total.length - 1], nx = s.forecast[0].q[2], chg = (nx / Math.max(1, now) - 1) * 100;
      return `<div class="mini" data-s="${n}"><div class="hd"><b>${short(n)}</b><span class="tag">${chg >= 0 ? '↑' : '↓'} ${Math.abs(chg).toFixed(1)}%</span></div>${f.svg}</div>`;
    }).join('');
    root.querySelectorAll('.mini').forEach(m => m.addEventListener('click', () => { sel = m.dataset.s; renderFeature(); }));
  };

  /* ---------- market signals ---------- */
  const renderSignals = () => {
    // skip markets on straits that are near-empty (e.g. a closed strait with a 0-ship line)
    const real = F.market_odds.filter(m => m.threshold >= 30);
    const list = real.slice().sort((a, b) => Math.abs(b.model_p_yes - 0.5) - Math.abs(a.model_p_yes - 0.5)).slice(0, 9);
    $('#signals', root).innerHTML = list.map(m => {
      const p = m.model_p_yes, yes = p >= 0.5, h8 = m.last_8_weeks || [];
      const lo = Math.min(...h8, m.threshold) * 0.92, hi = Math.max(...h8, m.threshold) * 1.06;
      const X = i => 4 + i / Math.max(1, h8.length - 1) * 292, Y = v => 30 - (v - lo) / (hi - lo || 1) * 26;
      const spark = h8.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
      return `<div class="sig">
        <div class="q">${HW.esc ? HW.esc(m.question) : m.question}</div>
        <div class="p">${Math.round(p * 100)}%</div><span class="lean ${yes ? 'yes' : 'no'}">MODEL LEANS ${yes ? 'YES' : 'NO'}</span>
        <div class="pb"><i style="width:${(p * 100).toFixed(1)}%"></i><u></u></div>
        <svg viewBox="0 0 300 34" preserveAspectRatio="none">
          <line x1="0" x2="300" y1="${Y(m.threshold)}" y2="${Y(m.threshold)}" stroke="var(--fg)" stroke-opacity=".35" stroke-dasharray="3 3"/>
          <path d="${spark}" fill="none" stroke="var(--fg)" stroke-width="1.3"/>
          ${h8.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="1.8" fill="${v >= m.threshold ? 'var(--fg)' : 'var(--dim)'}"/>`).join('')}
        </svg>
        <div class="tag" style="grid-column:1/-1;letter-spacing:.1em">LAST 8 WEEKS VS THE ${fInt(m.threshold)} LINE · ${m.weeks_ahead} WEEKS AHEAD</div>
      </div>`;
    }).join('');
  };

  /* ---------- importance and backtest ---------- */
  const renderDots = () => {
    const imp = F.importance.filter(d => d.value > 0).slice(0, 9), mx = Math.max(...imp.map(d => d.value));
    $('#importance', root).innerHTML = imp.map(d => `<div class="r"><span>${d.feature}</span><div class="tr"><i style="--l:${(d.value / mx * 100).toFixed(1)}%"></i></div><span class="v">${(d.value / mx * 100).toFixed(0)}</span></div>`).join('');
    const bt = F.backtest, mxb = Math.max(...bt.map(b => Math.max(b.wape_model, b.wape_naive))) * 1.12;
    $('#backtest', root).innerHTML = bt.map(b => {
      const a = b.wape_model / mxb * 100, n = b.wape_naive / mxb * 100;
      return `<div class="r"><span>${b.h} week${b.h > 1 ? 's' : ''} ahead</span><div class="tr"><s style="left:${Math.min(a, n)}%;width:${Math.abs(n - a)}%"></s><i class="n" style="--l:${n.toFixed(1)}%"></i><i style="--l:${a.toFixed(1)}%"></i></div><span class="v">${b.wape_model}% / ${b.wape_naive}%</span></div>`;
    }).join('');
  };
  const animateDots = () => root.querySelectorAll('.dots i[data-l]').forEach(i => { i.style.left = i.dataset.l + '%'; });

  /* ---------- the ridgeline as a dotted 3D surface on springs ----------
     Same idea as the surface on my ECON 423 page: every strait is a curtain of dots, and the
     heights sit on springs joined to their neighbours. Moving the cursor across it leaves a
     wake, a click makes a splash, and the rows rise as a front that runs from 2019 to now.
     Dots turn accent blue in weeks when the strait ran under 60% of its normal 2023 traffic,
     so the crises show as blue scars. Drag to orbit (it keeps a little momentum). */
  const ridge = { yaw: -0.3, pitch: 0.62, yawV: 0, pitchV: 0, drag: null, mx: null, my: null, shownAt: 0 };
  const setupRidge = () => {
    const cv = $('#ridge', root), ctx = cv.getContext('2d'), read = $('#ridgeRead', root);
    const names = Object.keys(F.ridge.series), weeks = F.ridge.weeks, nW = weeks.length;
    const R = names.length, C = Math.min(130, nW), N = R * C;
    const wk = c => Math.round(c * (nW - 1) / (C - 1));   // the week a column stands for
    const val = new Float32Array(N), low = new Uint8Array(N);
    const i23 = weeks.map((w, i) => w.startsWith('2023') ? i : -1).filter(i => i >= 0);
    names.forEach((n, r) => {
      const v = F.ridge.series[n], mx = Math.max(...v) || 1, base = (i23.reduce((a, i) => a + v[i], 0) / (i23.length || 1)) || mx;
      for (let c = 0; c < C; c++) {
        const i = wk(c); let sum = 0, k = 0;
        for (let j = -3; j <= 3; j++) { const y = v[i + j]; if (y != null) { sum += y; k++; } }
        val[r * C + c] = sum / k / mx; low[r * C + c] = sum / k / base < 0.6 ? 1 : 0;
      }
    });
    const h = new Float32Array(N), vel = new Float32Array(N), tg = new Float32Array(N), E = new Float32Array(N);
    const PX = new Float32Array(N), PY = new Float32Array(N);
    const evIdx = EVENTS.map(([d, l]) => [weeks.findIndex(w => w >= d), l]).filter(([i]) => i >= 0);
    let W = 0, H = 0, DPR = 1;
    const resize = () => { DPR = Math.min(2, window.devicePixelRatio || 1); W = cv.clientWidth; H = cv.clientHeight; cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); };
    resize(); window.addEventListener('resize', resize);

    const SX = 1.35, SZ = 1.12, HY = 0.58;
    let cyw = 1, syw = 0, cp = 1, sp = 0, f = 1;
    const proj = (x, y, z, out) => {
      const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, y2 = y * cp + z1 * sp, z2 = -y * sp + z1 * cp, k = f / (z2 + 3.7);
      out[0] = W * 0.53 + x1 * k; out[1] = H * 0.47 - y2 * k; return z2;
    };
    const xOf = c => -SX + 2 * SX * c / (C - 1), zOf = r => SZ - 2 * SZ * r / (R - 1);

    const kick = (node, amount, rad) => {
      const r0 = (node / C) | 0, c0 = node % C, rc = Math.ceil(rad * 2.5);
      for (let r = Math.max(0, r0 - 1); r <= Math.min(R - 1, r0 + 1); r++) for (let c = Math.max(0, c0 - rc); c <= Math.min(C - 1, c0 + rc); c++) {
        const dc = (c - c0) / rad, dr = r - r0;
        vel[r * C + c] += amount * Math.exp(-(dc * dc + dr * dr * 2.2));
      }
    };
    const step = dt => {
      for (let i = 0; i < N; i++) E[i] = h[i] - tg[i];
      for (let r = 0; r < R; r++) {
        const up = r > 0 ? -C : 0, dn = r < R - 1 ? C : 0;
        for (let c = 0; c < C; c++) {
          const i = r * C + c, e = E[i];
          const along = E[c > 0 ? i - 1 : i] + E[c < C - 1 ? i + 1 : i] - 2 * e, across = E[i + up] + E[i + dn] - 2 * e;
          vel[i] += (-46 * e + 520 * along + 60 * across - 3.4 * vel[i]) * dt;
        }
      }
      for (let i = 0; i < N; i++) h[i] += vel[i] * dt;
    };

    let near = -1, lastMx = 0, lastMy = 0, moved = 0;
    cv.addEventListener('pointerdown', e => { ridge.drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY }; ridge.yawV = ridge.pitchV = 0; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointerup', e => {
      const d = ridge.drag; ridge.drag = null;
      if (d && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5 && near >= 0) kick(near, 2.6, 5);   // a click: a splash
    });
    cv.addEventListener('pointermove', e => {
      const r = cv.getBoundingClientRect();
      ridge.mx = e.clientX - r.left; ridge.my = e.clientY - r.top;
      if (ridge.drag) {
        const dx = e.clientX - ridge.drag.x, dy = e.clientY - ridge.drag.y; ridge.drag.x = e.clientX; ridge.drag.y = e.clientY;
        ridge.yaw += dx * 0.0055; ridge.pitch = clamp(ridge.pitch + dy * 0.004, 0.14, 1.25);
        ridge.yawV = dx * 0.0055 * 60; ridge.pitchV = dy * 0.004 * 60;
      }
    });
    cv.addEventListener('pointerleave', () => { ridge.mx = null; near = -1; read.style.opacity = 0; });

    const tmp = [0, 0], order = Array.from({ length: R }, (_, r) => r), depthOf = new Float32Array(R);
    let last = 0, front = -0.1;
    const frame = now => {
      requestAnimationFrame(frame);
      if (!(open && isVisible(cv))) { last = 0; return; }
      const dt = Math.min(0.033, last ? (now - last) / 1000 : 0.016); last = now;
      // orbit: momentum after a drag, and a slow sway when left alone
      if (!ridge.drag) {
        ridge.yaw += ridge.yawV * dt; ridge.pitch = clamp(ridge.pitch + ridge.pitchV * dt, 0.14, 1.25);
        ridge.yawV *= Math.exp(-2.6 * dt); ridge.pitchV *= Math.exp(-2.6 * dt);
        ridge.yaw += Math.sin(now / 1000 * 0.22) * 0.0005;
      }
      // the rows rise as a front that runs from 2019 to now
      if (ridge.shownAt && front < 1.2) {
        front += dt / 2.2;
        for (let c = 0; c < C; c++) { const k = clamp((front - c / (C - 1)) * 6 + 1, 0, 1); if (k > 0) for (let r = 0; r < R; r++) tg[r * C + c] = val[r * C + c] * k; }
      }
      step(dt / 2); step(dt / 2);

      const fg = cssVar('--fg') || '#f2f2f0', acc = cssVar('--accent') || '#4c8dff', dim = cssVar('--dim') || '#8a8a8a';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);
      cyw = Math.cos(ridge.yaw); syw = Math.sin(ridge.yaw); cp = Math.cos(ridge.pitch); sp = Math.sin(ridge.pitch); f = Math.min(W * 0.86, H * 1.62);

      // tops of every column, the node under the cursor, and the rows from far to near
      let nd = 26 * 26, hit = -1;
      for (let r = 0; r < R; r++) {
        const z = zOf(r);
        for (let c = 0; c < C; c++) {
          const i = r * C + c; proj(xOf(c), Math.max(0, h[i]) * HY, z, tmp); PX[i] = tmp[0]; PY[i] = tmp[1];
          if (ridge.mx != null) { const d = (tmp[0] - ridge.mx) ** 2 + (tmp[1] - ridge.my) ** 2; if (d < nd) { nd = d; hit = i; } }
        }
        depthOf[r] = proj(0, 0, z, tmp);
      }
      near = ridge.drag ? -1 : hit;
      // the cursor's wake: moving across the surface pushes it down a little where it passes
      if (near >= 0 && ridge.mx != null) { const sp2 = Math.hypot(ridge.mx - lastMx, ridge.my - lastMy); moved = Math.min(40, sp2); if (moved > 1.5) kick(near, -0.012 * moved, 3); }
      lastMx = ridge.mx || 0; lastMy = ridge.my || 0;
      order.sort((a, b) => depthOf[b] - depthOf[a]);
      const hr = near >= 0 ? (near / C) | 0 : -1, hc = near >= 0 ? near % C : -1;

      // floor: the crisis lines, under everything
      evIdx.forEach(([i]) => {
        const x = -SX + 2 * SX * i / (nW - 1);
        proj(x, 0, -SZ - 0.06, tmp); const ax = tmp[0], ay = tmp[1]; proj(x, 0, SZ + 0.06, tmp);
        ctx.globalAlpha = 0.4; ctx.strokeStyle = acc; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(tmp[0], tmp[1]); ctx.stroke(); ctx.setLineDash([]);
      });

      const rowLabels = [];
      for (const r of order) {
        const z = zOf(r), nearK = 1 - clamp((depthOf[r] + 1.1) / 2.2, 0, 1), isH = r === hr;
        const a0 = 0.35 + 0.65 * nearK, size = 1.1 + 1.1 * nearK;
        // hide what's behind this row (a joyplot), then hang its curtain of dots
        ctx.globalAlpha = 0.86; ctx.fillStyle = cssVar('--bg') || '#0a0a0a'; ctx.beginPath();
        for (let c = 0; c < C; c++) { const i = r * C + c; if (c) ctx.lineTo(PX[i], PY[i]); else ctx.moveTo(PX[i], PY[i]); }
        proj(xOf(C - 1), 0, z, tmp); ctx.lineTo(tmp[0], tmp[1]); proj(xOf(0), 0, z, tmp); ctx.lineTo(tmp[0], tmp[1]); ctx.closePath(); ctx.fill();
        const DY = 0.04;
        ctx.fillStyle = isH ? acc : fg; ctx.globalAlpha = (isH ? 0.42 : 0.2) * a0; ctx.beginPath();
        for (let c = 0; c < C; c++) {
          const i = r * C + c, top = Math.max(0, h[i]) * HY;
          for (let y = DY; y < top - 0.02; y += DY) { proj(xOf(c), y, z, tmp); ctx.rect(tmp[0] - 0.6, tmp[1] - 0.6, 1.3, 1.3); }
        }
        ctx.fill();
        // weeks under 60% of normal: the curtain in blue
        ctx.fillStyle = acc; ctx.globalAlpha = 0.5 * a0; ctx.beginPath();
        for (let c = 0; c < C; c++) {
          const i = r * C + c; if (!low[i] || tg[i] === 0) continue;
          const top = Math.max(0, h[i]) * HY;
          for (let y = 0; y < top + 0.03; y += DY * 0.7) { proj(xOf(c), y, z, tmp); ctx.rect(tmp[0] - 0.8, tmp[1] - 0.8, 1.7, 1.7); }
        }
        ctx.fill();
        // the tops: the ridge itself, a line with a dot on every week
        ctx.strokeStyle = isH ? acc : fg; ctx.globalAlpha = (isH ? 0.95 : 0.5) * a0; ctx.lineWidth = isH ? 1.6 : 1; ctx.beginPath();
        for (let c = 0; c < C; c++) { const i = r * C + c; if (c) ctx.lineTo(PX[i], PY[i]); else ctx.moveTo(PX[i], PY[i]); }
        ctx.stroke();
        ctx.fillStyle = isH ? acc : fg; ctx.globalAlpha = (isH ? 1 : 0.85) * a0; ctx.beginPath();
        for (let c = 0; c < C; c++) { const i = r * C + c; if (low[i]) continue; ctx.rect(PX[i] - size / 2, PY[i] - size / 2, size, size); }
        ctx.fill();
        ctx.fillStyle = acc; ctx.globalAlpha = a0; ctx.beginPath();
        for (let c = 0; c < C; c++) { const i = r * C + c; if (!low[i]) continue; ctx.rect(PX[i] - size * 0.7, PY[i] - size * 0.7, size * 1.4, size * 1.4); }
        ctx.fill();
        proj(xOf(0), 0, z, tmp); rowLabels.push([r, tmp[0], tmp[1], nearK]);
      }
      // strait names at the 2019 end of each row, drawn after the rows so none is covered
      ctx.font = `300 10px ${HW.MONO}`; ctx.textAlign = 'right';
      for (const [r, x, y, nearK] of rowLabels) {
        ctx.globalAlpha = r === hr ? 1 : 0.45 + 0.5 * nearK; ctx.fillStyle = r === hr ? acc : dim;
        ctx.fillText(short(names[r]).toUpperCase(), x - 9, y + 3);
      }
      // crisis names on posts at the back, and years along the front
      ctx.font = `300 10px ${HW.MONO}`; ctx.textAlign = 'center';
      const backZ = depthOf[0] > depthOf[R - 1] ? SZ + 0.06 : -SZ - 0.06, frontZ = -backZ;
      evIdx.forEach(([i, label]) => {
        const x = -SX + 2 * SX * i / (nW - 1);
        proj(x, 0, backZ, tmp); const ax = tmp[0], ay = tmp[1]; proj(x, HY * 1.08, backZ, tmp);
        ctx.globalAlpha = 0.55; ctx.strokeStyle = acc; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(tmp[0], tmp[1]); ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha = 0.95; ctx.fillStyle = acc; ctx.fillText(label, tmp[0], tmp[1] - 6);
      });
      ctx.globalAlpha = 0.6; ctx.fillStyle = dim;
      weeks.forEach((w, i) => { if (w.slice(5, 7) === '01' && w.slice(8) <= '07') { proj(-SX + 2 * SX * i / (nW - 1), 0, frontZ * 1.07, tmp); ctx.fillText(w.slice(0, 4), tmp[0], tmp[1] + 14); } });
      ctx.globalAlpha = 1;

      if (near >= 0) {
        const x = PX[near], y = PY[near], i = wk(hc), name = names[hr], raw = F.ridge.series[name][i];
        proj(xOf(hc), 0, zOf(hr), tmp);
        ctx.strokeStyle = acc; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tmp[0], tmp[1]); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 6.2832); ctx.fill();
        read.innerHTML = `<span style="color:var(--dim)">${name.toUpperCase()} · ${fDay(weeks[i])} ${weeks[i].slice(0, 4)}</span><br><b>${fInt(raw)} SHIPS</b>${low[near] ? '<br><span style="color:var(--accent)">UNDER 60% OF A NORMAL WEEK</span>' : ''}`;
        read.style.left = Math.min(W - 210, x + 14) + 'px'; read.style.top = Math.max(0, y - 58) + 'px'; read.style.opacity = 1;
      } else if (!ridge.drag) read.style.opacity = 0;
    };
    requestAnimationFrame(frame);
  };
  const isVisible = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; };
  root.addEventListener('scroll', () => {
    const cv = $('#ridge', root);
    if (cv && !ridge.shownAt && isVisible(cv) && cv.getBoundingClientRect().top < window.innerHeight * 0.75) ridge.shownAt = 1;
    const dots = $('#importance', root);
    if (dots && !dots.dataset.done && dots.getBoundingClientRect().top < window.innerHeight * 0.85) { dots.dataset.done = 1; animateDots(); }
  }, { passive: true });

  /* ---------- numbers at the top ---------- */
  const countUp = (el, to, fmt, ms = 1200) => {
    const t0 = performance.now();
    const step = () => { const p = ease((performance.now() - t0) / ms); el.textContent = fmt(to * p); if (p < 1) requestAnimationFrame(step); };
    step();
  };
  const renderKpis = () => {
    const b1 = F.backtest[0], cov = F.backtest.reduce((a, b) => a + b.coverage_90_calibrated, 0) / F.backtest.length;
    const moves = Object.entries(F.straits).map(([n, s]) => [n, s.forecast[0].q[2] / Math.max(1, s.total[s.total.length - 1]) - 1, s.total[s.total.length - 1]]).filter(m => m[2] >= 50);
    moves.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const big = moves[0];
    $('#kpis', root).innerHTML = `
      <div><span class="tag">ONE WEEK OUT</span><b id="k1">0%</b><span class="s">typical miss, against ${b1.wape_naive}% for "same as last week"</span></div>
      <div><span class="tag">RANGES THAT HOLD</span><b id="k2">0%</b><span class="s">of backtest weeks landed inside the 90% range</span></div>
      <div><span class="tag">STRAITS FORECAST</span><b id="k3">0</b><span class="s">every strait with 20+ ships in a typical week</span></div>
      <div><span class="tag">BIGGEST EXPECTED MOVE</span><b id="k4">0%</b><span class="s">${big[0]}, next week vs this week</span></div>`;
    countUp($('#k1', root), b1.wape_model, v => v.toFixed(1) + '%');
    countUp($('#k2', root), cov, v => Math.round(v) + '%');
    countUp($('#k3', root), Object.keys(F.straits).length, v => Math.round(v));
    countUp($('#k4', root), big[1] * 100, v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%');
    $('#sTag', root).textContent = `FORECASTS · GRADIENT-BOOSTED TREES · PORTWATCH DATA TO ${fDay(F.data_to)}, ${F.data_to.slice(0, 4)}`;
    $('#method', root).textContent = `Method. ${F.model}. The target is the log change in weekly ships from the latest week, 1 to 8 weeks ahead, with 5/25/50/75/95% quantiles. The 90% ranges are widened with a conformal correction set on the backtest so they hold about 90% of the time. ${F.backtest_note} Market odds read the forecast range as a probability of reaching each market's threshold; they are a model's view, not advice. Made ${F.made} by web/tools/forecast.py.`;
  };

  /* ---------- the hero: one strait, big, scrubbable (the trading-app view) ---------- */
  const RANGES = { '1M': 5, '3M': 13, '6M': 26, '1Y': 52, '2Y': 104 };
  let rhRange = '6M', rhTween = 0;
  const tweenNum = (el, to) => {
    const from = parseFloat((el.dataset.v || '0')) || 0, t0 = performance.now(), id = ++rhTween;
    const step = () => {
      if (id !== rhTween) return;
      const p = ease((performance.now() - t0) / 450), v = from + (to - from) * p;
      el.textContent = fInt(v); el.dataset.v = v;
      if (p < 1) requestAnimationFrame(step);
    };
    step();
  };
  const sparkPath = (vals, w, h) => {
    const lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
    return vals.map((v, i) => `${i ? 'L' : 'M'}${(i / (vals.length - 1) * w).toFixed(1)},${(h - 2 - (v - lo) / sp * (h - 4)).toFixed(1)}`).join('');
  };
  const renderHero = () => {
    const s = F.straits[sel]; if (!s) return;
    const n = Math.min(RANGES[rhRange], s.total.length), hist = s.total.slice(-n), weeks = s.weeks.slice(-n), fc = s.forecast;
    const now = hist[hist.length - 1], start = hist[0], up = now >= start;
    const colr = up ? 'var(--up)' : 'var(--down)';
    const W = 900, H = 320, PADT = 16, PADB = 18, total = hist.length + fc.length;
    let lo = Infinity, hi = -Infinity;
    hist.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
    fc.forEach(f => { lo = Math.min(lo, f.q[1]); hi = Math.max(hi, f.q[3]); });
    const pad = (hi - lo) * 0.1 || 1; lo -= pad; hi += pad;
    const X = i => i / (total - 1) * W, Y = v => PADT + (1 - (v - lo) / (hi - lo)) * (H - PADT - PADB);
    const last = hist.length - 1;
    const line = hist.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    const area = line + `L${X(last).toFixed(1)},${H}L0,${H}Z`;
    const med = `M${X(last).toFixed(1)},${Y(now).toFixed(1)}` + fc.map((f, k) => `L${X(last + 1 + k).toFixed(1)},${Y(f.q[2]).toFixed(1)}`).join('');
    const band = `M${X(last).toFixed(1)},${Y(now).toFixed(1)}` + fc.map((f, k) => `L${X(last + 1 + k).toFixed(1)},${Y(f.q[3]).toFixed(1)}`).join('') +
      fc.slice().reverse().map((f, k) => `L${X(last + fc.length - k).toFixed(1)},${Y(f.q[1]).toFixed(1)}`).join('') + 'Z';
    const box = $('#rhChart', root);
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="rhFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? '#35c97b' : '#ff5d5d'}" stop-opacity=".22"/><stop offset="1" stop-color="${up ? '#35c97b' : '#ff5d5d'}" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" x2="${W}" y1="${Y(start)}" y2="${Y(start)}" stroke="var(--fg)" stroke-opacity=".18" stroke-dasharray="1.5 5"/>
      <path d="${area}" fill="url(#rhFill)"/>
      <path d="${band}" fill="${colr}" fill-opacity=".1"/>
      <path class="draw go" d="${line}" fill="none" stroke="${colr}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <path d="${med}" fill="none" stroke="${colr}" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <line class="sx" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--fg)" stroke-opacity="0" vector-effect="non-scaling-stroke"/>
    </svg><i class="rh-dot" style="background:${colr}"></i><i class="rh-pulse" style="left:${(X(last) / W * 100).toFixed(2)}%;top:${(Y(now) / H * 100).toFixed(2)}%;background:${colr}"></i><span class="rh-date tag"></span>`;
    const numEl = $('#rhNum', root), chgEl = $('#rhChg', root);
    const show = (v, ref, label, isFc) => {
      numEl.textContent = fInt(v); numEl.dataset.v = v;
      const d = v - ref, pc = ref ? d / ref * 100 : 0;
      chgEl.innerHTML = `<b style="color:${d >= 0 ? 'var(--up)' : 'var(--down)'}">${d >= 0 ? '▲' : '▼'} ${fInt(Math.abs(d))} (${Math.abs(pc).toFixed(1)}%)</b> <span>${label}</span>${isFc ? ' <em>FORECAST</em>' : ''}`;
    };
    const rest = () => { tweenNum(numEl, now); const d = now - start, pc = start ? d / start * 100 : 0; chgEl.innerHTML = `<b style="color:${colr}">${d >= 0 ? '▲' : '▼'} ${fInt(Math.abs(d))} (${Math.abs(pc).toFixed(1)}%)</b> <span>past ${({ '1M': 'month', '3M': '3 months', '6M': '6 months', '1Y': 'year', '2Y': '2 years' })[rhRange]}</span>`; };
    $('#rhName', root).textContent = sel;
    rest();
    const svg = box.querySelector('svg'), sx = svg.querySelector('.sx'), dot = box.querySelector('.rh-dot'), dateEl = box.querySelector('.rh-date');
    box.onmousemove = e => {
      const r = box.getBoundingClientRect(), i = clamp(Math.round((e.clientX - r.left) / r.width * (total - 1)), 0, total - 1);
      const isFc = i > last, v = isFc ? fc[i - last - 1].q[2] : hist[i], wk = isFc ? fc[i - last - 1].week : weeks[i];
      rhTween++; show(v, start, 'vs start of range', isFc);
      sx.setAttribute('x1', X(i)); sx.setAttribute('x2', X(i)); sx.setAttribute('stroke-opacity', '.35');
      dot.style.cssText += `;opacity:1;left:${(X(i) / W * 100).toFixed(2)}%;top:${(Y(v) / H * 100).toFixed(2)}%`;
      dateEl.textContent = 'WEEK ENDING ' + fDay(wk) + ' ' + wk.slice(0, 4); dateEl.style.opacity = 1;
      dateEl.style.left = clamp(X(i) / W * 100, 8, 92) + '%';
    };
    box.onmouseleave = () => { sx.setAttribute('stroke-opacity', '0'); dot.style.opacity = 0; dateEl.style.opacity = 0; rest(); };
    // facts under the chart
    const nx = fc[0].q, pUp = s.p_up_next_week;
    $('#rhFacts', root).innerHTML = [
      ['NEXT WEEK', fInt(nx[2]), `likely ${fInt(nx[1])}–${fInt(nx[3])}`],
      ['CHANCE IT RISES', Math.round(pUp * 100) + '%', pUp >= 0.5 ? 'model leans up' : 'model leans down'],
      ['IN 8 WEEKS', fInt(fc[7].q[2]), `90% range ${fInt(fc[7].q[0])}–${fInt(fc[7].q[4])}`],
      ['52-WEEK RANGE', `${fInt(Math.min(...s.total.slice(-52)))}–${fInt(Math.max(...s.total.slice(-52)))}`, 'ships per week'],
    ].map(([k, v, sub]) => `<div><span class="tag">${k}</span><b>${v}</b><em>${sub}</em></div>`).join('');
    root.querySelectorAll('.rh-row').forEach(r => r.classList.toggle('on', r.dataset.s === sel));
  };
  const renderWatch = () => {
    const rows = Object.entries(F.straits).map(([name, s]) => {
      const t = s.total, now = t[t.length - 1], ago = t[t.length - 5] || t[0], chg = ago ? (now / ago - 1) * 100 : 0;
      const nxt = s.forecast[0].q[2], move = now ? (nxt / now - 1) * 100 : 0;
      return { name, s, now, chg, move };
    }).filter(r => r.now >= 20).sort((a, b) => b.now - a.now);
    $('#rhList', root).innerHTML = rows.map(r => `<button class="rh-row" data-s="${r.name}">
        <span class="nm">${short(r.name)}<small>${fInt(r.now)} / wk</small></span>
        <svg viewBox="0 0 84 28" preserveAspectRatio="none"><path d="${sparkPath(r.s.total.slice(-26), 84, 28)}" fill="none" stroke="${r.chg >= 0 ? 'var(--up)' : 'var(--down)'}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
        <span class="pill ${r.chg >= 0 ? 'u' : 'd'}">${r.chg >= 0 ? '+' : '−'}${Math.abs(r.chg).toFixed(1)}%</span>
      </button>`).join('');
    const movers = rows.slice().sort((a, b) => Math.abs(b.move) - Math.abs(a.move)).slice(0, 4);
    $('#rhMovers', root).innerHTML = movers.map(r => `<button class="rh-mv" data-s="${r.name}"><b>${short(r.name)}</b><span style="color:${r.move >= 0 ? 'var(--up)' : 'var(--down)'}">${r.move >= 0 ? '▲' : '▼'} ${Math.abs(r.move).toFixed(1)}%</span></button>`).join('');
    root.querySelectorAll('.rh-row, .rh-mv').forEach(b => b.addEventListener('click', () => { sel = b.dataset.s; renderHero(); renderFeature(); }));
    root.querySelectorAll('#rhRanges button').forEach(b => b.addEventListener('click', () => {
      rhRange = b.dataset.r; root.querySelectorAll('#rhRanges button').forEach(o => o.classList.toggle('on', o === b)); renderHero();
    }));
  };

  /* ---------- the forecast wheel: every strait around one turning ring ---------- */
  const setupWheel = () => {
    const cv = $('#wheel', root), ctx = cv.getContext('2d'), read = $('#wheelRead', root);
    const names = Object.keys(F.straits).filter(n => F.straits[n].total[F.straits[n].total.length - 1] >= 20)
      .sort((a, b) => F.straits[b].total.slice(-1)[0] - F.straits[a].total.slice(-1)[0]);
    const N = names.length, HIST = 26;
    const items = names.map(n => {
      const s = F.straits[n], h = s.total.slice(-HIST), fc = s.forecast;
      const all = h.concat(fc.map(f => f.q[4]), fc.map(f => f.q[0]));
      const lo = Math.min(...all), hi = Math.max(...all), sp = hi - lo || 1;
      const now = h[h.length - 1], nx = fc[0].q[2], end = fc[7].q[2];
      return { n, s, h, fc, lo, sp, now, nx, end, up: end >= now };
    });
    let W = 0, H = 0, DPR = 1, rot = 0, hover = -1, mx = null, my = null, grow = 0, lastT = 0;
    const resize = () => { DPR = Math.min(2, window.devicePixelRatio || 1); W = cv.clientWidth; H = cv.clientHeight; cv.width = W * DPR; cv.height = H * DPR; };
    resize(); window.addEventListener('resize', resize);
    cv.addEventListener('pointermove', e => { const r = cv.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; });
    cv.addEventListener('pointerleave', () => { mx = null; });
    cv.addEventListener('click', () => { if (hover >= 0) { sel = items[hover].n; renderHero(); renderFeature(); root.scrollTo({ top: 0, behavior: 'smooth' }); } });
    const UP = [53, 201, 123], DN = [255, 93, 93];
    const showRead = it => {
      if (!it) { read.innerHTML = `<b>${N}</b><span>straits forecast</span><em>${items.filter(i => i.up).length} heading up · ${items.filter(i => !i.up).length} heading down over 8 weeks</em>`; return; }
      const d = (it.end / Math.max(1, it.now) - 1) * 100;
      read.innerHTML = `<b style="color:${it.up ? 'var(--up)' : 'var(--down)'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}%</b><span>${it.n}</span><em>${fInt(it.now)} ships this week → ${fInt(it.end)} in 8 weeks · ${Math.round(it.s.p_up_next_week * 100)}% chance it rises next week</em>`;
    };
    showRead(null);
    let lastHover = -2;
    const frame = now => {
      requestAnimationFrame(frame);
      if (!open || !isVisible(cv)) return;
      const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016); lastT = now;
      grow += (1 - grow) * 0.03;
      if (mx == null) rot += dt * 0.035;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2, R0 = Math.min(W, H) * 0.2, R1 = Math.min(W, H) * 0.36, R2 = Math.min(W, H) * 0.47;
      const slot = 6.2832 / N, gap = slot * 0.14;
      // which slice is the cursor in
      hover = -1;
      if (mx != null) {
        const dx = mx - cx, dy = my - cy, rr = Math.hypot(dx, dy);
        if (rr > R0 * 0.7 && rr < R2 * 1.08) { let a = (Math.atan2(dy, dx) - rot) % 6.2832; if (a < 0) a += 6.2832; hover = Math.floor(a / slot); }
      }
      if (hover !== lastHover) { lastHover = hover; showRead(hover >= 0 ? items[hover] : null); cv.style.cursor = hover >= 0 ? 'pointer' : 'default'; }
      // the "now" ring and a faint inner ring
      ctx.strokeStyle = 'rgba(242,242,240,0.16)'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
      ctx.beginPath(); ctx.arc(cx, cy, R1, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(242,242,240,0.07)'; ctx.beginPath(); ctx.arc(cx, cy, R0, 0, 6.2832); ctx.stroke();
      items.forEach((it, i) => {
        const a0 = rot + i * slot + gap / 2, a1 = rot + (i + 1) * slot - gap / 2, am = (a0 + a1) / 2;
        const c = it.up ? UP : DN, hot = i === hover, dim = hover >= 0 && !hot ? 0.3 : 1;
        // history: radius is time (inner = 6 months ago, R1 = now), swing across the slice is the value
        const A = v => a0 + ((v - it.lo) / it.sp) * (a1 - a0);
        ctx.beginPath();
        it.h.forEach((v, k) => { const r = R0 + (R1 - R0) * (k / (HIST - 1)) * grow, a = A(v); k ? ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); });
        ctx.strokeStyle = `rgba(${c},${(hot ? 1 : 0.85) * dim})`; ctx.lineWidth = hot ? 2.2 : 1.4;
        ctx.shadowColor = `rgba(${c},0.8)`; ctx.shadowBlur = hot ? 14 : 5; ctx.stroke(); ctx.shadowBlur = 0;
        // forecast cone beyond the ring: 5–95% band, then the median dotted
        const rf = k => R1 + (R2 - R1) * ((k + 1) / it.fc.length) * grow;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(A(it.now)) * R1, cy + Math.sin(A(it.now)) * R1);
        it.fc.forEach((f, k) => { const a = Math.min(a1, A(f.q[4])); ctx.lineTo(cx + Math.cos(a) * rf(k), cy + Math.sin(a) * rf(k)); });
        for (let k = it.fc.length - 1; k >= 0; k--) { const a = Math.max(a0, A(it.fc[k].q[0])); ctx.lineTo(cx + Math.cos(a) * rf(k), cy + Math.sin(a) * rf(k)); }
        ctx.closePath(); ctx.fillStyle = `rgba(${c},${(hot ? 0.3 : 0.14) * dim})`; ctx.fill();
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(A(it.now)) * R1, cy + Math.sin(A(it.now)) * R1);
        it.fc.forEach((f, k) => { const a = A(f.q[2]); ctx.lineTo(cx + Math.cos(a) * rf(k), cy + Math.sin(a) * rf(k)); });
        ctx.setLineDash([2, 4]); ctx.strokeStyle = `rgba(${c},${dim})`; ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]);
        // the live dot on the ring, pulsing
        const pa = A(it.now), pr = 2.6 + (hot ? 2 : 0) + Math.sin(now / 400 + i) * 0.6;
        ctx.fillStyle = `rgba(${c},${dim})`; ctx.beginPath(); ctx.arc(cx + Math.cos(pa) * R1, cy + Math.sin(pa) * R1, pr, 0, 6.2832); ctx.fill();
        // name outside, turned to read along the spoke
        ctx.save(); ctx.translate(cx + Math.cos(am) * (R2 + 10), cy + Math.sin(am) * (R2 + 10));
        const flip = Math.cos(am) < 0; ctx.rotate(am + (flip ? Math.PI : 0));
        ctx.font = `${hot ? 500 : 300} 10px ${HW.MONO}`; ctx.textAlign = flip ? 'right' : 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = hot ? '#f2f2f0' : `rgba(170,170,168,${dim})`;
        ctx.fillText(short(it.n).toUpperCase(), 0, 0); ctx.restore();
      });
    };
    requestAnimationFrame(frame);
  };

  /* ---------- the disruption tape: week x strait heat strip vs a normal 2023 week ---------- */
  const setupTape = () => {
    const cv = $('#tape', root), ctx = cv.getContext('2d'), read = $('#tapeRead', root);
    const names = Object.keys(F.ridge.series), weeks = F.ridge.weeks, nW = weeks.length, nR = names.length;
    const i23 = weeks.map((w, i) => w.startsWith('2023') ? i : -1).filter(i => i >= 0);
    const ratio = names.map(n => { const v = F.ridge.series[n], base = i23.reduce((a, i) => a + v[i], 0) / i23.length || 1; return v.map(x => x / base); });
    const LAB = 96, ROW = 22, TOP = 26;
    let W = 0, DPR = 1, reveal = 0, hx = -1, hy = -1;
    const resize = () => { DPR = Math.min(2, window.devicePixelRatio || 1); W = cv.clientWidth; cv.style.height = (TOP + nR * ROW + 8) + 'px'; cv.width = W * DPR; cv.height = (TOP + nR * ROW + 8) * DPR; };
    resize(); window.addEventListener('resize', resize);
    cv.addEventListener('pointermove', e => { const r = cv.getBoundingClientRect(); hx = e.clientX - r.left; hy = e.clientY - r.top; });
    cv.addEventListener('pointerleave', () => { hx = -1; read.style.opacity = 0; });
    const colour = r => {   // 1 = normal (dark), below = red, above = green
      const d = clamp(r - 1, -1, 1), k = Math.pow(Math.abs(d), 0.6);
      return d < 0 ? `rgb(${Math.round(24 + 231 * k)},${Math.round(26 + 67 * k * 0.6)},${Math.round(30 + 63 * k * 0.6)})` : `rgb(${Math.round(24 + 29 * k)},${Math.round(26 + 175 * k)},${Math.round(30 + 93 * k)})`;
    };
    const frame = () => {
      requestAnimationFrame(frame);
      if (!open || !isVisible(cv)) return;
      reveal = Math.min(1, reveal + 0.012);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, cv.height);
      const cw = (W - LAB) / nW, shown = Math.floor(nW * ease(reveal));
      for (let r = 0; r < nR; r++) {
        const y = TOP + r * ROW;
        for (let i = 0; i < shown; i++) { ctx.fillStyle = colour(ratio[r][i]); ctx.fillRect(LAB + i * cw, y, Math.ceil(cw), ROW - 3); }
        ctx.fillStyle = '#a8a8a6'; ctx.font = `300 10px ${HW.MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(short(names[r]).toUpperCase(), LAB - 10, y + (ROW - 3) / 2);
      }
      ctx.textAlign = 'center'; ctx.fillStyle = '#8a8a8a';
      weeks.forEach((w, i) => { if (w.slice(5, 7) === '01' && w.slice(8) <= '07') ctx.fillText(w.slice(0, 4), LAB + i * cw, 12); });
      EVENTS.forEach(([d, l]) => { const i = weeks.findIndex(w => w >= d); if (i < 0 || i > shown) return; const x = LAB + i * cw; ctx.strokeStyle = 'rgba(242,242,240,0.7)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, TOP - 4); ctx.lineTo(x, TOP + nR * ROW); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#f2f2f0'; ctx.textAlign = 'left'; ctx.fillText(l, x + 5, 12); });
      if (hx > LAB && hy > TOP) {
        const i = clamp(Math.floor((hx - LAB) / cw), 0, nW - 1), r = clamp(Math.floor((hy - TOP) / ROW), 0, nR - 1);
        ctx.strokeStyle = '#f2f2f0'; ctx.lineWidth = 1; ctx.strokeRect(LAB + i * cw - 1, TOP + r * ROW - 1, Math.max(4, cw + 2), ROW - 1);
        ctx.strokeStyle = 'rgba(242,242,240,0.25)'; ctx.beginPath(); ctx.moveTo(LAB + i * cw + cw / 2, TOP); ctx.lineTo(LAB + i * cw + cw / 2, TOP + nR * ROW); ctx.stroke();
        const v = F.ridge.series[names[r]][i], q = ratio[r][i];
        read.innerHTML = `<span style="color:var(--dim)">${names[r].toUpperCase()} · ${fDay(weeks[i])} ${weeks[i].slice(0, 4)}</span><br><b>${fInt(v)} SHIPS</b> · <b style="color:${q >= 1 ? 'var(--up)' : 'var(--down)'}">${q >= 1 ? '+' : '−'}${Math.abs((q - 1) * 100).toFixed(0)}% VS 2023</b>`;
        read.style.left = Math.min(W - 230, hx + 14) + 'px'; read.style.top = Math.max(0, hy - 54) + 'px'; read.style.opacity = 1;
      }
    };
    requestAnimationFrame(frame);
  };

  /* ---------- load ---------- */
  fetch('data/forecast.json').then(r => r.json()).then(data => {
    F = data;
    renderWatch();
    renderHero();
    renderKpis();
    renderMultiples();
    renderFeature();
    renderSignals();
    renderDots();
    setupRidge();
    setupWheel();
    setupTape();
    // the kpis count up again the first time the screen opens
    let counted = false;
    const obs = new MutationObserver(() => { if (open && !counted) { counted = true; renderKpis(); } });
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }).catch(() => { btn.style.display = 'none'; });
})();
