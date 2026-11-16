/* The ship dive as real drone footage, dressed in the live weather.

   1. A Google-Earth style zoom: real satellite imagery of the ship's actual position
      (Esri World Imagery), zooming in continuously from ~300 km across to ~1 km, centred
      on the ship, then dissolving into the footage.
   2. The footage: a top-down drone clip picked for the situation (free Pexels clips in
      web/ship/, labelled on screen as representative, since they aren't this exact ship):
        moored container ship -> container_port   moored other ship -> jetty
        night at the ship     -> night            grey / rain / fog  -> grey_sea
        tanker -> tanker      container ship -> container_sea      bulk / general -> open_sea
   3. Live weather as a colour grade only: darker and greyer for night, overcast, rain and
      storm. No particle effects, so the footage stays clean.

   Same interface as the other ship scenes, so main.js can use any of them:
     open(ship, weather), setWeather(weather), setMode('top' | 'side'), close(), S
   DRONE shows the whole frame; PROFILE (here "close") pushes in on the ship. */

(() => {
  const HW = window.HW, RAD = Math.PI / 180;
  const ESRI = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  const CLIPS = {
    container_sea: 'ship/container_sea.mp4', container_port: 'ship/container_port.mp4', night: 'ship/night.mp4',
    grey_sea: 'ship/grey_sea.mp4', jetty: 'ship/jetty.mp4', open_sea: 'ship/open_sea.mp4', tanker: 'ship/tanker.mp4',
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = x => { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

  const sunElev = (lat, lon) => {
    const d = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 864e5;
    const g = (357.529 + 0.98560028 * d) * RAD, L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD, e = 23.439 * RAD;
    const dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const ha = (280.46061837 + 360.98564736629 * d) * RAD + lon * RAD - ra, la = lat * RAD;
    return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / RAD;
  };
  const tileXY = (lon, lat, z) => {
    const n = 2 ** z;
    return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2 * n];
  };

  const envFrom = (w, s) => {
    w = w || {};
    const code = +w.weather_code || 0;
    return {
      cloud: w.cloud_cover != null ? +w.cloud_cover / 100 : 0.3,
      wind: w.wind_speed_10m != null ? +w.wind_speed_10m : 10, windDir: w.wind_direction_10m != null ? +w.wind_direction_10m : 0,
      wave: w.wave_height != null ? +w.wave_height : 0.8,
      rain: (code >= 51 && code <= 67) || (code >= 80 && code <= 82) ? (code >= 63 ? 1 : 0.6) : 0,
      snow: (code >= 71 && code <= 77) || code === 85 || code === 86 ? 1 : 0,
      fog: code === 45 || code === 48 ? 1 : (w.visibility != null && +w.visibility < 4000 ? 0.6 : 0),
      storm: code >= 95 ? 1 : 0,
      night: s ? clamp((-sunElev(+s.lat, +s.lon) + 2) / 10, 0, 1) : 0,
    };
  };

  HW.makeShipSceneVideo = canvas => {
    const ctx = canvas.getContext('2d');
    const video = document.createElement('video');
    Object.assign(video, { muted: true, loop: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
    let W = 0, H = 0, DPR = 1, raf = 0, t0 = 0, last = 0;
    let ship = null, env = envFrom(null), clip = '', tiles = [];   // tiles: {z, img, x0, y0}
    const S = { on: false, intro: 0, mode: 'top', kind: 'cargo', alt: 5000, clip: '' };
    const drops = Array.from({ length: 900 }, () => [Math.random(), Math.random(), 0.5 + Math.random()]);
    const fog = Array.from({ length: 14 }, () => [Math.random(), Math.random(), 0.25 + Math.random() * 0.4]);
    const shadows = Array.from({ length: 8 }, () => [Math.random(), Math.random(), 0.2 + Math.random() * 0.35]);
    const spray = Array.from({ length: 160 }, () => [Math.random(), Math.random(), Math.random()]);
    let flash = 0, label = null, started = false;

    const resize = () => {
      DPR = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth || innerWidth; H = canvas.clientHeight || innerHeight;
      canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    };
    window.addEventListener('resize', resize);

    // the honest caption under the footage
    const note = document.createElement('div');
    note.style.cssText = 'position:absolute;left:50%;top:64px;transform:translateX(-50%);font:300 9.5px ui-monospace,Menlo,monospace;letter-spacing:.16em;color:rgba(255,255,255,.55);pointer-events:none;text-transform:uppercase;transition:opacity .8s;opacity:0;white-space:nowrap';
    canvas.parentElement.appendChild(note);

    const kindOf = s => {
      const g = s.type_group || HW.vesselGroup(s.type);
      if (g === 'tanker') return 'tanker';
      if (g === 'passenger') return 'passenger';
      if (/BULK|ORE|COAL|GRAIN|CAPE|MAX\b/i.test(s.name || '')) return 'bulk';
      if (g === 'cargo') return +s.length && +s.length < 140 ? 'general' : 'cargo';
      return 'general';
    };
    const pickClip = () => {
      const moored = ship.sog != null && +ship.sog < 0.8;
      // the night clip is a ship alongside a lit quay, so it's only for ships that aren't moving;
      // a ship underway at night gets the sea footage, darkened by the grade
      if (moored) return env.night > 0.5 ? 'night' : S.kind === 'cargo' ? 'container_port' : 'jetty';
      if (env.rain || env.storm || env.fog > 0.5 || env.cloud > 0.8) return 'grey_sea';
      if (S.kind === 'tanker') return 'tanker';
      if (S.kind === 'cargo') return 'container_sea';
      return 'open_sea';
    };
    const setClip = name => {
      if (clip === name) return;
      clip = name; S.clip = name;
      video.src = CLIPS[name];
      video.play().catch(() => {});
      note.textContent = 'Representative drone footage · not this exact ship · Pexels';
    };

    // satellite pyramid around the ship: 3x3 tiles at a few zoom levels
    const probeCv = document.createElement('canvas'); probeCv.width = probeCv.height = 8;
    const probe = probeCv.getContext('2d', { willReadFrequently: true });
    const loadTiles = s => {
      tiles = [];
      [5, 7, 9, 11, 13, 15, 17].forEach(z => {
        const [fx, fy] = tileXY(+s.lon, +s.lat, z), x0 = Math.floor(fx) - 1, y0 = Math.floor(fy) - 1;
        const cv = document.createElement('canvas'); cv.width = cv.height = 768;
        const g = cv.getContext('2d'); let n = 0, blank = 0;
        const entry = { z, cv, fx, fy, x0, y0, ready: false };
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
          const im = new Image(); im.crossOrigin = 'anonymous';
          im.onload = () => {
            // far out at sea Esri has no close-up imagery and sends a flat grey "no data" tile:
            // spot it (bright, colourless, almost no variation) and drop that whole level
            probe.drawImage(im, 0, 0, 8, 8);
            const d = probe.getImageData(0, 0, 8, 8).data;
            let sum = 0, sat = 0, lo = 255, hi = 0;
            for (let q = 0; q < d.length; q += 4) { const l = (d[q] + d[q + 1] + d[q + 2]) / 3; sum += l; sat += Math.max(d[q], d[q + 1], d[q + 2]) - Math.min(d[q], d[q + 1], d[q + 2]); lo = Math.min(lo, l); hi = Math.max(hi, l); }
            if (sum / 64 > 150 && sat / 64 < 10 && hi - lo < 40) { if (++blank >= 3) entry.bad = true; return; }
            g.drawImage(im, i * 256, j * 256);
            if (++n >= 5 && !entry.bad) entry.ready = true;
          };
          im.src = ESRI(z, x0 + i, y0 + j);
        }
        tiles.push(entry);
      });
    };
    // Draw the satellite at a continuous zoom Z, centred on the ship. Every loaded level is
    // drawn, coarse first, so finer imagery sits as a sharp patch in the middle that grows as
    // you push in: one unbroken zoom with no level-to-level pops.
    const drawSat = Z => {
      let any = false;
      for (const e of tiles) {
        if (!e.ready || e.bad || e.z > Z + 3) continue;
        const scale = 2 ** (Z - e.z) * (Math.max(W, H) / 512);          // screen px per tile px
        if (scale > 24 && tiles.some(o => o.ready && !o.bad && o.z > e.z)) continue;   // a finer level covers this
        const px = (e.fx - e.x0) * 256, py = (e.fy - e.y0) * 256;
        // fade a finer level in as it arrives, so its edge never snaps on
        ctx.globalAlpha = clamp((Z + 3 - e.z) / 1.2, 0, 1);
        ctx.drawImage(e.cv, W / 2 - px * scale, H / 2 - py * scale, 768 * scale, 768 * scale);
        any = true;
      }
      ctx.globalAlpha = 1;
      return any;
    };

    const grade = () => {
      const n = env.night, grey = Math.max(env.cloud * 0.7, env.fog, env.rain * 0.8, env.storm);
      const clipNight = clip === 'night';
      const b = clipNight ? 1 : lerp(1, 0.45, n) * lerp(1, 0.85, grey) * (env.storm ? 0.8 : 1);
      const sat = lerp(1.08, 0.55, Math.max(grey, n * 0.8));
      return `brightness(${b.toFixed(2)}) saturate(${sat.toFixed(2)}) contrast(${(1.04 + env.storm * 0.08).toFixed(2)})`;
    };

    const frame = now => {
      raf = requestAnimationFrame(frame);
      if (!S.on) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
      const t = (now - t0) / 1000;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // No satellite zoom any more (Kimball, Nov 15): the globe flies to the ship underneath, and
      // the footage fades in over it once the clip has a frame to show (at most 2.5 s wait).
      if (!started) {
        if (video.readyState >= 2 || now - t0 > 2500) { started = true; t0 = now; }
        else { S.intro = 0; canvas.parentElement.style.background = 'transparent'; return; }
      }
      const t2 = (now - t0) / 1000;
      const into = clamp(t2 / 1.4, 0, 1), ein = into * into * (3 - 2 * into), fadeIn = into;
      S.intro = into;
      canvas.parentElement.style.background = into >= 1 ? '#05070a' : 'transparent';
      ctx.globalAlpha = ein; ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      S.alt = Math.round(lerp(1800, S.mode === 'side' ? 140 : 320, ein));

      if (into > 0 && video.readyState >= 2) {
        const vw = video.videoWidth, vh = video.videoHeight;
        const zoomIn = S.mode === 'side' ? 1.7 : 1;
        S.vz = lerp(S.vz || 1, zoomIn, 1 - Math.exp(-2.5 * dt));
        // the footage arrives still pushing in: it starts wide and settles as it sharpens
        const sc = Math.max(W / vw, H / vh) * S.vz * lerp(1.12, 1, ein);
        ctx.globalAlpha = ein;
        ctx.filter = grade();
        ctx.drawImage(video, (W - vw * sc) / 2, (H - vh * sc) / 2, vw * sc, vh * sc);
        ctx.filter = 'none'; ctx.globalAlpha = 1;
        note.style.opacity = into > 0.9 ? 1 : 0;
      }
      if (fadeIn < 1) return;   // weather layers start once we're fully in

      // 3. weather shows through the colour grade only (rain, fog, spray and lightning layers
      //    were dropped to keep the footage clean), plus a soft vignette
      // vignette and a little grain
      const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${(0.28 + env.night * 0.15).toFixed(2)})`);
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    };

    return {
      S, envFrom,
      open(s, w) {
        ship = s; S.kind = kindOf(s); env = envFrom(w, s);
        resize(); setClip(pickClip());
        S.on = true; S.vz = 1; started = false; t0 = performance.now(); last = t0;
        if (!raf) raf = requestAnimationFrame(frame);
      },
      setWeather(w) { env = envFrom(w, ship); setClip(pickClip()); },
      setMode(m) { S.mode = m; },
      close() { S.on = false; video.pause(); note.style.opacity = 0; canvas.parentElement.style.background = ''; },
    };
  };
})();
