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
    <div class="back"><span class="word">HEADWAY</span><button id="statsBack">↑ BACK TO THE GLOBE</button></div>
    <div class="wrap">
      <section>
        <div class="tag rv" id="sTag">FORECASTS</div>
        <h2 class="rv">The next eight weeks, <em>strait by strait.</em></h2>
        <p class="lede rv">A gradient-boosted tree model (the same family as LightGBM) reads every strait's recent traffic, its usual level, its mix of ships, the time of year and how well the world's routes are flowing, then forecasts weekly transits up to eight weeks out with a range around each number.</p>
        <div class="kpis rv" id="kpis"></div>
      </section>

      <section>
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
        <div class="tag rv">EVERY WEEK SINCE 2019 · DRAG TO TURN</div>
        <h2 class="rv">Sixteen straits, <em>three crises.</em></h2>
        <p class="lede rv">Weekly ships through the sixteen busiest straits, each scaled to its own peak. The Ever Given blockage, the Red Sea attacks and the Hormuz closure cut through them as vertical scars.</p>
        <div class="ridgeWrap rv"><canvas id="ridge"></canvas><div class="readout" id="ridgeRead"></div></div>
      </section>

      <section>
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

  /* ---------- the ridgeline, in 3D ---------- */
  const ridge = {
    yaw: -0.16, pitch: 0.48, vy: 0, drag: null, hover: null, t: 0, running: false,
  };
  const setupRidge = () => {
    const cv = $('#ridge', root), ctx = cv.getContext('2d'), read = $('#ridgeRead', root);
    const names = Object.keys(F.ridge.series), weeks = F.ridge.weeks, nW = weeks.length;
    // each strait scaled to its own peak, lightly smoothed
    const rows = names.map(n => {
      const v = F.ridge.series[n], mx = Math.max(...v) || 1;
      return v.map((x, i) => {
        let s = 0, c = 0;
        for (let k = -1; k <= 1; k++) { const y = v[i + k]; if (y != null) { s += y; c++; } }
        return s / c / mx;
      });
    });
    const evIdx = EVENTS.map(([d, l]) => [weeks.findIndex(w => w >= d), l]).filter(([i]) => i >= 0);
    let W = 0, H = 0, DPR = 1;
    const resize = () => {
      DPR = Math.min(2, window.devicePixelRatio || 1);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    };
    resize();
    window.addEventListener('resize', resize);

    // world: x across time [-1.3, 1.3], z across straits [-1, 1] (back to front), y up
    const proj = (x, y, z) => {
      const cyw = Math.cos(ridge.yaw), syw = Math.sin(ridge.yaw), cp = Math.cos(ridge.pitch), sp = Math.sin(ridge.pitch);
      const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw;
      // looking down from above: farther rows (z1 > 0) rise up the screen
      const y2 = y * cp + z1 * sp, z2 = -y * sp + z1 * cp;
      const d = 3.6, f = Math.min(W * 0.98, H * 1.9);
      const k = f / (z2 + d);
      return [W * 0.56 + x1 * k, H * 0.47 - y2 * k, z2];
    };

    cv.addEventListener('pointerdown', e => { ridge.drag = { x: e.clientX, y: e.clientY, yaw: ridge.yaw, pitch: ridge.pitch }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointerup', () => { ridge.drag = null; });
    cv.addEventListener('pointermove', e => {
      const r = cv.getBoundingClientRect();
      ridge.mx = e.clientX - r.left; ridge.my = e.clientY - r.top;
      if (ridge.drag) {
        ridge.yaw = ridge.drag.yaw + (e.clientX - ridge.drag.x) * 0.006;
        ridge.pitch = clamp(ridge.drag.pitch + (e.clientY - ridge.drag.y) * 0.004, 0.08, 1.2);
      }
    });
    cv.addEventListener('pointerleave', () => { ridge.mx = null; read.style.opacity = 0; });

    const frame = now => {
      ridge.running = open && isVisible(cv);
      if (!ridge.running) { requestAnimationFrame(frame); return; }
      ridge.t = now / 1000;
      if (!ridge.drag) ridge.yaw += Math.sin(ridge.t * 0.25) * 0.0006;   // a slow sway
      const fg = cssVar('--fg') || '#f2f2f0', bg = cssVar('--bg') || '#0a0a0a', acc = cssVar('--accent') || '#4c8dff', dim = cssVar('--dim') || '#8a8a8a';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const nR = rows.length, HY = 0.7;
      const labels = [];
      const zOf = r => 1 - 2 * r / (nR - 1);   // row 0 at the back, drawn first
      const xOf = i => -1.3 + 2.6 * i / (nW - 1);
      // rows rise once the chart has been scrolled into view
      ridge.g = (ridge.g || 0) + ((ridge.shownAt ? 1 : 0) - (ridge.g || 0)) * 0.045;
      const grow = ease(ridge.g);

      // rows from back to front, each filled with the background so nearer rows hide farther ones
      let hov = null, hovD = 400;
      for (let r = 0; r < nR; r++) {
        const z = zOf(r), v = rows[r];
        const depth = r / (nR - 1);
        // the ridge as a classic joyplot: fill with the background to hide rows behind,
        // then stroke only the top line
        const start = proj(xOf(0), 0, z);
        const top = new Path2D();
        const step = 2;
        for (let i = 0; i < nW; i += step) {
          const p = proj(xOf(i), v[i] * HY * grow, z);
          if (i === 0) top.moveTo(p[0], p[1]); else top.lineTo(p[0], p[1]);
          if (ridge.mx != null && !ridge.drag) {
            const d = (p[0] - ridge.mx) ** 2 + (p[1] - ridge.my) ** 2;
            if (d < hovD) { hovD = d; hov = { r, i, x: p[0], y: p[1] }; }
          }
        }
        const end = proj(xOf(nW - 1), 0, z);
        const body = new Path2D(top);
        body.lineTo(end[0], end[1]);
        body.lineTo(start[0], start[1]);
        body.closePath();
        ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fill(body);
        ctx.globalAlpha = 0.25 + 0.65 * depth;
        ctx.strokeStyle = hov && hov.r === r ? acc : fg;
        ctx.lineWidth = hov && hov.r === r ? 1.6 : 1;
        ctx.stroke(top);
        labels.push([r, start, depth]);
      }
      // event scars: a dashed line across the floor and a post at the back, on top of the rows
      evIdx.forEach(([i, label]) => {
        const a = proj(xOf(i), 0, -1.08), b = proj(xOf(i), 0, 1.05), top = proj(xOf(i), HY * 0.85, 1.05);
        ctx.globalAlpha = 0.55; ctx.strokeStyle = acc; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 0.9; ctx.fillStyle = acc; ctx.font = `300 10px ${HW.MONO}`; ctx.textAlign = 'center';
        ctx.fillText(label, top[0], top[1] - 6);
      });

      // strait names at the left foot of each row, drawn last so no row covers them
      ctx.font = `300 10px ${HW.MONO}`; ctx.textAlign = 'right';
      labels.forEach(([r, p, depth]) => {
        ctx.globalAlpha = 0.5 + 0.5 * depth; ctx.fillStyle = hov && hov.r === r ? acc : dim;
        ctx.fillText(short(names[r]).toUpperCase(), p[0] - 8, p[1] + 3);
      });
      // year ticks along the front edge
      ctx.globalAlpha = 0.6; ctx.fillStyle = dim; ctx.textAlign = 'center';
      weeks.forEach((w, i) => {
        if (w.slice(5, 7) === '01' && w.slice(8) <= '07') { const p = proj(xOf(i), 0, -1.12); ctx.fillText(w.slice(0, 4), p[0], p[1] + 14); }
      });
      ctx.globalAlpha = 1;

      if (hov) {
        ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(hov.x, hov.y, 3.5, 0, 6.2832); ctx.fill();
        const name = names[hov.r], raw = F.ridge.series[name][hov.i];
        read.innerHTML = `<span style="color:var(--dim)">${name.toUpperCase()} · ${fDay(weeks[hov.i])} ${weeks[hov.i].slice(0, 4)}</span><br><b>${fInt(raw)} SHIPS</b>`;
        read.style.left = Math.min(W - 200, hov.x + 14) + 'px'; read.style.top = Math.max(0, hov.y - 52) + 'px'; read.style.opacity = 1;
      } else if (!ridge.drag) read.style.opacity = 0;
      requestAnimationFrame(frame);
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

  /* ---------- load ---------- */
  fetch('data/forecast.json').then(r => r.json()).then(data => {
    F = data;
    renderKpis();
    renderMultiples();
    renderFeature();
    renderSignals();
    renderDots();
    setupRidge();
    // the kpis count up again the first time the screen opens
    let counted = false;
    const obs = new MutationObserver(() => { if (open && !counted) { counted = true; renderKpis(); } });
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }).catch(() => { btn.style.display = 'none'; });
})();
