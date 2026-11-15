/* The ship dive as real drone footage, dressed in the live weather.

   1. A Google-Earth style zoom: real satellite imagery of the ship's actual position
      (Esri World Imagery), zooming in continuously from ~300 km across to ~1 km, centred
      on the ship, then dissolving into the footage.
   2. The footage: a top-down drone clip picked for the situation (free Pexels clips in
      web/ship/, labelled on screen as representative, since they aren't this exact ship):
        moored container ship -> container_port   moored other ship -> jetty
        night at the ship     -> night            grey / rain / fog  -> grey_sea
        tanker -> tanker      container ship -> container_sea      bulk / general -> open_sea
   3. Live weather on top: colour grade for night, overcast and storm; rain or snow;
      drifting fog; cloud shadows; lightning; wind-blown spray; vignette and grain.

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
    let flash = 0, label = null;

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
      if (moored) return S.kind === 'cargo' ? 'container_port' : 'jetty';
      if (env.night > 0.5) return 'night';
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
    const loadTiles = s => {
      tiles = [];
      [8, 10, 12, 14, 16].forEach(z => {
        const [fx, fy] = tileXY(+s.lon, +s.lat, z), x0 = Math.floor(fx) - 1, y0 = Math.floor(fy) - 1;
        const cv = document.createElement('canvas'); cv.width = cv.height = 768;
        const g = cv.getContext('2d'); let n = 0;
        const entry = { z, cv, fx, fy, x0, y0, ready: false };
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
          const im = new Image(); im.crossOrigin = 'anonymous';
          im.onload = () => { g.drawImage(im, i * 256, j * 256); if (++n >= 5) entry.ready = true; };
          im.src = ESRI(z, x0 + i, y0 + j);
        }
        tiles.push(entry);
      });
    };
    // draw the satellite at a continuous zoom Z, centred on the ship
    const drawSat = Z => {
      const usable = tiles.filter(e => e.ready && e.z <= Math.ceil(Z));
      const e = usable[usable.length - 1] || tiles.find(x => x.ready); if (!e) return false;
      const scale = 2 ** (Z - e.z) * (Math.max(W, H) / 512);          // screen px per tile px
      const px = (e.fx - e.x0) * 256, py = (e.fy - e.y0) * 256;      // ship in the mosaic
      ctx.drawImage(e.cv, W / 2 - px * scale, H / 2 - py * scale, 768 * scale, 768 * scale);
      return true;
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
      ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, W, H);

      // 1. satellite zoom (0..4.5 s), 2. dissolve to footage (4.5..6 s)
      S.intro = clamp(t / 6, 0, 1);
      const Z = lerp(8, 16.6, ease(clamp(t / 4.8, 0, 1)));
      const into = clamp((t - 4.4) / 1.6, 0, 1);
      if (into < 1) drawSat(Z);
      S.alt = into < 1 ? Math.round(40075000 * Math.cos(+ship.lat * RAD) / 2 ** Z * (W / 256) / 2.2) : (S.mode === 'side' ? 140 : 320);

      if (into > 0 && video.readyState >= 2) {
        const vw = video.videoWidth, vh = video.videoHeight;
        const zoomIn = S.mode === 'side' ? 1.7 : 1;
        S.vz = lerp(S.vz || 1.25, zoomIn, 1 - Math.exp(-2.5 * dt));
        const s = Math.max(W / vw, H / vh) * S.vz * lerp(1.25, 1, ease(into));
        ctx.globalAlpha = ease(into);
        ctx.filter = grade();
        ctx.drawImage(video, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
        ctx.filter = 'none'; ctx.globalAlpha = 1;
        note.style.opacity = into > 0.9 ? 1 : 0;
      }

      // 3. weather layers
      const wx = Math.sin(env.windDir * RAD), wy = -Math.cos(env.windDir * RAD);
      // cloud shadows drifting with the wind
      if (env.cloud > 0.2 && env.night < 0.6) {
        shadows.forEach(c => {
          c[0] = (c[0] + wx * env.wind * 0.00004 + 1) % 1; c[1] = (c[1] + wy * env.wind * 0.00004 + 1) % 1;
          const r = c[2] * Math.max(W, H), g = ctx.createRadialGradient(c[0] * W, c[1] * H, 0, c[0] * W, c[1] * H, r);
          g.addColorStop(0, `rgba(0,0,0,${(0.22 * env.cloud).toFixed(3)})`); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        });
      }
      // fog banks
      if (env.fog > 0.1 || env.rain > 0.5) {
        const a = Math.max(env.fog * 0.5, env.rain * 0.12);
        fog.forEach(f => {
          f[0] = (f[0] + wx * 0.00012 + 1.2) % 1.4 - 0.2;
          const r = f[2] * Math.max(W, H), g = ctx.createRadialGradient(f[0] * W, f[1] * H, 0, f[0] * W, f[1] * H, r);
          const c = env.night > 0.5 ? '40,46,54' : '205,212,218';
          g.addColorStop(0, `rgba(${c},${a.toFixed(3)})`); g.addColorStop(1, `rgba(${c},0)`);
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        });
      }
      // wind spray: streaks of white over the water in strong wind
      if (env.wind > 18) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
        ctx.beginPath();
        spray.forEach(p => {
          p[0] = (p[0] + wx * dt * 0.08 * (env.wind / 25) + 1) % 1; p[1] = (p[1] + wy * dt * 0.08 * (env.wind / 25) + 1) % 1;
          const x = p[0] * W, y = p[1] * H, l = 6 + p[2] * 14;
          ctx.moveTo(x, y); ctx.lineTo(x - wx * l, y - wy * l);
        });
        ctx.stroke();
      }
      // rain or snow, falling toward the camera (seen from above: short streaks blown by the wind)
      const precip = Math.max(env.rain, env.snow, env.storm);
      if (precip > 0) {
        const n = Math.floor(drops.length * clamp(precip, 0.25, 1));
        ctx.strokeStyle = env.snow ? 'rgba(255,255,255,0.8)' : 'rgba(210,222,235,0.45)';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = env.snow ? 0 : 1.1;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const d = drops[i];
          d[0] = (d[0] + (wx * 0.05 + 0.02) * dt * d[2] * (env.snow ? 0.3 : 3) + 1) % 1;
          d[1] = (d[1] + (wy * 0.05 + 0.25) * dt * d[2] * (env.snow ? 0.3 : 3) + 1) % 1;
          const x = d[0] * W, y = d[1] * H;
          if (env.snow) ctx.rect(x, y, 2, 2); else { ctx.moveTo(x, y); ctx.lineTo(x - (wx * 0.05 + 0.02) * 120, y - (wy * 0.05 + 0.25) * 60); }
        }
        if (env.snow) ctx.fill(); else ctx.stroke();
      }
      // lightning
      if (env.storm) {
        if (Math.random() < dt * 0.2) flash = 1;
        if (flash > 0) { ctx.fillStyle = `rgba(225,235,255,${(flash * 0.55).toFixed(3)})`; ctx.fillRect(0, 0, W, H); flash -= dt * 5; }
      }
      // vignette and a little grain
      const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${(0.45 + env.night * 0.25).toFixed(2)})`);
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
      // intro: start from black
      if (t < 0.6) { ctx.fillStyle = `rgba(5,7,10,${(1 - t / 0.6).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
    };

    return {
      S, envFrom,
      open(s, w) {
        ship = s; S.kind = kindOf(s); env = envFrom(w, s);
        resize(); loadTiles(s); setClip(pickClip());
        S.on = true; S.vz = 1.25; t0 = performance.now(); last = t0;
        if (!raf) raf = requestAnimationFrame(frame);
      },
      setWeather(w) { env = envFrom(w, ship); setClip(pickClip()); },
      setMode(m) { S.mode = m; },
      close() { S.on = false; video.pause(); note.style.opacity = 0; },
    };
  };
})();
