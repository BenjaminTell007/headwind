/* The ship dive in 3D (three.js, loaded from a CDN through the import map in index.html).

   It's meant to feel like zooming into the Earth and finding a ship:
   - Satellite ground: Sentinel-2 cloudless imagery (EOX, CC BY-NC-SA, credited on screen)
     draped under the scene, about 17 km across. Near a coast, port or river you see the
     real land and the water is masked to the real coastline; out at sea it's just ocean.
   - A real 3D ocean: six Gerstner waves sized from the live wave height, period and the
     swell and wind directions, plus fine ripples from a normal map, Fresnel sky reflection,
     a sharp sun glint and foam on the crests. Waves die down near land (harbours are calm).
   - The ship and every other live ship within ~20 km, at their real positions, built from
     AIS type and length, moving along their real course and speed and riding the waves.
     Name tags follow them; click one to glide over to that ship.
   - A physical sky with the Sun at its true elevation over the ship right now, clouds you
     fall through on the way down, rain, snow, fog, lightning and night with ship lights.
   - HDR rendering with 4x MSAA, bloom on the glints and lights, a light grade and grain.

   Same interface as the old 2D scene (js/ship.js), so main.js can use either:
     open(ship, weather), setWeather(weather), setMode('top' | 'side'), close(), S
   Drag to look around, scroll to zoom. ?hours=6 shifts the Sun 6 h (to show daylight). */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const HW = window.HW;
const NORMALS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/waternormals.jpg';
const EOX = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`;
const ESRI = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const RAD = Math.PI / 180;
const HOURS = +(new URLSearchParams(location.search).get('hours') || 0) || 0;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = x => { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

/* ---------- the Sun at a place and time ---------- */
const sunAt = (lat, lon, date) => {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * RAD, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD, e = 23.439 * RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const ha = (280.46061837 + 360.98564736629 * d) * RAD + lon * RAD - ra, la = lat * RAD;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { el, az };
};

/* ---------- small textures drawn on the fly ---------- */
const canvasTex = (w, h, draw, srgb = true) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
};
const cloudTex = () => canvasTex(256, 256, (g, w, h) => {
  for (let i = 0; i < 30; i++) {
    const x = w * (0.22 + 0.56 * Math.random()), y = h * (0.35 + 0.35 * Math.random()), r = w * (0.07 + 0.17 * Math.random());
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
});
const dotTex = () => canvasTex(64, 64, (g, w) => {
  const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, w);
});
const windowsTex = (rows, cols, lit) => canvasTex(256, 128, (g, w, h) => {
  g.fillStyle = '#f0efea'; g.fillRect(0, 0, w, h);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    g.fillStyle = lit && Math.random() < 0.55 ? '#ffd38a' : '#1b2430';
    g.fillRect(6 + c * (w - 12) / cols, 8 + r * (h - 16) / rows, (w - 12) / cols * 0.62, (h - 16) / rows * 0.42);
  }
});
const nameTex = (name, colour) => canvasTex(1024, 128, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.font = '700 84px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = colour; g.fillText((name || '').toUpperCase().slice(0, 22), w / 2, h / 2 + 4);
});
// a grimy noise used as roughness/bump so hulls aren't plastic
const grimeTex = () => canvasTex(512, 512, (g, w, h) => {
  const im = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const v = 150 + Math.random() * 80 + (Math.sin(i * 0.013) * 10); im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
  g.putImageData(im, 0, 0);
}, false);

/* ---------- ships ---------- */
const GRIME = grimeTex(); GRIME.wrapS = GRIME.wrapT = THREE.RepeatWrapping; GRIME.repeat.set(6, 2);
const mat = (color, rough = 0.7, metal = 0.15, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, roughnessMap: GRIME, ...extra });
const CONTAINER_COLOURS = [0x2a5a9e, 0xb8322a, 0xd9822b, 0x3c7d4f, 0x8a8f96, 0xe2e0d8, 0x1f3a5f, 0x7a2f2a, 0xc9a227, 0x3d4a57, 0x14628c, 0x9b3d2e];

const hullShape = (L, B) => {
  const s = new THREE.Shape(), h = B / 2, bowStart = L * 0.3;
  s.moveTo(-L / 2, -h * 0.9);
  s.quadraticCurveTo(-L / 2, -h, -L / 2 + B * 0.2, -h);
  s.lineTo(L / 2 - bowStart, -h);
  s.bezierCurveTo(L / 2 - bowStart * 0.35, -h, L / 2, -h * 0.32, L / 2, 0);
  s.bezierCurveTo(L / 2, h * 0.32, L / 2 - bowStart * 0.35, h, L / 2 - bowStart, h);
  s.lineTo(-L / 2 + B * 0.2, h);
  s.quadraticCurveTo(-L / 2, h, -L / 2, h * 0.9);
  s.closePath();
  return s;
};
const slab = (shape, depth, material, y, bevel = 0) => {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 24 });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, material); m.position.y = y; m.castShadow = true; m.receiveShadow = true;
  return m;
};

const buildShip = (kind, L, name) => {
  const ship = new THREE.Group();
  const B = L * (kind === 'passenger' ? 0.13 : 0.155), draft = L * 0.045, free = L * (kind === 'passenger' ? 0.05 : 0.065);
  const shape = hullShape(L, B);
  const hullTop = { tanker: 0x1f2226, cargo: 0x1c3550, bulk: 0x4f1b1b, passenger: 0xf2f2ee, general: 0x2a382e }[kind] || 0x1f2226;
  ship.add(slab(shape, draft + 0.2, mat(0x6e211d, 0.85, 0.05), -draft));                       // antifouling red
  ship.add(slab(shape, 0.9, mat(0xeeeeea, 0.6, 0.05), 0.15));                                  // boot-top line
  ship.add(slab(shape, free - 1, mat(hullTop, 0.42, 0.35), 1.05, 0.25));                       // topsides
  const deckCol = kind === 'tanker' ? 0x3d5a45 : kind === 'passenger' ? 0xc7c1b4 : 0x5f6264;
  ship.add(slab(shape, 0.35, mat(deckCol, 0.9, 0.05), free));
  const D = free + 0.35;

  // the ship's name on both bows and across the stern
  const nm = new THREE.MeshBasicMaterial({ map: nameTex(name, kind === 'passenger' ? '#1a3d8f' : '#f2f2ee'), transparent: true, depthWrite: false });
  [[-1, L * 0.36], [1, L * 0.36]].forEach(([side, x]) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(B * 1.6, B * 0.2), nm);
    p.position.set(x, free * 0.62, side * (B / 2 + 0.12) * 0.86); p.rotation.y = side > 0 ? 0 : Math.PI; ship.add(p);
  });
  const sternName = new THREE.Mesh(new THREE.PlaneGeometry(B * 0.9, B * 0.11), nm);
  sternName.position.set(-L / 2 - 0.15, free * 0.65, 0); sternName.rotation.y = -Math.PI / 2; ship.add(sternName);

  // accommodation, bridge wings, funnel and mast
  const accomH = kind === 'passenger' ? L * 0.09 : L * 0.075;
  const accomLen = kind === 'passenger' ? L * 0.72 : L * 0.09;
  const winMat = new THREE.MeshStandardMaterial({ map: windowsTex(kind === 'passenger' ? 7 : 5, kind === 'passenger' ? 18 : 6, true), roughness: 0.5, metalness: 0.1, emissiveMap: null });
  const accom = new THREE.Mesh(new THREE.BoxGeometry(accomLen, accomH, B * (kind === 'passenger' ? 0.92 : 0.86)), winMat);
  accom.position.set(kind === 'passenger' ? -L * 0.08 : -L / 2 + accomLen / 2 + L * 0.03, D + accomH / 2, 0);
  accom.castShadow = accom.receiveShadow = true; ship.add(accom);
  const wings = new THREE.Mesh(new THREE.BoxGeometry(accomLen * 0.35, 1.2, B * 1.04), mat(0xeeeeea, 0.5));
  wings.position.set(accom.position.x + accomLen * 0.3, D + accomH - 0.8, 0); wings.castShadow = true; ship.add(wings);
  const funnelCol = { tanker: 0xd9822b, cargo: 0x2a5a9e, bulk: 0x1f1f1f, passenger: 0x1a3d8f, general: 0xb8322a }[kind] || 0x333333;
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(B * 0.13, B * 0.16, accomH * 0.5, 20), mat(funnelCol, 0.45, 0.3));
  funnel.position.set(accom.position.x - accomLen * 0.25, D + accomH + accomH * 0.25, 0); funnel.castShadow = true; ship.add(funnel);
  const funnelTop = new THREE.Mesh(new THREE.CylinderGeometry(B * 0.135, B * 0.135, accomH * 0.08, 20), mat(0x111111, 0.6));
  funnelTop.position.set(funnel.position.x, funnel.position.y + accomH * 0.27, 0); ship.add(funnelTop);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, accomH * 0.6), mat(0xdddddd, 0.4, 0.6));
  mast.position.set(accom.position.x + accomLen * 0.1, D + accomH + accomH * 0.3, 0); ship.add(mast);
  const radar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 4.5), mat(0xeeeeee, 0.4)); radar.position.set(mast.position.x, mast.position.y + accomH * 0.2, 0); radar.userData.spin = true; ship.add(radar);

  const fwd0 = -L / 2 + accomLen + L * 0.05, fwd1 = L / 2 - L * 0.1;
  if (kind === 'cargo') {
    const box = new THREE.BoxGeometry(12.1, 2.55, 2.4);
    const across = Math.max(4, Math.floor(B / 2.5)), bays = Math.floor((fwd1 - fwd0) / 13);
    const n = across * bays * 8;
    const inst = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.25, roughnessMap: GRIME }), n);
    const m4 = new THREE.Matrix4(), c = new THREE.Color();
    let k = 0;
    for (let b = 0; b < bays; b++) {
      const x = fwd0 + 6.5 + b * 13, taper = x > L / 2 - L * 0.22 ? 0.66 : 1;
      for (let a = 0; a < Math.floor(across * taper); a++) {
        const z = (a - (Math.floor(across * taper) - 1) / 2) * 2.48, tiers = 3 + Math.floor(Math.random() * 6);
        for (let t = 0; t < tiers && k < n; t++) {
          m4.makeTranslation(x, D + 1.3 + t * 2.58, z); inst.setMatrixAt(k, m4);
          inst.setColorAt(k, c.setHex(CONTAINER_COLOURS[(Math.random() * CONTAINER_COLOURS.length) | 0]).multiplyScalar(0.8 + Math.random() * 0.3)); k++;
        }
      }
    }
    inst.count = k; inst.castShadow = inst.receiveShadow = true; ship.add(inst);
    // lashing bridges between bays
    for (let b = 0; b <= bays; b += 2) { const lb = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5, B * 0.96), mat(0x8a8d8f, 0.5, 0.5)); lb.position.set(fwd0 + b * 13, D + 2.5, 0); ship.add(lb); }
  } else if (kind === 'tanker') {
    for (let p = -2; p <= 2; p++) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, fwd1 - fwd0, 10), mat(0xb5b5b0, 0.4, 0.6));
      pipe.rotation.z = Math.PI / 2; pipe.position.set((fwd0 + fwd1) / 2, D + 1 + Math.abs(p) * 0.25, p * 1.35); pipe.castShadow = true; ship.add(pipe);
    }
    const walk = new THREE.Mesh(new THREE.BoxGeometry(fwd1 - fwd0, 0.3, 1.6), mat(0xd8d8d2, 0.6));
    walk.position.set((fwd0 + fwd1) / 2, D + 3.2, 0); walk.castShadow = true; ship.add(walk);
    const mani = new THREE.Mesh(new THREE.BoxGeometry(6, 3, B * 0.86), mat(0x9fa3a6, 0.45, 0.5));
    mani.position.set((fwd0 + fwd1) / 2, D + 1.5, 0); ship.add(mani);
    for (let h = 0; h < 6; h++) { const dome = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.8, 16), mat(0x8c9196, 0.5, 0.5)); dome.position.set(fwd0 + (h + 0.5) * (fwd1 - fwd0) / 6, D + 0.4, B * 0.28); ship.add(dome); }
  } else if (kind === 'bulk' || kind === 'general') {
    const holds = kind === 'bulk' ? 7 : 5, len = (fwd1 - fwd0) / holds;
    for (let h = 0; h < holds; h++) {
      const hatch = new THREE.Mesh(new THREE.BoxGeometry(len * 0.72, 1.8, B * 0.62), mat(kind === 'bulk' ? 0x6a2a24 : 0x2f4f6f, 0.65, 0.3));
      hatch.position.set(fwd0 + len * (h + 0.5), D + 0.9, 0); hatch.castShadow = hatch.receiveShadow = true; ship.add(hatch);
      if (h % 2 === 0 && h < holds - 1) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 14, 16), mat(0xd6b330, 0.55, 0.3));
        post.position.set(fwd0 + len * (h + 1), D + 7, B * 0.18); post.castShadow = true; ship.add(post);
        const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, len * 1.5, 10), mat(0xd6b330, 0.55, 0.3));
        boom.rotation.z = Math.PI / 2.6; boom.position.set(fwd0 + len * (h + 1) + len * 0.4, D + 12, B * 0.18); boom.castShadow = true; ship.add(boom);
      }
    }
    if (kind === 'general') {
      const box = new THREE.BoxGeometry(6.1, 2.55, 2.4);
      for (let i = 0; i < 18; i++) {
        const bx = new THREE.Mesh(box, mat(CONTAINER_COLOURS[i % CONTAINER_COLOURS.length], 0.7, 0.25));
        bx.position.set(fwd0 + 4 + (i % 6) * 6.6, D + 2.7 + Math.floor(i / 6) * 2.6, -B * 0.1); bx.castShadow = true; ship.add(bx);
      }
    }
  } else if (kind === 'passenger') {
    const deck2 = new THREE.Mesh(new THREE.BoxGeometry(L * 0.5, accomH * 0.35, B * 0.8), new THREE.MeshStandardMaterial({ map: windowsTex(3, 22, true), roughness: 0.5 }));
    deck2.position.set(-L * 0.08, D + accomH + accomH * 0.17, 0); deck2.castShadow = true; ship.add(deck2);
  }

  const lamp = (c, x, y, z) => { const l = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 10), new THREE.MeshBasicMaterial({ color: c })); l.position.set(x, y, z); l.userData.lamp = true; ship.add(l); };
  lamp(0xff3030, accom.position.x + accomLen * 0.35, D + accomH - 0.6, -B * 0.53);
  lamp(0x30ff70, accom.position.x + accomLen * 0.35, D + accomH - 0.6, B * 0.53);
  lamp(0xffffff, mast.position.x, mast.position.y + accomH * 0.3, 0);
  lamp(0xffffff, L * 0.45, D + 4, 0);
  ship.userData = { L, B, D, draft, accomTop: D + accomH, accomX: accom.position.x };
  return ship;
};

/* ---------- weather from Open-Meteo -> scene settings ---------- */
const envFrom = (w, ship) => {
  w = w || {};
  const code = +w.weather_code || 0;
  return {
    wave: w.wave_height != null ? +w.wave_height : 0.8,
    period: w.wave_period != null ? +w.wave_period : 7,
    waveDir: w.wave_direction != null ? +w.wave_direction : (w.wind_direction_10m != null ? +w.wind_direction_10m : 0),
    swell: w.swell_wave_height != null ? +w.swell_wave_height : 0.5,
    swellDir: w.swell_wave_direction != null ? +w.swell_wave_direction : (w.wave_direction != null ? +w.wave_direction : 0),
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

/* ---------- the ocean: Gerstner waves + ripples + Fresnel + glint + foam ---------- */
const N_WAVES = 10, N_SHIPS = 8;
const SHIP_PARS = `
  uniform vec4 uShipA[${N_SHIPS}];   // x, z, heading (rad, clockwise from north), length
  uniform vec4 uShipB[${N_SHIPS}];   // beam, speed (m/s), active, 0
`;
const OCEAN_VS = `
  uniform float uTime;
  uniform vec4 uWave[${N_WAVES}];     // dir.x, dir.z, steepness, wavelength
  uniform float uDisplace;
  uniform sampler2D uMask; uniform vec4 uMaskRect;   // x0, z0, size, on
  ${SHIP_PARS}
  varying vec3 vWorld; varying vec3 vNormal; varying float vCrest; varying float vLand;
  #include <fog_pars_vertex>
  float landAt(vec2 xz) {
    if (uMaskRect.w < 0.5) return 0.0;
    vec2 uv = (xz - uMaskRect.xy) / uMaskRect.z;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
    return texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).r;
  }
  void main() {
    vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
    float land = landAt(p.xz);
    float amp = uDisplace * (1.0 - smoothstep(0.05, 0.5, land)) * (1.0 - smoothstep(1000.0, 1180.0, length(p.xz - cameraPosition.xz)));
    // calm the swell under and right around each hull so water never pokes through a deck
    for (int j = 0; j < ${N_SHIPS}; j++) {
      if (uShipB[j].z < 0.5) continue;
      vec2 d = p.xz - uShipA[j].xy; float h = uShipA[j].z;
      vec2 fwd = vec2(sin(h), -cos(h)), side = vec2(cos(h), sin(h));
      float along = dot(d, fwd) / (uShipA[j].w * 0.5), lat = dot(d, side) / (uShipB[j].x * 0.5);
      float inside = 1.0 - smoothstep(0.85, 1.35, max(abs(along), abs(lat) * 0.92));
      amp *= 1.0 - 0.85 * inside;
    }
    vec3 tangent = vec3(1.0, 0.0, 0.0), binormal = vec3(0.0, 0.0, 1.0), disp = vec3(0.0);
    float crest = 0.0;
    for (int i = 0; i < ${N_WAVES}; i++) {
      vec4 w = uWave[i];
      float k = 6.2831853 / w.w, c = sqrt(9.8 / k);
      vec2 dd = normalize(w.xy);
      float f = k * (dot(dd, p.xz) - c * uTime);
      float st = w.z * amp, a = st / k;
      disp += vec3(dd.x * a * cos(f), a * sin(f), dd.y * a * cos(f));
      tangent += vec3(-dd.x * dd.x * st * sin(f), dd.x * st * cos(f), -dd.x * dd.y * st * sin(f));
      binormal += vec3(-dd.x * dd.y * st * sin(f), dd.y * st * cos(f), -dd.y * dd.y * st * sin(f));
      crest += st * sin(f);
    }
    p += disp;
    vWorld = p; vNormal = normalize(cross(binormal, tangent)); vCrest = crest; vLand = land;
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const OCEAN_FS = `
  #define ENVMAP_TYPE_CUBE_UV
  uniform float uTime; uniform sampler2D uNormals; uniform vec3 uSunDir; uniform vec3 uSunColor;
  uniform vec3 uDeep; uniform vec3 uShallow; uniform float uFoam; uniform float uNight; uniform float uRipple;
  uniform sampler2D envMap; uniform float uEnvOn; uniform vec3 uSkyTop; uniform vec3 uSkyHorizon;
  ${SHIP_PARS}
  varying vec3 vWorld; varying vec3 vNormal; varying float vCrest; varying float vLand;
  #include <common>
  #include <cube_uv_reflection_fragment>
  #include <fog_pars_fragment>
  float tex(vec2 uv) { return texture2D(uNormals, uv).g; }
  void main() {
    if (vLand > 0.5) discard;                                       // land: the satellite ground shows
    vec3 V = normalize(cameraPosition - vWorld);
    float dist = length(cameraPosition - vWorld);
    float near = 1.0 - smoothstep(150.0, 3500.0, dist);

    // ship wakes: waterline foam, bow wave, Kelvin wedge arms and propeller wash
    float wake = 0.0, churn = 0.0;
    for (int j = 0; j < ${N_SHIPS}; j++) {
      if (uShipB[j].z < 0.5) continue;
      vec2 d = vWorld.xz - uShipA[j].xy; float h = uShipA[j].z, L = uShipA[j].w, B = uShipB[j].x, v = uShipB[j].y;
      vec2 fwd = vec2(sin(h), -cos(h)), side = vec2(cos(h), sin(h));
      float along = dot(d, fwd), lat = dot(d, side), alat = abs(lat);
      float e = max(abs(along) / (L * 0.5), alat / (B * 0.5));
      float sp = clamp(v / 8.0, 0.0, 1.5);
      // a ring of foam pressed against the hull, thicker toward the bow when moving
      wake += smoothstep(1.28, 1.02, e) * step(0.97, e) * (0.35 + 0.65 * sp * smoothstep(-0.1, 0.5, along / L));
      // bow wave pushed out ahead and to the sides
      float bow = along - L * 0.5;
      wake += sp * exp(-pow(max(bow, 0.0) / (B * 0.6), 2.0)) * exp(-pow(alat / (B * 0.9), 2.0)) * step(-L * 0.12, bow);
      // behind the stern: the V-shaped Kelvin wake (arms at 19.5 degrees) and the propwash
      float behind = -along - L * 0.5;
      if (behind > 0.0 && v > 0.4) {
        float decay = exp(-behind / (120.0 + v * 70.0));
        float ang = atan(alat, behind + B * 0.5);
        float arms = exp(-pow((ang - 0.34) / 0.045, 2.0)) * smoothstep(0.0, 25.0, behind);
        float wash = exp(-pow(alat / (B * 0.55 + behind * 0.045), 2.0));
        wake += (arms * 0.75 + wash * 0.95) * decay * sp;
        churn += wash * decay * sp;
      }
    }

    // fine ripples: three layers of the normal map, choppier in the propwash
    vec2 uv = vWorld.xz * 0.019;
    vec3 n1 = texture2D(uNormals, uv + vec2(uTime * 0.012, uTime * 0.009)).rbg * 2.0 - 1.0;
    vec3 n2 = texture2D(uNormals, uv * 2.7 - vec2(uTime * 0.013, -uTime * 0.017)).rbg * 2.0 - 1.0;
    vec3 n3 = texture2D(uNormals, uv * 11.0 + vec2(-uTime * 0.04, uTime * 0.03)).rbg * 2.0 - 1.0;
    vec3 ripple = vec3(n1.x * 0.3 + n2.x * 0.6 + n3.x * (0.55 + churn * 2.0) * near, 0.0, n1.z * 0.3 + n2.z * 0.6 + n3.z * (0.55 + churn * 2.0) * near);
    vec3 N = normalize(vNormal + ripple * uRipple * (0.04 + 0.16 * near));
    float NdV = max(dot(N, V), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    vec3 R = reflect(-V, N); R.y = abs(R.y);
    vec3 refl = uEnvOn > 0.5 ? textureCubeUV(envMap, R, 0.04).rgb : mix(uSkyHorizon, uSkyTop, pow(R.y, 0.45));
    float sd = max(dot(R, uSunDir), 0.0);
    vec3 glint = uSunColor * (pow(sd, 1400.0) * 40.0 + pow(sd, 120.0) * 0.5) * (1.0 - uNight);
    // light scattered up from below: brighter and greener through crests facing the sun
    float sss = clamp(vCrest * 0.22 + 0.3, 0.0, 1.0) * (0.35 + 0.65 * max(dot(normalize(vec3(-uSunDir.x, 0.0, -uSunDir.z)), -V) * 0.5 + 0.5, 0.0));
    vec3 body = mix(uDeep, uShallow, clamp(sss * 0.6 + vLand * 1.5, 0.0, 1.0));
    vec3 col = mix(body, refl, fres) + glint;
    // foam: steep crests, coastlines and wakes, broken up by the ripple texture
    float breakup = tex(uv * 3.1 + uTime * 0.01) * 0.6 + tex(uv * 13.0 - uTime * 0.02) * 0.4;
    float foam = smoothstep(0.6, 1.15, vCrest + breakup * 0.35) * uFoam;
    foam += smoothstep(0.25, 0.48, vLand) * 0.55;
    foam += smoothstep(0.18, 0.9, wake * (0.55 + breakup * 0.9));
    vec3 foamCol = vec3(0.93, 0.96, 0.98) * mix(1.0, 0.16, uNight);
    col = mix(col, foamCol, clamp(foam, 0.0, 0.92));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/* ---------- satellite ground and the land/water mask around a point ---------- */
const lonLatToTile = (lon, lat, z) => {
  const n = 2 ** z, x = (lon + 180) / 360 * n;
  const y = (1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2 * n;
  return [x, y];
};
// a square mosaic of T x T tiles centred on a point; returns the canvas and where the point sits
const mosaic = async (urlOf, Z, T, lat, lon) => {
  const PX = 256 * T, [fx, fy] = lonLatToTile(lon, lat, Z);
  const tx0 = Math.floor(fx) - (T >> 1), ty0 = Math.floor(fy) - (T >> 1);
  const cv = document.createElement('canvas'); cv.width = cv.height = PX;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
    jobs.push(new Promise(res => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { g.drawImage(im, i * 256, j * 256); res(true); };
      im.onerror = () => res(false);
      im.src = urlOf(Z, tx0 + i, ty0 + j);
    }));
  }
  const ok = (await Promise.all(jobs)).filter(Boolean).length;
  if (ok < T * T * 0.5) return null;
  const mpp = 156543.03392 * Math.cos(lat * RAD) / 2 ** Z;
  const sx = (fx - tx0) * 256, sy = (fy - ty0) * 256;
  return { cv, g, PX, mpp, size: PX * mpp, cx: (PX / 2 - sx) * mpp, cz: (PX / 2 - sy) * mpp, sx, sy };
};
const toTex = cv => { const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16; t.generateMipmaps = true; return t; };

// The ground under the scene: Esri World Imagery (sub-metre) for what you see, a sharp close-up
// layer around the ship plus a wide one, and a land/water mask from Sentinel-2 cloudless (EOX),
// whose water is a uniform dark blue that's easy to tell from land.
const loadSatellite = async (lat, lon) => {
  const [wide, close, maskSrc] = await Promise.all([
    mosaic(ESRI, 14, 7, lat, lon).then(r => r || mosaic(EOX, 14, 7, lat, lon)),
    mosaic(ESRI, 17, 9, lat, lon),
    mosaic(EOX, 14, 7, lat, lon),
  ]);
  if (!wide) return null;
  const m = maskSrc || wide;
  const src = m.g.getImageData(0, 0, m.PX, m.PX).data;
  const M = 512, mcv = document.createElement('canvas'); mcv.width = mcv.height = M;
  const mg = mcv.getContext('2d', { willReadFrequently: true }), md = mg.createImageData(M, M);
  let nearLand = 0;
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const o = (Math.floor(y / M * m.PX) * m.PX + Math.floor(x / M * m.PX)) * 4;
    const r = src[o], gg = src[o + 1], b = src[o + 2], l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    // water: dark with no red cast (open sea, North Sea green-blue), or teal/turbid (Singapore)
    const water = (l < 58 && b >= r - 4) || l < 40 || (b >= r + 15 && l < 95 && Math.abs(gg - b) < 28);
    md.data[(y * M + x) * 4] = water ? 0 : 255; md.data[(y * M + x) * 4 + 3] = 255;
    if (!water) { const dx = x - m.sx / m.PX * M, dy = y - m.sy / m.PX * M; if (dx * dx + dy * dy < (2500 / m.size * M) ** 2) nearLand++; }
  }
  mg.putImageData(md, 0, 0);
  mg.filter = 'blur(2px)'; mg.drawImage(mcv, 0, 0); mg.filter = 'none';
  const mask = new THREE.CanvasTexture(mcv); mask.minFilter = mask.magFilter = THREE.LinearFilter;
  return {
    tex: toTex(wide.cv), size: wide.size, cx: wide.cx, cz: wide.cz,
    close: close ? { tex: toTex(close.cv), size: close.size, cx: close.cx, cz: close.cz } : null,
    mask, maskRect: { size: m.size, cx: m.cx, cz: m.cz }, coastal: nearLand > 40,
    credit: close || wide !== maskSrc ? 'IMAGERY: ESRI, MAXAR, EARTHSTAR GEOGRAPHICS · COASTLINE: SENTINEL-2 CLOUDLESS BY EOX' : 'IMAGERY: SENTINEL-2 CLOUDLESS BY EOX (COPERNICUS DATA)',
  };
};

HW.makeShipScene3D = canvas => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 60000);

  /* post-processing: HDR target with MSAA, bloom, grade + grain, output */
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.55, 0.88);
  composer.addPass(bloom);
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVig: { value: 0.32 }, uGrain: { value: 0.035 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uVig, uGrain; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime) * 43758.5453); }
      void main(){ vec4 c = texture2D(tDiffuse, vUv);
        float v = smoothstep(0.95, 0.25, length(vUv - 0.5) * 1.15); c.rgb *= mix(1.0 - uVig, 1.0, v);
        c.rgb += (h(vUv * 1000.0) - 0.5) * uGrain * c.rgb; gl_FragColor = c; }`,
  });
  composer.addPass(grade);
  composer.addPass(new OutputPass());

  /* sky and light */
  const sky = new Sky(); sky.scale.setScalar(45000); scene.add(sky);
  const sun = new THREE.Vector3();
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
  sunLight.castShadow = true; sunLight.shadow.mapSize.set(4096, 4096); sunLight.shadow.bias = -0.0004; sunLight.shadow.normalBias = 0.6;
  Object.assign(sunLight.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 10, far: 4000 });
  scene.add(sunLight, sunLight.target);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x0b2230, 0.6); scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x9fb4d8, 0); moon.position.set(-600, 900, 400); scene.add(moon);
  const flood = new THREE.PointLight(0xffd9a0, 0, 700, 1.4); scene.add(flood);
  const flood2 = new THREE.PointLight(0xffe4b8, 0, 600, 1.4); scene.add(flood2);
  const flash = new THREE.AmbientLight(0xdfe8ff, 0); scene.add(flash);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  const starGeo = new THREE.BufferGeometry(), sp = [];
  for (let i = 0; i < 3000; i++) { const v = new THREE.Vector3().randomDirection(); v.y = Math.abs(v.y) + 0.02; v.normalize().multiplyScalar(40000); sp.push(v.x, v.y, v.z); }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
  scene.add(stars);

  /* ocean: a dense displaced patch that follows the camera, and a flat ring to the horizon */
  const normals = new THREE.TextureLoader().load(NORMALS, t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 16; });
  const waveU = Array.from({ length: N_WAVES }, () => new THREE.Vector4(1, 0, 0, 100));
  const maskBlank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); maskBlank.needsUpdate = true;
  const shipA = Array.from({ length: N_SHIPS }, () => new THREE.Vector4()), shipB = Array.from({ length: N_SHIPS }, () => new THREE.Vector4());
  const oceanUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uWave: { value: waveU }, uDisplace: { value: 1 },
    uNormals: { value: normals }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uDeep: { value: new THREE.Color(0.01, 0.07, 0.11) }, uShallow: { value: new THREE.Color(0.05, 0.3, 0.32) },
    uSkyTop: { value: new THREE.Color(0.2, 0.42, 0.7) }, uSkyHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
    uFoam: { value: 0.5 }, uNight: { value: 0 }, uRipple: { value: 1 },
    uMask: { value: maskBlank }, uMaskRect: { value: new THREE.Vector4(0, 0, 1, 0) },
    envMap: { value: null }, uEnvOn: { value: 0 }, uShipA: { value: shipA }, uShipB: { value: shipB },
  }]);
  Object.assign(oceanUniforms, { uWave: { value: waveU }, uNormals: { value: normals }, uMask: { value: maskBlank }, uShipA: { value: shipA }, uShipB: { value: shipB } });
  const oceanDefines = { CUBEUV_TEXEL_WIDTH: '0.001', CUBEUV_TEXEL_HEIGHT: '0.001', CUBEUV_MAX_MIP: '8.0' };
  const oceanMat = new THREE.ShaderMaterial({ uniforms: oceanUniforms, vertexShader: OCEAN_VS, fragmentShader: OCEAN_FS, fog: true, defines: { ...oceanDefines } });
  const nearGeo = new THREE.PlaneGeometry(2400, 2400, 600, 600); nearGeo.rotateX(-Math.PI / 2);   // 4 m between vertices
  const ocean = new THREE.Mesh(nearGeo, oceanMat); ocean.frustumCulled = false; scene.add(ocean);
  const farGeo = new THREE.RingGeometry(1100, 50000, 128, 1); farGeo.rotateX(-Math.PI / 2);
  const farMat = new THREE.ShaderMaterial({ uniforms: { ...oceanUniforms, uDisplace: { value: 0 } }, vertexShader: OCEAN_VS, fragmentShader: OCEAN_FS, fog: true, defines: { ...oceanDefines } });
  const farOcean = new THREE.Mesh(farGeo, farMat);
  farOcean.position.y = -0.05; farOcean.frustumCulled = false; scene.add(farOcean);
  // point the water's reflections at the sky's environment map (the same one that lights the ships)
  const useEnv = tex => {
    const hgt = tex.image.height, maxMip = Math.log2(hgt) - 2;
    const defs = { CUBEUV_TEXEL_WIDTH: String(1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16))), CUBEUV_TEXEL_HEIGHT: String(1 / hgt), CUBEUV_MAX_MIP: maxMip.toFixed(1) };
    [oceanMat, farMat].forEach(m => { Object.assign(m.defines, defs); m.needsUpdate = true; });
    oceanUniforms.envMap.value = tex; oceanUniforms.uEnvOn.value = 1;
  };

  /* satellite ground (filled in by loadSatellite) */
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }));
  ground.position.y = -30; ground.visible = false; ground.receiveShadow = true; scene.add(ground);
  const groundClose = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1 }));
  groundClose.position.y = -29.8; groundClose.visible = false; groundClose.receiveShadow = true; scene.add(groundClose);
  let sat = null;

  /* clouds */
  const cloudMap = cloudTex(), clouds = new THREE.Group(); scene.add(clouds);
  for (let i = 0; i < 180; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudMap, transparent: true, depthWrite: false, opacity: 0.85, fog: false }));
    const r = Math.sqrt(Math.random()) * 6000, a = Math.random() * 6.2832;
    s.position.set(Math.cos(a) * r, 1900 + Math.random() * 700, Math.sin(a) * r);
    const sc = 500 + Math.random() * 1000; s.scale.set(sc, sc * 0.55, 1);
    s.userData.base = s.material.opacity = 0.45 + Math.random() * 0.45;
    clouds.add(s);
  }

  /* rain or snow */
  const N_RAIN = 7000, rainPos = new Float32Array(N_RAIN * 6);
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xcfd8e2, transparent: true, opacity: 0.35, depthWrite: false }));
  rain.frustumCulled = false; scene.add(rain);
  const drops = Array.from({ length: N_RAIN }, () => [Math.random() * 700 - 350, Math.random() * 320, Math.random() * 700 - 350]);

  /* wake and spray for every moving ship */
  const N_FOAM = 6000, foamPos = new Float32Array(N_FOAM * 3), foamAge = new Float32Array(N_FOAM).fill(99), foamVel = new Float32Array(N_FOAM * 3);
  const foamGeo = new THREE.BufferGeometry(); foamGeo.setAttribute('position', new THREE.BufferAttribute(foamPos, 3));
  const foam = new THREE.Points(foamGeo, new THREE.PointsMaterial({ map: dotTex(), color: 0xffffff, size: 4, transparent: true, opacity: 0.8, depthWrite: false }));
  foam.frustumCulled = false; scene.add(foam);
  let foamI = 0;

  /* state */
  let env = envFrom(null), S = { on: false, intro: 0, mode: 'top', kind: 'tanker', alt: 3200, coastal: false, others: 0 };
  let t = 0, last = 0, raf = 0, night = 0, lat0 = 0, lon0 = 0;
  let fleet = [];            // {ship, data, x, z, heading, speed, mesh, tag}
  let focus = null;          // the fleet entry the camera follows
  const orbit = { az: 0, el: 0.85, dist: 420, tAz: 0, tEl: 0.85, tDist: 420, user: false };
  const camTarget = new THREE.Vector3();

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
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
  const lengthOf = (s, kind) => clamp(+s.length >= 40 ? +s.length : ({ tanker: 230, cargo: 300, bulk: 225, passenger: 200, general: 120 })[kind], 40, 400);
  const local = (lat, lon) => [(lon - lon0) * Math.cos(lat0 * RAD) * 111320, -(lat - lat0) * 110540];

  /* waves: Gerstner set from the live sea state */
  const setWaves = () => {
    const H = clamp(Math.max(env.wave, 0.15), 0.15, 12), T = clamp(env.period || 7, 3, 18);
    const Ls = clamp(1.56 * T * T, 70, 320), Lw = clamp(1.56 * (T * 0.62) ** 2, 45, 150);
    const dirOf = fromDeg => { const b = (fromDeg + 180) * RAD; return [Math.sin(b), -Math.cos(b)]; };   // travel direction in x,z
    const sw = dirOf(env.swellDir), wd = dirOf(env.windDir);
    const rot = (d, deg) => { const a = deg * RAD; return [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a)]; };
    const set = [
      [sw, Ls, H * 0.55], [rot(sw, 17), Ls * 0.71, H * 0.3], [rot(sw, -12), Ls * 0.53, H * 0.2],
      [wd, Lw, H * 0.42], [rot(wd, -28), Lw * 0.66, H * 0.25], [rot(wd, 41), Lw * 0.47, H * 0.16],
      [rot(wd, -57), Lw * 0.34, H * 0.1], [rot(wd, 73), Lw * 0.26, H * 0.07], [rot(wd, -9), Lw * 0.19, H * 0.05], [rot(wd, 31), Lw * 0.14, H * 0.035],
    ];
    let sum = 0;
    // the mesh has a vertex every 4 m, so a wave shorter than ~22 m would alias into blotches:
    // keep geometry waves at least that long (shorter chop comes from the ripple texture)
    const st = set.map(([d, L, h]) => { L = Math.max(22, L); const s = Math.min(0.28, Math.PI * h / L); sum += s; return [d, L, s]; });
    const scale = sum > 0.85 ? 0.85 / sum : 1;
    st.forEach(([d, L, s], i) => waveU[i].set(d[0], d[1], s * scale, L));
  };
  // the same waves on the CPU, for floating ships: surface height at a point
  const heightAt = (x, z, time) => {
    let y = 0;
    for (let i = 0; i < N_WAVES; i++) {
      const w = waveU[i], k = 6.2831853 / w.w, c = Math.sqrt(9.8 / k), l = Math.hypot(w.x, w.y) || 1;
      const f = k * ((w.x / l) * x + (w.y / l) * z - c * time);
      y += (w.z / k) * Math.sin(f);
    }
    return y * landCalm(x, z);
  };
  let maskData = null;
  const landCalm = (x, z) => {
    if (!maskData || !sat) return 1;
    const u = (x - (sat.cx - sat.size / 2)) / sat.size, v = (z - (sat.cz - sat.size / 2)) / sat.size;
    if (u < 0 || v < 0 || u > 1 || v > 1) return 1;
    const M = 512, px = Math.floor(u * M), py = Math.floor(v * M);
    const land = maskData[(py * M + px) * 4] / 255;
    return 1 - clamp((land - 0.05) / 0.45, 0, 1);
  };

  const applySky = () => {
    const { el, az } = sunAt(lat0, lon0, new Date(Date.now() + HOURS * 3600e3));
    const phi = Math.PI / 2 - el, theta = Math.PI - az;
    sun.setFromSphericalCoords(1, clamp(phi, 0.02, Math.PI - 0.02), theta);
    const u = sky.material.uniforms;
    u.turbidity.value = 2 + env.cloud * 9 + env.fog * 6;
    u.rayleigh.value = 1.1 + env.cloud * 1.6;
    u.mieCoefficient.value = 0.004 + env.fog * 0.02 + env.cloud * 0.004;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(sun);
    night = clamp((-el / RAD + 2) / 10, 0, 1);
    const dim = 1 - 0.55 * env.cloud;
    sunLight.position.copy(sun).multiplyScalar(2000);
    sunLight.intensity = lerp(3, 0.03, night) * dim;
    sunLight.color.setHSL(0.09, lerp(0.15, 0.6, clamp(1 - el / (25 * RAD), 0, 1)), lerp(0.95, 0.7, clamp(1 - el / (15 * RAD), 0, 1)));
    hemi.intensity = lerp(0.75, 0.25, night);
    moon.intensity = night * 0.9 * (1 - env.cloud * 0.5);
    renderer.toneMappingExposure = lerp(0.6, 0.32, night) * (1 - 0.2 * env.cloud);
    stars.material.opacity = night * (1 - env.cloud * 0.85) * (1 - env.fog);
    // colours the ocean reflects: a simple sky model from the sun height and the weather
    const day = 1 - night, grey = env.cloud * 0.8 + env.fog * 0.5;
    const top = new THREE.Color(0.12, 0.33, 0.66).lerp(new THREE.Color(0.42, 0.45, 0.5), grey).multiplyScalar(lerp(0.04, 1, day));
    const hor = new THREE.Color(0.72, 0.8, 0.88).lerp(new THREE.Color(0.62, 0.64, 0.67), grey).multiplyScalar(lerp(0.05, 1, day));
    if (el < 12 * RAD && el > -4 * RAD) hor.lerp(new THREE.Color(0.95, 0.6, 0.35), 0.45 * (1 - grey));   // golden hour
    oceanUniforms.uSkyTop.value.copy(top); oceanUniforms.uSkyHorizon.value.copy(hor);
    oceanUniforms.uSunDir.value.copy(sun).normalize();
    oceanUniforms.uSunColor.value.copy(sunLight.color).multiplyScalar(lerp(1, 0.1, night) * dim + 0.05);
    oceanUniforms.uNight.value = night;
    ground.material.color.setScalar(lerp(1, 0.18, night) * (1 - 0.3 * env.cloud));
    groundClose.material.color.copy(ground.material.color);
    if (envRT) envRT.dispose();
    envRT = pmrem.fromScene(sky); scene.environment = envRT.texture; useEnv(envRT.texture);
  };

  const applyWeather = () => {
    setWaves();
    const warm = clamp((env.sst - 4) / 26, 0, 1), rough = Math.max(env.storm, env.rain * 0.5);
    oceanUniforms.uDeep.value.setRGB(lerp(0.02, 0.012, warm), lerp(0.075, 0.13, warm), lerp(0.11, 0.17, warm)).multiplyScalar(1 - 0.35 * rough);
    oceanUniforms.uShallow.value.setRGB(lerp(0.05, 0.03, warm), lerp(0.22, 0.38, warm), lerp(0.26, 0.36, warm));
    oceanUniforms.uFoam.value = clamp(0.15 + env.wind / 35 + env.wave / 6, 0.1, 1);
    oceanUniforms.uRipple.value = clamp(0.5 + env.wind / 20, 0.5, 2.2);
    const fogCol = new THREE.Color(0.6, 0.66, 0.72).multiplyScalar(lerp(1, 0.06, night));
    scene.fog = new THREE.FogExp2(fogCol, 0.000025 + env.fog * 0.00045 + env.rain * 0.00018 + env.snow * 0.0003 + env.storm * 0.0002);
    rain.material.color.set(env.snow ? 0xffffff : 0xcfd8e2);
    rain.material.opacity = env.snow ? 0.75 : 0.3;
    clouds.children.forEach((c, i) => {
      c.visible = i / clouds.children.length < 0.12 + env.cloud * 0.88;
      c.material.color.setScalar(lerp(1, 0.45, Math.max(env.rain * 0.6, env.storm)) * lerp(1, 0.15, night));
    });
    applySky();
  };

  /* name tags for the fleet: HTML labels that follow each ship */
  const tagLayer = document.createElement('div');
  tagLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  canvas.parentElement.appendChild(tagLayer);
  const tagStyle = document.createElement('style');
  tagStyle.textContent = `
    .s3-tag { position:absolute; transform:translate(-50%,-100%); pointer-events:auto; cursor:pointer; white-space:nowrap; font:300 10px/1.3 ui-monospace,"SF Mono",Menlo,monospace; letter-spacing:.14em; color:#e8e8e6; padding:5px 8px 5px 18px; border-radius:999px; background:rgba(10,10,10,.42); backdrop-filter:blur(6px); border:1px solid rgba(255,255,255,.14); transition:opacity .3s, background .2s; }
    .s3-tag::before { content:''; position:absolute; left:7px; top:50%; width:6px; height:6px; margin-top:-3px; border-radius:50%; background:var(--c); }
    .s3-tag::after { content:''; position:absolute; left:50%; top:100%; width:1px; height:18px; background:rgba(255,255,255,.35); }
    .s3-tag:hover { background:rgba(76,141,255,.55); }
    .s3-tag.me { border-color:rgba(76,141,255,.9); }
    .s3-tag small { color:#9a9a98; margin-left:6px; }
    .s3-credit { position:absolute; right:24px; bottom:6px; font:300 9px ui-monospace,Menlo,monospace; letter-spacing:.1em; color:rgba(255,255,255,.45); pointer-events:none; }
  `;
  document.head.appendChild(tagStyle);
  const credit = document.createElement('div'); credit.className = 's3-credit'; tagLayer.appendChild(credit);

  const addToFleet = (s, isMe) => {
    const kind = kindOf(s), L = lengthOf(s, kind);
    const mesh = buildShip(kind, L, s.name);
    mesh.rotation.order = 'YXZ';
    const [x, z] = local(+s.lat, +s.lon);
    const heading = (s.cog != null ? +s.cog : (s.heading != null ? +s.heading : 0)) * RAD;
    const speed = s.sog != null ? +s.sog : 0;
    mesh.position.set(x, 0, z); mesh.rotation.y = Math.PI / 2 - heading;
    scene.add(mesh);
    const tag = document.createElement('div');
    tag.className = 's3-tag' + (isMe ? ' me' : '');
    tag.style.setProperty('--c', HW.groupColour(s.type_group || HW.vesselGroup(s.type)));
    tag.innerHTML = `${HW.esc(s.name || 'MMSI ' + s.mmsi)}<small>${speed < 0.8 ? 'MOORED' : speed.toFixed(1) + ' KN'}</small>`;
    tagLayer.appendChild(tag);
    const entry = { data: s, mesh, x, z, heading, speed, kind, L, tag, isMe };
    tag.addEventListener('click', () => api.focusOn(entry));
    fleet.push(entry);
    return entry;
  };
  const clearFleet = () => {
    fleet.forEach(f => { scene.remove(f.mesh); f.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); }); f.tag.remove(); });
    fleet = [];
  };

  /* drag to look around, scroll to zoom */
  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, az: orbit.tAz, el: orbit.tEl }; orbit.user = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    orbit.tAz = drag.az - (e.clientX - drag.x) * 0.006;
    orbit.tEl = clamp(drag.el + (e.clientY - drag.y) * 0.004, 0.02, 1.5);
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', e => { e.preventDefault(); orbit.tDist = clamp(orbit.tDist * Math.exp(e.deltaY * 0.0012), 40, 3200); orbit.user = true; }, { passive: false });

  const modeTargets = () => {
    const L = focus ? focus.L : 200, h = focus ? focus.heading : 0;
    const behind = Math.atan2(Math.cos(h), -Math.sin(h)), beam = Math.atan2(Math.sin(h), Math.cos(h));
    return S.mode === 'side' ? { el: 0.05, dist: L * 1.3, az: beam - 0.2 } : { el: 0.6, dist: L * 2.1, az: behind + 0.6 };
  };

  const v3 = new THREE.Vector3();
  const frame = now => {
    raf = requestAnimationFrame(frame);
    if (!S.on || !focus) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now; t += dt;
    oceanUniforms.uTime.value = t;
    grade.uniforms.uTime.value = t;

    // every ship moves along its course and rides the waves
    for (const f of fleet) {
      const v = f.speed * 0.5144;
      f.x += Math.sin(f.heading) * v * dt; f.z += -Math.cos(f.heading) * v * dt;
      const fx = Math.sin(f.heading), fz = -Math.cos(f.heading), half = f.L * 0.4, beamH = f.L * 0.07;
      const hb = heightAt(f.x + fx * half, f.z + fz * half, t), hs = heightAt(f.x - fx * half, f.z - fz * half, t);
      const hp = heightAt(f.x - fz * beamH, f.z + fx * beamH, t), hst = heightAt(f.x + fz * beamH, f.z - fx * beamH, t);
      const hc = (hb + hs + hp + hst) / 4;
      f.mesh.position.set(f.x, lerp(f.mesh.position.y, hc * 0.3, 0.2), f.z);   // the water right at the hull is calmed, so heave less
      f.mesh.rotation.z = lerp(f.mesh.rotation.z, Math.atan2(hb - hs, half * 2) * 0.8, 0.15);      // pitch (bow up)
      f.mesh.rotation.x = lerp(f.mesh.rotation.x, Math.atan2(hst - hp, beamH * 2) * 0.6, 0.12);    // roll
      f.mesh.traverse(o => { if (o.userData.spin) o.rotation.y += dt * 2.5; });
      // wake: spray at the bow, churn at the stern, spreading behind
      if (v > 0.5) {
        const n = Math.round((8 + v * 4) * dt * 6 * (f === focus ? 1.4 : 0.5));   // bow spray (the wake itself is drawn on the water)
        for (let q = 0; q < n; q++) {
          const i = foamI++ % N_FOAM, bow = true;
          const along = bow ? f.L * 0.46 : -f.L * 0.5, side = (Math.random() < 0.5 ? -1 : 1) * (bow ? 0.5 : Math.random() * 0.45) * f.L * 0.155;
          const sx = -fz, sz = fx;
          foamPos[i * 3] = f.x + fx * along + sx * side; foamPos[i * 3 + 1] = 0.5; foamPos[i * 3 + 2] = f.z + fz * along + sz * side;
          const spread = bow ? 3.5 : 1.2;
          foamVel[i * 3] = fx * v * (bow ? 0.6 : 0.15) + sx * Math.sign(side) * spread; foamVel[i * 3 + 1] = bow ? 1.5 + Math.random() * 2.5 : 0; foamVel[i * 3 + 2] = fz * v * (bow ? 0.6 : 0.15) + sz * Math.sign(side) * spread;
          foamAge[i] = 0;
        }
      }
    }
    // hand the nearest ships to the ocean shader: hull calming, waterline foam, bow wave, wake
    const nearest = fleet.map(f => [Math.hypot(f.x - camTarget.x, f.z - camTarget.z), f]).sort((a, b) => a[0] - b[0]).slice(0, N_SHIPS);
    for (let j = 0; j < N_SHIPS; j++) {
      const f = nearest[j] && nearest[j][1];
      if (!f) { shipB[j].z = 0; continue; }
      shipA[j].set(f.x, f.z, f.heading, f.L);
      shipB[j].set(f.L * (f.kind === 'passenger' ? 0.13 : 0.155), f.speed * 0.5144, 1, 0);
    }
    for (let i = 0; i < N_FOAM; i++) {
      foamAge[i] += dt;
      if (foamAge[i] > 5) { foamPos[i * 3 + 1] = -999; continue; }
      foamPos[i * 3] += foamVel[i * 3] * dt; foamPos[i * 3 + 2] += foamVel[i * 3 + 2] * dt;
      foamPos[i * 3 + 1] = Math.max(heightAt(foamPos[i * 3], foamPos[i * 3 + 2], t) * 0.8 + 0.4, foamPos[i * 3 + 1] + foamVel[i * 3 + 1] * dt);
      foamVel[i * 3 + 1] -= 9.8 * dt; foamVel[i * 3] *= 0.996; foamVel[i * 3 + 2] *= 0.996;
    }
    foamGeo.attributes.position.needsUpdate = true;
    foam.material.opacity = lerp(0.85, 0.3, night);

    // the descent, then orbit the focused ship
    S.intro = clamp(S.intro + dt / 7, 0, 1);
    const k = ease(S.intro);
    const tg = modeTargets();
    if (!orbit.user) { orbit.tAz = tg.az; orbit.tEl = tg.el; orbit.tDist = tg.dist; }
    const sm = 1 - Math.exp(-2.6 * dt);
    orbit.az = lerp(orbit.az, orbit.tAz, sm); orbit.el = lerp(orbit.el, orbit.tEl, sm); orbit.dist = lerp(orbit.dist, orbit.tDist, sm);
    camTarget.lerp(v3.set(focus.x, focus.mesh.position.y + focus.L * 0.02, focus.z), 1 - Math.exp(-3 * dt));
    const el = lerp(1.52, orbit.el, k), dist = lerp(5200, orbit.dist, k), az = lerp(orbit.az + 1.4, orbit.az, k);
    camera.position.set(camTarget.x + Math.cos(el) * Math.cos(az) * dist, Math.max(4, camTarget.y + Math.sin(el) * dist), camTarget.z + Math.cos(el) * Math.sin(az) * dist);
    const camWater = heightAt(camera.position.x, camera.position.z, t) + 2.5;
    if (camera.position.y < camWater) camera.position.y = camWater;
    camera.lookAt(camTarget.x, camTarget.y + lerp(0, focus.L * 0.04, k), camTarget.z);
    S.alt = camera.position.y;
    ocean.position.set(Math.round(camera.position.x / 4) * 4, 0, Math.round(camera.position.z / 4) * 4);
    farOcean.position.x = camera.position.x; farOcean.position.z = camera.position.z;

    // shadows follow the focused ship
    sunLight.target.position.copy(camTarget); sunLight.position.copy(sun).multiplyScalar(2000).add(camTarget);

    // rain / snow around the camera target
    const precip = Math.max(env.rain, env.snow, env.storm);
    rain.visible = precip > 0;
    if (rain.visible) {
      const fall = env.snow ? 18 : 170, wx = Math.sin(env.windDir * RAD) * env.wind * 0.4, wz = -Math.cos(env.windDir * RAD) * env.wind * 0.4, len = env.snow ? 0.6 : 7;
      const nShow = Math.floor(N_RAIN * clamp(precip, 0.2, 1));
      for (let i = 0; i < N_RAIN; i++) {
        const d = drops[i];
        d[1] -= fall * dt; d[0] += wx * dt; d[2] += wz * dt;
        if (d[1] < 0) { d[1] = 320; d[0] = Math.random() * 700 - 350; d[2] = Math.random() * 700 - 350; }
        const x = camTarget.x + d[0], y = d[1], z = camTarget.z + d[2], o = i * 6, vis = i < nShow;
        rainPos[o] = x; rainPos[o + 1] = vis ? y : -999; rainPos[o + 2] = z;
        rainPos[o + 3] = x - wx * 0.03; rainPos[o + 4] = vis ? y + len : -999; rainPos[o + 5] = z - wz * 0.03;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }
    if (env.storm) {
      if (Math.random() < dt * 0.25) flash.userData.t = 0;
      if (flash.userData.t != null) { flash.userData.t += dt; const f = flash.userData.t; flash.intensity = f < 0.08 ? 5 : f < 0.16 ? 0 : f < 0.24 ? 3.5 : 0; if (f > 0.3) flash.userData.t = null; }
    }

    // clouds drift and thin as the camera passes through
    const cdx = Math.sin(env.windDir * RAD) * env.wind * 0.5 * dt, cdz = -Math.cos(env.windDir * RAD) * env.wind * 0.5 * dt;
    clouds.children.forEach(c => { c.position.x += cdx; c.position.z += cdz; const near = Math.abs(c.position.y - camera.position.y); c.material.opacity = c.userData.base * clamp(near / 240, 0.12, 1) * (1 - env.fog * 0.5); });

    // night: ship lights and floodlights on the focused ship
    const lit = night > 0.3;
    fleet.forEach(f => f.mesh.children.forEach(m => { if (m.userData.lamp) m.visible = lit; }));
    const fx = Math.sin(focus.heading), fz = -Math.cos(focus.heading);
    flood.position.set(focus.x - fx * focus.L * 0.38, focus.mesh.position.y + focus.mesh.userData.accomTop + 12, focus.z - fz * focus.L * 0.38);
    flood2.position.set(focus.x + fx * focus.L * 0.15, focus.mesh.position.y + focus.mesh.userData.D + 22, focus.z + fz * focus.L * 0.15);
    flood.intensity = lit ? 2600 : 0; flood2.intensity = lit ? 1800 : 0;
    bloom.strength = lerp(0.28, 0.42, night);

    // name tags: project each ship to the screen; hide far ones and the ones behind us
    const w = canvas.clientWidth, h = canvas.clientHeight;
    fleet.forEach(f => {
      v3.set(f.x, f.mesh.position.y + f.mesh.userData.accomTop + f.L * 0.08, f.z).project(camera);
      const d = camera.position.distanceTo(f.mesh.position);
      const show = v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1 && k > 0.8 && d < 9000 && (f !== focus || S.mode === 'side' || d > 900);
      f.tag.style.opacity = show ? (f === focus ? 1 : clamp(1.4 - d / 7000, 0.35, 1)) : 0;
      f.tag.style.pointerEvents = show ? 'auto' : 'none';
      if (show) { f.tag.style.left = ((v3.x + 1) / 2 * w).toFixed(1) + 'px'; f.tag.style.top = ((1 - v3.y) / 2 * h - 18).toFixed(1) + 'px'; }
    });

    composer.render();
  };

  /* nearby ships: everything live within ~20 km */
  const loadFleet = async me => {
    try {
      const r = await fetch(`${HW.SERVER}/api/ships?max_age_minutes=60&limit=20000`);
      const list = (await r.json()).ships || [];
      const near = list.filter(s => s.mmsi !== me.mmsi && Math.abs(+s.lat - lat0) < 0.2 && Math.abs(+s.lon - lon0) < 0.25)
        .map(s => { const [x, z] = local(+s.lat, +s.lon); return [Math.hypot(x, z), s]; })
        .filter(([d, s]) => d < 20000 && (+s.length > 40 || /^(7|8)/.test(String(s.type))))
        .sort((a, b) => a[0] - b[0]).slice(0, 30).map(([, s]) => s);
      if (!S.on || me !== focus.data) return;
      near.forEach(s => addToFleet(s, false));
      S.others = near.length;
    } catch { /* no fleet: just our ship */ }
  };

  const api = {
    S,
    open(s, w) {
      clearFleet();
      lat0 = +s.lat; lon0 = +s.lon;
      env = envFrom(w, s);
      focus = addToFleet(s, true);
      S.kind = focus.kind; S.coastal = false; S.others = 0;
      camTarget.set(0, 0, 0);
      orbit.user = false; S.intro = 0; S.on = true; S.mode = S.mode || 'top';
      const tg = modeTargets(); Object.assign(orbit, { az: tg.az, el: tg.el, dist: tg.dist, tAz: tg.az, tEl: tg.el, tDist: tg.dist });
      foamAge.fill(99);
      // satellite ground and coastline mask
      sat = null; maskData = null; ground.visible = false; groundClose.visible = false; oceanUniforms.uMaskRect.value.set(0, 0, 1, 0);
      credit.textContent = 'IMAGERY: SENTINEL-2 CLOUDLESS BY EOX (CONTAINS COPERNICUS DATA) · SKY & SEA: THREE.JS';
      loadSatellite(lat0, lon0).then(r => {
        if (!r || !S.on || focus.data !== s) return;
        sat = { size: r.maskRect.size, cx: r.maskRect.cx, cz: r.maskRect.cz };
        ground.material.map = r.tex; ground.material.needsUpdate = true;
        // well below the deepest wave trough: it only shows where the water is cut away (land)
        ground.scale.set(r.size, 1, r.size); ground.position.set(r.cx, -30, r.cz); ground.visible = true;
        if (r.close) {
          groundClose.material.map = r.close.tex; groundClose.material.needsUpdate = true;
          groundClose.scale.set(r.close.size, 1, r.close.size); groundClose.position.set(r.close.cx, -29.8, r.close.cz); groundClose.visible = true;
        }
        oceanUniforms.uMask.value = r.mask;
        oceanUniforms.uMaskRect.value.set(r.maskRect.cx - r.maskRect.size / 2, r.maskRect.cz - r.maskRect.size / 2, r.maskRect.size, 1);
        maskData = r.mask.image.getContext('2d').getImageData(0, 0, 512, 512).data;
        S.coastal = r.coastal;
        S.landShare = (() => { let n = 0; for (let i = 0; i < maskData.length; i += 4) if (maskData[i] > 127) n++; return n / (maskData.length / 4); })();
        credit.textContent = r.credit + ' · RENDER: THREE.JS';
        applySky();
      });
      loadFleet(s);
      resize(); applyWeather();
      last = performance.now();
      if (!raf) raf = requestAnimationFrame(frame);
    },
    focusOn(entry) {
      if (!entry || entry === focus) return;
      focus.tag.classList.remove('me'); focus = entry; focus.tag.classList.add('me');
      S.kind = focus.kind; orbit.user = false;
      window.dispatchEvent(new CustomEvent('headway:shipfocus', { detail: entry.data }));
    },
    setWeather(w) { env = envFrom(w, focus ? focus.data : null); applyWeather(); },
    setMode(m) { S.mode = m; orbit.user = false; },
    close() { S.on = false; clearFleet(); },
    envFrom,
    debug: { oceanUniforms, waveU },
  };
  return api;
};
HW.webgl3d = true;
