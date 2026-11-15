/* The ship dive in real 3D (three.js, loaded from a CDN through the import map in index.html).

   What you see:
   - an ocean with real reflections and moving wave normals (three.js Water shader)
   - a physical sky (three.js Sky shader) with the Sun at its true elevation over the ship
     right now, so a ship in the dark half of the world is seen at night under stars
   - a cloud layer you fall through on the way down, like zooming into Google Earth
   - a ship built from its AIS type and length: tanker (deck pipes), container ship
     (stacked boxes), bulk carrier (hatches and cranes), passenger / ro-ro, general cargo
   - weather from Open-Meteo at the ship: wave height and wind set how rough the water is
     and how the ship pitches and rolls; cloud cover sets the clouds and haze; rain, snow,
     fog and thunderstorms get their own effects; sea temperature tints the water

   Same interface as the old 2D scene (js/ship.js), so main.js can use either one:
     open(ship, weather), setWeather(weather), setMode('top' | 'side'), close(), S
   Drag to look around the ship, scroll to move closer or further. */

import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { Sky } from 'three/addons/objects/Sky.js';

const HW = window.HW;
const NORMALS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/waternormals.jpg';
const RAD = Math.PI / 180;
// ?hours=6 shifts the Sun six hours ahead (to show a daytime scene in a demo); 0 = real time
const HOURS = +(new URLSearchParams(location.search).get('hours') || 0) || 0;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = x => { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

/* ---------- the Sun's elevation and direction at a place, right now ---------- */
const sunAt = (lat, lon, date = new Date()) => {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * RAD, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD, e = 23.439 * RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (280.46061837 + 360.98564736629 * d) * RAD;
  const ha = gmst + lon * RAD - ra;                       // hour angle
  const la = lat * RAD;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));   // from north, clockwise
  return { el, az };
};

/* ---------- soft textures drawn on the fly ---------- */
const canvasTex = (w, h, draw) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
};
const cloudTex = () => canvasTex(256, 256, (g, w, h) => {
  // a cumulus puff: many overlapping soft blobs
  for (let i = 0; i < 26; i++) {
    const x = w * (0.25 + 0.5 * Math.random()), y = h * (0.35 + 0.35 * Math.random()), r = w * (0.08 + 0.16 * Math.random());
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
});
const dotTex = () => canvasTex(64, 64, (g, w) => {
  const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, w);
});
const windowsTex = (rows, cols) => canvasTex(256, 128, (g, w, h) => {
  g.fillStyle = '#f2f2ee'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#1d2630';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    g.fillRect(6 + c * (w - 12) / cols, 8 + r * (h - 16) / rows, (w - 12) / cols * 0.62, (h - 16) / rows * 0.42);
  }
});

/* ---------- ships, built from simple shapes at real proportions (metres) ---------- */
const mat = (color, rough = 0.7, metal = 0.1) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
const CONTAINER_COLOURS = [0x2a5a9e, 0xb8322a, 0xd9822b, 0x3c7d4f, 0x8a8f96, 0xe2e0d8, 0x1f3a5f, 0x7a2f2a, 0xc9a227, 0x3d4a57];

const hullShape = (L, B) => {
  // plan view: square stern, parallel body, rounded pointed bow (x forward)
  const s = new THREE.Shape(), h = B / 2, bowStart = L * 0.32;
  s.moveTo(-L / 2, -h * 0.92);
  s.lineTo(-L / 2 + B * 0.15, -h);
  s.lineTo(L / 2 - bowStart, -h);
  s.bezierCurveTo(L / 2 - bowStart * 0.35, -h, L / 2, -h * 0.35, L / 2, 0);
  s.bezierCurveTo(L / 2, h * 0.35, L / 2 - bowStart * 0.35, h, L / 2 - bowStart, h);
  s.lineTo(-L / 2 + B * 0.15, h);
  s.lineTo(-L / 2, h * 0.92);
  s.closePath();
  return s;
};
const slab = (shape, depth, material, y) => {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 18 });
  g.rotateX(-Math.PI / 2);            // extrude upward
  const m = new THREE.Mesh(g, material); m.position.y = y; m.castShadow = true; m.receiveShadow = true;
  return m;
};

const buildShip = (kind, L) => {
  const ship = new THREE.Group();
  const B = L * (kind === 'passenger' ? 0.13 : 0.155), draft = L * 0.045, free = L * (kind === 'passenger' ? 0.05 : 0.06);
  const shape = hullShape(L, B);
  const hullTop = { tanker: 0x24272b, cargo: 0x1e3550, bulk: 0x5b1e1e, passenger: 0xf2f2ee, general: 0x2c3a2f }[kind] || 0x24272b;
  ship.add(slab(shape, draft, mat(0x7b2420, 0.8), -draft));                 // red bottom paint below the waterline
  ship.add(slab(shape, free, mat(hullTop, 0.55, 0.2), 0));                  // topsides
  const deckCol = kind === 'tanker' ? 0x3f5a46 : kind === 'passenger' ? 0xc9c4b8 : 0x6b6e70;
  ship.add(slab(shape, 0.4, mat(deckCol, 0.9), free));                      // deck
  const D = free + 0.4;

  // accommodation block and funnel at the stern
  const accomH = kind === 'passenger' ? L * 0.09 : L * 0.075;
  const accomLen = kind === 'passenger' ? L * 0.72 : L * 0.09;
  const accom = new THREE.Mesh(new THREE.BoxGeometry(accomLen, accomH, B * (kind === 'passenger' ? 0.92 : 0.86)),
    new THREE.MeshStandardMaterial({ map: windowsTex(kind === 'passenger' ? 7 : 5, kind === 'passenger' ? 18 : 6), roughness: 0.6 }));
  accom.position.set(kind === 'passenger' ? -L * 0.08 : -L / 2 + accomLen / 2 + L * 0.03, D + accomH / 2, 0);
  accom.castShadow = true; ship.add(accom);
  const wings = new THREE.Mesh(new THREE.BoxGeometry(accomLen * 0.35, 1.2, B * 1.04), mat(0xeeeeea));
  wings.position.set(accom.position.x + accomLen * 0.3, D + accomH - 0.8, 0); ship.add(wings);
  const funnelCol = { tanker: 0xd9822b, cargo: 0x2a5a9e, bulk: 0x1f1f1f, passenger: 0x1a3d8f, general: 0xb8322a }[kind] || 0x333333;
  const funnel = new THREE.Mesh(new THREE.BoxGeometry(L * 0.025, accomH * 0.45, B * 0.3), mat(funnelCol, 0.5));
  funnel.position.set(accom.position.x - accomLen * 0.25, D + accomH + accomH * 0.22, 0); ship.add(funnel);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, accomH * 0.6), mat(0xdddddd));
  mast.position.set(accom.position.x + accomLen * 0.1, D + accomH + accomH * 0.3, 0); ship.add(mast);

  const fwd0 = -L / 2 + accomLen + L * 0.05, fwd1 = L / 2 - L * 0.1;   // the cargo area
  if (kind === 'cargo') {
    // container stacks: 40 ft boxes, rows across the beam, tiers up from the deck
    const box = new THREE.BoxGeometry(12.2, 2.59, 2.44);
    const across = Math.max(4, Math.floor(B / 2.5)), bays = Math.floor((fwd1 - fwd0) / 13);
    const n = across * bays * 7;
    const inst = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.2 }), n);
    const m4 = new THREE.Matrix4(), c = new THREE.Color();
    let k = 0;
    for (let b = 0; b < bays; b++) {
      const x = fwd0 + 6.5 + b * 13, taper = x > L / 2 - L * 0.25 ? 0.7 : 1;
      for (let a = 0; a < across * taper; a++) {
        const z = (a - (across * taper - 1) / 2) * 2.5, tiers = 3 + Math.floor(Math.random() * 5);
        for (let t = 0; t < tiers && k < n; t++) {
          m4.makeTranslation(x, D + 1.3 + t * 2.6, z); inst.setMatrixAt(k, m4);
          inst.setColorAt(k, c.setHex(CONTAINER_COLOURS[(Math.random() * CONTAINER_COLOURS.length) | 0])); k++;
        }
      }
    }
    inst.count = k; inst.castShadow = true; ship.add(inst);
  } else if (kind === 'tanker') {
    // pipe runs, a catwalk and the cargo manifold amidships
    for (let p = -2; p <= 2; p++) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, fwd1 - fwd0), mat(0xb9b9b4, 0.5, 0.5));
      pipe.rotation.z = Math.PI / 2; pipe.position.set((fwd0 + fwd1) / 2, D + 1 + Math.abs(p) * 0.2, p * 1.4); ship.add(pipe);
    }
    const walk = new THREE.Mesh(new THREE.BoxGeometry(fwd1 - fwd0, 0.3, 1.6), mat(0xd8d8d2));
    walk.position.set((fwd0 + fwd1) / 2, D + 3.2, 0); ship.add(walk);
    const mani = new THREE.Mesh(new THREE.BoxGeometry(6, 3, B * 0.85), mat(0x9fa3a6, 0.5, 0.4));
    mani.position.set((fwd0 + fwd1) / 2, D + 1.5, 0); ship.add(mani);
  } else if (kind === 'bulk' || kind === 'general') {
    // hatch covers and deck cranes
    const holds = kind === 'bulk' ? 7 : 5, len = (fwd1 - fwd0) / holds;
    for (let h = 0; h < holds; h++) {
      const hatch = new THREE.Mesh(new THREE.BoxGeometry(len * 0.72, 1.8, B * 0.62), mat(kind === 'bulk' ? 0x6a2a24 : 0x2f4f6f, 0.7));
      hatch.position.set(fwd0 + len * (h + 0.5), D + 0.9, 0); hatch.castShadow = true; ship.add(hatch);
      if (h % 2 === 0 && h < holds - 1) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 14), mat(0xd6b330, 0.6));
        post.position.set(fwd0 + len * (h + 1), D + 7, B * 0.18); ship.add(post);
        const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, len * 1.5), mat(0xd6b330, 0.6));
        boom.rotation.z = Math.PI / 2.6; boom.position.set(fwd0 + len * (h + 1) + len * 0.4, D + 12, B * 0.18); ship.add(boom);
      }
    }
    if (kind === 'general') {
      const box = new THREE.BoxGeometry(6.1, 2.59, 2.44);
      for (let i = 0; i < 18; i++) {
        const b = new THREE.Mesh(box, mat(CONTAINER_COLOURS[i % CONTAINER_COLOURS.length], 0.75));
        b.position.set(fwd0 + 4 + (i % 6) * 6.6, D + 2.7 + Math.floor(i / 6) * 2.6, -B * 0.1); ship.add(b);
      }
    }
  } else if (kind === 'passenger') {
    const deck2 = new THREE.Mesh(new THREE.BoxGeometry(L * 0.5, accomH * 0.35, B * 0.8),
      new THREE.MeshStandardMaterial({ map: windowsTex(3, 22), roughness: 0.6 }));
    deck2.position.set(-L * 0.08, D + accomH + accomH * 0.17, 0); ship.add(deck2);
  }

  // navigation lights: red to port, green to starboard, white masthead (they glow at night)
  const lamp = (c, x, y, z) => { const l = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 8), new THREE.MeshBasicMaterial({ color: c })); l.position.set(x, y, z); l.userData.lamp = true; ship.add(l); };
  lamp(0xff2a2a, accom.position.x + accomLen * 0.35, D + accomH - 0.6, -B * 0.53);
  lamp(0x2aff6a, accom.position.x + accomLen * 0.35, D + accomH - 0.6, B * 0.53);
  lamp(0xffffff, mast.position.x, mast.position.y + accomH * 0.3, 0);
  ship.userData = { L, B, D, draft, accomTop: D + accomH };
  return ship;
};

/* ---------- weather from Open-Meteo -> scene settings ---------- */
const envFrom = (w, ship) => {
  w = w || {};
  const code = +w.weather_code || 0;
  return {
    wave: w.wave_height != null ? +w.wave_height : 0.8,
    period: w.wave_period != null ? +w.wave_period : 7,
    wind: w.wind_speed_10m != null ? +w.wind_speed_10m : 10,
    windDir: w.wind_direction_10m != null ? +w.wind_direction_10m : 0,
    cloud: w.cloud_cover != null ? +w.cloud_cover / 100 : 0.35,
    rain: (code >= 51 && code <= 67) || (code >= 80 && code <= 82) ? (code % 10 >= 5 || code >= 63 ? 1 : 0.55) : 0,
    snow: (code >= 71 && code <= 77) || code === 85 || code === 86 ? 1 : 0,
    fog: code === 45 || code === 48 ? 1 : (w.visibility != null && +w.visibility < 4000 ? 0.6 : 0),
    storm: code >= 95 ? 1 : 0,
    sst: w.sea_surface_temperature != null ? +w.sea_surface_temperature : 18,
    speed: ship && ship.sog != null ? +ship.sog : 12,
  };
};

HW.makeShipScene3D = canvas => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 1, 30000);

  // ocean
  const normals = new THREE.TextureLoader().load(NORMALS, t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; });
  const water = new Water(new THREE.PlaneGeometry(40000, 40000), {
    textureWidth: 512, textureHeight: 512, waterNormals: normals,
    sunDirection: new THREE.Vector3(), sunColor: 0xffffff, waterColor: 0x0b3b4a, distortionScale: 3.7, fog: true,
  });
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  // sky, sun light and an environment map made from the sky
  const sky = new Sky(); sky.scale.setScalar(20000); scene.add(sky);
  const sun = new THREE.Vector3();
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
  sunLight.castShadow = true; sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 10, far: 3000 });
  scene.add(sunLight, sunLight.target);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x0b2230, 0.6); scene.add(hemi);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  // stars, for night
  const starGeo = new THREE.BufferGeometry(), sp = [];
  for (let i = 0; i < 2500; i++) { const v = new THREE.Vector3().randomDirection(); if (v.y < 0.02) v.y = Math.abs(v.y) + 0.02; v.multiplyScalar(15000); sp.push(v.x, v.y, v.z); }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
  scene.add(stars);

  // clouds: a layer of soft sprites the camera falls through
  const cloudMap = cloudTex();
  const clouds = new THREE.Group(); scene.add(clouds);
  const cloudMat = new THREE.SpriteMaterial({ map: cloudMap, transparent: true, depthWrite: false, opacity: 0.85, fog: false });
  for (let i = 0; i < 160; i++) {
    const s = new THREE.Sprite(cloudMat.clone());
    const r = Math.sqrt(Math.random()) * 5000, a = Math.random() * 6.2832;
    s.position.set(Math.cos(a) * r, 800 + Math.random() * 700, Math.sin(a) * r);
    const sc = 500 + Math.random() * 900; s.scale.set(sc, sc * 0.55, 1);
    s.userData.base = s.material.opacity = 0.5 + Math.random() * 0.45;
    clouds.add(s);
  }

  // rain or snow: short streaks in a box that follows the camera
  const N_RAIN = 6000, rainPos = new Float32Array(N_RAIN * 6);
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xcfd8e2, transparent: true, opacity: 0.4, depthWrite: false }));
  rain.frustumCulled = false; scene.add(rain);
  const drops = Array.from({ length: N_RAIN }, () => [Math.random() * 600 - 300, Math.random() * 300, Math.random() * 600 - 300]);

  // wake and spray: soft white particles left behind the stern and thrown off the bow
  const N_FOAM = 3200, foamPos = new Float32Array(N_FOAM * 3), foamAge = new Float32Array(N_FOAM).fill(99), foamVel = new Float32Array(N_FOAM * 3);
  const foamGeo = new THREE.BufferGeometry(); foamGeo.setAttribute('position', new THREE.BufferAttribute(foamPos, 3));
  const foam = new THREE.Points(foamGeo, new THREE.PointsMaterial({ map: dotTex(), color: 0xffffff, size: 4.5, transparent: true, opacity: 0.8, depthWrite: false }));
  foam.frustumCulled = false; scene.add(foam);
  let foamNext = 0;

  // night lighting: a cool moonlight and warm floodlights on the ship
  const moon = new THREE.DirectionalLight(0x9fb4d8, 0); moon.position.set(-600, 900, 400); scene.add(moon);
  const flood = new THREE.PointLight(0xffd9a0, 0, 600, 1.4); scene.add(flood);
  const flood2 = new THREE.PointLight(0xffe4b8, 0, 500, 1.4); scene.add(flood2);

  // lightning flash
  const flash = new THREE.AmbientLight(0xdfe8ff, 0); scene.add(flash);

  let ship = null, env = envFrom(null), S = { on: false, intro: 0, mode: 'top', kind: 'tanker', alt: 3200 };
  let shipData = null, heading = 0, t = 0, last = 0, raf = 0;
  const orbit = { az: 0, el: 0.85, dist: 420, tAz: 0, tEl: 0.85, tDist: 420, user: false };
  let night = 0;

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  const kindOf = s => {
    const g = s.type_group || HW.vesselGroup(s.type);
    if (g === 'tanker') return 'tanker';
    if (g === 'passenger') return 'passenger';
    if (/BULK|ORE|COAL|GRAIN|CAPE|MAX\b/i.test(s.name || '')) return 'bulk';
    if (g === 'cargo') return +s.length && +s.length < 140 ? 'general' : 'cargo';
    return 'general';
  };

  const applySky = () => {
    if (!shipData) return;
    const { el, az } = sunAt(+shipData.lat, +shipData.lon, new Date(Date.now() + HOURS * 3600e3));
    // sky sits around the ship: x east, z south (three.js: -z is north)
    const phi = Math.PI / 2 - el, theta = Math.PI - az;   // az from north clockwise
    sun.setFromSphericalCoords(1, Math.max(0.02, Math.min(Math.PI - 0.02, phi)), theta);
    const u = sky.material.uniforms;
    u.turbidity.value = 2 + env.cloud * 9 + env.fog * 6;
    u.rayleigh.value = 1.2 + env.cloud * 1.5;
    u.mieCoefficient.value = 0.005 + env.fog * 0.02;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(sun);
    water.material.uniforms.sunDirection.value.copy(sun).normalize();
    night = clamp((-el / RAD + 2) / 10, 0, 1);              // 0 = day, 1 = full night (sun 8° below)
    sunLight.position.copy(sun).multiplyScalar(1500);
    sunLight.intensity = lerp(2.4, 0.05, night) * (1 - 0.6 * env.cloud);
    hemi.intensity = lerp(0.7, 0.28, night);
    moon.intensity = night * 0.9 * (1 - env.cloud * 0.5);
    water.material.uniforms.sunColor.value.setScalar(lerp(1, 0.08, night));
    renderer.toneMappingExposure = lerp(0.55, 0.25, night) * (1 - 0.25 * env.cloud);
    stars.material.opacity = night * (1 - env.cloud * 0.8) * (1 - env.fog);
    if (envRT) envRT.dispose();
    envRT = pmrem.fromScene(sky);
    scene.environment = envRT.texture;
  };

  const applyWeather = () => {
    const u = water.material.uniforms;
    u.distortionScale.value = clamp(1.2 + env.wave * 1.6 + env.wind / 20, 1, 9);
    u.size.value = clamp(1.4 - env.wave * 0.12, 0.6, 1.4);
    // sea colour from temperature: cold slate to warm teal
    const warm = clamp((env.sst - 4) / 26, 0, 1);
    u.waterColor.value.setRGB(lerp(0.02, 0.0, warm), lerp(0.12, 0.26, warm), lerp(0.16, 0.28, warm)).multiplyScalar(1 - 0.4 * (env.storm || env.rain * 0.5));
    // haze and fog
    const fogCol = new THREE.Color().setRGB(0.55, 0.6, 0.66).multiplyScalar(lerp(1, 0.08, night));
    scene.fog = new THREE.FogExp2(fogCol, 0.00004 + env.fog * 0.0016 + env.rain * 0.0004 + env.snow * 0.0006 + env.storm * 0.0004);
    rain.material.color.set(env.snow ? 0xffffff : 0xcfd8e2);
    rain.material.opacity = env.snow ? 0.75 : 0.35;
    // clouds: how many show depends on cover; grey and heavy when it rains
    clouds.children.forEach((c, i) => {
      const show = i / clouds.children.length < 0.15 + env.cloud * 0.85;
      c.visible = show;
      c.material.color.setScalar(lerp(1, 0.45, Math.max(env.rain * 0.6, env.storm)) * lerp(1, 0.18, night));
    });
    applySky();
  };

  // drag to look around, scroll to zoom
  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, az: orbit.tAz, el: orbit.tEl }; orbit.user = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    orbit.tAz = drag.az - (e.clientX - drag.x) * 0.006;
    orbit.tEl = clamp(drag.el + (e.clientY - drag.y) * 0.004, 0.03, 1.45);
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', e => { e.preventDefault(); orbit.tDist = clamp(orbit.tDist * Math.exp(e.deltaY * 0.0012), 60, 2400); orbit.user = true; }, { passive: false });

  const modeTargets = () => {
    const L = ship ? ship.userData.L : 200;
    // camera azimuth is measured in the x-z plane: az = atan2(z, x)
    const behind = Math.atan2(Math.cos(heading), -Math.sin(heading));     // astern of the ship
    const beam = Math.atan2(Math.sin(heading), Math.cos(heading));        // off the starboard side
    return S.mode === 'side'
      ? { el: 0.06, dist: L * 1.25, az: beam - 0.18 }      // low, beside the hull
      : { el: 0.72, dist: L * 1.75, az: behind + 0.55 };   // drone, from behind and above
  };

  const frame = now => {
    raf = requestAnimationFrame(frame);
    if (!S.on) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now; t += dt;
    const L = ship.userData.L;

    // the descent: from high above, through the clouds, down to the ship
    S.intro = clamp(S.intro + dt / 6.5, 0, 1);
    const k = ease(S.intro);
    const tg = modeTargets();
    if (!orbit.user) { orbit.tAz = tg.az; orbit.tEl = tg.el; orbit.tDist = tg.dist; }
    orbit.az = lerp(orbit.az, orbit.tAz, 1 - Math.exp(-3 * dt));
    orbit.el = lerp(orbit.el, orbit.tEl, 1 - Math.exp(-3 * dt));
    orbit.dist = lerp(orbit.dist, orbit.tDist, 1 - Math.exp(-3 * dt));
    const el = lerp(1.5, orbit.el, k), dist = lerp(3400, orbit.dist, k), az = lerp(orbit.az + 1.2, orbit.az, k);
    const cx = Math.cos(el) * Math.cos(az) * dist, cz = Math.cos(el) * Math.sin(az) * dist, cy = Math.max(6, Math.sin(el) * dist);
    camera.position.set(cx, cy, cz);
    camera.lookAt(0, lerp(0, ship.userData.D * 0.6, k), 0);
    S.alt = camera.position.y;

    // the ship rides the swell: heave, pitch and roll scale with wave height and period
    const per = Math.max(4, env.period), amp = clamp(env.wave, 0.1, 9);
    ship.position.y = Math.sin(t * 6.2832 / per) * amp * 0.28;
    ship.rotation.z = Math.sin(t * 6.2832 / per + 0.6) * clamp(amp * 0.006, 0.002, 0.05);
    ship.rotation.x = Math.sin(t * 6.2832 / (per * 1.3) + 1.7) * clamp(amp * 0.012, 0.004, 0.12);

    // water moves with the wind
    water.material.uniforms.time.value += dt * (0.5 + env.wind / 22);

    // wake: emit at the stern quarters and bow, drift aft, spread, fade
    const fwd = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading)), side = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
    const kn = Math.max(1.5, env.speed);
    foamNext -= dt * (90 + kn * 30);
    while (foamNext < 0) {
      foamNext += 1;
      const i = (Math.random() * N_FOAM) | 0, bow = Math.random() < 0.3;
      const along = bow ? L * 0.46 : -L * 0.5, s2 = (Math.random() < 0.5 ? -1 : 1) * (bow ? 0.5 : Math.random() * 0.5) * ship.userData.B;
      foamPos[i * 3] = fwd.x * along + side.x * s2; foamPos[i * 3 + 1] = 0.6; foamPos[i * 3 + 2] = fwd.z * along + side.z * s2;
      const spread = bow ? 4 : 1.5;
      foamVel[i * 3] = -fwd.x * kn * 0.5 + side.x * Math.sign(s2) * spread; foamVel[i * 3 + 1] = bow ? 2 + Math.random() * 3 : 0; foamVel[i * 3 + 2] = -fwd.z * kn * 0.5 + side.z * Math.sign(s2) * spread;
      foamAge[i] = 0;
    }
    for (let i = 0; i < N_FOAM; i++) {
      foamAge[i] += dt;
      if (foamAge[i] > 14) { foamPos[i * 3 + 1] = -999; continue; }
      foamPos[i * 3] += foamVel[i * 3] * dt; foamPos[i * 3 + 2] += foamVel[i * 3 + 2] * dt;
      foamPos[i * 3 + 1] = Math.max(0.4, foamPos[i * 3 + 1] + foamVel[i * 3 + 1] * dt); foamVel[i * 3 + 1] -= 9.8 * dt;
      foamVel[i * 3] *= 0.995; foamVel[i * 3 + 2] *= 0.995;
    }
    foamGeo.attributes.position.needsUpdate = true;
    foam.material.opacity = lerp(0.85, 0.35, night);

    // rain / snow around the camera
    const precip = Math.max(env.rain, env.snow, env.storm);
    rain.visible = precip > 0;
    if (rain.visible) {
      const fall = env.snow ? 18 : 160, wx = Math.sin(env.windDir * RAD) * env.wind * 0.4, wz = -Math.cos(env.windDir * RAD) * env.wind * 0.4;
      const len = env.snow ? 0.6 : 7;
      const nShow = Math.floor(N_RAIN * clamp(precip, 0.2, 1));
      for (let i = 0; i < N_RAIN; i++) {
        const d = drops[i];
        d[1] -= fall * dt; d[0] += wx * dt; d[2] += wz * dt;
        if (d[1] < 0) { d[1] = 300; d[0] = Math.random() * 600 - 300; d[2] = Math.random() * 600 - 300; }
        const x = d[0], y = d[1], z = d[2];   // the rain box sits around the ship
        const o = i * 6, vis = i < nShow ? 1 : 0;
        rainPos[o] = x; rainPos[o + 1] = vis ? y : -999; rainPos[o + 2] = z;
        rainPos[o + 3] = x - wx * 0.03; rainPos[o + 4] = vis ? y + len : -999; rainPos[o + 5] = z - wz * 0.03;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }

    // thunderstorm: an occasional double flash
    if (env.storm) {
      if (Math.random() < dt * 0.25) flash.userData.t = 0;
      if (flash.userData.t != null) {
        flash.userData.t += dt;
        const f = flash.userData.t;
        flash.intensity = f < 0.08 ? 5 : f < 0.16 ? 0 : f < 0.24 ? 3.5 : 0;
        if (f > 0.3) flash.userData.t = null;
      }
    }

    // clouds drift with the wind and thin out as the camera passes through them
    const cdx = Math.sin(env.windDir * RAD) * env.wind * 0.5 * dt, cdz = -Math.cos(env.windDir * RAD) * env.wind * 0.5 * dt;
    clouds.children.forEach(c => {
      c.position.x += cdx; c.position.z += cdz;
      const near = Math.abs(c.position.y - camera.position.y);
      c.material.opacity = c.userData.base * clamp(near / 220, 0.15, 1) * (1 - env.fog * 0.5);
    });

    // night: the ship's own lights, and floodlights over the deck and superstructure
    const lit = night > 0.3 || env.fog > 0.5;
    ship.children.forEach(m => { if (m.userData.lamp) m.visible = lit; });
    const ud = ship.userData;
    flood.position.set(-fwd.x * L * 0.38, ship.position.y + ud.accomTop + 12, -fwd.z * L * 0.38);
    flood2.position.set(fwd.x * L * 0.15, ship.position.y + ud.D + 22, fwd.z * L * 0.15);
    flood.intensity = lit ? 9000 : 0; flood2.intensity = lit ? 6000 : 0;

    renderer.render(scene, camera);
  };

  const api = {
    S,
    open(s, w) {
      shipData = s;
      S.kind = kindOf(s);
      const L = clamp(+s.length >= 60 ? +s.length : ({ tanker: 230, cargo: 300, bulk: 225, passenger: 200, general: 130 })[S.kind], 60, 400);
      if (ship) { scene.remove(ship); ship.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
      ship = buildShip(S.kind, L);
      // course is clockwise from north; in the scene north is -z and east is +x, and the
      // ship model points along +x, so turning it by (90° - course) points it on its course
      heading = (s.cog != null ? +s.cog : 0) * RAD;
      ship.rotation.order = 'YXZ';
      ship.rotation.y = Math.PI / 2 - heading;
      scene.add(ship);
      env = envFrom(w, s);
      orbit.user = false; S.intro = 0; S.on = true; S.mode = S.mode || 'top';
      const tg = modeTargets(); Object.assign(orbit, { az: tg.az, el: tg.el, dist: tg.dist, tAz: tg.az, tEl: tg.el, tDist: tg.dist });
      foamAge.fill(99);
      resize(); applyWeather();
      last = performance.now();
      if (!raf) raf = requestAnimationFrame(frame);
    },
    setWeather(w) { env = envFrom(w, shipData); applyWeather(); },
    setMode(m) { S.mode = m; orbit.user = false; },
    close() { S.on = false; },
    envFrom,
  };
  return api;
};
HW.webgl3d = true;
