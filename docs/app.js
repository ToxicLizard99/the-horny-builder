import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = (id) => document.getElementById(id);
function store(key, value) { try { localStorage.setItem(key, value); } catch {} }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- Icons (Lucide, drawn once and reused as text) ----------
const svgCache = new Map();
function svg(name) {
  if (svgCache.has(name)) return svgCache.get(name);
  let out = '';
  try {
    const key = name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    const node = window.lucide?.icons?.[key];
    if (node) out = window.lucide.createElement(node).outerHTML;
  } catch { /* icons are decoration; the tooltips still name every button */ }
  svgCache.set(name, out);
  return out;
}
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconDone) return;
    el.dataset.iconDone = '1';
    el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon));
  });
}

// ---------- Log (the corner stack) ----------
const logEl = $('log');
const logLines = [];
function log(text, kind = 'info') {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  logLines.unshift({ t, text, kind });
  logLines.length = Math.min(logLines.length, 40);
  logEl.innerHTML = logLines.map((l) => `<div class="${l.kind}"><b>${l.t}</b>${esc(l.text)}</div>`).join('');
}
// kept for the many places that report what happened
function setStatus(text, cls = '') { log(text, cls === 'err' ? 'err' : cls === 'ok' ? 'ok' : 'info'); }
let progressTimer = null;
function progress(text, ms = 4000) {  // short-lived notes (loading…, saved) go in the room chip, not the log
  $('world-state').textContent = text ? ' · ' + text : '';
  clearTimeout(progressTimer);
  progressTimer = null;
  if (text) progressTimer = setTimeout(() => { progressTimer = null; updateChip(); }, ms);
}

// ---------- The helper (the small program on this PC) ----------
// Opened from GitHub Pages, the page talks to the helper on this PC for rooms
// and the game's models; opened from the helper itself (the developer's copy),
// it's all on the same address and HELPER stays empty.
const PAGE_VERSION = '0.1 beta';
const REPO = 'https://github.com/ToxicLizard99/the-horny-builder';
const HOSTED = !['localhost', '127.0.0.1'].includes(location.hostname);
let HELPER = '';
async function findHelper(ports = 20) {  // the helper takes the first free port from 8710
  for (let port = 8710; port < 8710 + ports; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(800) });
      const hello = await res.json();
      if (hello.app === '3dx-editor') { HELPER = `http://127.0.0.1:${port}`; return hello; }
    } catch { /* nothing on this port */ }
  }
  return null;
}
async function waitForHelper() {
  let hello = await findHelper();
  if (hello) return hello;
  const el = document.createElement('div');
  el.id = 'helper-screen';
  el.innerHTML = `<div class="panel">
      <h2>The Horny Builder</h2>
      <p>The editor runs through its <b>helper</b> on your PC. It reads your rooms and the 3DXChat models from your own game, and nothing leaves your PC.</p>
      <ol>
        <li><a href="${REPO}/releases/latest" target="_blank" rel="noopener">Download the helper</a>, unzip it, and run <b>Setup.bat</b> once.</li>
        <li>Start <b>The Horny Builder</b> from the shortcut Setup made. The editor opens in your browser by itself; keep the helper's window open while you build.</li>
      </ol>
      <p class="hs-small">Helper already running? <a href="http://localhost:8710/">Open the editor here</a>.
        <a href="${REPO}/issues" target="_blank" rel="noopener">Problems? Tell us on GitHub.</a></p>
      <div class="hs-status"><span class="aidot busy"></span><span>Looking for the helper…</span></div>
    </div>`;
  document.body.appendChild(el);
  // while waiting, knock on the usual ports often and on all of them now and then
  for (let round = 1; !(hello = await findHelper(round % 5 ? 3 : 20)); round++) await new Promise((r) => setTimeout(r, 2000));
  el.remove();
  return hello;
}

// ---------- Settings ----------
// The editor's own defaults (Settings → "Reset this page" goes back to these).
const DEFAULTS = {
  openLast: true, listOpen: false,                                       // General
  flySpeed: 5, rotateSpeed: 1, panSpeed: 1, zoomSpeed: 1,                // Camera
  boost1: 3, boost2: 10, slow: 0.25, fov: 50, smooth: true, invert: false,
  handleSize: 1, placeFacing: 'last', selectAfterPlace: false,           // Building
  corner: 'br', tooltips: true,                                          // Screen layout
  shadows: 'high', showFps: true, grid: true, spawnMarker: true,         // Graphics
};
const settings = Object.assign(
  { ...DEFAULTS },
  (() => { try { return JSON.parse(recall('3dx-editor-settings') || '{}'); } catch { return {}; } })(),
);
function saveSettings() { store('3dx-editor-settings', JSON.stringify(settings)); }

// ---------- Scene ----------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;              // the sun and moon cast shadows, like in the game
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// the game's film-like tone curve: more contrast and richer colour, at no cost
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15161a);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
camera.position.set(10, 10, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Brightness and warmth matched to the game's "Day" weather by measuring the
// same panels in both (Claude Tests/Texture test, 2026-10-13).
const hemi = new THREE.HemisphereLight(0xfff2e2, 0x5a5048, 2.9);  // used only without the game's skies
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe0bc, 2.0);
sun.position.set(30, 60, 20);
scene.add(sun);
scene.add(sun.target);
// Shadows cover a square around where the camera looks (SHADOW_REACH metres
// each way), and follow it; further away, objects are lit but unshadowed.
const SHADOW_REACH = 40;
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -SHADOW_REACH, right: SHADOW_REACH, top: SHADOW_REACH, bottom: -SHADOW_REACH, near: 1, far: 600 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
const sunDir = new THREE.Vector3(0.3, 0.6, 0.2).normalize();  // set by the weather
// Settings → Graphics → Shadows: High (sharp, 4096 map), Low (1024), Off.
function applyShadows() {
  const mode = settings.shadows || 'high';
  const on = mode !== 'off';
  const size = mode === 'low' ? 1024 : 4096;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;  // rebuilt at the new size on the next frame
  }
  if (renderer.shadowMap.enabled !== on) {
    renderer.shadowMap.enabled = on;
    sun.castShadow = on;
    // materials have to be recompiled with or without shadow code
    scene.traverse((m) => { if (m.isMesh) [].concat(m.material).forEach((x) => { x.needsUpdate = true; }); });
  }
}
function placeSun() {  // keep the shadow area centred on what you're looking at
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(sunDir, 300);
  sun.target.updateMatrixWorld();
}
const grid = new THREE.GridHelper(200, 200, 0x3a4050, 0x23262e);
scene.add(grid);

const worldGroup = new THREE.Group();
scene.add(worldGroup);
// Selection outline: one gold box around everything selected, drawn on top so
// it shows through walls, plus a thin box per object for small selections.
const selBox = new THREE.Box3Helper(new THREE.Box3(), 0xfacc15);
selBox.material.depthTest = false;
selBox.material.transparent = true;
selBox.renderOrder = 998;
selBox.visible = false;
scene.add(selBox);
const partBoxes = new THREE.LineSegments(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.45, depthTest: false }));
partBoxes.renderOrder = 997;
partBoxes.frustumCulled = false;
scene.add(partBoxes);
const BOX_EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
function drawPartBoxes(boxes) {  // the 12 edges of each box, all in one draw
  const pts = new Float32Array(boxes.length * 24 * 3);
  let i = 0;
  for (const b of boxes) {
    const c = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => [n & 1 ? b.max.x : b.min.x, n & 2 ? b.max.y : b.min.y, n & 4 ? b.max.z : b.min.z]);
    for (const [a, z] of BOX_EDGES) { pts.set(c[a], i); pts.set(c[z], i + 3); i += 6; }
  }
  partBoxes.geometry.dispose();
  partBoxes.geometry = new THREE.BufferGeometry();
  partBoxes.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  partBoxes.visible = boxes.length > 0;
}

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- Fly with the keyboard ----------
// W A S D move where the camera looks, Q / E go down / up, Shift is faster.
// The orbit point travels along, so mouse orbiting keeps working afterwards.
const flyKeys = new Set();
const FLY = { w: [0, 0, 1], s: [0, 0, -1], a: [-1, 0, 0], d: [1, 0, 0], q: [0, -1, 0], e: [0, 1, 0] };
const clock = new THREE.Clock();
function fly(dt) {
  if (!flyKeys.size) return;
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);  // safe even looking straight down
  const move = new THREE.Vector3();
  for (const k of flyKeys) {
    const [x, y, z] = FLY[k];
    move.addScaledVector(right, x).addScaledVector(fwd, z);
    move.y += y;
  }
  if (!move.lengthSq()) return;
  // metres per second; Shift / Alt speed up, Space slows down (Settings → Camera)
  const speed = settings.flySpeed * (flyKeys.alt ? settings.boost2 : flyKeys.shift ? settings.boost1 : 1) * (flyKeys.space ? settings.slow : 1);
  move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move);
  controls.target.add(move);
}

// Performance readout (corner stack): frames per second, the slowest frame,
// draw calls and triangles in the last frame.
const perfEl = $('perf');
const gpuName = (() => {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return 'unknown'; }
})();
const softwareGpu = /swiftshader|basic render|llvmpipe|software/i.test(gpuName);
let perfFrames = 0, perfWorst = 0, perfSince = performance.now(), perfLast = performance.now();
function perfTick() {
  const now = performance.now();
  perfWorst = Math.max(perfWorst, now - perfLast);
  perfLast = now;
  perfFrames++;
  if (now - perfSince < 500) return;
  const fps = (perfFrames * 1000) / (now - perfSince);
  const r = renderer.info.render;
  perfEl.textContent = `${fps.toFixed(0)} fps · slowest ${perfWorst.toFixed(0)} ms · ${r.calls} draws · ${(r.triangles / 1e6).toFixed(2)} M triangles`
    + (softwareGpu ? ' · ⚠ software rendering' : '');
  perfFrames = 0; perfWorst = 0; perfSince = now;
}

renderer.setAnimationLoop(() => {
  fly(Math.min(clock.getDelta(), 0.1));
  controls.update();
  detailTick();
  if (skyMesh.visible) skyMesh.position.copy(camera.position);  // the sky stays around the camera
  placeSun();
  if (resizeHandles.length) sizeHandles();
  renderer.render(scene, camera);
  perfTick();
});

// ---------- 3DXChat → three.js conversion ----------
// The game is made in Unity, which is left-handed (z points away from you) and
// applies rotations Z, then X, then Y. three.js is right-handed. Flipping z
// converts positions; the same flip negates the x and y rotation angles.
const D2R = Math.PI / 180;
function placeOf(o) {
  const p = o.p || [0, 0, 0], r = o.r || [0, 0, 0], s = o.s || [1, 1, 1];
  const d = new THREE.Object3D();
  d.position.set(p[0], p[1], -p[2]);
  d.rotation.order = 'YXZ';
  d.rotation.set(-r[0] * D2R, -r[1] * D2R, r[2] * D2R);
  d.scale.set(s[0], s[1], s[2]);
  d.updateMatrix();
  return d.matrix;
}

// And back: a three.js position + rotation to the game's p and r.
const round = (v, k) => { const f = 10 ** k; const x = Math.round(v * f) / f; return Object.is(x, -0) ? 0 : x; };
const deg360 = (d) => { const x = round(((d % 360) + 360) % 360, 3); return x === 360 ? 0 : x; };
function gameP(v) { return [round(v.x, 4), round(v.y, 4), round(-v.z, 4)]; }
function gameR(q) {
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  return [deg360(-e.x / D2R), deg360(-e.y / D2R), deg360(e.z / D2R)];
}
// The game's "standing up" rotation: x = 270 turns an object's local z upward.
const UPRIGHT = 270;
const isUpright = (o) => o.r && Math.abs(deg360(o.r[0]) - UPRIGHT) < 0.01 && Math.abs(deg360(o.r[2])) < 0.01;

// ---------- Stand-in shapes ----------
// Measured against the game with Worlds/Claude Tests/Calibration.world
// (2026-10-12). In the game, a shape doesn't sit centred on its position: it
// runs from the position forward along its own z axis, 0 to 1. Cylinders, cones,
// pyramids and tubes point along that axis. In three.js space z is flipped, so
// "forward 0..1" becomes local z from 0 to -1 here. Real models replace these
// wherever the game files have one.
function forward(geo) { return geo.translate(0, 0, -0.5); }          // centred → z 0..-1
function alongZ(geo) { return geo.rotateX(-Math.PI / 2); }           // +y axis → -z (game +z)

const tubeShape = new THREE.Shape().absarc(0, 0, 0.5, 0, Math.PI * 2);
tubeShape.holes.push(new THREE.Path().absarc(0, 0, 0.35, 0, Math.PI * 2, true));
const tube = new THREE.ExtrudeGeometry(tubeShape, { depth: 1, bevelEnabled: false, curveSegments: 24 });
tube.translate(0, 0, -1);

const prismShape = new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0, 1)]);
const prism = new THREE.ExtrudeGeometry(prismShape, { depth: 1, bevelEnabled: false });
prism.rotateX(-Math.PI / 2).translate(0, -0.5, 0);                   // triangle on the floor plane, apex forward

const pyramid = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4);
const hemisphere = new THREE.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
hemisphere.rotateX(Math.PI / 2).translate(0, 0, -0.5);            // flat face at the back, dome toward the position

const egg = new THREE.SphereGeometry(0.2, 16, 12).scale(1, 1, 1.15);  // ~0.4 m, centred
const torus = new THREE.TorusGeometry(0.75, 0.25, 10, 16, Math.PI / 2).rotateX(-Math.PI / 2);

const SHAPES = {
  box: forward(new THREE.BoxGeometry(1, 1, 1)),
  sphere: forward(new THREE.SphereGeometry(0.5, 20, 14)),
  egg,
  cylinder: forward(alongZ(new THREE.CylinderGeometry(0.5, 0.5, 1, 20))),
  tube,
  cone: forward(alongZ(new THREE.ConeGeometry(0.5, 1, 20))),
  hemisphere,
  pyramid: forward(alongZ(pyramid)),
  prism,
  torus,
  prop: new THREE.BoxGeometry(0.5, 0.5, 0.5),
};
for (const g of Object.values(SHAPES)) g.computeBoundingBox();

function shapeOf(name) {
  const n = (name || '').toLowerCase();
  if (n === 'box' || n.startsWith('boxch') || n === 'cube') return 'box';
  if (n === 'sphere') return 'sphere';
  if (n.startsWith('egg')) return 'egg';
  if (n.startsWith('cylinder')) return 'cylinder';
  if (n === 'tube') return 'tube';
  if (n.startsWith('cone')) return 'cone';
  if (n === 'hemisphere') return 'hemisphere';
  if (n.startsWith('pyramid')) return 'pyramid';
  if (n.startsWith('prism')) return 'prism';
  if (n.startsWith('torus')) return 'torus';
  return 'prop';
}
// Shapes (as opposed to props) take a colour, a material and a size.
const isShapeName = (name) => shapeOf(name) !== 'prop' || dockOf(name)?.[0] === 'shapes';

function finishOf(o) {
  const m = (o.m || '').toLowerCase();
  if (m.startsWith('glass')) return 'glass';
  if (m.startsWith('illum')) return 'glow';
  if (m.startsWith('mirror')) return 'mirror';
  return 'solid';
}

function materialFor(shape, finish) {
  const side = shape === 'hemisphere' ? THREE.DoubleSide : THREE.FrontSide;
  if (shape === 'prop') return new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side });
  if (finish === 'glow') return new THREE.MeshBasicMaterial({ color: 0xffffff, side, toneMapped: false });  // glows stay full white
  if (finish === 'glass') return new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, roughness: 0.1, depthWrite: false, side });
  if (finish === 'mirror') return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0.9, side });
  return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05, side });
}

const PROP_COLOR = new THREE.Color(0x9aa0b4);
// Selected objects keep their true colour (so colours and materials can be
// judged while editing); the gold outline box shows what is selected.
const selColor = (e) => e.color;
const WHITE = new THREE.Color(0xffffff);
function colorOf(o, shape, hasModel) {
  if (o.c) return new THREE.Color(o.c[0], o.c[1], o.c[2]);
  return hasModel ? WHITE.clone() : PROP_COLOR.clone();  // a real model shows its own colours
}

// ---------- Real game models and materials ----------
// extract_models.py reads them from the game into a local cache; the server
// hands them out under /cache/. Without the cache, the shapes above are used.
let cacheIndex = { models: {}, materials: {} };
const modelKey = (n) => (n || '').toLowerCase();
const models = new Map();   // lower-case name → { prims, far, box } | 'loading' | 'none'
const gltf = new GLTFLoader();

async function loadCacheIndex() {
  try {
    const res = await fetch(HELPER + '/cache/index.json');
    if (res.ok) {
      const idx = await res.json();
      cacheIndex = { models: {}, materials: {} };
      for (const [k, v] of Object.entries(idx.models || {})) cacheIndex.models[modelKey(k)] = v;
      // world files spell materials with capitals (Leather_Italian); the game's index is lower case
      for (const [k, v] of Object.entries(idx.materials || {})) cacheIndex.materials[k.toLowerCase()] = v;
      cacheIndex.skies = idx.skies || {};
    }
  } catch { /* no cache: approximate shapes */ }
}

function modelOf(name) {
  const m = models.get(modelKey(name));
  return m && m !== 'loading' && m !== 'none' ? m : null;
}

const loadingModels = new Map();  // key → promise, so two callers share one download
// Load the models these names need; resolves when all are in (or known missing).
async function ensureModels(names) {
  const keys = [...new Set(names.map(modelKey))];
  const todo = keys.filter((k) => !models.has(k));
  const waiting = keys.filter((k) => loadingModels.has(k)).map((k) => loadingModels.get(k));
  if (!todo.length) { if (waiting.length) await Promise.all(waiting); return false; }
  let done = 0;
  await Promise.all([...waiting, ...todo.map((k) => {
    const job = (async () => {
      const info = cacheIndex.models[k];
      if (!info) { models.set(k, 'none'); return; }
      models.set(k, 'loading');
      try {
        const g = await gltf.loadAsync(HELPER + '/cache/models/' + encodeURIComponent(info.file));
        const prims = [];
        const box = new THREE.Box3();
        g.scene.traverse((m) => {
          if (!m.isMesh) return;
          m.geometry.computeBoundingBox();
          box.union(m.geometry.boundingBox);
          prims.push({ geometry: m.geometry, material: m.material });
        });
        // the game's own low-detail version, drawn when the object is far away
        let far = null;
        if (info.far && prims.length) {
          try {
            const gf = await gltf.loadAsync(HELPER + '/cache/models/' + encodeURIComponent(info.far));
            far = [];
            gf.scene.traverse((m) => { if (m.isMesh) far.push({ geometry: m.geometry, material: m.material }); });
            if (!far.length) far = null;
          } catch { far = null; }
        }
        models.set(k, prims.length ? { prims, far, box } : 'none');
      } catch {
        models.set(k, 'none');
      }
      if (++done % 20 === 0 && todo.length > 20) progress(`loading models ${done}/${todo.length}`);
    })();
    loadingModels.set(k, job);
    return job.finally(() => loadingModels.delete(k));
  })]);
  return true;
}

// World materials (the "m" field). The game draws them with its own
// "Triplanar" shader (named so in its files): the texture is laid across the
// surface in world space, so a long wall shows more bricks, not stretched ones.
// The material's tiling number is copies per metre (brick_3 0.5 = one copy
// every 2 m). TILE_METRES scales that if an in-game check says otherwise.
const TILE_METRES = 1;
const texLoader = new THREE.TextureLoader();
const worldMaterials = new Map();
function materialInfo(name) { return name ? cacheIndex.materials[name.toLowerCase()] : null; }
function materialUrl(name) { const i = materialInfo(name); return i?.file ? HELPER + '/cache/materials/' + encodeURIComponent(i.file) : null; }
// small preview for cards and swatches (falls back to the full texture)
function materialThumb(name) { const i = materialInfo(name); return i?.thumb ? HELPER + '/cache/materials/' + i.thumb.split('/').map(encodeURIComponent).join('/') : materialUrl(name); }
function worldMaterial(name) {
  if (!name) return null;
  if (worldMaterials.has(name)) return worldMaterials.get(name);
  const info = materialInfo(name);
  let mat = null;
  const kind = finishOf({ m: name });
  if (kind === 'glass') mat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, roughness: 0.05, depthWrite: false, side: THREE.DoubleSide });
  else if (kind === 'glow') mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });  // glows stay full white
  else if (kind === 'mirror') mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0.9 });
  else if (info?.file) mat = triplanar(materialUrl(name), info, info.normal ? HELPER + '/cache/materials/' + encodeURIComponent(info.normal) : null);
  worldMaterials.set(name, mat);
  return mat;
}

function triplanar(url, info, normalUrl) {
  const tex = texLoader.load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  let nrm = null;
  if (normalUrl) {
    nrm = texLoader.load(normalUrl);
    nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping;
    nrm.anisotropy = 8;
  }
  // The material's own colour is NOT applied: in the game the object's colour
  // ("c") takes its place (measured with Claude Tests/Texture test, 2026-10-13:
  // wood_10 has a dark brown colour yet shows its plain texture under white).
  const tint = WHITE;
  const floats = info.props?.floats || {};
  // the game's own gloss and metal settings, where it has them
  const gloss = Math.min(1, Math.max(0, floats._Glossiness ?? 0.2) * (floats._GlossMapScale ?? 1));
  const mat = new THREE.MeshStandardMaterial({
    color: tint, roughness: 1 - gloss * 0.7, metalness: Math.min(1, floats._Metallic ?? 0), side: THREE.DoubleSide,
  });
  const tiling = info.tiling || [1, 1];
  const bump = nrm ? Math.min(2, floats._BumpScale ?? 1) : 0;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.triMap = { value: tex };
    sh.uniforms.triScale = { value: new THREE.Vector2(tiling[0] / TILE_METRES, tiling[1] / TILE_METRES) };
    sh.uniforms.triNrm = { value: nrm };
    sh.uniforms.triBump = { value: bump };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        mat4 triM = modelMatrix;
        #ifdef USE_INSTANCING
          triM = modelMatrix * instanceMatrix;
        #endif
        vTriPos = (triM * vec4(transformed, 1.0)).xyz;
        vTriNrm = normalize(mat3(triM) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D triMap;\nuniform sampler2D triNrm;\nuniform float triBump;\nuniform vec2 triScale;\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;')
      // bumps from the normal map, laid the same three ways as the colour
      // ("whiteout" blend), then turned into the view space three.js lights in
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (triBump > 0.0) {
          vec3 N = normalize(vTriNrm);
          vec3 bw = pow(abs(N), vec3(4.0));
          bw /= (bw.x + bw.y + bw.z);
          vec3 tnx = texture2D(triNrm, vTriPos.zy * triScale).xyz * 2.0 - 1.0;
          vec3 tny = texture2D(triNrm, vTriPos.xz * triScale).xyz * 2.0 - 1.0;
          vec3 tnz = texture2D(triNrm, vTriPos.xy * triScale).xyz * 2.0 - 1.0;
          tnx.xy *= triBump; tny.xy *= triBump; tnz.xy *= triBump;
          vec3 nx = vec3(tnx.xy + N.zy, abs(tnx.z) * N.x);
          vec3 ny = vec3(tny.xy + N.xz, abs(tny.z) * N.y);
          vec3 nz = vec3(tnz.xy + N.xy, abs(tnz.z) * N.z);
          vec3 wn = normalize(nx.zyx * bw.x + ny.xzy * bw.y + nz.xyz * bw.z);
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`)
      .replace('#include <map_fragment>', `
        vec3 tw = pow(abs(normalize(vTriNrm)), vec3(4.0));
        tw /= (tw.x + tw.y + tw.z);
        vec4 tx = texture2D(triMap, vTriPos.zy * triScale);
        vec4 ty = texture2D(triMap, vTriPos.xz * triScale);
        vec4 tz = texture2D(triMap, vTriPos.xy * triScale);
        diffuseColor *= tx * tw.x + ty * tw.y + tz * tw.z;`);
  };
  mat.customProgramCacheKey = () => 'triplanar2';
  return mat;
}

// ---------- Weather and lighting ----------
// Each weather is one of the game's sky materials ("sky/day", "sky/night"…),
// read by extract_models.py: a 360° picture, how far it is turned, and a sun
// or moon. The picture is drawn around the world and also lights it (image-based
// light), so Night is dark and blue and Sunset warm. A sun or moon light comes
// from the bright spot in the picture. The two K_ numbers are tuned so Day
// matches the game (measured with Claude Tests/Texture test).
let K_ENV = 2.83;    // how strongly the sky picture lights surfaces (fitted to the game's Day)
let K_SUN = 3.07;    // sun strength under the Day sky (fitted to the game's Day)
let lightOverride = null;  // [sky, sun] strengths forced by Claude's test scripts
const DAY_SKY_LUM = 0.09;
const skyVert = `varying vec3 vDir;
  void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const skyFrag = `uniform samplerCube skyMap; uniform float rot; uniform float exposure; uniform vec3 tint; uniform float sat;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 g = vec3(d.x, d.y, -d.z);              // three.js → the game's axes
    float c = cos(rot), s = sin(rot);           // the game turns its sky by "rotation" degrees
    vec3 r = vec3(c * g.x + s * g.z, g.y, -s * g.x + c * g.z);
    vec3 col = textureCube(skyMap, r).rgb * tint * exposure;
    col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, sat);  // the light copy is less colourful
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
function makeSkyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { skyMap: { value: null }, rot: { value: 0 }, exposure: { value: 1 }, tint: { value: new THREE.Color(1, 1, 1) }, sat: { value: 1 } },
    vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false,
  });
}
const skyMaterial = makeSkyMaterial();
const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), skyMaterial);
skyMesh.renderOrder = -10;
skyMesh.frustumCulled = false;
skyMesh.visible = false;
scene.add(skyMesh);
// a small copy of the sky in its own scene, to bake the light it gives
const envScene = new THREE.Scene();
// the light copy: same sky, colour softened (ENV_SAT), the way the game's ambient light is
let ENV_SAT = 0.35;
const envSkyMaterial = makeSkyMaterial();
envSkyMaterial.uniforms.sat.value = ENV_SAT;
const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), envSkyMaterial);
envScene.add(envSky);
const pmrem = new THREE.PMREMGenerator(renderer);
let envTarget = null;
let currentSky = null;
const cubeLoader = new THREE.CubeTextureLoader();
const skyTextures = new Map();
let envIntensity = 1;

function skyFor(weather) {
  const skies = cacheIndex.skies || {};
  const key = (weather || 'day').toLowerCase();
  return skies[key]?.faces ? [key, skies[key]] : skies.day?.faces ? ['day', skies.day] : [null, null];
}
// The game's weather menu, in its own order, with its tile colours. Each world
// file stores one brightness per entry in its "ambient" list (11 numbers, same
// order). Names are the sky each option uses; #1, #2 and #6 are best guesses
// from the icons until checked in game.
const WEATHERS = [
  { id: 'Above', icon: 'mountain', bg: '#5aa9d6' },
  { id: 'Sky1', icon: 'cloud-sun', bg: '#2b95d6' },
  { id: 'Day', icon: 'sun', bg: '#1474b4' },
  { id: 'Sunrise', icon: 'sunrise', bg: '#e8870f' },
  { id: 'Sunset', icon: 'sunset', bg: '#c4672b' },
  { id: 'Sky2', icon: 'sun-dim', bg: '#ef4b4b' },
  { id: 'Pink', icon: 'moon', bg: '#c13b77' },
  { id: 'Cloudy', icon: 'cloud', bg: '#3c5884' },
  { id: 'Rain', icon: 'cloud-rain', bg: '#2d4265' },
  { id: 'Night', icon: 'moon-star', bg: '#1d283b' },
  { id: 'Space', icon: 'orbit', bg: '#000000' },
];
const weatherIndex = (w) => WEATHERS.findIndex((x) => x.id.toLowerCase() === (w || '').toLowerCase());
// Measured in game, 2026-10-13: the Kit test room photographed in all 11
// weathers, then sun position found by matching shadows and the sky/sun
// strengths fitted pixel by pixel. bearing: compass degrees the sun shines
// from (0 north, 90 east); height: degrees above the horizon.
const WEATHER_LIGHT = {  // fitted through the game's tone curve; sat: 1 = the sky's full colour, 0.35 = softened
  above: { env: 2.01, sun: 1.69, sat: 0.35, bearing: 90, height: 15 },
  sky1: { env: 2.42, sun: 1.18, sat: 0.35, bearing: 235, height: 35 },
  day: { env: 1.66, sun: 1.80, sat: 1, bearing: 228, height: 45 },
  sunrise: { env: 1.60, sun: 0.39, sat: 1, bearing: 190, height: 7 },
  sunset: { env: 1.17, sun: 1.67, sat: 0.35, bearing: 225, height: 22 },
  sky2: { env: 1.85, sun: 0.74, sat: 1, bearing: 185, height: 16 },
  pink: { env: 1.07, sun: 0.48, sat: 0.35, bearing: 200, height: 30 },
  cloudy: { env: 1.02, sun: 0.26, sat: 1, bearing: 180, height: 45 },
  rain: { env: 1.03, sun: 0.23, sat: 1, bearing: 180, height: 45 },
  night: { env: 5.68, sun: 2.95, sat: 1, bearing: 240, height: 45 },
  space: { env: 4.77, sun: 2.92, sat: 0.35, bearing: 180, height: 60 },
};
function weatherBrightness(w = world?.weather) {
  const v = world?.ambient?.[weatherIndex(w)];
  return Number.isFinite(v) ? v : 1;
}
function applyWeather(weather) {
  const [key, sky] = skyFor(weather);
  const changed = key !== currentSky;
  currentSky = key;
  if (!sky) {  // no game skies: the plain studio light from before
    skyMesh.visible = false;
    scene.environment = null;
    hemi.intensity = 2.9; sun.intensity = 2.0;
    envIntensity = 1;
    return;
  }
  let tex = skyTextures.get(key);
  if (!tex) {
    tex = cubeLoader.load(sky.faces.map((f) => HELPER + '/cache/' + f.split('/').map(encodeURIComponent).join('/')), () => bakeEnvironment());
    tex.colorSpace = THREE.SRGBColorSpace;
    skyTextures.set(key, tex);
  }
  const amb = weatherBrightness(weather);  // the room's own brightness for this weather
  const measured = WEATHER_LIGHT[key];      // the game's 11 menu weathers; other skies use the general rule
  const kEnv = lightOverride ? lightOverride[0] : measured ? measured.env : K_ENV;
  const kSun = lightOverride ? lightOverride[1] : measured ? measured.sun : K_SUN;
  skyMaterial.uniforms.skyMap.value = tex;
  skyMaterial.uniforms.rot.value = (sky.rotation || 0) * D2R;
  skyMaterial.uniforms.exposure.value = sky.exposure ?? 1;
  skyMaterial.uniforms.tint.value.setRGB(...(sky.tint || [1, 1, 1]));
  for (const k of ['skyMap', 'rot', 'exposure']) envSkyMaterial.uniforms[k].value = skyMaterial.uniforms[k].value;
  envSkyMaterial.uniforms.sat.value = WEATHER_LIGHT[key]?.sat ?? ENV_SAT;  // how much of the sky's colour the light keeps
  envSkyMaterial.uniforms.tint.value.copy(skyMaterial.uniforms.tint.value);
  skyMesh.visible = true;
  hemi.intensity = 0;  // the sky picture does this job now
  // sun or moon: from the picture's bright spot, turned with the sky
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const bright = Math.min(1.5, Math.max(0.04, lum(sky.sky_color || [0.09, 0.09, 0.09]) / DAY_SKY_LUM));
  const st = sky.sun_tint || [0, 0, 0];
  const tintMax = Math.max(...st);
  if (sky.sun_dir && tintMax > 0) {
    const [x, y, z] = sky.sun_dir, c = Math.cos(sky.rotation * D2R), s = Math.sin(sky.rotation * D2R);
    const gx = c * x - s * z, gz = s * x + c * z;           // into the world, like the sky itself
    sunDir.set(gx, Math.max(y, 0.15), -gz).normalize();
    sun.color.setRGB(st[0] / tintMax, st[1] / tintMax, st[2] / tintMax);
    sun.intensity = kSun * bright * amb;
  } else {
    sun.intensity = kSun * 0.35 * bright * amb;  // photo skies without a sun disk: soft light from above
    sun.color.set(0xffffff);
    sunDir.set(0.3, 1, 0.2).normalize();
  }
  if (measured) {  // where the game's sun really is for this weather (read from its shadows)
    const b = measured.bearing * D2R, h = measured.height * D2R;
    sunDir.set(Math.sin(b) * Math.cos(h), Math.sin(h), -Math.cos(b) * Math.cos(h));
  }
  envIntensity = kEnv * amb;
  applyEnvIntensity();
  if (changed && tex.image?.length === 6 && tex.image[0]?.complete) bakeEnvironment();
}
function bakeEnvironment() {
  if (envTarget) envTarget.dispose();
  envTarget = pmrem.fromScene(envScene, 0, 0.1, 200);
  scene.environment = envTarget.texture;
  applyEnvIntensity();
}
// three.js 0.160 sets the sky's light strength per material
function applyEnvIntensity(root = worldGroup) {
  root.traverse((m) => {
    if (!m.isMesh) return;
    for (const mat of [].concat(m.material)) if ('envMapIntensity' in mat) mat.envMapIntensity = envIntensity;
  });
}

// --- Lamps: the props' own lights. Only the nearest few are lit (each light
// costs every pixel on screen), re-chosen as the camera moves.
const POINT_POOL = 8, SPOT_POOL = 6;
// strength, reach and fall-off: set by eye against the Lamp test room in game (2026-10-13);
// lighting is deliberately not matched further (not the project's focus)
let K_LAMP = 4.0, LAMP_RANGE = 1.5, LAMP_DECAY = 1;
const pointPool = [], spotPool = [];
for (let i = 0; i < POINT_POOL; i++) { const l = new THREE.PointLight(0xffffff, 0, 8, 1); scene.add(l); pointPool.push(l); }
for (let i = 0; i < SPOT_POOL; i++) {
  const l = new THREE.SpotLight(0xffffff, 0, 8, Math.PI / 4, 0.35, 1);
  scene.add(l); scene.add(l.target); spotPool.push(l);
}
let lamps = [];  // { e, def } for every lamp in the room
function collectLamps() {
  lamps = [];
  for (const e of entries) {
    const defs = cacheIndex.models[modelKey(e.o.n)]?.lights;
    if (defs) for (const def of defs) if (def.type === 'point' || def.type === 'spot') lamps.push({ e, def });
  }
}
function assignLamps() {
  const cam = camera.position;
  const v = new THREE.Vector3();
  const near = lamps.filter((l) => !hiddenObjs.has(l.e.o) && !(layerCut !== null && l.e.y0 > layerCut))
    .map((l) => ({ l, d: v.set(l.e.cx, l.e.cy, l.e.cz).distanceToSquared(cam) }))
    .sort((a, b) => a.d - b.d);
  let pi = 0, si = 0;
  for (const { l } of near) {
    const pool = l.def.type === 'spot' ? spotPool : pointPool;
    const i = l.def.type === 'spot' ? si : pi;
    if (i >= pool.length) continue;
    const light = pool[i];
    const c = l.e.o.c || l.def.color;   // a lamp's own colour, as picked in the game
    light.color.setRGB(c[0], c[1], c[2]);
    light.intensity = l.def.intensity * K_LAMP;
    light.distance = l.def.range * LAMP_RANGE;
    light.decay = LAMP_DECAY;
    light.position.set(...l.def.pos).applyMatrix4(l.e.matrix);
    if (l.def.type === 'spot') {
      light.angle = Math.min(Math.PI / 2 - 0.01, (l.def.angle * D2R) / 2);
      const dir = new THREE.Vector3(...l.def.dir).transformDirection(l.e.matrix);
      light.target.position.copy(light.position).add(dir);
      light.target.updateMatrixWorld();
      si++;
    } else pi++;
    if (pi >= POINT_POOL && si >= SPOT_POOL) break;
  }
  for (let k = pi; k < POINT_POOL; k++) pointPool[k].intensity = 0;
  for (let k = si; k < SPOT_POOL; k++) spotPool[k].intensity = 0;
}

// ---------- The library: which dock button and tab each game object goes under ----------
const DOCK = [
  { id: 'shapes', label: 'Shapes', icon: 'box' },
  { id: 'seating', label: 'Seating', icon: 'armchair' },
  { id: 'tables', label: 'Tables & storage', icon: 'archive' },
  { id: 'lights', label: 'Lights', icon: 'lamp' },
  { id: 'effects', label: 'Effects', icon: 'sparkles' },
  { id: 'nature', label: 'Nature', icon: 'trees' },
  { id: 'food', label: 'Food & drink', icon: 'wine' },
  { id: 'decor', label: 'Decor', icon: 'gem' },
  { id: 'vehicles', label: 'Vehicles', icon: 'car' },
  { id: 'spots', label: 'Action spots', icon: 'person-standing' },
  { id: 'materials', label: 'Materials', icon: 'brick-wall', mat: true },
];
// Sorts the game's own folders (from extract_models.py) into the dock.
// Returns [dock id, tab] or null for helper objects nobody places by hand.
function classify(name, cat) {
  const n = name.toLowerCase();
  if (/_collision$|_collider$/.test(n)) return null;
  if (n.startsWith('boundingbox')) return ['effects', 'Volumes'];
  if (cat === 'primitives' || (cat === 'legacy' && n.startsWith('semiarch'))) {
    if (/^(box|chamf|dice|dia|cube)/.test(n)) return ['shapes', 'Boxes'];
    if (/^(cyl|sphere|egg|dish|tube|torus|twist|pillow|cone)/.test(n)) return ['shapes', 'Round'];
    if (/^(pyramid|prism|hex|star|heart|gh)/.test(n)) return ['shapes', 'Angled'];
    if (/^(semiarch|arc|pillar|stair)/.test(n)) return ['shapes', 'Arches & stairs'];
    if (/^(terrain|rock)/.test(n)) return ['shapes', 'Terrain'];
    return ['shapes', 'Other'];
  }
  if (cat === 'legacy') return n.startsWith('car') ? ['vehicles', 'Cars'] : ['decor', 'Doors'];
  if (cat === 'chairs') return ['seating', 'Chairs'];
  if (cat === 'sofas') return ['seating', 'Sofas'];
  if (cat === 'beds') return ['seating', 'Beds'];
  if (cat === 'sunbeds') return ['seating', 'Sunbeds'];
  if (cat === 'tables') return ['tables', 'Tables'];
  if (cat === 'racks') return ['tables', 'Storage'];
  if (cat === 'lamps' || cat === 'lights') return ['lights', 'Lamps'];
  if (cat === 'effects') return ['effects', 'Effects'];
  if (cat === 'plants' || cat === 'plants/grass') return ['nature', 'Plants'];
  if (cat === 'jungle/plants') return ['nature', 'Jungle plants'];
  if (cat === 'jungle/trees') return ['nature', 'Trees'];
  if (cat === 'terrain') return ['nature', 'Stones'];
  if (cat === 'food') return ['food', 'Food'];
  if (cat === 'drinks') return ['food', 'Drinks'];
  if (cat === 'ornaments' || cat === 'ornament') return ['decor', 'Ornaments'];
  if (cat === 'tech') return ['decor', 'Tech'];
  if (cat === 'custom') return ['decor', 'Screens'];
  if (cat === 'cars') return ['decor', 'Logos'];   // the game's "cars" folder is mostly club logos
  if (cat === 'vehicles') return ['vehicles', 'Cars'];
  if (cat.startsWith('placeholders')) {
    if (n.includes('_ph')) return ['spots', 'Action spots'];
    if (n === 'portal') return ['spots', 'Special'];
    return ['spots', 'Previews'];
  }
  if (n.includes('stool')) return ['seating', 'Stools'];
  if (n.includes('sofa')) return ['seating', 'Sofas'];
  if (/light|luster/.test(n)) return ['lights', 'Lamps'];
  if (n === 'respawn') return ['spots', 'Special'];
  if (n === 'pumpkin' || n.startsWith('shell')) return ['nature', 'Other'];
  if (n.startsWith('door')) return ['decor', 'Doors'];
  return ['decor', 'Other'];
}
// The game files every material under "wall", so the library sorts them by name.
const MATERIAL_TABS = [
  ['Glass & mirror', /glass|mirror/i], ['Glowing', /illum|neon|hologram|light/i],
  ['Brick & stone', /brick|stone|rock|cobble|marble|granite|slate|tile|concrete|asphalt|cement|terrazzo/i],
  ['Wood', /wood|bamboo|bark|plank|parquet|oak|walnut|sequoia|zebrano/i],
  ['Metal', /metal|steel|iron|copper|gold|chrome|alumin|rust/i],
  ['Fabric & leather', /fabric|leather|carpet|cloth|muslin|velvet|silk|blanket|linen|fur/i],
  ['Walls & paint', /wallpaper|plaster|paint|stucco|panel|cladding|facade/i],
  ['Nature', /grass|sand|soil|dirt|leaf|leaves|moss|water|snow|ground/i],
];
function materialTab(name) {
  for (const [tab, re] of MATERIAL_TABS) if (re.test(name)) return tab;
  return 'Other';
}
function dockOf(name) {
  const info = cacheIndex.models[modelKey(name)];
  return info ? classify(info.name || name, info.cat || 'other') : null;
}

// ---------- World state ----------
// `world` is the file's own JSON, edited in place, so saving writes back
// exactly the structure the game wrote (groups, field order, extra fields).
let world = null;
let entries = [];              // every object, groups unpacked
let byObj = new Map();         // object → its entry
let batches = [];              // instanced meshes: one set per model (or shape) + material
let respawnMarker = null;
let groupCount = 0;
const selection = new Set();   // selected objects (never group wrappers)
const hiddenObjs = new Set();  // hidden in the editor only (eye icon); not saved
const lockedObjs = new Set();  // can't be clicked in the 3D view (lock icon); not saved

function isGroup(o) { return Array.isArray(o.objects); }

// A prop without "s" keeps its prefab's own scale.
function defaultScale(name) { return cacheIndex.models[modelKey(name)]?.scale || [1, 1, 1]; }
function matrixOf(o) { return o.s ? placeOf(o) : placeOf({ ...o, s: defaultScale(o.n) }); }

function clearWorld() {
  for (const b of batches) {
    for (const m of b.meshes) { worldGroup.remove(m); m.dispose(); }
    for (const mat of b.ownMaterials) mat.dispose();
  }
  batches = [];
  if (respawnMarker) { worldGroup.remove(respawnMarker); respawnMarker = null; }
}

// An entry is drawn by one detail tier of its batch (0 = full model, 1 = the
// game's low-detail version) at slot e.drawSlot, or not at all (e.tier -1).
function setInstance(e, color) {
  if (e.tier < 0) return;
  for (const m of e.batch.tiers[e.tier]) {
    m.setMatrixAt(e.drawSlot, e.matrix);
    m.setColorAt(e.drawSlot, color);
  }
}

// Where an object is and how big, for deciding how much detail it needs.
function measure(e) {
  const b = boxOf(e);
  const c = b.getCenter(new THREE.Vector3());
  e.cx = c.x; e.cy = c.y; e.cz = c.z;
  e.y0 = b.min.y;
  e.r = b.getSize(new THREE.Vector3()).length() / 2;
}

// ---------- Level of detail ----------
// Like the game: objects that would be smaller than a couple of pixels aren't
// drawn, and far objects use the game's own low-detail model. The numbers are
// the object's radius divided by its distance, below which it's skipped / simplified.
const DETAIL = { high: [0.0004, 0.004], normal: [0.0012, 0.01], low: [0.003, 0.025] };
let detailLevel = DETAIL[recall('3dx-editor-detail')] ? recall('3dx-editor-detail') : 'normal';
let layerCut = null;           // "Hide above": objects starting above this height aren't drawn
const lastDetailAt = new THREE.Vector3(Infinity, 0, 0);
const lastDetailTurn = new THREE.Quaternion();
let lastDetailTime = 0;
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
// Objects this far outside the view still count as in view (as a share of their
// distance), so turning the camera doesn't show them popping in at the edges.
const VIEW_MARGIN = 0.2;

function assignDetail() {
  const [cull, far] = DETAIL[detailLevel];
  const cam = camera.position;
  lastDetailAt.copy(cam);
  lastDetailTurn.copy(camera.quaternion);
  lastDetailTime = performance.now();
  camera.updateMatrixWorld();
  projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
  const planes = frustum.planes;
  for (const b of batches) {
    const drawn = b.tiers.map(() => []);
    for (const e of b.list) {
      let t = 0;
      if (hiddenObjs.has(e.o) || (layerCut !== null && e.y0 > layerCut)) t = -1;
      else if (!selection.has(e.o)) {  // the selection always shows in full
        const dx = e.cx - cam.x, dy = e.cy - cam.y, dz = e.cz - cam.z;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-6);
        const a = e.r / d;
        t = a < cull ? -1 : (a < far && b.tiers.length > 1) ? 1 : 0;
        if (t >= 0) {  // behind the camera or off to the side: skip
          const slack = -(e.r + d * VIEW_MARGIN);
          for (let p = 0; p < 6; p++) {
            const pl = planes[p];
            if (pl.normal.x * e.cx + pl.normal.y * e.cy + pl.normal.z * e.cz + pl.constant < slack) { t = -1; break; }
          }
        }
      }
      e.tier = t;
      e.drawSlot = t < 0 ? -1 : drawn[t].length;
      if (t >= 0) drawn[t].push(e);
    }
    b.drawn = drawn;
    b.tiers.forEach((meshes, t) => {
      const list = drawn[t];
      for (const m of meshes) {
        for (let i = 0; i < list.length; i++) {
          m.setMatrixAt(i, list[i].matrix);
          m.setColorAt(i, selection.has(list[i].o) ? selColor(list[i]) : list[i].color);
        }
        m.count = list.length;
        m.visible = !b.hidden && list.length > 0;  // an empty mesh still costs a draw call
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor.needsUpdate = true;
        // culling is done per object above; the bounds are only needed for
        // clicking, and three.js works them out again when a click needs them
        m.frustumCulled = false;
        m.boundingSphere = null;
      }
    });
  }
  assignLamps();
}

// re-check after the camera has moved or turned a bit (at most ~8 times a second)
function detailTick() {
  if (!batches.length) return;
  const now = performance.now();
  if (now - lastDetailTime < 120) return;
  const moved = camera.position.distanceToSquared(lastDetailAt) > 0.25 * 0.25;
  const turned = camera.quaternion.angleTo(lastDetailTurn) > 0.05;
  if (moved || turned) assignDetail();
}

function build() {
  clearWorld();
  entries = [];
  byObj = new Map();
  groupCount = 0;
  world.objects.forEach((o) => {
    if (isGroup(o)) {
      const gid = groupCount++;
      o.objects.forEach((c) => entries.push({ o: c, arr: o.objects, group: o, gid }));
    } else {
      entries.push({ o, arr: world.objects, group: null, gid: null });
    }
  });

  // Batch by what's drawn: the real model (or the stand-in shape) and the
  // world material, so thousands of objects cost a handful of draw calls.
  const byKey = new Map();
  entries.forEach((e, i) => {
    e.index = i;
    e.shape = shapeOf(e.o.n);
    e.finish = finishOf(e.o);
    e.model = modelOf(e.o.n);
    byObj.set(e.o, e);
    const wm = worldMaterial(e.o.m) ? e.o.m : '';
    const key = e.model ? `model|${modelKey(e.o.n)}|${wm}`
      : `shape|${e.shape}|${e.shape === 'prop' ? 'prop' : wm || e.finish}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  });

  for (const [key, list] of byKey) {
    const [kind, what, mat] = key.split('|');
    const first = list[0];
    const ownMaterials = [];
    const tierParts = [];
    if (kind === 'model') {
      const wm = mat ? worldMaterial(mat) : null;
      tierParts.push(first.model.prims.map((p) => ({ geometry: p.geometry, material: wm || p.material })));
      if (first.model.far) tierParts.push(first.model.far.map((p) => ({ geometry: p.geometry, material: wm || p.material })));
    } else {
      let m = what !== 'prop' && worldMaterial(first.o.m);
      if (!m) { m = materialFor(what, first.finish); ownMaterials.push(m); }
      tierParts.push([{ geometry: SHAPES[what], material: m }]);
    }
    const tiers = tierParts.map((parts) => parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geometry, p.material, list.length);
      m.setColorAt(0, WHITE);  // creates the colour buffer up front
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      worldGroup.add(m);
      return m;
    }));
    const batch = { tiers, meshes: tiers.flat(), drawn: tiers.map(() => []), list,
      shape: first.shape, finish: first.finish, hasModel: kind === 'model', ownMaterials,
      isProp: !isShapeName(first.o.n) };
    list.forEach((e) => {
      e.batch = batch;
      e.tier = -1;
      e.drawSlot = -1;
      e.box = e.model ? e.model.box : SHAPES[e.shape].boundingBox;
      e.matrix = matrixOf(e.o);
      e.color = colorOf(e.o, e.shape, batch.hasModel);
      measure(e);
    });
    batches.push(batch);
  }
  collectLamps();
  applyToggles();
  assignDetail();
  applyWeather(world.weather);
  applyEnvIntensity();

  if (world.respawn) {
    const p = world.respawn.p || [0, 0, 0];
    respawnMarker = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.7, 12), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
    respawnMarker.rotation.x = Math.PI;
    respawnMarker.position.set(p[0], p[1] + 0.35, -p[2]);
    respawnMarker.visible = settings.spawnMarker;
    worldGroup.add(respawnMarker);
  }

  // forget objects that no longer exist
  for (const set of [selection, hiddenObjs, lockedObjs]) for (const o of [...set]) if (!byObj.has(o)) set.delete(o);

  updateLayerRange();
  updateWeather();
  renderTree(true);
  selectionChanged();
  // objects added or renamed since the last load may need models: fetch, then redraw
  ensureModels(entries.map((e) => e.o.n)).then((loaded) => { if (loaded && world) build(); });
}

// Move existing instances after p/r/s/c changes, without rebuilding everything.
function refresh(objs, final = true) {
  const touched = new Set();
  for (const o of objs) {
    const e = byObj.get(o);
    if (!e) continue;
    e.matrix = matrixOf(o);
    e.color = colorOf(o, e.shape, e.batch.hasModel);
    measure(e);
    setInstance(e, selection.has(o) ? selColor(e) : e.color);
    if (e.tier >= 0) e.batch.tiers[e.tier].forEach((m) => touched.add(m));
  }
  for (const m of touched) {
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
    if (final) m.boundingSphere = null; // worked out again on the next click, so clicking stays accurate
  }
  updateSelBox();
}

let showProps = true, showGlass = true;
function applyToggles() {
  for (const b of batches) {
    b.hidden = (b.isProp && !showProps) || (b.finish === 'glass' && !showGlass);
    for (const m of b.meshes) m.visible = !b.hidden && m.count > 0;
  }
}

// ---------- Undo / redo ----------
// Two kinds of change: "edit" swaps an object's fields, "splice" adds or
// removes items in an objects list. Both keep the original objects, so undo
// puts back exactly what was there.
const FIELDS = ['n', 'p', 'r', 's', 'c', 'm'];
function snap(o) { const s = {}; for (const k of FIELDS) if (k in o) s[k] = clone(o[k]); return s; }
function restore(o, s) {
  const extra = {};
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) { extra[k] = o[k]; }
  for (const k of Object.keys(o)) delete o[k];
  for (const k of FIELDS) if (k in s) o[k] = clone(s[k]);   // game's own field order
  Object.assign(o, extra);
}

const undoStack = [], redoStack = [];
let dirty = false;

function setDirty(v) {
  dirty = v;
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
  updateChip();
}

function push(cmd) {
  undoStack.push(cmd);
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  setDirty(true);
}

function runSplices(ops) {
  for (const op of ops) op.removed = op.arr.splice(op.index, op.count, ...op.insert);
}

function apply(cmd, dir) {
  if (cmd.type === 'edit') {
    let rebuild = false;
    for (const it of cmd.items) {
      const s = dir === 'undo' ? it.before : it.after;
      if (s.n !== it.o.n || s.m !== it.o.m) rebuild = true;
      restore(it.o, s);
    }
    setSelection(cmd.items.map((it) => it.o), false);
    if (rebuild) build(); else refresh(cmd.items.map((it) => it.o));
  } else if (cmd.type === 'splice') {
    if (dir === 'undo') {
      for (const op of [...cmd.ops].reverse()) op.arr.splice(op.index, op.insert.length, ...op.removed);
    } else {
      for (const op of cmd.ops) op.arr.splice(op.index, op.removed.length, ...op.insert);
    }
    setSelection(dir === 'undo' ? cmd.selBefore : cmd.selAfter, false);
    build();
  } else if (cmd.type === 'world') {
    Object.assign(world, clone(dir === 'undo' ? cmd.before : cmd.after));
    build();
  }
  selectionChanged();
}
function undo() { const c = undoStack.pop(); if (!c) return; apply(c, 'undo'); redoStack.push(c); setDirty(true); }
function redo() { const c = redoStack.pop(); if (!c) return; apply(c, 'redo'); undoStack.push(c); setDirty(true); }

// Change fields on objects, as one undo step.
function editObjects(objs, change) {
  if (!objs.length) return;
  const items = objs.map((o) => ({ o, before: snap(o) }));
  let rebuild = false;
  for (const it of items) { change(it.o); it.after = snap(it.o); if (it.after.n !== it.before.n || it.after.m !== it.before.m) rebuild = true; }
  push({ type: 'edit', items });
  if (rebuild) build(); else refresh(objs);
  selectionChanged();
}

// Splice ops, as one undo step; `after` is the selection to show afterwards.
function structure(ops, after) {
  const before = [...selection];
  runSplices(ops);
  push({ type: 'splice', ops, selBefore: before, selAfter: after });
  setSelection(after, false);
  build();
}

// Change world settings (weather, spawn), as one undo step.
function changeWorld(change) {
  const shot = () => ({ respawn: clone(world.respawn), weather: world.weather, ambient: clone(world.ambient), oceanlevel: world.oceanlevel ?? 0 });
  const before = shot();
  change();
  push({ type: 'world', before, after: shot() });
  build();
}

// ---------- Selection ----------
function leavesOf(o) { return isGroup(o) ? o.objects : [o]; }

function setSelection(objs, notify = true) {
  selection.clear();
  for (const o of objs) if (o && !isGroup(o)) selection.add(o);
  assignDetail();  // recolours, and brings the selection to full detail
  if (notify) selectionChanged();
}

function selectionChanged() {
  updateSelBox();
  attachGizmo();
  renderSelPanel();
  renderTree();
  const n = selection.size;
  for (const id of ['dup', 'del', 'group', 'copy', 'focus']) $(id).disabled = !n;
  $('ungroup').disabled = !roots().some((r) => isGroup(r.o));
}

// What the selection is made of: whole groups where every member is selected,
// otherwise single objects. Each root comes with the list it lives in.
function roots() {
  if (!world || !selection.size) return [];
  const out = [];
  world.objects.forEach((o, i) => {
    if (isGroup(o)) {
      const sel = o.objects.filter((c) => selection.has(c));
      if (sel.length && sel.length === o.objects.length) out.push({ o, arr: world.objects, index: i });
      else o.objects.forEach((c, j) => { if (selection.has(c)) out.push({ o: c, arr: o.objects, index: j }); });
    } else if (selection.has(o)) out.push({ o, arr: world.objects, index: i });
  });
  return out;
}

function boxOf(e) { return e.box.clone().applyMatrix4(e.matrix); }
function selectionBox() {
  const box = new THREE.Box3();
  for (const o of selection) { const e = byObj.get(o); if (e) box.union(boxOf(e)); }
  return box;
}
function updateSelBox() {
  if (!selection.size) { selBox.visible = false; drawPartBoxes([]); return; }
  selBox.box.copy(selectionBox());
  selBox.visible = true;
  // per-object outlines only for small selections (and only when there's more than one)
  const objs = [...selection];
  drawPartBoxes(objs.length > 1 && objs.length <= 60 ? objs.map((o) => byObj.get(o)).filter(Boolean).map(boxOf) : []);
}

// ---------- Gizmo (move / rotate / scale) ----------
const pivot = new THREE.Object3D();
scene.add(pivot);
const gizmo = new TransformControls(camera, renderer.domElement);
scene.add(gizmo);
let mode = 'translate';
let space = recall('3dx-editor-space') === 'local' ? 'local' : 'world';
let pivotMode = recall('3dx-editor-pivot') === 'center' ? 'center' : 'pivot';

// Tools that work with the mouse directly instead of the arrow handles.
const HAND_TOOLS = new Set(['resize', 'grab', 'brush']);
function attachGizmo() {
  updateResizeHandles();
  if (placing || HAND_TOOLS.has(mode)) { gizmo.detach(); return; }
  if (!selection.size || gizmo.dragging) { if (!selection.size) gizmo.detach(); return; }
  const objs = [...selection];
  pivot.scale.set(1, 1, 1);
  const s = new THREE.Vector3();
  // "Pivot": on the (first) object's own position, turned with it.
  // "Centre": in the middle of the selection's bounds.
  byObj.get(objs[0]).matrix.decompose(pivot.position, pivot.quaternion, s);
  if (pivotMode === 'center' || objs.length > 1) selectionBox().getCenter(pivot.position);
  if (objs.length > 1) pivot.quaternion.identity();
  if (pivotMode === 'pivot' && objs.length > 1) byObj.get(objs[0]).matrix.decompose(pivot.position, new THREE.Quaternion(), s);
  pivot.updateMatrixWorld();
  gizmo.attach(pivot);
  gizmo.setMode(mode === 'scale' && objs.length > 1 ? 'translate' : mode);
  gizmo.setSpace(space);
}

function setMode(m) {
  if (placing && m !== mode) stopPlacing();
  const was = mode;
  mode = m;
  if (m === 'brush' && was !== 'brush') openBrushPanel();
  else if (m !== 'brush' && cp?.floating) closeColourPicker();
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  if (m === 'scale' && selection.size > 1) log('Scale works on one object at a time. Moving instead.', 'err');
  if (m === 'resize' && selection.size > 1) log('Resize works on one object at a time: select a single object.', 'err');
  showToolHint();
  attachGizmo();
}
function setSpace(s) {
  space = s;
  store('3dx-editor-space', s);
  $('space-btn').querySelector('span').textContent = s === 'local' ? 'Local' : 'Global';
  gizmo.setSpace(s);
}
function setPivotMode(p) {
  pivotMode = p;
  store('3dx-editor-pivot', p);
  $('pivot-btn').querySelector('span').textContent = p === 'center' ? 'Centre' : 'Pivot';
  attachGizmo();
}

// Top bar: a magnet + size for moving, and a magnet + angle for rotating. Each
// magnet turns its snapping on and off; the size is kept while it's off.
const SNAP_STEPS = [[0.01, '1 cm'], [0.05, '5 cm'], [0.1, '10 cm'], [0.25, '25 cm'], [0.5, '50 cm'], [1, '1 m']];
const SNAP_ANGLES = [[5, '5°'], [15, '15°'], [45, '45°'], [90, '90°']];
// Any value can be typed in ("Custom…"), like in the game; presets stay in the menu.
const okNum = (v, max) => Number.isFinite(v) && v >= 0 && v <= max;
let stepSet = Number(recall('3dx-editor-snap') ?? 0.05);
let angleSet = Number(recall('3dx-editor-angle') ?? 15);
let moveOn = recall('3dx-editor-magnet-move') !== 'off';
let turnOn = recall('3dx-editor-magnet-turn') !== 'off';
if (!okNum(stepSet, 100) || !stepSet) stepSet = 0.05;    // 0 used to mean "off"; the magnet does that now
if (!okNum(angleSet, 360) || !angleSet) angleSet = 15;
let snapStep = 0, snapAngle = 0;  // what snapping uses right now: 0 while its magnet is off
const stepLabel = (v) => (v < 1 ? `${round(v * 100, 2)} cm` : `${round(v, 3)} m`);
const angleLabel = (v) => `${round(v, 2)}°`;
function applySnap() {
  snapStep = moveOn ? stepSet : 0;
  snapAngle = turnOn ? angleSet : 0;
  gizmo.setTranslationSnap(snapStep || null);
  gizmo.setRotationSnap(snapAngle ? snapAngle * D2R : null);
  gizmo.setScaleSnap(snapStep ? 0.05 : null);
  for (const [id, on] of [['magnet-move', moveOn], ['snap-btn', moveOn], ['magnet-turn', turnOn], ['angle-btn', turnOn]]) {
    $(id).classList.toggle('live', on);
  }
  $('magnet-move').dataset.tip = `Snap when moving: ${moveOn ? 'on' : 'off'}`;
  $('magnet-turn').dataset.tip = `Snap when rotating: ${turnOn ? 'on' : 'off'}`;
  $('snap-btn').querySelector('span').textContent = stepLabel(stepSet);
  $('angle-btn').querySelector('span').textContent = angleLabel(angleSet);
}
function setMagnet(which, on) {
  if (which === 'move') moveOn = on; else turnOn = on;
  store('3dx-editor-magnet-' + which, on ? 'on' : 'off');
  applySnap();
}
function snapMenu(presets, currentValue, label, set, ask) {
  const isPreset = presets.some(([v]) => v === currentValue);
  return [
    ...presets.map(([v, l]) => ({ label: l, checked: v === currentValue, run: () => set(v) })),
    ...(isPreset ? [] : [{ label: label(currentValue) + ' (yours)', checked: true, run: () => {} }]),
    '-',
    { label: 'Custom…', icon: 'pencil', run: ask },
  ];
}
function askNumber(title, unit, value, max) {
  return openModal(`<h3>${esc(title)}</h3>
    <div class="row one"><label>${esc(unit)}</label><input type="text" id="num-in" value="${num(value)}" inputmode="decimal"></div>
    <div class="note">The magnet next to it turns snapping on and off.</div>
    <div class="foot"><button class="act" data-x="no">Cancel</button><button class="act primary" data-x="yes">Set</button></div>`,
  (done) => {
    const inp = $('num-in');
    inp.focus(); inp.select();
    const finish = () => {
      const v = parseFloat(inp.value.replace(',', '.'));
      if (!okNum(v, max) || !v) { inp.style.borderColor = '#b45454'; return; }
      done(v);
    };
    modalEl.onclick = (ev) => { const x = ev.target.closest('[data-x]')?.dataset.x; if (x === 'yes') finish(); else if (x) done(null); };
    modalEl.onkeydown = (ev) => { if (ev.key === 'Enter') finish(); };
  });
}
function setSnapStep(v) { stepSet = round(v, 4); store('3dx-editor-snap', stepSet); applySnap(); }
function setSnapAngle(v) { angleSet = round(v, 3); store('3dx-editor-angle', angleSet); applySnap(); }

let drag = null;
gizmo.addEventListener('dragging-changed', (ev) => { controls.enabled = !ev.value; });
gizmo.addEventListener('mouseDown', () => {
  const objs = [...selection];
  drag = {
    pivotInv: pivot.matrixWorld.clone().invert(),
    items: objs.map((o) => ({ o, before: snap(o), start: byObj.get(o).matrix.clone() })),
  };
});
gizmo.addEventListener('objectChange', () => {
  if (!drag) return;
  pivot.updateMatrixWorld();
  if (gizmo.getMode() === 'scale') {
    const it = drag.items[0];
    const s0 = it.before.s || defaultScale(it.o.n);
    it.o.s = [round(s0[0] * pivot.scale.x, 4), round(s0[1] * pivot.scale.y, 4), round(s0[2] * pivot.scale.z, 4)];
  } else {
    const delta = pivot.matrixWorld.clone().multiply(drag.pivotInv);
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    for (const it of drag.items) {
      delta.clone().multiply(it.start).decompose(pos, quat, scl);
      it.o.p = gameP(pos);
      if (gizmo.getMode() === 'rotate') it.o.r = gameR(quat);
    }
  }
  refresh(drag.items.map((it) => it.o), false);
  renderSelPanel();
});
gizmo.addEventListener('mouseUp', () => {
  if (!drag) return;
  const items = drag.items.map((it) => ({ o: it.o, before: it.before, after: snap(it.o) }));
  drag = null;
  if (items.some((it) => JSON.stringify(it.before) !== JSON.stringify(it.after))) push({ type: 'edit', items });
  refresh(items.map((it) => it.o));
  attachGizmo();
  renderSelPanel();
});

// ---------- Picking ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
function aim(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(mouse, camera);
}
function entryOfHit(hit) {
  for (const b of batches) {
    const t = b.tiers.findIndex((ms) => ms.includes(hit.object));
    if (t >= 0) return b.drawn[t][hit.instanceId] || null;
  }
  return null;
}
// What's under the mouse (skipping locked objects), and where exactly.
function pickAt(ev) {
  aim(ev);
  const meshes = batches.flatMap((b) => b.meshes).filter((m) => m.visible);
  for (const hit of ray.intersectObjects(meshes, false)) {
    const e = entryOfHit(hit);
    if (e && !lockedObjs.has(e.o)) return { e, point: hit.point };
  }
  return null;
}
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  closePopup();
  downAt = gizmo.axis ? null : [e.clientX, e.clientY];  // a gizmo drag isn't a click
  // Resize and Grab start dragging straight away when pressed on their target
  if (e.button === 0 && !placing && downAt) {
    if ((mode === 'resize' && startResize(e)) || (mode === 'grab' && startGrab(e))) {
      downAt = null;
      controls.enabled = false;  // the drag moves the object, not the camera
      try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* not essential */ }
    }
  }
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (toolDrag) { finishToolDrag(); controls.enabled = true; return; }
  if (!downAt) return;
  const clicked = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) <= 4;
  downAt = null;
  if (placing) {
    if (clicked && ev.button === 0) placeHere();
    else if (clicked && ev.button === 2) stopPlacing();
    return;
  }
  if (!clicked || ev.button !== 0) return;
  if (mode === 'brush') { brushClick(ev); return; }
  const hit = pickAt(ev);
  const e = hit?.e;
  const objs = !e ? [] : (e.group && !ev.altKey) ? e.group.objects : [e.o];
  if (ev.shiftKey || ev.ctrlKey) {
    const all = objs.every((o) => selection.has(o));
    const next = new Set(selection);
    objs.forEach((o) => (all ? next.delete(o) : next.add(o)));
    setSelection([...next]);
  } else setSelection(objs);
  scrollTreeToSelection();
});
renderer.domElement.addEventListener('dblclick', () => { if (selection.size && !placing) frameBox(selectionBox()); });
renderer.domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());
// while placing or dragging, test what's under the mouse at most once per frame
let pendingMove = null;
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!placing && !toolDrag) return;
  if (!pendingMove) requestAnimationFrame(() => {
    const e = pendingMove;
    pendingMove = null;
    if (!e) return;
    if (placing) movePlacing(e);
    else if (toolDrag?.kind === 'grab') moveGrab(e);
    else if (toolDrag?.kind === 'resize') moveResize(e);
  });
  pendingMove = ev;
});

// ---------- Camera ----------
function worldBounds() {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const e of entries) box.expandByPoint(v.setFromMatrixPosition(e.matrix));
  if (respawnMarker) box.expandByPoint(respawnMarker.position);
  return box;
}
function frameBox(box, fromAbove = false) {
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const size = Math.max(box.getSize(new THREE.Vector3()).length(), 4);
  controls.target.copy(c);
  if (fromAbove) camera.position.set(c.x, c.y + size * 1.1, c.z + 0.001);
  else camera.position.set(c.x + size * 0.55, c.y + size * 0.45, c.z + size * 0.55);
  controls.update();
}
const focus = () => frameBox(selection.size ? selectionBox() : worldBounds());

// ---------- Object list (tree) ----------
// Groups fold open and closed; only the rows in view are drawn, so a group of
// 13,000 objects stays quick. Eye = hide in the editor, lock = can't be clicked
// in the 3D view. Neither is saved to the room.
const ROW = 26;
const openGroups = new Set();
let treeRows = [];
const treeEl = $('tree'), treeInner = $('tree-inner'), filterEl = $('filter');
function rowLabel(o) {
  return `${esc(o.n)} <span class="muted">${esc(o.m || '')}</span>`;
}
function renderTree(rebuildRows = false) {
  if ($('objlist').hidden || !world) return;
  if (rebuildRows || !treeRows.length) {
    const q = filterEl.value.trim().toLowerCase();
    const match = (o) => !q || (o.n || '').toLowerCase().includes(q) || (o.m || '').toLowerCase().includes(q);
    treeRows = [];
    let gid = 0;
    for (const o of world.objects) {
      if (isGroup(o)) {
        const id = gid++;
        const kids = o.objects.filter(match);
        if (q && !kids.length) continue;
        treeRows.push({ kind: 'group', o, id, count: o.objects.length });
        if (openGroups.has(o) || q) kids.forEach((c) => treeRows.push({ kind: 'obj', o: c, inGroup: true }));
      } else if (match(o)) treeRows.push({ kind: 'obj', o, inGroup: false });
    }
    treeInner.style.height = treeRows.length * ROW + 'px';
    $('tree-foot').textContent = `${entries.length.toLocaleString()} objects · ${groupCount} groups`;
  }
  const first = Math.max(0, Math.floor(treeEl.scrollTop / ROW) - 5);
  const last = Math.min(treeRows.length, first + Math.ceil(treeEl.clientHeight / ROW) + 10);
  const html = [];
  for (let k = first; k < last; k++) {
    const r = treeRows[k];
    const top = `style="top:${k * ROW}px"`;
    if (r.kind === 'group') {
      const kids = r.o.objects;
      const sel = kids.length && kids.every((c) => selection.has(c));
      const hid = kids.every((c) => hiddenObjs.has(c)), lock = kids.every((c) => lockedObjs.has(c));
      html.push(`<div class="trow${sel ? ' sel' : ''}" data-k="${k}" ${top}><span class="tw" data-act="fold">${svg(openGroups.has(r.o) ? 'chevron-down' : 'chevron-right')}</span>`
        + `<span class="nm">Group ${r.id + 1} <span class="muted">· ${r.count}</span></span>`
        + `<span class="e"><button data-act="eye" class="${hid ? 'on' : ''}" title="Hide in the editor">${svg(hid ? 'eye-off' : 'eye')}</button>`
        + `<button data-act="lock" class="${lock ? 'on' : ''}" title="Lock: can't be clicked in the 3D view">${svg(lock ? 'lock' : 'unlock')}</button></span></div>`);
    } else {
      const hid = hiddenObjs.has(r.o), lock = lockedObjs.has(r.o);
      html.push(`<div class="trow${r.inGroup ? ' in' : ''}${selection.has(r.o) ? ' sel' : ''}" data-k="${k}" ${top}><span class="nm">${rowLabel(r.o)}</span>`
        + `<span class="e"><button data-act="eye" class="${hid ? 'on' : ''}" title="Hide in the editor">${svg(hid ? 'eye-off' : 'eye')}</button>`
        + `<button data-act="lock" class="${lock ? 'on' : ''}" title="Lock: can't be clicked in the 3D view">${svg(lock ? 'lock' : 'unlock')}</button></span></div>`);
    }
  }
  treeInner.innerHTML = html.join('');
}
treeEl.addEventListener('scroll', () => renderTree());
filterEl.addEventListener('input', () => { treeEl.scrollTop = 0; renderTree(true); });
treeInner.addEventListener('click', (ev) => {
  const rowEl = ev.target.closest('.trow');
  if (!rowEl) return;
  const r = treeRows[Number(rowEl.dataset.k)];
  const act = ev.target.closest('[data-act]')?.dataset.act;
  const objs = r.kind === 'group' ? r.o.objects : [r.o];
  if (act === 'fold') { openGroups.has(r.o) ? openGroups.delete(r.o) : openGroups.add(r.o); renderTree(true); return; }
  if (act === 'eye' || act === 'lock') {
    const set = act === 'eye' ? hiddenObjs : lockedObjs;
    const all = objs.every((o) => set.has(o));
    objs.forEach((o) => (all ? set.delete(o) : set.add(o)));
    if (act === 'eye') assignDetail();
    renderTree();
    return;
  }
  if (ev.shiftKey || ev.ctrlKey) {
    const next = new Set(selection);
    const all = objs.every((o) => next.has(o));
    objs.forEach((o) => (all ? next.delete(o) : next.add(o)));
    setSelection([...next]);
  } else setSelection(objs);
});
treeInner.addEventListener('dblclick', (ev) => { if (ev.target.closest('.trow') && selection.size) frameBox(selectionBox()); });
function scrollTreeToSelection() {
  if ($('objlist').hidden || !selection.size) return;
  const first = [...selection][0];
  const e = byObj.get(first);
  if (e?.group && !openGroups.has(e.group) && selection.size === 1) { openGroups.add(e.group); renderTree(true); }
  const k = treeRows.findIndex((r) => r.o === first || (r.kind === 'group' && r.o === e?.group));
  if (k < 0) return;
  const y = k * ROW;
  if (y < treeEl.scrollTop || y > treeEl.scrollTop + treeEl.clientHeight - ROW) treeEl.scrollTop = y - treeEl.clientHeight / 2;
  renderTree();
}
function toggleList(open = $('objlist').hidden) {
  $('objlist').hidden = !open;
  $('list-btn').classList.toggle('on', open);
  settings.listOpen = open;
  saveSettings();
  if (open) renderTree(true);
}

// ---------- Selection panel ----------
const num = (v) => (v === undefined || v === null ? '' : String(round(Number(v), 4)));
function toHex(c) {
  if (!c) return '#cccccc';
  return '#' + c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}
function fromHex(hex, old) {
  const v = [1, 3, 5].map((i) => round(parseInt(hex.slice(i, i + 2), 16) / 255, 4));
  return old && old.length > 3 ? [...v, ...old.slice(3)] : v;
}
function vecRow(label, key, v) {
  return `<div class="row"><label>${label}</label>${[0, 1, 2].map((i) =>
    `<input data-k="${key}" data-i="${i}" value="${num(v?.[i])}" inputmode="decimal">`).join('')}</div>`;
}
// Facing for standing objects, in the kit's terms: 0 = front toward +z (north).
// Props' fronts point opposite their y angle (measured in game), shapes' don't.
function facingOf(o) { return deg360((o.r?.[1] || 0) - (isShapeName(o.n) ? 0 : 180)); }
function setFacing(o, f) { o.r = [o.r[0], deg360(f + (isShapeName(o.n) ? 0 : 180)), o.r[2]]; }
function matRow(value, placeholder = '') {
  const url = materialThumb(value);
  return `<div class="row one"><label>Material</label><div class="matrow"><span class="sw" style="${url ? `background-image:url('${url}')` : 'background:#333'}"></span>`
    + `<input data-k="m" list="materials" value="${esc(value || '')}" placeholder="${placeholder}"></div></div>`;
}
function colourRow(hex) {
  return `<div class="row one"><label>Colour</label><button class="cswatch wide" data-a="colour" data-hex="${hex}" title="Pick a colour">`
    + `<span style="background:${hex}"></span><code>${hex}</code></button></div>`;
}
const selEl = $('selpanel');
function renderSelPanel() {
  if (selEl.contains(document.activeElement) && drag === null && selEl.dataset.lock === '1') return;
  const objs = [...selection];
  selEl.hidden = !objs.length || !world;
  if (selEl.hidden) return;
  const actions = `<div class="actions">
      <button class="act" data-a="drop" title="Fall onto whatever is below (End)">${svg('arrow-down-to-line')} Drop to floor</button>
      <button class="act" data-a="focus" title="Frame the selection (F)">${svg('focus')} Focus</button>
      <button class="act" data-a="row" title="Copies in a line">${svg('columns-3')} Make a row…</button>
      <button class="act" data-a="align"${roots().length < 2 ? ' disabled title="Select two or more objects or groups"' : ' title="Line up or spread out"'}>${svg('align-center-horizontal')} Align…</button>
    </div>`;
  if (objs.length === 1) {
    const o = objs[0], e = byObj.get(o);
    const shape = isShapeName(o.n);
    const where = dockOf(o.n);
    const sub = [where ? where[1] : (shape ? 'Shape' : 'Object'), e?.group ? `in Group ${e.gid + 1}` : null].filter(Boolean).join(' · ');
    selEl.innerHTML = `<h3>${esc(o.n)}</h3><div class="sub">${esc(sub)}</div>`
      + `<div class="row one"><label>Type</label><input data-k="n" list="names" value="${esc(o.n)}"></div>`
      + vecRow('Position', 'p', o.p)
      + (isUpright(o)
        ? `<div class="row one"><label>Facing</label><div class="slider"><input type="range" data-k="facing" min="0" max="359" step="1" value="${Math.round(facingOf(o))}"><input data-k="facing-n" value="${num(facingOf(o))}°"></div></div>`
        : '')
      + vecRow('Rotation', 'r', o.r)
      + (shape || o.s ? vecRow('Size', 's', o.s || defaultScale(o.n)) : '')
      + (shape || o.c ? colourRow(toHex(o.c)) : '')
      + (shape || o.m ? matRow(o.m) : '')
      + actions;
  } else {
    const r = roots();
    const g = r.filter((x) => isGroup(x.o)).length;
    selEl.innerHTML = `<h3>${objs.length.toLocaleString()} objects</h3><div class="sub">${g ? `${g} group${g > 1 ? 's' : ''} · ` : ''}colour and material apply to every shape</div>`
      + colourRow(toHex(objs.find((o) => o.c)?.c))
      + matRow('', 'set for all')
      + actions;
  }
}
selEl.addEventListener('focusin', () => { selEl.dataset.lock = '1'; });
selEl.addEventListener('focusout', () => { selEl.dataset.lock = '0'; });
selEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });
selEl.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-a]')?.dataset.a;
  if (a === 'focus') focus();
  else if (a === 'drop') dropToFloor();
  else if (a === 'row') makeRow();
  else if (a === 'align') alignMenu(ev.target.closest('[data-a]'));
  else if (a === 'colour') {
    const b = ev.target.closest('[data-a]');
    openColourPicker(b, b.dataset.hex, selection.size > 1 ? 'Colour of the selected shapes' : 'Colour', (hex) => {
      const objs = [...selection];
      const targets = objs.length === 1 ? objs : objs.filter((o) => isShapeName(o.n));
      if (!targets.length) { log('Colour applies to shapes; select one or more shapes.', 'err'); return; }
      editObjects(targets, (o) => { o.c = fromHex(hex, o.c); });
      // the panel was rebuilt: keep the picker attached to the new colour button
      const nb = selEl.querySelector('[data-a="colour"]');
      if (cp && nb) cp.anchor = nb;
    });
  }
});
// Facing slider: previews while dragging, one undo step when let go.
let facingDrag = null;
selEl.addEventListener('input', (ev) => {
  if (ev.target.dataset.k !== 'facing') return;
  const o = [...selection][0];
  if (!o) return;
  if (!facingDrag) facingDrag = { o, before: snap(o) };
  setFacing(o, Number(ev.target.value));
  refresh([o], false);
  const n = selEl.querySelector('[data-k="facing-n"]');
  if (n) n.value = ev.target.value + '°';
});
selEl.addEventListener('change', (ev) => {
  const t = ev.target;
  selEl.dataset.lock = '0';
  const k = t.dataset.k;
  const objs = [...selection];
  if (!k || !objs.length) return;
  if (k === 'facing') {
    if (facingDrag) {
      push({ type: 'edit', items: [{ o: facingDrag.o, before: facingDrag.before, after: snap(facingDrag.o) }] });
      refresh([facingDrag.o]);
      facingDrag = null;
      renderSelPanel();
    }
  } else if (k === 'facing-n') {
    const v = parseFloat(t.value);
    if (!Number.isFinite(v)) { renderSelPanel(); return; }
    editObjects(objs, (o) => setFacing(o, v));
  } else if (k === 'p' || k === 'r' || k === 's') {
    const v = Number(t.value);
    if (!Number.isFinite(v)) { renderSelPanel(); return; }
    editObjects(objs, (o) => {
      const arr = o[k] ? [...o[k]] : (k === 's' ? [...defaultScale(o.n)] : [0, 0, 0]);
      arr[Number(t.dataset.i)] = k === 'r' ? deg360(v) : round(v, 4);
      o[k] = arr;
    });
  } else if (k === 'n') {
    if (!t.value.trim()) { renderSelPanel(); return; }
    editObjects(objs, (o) => { o.n = t.value.trim(); });
  } else if (k === 'm') {
    applyMaterial(t.value.trim(), objs);
  }
});
function applyMaterial(m, objs = [...selection]) {
  const targets = objs.length === 1 ? objs : objs.filter((o) => isShapeName(o.n));
  if (!targets.length) { log('Select one or more shapes first, then pick a material.', 'err'); return; }
  if (!m && objs.length > 1) return;
  editObjects(targets, (o) => { if (m) o.m = m; else delete o.m; });
  if (m) log(`Material ${m} on ${targets.length} object${targets.length > 1 ? 's' : ''}.`, 'ok');
}

// ---------- Dock + picker (the library) ----------
const dockEl = $('dock'), pickerEl = $('picker'), cardsEl = $('cards'), tabsEl = $('ptabs');
let library = null;  // dock id → { tab → [{ name, label }] }
function buildLibrary() {
  library = Object.fromEntries(DOCK.map((d) => [d.id, {}]));
  for (const info of Object.values(cacheIndex.models)) {
    const where = classify(info.name || '', info.cat || 'other');
    if (!where) continue;
    const [dock, tab] = where;
    (library[dock][tab] ||= []).push({ name: info.name, label: info.name });
  }
  for (const m of Object.values(cacheIndex.materials)) {
    (library.materials[materialTab(m.name || '')] ||= []).push({ name: m.name, label: m.name, material: true });
  }
  for (const tabs of Object.values(library)) for (const list of Object.values(tabs)) list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
function renderDock() {
  dockEl.innerHTML = DOCK.map((d, i) => (d.mat ? '<div class="sep" style="height:40px"></div>' : '')
    + `<button class="cat${d.mat ? ' mat' : ''}" data-i="${i}" data-tip="${d.label}">${svg(d.icon)}</button>`).join('');
}
let openDock = null, openTab = null, pickQuery = '';
dockEl.addEventListener('click', (ev) => {
  const b = ev.target.closest('.cat');
  if (!b) return;
  const d = DOCK[b.dataset.i];
  if (openDock === d.id) closePicker();
  else openPicker(d.id);
});
function openPicker(id) {
  openDock = id;
  const tabs = Object.keys(library[id] || {});
  openTab = tabs.includes(recall('3dx-editor-tab-' + id)) ? recall('3dx-editor-tab-' + id) : tabs[0];
  pickQuery = '';
  pickerEl.hidden = false;
  dockEl.querySelectorAll('.cat').forEach((x) => x.classList.toggle('on', DOCK[x.dataset.i].id === id));
  renderPicker();
}
function closePicker() {
  openDock = null;
  pickerEl.hidden = true;
  dockEl.querySelectorAll('.cat').forEach((x) => x.classList.remove('on'));
}
function renderPicker() {
  const tabs = library[openDock] || {};
  const d = DOCK.find((x) => x.id === openDock);
  tabsEl.innerHTML = Object.keys(tabs).map((t) => `<button class="ptab${t === openTab && !pickQuery ? ' on' : ''}" data-t="${esc(t)}">${esc(t)} <span class="muted">${tabs[t].length}</span></button>`).join('')
    + `<input class="psearch" id="psearch" placeholder="Search ${esc(d.label.toLowerCase())}…" value="${esc(pickQuery)}">`
    + `<button class="ib" id="pclose" title="Close">${svg('x')}</button>`;
  renderCards();
}
function renderCards() {
  const tabs = library[openDock] || {};
  const q = pickQuery.trim().toLowerCase();
  const items = q ? Object.values(tabs).flat().filter((it) => it.label.toLowerCase().includes(q)) : (tabs[openTab] || []);
  if (!items.length) { cardsEl.innerHTML = `<div class="empty">${q ? 'Nothing matches.' : 'Nothing here. Run extract_models.py to read the game\'s objects.'}</div>`; return; }
  cardsEl.innerHTML = items.map((it) => {
    if (it.material) {
      const url = materialThumb(it.name);
      const info = materialInfo(it.name);
      const bg = url ? `background-image:url('${url}')` : `background:${info?.color ? toHex(info.color) : '#444'}`;
      return `<button class="card mat" data-n="${esc(it.name)}" data-mat="1" data-tip="${esc(it.label)}" style="${bg}"><small>${esc(it.label)}</small></button>`;
    }
    const url = thumbs.get(modelKey(it.name));
    return `<button class="card${placing?.name === it.name ? ' on' : ''}" data-n="${esc(it.name)}" data-tip="${esc(it.label)}">`
      + (url ? `<img src="${url}" alt="">` : `<span class="ph">${svg(DOCK.find((x) => x.id === openDock).icon)}</span>`)
      + `<small>${esc(it.label)}</small></button>`;
  }).join('');
  // draw missing pictures in the background, a few at a time
  for (const it of items) if (!it.material && !thumbs.has(modelKey(it.name))) queueThumb(it.name);
}
pickerEl.addEventListener('click', (ev) => {
  const t = ev.target.closest('.ptab');
  if (t) { openTab = t.dataset.t; pickQuery = ''; store('3dx-editor-tab-' + openDock, openTab); renderPicker(); return; }
  if (ev.target.closest('#pclose')) { closePicker(); return; }
  const c = ev.target.closest('.card');
  if (!c) return;
  if (c.dataset.mat) applyMaterial(c.dataset.n);
  else startPlacing(c.dataset.n);
});
pickerEl.addEventListener('input', (ev) => {
  if (ev.target.id !== 'psearch') return;
  pickQuery = ev.target.value;
  tabsEl.querySelectorAll('.ptab').forEach((b) => b.classList.toggle('on', !pickQuery && b.dataset.t === openTab));
  renderCards();
});

// ---------- Card pictures ----------
// Each model is drawn once into a small picture by a second, hidden renderer.
const thumbs = new Map();          // model key → image URL
const thumbQueue = [];
let thumbRenderer = null, thumbScene = null, thumbCam = null, thumbBusy = false;
function queueThumb(name) {
  const k = modelKey(name);
  if (thumbs.has(k) || thumbQueue.includes(name)) return;
  thumbQueue.push(name);
  if (!thumbBusy) drainThumbs();
}
async function drainThumbs() {
  thumbBusy = true;
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    thumbRenderer.setSize(128, 128);
    thumbScene = new THREE.Scene();
    thumbScene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const l = new THREE.DirectionalLight(0xffffff, 1.4);
    l.position.set(3, 5, -4);
    thumbScene.add(l);
    thumbCam = new THREE.PerspectiveCamera(30, 1, 0.01, 2000);
  }
  while (thumbQueue.length) {
    const name = thumbQueue.shift();
    try { thumbs.set(modelKey(name), await drawThumb(name)); } catch { thumbs.set(modelKey(name), ''); }
    // swap the picture into its card if the card is still showing
    const card = cardsEl.querySelector(`.card[data-n="${CSS.escape(name)}"] .ph`);
    const url = thumbs.get(modelKey(name));
    if (card && url) card.outerHTML = `<img src="${url}" alt="">`;
    await new Promise((r) => requestAnimationFrame(r));  // keep the editor responsive
  }
  thumbBusy = false;
}
async function drawThumb(name) {
  await ensureModels([name]);
  const m = modelOf(name);
  const root = new THREE.Group();
  if (m) for (const p of m.prims) root.add(new THREE.Mesh(p.geometry, p.material));
  else return '';
  // stand it up the way the game does, front toward the camera
  const prop = !isShapeName(name);
  root.matrixAutoUpdate = false;
  root.matrix.copy(placeOf({ p: [0, 0, 0], r: [UPRIGHT, prop ? 180 : 0, 0], s: defaultScale(name) }));
  thumbScene.add(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) { thumbScene.remove(root); return ''; }
  const c = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
  const dist = radius / Math.sin((thumbCam.fov * D2R) / 2) * 1.05;
  const dir = new THREE.Vector3(0.75, 0.55, -1).normalize();
  thumbCam.position.copy(c).addScaledVector(dir, dist);
  thumbCam.near = dist / 100; thumbCam.far = dist * 10;
  thumbCam.updateProjectionMatrix();
  thumbCam.lookAt(c);
  thumbRenderer.render(thumbScene, thumbCam);
  thumbScene.remove(root);
  return thumbRenderer.domElement.toDataURL('image/png');
}

// ---------- Placing from the library ----------
// Click a card, then click in the world: the object stands on whatever is
// under the mouse (or on the floor at spawn height). R turns it; Esc or a
// right-click stops placing.
let placing = null;  // { name, facing, ghost, p }
const ghostMat = new THREE.MeshStandardMaterial({ color: 0x9ad7ff, transparent: true, opacity: 0.55, depthWrite: false });
async function startPlacing(name) {
  stopPlacing();
  if (!world) { log('Open or make a room first.', 'err'); return; }
  await ensureModels([name]);
  const m = modelOf(name);
  const ghost = new THREE.Group();
  if (m) for (const p of m.prims) ghost.add(new THREE.Mesh(p.geometry, p.material.clone()));
  else ghost.add(new THREE.Mesh(SHAPES[shapeOf(name)], ghostMat));
  ghost.traverse((x) => { if (x.isMesh && x.material !== ghostMat) { x.material.transparent = true; x.material.opacity = 0.7; } });
  ghost.matrixAutoUpdate = false;
  ghost.visible = false;
  scene.add(ghost);
  const facing = settings.placeFacing === 'north' ? 0 : Number(recall('3dx-editor-facing') || 0);
  placing = { name, facing, ghost, p: null };
  setSelection([]);
  $('place-hint').hidden = false;
  $('place-hint').innerHTML = `Placing <b>${esc(name)}</b> · click to place · <b>R</b> turn · <b>Esc</b> or right-click to stop`;
  if (!pickerEl.hidden) renderCards();
}
function stopPlacing() {
  if (!placing) return;
  scene.remove(placing.ghost);
  placing.ghost.traverse((x) => { if (x.isMesh && x.material !== ghostMat) x.material.dispose(); });
  placing = null;
  $('place-hint').hidden = true;
  if (!pickerEl.hidden) renderCards();
  attachGizmo();
}
function floorHeight() { return world?.respawn?.p ? world.respawn.p[1] : 1.0; }
function newObject(name, p) {
  const r = [UPRIGHT, deg360(placing.facing + (isShapeName(name) ? 0 : 180)), 0];
  return isShapeName(name)
    ? { n: name, p, r, s: [1, 1, 1], c: [0.8, 0.8, 0.8], m: 'paint_1' }
    : { n: name, p, r };
}
function movePlacing(ev) {
  const hit = pickAt(ev);
  let point = hit?.point;
  if (!point) {  // nothing under the mouse: the floor plane at spawn height
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorHeight());
    point = ray.ray.intersectPlane(plane, new THREE.Vector3());
  }
  if (!point) { placing.ghost.visible = false; placing.p = null; return; }
  const step = snapStep || 0.01;
  const p = [round(Math.round(point.x / step) * step, 4), round(point.y, 4), round(Math.round(-point.z / step) * step, 4)];
  placing.p = p;
  placing.ghost.matrix.copy(matrixOf(newObject(placing.name, p)));
  placing.ghost.visible = true;
}
function placeHere() {
  if (!placing?.p) return;
  const o = newObject(placing.name, placing.p);
  log(`Placed ${placing.name}.`, 'ok');
  if (settings.selectAfterPlace) {  // Settings → Building: stop and select what was placed
    stopPlacing();
    structure([{ arr: world.objects, index: world.objects.length, count: 0, insert: [o] }], [o]);
  } else structure([{ arr: world.objects, index: world.objects.length, count: 0, insert: [o] }], []);
}
function turnPlacing() {
  placing.facing = deg360(placing.facing + (snapAngle || 15));
  store('3dx-editor-facing', placing.facing);
  if (placing.p) placing.ghost.matrix.copy(matrixOf(newObject(placing.name, placing.p)));
}

// ---------- Building tools: Grab, Resize, Drop to floor, Make a row, Align, Colour brush ----------
// "Units" are what the tools move as one piece: whole groups, or single objects.
function unitsOf() { return roots().map((r) => leavesOf(r.o)); }
function unitBox(objs) {
  const box = new THREE.Box3();
  for (const o of objs) { const e = byObj.get(o); if (e) box.union(boxOf(e)); }
  return box;
}
// three.js box → the game's axes (x east, y up, z north)
function gameBox(b) { return { min: [b.min.x, b.min.y, -b.max.z], max: [b.max.x, b.max.y, -b.min.z] }; }
// Shift objects by per-object offsets in game metres, as one undo step.
function shiftObjects(offsets) {
  const objs = [...offsets.keys()];
  if (!objs.length) return false;
  editObjects(objs, (o) => {
    const d = offsets.get(o), p = o.p || [0, 0, 0];
    o.p = [round(p[0] + d[0], 4), round(p[1] + d[1], 4), round(p[2] + d[2], 4)];
  });
  return true;
}
const visibleMeshes = () => batches.flatMap((b) => b.meshes).filter((m) => m.visible);

// ---------- Colour picker (brush + selection panel) ----------
// Swatches on the left (recent, my colours, colours in this room, the game's
// palette), a mixer on the right (shade square, hue strip, hex, R G B).
// Clicking a swatch, letting go of the square or strip, or typing a value
// picks the colour: one undo step each. Saved lists live in the editor's own
// folder (palette.json via the server); the game's palette is only read.
let palette = { mine: [], recent: [], game: [], game_imported: null };
async function loadPalette() {
  try { palette = await (await fetch(HELPER + '/api/palette')).json(); } catch { /* the picker still mixes colours */ }
}
async function savePalette() {
  try {
    await fetch(HELPER + '/api/palette', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mine: palette.mine, recent: palette.recent }) });
  } catch { log('Could not save your colours (is the editor server running?).', 'err'); }
}
function rememberColour(hex) {  // recently used, newest first
  palette.recent = [hex, ...palette.recent.filter((c) => c !== hex)].slice(0, 8);
  savePalette();
}
const hexOk = (s) => /^#?[0-9a-f]{6}$/i.test(String(s).trim());
const normHex = (s) => '#' + String(s).trim().replace(/^#/, '').toLowerCase();
function hexToRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function rgbToHex(rgb) { return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join(''); }
function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
function hsvToRgb([h, s, v]) {
  const f = (n) => { const k = (n + h / 60) % 6; return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255; };
  return [f(5), f(3), f(1)];
}
function roomColours() {  // colours used in the open room, most used first
  const n = new Map();
  for (const e of entries) if (e.o.c) { const h = toHex(e.o.c); n.set(h, (n.get(h) || 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h).slice(0, 48);
}

const cpEl = document.createElement('div');
cpEl.id = 'cpick';
cpEl.className = 'panel';
cpEl.hidden = true;
document.body.appendChild(cpEl);
// Two ways to show it: under a swatch button (closes when you click elsewhere),
// or floating for the brush (opens with the brush, stays while you paint, can
// be dragged by its title and closed with ×; its spot is remembered).
let cp = null;  // { anchor, hex, start, hsv, onPick, title, floating, tips }
function closeColourPicker() {
  const wasBrush = cp?.floating;
  cpEl.hidden = true; cp = null;
  if (wasBrush) showToolHint();  // the hint bar takes over (with a swatch to reopen it)
}
document.addEventListener('pointerdown', (ev) => {
  if (cp && !cp.floating && !cpEl.contains(ev.target) && !cp.anchor.contains(ev.target)) closeColourPicker();
});
async function openColourPicker(anchor, startHex, title, onPick, { floating = false, tips = '' } = {}) {
  if (cp && anchor && cp.anchor === anchor) { closeColourPicker(); return; }
  closePopup();
  const hex = hexOk(startHex) ? normHex(startHex) : '#cccccc';
  cp = { anchor, hex, start: hex, hsv: rgbToHsv(hexToRgb(hex)), onPick, title, floating, tips };
  await loadPalette();
  if (!cp) return;  // closed while the palette loaded
  renderColourPicker();
  cpEl.hidden = false;
  const w = cpEl.offsetWidth, h = cpEl.offsetHeight;
  let left, top;
  if (floating) {
    const saved = JSON.parse(recall('3dx-editor-brush-panel') || 'null');
    [left, top] = saved || [innerWidth - w - 16, 62];
  } else {
    const r = anchor.getBoundingClientRect();
    left = r.left;
    top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = r.top - h - 6;
  }
  placeColourPicker(left, top);
}
function placeColourPicker(left, top) {  // kept fully on screen
  cpEl.style.left = Math.max(8, Math.min(left, innerWidth - cpEl.offsetWidth - 8)) + 'px';
  cpEl.style.top = Math.max(8, Math.min(top, innerHeight - cpEl.offsetHeight - 8)) + 'px';
}
// the floating brush panel: drag it by its title row
let cpMove = null;
cpEl.addEventListener('pointerdown', (ev) => {
  if (!cp?.floating || !ev.target.closest('.cp-grip')) return;
  cpMove = { dx: ev.clientX - cpEl.offsetLeft, dy: ev.clientY - cpEl.offsetTop };
  cpEl.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
cpEl.addEventListener('pointermove', (ev) => { if (cpMove) placeColourPicker(ev.clientX - cpMove.dx, ev.clientY - cpMove.dy); });
cpEl.addEventListener('pointerup', () => {
  if (!cpMove) return;
  cpMove = null;
  store('3dx-editor-brush-panel', JSON.stringify([cpEl.offsetLeft, cpEl.offsetTop]));
});
function swatches(list, kind) {
  return list.map((c) => `<button class="sw-c" data-c="${c}" data-kind="${kind}" style="background:${c}" title="${c}${kind === 'mine' ? ' · right-click to remove' : ''}"></button>`).join('');
}
function renderColourPicker() {
  const room = world ? roomColours() : [];
  const groups = [
    ['Recent', palette.recent, 'recent', ''],
    ['My colours', palette.mine, 'mine', palette.mine.length ? '' : 'Mix a colour, then ＋ Save colour.'],
    ['In this room', room, 'room', ''],
    ['Game palette', palette.game, 'game', palette.game.length ? '' : 'Import your palette from 3DXChat with the button below.'],
  ];
  cpEl.classList.toggle('floating', cp.floating);
  cpEl.innerHTML = `<div class="cp-head"><b class="${cp.floating ? 'cp-grip' : ''}"${cp.floating ? ' title="Drag to move"' : ''}>${cp.floating ? svg('grip-vertical') : ''}${esc(cp.title)}</b>
      <span class="cp-old" style="background:${cp.start}" title="Before (click to go back)" data-x="old"></span><span class="cp-new" style="background:${cp.hex}"></span>
      <input class="cp-hex" value="${cp.hex}" spellcheck="false" maxlength="7">
      ${cp.floating ? `<button class="ib cp-close" data-x="close" title="Close (the brush stays on)">${svg('x')}</button>` : ''}</div>
    ${cp.tips ? `<div class="cp-tips">${cp.tips}</div>` : ''}
    <div class="cp-body">
      <div class="cp-lists">${groups.filter(([, list, , empty]) => list.length || empty).map(([label, list, kind, empty]) =>
        `<div class="cp-label">${label}</div>${list.length ? `<div class="cp-grid">${swatches(list, kind)}</div>` : `<div class="cp-empty">${empty}</div>`}`).join('')}</div>
      <div class="cp-mix">
        <div class="cp-sv"><span class="cp-dot"></span></div>
        <div class="cp-hue"><span class="cp-bar"></span></div>
        <div class="cp-rgb">${['R', 'G', 'B'].map((l, i) => `<label>${l}<input data-rgb="${i}" inputmode="numeric"></label>`).join('')}</div>
      </div>
    </div>
    <div class="cp-foot"><button class="act" data-x="save">${svg('plus')} Save colour</button>
      <button class="act" data-x="import" title="${palette.game_imported ? 'Imported ' + new Date(palette.game_imported * 1000).toLocaleString() + '. Click to read it again.' : 'Read the palette from your 3DXChat settings'}">${svg('download')} Import from game</button></div>`;
  paintMixer();
}
function paintMixer() {  // update the mixer to cp.hsv / cp.hex without rebuilding the lists
  const [h, s, v] = cp.hsv;
  const sv = cpEl.querySelector('.cp-sv');
  sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))`;
  cpEl.querySelector('.cp-dot').style.cssText = `left:${s * 100}%;top:${(1 - v) * 100}%;background:${cp.hex}`;
  cpEl.querySelector('.cp-bar').style.top = `${(h / 360) * 100}%`;
  cpEl.querySelector('.cp-new').style.background = cp.hex;
  const hexIn = cpEl.querySelector('.cp-hex');
  if (document.activeElement !== hexIn) hexIn.value = cp.hex;
  hexToRgb(cp.hex).forEach((n, i) => { const el = cpEl.querySelector(`[data-rgb="${i}"]`); if (document.activeElement !== el) el.value = n; });
  cpEl.querySelectorAll('.sw-c').forEach((b) => b.classList.toggle('on', b.dataset.c === cp.hex));
}
function setPickerColour(hex, pick) {
  cp.hex = normHex(hex);
  cp.hsv = rgbToHsv(hexToRgb(cp.hex));
  paintMixer();
  if (pick) pickColour();
}
function pickColour() {
  if (!cp) return;
  cp.onPick(cp.hex);
  rememberColour(cp.hex);
}
// dragging in the shade square or hue strip: preview while dragging, pick on letting go
let cpDrag = null;
cpEl.addEventListener('pointerdown', (ev) => {
  const area = ev.target.closest('.cp-sv, .cp-hue');
  if (!area) return;
  cpDrag = area;
  area.setPointerCapture(ev.pointerId);
  dragMixer(ev);
});
cpEl.addEventListener('pointermove', (ev) => { if (cpDrag) dragMixer(ev); });
cpEl.addEventListener('pointerup', () => { if (cpDrag) { cpDrag = null; pickColour(); } });
function dragMixer(ev) {
  const r = cpDrag.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
  if (cpDrag.classList.contains('cp-sv')) cp.hsv = [cp.hsv[0], x, 1 - y];
  else cp.hsv = [Math.min(359.9, y * 360), cp.hsv[1], cp.hsv[2]];
  cp.hex = rgbToHex(hsvToRgb(cp.hsv));
  paintMixer();
}
cpEl.addEventListener('click', async (ev) => {
  const sw = ev.target.closest('.sw-c');
  if (sw) { setPickerColour(sw.dataset.c, true); return; }
  const x = ev.target.closest('[data-x]')?.dataset.x;
  if (x === 'close') closeColourPicker();
  else if (x === 'old') setPickerColour(cp.start, true);
  else if (x === 'save') {
    if (palette.mine.includes(cp.hex)) { log(`${cp.hex} is already in My colours.`, 'info'); return; }
    palette.mine = [...palette.mine, cp.hex];
    await savePalette();
    renderColourPicker();
  } else if (x === 'import') {
    const res = await fetch(HELPER + '/api/palette/import-game', { method: 'POST', body: '{}' });
    const body = await res.json();
    if (!res.ok) { log(body.error || 'Could not import the game palette.', 'err'); return; }
    palette = body;
    renderColourPicker();
    log(`Imported ${palette.game.length} colours from the game's palette.`, 'ok');
  }
});
cpEl.addEventListener('contextmenu', (ev) => {
  const sw = ev.target.closest('.sw-c[data-kind="mine"]');
  if (!sw) return;
  ev.preventDefault();
  palette.mine = palette.mine.filter((c) => c !== sw.dataset.c);
  savePalette();
  renderColourPicker();
});
cpEl.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.classList.contains('cp-hex')) {
    if (hexOk(t.value)) setPickerColour(t.value, true);
    else t.value = cp.hex;
  } else if (t.dataset.rgb !== undefined) {
    const rgb = hexToRgb(cp.hex);
    const v = Number(t.value);
    if (Number.isFinite(v)) { rgb[Number(t.dataset.rgb)] = Math.min(255, Math.max(0, Math.round(v))); setPickerColour(rgbToHex(rgb), true); }
    else t.value = rgb[Number(t.dataset.rgb)];
  }
});
cpEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') ev.target.blur();
  if (ev.key === 'Escape') closeColourPicker();
  if (ev.target.matches('input')) ev.stopPropagation();  // typing here mustn't trigger the editor's shortcuts
});

// Hint strip under the top bar for the tool in use.
let brushColor = recall('3dx-editor-brush') || '#d64f4f';
function showToolHint() {
  const el = $('place-hint');
  if (placing) return;  // placing shows its own hint
  if (mode === 'brush' && cp?.floating) { el.hidden = true; return; }  // the brush panel shows it all
  if (mode === 'grab') el.innerHTML = '<b>Grab</b> · drag an object onto another and it sticks to the side you touch · Shift keeps it upright on walls';
  else if (mode === 'resize') el.innerHTML = '<b>Resize</b> · drag a gold handle to move that side; the opposite side stays put';
  else if (mode === 'brush') el.innerHTML = `<b>Colour brush</b> <button class="cswatch" id="brush-col" style="background:${brushColor}" title="Pick the brush colour"></button><code>${brushColor}</code> · click to paint · Shift+click paints the whole group · Alt+click picks up a colour · Esc stops`;
  else { el.hidden = true; return; }
  el.hidden = false;
  const c = $('brush-col');
  if (c) c.onclick = () => openBrushPanel();
}
function openBrushPanel() {
  openColourPicker(null, brushColor, 'Colour brush', setBrushColour, { floating: true,
    tips: '<b>Click</b> paints · <b>Shift</b>+click the whole group · <b>Alt</b>+click picks up a colour · <b>Esc</b> stops' });
  showToolHint();
}
function setBrushColour(hex) {
  brushColor = hex;
  store('3dx-editor-brush', brushColor);
  const c = $('brush-col');
  if (c) { c.style.background = hex; c.nextElementSibling.textContent = hex; }
  if (cp?.floating && cp.hex !== hex) setPickerColour(hex, false);  // Alt+click picked one up
}

// --- Colour brush ---
function brushClick(ev) {
  const hit = pickAt(ev);
  if (!hit) return;
  const e = hit.e;
  if (ev.altKey) {  // pick up the object's colour
    if (e.o.c) { setBrushColour(toHex(e.o.c)); log(`Brush colour ${brushColor} from ${e.o.n}.`, 'info'); }
    return;
  }
  const targets = ev.shiftKey && e.group ? e.group.objects : [e.o];
  editObjects(targets, (o) => { o.c = fromHex(brushColor, o.c); });
  if (palette.recent[0] !== brushColor) rememberColour(brushColor);
}

// --- Grab: drag onto another object; it sticks to the side you touch ---
let toolDrag = null;
const UP = new THREE.Vector3(0, 1, 0);
function startGrab(ev) {
  const hit = pickAt(ev);
  if (!hit) return false;
  const e = hit.e;
  // grabbing something outside the selection selects it (a whole group, like a click)
  if (!selection.has(e.o)) setSelection(e.group && !ev.altKey ? e.group.objects : [e.o]);
  const objs = [...selection];
  const box = unitBox(objs);
  toolDrag = {
    kind: 'grab', objs,
    skip: new Set(objs),
    items: objs.map((o) => ({ o, before: snap(o), start: byObj.get(o).matrix.clone() })),
    anchor: new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2),
    floorY: box.min.y,
  };
  return true;
}
function moveGrab(ev) {
  const d = toolDrag;
  aim(ev);
  let point = null, normal = UP.clone();
  for (const hit of ray.intersectObjects(visibleMeshes(), false)) {
    const e = entryOfHit(hit);
    if (!e || d.skip.has(e.o) || lockedObjs.has(e.o)) continue;
    point = hit.point.clone();
    if (hit.face) {  // the face's direction in the world, through the instance's own turn
      const m = new THREE.Matrix4();
      hit.object.getMatrixAt(hit.instanceId, m);
      m.premultiply(hit.object.matrixWorld);
      normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(m)).normalize();
      if (normal.dot(ray.ray.direction) > 0) normal.negate();  // the side facing the camera
    }
    break;
  }
  if (!point) {  // over nothing: slide along the height it started at
    point = ray.ray.intersectPlane(new THREE.Plane(UP, -d.floorY), new THREE.Vector3());
    if (!point) return;
  }
  // stand on floors as they are; on walls and ceilings, turn to stand out from
  // the surface (Shift keeps the object upright instead)
  const flat = normal.angleTo(UP) < 2 * D2R || ev.shiftKey;
  const turn = flat ? new THREE.Quaternion() : new THREE.Quaternion().setFromUnitVectors(UP, normal);
  if (ev.shiftKey && normal.angleTo(UP) >= 2 * D2R) {
    // upright against a wall: push out so the object's side touches it
    const size = unitBox(d.objs).getSize(new THREE.Vector3());
    const out = new THREE.Vector3(normal.x, 0, normal.z).normalize();
    point.addScaledVector(out, Math.abs(out.x) * size.x / 2 + Math.abs(out.z) * size.z / 2);
    point.y -= size.y / 2;  // its middle follows the mouse up and down the wall
  }
  // snap along the surface, not into it
  if (snapStep) {
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
    const into = ay >= ax && ay >= az ? 'y' : ax >= az ? 'x' : 'z';
    for (const k of ['x', 'y', 'z']) if (k !== into) point[k] = Math.round(point[k] / snapStep) * snapStep;
  }
  const move = new THREE.Matrix4().makeTranslation(point.x, point.y, point.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(turn))
    .multiply(new THREE.Matrix4().makeTranslation(-d.anchor.x, -d.anchor.y, -d.anchor.z));
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  for (const it of d.items) {
    move.clone().multiply(it.start).decompose(pos, quat, scl);
    it.o.p = gameP(pos);
    it.o.r = flat ? clone(it.before.r) : gameR(quat);  // standing on a floor keeps the exact angles
    if (!it.o.r) delete it.o.r;
  }
  refresh(d.objs, false);
  renderSelPanel();
}

// --- Resize: drag one side, the opposite side stays put ---
// Six gold handles sit on the faces of the selected object's box.
const handleGeo = new THREE.BoxGeometry(1, 1, 1);
const handleMat = new THREE.MeshBasicMaterial({ color: 0xe2b65a, depthTest: false, transparent: true, opacity: 0.95 });
let resizeHandles = [];
function updateResizeHandles() {
  for (const h of resizeHandles) scene.remove(h);
  resizeHandles = [];
  if (mode !== 'resize' || selection.size !== 1 || placing) return;
  const e = byObj.get([...selection][0]);
  if (!e) return;
  const b = e.box, c = b.getCenter(new THREE.Vector3());
  for (let k = 0; k < 3; k++) {
    for (const side of ['min', 'max']) {
      const local = c.clone();
      local.setComponent(k, b[side].getComponent(k));
      const h = new THREE.Mesh(handleGeo, handleMat);
      h.position.copy(local.applyMatrix4(e.matrix));
      h.renderOrder = 999;
      h.userData = { k, side };
      scene.add(h);
      resizeHandles.push(h);
    }
  }
}
function sizeHandles() {  // same size on screen, like the arrows
  for (const h of resizeHandles) h.scale.setScalar(camera.position.distanceTo(h.position) * 0.014 * settings.handleSize);
}
// where along a line (p + t·dir) the mouse ray passes closest
function alongLine(p, dir) {
  const w0 = p.clone().sub(ray.ray.origin), r = ray.ray.direction;
  const b = dir.dot(r), d = dir.dot(w0), e = r.dot(w0);
  const denom = 1 - b * b;
  return Math.abs(denom) < 1e-6 ? 0 : (b * e - d) / denom;
}
function startResize(ev) {
  if (selection.size !== 1 || !resizeHandles.length) return false;
  aim(ev);
  const hit = ray.intersectObjects(resizeHandles, false)[0];
  if (!hit) return false;
  const o = [...selection][0], e = byObj.get(o);
  const { k, side } = hit.object.userData;
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  e.matrix.decompose(pos, quat, scl);
  const axis = new THREE.Vector3().setComponent(k, 1).applyQuaternion(quat).normalize();  // the local axis in the world
  const out = axis.clone().multiplyScalar(side === 'max' ? 1 : -1);
  toolDrag = {
    kind: 'resize', o, e, k, side, axis, out, pos, quat,
    s0: [...(o.s || defaultScale(o.n))], before: snap(o),
    start: hit.object.position.clone(),
  };
  toolDrag.t0 = alongLine(toolDrag.start, out);
  return true;
}
function moveResize(ev) {
  const d = toolDrag;
  aim(ev);
  let delta = alongLine(d.start, d.out) - d.t0;
  if (snapStep) delta = Math.round(delta / snapStep) * snapStep;
  const b = d.e.box, k = d.k;
  const extent = b.max.getComponent(k) - b.min.getComponent(k);
  const L0 = extent * Math.abs(d.s0[k]);
  const L1 = Math.max(0.01, L0 + delta);
  const s = [...d.s0];
  s[k] = d.s0[k] * (L1 / L0);
  // the opposite face stays where it was: shift the position to make up for the new size
  const fixed = d.side === 'max' ? b.min.getComponent(k) : b.max.getComponent(k);
  const pos = d.pos.clone().addScaledVector(d.axis, fixed * (d.s0[k] - s[k]));
  d.o.s = s.map((v) => round(v, 4));
  d.o.p = gameP(pos);
  refresh([d.o], false);
  updateResizeHandles();
  renderSelPanel();
}

function finishToolDrag() {
  const d = toolDrag;
  toolDrag = null;
  const items = d.kind === 'grab'
    ? d.items.map((it) => ({ o: it.o, before: it.before, after: snap(it.o) }))
    : [{ o: d.o, before: d.before, after: snap(d.o) }];
  if (items.some((it) => JSON.stringify(it.before) !== JSON.stringify(it.after))) push({ type: 'edit', items });
  refresh(items.map((it) => it.o));
  updateResizeHandles();
  selectionChanged();
}

// --- Drop to floor: fall straight down onto whatever is below ---
function dropToFloor() {
  const units = unitsOf();
  if (!units.length) return;
  const skip = new Set(selection);
  const meshes = visibleMeshes();
  const offsets = new Map();
  let landed = 0;
  for (const objs of units) {
    const box = unitBox(objs);
    const bottom = box.min.y;
    // test the middle and four points near the corners of the footprint
    const ix = (box.max.x - box.min.x) * 0.4, iz = (box.max.z - box.min.z) * 0.4;
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    let best = -Infinity;
    for (const [x, z] of [[cx, cz], [cx - ix, cz - iz], [cx + ix, cz - iz], [cx - ix, cz + iz], [cx + ix, cz + iz]]) {
      ray.set(new THREE.Vector3(x, bottom + 0.005, z), new THREE.Vector3(0, -1, 0));
      ray.far = 2000;
      for (const hit of ray.intersectObjects(meshes, false)) {
        const e = entryOfHit(hit);
        if (!e || skip.has(e.o)) continue;
        best = Math.max(best, hit.point.y);
        break;
      }
    }
    ray.far = Infinity;
    if (best === -Infinity) continue;  // nothing below: leave it where it is
    const dy = best - bottom;
    if (Math.abs(dy) < 1e-4) { landed++; continue; }
    for (const o of objs) offsets.set(o, [0, dy, 0]);
    landed++;
  }
  shiftObjects(offsets);
  const missed = units.length - landed;
  log(missed ? `Dropped ${landed}; ${missed} had nothing below them.` : `Dropped ${landed} to the surface below.`, missed ? 'err' : 'ok');
}

// --- Make a row: copies in a line ---
async function makeRow() {
  const rs = roots();
  if (!rs.length) return;
  const box = gameBox(unitBox([...selection]));
  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const DIRS = [['east', 'East (+x)', [1, 0, 0]], ['west', 'West (−x)', [-1, 0, 0]], ['north', 'North (+z)', [0, 0, 1]],
    ['south', 'South (−z)', [0, 0, -1]], ['up', 'Up (stacked)', [0, 1, 0]]];
  const last = recall('3dx-editor-row-dir') || 'east';
  const sizeFor = (id) => { const v = DIRS.find((d) => d[0] === id)[2]; return Math.abs(v[0]) * size[0] + Math.abs(v[1]) * size[1] + Math.abs(v[2]) * size[2]; };
  const res = await openModal(`<h3>Make a row</h3>
    <div class="row one"><label>Copies</label><input type="text" id="row-n" value="${recall('3dx-editor-row-n') || 4}"></div>
    <div class="row one"><label>Direction</label><select id="row-dir">${DIRS.map(([id, l]) => `<option value="${id}"${id === last ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="row one"><label>Spacing</label><input type="text" id="row-gap" value="${num(round(sizeFor(last), 3))}"></div>
    <div class="note">Spacing is metres from one copy to the next. It starts at the selection's own size, so the copies touch; make it bigger to leave gaps.</div>
    <div class="foot"><button class="act" data-x="no">Cancel</button><button class="act primary" data-x="yes">Make row</button></div>`,
  (done) => {
    $('row-dir').onchange = () => { $('row-gap').value = num(round(sizeFor($('row-dir').value), 3)); };
    const finish = () => {
      const n = Math.round(Number($('row-n').value)), gap = parseFloat($('row-gap').value.replace(',', '.'));
      if (!(n >= 1 && n <= 500)) { $('row-n').style.borderColor = '#b45454'; return; }
      if (!Number.isFinite(gap)) { $('row-gap').style.borderColor = '#b45454'; return; }
      done({ n, gap, dir: $('row-dir').value });
    };
    modalEl.onclick = (ev) => { const x = ev.target.closest('[data-x]')?.dataset.x; if (x === 'yes') finish(); else if (x) done(null); };
    modalEl.onkeydown = (ev) => { if (ev.key === 'Enter') finish(); };
  });
  if (!res) return;
  store('3dx-editor-row-n', res.n);
  store('3dx-editor-row-dir', res.dir);
  const v = DIRS.find((d) => d[0] === res.dir)[2];
  const made = [];
  const ops = sortRemovals(rs.map((r) => {
    const copies = [];
    for (let i = 1; i <= res.n; i++) {
      const c = clone(r.o);
      for (const o of leavesOf(c)) {
        const p = o.p || [0, 0, 0];
        o.p = [round(p[0] + v[0] * res.gap * i, 4), round(p[1] + v[1] * res.gap * i, 4), round(p[2] + v[2] * res.gap * i, 4)];
      }
      copies.push(c);
    }
    made.push(...copies);
    return { arr: r.arr, index: r.index + 1, count: 0, insert: copies };
  }));
  structure(ops, [...selection, ...made.flatMap(leavesOf)]);
  log(`Made a row of ${res.n} cop${res.n > 1 ? 'ies' : 'y'}, ${res.gap} m apart. Ctrl+Z undoes it.`, 'ok');
}

// --- Align and spread ---
function alignUnits(axis, how) {
  const units = unitsOf();
  if (units.length < 2) { log('Select two or more objects (or groups) to line up.', 'err'); return; }
  const boxes = units.map((objs) => gameBox(unitBox(objs)));
  const all = boxes.reduce((a, b) => ({ min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])) }));
  const mid = (b) => (b.min[axis] + b.max[axis]) / 2;
  const target = [];
  if (how === 'spread') {
    const order = boxes.map((b, i) => i).sort((a, b) => mid(boxes[a]) - mid(boxes[b]));
    const first = mid(boxes[order[0]]), lastMid = mid(boxes[order[order.length - 1]]);
    order.forEach((i, n) => { target[i] = first + ((lastMid - first) * n) / (order.length - 1) - mid(boxes[i]); });
  } else {
    boxes.forEach((b, i) => {
      target[i] = how === 'min' ? all.min[axis] - b.min[axis]
        : how === 'max' ? all.max[axis] - b.max[axis]
        : (all.min[axis] + all.max[axis]) / 2 - mid(b);
    });
  }
  const offsets = new Map();
  units.forEach((objs, i) => {
    if (Math.abs(target[i]) < 1e-5) return;
    const d = [0, 0, 0];
    d[axis] = target[i];
    for (const o of objs) offsets.set(o, d);
  });
  if (shiftObjects(offsets)) log('Lined up.', 'ok');
}
function alignMenu(anchor) {
  openPopup(anchor, [
    { label: 'West sides (−x)', icon: 'align-start-vertical', run: () => alignUnits(0, 'min') },
    { label: 'Centres east–west', icon: 'align-center-vertical', run: () => alignUnits(0, 'mid') },
    { label: 'East sides (+x)', icon: 'align-end-vertical', run: () => alignUnits(0, 'max') },
    '-',
    { label: 'South sides (−z)', icon: 'align-start-horizontal', run: () => alignUnits(2, 'min') },
    { label: 'Centres north–south', icon: 'align-center-horizontal', run: () => alignUnits(2, 'mid') },
    { label: 'North sides (+z)', icon: 'align-end-horizontal', run: () => alignUnits(2, 'max') },
    '-',
    { label: 'Bottoms', icon: 'arrow-down-to-line', run: () => alignUnits(1, 'min') },
    { label: 'Tops', icon: 'arrow-up-to-line', run: () => alignUnits(1, 'max') },
    '-',
    { label: 'Spread evenly east–west', icon: 'columns-3', run: () => alignUnits(0, 'spread') },
    { label: 'Spread evenly north–south', icon: 'rows-3', run: () => alignUnits(2, 'spread') },
  ]);
}

// ---------- Top view toggle ----------
let topSaved = null;  // the camera to go back to
function setTopView(on) {
  if (on && !topSaved) {
    topSaved = { pos: camera.position.clone(), target: controls.target.clone() };
    frameBox(selection.size ? selectionBox() : worldBounds(), true);
  } else if (!on && topSaved) {
    camera.position.copy(topSaved.pos);
    controls.target.copy(topSaved.target);
    controls.update();
    topSaved = null;
  }
  $('vtop').classList.toggle('on', !!topSaved);
}

// ---------- Commands: delete, duplicate, copy/paste, group, clear ----------
// Splices for removing items, ordered so earlier removals don't shift later ones.
function removalOps(rs) {
  return rs.map((r) => ({ arr: r.arr, index: r.index, count: 1, insert: [] }));
}
function sortRemovals(ops) {
  // group by list, highest index first within each list
  const lists = new Map();
  for (const op of ops) { if (!lists.has(op.arr)) lists.set(op.arr, []); lists.get(op.arr).push(op); }
  return [...lists.values()].flatMap((l) => l.sort((a, b) => b.index - a.index));
}

function del() {
  const rs = roots();
  if (!rs.length) return;
  structure(sortRemovals(removalOps(rs)), []);
  log(`Deleted ${rs.length} item${rs.length > 1 ? 's' : ''}. Ctrl+Z brings it back.`, 'ok');
}

function duplicate() {
  const rs = roots();
  if (!rs.length) return;
  const copies = rs.map((r) => ({ ...r, copy: clone(r.o) }));
  const ops = sortRemovals(copies.map((c) => ({ arr: c.arr, index: c.index + 1, count: 0, insert: [c.copy] })));
  structure(ops, copies.flatMap((c) => leavesOf(c.copy)));
  setMode('translate');
  log('Duplicated in place. Drag the arrows to move the copy.', 'ok');
}

let clipboard = null;
function copy() {
  const rs = roots();
  if (!rs.length) return;
  clipboard = rs.map((r) => clone(r.o));
  store('3dx-editor-clipboard', JSON.stringify(clipboard));
  log(`Copied ${rs.length} item${rs.length > 1 ? 's' : ''}. Paste with Ctrl+V, in this or another room.`, 'ok');
}
function paste() {
  let items = clipboard;
  if (!items) { try { items = JSON.parse(recall('3dx-editor-clipboard') || 'null'); } catch { items = null; } }
  if (!items?.length || !world) return;
  const fresh = clone(items);
  structure([{ arr: world.objects, index: world.objects.length, count: 0, insert: fresh }], fresh.flatMap(leavesOf));
  log(`Pasted ${fresh.length} item${fresh.length > 1 ? 's' : ''} at their original spot.`, 'ok');
}

function group() {
  const rs = roots();
  if (!rs.length) return;
  // groups in the game are one level deep, so members of existing groups are pulled in loose
  const members = rs.flatMap((r) => leavesOf(r.o));
  const g = { n: 'group', objects: members };
  const ops = sortRemovals(removalOps(rs));
  ops.push({ arr: world.objects, index: Infinity, count: 0, insert: [g] });
  const before = [...selection];
  for (const op of ops) {
    if (op.index === Infinity) op.index = op.arr.length;
    op.removed = op.arr.splice(op.index, op.count, ...op.insert);
  }
  // a group left empty after pulling members out goes too
  const empties = world.objects.map((o, i) => ({ o, i })).filter(({ o }) => isGroup(o) && !o.objects.length).reverse();
  const extra = empties.map(({ i }) => ({ arr: world.objects, index: i, count: 1, insert: [] }));
  runSplices(extra);
  push({ type: 'splice', ops: [...ops, ...extra], selBefore: before, selAfter: members });
  setSelection(members, false);
  build();
  log(`Grouped ${members.length} objects.`, 'ok');
}

function ungroup() {
  const gs = roots().filter((r) => isGroup(r.o)).sort((a, b) => b.index - a.index);
  if (!gs.length) return;
  structure(gs.map((r) => ({ arr: world.objects, index: r.index, count: 1, insert: [...r.o.objects] })), [...selection]);
  log(`Ungrouped ${gs.length} group${gs.length > 1 ? 's' : ''}.`, 'ok');
}

async function clearRoom() {
  if (!world || !world.objects.length) return;
  const ok = await confirmBox('Clear room', `Remove all ${entries.length.toLocaleString()} objects from ${current}? The spawn point and weather stay. Ctrl+Z undoes it until you close the room.`, 'Clear room', true);
  if (!ok) return;
  structure([{ arr: world.objects, index: 0, count: world.objects.length, insert: [] }], []);
  log('Room cleared. Ctrl+Z brings everything back.', 'ok');
}

// ---------- Popups (menus and dropdowns) ----------
const popupEl = $('popup');
let popupFor = null;
function openPopup(anchor, items) {
  if (popupFor === anchor && !popupEl.hidden) { closePopup(); return; }
  popupFor = anchor;
  popupEl.className = 'panel';  // drop the weather / AI panel layouts
  popupEl.innerHTML = items.map((it, i) => it === '-' ? '<div class="msep"></div>'
    : `<button class="mi${it.checked ? ' checked' : ''}${it.danger ? ' danger' : ''}" data-i="${i}"${it.disabled ? ' disabled' : ''}>`
      + `${it.icon ? svg(it.icon) : ''}${esc(it.label)}${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>`).join('');
  popupEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = popupEl.offsetWidth, h = popupEl.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = r.top - h - 6;  // open upward near the bottom
  popupEl.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  popupEl.style.top = Math.max(8, top) + 'px';
  popupEl.onclick = (ev) => {
    const b = ev.target.closest('.mi');
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    closePopup();
    it.run?.();
  };
}
function closePopup() { popupEl.hidden = true; popupFor = null; }
document.addEventListener('pointerdown', (ev) => {
  if (!popupEl.hidden && !popupEl.contains(ev.target) && !popupFor?.contains(ev.target)) closePopup();
});

// ---------- Modals ----------
const modalEl = $('modal'), modalBg = $('modal-bg');
let modalDone = null;
function openModal(html, onReady) {
  modalEl.onclick = modalEl.onchange = modalEl.onkeydown = null;  // no handlers left over from the last window
  modalEl.innerHTML = html;
  modalEl.hidden = modalBg.hidden = false;
  hydrateIcons(modalEl);
  return new Promise((resolve) => {
    modalDone = (v) => { modalEl.hidden = modalBg.hidden = true; modalDone = null; resolve(v); };
    onReady?.(modalDone);
  });
}
modalBg.addEventListener('click', () => modalDone?.(null));
function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return openModal(`<h3>${esc(title)}</h3><div>${esc(text)}</div>
    <div class="foot"><button class="act" data-x="no">Cancel</button><button class="act${danger ? '' : ' primary'}" data-x="yes" style="${danger ? 'border-color:#b45454;color:#fca5a5' : ''}">${esc(okLabel)}</button></div>`,
  (done) => { modalEl.onclick = (ev) => { const x = ev.target.closest('[data-x]')?.dataset.x; if (x) done(x === 'yes'); }; });
}

// Pick a room from the Worlds folder (Load room, Import).
let worldList = [];
// The room list: your Worlds folder (the shortcut), folders you opened before,
// any other folder, or a single file anywhere. Returns a room path or null.
const recentFolders = () => { try { return JSON.parse(recall('3dx-editor-folders') || '[]'); } catch { return []; } };
function rememberFolder(f) { store('3dx-editor-folders', JSON.stringify([f, ...recentFolders().filter((x) => x !== f)].slice(0, 5))); }
function roomPicker(title, note, exclude) {
  let source = worldsReady() ? null : recentFolders()[0] || null;  // null = the Worlds folder
  let rooms = source ? [] : worldList;
  const groupOf = (p) => {
    const rel = source && p.startsWith(source + '/') ? p.slice(source.length + 1) : p;
    const cut = rel.lastIndexOf('/');
    return cut < 0 ? (source ? source.split('/').pop() : 'Worlds') : rel.slice(0, cut);
  };
  const listHtml = (q) => {
    const folders = new Map();
    for (const w of rooms) {
      if (w.path === exclude || (q && !w.path.toLowerCase().includes(q))) continue;
      const g = groupOf(w.path);
      if (!folders.has(g)) folders.set(g, []);
      folders.get(g).push(w);
    }
    return [...folders].map(([folder, list]) => `<div class="fold">${esc(folder)}</div>` + list.map((w) =>
      `<button data-p="${esc(w.path)}" class="${w.path === current ? 'cur' : ''}"><span>${esc(w.path.split('/').pop().replace(/\.world$/i, ''))}</span><span>${(w.size / 1024).toFixed(0)} KB</span></button>`).join('')).join('')
      || `<div class="fold">${rooms.length ? 'Nothing matches.' : 'No rooms in this folder.'}</div>`;
  };
  const tabsHtml = () => (worldsReady() ? `<button class="rtab${source ? '' : ' on'}" data-src="">${svg('home')}Worlds</button>` : '')
    + recentFolders().map((f) => `<button class="rtab${source === f ? ' on' : ''}" data-src="${esc(f)}" title="${esc(f)}">${svg('folder')}${esc(f.split('/').pop())}</button>`).join('')
    + `<button class="rtab" data-x="folder">${svg('folder-search')}Other folder…</button>`;
  return openModal(`<h3>${esc(title)}</h3>${note ? `<div class="note" style="margin:0 0 8px">${esc(note)}</div>` : ''}
    <div class="rtabs" id="room-tabs">${tabsHtml()}</div>
    <input type="search" id="room-q" placeholder="Search rooms"><div class="wlist" id="room-list">${listHtml('')}</div>
    <div class="foot"><button class="act" data-x="file" style="margin-right:auto">${svg('file-search')} Open a file…</button><button class="act" data-x="no">Cancel</button></div>`,
  (done) => {
    const q = $('room-q');
    q.focus();
    const show = () => { $('room-tabs').innerHTML = tabsHtml(); $('room-list').innerHTML = listHtml(q.value.trim().toLowerCase()); };
    const openFolder = async (f) => {
      source = f || null;
      if (!f) { rooms = worldList; show(); return; }
      $('room-list').innerHTML = '<div class="fold">Looking…</div>';
      try {
        const res = await fetch(HELPER + '/api/worlds?folder=' + encodeURIComponent(f));
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        rooms = body.worlds;
        rememberFolder(f);
      } catch (err) { rooms = []; log(`${f}: ${err.message || 'could not be read'}`, 'err'); }
      show();
    };
    if (source) openFolder(source);
    q.oninput = show;
    modalEl.onclick = async (ev) => {
      const p = ev.target.closest('[data-p]')?.dataset.p;
      if (p) { done(p); return; }
      const src = ev.target.closest('[data-src]');
      if (src) { openFolder(src.dataset.src); return; }
      const x = ev.target.closest('[data-x]')?.dataset.x;
      if (x === 'folder') { const f = await pickOnPC('folder', source || ''); if (f) openFolder(f); }
      else if (x === 'file') { const f = await pickOnPC('file', source || ''); if (f) { if (isFullPath(f)) rememberFolder(folderOf(f)); done(f); } }
      else if (x) done(null);
    };
  });
}

// Ask for a room name and folder; returns a path ending in .world, or null.
function askRoomName(title, suggestion, okLabel, elsewhere = false) {
  const folders = [...new Set(worldList.map((w) => (w.path.includes('/') ? w.path.slice(0, w.path.lastIndexOf('/')) : '')))].sort();
  const cut = suggestion.lastIndexOf('/');
  const sFolder = cut < 0 ? '' : suggestion.slice(0, cut), sName = suggestion.slice(cut + 1);
  return openModal(`<h3>${esc(title)}</h3>
    <div class="row one"><label>Name</label><input type="text" id="rn-name" value="${esc(sName)}"></div>
    <div class="row one"><label>Folder</label><input type="text" id="rn-folder" list="rn-folders" value="${esc(sFolder)}" placeholder="(Worlds folder itself)"></div>
    <datalist id="rn-folders">${folders.filter(Boolean).map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
    <div class="note">In your Worlds folder. Type a new folder name to make one.</div>
    <div class="foot">${elsewhere ? `<button class="act" data-x="elsewhere" style="margin-right:auto">${svg('folder-open')} Somewhere else on this PC…</button>` : ''}
      <button class="act" data-x="no">Cancel</button><button class="act primary" data-x="yes">${esc(okLabel)}</button></div>`,
  (done) => {
    const nameEl = $('rn-name');
    nameEl.focus(); nameEl.select();
    const finish = () => {
      const name = nameEl.value.trim().replace(/\.world$/i, '');
      const folder = $('rn-folder').value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const parts = [...(folder ? folder.split('/') : []), name];
      if (!name || parts.some((p) => !p || p === '..' || /[<>:"|?*]/.test(p))) {
        nameEl.style.borderColor = '#b45454';
        return;
      }
      done(parts.join('/') + '.world');
    };
    modalEl.onclick = (ev) => {
      const x = ev.target.closest('[data-x]')?.dataset.x;
      if (x === 'yes') finish(); else if (x === 'elsewhere') done('*elsewhere'); else if (x) done(null);
    };
    modalEl.onkeydown = (ev) => { if (ev.key === 'Enter') finish(); if (ev.key === 'Escape') done(null); };
  });
}

// ---------- Settings window ----------
// Sections on the left (searchable), the chosen page on the right. Every
// change applies at once and is remembered; "Reset this page" goes back to
// the editor's defaults. Folders and AI connections go through the server.
const SECTIONS = [
  ['Editor', [['general', 'General', 'sliders-horizontal'], ['camera', 'Camera', 'video'], ['building', 'Building', 'hammer'],
    ['layout', 'Screen layout', 'layout-dashboard'], ['graphics', 'Graphics', 'monitor']]],
  ['Room', [['room', 'This room', 'map-pin']]],
  ['More', [['ai', 'AI', 'sparkles'], ['about', 'About & feedback', 'info']]],
];
const PAGE_NAMES = Object.fromEntries(SECTIONS.flatMap(([, s]) => s.map(([id, name]) => [id, name])));
const setBg = document.createElement('div');
setBg.id = 'set-bg';
setBg.hidden = true;
const setEl = document.createElement('div');
setEl.id = 'settings';
setEl.className = 'panel';
setEl.hidden = true;
document.body.append(setBg, setEl);
let setPage = 'general', setInfo = null, aiApp = null;

async function loadSetInfo() {
  try {
    const res = await fetch(HELPER + '/api/settings/info');
    if (res.status === 404) {  // the page was updated but the server is still the old one
      setInfo = null;
      log('The editor server is out of date: close its window and run Start Editor.bat again, then reload this page.', 'err');
      return;
    }
    setInfo = await res.json();
  } catch { setInfo = null; }
}
async function openSettings(page = setPage) {
  closePopup();
  setPage = page;
  setEl.innerHTML = `<nav class="set-nav"><h2>Settings</h2>
      <label class="set-search">${svg('search')}<input id="set-q" placeholder="Search settings" spellcheck="false"></label>
      ${SECTIONS.map(([grp, items]) => `<div class="set-grp">${grp}</div>` + items.map(([id, name, icon]) =>
        `<button class="set-nv" data-page="${id}">${svg(icon)}${name}${id === 'ai' ? '<span class="set-badge" id="set-ai-badge"></span>' : ''}</button>`).join('')).join('')}
    </nav>
    <main class="set-pane" id="set-pane"></main>
    <footer class="set-foot"><span class="muted">Changes apply right away and are remembered.</span>
      <button class="act" data-act="reset">Reset this page</button><button class="act primary" data-act="done">Done</button></footer>`;
  setEl.hidden = setBg.hidden = false;
  renderSetPage();
  await loadSetInfo();
  if (!setEl.hidden) renderSetPage();
}
function closeSettings() { setEl.hidden = setBg.hidden = true; }
setBg.onclick = closeSettings;

// --- building blocks ---
const sOpt = (title, desc, control = '', key = '') => `<div class="sopt"${key ? ` data-key="${key}"` : ''}><div><div class="t">${title}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div>${control}</div>`;
const sNum = (key, value, unit = '', min = 0, max = 1000) => `<div class="snum"><input data-num="${key}" data-min="${min}" data-max="${max}" value="${num(value)}" inputmode="decimal"><span>${unit}</span></div>`;
const sTog = (key, on) => `<button class="stog${on ? ' on' : ''}" data-tog="${key}" aria-pressed="${on}"></button>`;
const sSeg = (key, value, opts) => `<div class="sseg">${opts.map(([v, l]) => `<button class="${v === value ? 'on' : ''}" data-seg="${key}" data-v="${v}">${l}</button>`).join('')}</div>`;
const sCard = (title, body) => `<div class="scard"><h4>${title}</h4>${body}</div>`;
const sPath = (which, path, auto, extra = '') => `<div class="spath"><code title="${esc(path || '')}">${esc(path || 'Not found')}</code>`
  + `<button class="act small" data-act="folder" data-which="${which}">Change…</button>${extra}</div>`
  + (auto ? '' : `<button class="slink" data-act="auto" data-which="${which}">Go back to finding it automatically</button>`);
const found = (ok, auto) => ok ? `<span class="sok">${svg('check')}${auto ? 'Found automatically' : 'Chosen by you'}</span>` : `<span class="sbad">${svg('alert-triangle')}Not found: pick it with Change…</span>`;

function aiSnippet(app) {
  const ai = setInfo?.ai;
  if (!ai) return { text: '', where: '' };
  const entry = { command: ai.command, args: [ai.script] };
  const json = (o) => JSON.stringify(o, null, 2);
  if (app === 'claude-code') return { text: `claude mcp add ${ai.name} --scope user -- "${ai.command}" "${ai.script}"`, where: 'Run this once in a terminal (PowerShell or Command Prompt), then start a new Claude Code session.' };
  if (app === 'cursor') return { text: json({ mcpServers: { [ai.name]: entry } }), where: 'Cursor → Settings → MCP → Add new server, or paste into <code>%USERPROFILE%\\.cursor\\mcp.json</code>.' };
  if (app === 'vscode') return { text: json({ servers: { [ai.name]: { type: 'stdio', ...entry } } }), where: 'VS Code: Command Palette → "MCP: Open User Configuration", paste, save. Use Copilot Chat in Agent mode.' };
  if (app === 'lmstudio') return { text: json({ mcpServers: { [ai.name]: entry } }), where: 'LM Studio → Program tab → Install → Edit mcp.json, paste, save. Pick a model that supports tools.' };
  return { text: json({ mcpServers: { [ai.name]: entry } }), where: 'Most MCP apps take this in their MCP settings or mcp.json. The app must be able to run local programs.' };
}

const aiAvailable = () => setInfo?.ai_available !== false;  // the beta ships without the AI connection
function aiPage() {
  if (!aiAvailable()) {
    return `<h3>AI</h3><p class="lead">Let an AI assistant build and change rooms with you.</p>`
      + sCard('Coming in a later version', `<div class="sbody">AI connections aren't part of this beta yet. This first version is for testing the editor itself:
        build, break things, and tell us what goes wrong. After a round of bug fixes, AI connections come back, refined.</div>`)
      + sCard('What it will do', `<ul class="sprompts">
          <li>Build rooms from a description ("a small kitchen next to the Bedroom").</li>
          <li>Change what's there ("make all the walls darker", "put a plant in each corner").</li>
          <li>Look at what it built and fix what's off, and undo its own changes.</li>
          <li>Work with Claude, Cursor, VS Code, LM Studio and other AI apps.</li></ul>`);
  }
  const ai = setInfo?.ai;
  const app = ai?.claude_app || {};
  aiApp = aiApp || (app.installed ? 'claude-app' : 'claude-code');
  const APPS = [['claude-app', 'Claude app', 'Desktop app', 'Tested'], ['claude-code', 'Claude Code', 'Terminal', 'Tested'],
    ['cursor', 'Cursor', 'Code editor', 'Should work'], ['vscode', 'VS Code', 'Copilot agent mode', 'Should work'],
    ['lmstudio', 'LM Studio', 'Local models', 'Should work'], ['other', 'Other app', 'Any MCP app', 'Copy the setup']];
  let detail;
  if (!ai) detail = '<div class="d">Loading…</div>';
  else if (aiApp === 'claude-app') {
    detail = !app.installed ? `<div class="sbad">${svg('alert-triangle')}The Claude desktop app isn't installed on this PC.</div>`
      : !app.readable ? `<div class="sbad">${svg('alert-triangle')}Claude's settings file couldn't be read, so it's left alone.</div>`
      : `<div class="srow">${app.connected ? `<span class="sok">${svg('check')}The Claude app is connected</span>` : '<span class="d">Not connected yet.</span>'}<span style="flex:1"></span>`
        + (app.connected ? `<button class="act small" data-act="claude" data-on="1">Connect again</button><button class="act small" data-act="claude" data-on="0">Disconnect</button>`
          : `<button class="act small primary" data-act="claude" data-on="1">${svg('plug')} Connect</button>`) + '</div>'
        + '<div class="d" style="margin-top:6px">This adds the editor to Claude\'s own settings, leaving the rest as it was. Afterwards quit Claude fully (tray icon → Quit) and open it again.</div>';
  } else {
    const s = aiSnippet(aiApp);
    detail = (aiApp === 'claude-code' && ai.claude_code ? `<div class="srow"><span class="sok">${svg('check')}Claude Code is connected</span></div>` : '')
      + `<div class="d">${s.where}</div><pre class="ssnip" id="set-snip">${esc(s.text)}</pre>`
      + `<button class="act small" data-act="copy">${svg('copy')} Copy</button>`;
  }
  return `<h3>AI</h3><p class="lead">Let an AI assistant build and change rooms with you. It works through this editor, so it only touches your Worlds folder.</p>`
    + sCard('Connect to AI', `<div class="d" style="margin-bottom:8px">Pick the app you use:</div><div class="sapps">${APPS.map(([id, name, sub, tag]) =>
      `<button class="sapp${aiApp === id ? ' on' : ''}" data-app="${id}"><b>${name}</b><small>${sub}</small><span class="stag${tag === 'Tested' ? ' t' : ''}">${tag}</span></button>`).join('')}</div>
      <div class="sdetail">${detail}</div>`)
    + sCard('What to ask', `<ul class="sprompts">
        <li>"Build a small kitchen next to the Bedroom, then look at it and fix anything off."</li>
        <li>"Make all the walls in this room darker."</li>
        <li>"Put a plant in each corner, facing the middle."</li>
        <li>"Undo that."</li></ul>
      <div class="d" style="margin-top:8px">Keep the editor open: the AI uses it to take pictures. Save your own changes before asking it to look at another room. The AI button (top right) shows what it did.</div>`)
    + sCard('Which AIs work', '<div class="sbody">Any app that can run local MCP tools. <b>ChatGPT</b> can\'t: it only connects to servers on the internet. Small local models may struggle with the tools, and looking at pictures needs a model that can see images.</div>');
}

function setPageHtml(page) {
  const info = setInfo;
  if (page === 'general') return `<h3>General</h3><p class="lead">Where your rooms are and how the editor starts.</p>`
    + sCard('Folders', (info && !info.worlds_feature ? '' : !info ? sOpt('Worlds folder', '', '', 'worlds')
      : info.worlds_set
        ? sOpt('Worlds folder', `<span class="sok">${svg('check')}Chosen by you</span>`, '', 'worlds')
          + sPath('worlds', info.worlds, true, '<button class="act small" data-act="open" data-which="worlds">Open</button>')
        : sOpt('Worlds folder', `<span class="sbad">${svg('alert-triangle')}Not picked yet: rooms can't be loaded until you pick it.</span>`
          + (info.worlds_guess ? '<br>Found this one, where 3DXChat keeps its rooms:' : ' Point it at 3DXChat\'s Documents\\3DXChat\\Worlds folder.'), '', 'worlds')
          + `<div class="spath"><code title="${esc(info.worlds_guess || '')}">${esc(info.worlds_guess || 'Not found')}</code>`
          + (info.worlds_guess ? '<button class="act small primary" data-act="use-guess">Use this folder</button>' : '')
          + '<button class="act small" data-act="folder" data-which="worlds">Change…</button></div>')
      + (info && !info.worlds_feature ? '' : '<div style="height:10px"></div>')
      + sOpt('3DXChat game folder', 'Used to read the game\'s models and materials. ' + (info ? found(!!info.game, info.game_auto) : ''), '', 'game')
      + sPath('game', info?.game, info?.game_auto ?? true))
    + sCard('Start-up', sOpt('Open the last room', 'Otherwise the editor starts by asking which room to open.', sTog('openLast', settings.openLast))
      + sOpt('Show the object list', 'The tree on the left (L).', sTog('listOpen', !$('objlist').hidden)));
  if (page === 'camera') return `<h3>Camera</h3><p class="lead">How the view moves. Type a number: bigger is faster.</p>`
    + sCard('Free camera', `<div class="stwo"><div>`
      + sOpt('Movement', '<kbd>W A S D</kbd> <kbd>Q E</kbd>', sNum('flySpeed', settings.flySpeed, 'm/s', 0.1, 200))
      + sOpt('Rotate', 'Drag with the left mouse', sNum('rotateSpeed', settings.rotateSpeed, '×', 0.05, 20))
      + sOpt('Pan', 'Drag with the right mouse', sNum('panSpeed', settings.panSpeed, '×', 0.05, 20))
      + sOpt('Zoom step', 'Mouse wheel', sNum('zoomSpeed', settings.zoomSpeed, '×', 0.05, 20))
      + `</div><div>`
      + sOpt('Speed up 1', 'Hold <kbd>Shift</kbd>', sNum('boost1', settings.boost1, '×', 1, 100))
      + sOpt('Speed up 2', 'Hold <kbd>Alt</kbd>', sNum('boost2', settings.boost2, '×', 1, 500))
      + sOpt('Slow down', 'Hold <kbd>Space</kbd>', sNum('slow', settings.slow, '×', 0.01, 1))
      + sOpt('Field of view', 'Wider shows more', sNum('fov', settings.fov, '°', 20, 120))
      + `</div></div>`)
    + sCard('Feel', sOpt('Smooth camera', 'Glides to a stop instead of stopping at once.', sTog('smooth', settings.smooth))
      + sOpt('Invert rotating', 'Dragging turns the view the other way.', sTog('invert', settings.invert)));
  if (page === 'building') return `<h3>Building</h3><p class="lead">How the tools behave. The magnets in the top bar turn snapping on and off.</p>`
    + sCard('Snapping', sOpt('Move step', 'Used while the move magnet is on', sNum('moveStep', round(stepSet * 100, 2), 'cm', 0.1, 10000))
      + sOpt('Rotate step', 'Used while the rotate magnet is on', sNum('turnStep', angleSet, '°', 0.1, 360)))
    + sCard('Handles', sOpt('Handle size', 'The move, rotate and scale handles keep this size on screen.', sNum('handlePct', Math.round(settings.handleSize * 100), '%', 40, 250)))
    + sCard('Placing', sOpt('New objects face', 'The way the last one faced, or always north', sSeg('placeFacing', settings.placeFacing, [['last', 'Last used'], ['north', 'North']]))
      + sOpt('Select after placing', 'Stop placing and select the new object.', sTog('selectAfterPlace', settings.selectAfterPlace)));
  if (page === 'layout') return `<h3>Screen layout</h3><p class="lead">Where things sit on screen.</p>`
    + sCard('Info corner', sOpt('Log, view buttons, alerts and fps', 'Pick the corner they stack in.',
      `<div class="scorner">${['tl', 'tr', 'bl', 'br'].map((c) => `<button data-seg="corner" data-v="${c}" class="${settings.corner === c ? 'on' : ''}" title="${{ tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' }[c]}"><i class="${c}"></i></button>`).join('')}</div>`))
    + sCard('Panels', sOpt('Tooltips', 'Names of buttons when you hover over them.', sTog('tooltips', settings.tooltips))
      + sOpt('Colour brush panel', 'Opens with the brush (B). Its spot is remembered.', '<button class="act small" data-act="brush-spot">Reset its spot</button>'));
  if (page === 'graphics') return `<h3>Graphics</h3><p class="lead">Lower settings keep big rooms smooth on slower graphics cards.</p>`
    + sCard('Quality', sOpt('Shadows', '', sSeg('shadows', settings.shadows, [['high', 'High'], ['low', 'Low'], ['off', 'Off']]))
      + sOpt('Detail', 'How far away objects stay detailed', sSeg('detail', detailLevel, [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']]))
      + sOpt('Show fps', 'Frames per second in the info corner', sTog('showFps', settings.showFps)))
    + sCard('In the view', sOpt('Ground grid', 'The grid at sea level', sTog('grid', settings.grid))
      + sOpt('Spawn marker', 'The green cone where players appear', sTog('spawnMarker', settings.spawnMarker)));
  if (page === 'room') {
    if (!world) return '<h3>This room</h3><p class="lead">Open a room first.</p>';
    const rs = world.respawn || { p: [0, 0, 0], r: 0 };
    return `<h3>This room</h3><p class="lead">Saved inside <b>${esc(current ? roomFull(current) : untitled)}</b>. Weather and brightness are in the weather menu.</p>`
      + sCard('Spawn point', sOpt('Position', 'Where players appear (their feet): x · y · z', `<div class="snum">${[0, 1, 2].map((i) => `<input data-spawn="${i}" value="${num(rs.p?.[i])}" inputmode="decimal" style="width:64px">`).join('')}</div>`)
        + sOpt('Facing', '0 = north, 90 = east', sNum('spawnFacing', rs.r || 0, '°', -360, 720))
        + sOpt('', 'Where the camera is now, facing the way it looks.', '<button class="act small" data-act="spawn-cam">Set to the camera</button>'))
      + sCard('Water', sOpt('Sea level', 'Height of the sea in this room', sNum('sea', world.oceanlevel ?? 0, 'm', -1000, 1000)));
  }
  if (page === 'ai') return aiPage();
  if (page === 'about') return `<h3>About &amp; feedback</h3><p class="lead">3DX World Editor · ${esc(info?.version || '')}</p>`
    + sCard('Feedback', sOpt('Found a bug?', 'Opens a report on GitHub with your versions filled in. You need a free GitHub account.',
      `<a class="act small" target="_blank" rel="noopener" href="${REPO}/issues/new?template=bug.yml&version=${encodeURIComponent(`page ${PAGE_VERSION} · helper ${info?.version || '?'} · ${navigator.userAgent.match(/(Brave|Edg|Chrome|Firefox)\/[\d.]+/)?.[0] || 'browser?'}`)}">${svg('bug')} Report a bug</a>`)
      + sOpt('Have an idea?', '', `<a class="act small" target="_blank" rel="noopener" href="${REPO}/issues/new?template=idea.yml">${svg('lightbulb')} Suggest it</a>`))
    + sCard('What\'s new', `<ul class="sprompts">
        <li>Settings, in sections, with search</li>
        <li>Colour picker with your game palette (brush and selection)</li>
        ${aiAvailable() ? '<li>AI button and activity list; AI can look at what it builds</li>' : ''}
        <li>Load rooms from anywhere with Windows' file window; drag a room file onto the editor</li>
        <li>Separate move and rotate magnets</li>
        <li>Room status as a coloured dot</li></ul>`);
  return '';
}

function renderSetPage() {
  setEl.querySelectorAll('.set-nv').forEach((b) => b.classList.toggle('on', b.dataset.page === setPage));
  const ai = setInfo?.ai;
  const badge = $('set-ai-badge');
  if (badge) badge.hidden = !(ai && (ai.claude_app?.connected || ai.claude_code));
  $('set-pane').innerHTML = setPageHtml(setPage);
  setEl.querySelector('[data-act="reset"]').disabled = !RESETS[setPage];
}

// search: every option of every page, by its name and description
function searchSettings(q) {
  q = q.trim().toLowerCase();
  if (!q) { renderSetPage(); return; }
  const tmp = document.createElement('div');
  const hits = [];
  for (const id of Object.keys(PAGE_NAMES)) {
    tmp.innerHTML = setPageHtml(id);
    tmp.querySelectorAll('.sopt, .scard h4').forEach((el) => {
      const title = el.matches('h4') ? el.textContent : el.querySelector('.t')?.textContent || '';
      const text = (title + ' ' + (el.querySelector('.d')?.textContent || '') + ' ' + PAGE_NAMES[id]).toLowerCase();
      if (title && text.includes(q)) hits.push([id, title]);
    });
  }
  setEl.querySelectorAll('.set-nv').forEach((b) => b.classList.remove('on'));
  $('set-pane').innerHTML = `<h3>Search</h3><p class="lead">${hits.length ? `${hits.length} match${hits.length > 1 ? 'es' : ''}` : 'Nothing matches.'}</p>`
    + hits.map(([id, title]) => `<button class="shit" data-page="${id}" data-find="${esc(title)}"><span class="muted">${PAGE_NAMES[id]} ›</span> ${esc(title)}</button>`).join('');
}

// What "Reset this page" puts back (the editor's defaults).
const RESETS = {
  general: () => { settings.openLast = DEFAULTS.openLast; if (!$('objlist').hidden) toggleList(false); },
  camera: () => { for (const k of ['flySpeed', 'rotateSpeed', 'panSpeed', 'zoomSpeed', 'boost1', 'boost2', 'slow', 'fov', 'smooth', 'invert']) settings[k] = DEFAULTS[k]; applyCamera(); },
  building: () => { settings.handleSize = 1; settings.placeFacing = 'last'; settings.selectAfterPlace = false; gizmo.setSize(1); setSnapStep(0.05); setSnapAngle(15); },
  layout: () => { settings.corner = 'br'; settings.tooltips = true; applyCorner(); applyTooltips(); store('3dx-editor-brush-panel', ''); },
  graphics: () => { settings.shadows = 'high'; settings.showFps = settings.grid = settings.spawnMarker = true; applyShadows(); applyViewExtras(); setDetail('normal'); },
};

function applyCamera() {
  controls.rotateSpeed = settings.rotateSpeed * (settings.invert ? -1 : 1);
  controls.panSpeed = settings.panSpeed;
  controls.zoomSpeed = settings.zoomSpeed;
  controls.enableDamping = settings.smooth;
  camera.fov = settings.fov;
  camera.updateProjectionMatrix();
}
function applyTooltips() { document.body.classList.toggle('no-tips', !settings.tooltips); }
function applyViewExtras() {
  $('perf').hidden = !settings.showFps;
  grid.visible = settings.grid;
  if (respawnMarker) respawnMarker.visible = settings.spawnMarker;
}
function setDetail(d) {
  detailLevel = d;
  store('3dx-editor-detail', d);
  $('detail-btn').querySelector('span').textContent = DETAIL_LABEL[d];
  assignDetail();
}

// a number box changed
function setNumber(key, v) {
  if (key === 'moveStep') return setSnapStep(v / 100);
  if (key === 'turnStep') return setSnapAngle(v);
  if (key === 'handlePct') { settings.handleSize = v / 100; gizmo.setSize(settings.handleSize); return saveSettings(); }
  if (key === 'spawnFacing') return changeWorld(() => { world.respawn = world.respawn || { p: [0, 0, 0], r: 0 }; world.respawn.r = deg360(v); });
  if (key === 'sea') return changeWorld(() => { world.oceanlevel = round(v, 3); });
  settings[key] = v;
  saveSettings();
  applyCamera();
}
function setToggle(key, on) {
  if (key === 'listOpen') { toggleList(on); return; }
  settings[key] = on;
  saveSettings();
  if (key === 'smooth' || key === 'invert') applyCamera();
  else if (key === 'tooltips') applyTooltips();
  else applyViewExtras();
}
function setChoice(key, v) {
  if (key === 'detail') return setDetail(v);
  settings[key] = v;
  saveSettings();
  if (key === 'shadows') applyShadows();
  else if (key === 'corner') applyCorner();
}

setEl.addEventListener('click', async (ev) => {
  const nv = ev.target.closest('[data-page]');
  if (nv) {
    setPage = nv.dataset.page;
    $('set-q').value = '';
    renderSetPage();
    const find = nv.dataset.find;
    if (find) {  // from search: point at the option
      const row = [...setEl.querySelectorAll('.sopt, .scard')].find((el) => (el.querySelector('.t') || el.querySelector('h4'))?.textContent === find);
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('sflash'); }
    }
    return;
  }
  const tog = ev.target.closest('[data-tog]');
  if (tog) { const on = !tog.classList.contains('on'); tog.classList.toggle('on', on); setToggle(tog.dataset.tog, on); return; }
  const seg = ev.target.closest('[data-seg]');
  if (seg) {
    seg.parentElement.querySelectorAll('[data-seg]').forEach((b) => b.classList.toggle('on', b === seg));
    setChoice(seg.dataset.seg, seg.dataset.v);
    return;
  }
  const app = ev.target.closest('[data-app]');
  if (app) { aiApp = app.dataset.app; renderSetPage(); return; }
  const act = ev.target.closest('[data-act]');
  const a = act?.dataset.act;
  if (!a) return;
  if (a === 'done') closeSettings();
  else if (a === 'reset') {
    RESETS[setPage]?.();
    saveSettings();
    renderSetPage();
    log(`${PAGE_NAMES[setPage]} settings back to the defaults.`, 'ok');
  } else if (a === 'folder' || a === 'auto' || a === 'use-guess') {
    if (a === 'folder') log('Pick the folder in the window that opened (it may be behind the browser).', 'info');
    const which = a === 'use-guess' ? 'worlds' : act.dataset.which;
    const res = await fetch(HELPER + '/api/settings/folder', { method: 'POST', body: JSON.stringify({ which, action: { auto: 'auto', 'use-guess': 'guess' }[a] || 'pick' }) });
    const body = await res.json();
    if (!res.ok) { log(body.error || 'Could not change the folder.', 'err'); return; }
    const before = [setInfo?.worlds, setInfo?.worlds_set];
    setInfo = body;
    renderSetPage();
    if (which === 'worlds' && (before[0] !== body.worlds || before[1] !== body.worlds_set)) {
      await refreshWorldList();
      log(`Worlds folder: ${body.worlds}. ${current ? 'Restart your AI app so it uses it too.' : 'Load a room from ☰ → Load room.'}`, 'ok');
    }
  } else if (a === 'open') {
    fetch(HELPER + '/api/settings/open', { method: 'POST', body: JSON.stringify({ which: act.dataset.which }) });
  } else if (a === 'brush-spot') {
    store('3dx-editor-brush-panel', '');
    log('The colour brush panel opens in its first spot again.', 'ok');
  } else if (a === 'spawn-cam') {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const facing = deg360(Math.atan2(dir.x, -dir.z) / D2R);
    changeWorld(() => {
      world.respawn = { p: [round(camera.position.x, 3), round(Math.max(0, camera.position.y - 1.7), 3), round(-camera.position.z, 3)], r: round(facing, 1) };
    });
    renderSetPage();
    log('Spawn moved to the camera.', 'ok');
  } else if (a === 'claude') {
    const res = await fetch(HELPER + '/api/settings/claude-app', { method: 'POST', body: JSON.stringify({ connect: act.dataset.on === '1' }) });
    const body = await res.json();
    if (!res.ok) { log(body.error || 'Could not change Claude\'s settings.', 'err'); return; }
    setInfo.ai = body;
    renderSetPage();
    log(act.dataset.on === '1' ? 'Connected the Claude app. Quit Claude fully (tray icon → Quit) and open it again.' : 'Disconnected the Claude app. Restart Claude to finish.', 'ok');
  } else if (a === 'copy') {
    try { await navigator.clipboard.writeText($('set-snip').textContent); act.innerHTML = `${svg('check')} Copied`; }
    catch { log('Copying was blocked by the browser: select the text and press Ctrl+C.', 'err'); }
  }
});
setEl.addEventListener('input', (ev) => { if (ev.target.id === 'set-q') searchSettings(ev.target.value); });
setEl.addEventListener('change', (ev) => {
  const t = ev.target;
  const v = parseFloat(String(t.value).replace(',', '.'));
  if (t.dataset.num) {
    const min = Number(t.dataset.min), max = Number(t.dataset.max);
    if (!Number.isFinite(v) || v < min || v > max) { t.classList.add('bad'); t.title = `A number from ${min} to ${max}`; return; }
    t.classList.remove('bad');
    setNumber(t.dataset.num, v);
  } else if (t.dataset.spawn !== undefined && world) {
    if (!Number.isFinite(v)) { t.classList.add('bad'); return; }
    t.classList.remove('bad');
    changeWorld(() => {
      world.respawn = world.respawn || { p: [0, 0, 0], r: 0 };
      world.respawn.p = world.respawn.p || [0, 0, 0];
      world.respawn.p[Number(t.dataset.spawn)] = round(v, 4);
    });
  }
});
setEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches('input')) ev.target.blur();
});
function applyCorner() {
  const c = settings.corner;
  $('stack').className = c;
  // the selection panel and object list step aside for the stack
  selEl.classList.toggle('low', c === 'tr');
  $('objlist').classList.toggle('low', c === 'tl');
}

function openHelp() {
  const keys = [
    ['W A S D', 'fly · Q / E down and up · Shift faster'], ['Drag · right-drag · wheel', 'orbit · pan · zoom'],
    ['Click', 'select (a whole group)'], ['Alt + click', 'select one object inside a group'], ['Shift + click', 'add to the selection'],
    ['1 · 2 · 3', 'move · rotate · scale'], ['4 · 5', 'resize · grab'], ['B', 'colour brush (Alt+click picks a colour)'],
    ['End', 'drop to floor'], ['X', 'Global / Local handles'], ['F · double-click', 'focus on the selection'],
    ['T · Home', 'top view on/off · whole room'], ['L', 'object list'], ['R', 'turn the object you are placing'],
    ['Ctrl+Z · Ctrl+Y', 'undo · redo'], ['Ctrl+C · Ctrl+V · Ctrl+D', 'copy · paste · duplicate'], ['Del', 'delete'],
    ['Ctrl+G · Ctrl+Shift+G', 'group · ungroup'], ['Ctrl+S', 'save'], ['Esc', 'stop placing · clear the selection'], ['?', 'this help'],
  ];
  openModal(`<h3>Shortcuts</h3><div class="keys">${keys.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>
    <div class="note">Pick objects from the dock at the bottom: click a card, then click in the world.</div>
    <div class="foot"><button class="act primary" data-x="done">Close</button></div>`,
  (done) => { modalEl.onclick = (ev) => { if (ev.target.closest('[data-x]')) done(true); }; });
}

// ---------- Top bar, view controls and keys ----------
function updateWeather() {
  const w = WEATHERS[weatherIndex(world?.weather)];
  $('weather-btn').innerHTML = svg(w?.icon || 'cloud-sun') + `<span>${esc(world?.weather || '—')}</span>`;
}
// The weather panel: the game's 11 options in its order, each with the room's
// brightness for it (the "ambient" list in the file).
function openWeatherPanel(anchor) {
  if (popupFor === anchor && !popupEl.hidden) { closePopup(); return; }
  popupFor = anchor;
  const amb = world.ambient || [];
  const cur = (world.weather || '').toLowerCase();
  popupEl.innerHTML = WEATHERS.map((w, i) => `<div class="wxrow${w.id.toLowerCase() === cur ? ' on' : ''}" data-i="${i}">`
    + `<button class="wxpick" style="background:${w.bg}" title="${w.id}">${svg(w.icon)}</button>`
    + `<button class="wxname">${w.id}</button>`
    + `<input class="wxnum" data-i="${i}" value="${num(Number.isFinite(amb[i]) ? amb[i] : 1)}" title="Brightness of the room in this weather" inputmode="decimal"></div>`).join('')
    + `<div class="wxnote">Numbers: the room's brightness in each weather, as in the game.</div>`;
  popupEl.className = 'panel wx';
  popupEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  popupEl.style.left = Math.max(8, Math.min(r.left, innerWidth - popupEl.offsetWidth - 8)) + 'px';
  popupEl.style.top = (r.bottom + 6) + 'px';
  popupEl.onclick = (ev) => {
    const row = ev.target.closest('.wxpick, .wxname') && ev.target.closest('.wxrow');
    if (!row) return;
    const id = WEATHERS[Number(row.dataset.i)].id;
    if (id !== world.weather) { changeWorld(() => { world.weather = id; }); log(`Weather: ${id}.`, 'ok'); }
    closePopup();
  };
  popupEl.onkeydown = (ev) => { if (ev.key === 'Enter') ev.target.blur(); };
  popupEl.onchange = (ev) => {
    if (!ev.target.classList.contains('wxnum')) return;
    const v = parseFloat(ev.target.value.replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 10) { ev.target.style.borderColor = '#b45454'; return; }
    const i = Number(ev.target.dataset.i);
    changeWorld(() => {
      const a = Array.isArray(world.ambient) ? [...world.ambient] : [];
      while (a.length < WEATHERS.length) a.push(1.0);  // older files keep fewer
      a[i] = round(v, 3);
      world.ambient = a;
    });
    ev.target.style.borderColor = '';
  };
}
// The room chip's dot shows the room's state in colour; words only appear
// briefly (after a save, while loading). Grey = no room, green = saved,
// amber = unsaved changes, blue = loading or saving, red = a problem.
let chipProblem = null;  // what's wrong, for the tooltip (cleared by the next load or save)
function setChipProblem(text) { chipProblem = text; updateChip(); }
function updateChip() {
  $('world-name').textContent = current ? roomLabel(current) : untitled ? untitled.replace(/\.world$/i, '') : 'No room open';
  const [cls, tip] = !current && !untitled ? ['none', 'No room open']
    : chipProblem ? ['problem', chipProblem]
    : loading || saving ? ['busy', loading ? 'Loading…' : 'Saving…']
    : !current ? ['dirty', 'Not saved anywhere yet (Ctrl+S picks where)']
    : dirty ? ['dirty', 'Unsaved changes (Ctrl+S saves)']
    : ['', 'Saved'];
  document.querySelector('#world-chip .dot').className = 'dot' + (cls ? ' ' + cls : '');
  $('world-chip').dataset.tip = current ? `${roomFull(current)}: ${tip}` : tip;
  if (!progressTimer) $('world-state').textContent = '';
}
// Rooms in the Worlds folder are named by their path in it ("Room Areas/Bedroom");
// rooms anywhere else by their full path, shown short ("Downloads/Party").
const isFullPath = (p) => /^([A-Za-z]:\/|\/\/)/.test(p || '');
function roomLabel(p) {
  const name = p.replace(/\.world$/i, '');
  return isFullPath(name) ? name.split('/').slice(-2).join('/') : name;
}
function roomFull(p) { return isFullPath(p) ? p : p.replace(/\.world$/i, ''); }

// The room items only appear once a Worlds folder is picked in Settings → General.
$('menu-btn').onclick = (ev) => openPopup(ev.currentTarget, [
  { label: 'Settings', icon: 'settings', run: () => openSettings() },
  '-',
  ...(worldsReady() ? [
    { label: 'Load room…', icon: 'folder-open', run: loadRoom },
    { label: 'New room…', icon: 'file-plus', run: newWorld },
    { label: 'Save', icon: 'save', kbd: 'Ctrl+S', run: save, disabled: !world },
    { label: 'Save as…', icon: 'save-all', run: saveAs, disabled: !world },
    { label: 'Import a room into this one…', icon: 'import', run: importWorld, disabled: !world },
    '-',
    { label: 'Clear room', icon: 'eraser', danger: true, run: clearRoom, disabled: !world },
  ] : [
    { label: 'Pick your Worlds folder…', icon: 'folder-search', run: () => openSettings('general') },
  ]),
]);
// The Worlds folder feature (pick it once, Save as into it) is on in the
// developer's copy and comes later in the beta, which just uses Windows' windows.
const worldsFeature = () => setInfo?.worlds_feature !== false;
function worldsReady() { return !worldsFeature() || !!setInfo?.worlds_set; }
function needWorldsFolder() {
  log('Pick your Worlds folder first (Settings → General); then rooms can be loaded.', 'info');
  openSettings('general');
}
$('undo').onclick = undo;
$('redo').onclick = redo;
$('copy').onclick = copy;
$('paste').onclick = paste;
$('dup').onclick = duplicate;
$('del').onclick = del;
document.querySelectorAll('.tool').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
$('list-btn').onclick = () => toggleList();
$('space-btn').onclick = (ev) => openPopup(ev.currentTarget, [
  { label: 'Global: handles stay level', checked: space === 'world', run: () => setSpace('world') },
  { label: 'Local: handles turn with the object', checked: space === 'local', run: () => setSpace('local') },
]);
$('pivot-btn').onclick = (ev) => openPopup(ev.currentTarget, [
  { label: "Pivot: on the object's own position", checked: pivotMode === 'pivot', run: () => setPivotMode('pivot') },
  { label: 'Centre: in the middle of the selection', checked: pivotMode === 'center', run: () => setPivotMode('center') },
]);
$('focus').onclick = focus;
$('group').onclick = group;
$('ungroup').onclick = ungroup;
$('magnet-move').onclick = () => setMagnet('move', !moveOn);
$('magnet-turn').onclick = () => setMagnet('turn', !turnOn);
$('snap-btn').onclick = (ev) => openPopup(ev.currentTarget, snapMenu(SNAP_STEPS, stepSet, stepLabel, setSnapStep,
  async () => { const v = await askNumber('Snap step', 'Metres', stepSet, 100); if (v !== null) setSnapStep(v); }));
$('angle-btn').onclick = (ev) => openPopup(ev.currentTarget, snapMenu(SNAP_ANGLES, angleSet, angleLabel, setSnapAngle,
  async () => { const v = await askNumber('Snap angle', 'Degrees', angleSet, 360); if (v !== null) setSnapAngle(v); }));
$('help-btn').onclick = openHelp;
$('weather-btn').onclick = (ev) => { if (world) openWeatherPanel(ev.currentTarget); };

// corner stack: view controls
$('v3d').onclick = () => { topSaved = null; $('vtop').classList.remove('on'); frameBox(worldBounds()); };
$('vtop').onclick = () => setTopView(!topSaved);
const DETAIL_LABEL = { high: 'High', normal: 'Normal', low: 'Low' };
$('detail-btn').querySelector('span').textContent = DETAIL_LABEL[detailLevel];
$('detail-btn').onclick = (ev) => openPopup(ev.currentTarget, Object.keys(DETAIL).map((d) => ({
  label: DETAIL_LABEL[d] + (d === 'low' ? ' (fastest)' : d === 'high' ? ' (sharpest)' : ''), checked: d === detailLevel,
  run: () => { detailLevel = d; store('3dx-editor-detail', d); $('detail-btn').querySelector('span').textContent = DETAIL_LABEL[d]; assignDetail(); } })));
$('props-btn').onclick = () => { showProps = !showProps; $('props-btn').classList.toggle('on', showProps); applyToggles(); assignDetail(); };
$('glass-btn').onclick = () => { showGlass = !showGlass; $('glass-btn').classList.toggle('on', showGlass); applyToggles(); assignDetail(); };

// "Hide above": the slider runs from the lowest to the highest object in the room
let layerMin = 0, layerMax = 10;
function updateLayerRange() {
  if (!entries.length) return;
  let lo = Infinity, hi = -Infinity;
  for (const e of entries) { lo = Math.min(lo, e.y0); hi = Math.max(hi, e.y0); }
  layerMin = Math.floor(lo * 10) / 10; layerMax = Math.ceil(hi * 10) / 10 + 0.1;
  showLayer();
}
function showLayer() { $('layer-val').textContent = layerCut === null ? 'all' : layerCut.toFixed(1) + ' m'; }
$('layer').oninput = (ev) => {
  const v = Number(ev.target.value);
  layerCut = v >= 1000 ? null : round(layerMin + (layerMax - layerMin) * (v / 1000), 2);
  showLayer();
  assignDetail();
};

addEventListener('keyup', (ev) => {
  flyKeys.delete(ev.key.toLowerCase());
  flyKeys.shift = ev.shiftKey;
  flyKeys.alt = ev.altKey;
  if (ev.key === ' ') flyKeys.space = false;
});
addEventListener('blur', () => { flyKeys.clear(); flyKeys.shift = flyKeys.alt = flyKeys.space = false; });
addEventListener('keydown', (ev) => {
  const typing = ev.target.closest('input, select, textarea');
  const k = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && k === 's') { ev.preventDefault(); save(); return; }
  if (!modalEl.hidden) { if (k === 'escape') modalDone?.(null); return; }
  if (!setEl.hidden) { if (k === 'escape' && !typing) closeSettings(); return; }  // settings window open: no editor shortcuts
  if (typing) return;
  flyKeys.shift = ev.shiftKey;
  flyKeys.alt = ev.altKey;
  if (k === 'alt') { ev.preventDefault(); return; }  // Alt = speed up 2, not the browser's menu
  if (k === ' ') { ev.preventDefault(); flyKeys.space = true; return; }  // Space = slow down
  if (k in FLY && !ev.ctrlKey && !ev.metaKey) { flyKeys.add(k); return; }
  if (ev.ctrlKey || ev.metaKey) {
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && ev.shiftKey)) { ev.preventDefault(); redo(); }
    else if (k === 'd') { ev.preventDefault(); duplicate(); }
    else if (k === 'c') copy();
    else if (k === 'v') paste();
    else if (k === 'g') { ev.preventDefault(); ev.shiftKey ? ungroup() : group(); }
    return;
  }
  if (k === 'escape') {
    if (placing) stopPlacing();
    else if (!popupEl.hidden) closePopup();
    else if (mode === 'brush') setMode('translate');
    else setSelection([]);
  }
  else if (k === 'r' && placing) turnPlacing();
  else if (k === '1') setMode('translate');
  else if (k === '2') setMode('rotate');
  else if (k === '3') setMode('scale');
  else if (k === 'x') setSpace(space === 'local' ? 'world' : 'local');
  else if (k === 'f') focus();
  else if (k === 't') setTopView(!topSaved);
  else if (k === '4') setMode('resize');
  else if (k === '5') setMode('grab');
  else if (k === 'b') setMode(mode === 'brush' ? 'translate' : 'brush');
  else if (k === 'end') dropToFloor();
  else if (k === 'home') frameBox(worldBounds());
  else if (k === 'l') toggleList();
  else if (k === '?' || (k === '/' && ev.shiftKey)) openHelp();
  else if (k === 'delete' || k === 'backspace') del();
});

// ---------- Files: load, live reload, save, new, import ----------
let current = null;      // path of the open room ("Folder/Room.world" in Worlds, or a full path)
let untitled = null;     // file name of a dropped room that isn't saved anywhere yet
let currentMtime = null;
let loading = false;
let ignoredMtime = null; // a disk change the user chose to keep their edits over

async function fetchWorld(path) {
  const res = await fetch(HELPER + '/api/world?path=' + encodeURIComponent(path));
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  const mtime = res.headers.get('X-Mtime');
  const text = await res.text();
  return { world: JSON.parse(text.replace(/^﻿/, '')), mtime };
}

// A dropped file comes as { data, name }: the browser doesn't say where it is
// on disk, so it opens as "not saved anywhere yet" and Save asks where.
async function loadWorld(path, { reframe, quiet = false, data = null, name = null }) {
  loading = true;
  updateChip();
  stopPlacing();
  try {
    let got;
    if (data) got = { world: data, mtime: null };
    else try { got = await fetchWorld(path); }
    catch (err) {
      if (err instanceof SyntaxError) {
        // usually a file caught halfway through being saved; the next check retries
        log(`${path} changed but isn't readable yet (still saving?). Showing the last good version.`, 'err');
        return;
      }
      throw err;
    }
    if (!Array.isArray(got.world.objects)) got.world.objects = [];
    // fetch the game models this room uses before drawing it, so it doesn't flash grey boxes
    const names = got.world.objects.flatMap((o) => (isGroup(o) ? o.objects : [o])).map((o) => o.n);
    if (names.some((n) => !models.has(modelKey(n)))) progress('loading models…');
    await ensureModels(names);
    world = got.world;
    current = data ? null : path;
    untitled = data ? name : null;
    currentMtime = got.mtime;
    ignoredMtime = null;
    chipProblem = null;
    selection.clear(); hiddenObjs.clear(); lockedObjs.clear(); openGroups.clear();
    layerCut = null; $('layer').value = 1000;
    undoStack.length = 0;
    redoStack.length = 0;
    hideAlert();
    if (!data) store('3dx-editor-world', path);
    build();
    setDirty(!!data);
    if (reframe) frameBox(worldBounds());
    if (!quiet) log(data ? `Opened ${name}. It isn't saved anywhere yet: Ctrl+S picks where.` : `Opened ${roomFull(path)}.`, 'ok');
  } catch (err) {
    log('Could not open the room: ' + err.message, 'err');
  } finally {
    loading = false;
    updateChip();
  }
}

const alertEl = $('alert');
function hideAlert() { alertEl.hidden = true; alertEl.innerHTML = ''; }
function showConflict(mtime) {
  if (!alertEl.hidden) return;
  setChipProblem('Changed on disk while you have unsaved edits');
  alertEl.innerHTML = `${svg('bell')}<span>${esc(current)} changed on disk while you have unsaved edits.</span>`
    + `<button id="take-disk">Load the disk version</button><button id="keep-mine">Keep mine</button>`;
  alertEl.hidden = false;
  $('take-disk').onclick = () => loadWorld(current, { reframe: false });
  $('keep-mine').onclick = () => { ignoredMtime = mtime; hideAlert(); setChipProblem(null); log('Keeping your version. Saving will overwrite the disk version.', 'err'); };
}

async function watch() {
  if (!current || loading || saving) return;
  try {
    const res = await fetch(HELPER + '/api/mtime?path=' + encodeURIComponent(current));
    if (!res.ok) {
      if (chipProblem !== GONE) log(`${current} is gone from disk (renamed or deleted?). Save as to keep it.`, 'err');
      setChipProblem(GONE);
      return;
    }
    if (chipProblem === GONE || chipProblem === OFFLINE) setChipProblem(null);
    const { mtime } = await res.json();
    if (String(mtime) === String(currentMtime) || String(mtime) === String(ignoredMtime)) return;
    if (dirty) showConflict(mtime);
    else {
      const keep = new Set([...selection].map((o) => byObj.get(o)?.index));
      const cam = { pos: camera.position.clone(), target: controls.target.clone() };
      await loadWorld(current, { reframe: false, quiet: true });
      camera.position.copy(cam.pos); controls.target.copy(cam.target); controls.update();
      setSelection(entries.filter((e) => keep.has(e.index)).map((e) => e.o));
      log(`${current} was updated on disk; showing the new version.`, 'info');
    }
  } catch {
    if (chipProblem !== OFFLINE) log('Lost the connection to the editor server. Is its window still open?', 'err');
    setChipProblem(OFFLINE);
  }
}
const GONE = 'Gone from disk (renamed or deleted?): Save as to keep it';
const OFFLINE = 'Lost the connection to the editor server';
setInterval(watch, 800);

let saving = false;
async function writeWorld(path, create, data = world) {
  saving = true;  // our own save changes the file; don't mistake it for an outside change
  updateChip();
  try {
    const res = await fetch(HELPER + '/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, text: JSON.stringify(data), create }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    setTimeout(() => { saving = false; updateChip(); }, 0);
  }
}

async function save() {
  if (world && !current && untitled) { saveAs(); return; }  // a dropped room: ask where first
  if (!world || !current) return;
  const { status, body } = await writeWorld(current, false);
  if (status !== 200) { log('Save failed: ' + body.error, 'err'); setChipProblem('Save failed: ' + body.error); return; }
  currentMtime = String(body.mtime);
  ignoredMtime = null;
  hideAlert();
  chipProblem = null;
  setDirty(false);
  progress('saved', 2500);
  log(`Saved ${roomFull(current)}.`, 'ok');
}

// Windows' own file windows (opened by the editor server, so they can appear behind the browser)
async function pickOnPC(kind, start = '', name = '') {
  log(kind === 'folder' ? 'Pick the folder in the window that opened (it may be behind the browser).'
    : 'Pick the file in the window that opened (it may be behind the browser).', 'info');
  try {
    const res = await fetch(HELPER + '/api/settings/pick', { method: 'POST', body: JSON.stringify({ kind, start, name }) });
    const body = await res.json();
    if (!res.ok) { log(body.error || 'The file window could not open.', 'err'); return null; }
    return body.path;
  } catch { log('The editor server is out of date or not running: restart Start Editor.bat.', 'err'); return null; }
}
const folderOf = (p) => (isFullPath(p) ? p.slice(0, p.lastIndexOf('/')) : '');

async function saveAs() {
  if (!world) return;
  const base = current ? roomLabel(current).split('/').pop() + ' copy' : (untitled || 'New room').replace(/\.world$/i, '');
  // in the Worlds folder (name + folder), or anywhere on this PC (Windows' save window)
  let path = worldsFeature() && worldsReady() ? await askRoomName('Save as', current && !isFullPath(current) ? current.replace(/\.world$/i, '') + ' copy' : base, 'Save', true) : '*elsewhere';
  if (path === '*elsewhere') path = await pickOnPC('save', startFolder(), base + '.world');
  if (!path) return;
  const elsewhere = isFullPath(path);  // Windows' save window already asked about replacing
  let { status, body } = await writeWorld(path, !elsewhere);
  if (status === 409) {
    if (!await confirmBox('Replace?', `${path} already exists. Replace it?`, 'Replace', true)) return;
    ({ status, body } = await writeWorld(path, false));
  }
  if (status !== 200) { log('Save failed: ' + body.error, 'err'); setChipProblem('Save failed: ' + body.error); return; }
  current = body.path;
  untitled = null;
  currentMtime = String(body.mtime);
  store('3dx-editor-world', current);
  chipProblem = null;
  setDirty(false);
  progress('saved', 2500);
  await refreshWorldList();
  log(`Saved as ${roomFull(current)}.`, 'ok');
}

const DEFAULT_AMBIENT = [2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.8, 1.0, 1.0, 1.0, 1.0];
async function newWorld() {
  if (!worldsReady()) { needWorldsFolder(); return; }
  if (dirty && !await confirmBox('Unsaved changes', 'This room has unsaved changes. Discard them?', 'Discard', true)) return;
  let path = worldsFeature() ? await askRoomName('New room', 'Props/New prop', 'Create', true) : '*elsewhere';
  if (path === '*elsewhere') path = await pickOnPC('save', startFolder(), 'New room.world');
  if (!path) return;
  const fresh = {
    respawn: { p: [0, 1.05, -3], r: 0 },
    ambient: clone(world?.ambient) || DEFAULT_AMBIENT,
    oceanlevel: 0,
    weather: 'Day',
    valuetype: 'float',
    objects: [],
  };
  const { status, body } = await writeWorld(path, !isFullPath(path), fresh);  // Windows' save window asked about replacing
  if (status === 409) { log(`${path} already exists. Pick another name.`, 'err'); return; }
  if (status !== 200) { log('Could not create the room: ' + body.error, 'err'); return; }
  await refreshWorldList();
  await loadWorld(body.path, { reframe: true, quiet: true });
  controls.target.set(0, 1, 0);
  camera.position.set(4, 4, 6);
  controls.update();
  log(`New room ${roomFull(body.path)}. The sea is at height 0: build above it.`, 'ok');
}

// Load room: Windows' own file window, like 3DXChat's. It opens in the open
// room's folder, else the Worlds folder. (The in-app room list, roomPicker, is
// kept for later; the beta uses the file window.)
function startFolder() {
  if (isFullPath(current)) return folderOf(current);
  const root = (setInfo?.worlds || '').replace(/\\/g, '/');
  const sub = current && current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
  return root ? (sub ? `${root}/${sub}` : root) : '';
}
async function loadRoom() {
  if (!worldsReady()) { needWorldsFolder(); return; }
  if (dirty && !await confirmBox('Unsaved changes', 'This room has unsaved changes. Discard them?', 'Discard', true)) return;
  const path = await pickOnPC('file', startFolder());
  if (!path || path === current) return;
  loadWorld(path, { reframe: true });
}

async function importWorld() {
  if (!world) return;
  const choice = await pickOnPC('file', startFolder());  // Windows' file window, like Load room
  if (!choice) return;
  if (choice === current) { log('That is the room that is open. Pick another one to import.', 'err'); return; }
  try {
    const { world: other } = await fetchWorld(choice);
    await importObjects(other, roomFull(choice));
  } catch (err) {
    log('Import failed: ' + err.message, 'err');
  }
}
// another room's objects into this one, as one group at their own spots
async function importObjects(other, label) {
  const leaves = (other.objects || []).flatMap(leavesOf);
  if (!leaves.length) { log(`${label} has no objects.`, 'err'); return; }
  await ensureModels(leaves.map((o) => o.n));
  const g = { n: 'group', objects: leaves };
  structure([{ arr: world.objects, index: world.objects.length, count: 0, insert: [g] }], leaves);
  setMode('translate');
  frameBox(selectionBox());
  log(`Imported ${leaves.length.toLocaleString()} objects from ${label}. Save to keep them.`, 'ok');
}

// Drag a .world file onto the editor: open it, or import it into the open room.
addEventListener('dragover', (ev) => { if ([...ev.dataTransfer.types].includes('Files')) ev.preventDefault(); });
addEventListener('drop', async (ev) => {
  const file = [...(ev.dataTransfer?.files || [])][0];
  if (!file) return;
  ev.preventDefault();
  if (!/\.world$/i.test(file.name)) { log(`${file.name} isn't a room file (.world).`, 'err'); return; }
  let data;
  try {
    data = JSON.parse((await file.text()).replace(/^﻿/, ''));
    if (!data || !Array.isArray(data.objects)) throw new Error('no objects list');
  } catch (err) { log(`${file.name} couldn't be read as a room (${err.message}).`, 'err'); return; }
  let how = 'open';
  if (world) {
    how = await openModal(`<h3>${esc(file.name)}</h3>
      <div class="note" style="margin-top:0">${data.objects.length.toLocaleString()} entries. Open it on its own, or bring its objects into ${esc(current ? roomLabel(current) : 'this room')}?</div>
      <div class="foot"><button class="act" data-x="no">Cancel</button><button class="act" data-x="import">Import into this room</button><button class="act primary" data-x="open">Open it</button></div>`,
    (done) => { modalEl.onclick = (e) => { const x = e.target.closest('[data-x]')?.dataset.x; if (x) done(x === 'no' ? null : x); }; });
    if (!how) return;
  }
  if (how === 'import') { await importObjects(data, file.name); return; }
  if (dirty && !await confirmBox('Unsaved changes', 'This room has unsaved changes. Discard them?', 'Discard', true)) return;
  loadWorld(null, { reframe: true, data, name: file.name });
});
addEventListener('beforeunload', (ev) => { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } });

async function refreshWorldList() {
  try {
    const { worlds } = await (await fetch(HELPER + '/api/worlds')).json();
    worldList = worlds;
  } catch {
    log('Could not reach the editor server. Start it with "Start Editor.bat".', 'err');
  }
}

async function loadCatalog() {
  try {
    const { names, materials } = await (await fetch(HELPER + '/api/catalog')).json();
    // names used in your rooms first, then every other object the game has
    const seen = new Set(names.map(modelKey));
    const more = Object.values(cacheIndex.models).map((m) => m.name).filter((n) => n && !seen.has(modelKey(n))).sort();
    $('names').innerHTML = [...names, ...more].map((n) => `<option value="${esc(n)}">`).join('');
    const lower = new Set(materials.map((m) => m.toLowerCase()));
    const mmore = Object.values(cacheIndex.materials).map((m) => m.name).filter((m) => m && !lower.has(m.toLowerCase())).sort();
    $('materials').innerHTML = [...materials, ...mmore].map((m) => `<option value="${esc(m)}">`).join('');
  } catch { /* lists are a convenience only */ }
}

// ---------- Test hook ----------
// Lets Claude's test scripts read the editor's state and find things on screen.
window.__editor = {
  get world() { return world; }, get selection() { return [...selection]; }, get mode() { return mode; },
  get topOn() { return !!topSaved; }, get camera() { return camera.position.toArray(); },
  find: (name) => entries.filter((e) => e.o.n === name).map((e) => e.o),
  select: (objs) => setSelection(objs), editObjects, dropToFloor, alignUnits, setMode,
  screenOf(v3) {  // three.js world point → page pixels
    const p = new THREE.Vector3(...v3).project(camera), r = renderer.domElement.getBoundingClientRect();
    return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
  },
  centreOf(o) { const e = byObj.get(o); return boxOf(e).getCenter(new THREE.Vector3()).toArray(); },
  boxOf(o) { const b = boxOf(byObj.get(o)); return [b.min.toArray(), b.max.toArray()]; },
  handles: () => resizeHandles.map((h) => ({ ...h.userData, at: h.position.toArray() })),
  frame: (objs) => frameBox(unitBox(objs)),
  setLight(env, sunK) { lightOverride = [env, sunK]; currentSky = null; applyWeather(world.weather); applyEnvIntensity(); return [K_ENV, K_SUN]; },
  setFov(v) { camera.fov = v; camera.updateProjectionMatrix(); return v; },
  setEnvSat(v) { ENV_SAT = v; envSkyMaterial.uniforms.sat.value = v; bakeEnvironment(); return v; },
  setLamp(k, range, decay) { K_LAMP = k; LAMP_RANGE = range; LAMP_DECAY = decay; assignLamps(); return [k, range, decay]; },
  toneMap(on) { renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping; skyMaterial.needsUpdate = true; worldGroup.traverse((m) => { if (m.isMesh) [].concat(m.material).forEach((x) => { x.needsUpdate = true; }); }); return on; },
  resetLight() { lightOverride = null; currentSky = null; applyWeather(world.weather); applyEnvIntensity(); return world.weather; },
  hideMarkers() { if (respawnMarker) respawnMarker.visible = false; grid.visible = false; return true; },
  // sun from a compass bearing (0 = north, 90 = east) and height above the horizon, in degrees
  setSun(bearing, height) {
    const b = bearing * D2R, h = height * D2R;
    sunDir.set(Math.sin(b) * Math.cos(h), Math.sin(h), -Math.cos(b) * Math.cos(h));  // game z (north) = three -z
    placeSun();
    return sunDir.toArray().map((v) => +v.toFixed(3));
  },
  get sunNow() {  // current sun as [bearing, height]
    const d = sunDir;
    return [+(((Math.atan2(d.x, -d.z) / D2R) + 360) % 360).toFixed(1), +(Math.asin(d.y) / D2R).toFixed(1)];
  },
  // camera at a game position, looking at another (game coordinates)
  look(from, to) {
    camera.position.set(from[0], from[1], -from[2]);
    controls.target.set(to[0], to[1], -to[2]);
    controls.update();
    assignDetail();
  },
};

// ---------- Pictures for the AI (MCP "look" tool) ----------
// The editor server holds a request open for this page; when the AI asks to
// look, the page opens that room if needed, takes the picture from the camera
// asked for, sends it back and puts your camera back where it was.
// Coordinates in requests are the game's (z = north); three.js has z flipped.
const gameV = (v) => new THREE.Vector3(v[0], v[1], -v[2]);
const toGame = (v) => [v.x, v.y, -v.z].map((n) => +n.toFixed(2));
function compass(bearing) { const b = bearing * D2R; return new THREE.Vector3(Math.sin(b), 0, -Math.cos(b)); }
const SIDES = { north: 0, 'north-east': 45, east: 90, 'south-east': 135, south: 180, 'south-west': 225, west: 270, 'north-west': 315 };

function lookTargets(ids) {  // "12" = loose object or whole group, "5.3" = object 3 of group 5
  const out = [];
  for (const id of ids) {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(String(id).trim());
    const top = m && world.objects[+m[1]];
    if (!top) throw new Error(`No object ${id} in the editor's copy of the room.`);
    if (m[2] !== undefined) {
      const c = isGroup(top) ? top.objects[+m[2]] : null;
      if (!c) throw new Error(`No object ${id} in the editor's copy of the room.`);
      out.push(c);
    } else out.push(...(isGroup(top) ? top.objects : [top]));
  }
  return out;
}

// camera somewhere on a line from the box's centre, far enough back that the whole box fits
function fitCamera(box, bearing, height) {
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
  const vfov = camera.fov * D2R, hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const d = r / Math.sin(Math.min(vfov, hfov) / 2);
  const h = height * D2R;
  const dir = compass(bearing).multiplyScalar(Math.cos(h));
  dir.y = Math.sin(h);
  camera.position.copy(c).addScaledVector(dir, d);
  controls.target.copy(c);
}

async function takeLook(req) {
  const notes = [];
  if (!world || req.room !== current) {
    if (dirty) throw new Error(`The editor has unsaved changes in ${current}. Ask the user to save (or discard) them before you look at another room.`);
    await loadWorld(req.room, { reframe: true, quiet: true });
    if (current !== req.room) throw new Error(`The editor couldn't open ${req.room}.`);
    log(`Claude opened ${current} to look at it.`, 'info');
  } else {
    // the AI has usually just changed the file; don't wait for the 0.8 s check
    const { mtime } = await (await fetch(HELPER + '/api/mtime?path=' + encodeURIComponent(current))).json();
    if (String(mtime) !== String(currentMtime)) {
      if (dirty) notes.push('The user has unsaved edits in the editor, so this picture shows their version, not the file on disk. Ids may not match.');
      else {
        const cam = { pos: camera.position.clone(), target: controls.target.clone() };
        await loadWorld(current, { reframe: false, quiet: true });
        camera.position.copy(cam.pos); controls.target.copy(cam.target); controls.update();
      }
    }
  }
  await texturesLoaded();

  const w = Math.round(Math.min(Math.max(req.width || 1024, 256), 1600));
  const h = Math.round(Math.min(Math.max(req.height || 640, 256), 1200));
  const saved = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov,
    size: renderer.getSize(new THREE.Vector2()), ratio: renderer.getPixelRatio(), detail: detailLevel,
    cut: layerCut, hidden: [...hiddenObjs], props: showProps, glass: showGlass };
  const helpers = [gizmo, selBox, partBoxes, grid, placing?.ghost, ...resizeHandles].filter(Boolean);
  const shown = helpers.map((x) => x.visible);
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = req.fov || 50;
    camera.updateProjectionMatrix();
    // everything in the room, unless the AI asked to cut off the top
    hiddenObjs.clear();
    layerCut = req.hide_above ?? null;
    if (!showProps || !showGlass) { showProps = showGlass = true; applyToggles(); }

    const all = new THREE.Box3();
    for (const e of entries) all.union(boxOf(e));
    if (respawnMarker) all.expandByPoint(respawnMarker.position);
    const side = SIDES[req.side] ?? 135;
    let what;
    if (req.view === 'top') {
      if (all.isEmpty()) throw new Error('The room is empty.');
      fitCamera(all, 180, 89.9);
      what = 'straight down, north at the top';
    } else if (req.view === 'spawn') {
      const sp = world.respawn;
      if (!sp?.p) throw new Error('The room has no spawn point.');
      const eye = gameV(sp.p).add(new THREE.Vector3(0, 1.7, 0));
      camera.position.copy(eye);
      controls.target.copy(eye).add(compass(Number(sp.r) || 0)).add(new THREE.Vector3(0, -0.12, 0));
      what = `from the spawn point at eye height, facing ${Number(sp.r) || 0}°`;
    } else if (req.view === 'objects') {
      const objs = lookTargets(req.ids || []);
      const box = new THREE.Box3();
      for (const o of objs) box.union(boxOf(byObj.get(o)));
      fitCamera(box.clone().expandByScalar(0.3), side, 30);
      // Leave out whatever stands between the camera and them: walls, yes, but
      // not smaller things touching them (the bed on a floor, chairs at a table).
      const keep = new Set(objs), c = box.getCenter(new THREE.Vector3());
      const ray = new THREE.Ray(camera.position.clone(), c.clone().sub(camera.position).normalize());
      const reach = camera.position.distanceTo(c), hit = new THREE.Vector3(), v = new THREE.Vector3();
      const big = box.getSize(v).length();
      let cut = 0;
      for (const e of entries) {
        if (keep.has(e.o)) continue;
        const b = boxOf(e);
        if (!ray.intersectBox(b, hit) || hit.distanceTo(camera.position) >= reach) continue;
        if (b.intersectsBox(box) && b.getSize(v).length() <= big * 1.5) continue;
        hiddenObjs.add(e.o); cut++;
      }
      if (cut) notes.push(`${cut} object(s) between the camera and them are left out of this picture.`);
      what = `${objs.length} object(s) from the ${req.side || 'south-east'}`;
    } else if (req.view === 'camera') {
      if (!req.from || !req.at) throw new Error('The camera view needs "from" and "at" (game coordinates).');
      camera.position.copy(gameV(req.from));
      controls.target.copy(gameV(req.at));
      what = 'from the given point';
    } else {
      if (all.isEmpty()) throw new Error('The room is empty.');
      fitCamera(all, side, 35);
      what = `the whole room from the ${req.side || 'south-east'}, looking down`;
    }
    controls.update();
    camera.updateMatrixWorld();
    detailLevel = 'high';
    assignDetail();
    assignLamps();
    placeSun();
    if (skyMesh.visible) skyMesh.position.copy(camera.position);
    for (const x of helpers) x.visible = false;
    renderer.render(scene, camera);
    // read the picture now, before the browser clears the canvas
    const image = renderer.domElement.toDataURL('image/jpeg', 0.85).split(',')[1];
    if (entries.some((e) => /^light(p|90)/i.test(e.o.n))) notes.push('LightP/Light90 icons (sun-like markers) only show in the editor; in the game they are invisible light sources.');
    if (saved.hidden.length) notes.push(`${saved.hidden.length} object(s) the user hid in the editor are shown here.`);
    if (layerCut !== null) notes.push(`Objects starting above y = ${layerCut} are left out.`);
    log(`Claude looked at ${current} (${req.view || 'overview'}).`, 'info');
    return { image, room: current, view: what, camera: toGame(camera.position), looking_at: toGame(controls.target), notes };
  } finally {
    for (const [i, x] of helpers.entries()) x.visible = shown[i];
    hiddenObjs.clear(); for (const o of saved.hidden) hiddenObjs.add(o);
    layerCut = saved.cut; detailLevel = saved.detail;
    if (showProps !== saved.props || showGlass !== saved.glass) { showProps = saved.props; showGlass = saved.glass; applyToggles(); }
    renderer.setPixelRatio(saved.ratio);
    camera.fov = saved.fov;
    resize();
    camera.position.copy(saved.pos); controls.target.copy(saved.target); controls.update();
    assignDetail(); assignLamps();
  }
}

// three.js loads textures in the background; wait (up to 8 s) until none are still on their way
let texturesPending = 0;
THREE.DefaultLoadingManager.onStart = () => { texturesPending++; };
THREE.DefaultLoadingManager.onLoad = () => { texturesPending = 0; };
async function texturesLoaded() {
  const end = performance.now() + 8000;
  while (texturesPending && performance.now() < end) await new Promise((r) => setTimeout(r, 100));
}

async function lookLoop() {
  for (;;) {
    let req = null;
    try {
      req = await (await fetch(HELPER + '/api/look/next')).json();
    } catch {
      await new Promise((r) => setTimeout(r, 3000));  // server gone; the log already says so
      continue;
    }
    if (!req?.id) continue;
    try {  // another tab (or a leftover wait from before a reload) may have it already
      const { ok } = await (await fetch(HELPER + '/api/look/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: req.id }) })).json();
      if (!ok) continue;
    } catch { continue; }
    let answer;
    try { answer = { id: req.id, ...(await takeLook(req)) }; }
    catch (err) { answer = { id: req.id, error: err.message }; }
    try {
      await fetch(HELPER + '/api/look/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answer) });
    } catch { /* the AI's side times out and says so */ }
  }
}

// ---------- AI button (top right) ----------
// What AI assistants did through the MCP server (reported to the editor
// server). The dot: grey = nothing yet, green = active in the last 5 minutes,
// pulsing = working right now.
let aiState = { now: 0, app: null, busy: false, items: [] };
const AI_RECENT = 300;
function ago(s) {
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
function aiDotClass() {
  const last = aiState.items.at(-1);
  return 'aidot' + (aiState.busy ? ' busy' : last && aiState.now - last.t < AI_RECENT ? ' live' : '');
}
async function pollAI() {
  if (setInfo && !aiAvailable()) { $('ai-btn').dataset.tip = 'AI assistant (coming in a later version)'; return; }
  try { aiState = await (await fetch(HELPER + '/api/ai/activity')).json(); } catch { return; }
  $('ai-dot').className = aiDotClass();
  const who = aiState.app || 'An AI';
  $('ai-btn').dataset.tip = aiState.busy ? `${who} is working` : aiState.items.length ? `AI assistant · ${who}` : 'AI assistant';
  if (popupFor === $('ai-btn') && !popupEl.hidden) renderAIPanel();
}
function renderAIPanel() {
  if (!aiAvailable()) {  // the beta: the button is there, the connection comes later
    popupEl.innerHTML = `<div class="aihead"><span class="aidot"></span><span>AI connections come in a later version</span></div>`
      + '<div class="ainote">This beta is for testing the editor itself. AI building returns, refined, after the first round of bug fixes.</div>'
      + `<div class="msep"></div><button class="mi" data-x="connect">${svg('info')}What it will do…</button>`;
    return;
  }
  const { now, app, busy, items } = aiState;
  const last = items.at(-1);
  const who = app || 'An AI';
  const status = busy ? `${who} is working…`
    : last ? `${who} · last action ${ago(now - last.t)}` : 'No AI has used the editor yet.';
  popupEl.innerHTML = `<div class="aihead"><span class="${aiDotClass()}"></span><span>${esc(status)}</span></div>`
    + (items.length
      ? '<div class="ailist">' + items.slice(-8).reverse().map((it) => `<button class="aiitem${it.ok ? '' : ' bad'}" data-room="${esc(it.room || '')}"`
        + ` ${it.room ? `data-tip="Open ${esc(it.room)}"` : 'disabled'}><span>${esc(it.text)}</span><small>${ago(now - it.t)}</small></button>`).join('') + '</div>'
      : '<div class="ainote">Connect an AI app and ask it to build something. What it does shows up here.</div>')
    + `<div class="msep"></div><button class="mi" data-x="connect">${svg('plug')}Connect to AI…</button>`;
}
function roomPath(room) {  // "Room Areas/Bedroom" (or just "Bedroom") → its .world path
  const r = room.toLowerCase().replace(/\.world$/, '');
  const hits = worldList.filter((w) => {
    const p = w.path.toLowerCase().replace(/\.world$/, '');
    return p === r || p.split('/').pop() === r.split('/').pop();
  });
  return hits.find((w) => w.path.toLowerCase().replace(/\.world$/, '') === r)?.path || (hits.length === 1 ? hits[0].path : null);
}
function openAIPanel(anchor) {
  if (popupFor === anchor && !popupEl.hidden) { closePopup(); return; }
  popupFor = anchor;
  popupEl.className = 'panel ai';
  renderAIPanel();
  popupEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  popupEl.style.left = Math.max(8, Math.min(r.left, innerWidth - popupEl.offsetWidth - 8)) + 'px';
  popupEl.style.top = (r.bottom + 6) + 'px';
  popupEl.onkeydown = popupEl.onchange = null;
  popupEl.onclick = async (ev) => {
    if (ev.target.closest('[data-x="connect"]')) {
      openSettings('ai');
      return;
    }
    const item = ev.target.closest('.aiitem');
    if (!item?.dataset.room) return;
    closePopup();
    await refreshWorldList();
    const path = roomPath(item.dataset.room);
    if (!path) { log(`Couldn't find ${item.dataset.room} in the Worlds folder.`, 'err'); return; }
    if (path === current) return;
    if (dirty && !await confirmBox('Unsaved changes', 'This room has unsaved changes. Discard them?', 'Discard', true)) return;
    loadWorld(path, { reframe: true });
  };
}
$('ai-btn').onclick = (ev) => openAIPanel(ev.currentTarget);

// ---------- Start ----------
hydrateIcons();
gizmo.setSize(settings.handleSize);
applyShadows();
applyCamera();
applyTooltips();
applyViewExtras();
applySnap();
setSpace(space);
setPivotMode(pivotMode);
setMode('translate');
applyCorner();
setDirty(false);
if (HOSTED) {
  const hello = await waitForHelper();
  if (hello.version !== PAGE_VERSION) log(`Your helper is version ${hello.version || 'unknown'}, the editor is ${PAGE_VERSION}. Download the new helper from GitHub if things misbehave.`, 'err');
}
await loadCacheIndex();
buildLibrary();
renderDock();
if (!Object.keys(cacheIndex.models).length) log('No game models found: showing stand-in shapes. Run extract_models.py to add them.', 'err');
if (settings.listOpen) toggleList(true);
loadCatalog();
await refreshWorldList();
setInterval(refreshWorldList, 10000);
lookLoop();
pollAI();
setInterval(pollAI, 2000);
const last = recall('3dx-editor-world');
// the last room, also when it lives outside the Worlds folder (if it's still there)
const lastOutside = isFullPath(last) && await fetch(HELPER + '/api/mtime?path=' + encodeURIComponent(last)).then((r) => r.ok).catch(() => false);
const firstPath = lastOutside || worldList.some((w) => w.path === last) ? last : worldList[0]?.path;
await loadSetInfo();
if (!worldsFeature()) {
  // the beta: no folder to pick; reopen the last room if it's still there
  const lastThere = last && await fetch(HELPER + '/api/mtime?path=' + encodeURIComponent(last)).then((r) => r.ok).catch(() => false);
  if (settings.openLast && lastThere) loadWorld(last, { reframe: true });
  else if (!settings.openLast) loadRoom();
  else log('Welcome! Open a room with ☰ → Load room, make one with ☰ → New room, or drag a .world file here.', 'info');
} else if (!worldsReady()) {  // first run (or the folder is gone): pick the Worlds folder before any room
  log('Welcome! Pick your Worlds folder to start (Settings → General).', 'info');
  openSettings('general');
} else if (!worldList.length) log('No rooms found in the Worlds folder. Use ☰ → New room.', 'info');
else if (settings.openLast && firstPath) loadWorld(firstPath, { reframe: true });
else loadRoom();  // Settings → General: start with the room list
