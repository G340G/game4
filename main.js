/* main.js
   GLITCH CITY: SECTOR 0 — POCKET CORRIDORS
   - Stable pointer lock controls (no mouse drift)
   - Correct WASD (S = backward)
   - High-FPS collision (grid-based, no per-frame Box3 allocations)
   - PS2 texture vibe: nearest filtering + downscale render pass + jitter + scanlines
   - AudioWorklet ominous bed + breathing, plus real-time browser TTS (SpeechSynthesis)
   - Procedural city surface + “pocket corridors” interior generator (rooms, doors, keys)
   - Sanity-based lighting + minimap hallucinations + glitch overlays
   - Uses user images in assets/ : back.png, back2.png, fiend.png, npc.png, npc3.png, object1.png, image.png, image2.png
*/

import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";

/* =====================================================================================
   0) SAFETY: avoid "Uncaught (in promise) Event" by catching all async
===================================================================================== */

window.addEventListener("unhandledrejection", (ev) => {
  console.warn("[unhandledrejection]", ev.reason);
  // prevent noisy "Event" dumps in console
  ev.preventDefault();
});

/* =====================================================================================
   1) CONFIG
===================================================================================== */

const CFG = {
  // Rendering
  fov: 74,
  near: 0.08,
  far: 180,
  pixelScale: 2,           // PS2-ish low-res: render at (w/pixelScale, h/pixelScale)
  maxFPSCap: 0,            // set > 0 to cap FPS (e.g., 90). 0 = no cap.
  useDynamicResolution: true, // auto adjust pixelScale when FPS drops hard
  dynamicResMin: 1.6,
  dynamicResMax: 3.4,

  // Player
  playerHeight: 1.72,
  playerRadius: 0.38,
  walkSpeed: 4.2,
  runSpeed: 6.8,
  jumpVel: 5.8,
  gravity: 15.5,
  friction: 12.0,
  airControl: 0.22,
  maxSlope: 0.9, // not used heavily; placeholder if you extend.

  // World: Surface City
  citySize: 48,      // grid cells
  cell: 3.2,         // world units per cell
  surfaceWallHeight: 6.0,
  surfaceWallThickness: 0.35,
  propDensity: 0.35,
  treeChance: 0.26,
  deadTreeChance: 0.12,
  tvChance: 0.10,
  bedChance: 0.10,
  nailsChance: 0.12,
  posterChance: 0.14,
  doorChance: 0.08,

  // Pocket Corridors: procedural interior
  pocket: {
    // This creates interior “chunks” in a separate area; you transition via door.
    roomCount: 12,
    roomMin: 5,
    roomMax: 11,
    corridorWidth: 2,
    wallH: 3.2,
    areaSize: 80,     // interior grid size
    cell: 1.6,
    doorLockChance: 0.42,
    keyCount: 4,
    exitChance: 0.12
  },

  // Enemies
  enemyCountSurface: 7,
  enemyCountPocket: 8,
  enemyViewDist: 24,
  enemyAttackDist: 1.5,
  enemyDamageHP: 14,
  enemyDamageSAN: 9,
  enemySpeedMin: 1.35,
  enemySpeedMax: 2.6,

  // Sanity system
  sanityDecayPerSec: 0.85,
  sanityCreepyNoteHit: [6, 18],     // range
  sanityPosterHit: [2, 10],
  sanityLookThreshold: 0.65,        // dot product threshold for “looking at”
  sanityLowDarknessBoost: 0.85,

  // Items / weapons
  itemCountSurface: 18,
  itemCountPocket: 14,
  weaponStartAmmo: 0.55,  // “charge” bar 0..1
  weaponChargePerPickup: 0.25,
  weaponDrainPerShot: 0.18,
  cursedBoost: 0.22,      // cursed items temporarily help but later hit sanity

  // UI glitching
  minimapLieStart: 70,  // sanity below this starts lying
  minimapLieMax: 18,    // max “fake blips”
  glitchJitterStart: 55,
  glitchHardStart: 28,

  // Rain
  rainCount: 1600,
  rainArea: 170,
  rainHeight: 70,

  // Assets
  assetsPath: "./assets/",
  images: {
    back: "back.png",
    back2: "back2.png",
    fiend: "fiend.png",
    npc: "npc.png",
    npc3: "npc3.png",
    object1: "object1.png",
    image1: "image.png",
    image2: "image2.png"
  }
};

const UI = {
  start: document.getElementById("start"),
  death: document.getElementById("death"),
  pause: document.getElementById("pause"),
  note: document.getElementById("note"),

  startBtn: document.getElementById("startBtn"),
  howBtn: document.getElementById("howBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  restartBtn: document.getElementById("restartBtn"),
  respawnBtn: document.getElementById("respawnBtn"),

  nameInput: document.getElementById("nameInput"),

  crosshair: document.getElementById("crosshair"),
  interaction: document.getElementById("interaction"),

  hpFill: document.getElementById("hp"),
  sanFill: document.getElementById("san"),
  ammoFill: document.getElementById("ammo"),
  quest: document.getElementById("quest"),

  noteTitle: document.getElementById("noteTitle"),
  noteBody: document.getElementById("noteBody"),
  noteClose: document.getElementById("noteClose"),

  deathReason: document.getElementById("deathReason"),

  minimap: document.getElementById("minimap"),
};

const mapCtx = UI.minimap.getContext("2d");

/* =====================================================================================
   2) GAME STATE
===================================================================================== */

const STATE = {
  playing: false,
  paused: false,

  // player
  name: "DEFER",
  hp: 100,
  sanity: 100,
  ammo: CFG.weaponStartAmmo,     // 0..1 “charge”
  weaponIndex: 0,                // 0 = pulse tool, 1 = flare tool
  quickItem: null,               // e.g., medkit, cursed candy
  hasKey: false,                 // generic surface key
  keys: 0,                       // pocket keys collected
  inPocket: false,               // currently in pocket corridor area?

  // objectives
  objective: "FIND A KEY • ENTER A POCKET CORRIDOR • REACH THE EXIT",
  exitUnlocked: false,

  // glitching
  glitch: 0,   // computed from sanity
  time: 0,
  lastSpeakAt: -9999,

  // performance stats
  fps: 60,
  fpsSmoothed: 60,
  dynResScale: CFG.pixelScale,

  // interaction
  currentInteract: null,

  // triggers
  readNotes: 0,
  sawPosters: 0,
};

/* =====================================================================================
   3) THREE SETUP + PS2 PASS (low-res render target + nearest upscaling)
===================================================================================== */

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07070b);
scene.fog = new THREE.FogExp2(0x07070b, 0.028);

const camera = new THREE.PerspectiveCamera(CFG.fov, window.innerWidth / window.innerHeight, CFG.near, CFG.far);
camera.position.set(2, CFG.playerHeight, 2);

const renderer = new THREE.WebGLRenderer({
  antialias: false,             // PS2 vibe, also faster
  powerPreference: "high-performance",
  alpha: false,
  stencil: false,
  depth: true
});
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

// Offscreen render target for low-res upscaling
let rt = null;
let ps2Scene = null;
let ps2Cam = null;
let ps2Mat = null;
let ps2Mesh = null;

function makePS2Pass() {
  const w = Math.max(2, Math.floor(window.innerWidth / STATE.dynResScale));
  const h = Math.max(2, Math.floor(window.innerHeight / STATE.dynResScale));

  if (rt) rt.dispose();
  rt = new THREE.WebGLRenderTarget(w, h, {
    depthBuffer: true,
    stencilBuffer: false
  });
  rt.texture.generateMipmaps = false;
  rt.texture.minFilter = THREE.NearestFilter;
  rt.texture.magFilter = THREE.NearestFilter;

  // Fullscreen quad scene
  ps2Scene = new THREE.Scene();
  ps2Cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  ps2Mat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: rt.texture },
      time: { value: 0 },
      glitch: { value: 0 },
      vignette: { value: 0.55 },
      scan: { value: 0.16 },
      chroma: { value: 0.35 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform float time;
      uniform float glitch;
      uniform float vignette;
      uniform float scan;
      uniform float chroma;

      float hash(vec2 p){
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main(){
        vec2 uv = vUv;

        // scanlines
        float s = sin((uv.y * 800.0) + time * 18.0) * 0.5 + 0.5;
        float scanline = mix(1.0, 0.86, s * scan);

        // subtle jitter / tear when glitching
        float g = glitch;
        float j = (hash(vec2(time, uv.y)) - 0.5) * 0.008 * g;
        uv.x += j;

        // mild vertical wobble
        uv.y += (sin(time * 1.7 + uv.x * 9.0) * 0.002) * g;

        // chromatic offset (PS2 cheap composite)
        float c = chroma * (0.002 + 0.008 * g);
        vec4 r = texture2D(tDiffuse, uv + vec2(c, 0.0));
        vec4 gch = texture2D(tDiffuse, uv);
        vec4 b = texture2D(tDiffuse, uv - vec2(c, 0.0));
        vec3 col = vec3(r.r, gch.g, b.b);

        // mild posterize
        float steps = mix(64.0, 22.0, clamp(g, 0.0, 1.0));
        col = floor(col * steps) / steps;

        // vignette
        vec2 d = uv - 0.5;
        float v = 1.0 - dot(d, d) * vignette;
        v = clamp(v, 0.08, 1.0);

        // occasional blocky corruption
        float blk = step(0.985, hash(floor(uv * vec2(22.0, 18.0)) + time));
        col = mix(col, col.bgr * 1.15, blk * g * 0.85);

        col *= scanline * v;

        gl_FragColor = vec4(col, 1.0);
      }
    `
  });

  ps2Mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ps2Mat);
  ps2Scene.add(ps2Mesh);
}
makePS2Pass();

/* =====================================================================================
   4) CONTROLS (PointerLock) — stable pitch clamp, correct WASD
===================================================================================== */

const controls = new PointerLockControls(camera, document.body);

const INPUT = {
  forward: false,
  back: false,
  left: false,
  right: false,
  run: false,
  jump: false,
  interact: false,
  quick: false,
  fire: false,
  fire2: false
};

let pitch = 0;   // vertical look (radians)
let yaw = 0;     // horizontal look (radians)
const pitchLimit = Math.PI / 2 - 0.05;
let mouseActive = false;

function setMouseEnabled(on) {
  mouseActive = on;
  if (on) {
    document.body.requestPointerLock?.();
  } else {
    document.exitPointerLock?.();
  }
}

document.addEventListener("pointerlockchange", () => {
  const locked = (document.pointerLockElement === document.body);
  if (!locked && STATE.playing && !STATE.paused && UI.note.style.display !== "flex") {
    // If user broke pointer lock accidentally, show pause so they can resume cleanly.
    pauseGame(true);
  }
});

document.addEventListener("mousemove", (e) => {
  if (!STATE.playing || STATE.paused) return;
  if (document.pointerLockElement !== document.body) return;

  // stable mouse: manual yaw/pitch rather than using controls built-in rotation
  const sens = 0.0022;
  yaw -= e.movementX * sens;
  pitch -= e.movementY * sens;

  // clamp pitch to prevent drifting down/up
  if (pitch > pitchLimit) pitch = pitchLimit;
  if (pitch < -pitchLimit) pitch = -pitchLimit;

  camera.rotation.set(pitch, yaw, 0, "YXZ");
});

// Keyboard
document.addEventListener("keydown", (e) => {
  if (e.code === "Escape") {
    if (STATE.playing) pauseGame(!STATE.paused);
    return;
  }
  if (!STATE.playing || STATE.paused) return;

  switch (e.code) {
    case "KeyW": INPUT.forward = true; break;
    case "KeyS": INPUT.back = true; break;
    case "KeyA": INPUT.left = true; break;
    case "KeyD": INPUT.right = true; break;
    case "ShiftLeft":
    case "ShiftRight": INPUT.run = true; break;
    case "Space": INPUT.jump = true; break;
    case "KeyE": INPUT.interact = true; break;
    case "KeyQ": INPUT.quick = true; break;
    case "Digit1": STATE.weaponIndex = 0; break;
    case "Digit2": STATE.weaponIndex = 1; break;
  }
});

document.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW": INPUT.forward = false; break;
    case "KeyS": INPUT.back = false; break;
    case "KeyA": INPUT.left = false; break;
    case "KeyD": INPUT.right = false; break;
    case "ShiftLeft":
    case "ShiftRight": INPUT.run = false; break;
    case "Space": INPUT.jump = false; break;
    case "KeyE": INPUT.interact = false; break;
    case "KeyQ": INPUT.quick = false; break;
  }
});

// Mouse click to fire
document.addEventListener("mousedown", (e) => {
  if (!STATE.playing || STATE.paused) return;
  if (document.pointerLockElement !== document.body) return;
  if (e.button === 0) INPUT.fire = true;
  if (e.button === 2) INPUT.fire2 = true;
});
document.addEventListener("mouseup", (e) => {
  if (e.button === 0) INPUT.fire = false;
  if (e.button === 2) INPUT.fire2 = false;
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

/* =====================================================================================
   5) LIGHTING (starts brighter; dims with sanity)
===================================================================================== */

const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x1b1b24, 0.9);
scene.add(hemi);

const moon = new THREE.DirectionalLight(0xaac8ff, 0.55);
moon.position.set(20, 40, 18);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
moon.shadow.camera.near = 1;
moon.shadow.camera.far = 120;
moon.shadow.camera.left = -40;
moon.shadow.camera.right = 40;
moon.shadow.camera.top = 40;
moon.shadow.camera.bottom = -40;
scene.add(moon);

// Player flashlight (gets weaker + more jittery with low sanity)
const flash = new THREE.SpotLight(0xfff3d8, 2.3, 30, Math.PI / 6, 0.55, 1.0);
flash.position.set(0, 0, 0);
flash.target.position.set(0, 0, -1);
camera.add(flash);
camera.add(flash.target);
scene.add(camera);

// Fake emissive “ambient” points near props in pocket corridors
const ambientPoints = new THREE.Group();
scene.add(ambientPoints);

/* =====================================================================================
   6) ASSET LOADING (textures/sprites) — all caught
===================================================================================== */

const loader = new THREE.TextureLoader();

function loadTex(url) {
  return new Promise((resolve) => {
    loader.load(
      url,
      (t) => resolve(t),
      undefined,
      (err) => {
        console.warn("Texture failed:", url, err);
        // fallback 1x1
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#101014";
        ctx.fillRect(0, 0, 1, 1);
        const tex = new THREE.CanvasTexture(c);
        resolve(tex);
      }
    );
  });
}

function setPixelArt(tex, repeat = 1) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
}

const ASSETS = {
  tex: {},
  ready: false
};

async function loadAssets() {
  const base = CFG.assetsPath;
  const p = (f) => base + f;

  const [
    back,
    back2,
    fiend,
    npc,
    npc3,
    object1,
    image1,
    image2
  ] = await Promise.all([
    loadTex(p(CFG.images.back)),
    loadTex(p(CFG.images.back2)),
    loadTex(p(CFG.images.fiend)),
    loadTex(p(CFG.images.npc)),
    loadTex(p(CFG.images.npc3)),
    loadTex(p(CFG.images.object1)),
    loadTex(p(CFG.images.image1)),
    loadTex(p(CFG.images.image2)),
  ]);

  [back, back2, fiend, npc, npc3, object1, image1, image2].forEach((t) => setPixelArt(t, 1));

  ASSETS.tex.back = back;
  ASSETS.tex.back2 = back2;
  ASSETS.tex.fiend = fiend;
  ASSETS.tex.npc = npc;
  ASSETS.tex.npc3 = npc3;
  ASSETS.tex.object1 = object1;
  ASSETS.tex.image1 = image1;
  ASSETS.tex.image2 = image2;

  ASSETS.ready = true;
}

/* =====================================================================================
   7) PROCEDURAL MATERIALS (PS2-ish palette + normal-ish detail)
===================================================================================== */

function makeCanvasTex(w, h, painter) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  painter(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  setPixelArt(t, 1);
  return t;
}

function texConcrete(seed = 1) {
  return makeCanvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#2a2a31";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 12000; i++) {
      const v = (Math.random() * 70 + 30) | 0;
      ctx.fillStyle = `rgba(${v},${v},${v+6},0.06)`;
      ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
    }
    // cracks
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 2;
    for (let k = 0; k < 12; k++) {
      ctx.beginPath();
      let x = Math.random() * w, y = Math.random() * h;
      ctx.moveTo(x, y);
      for (let s = 0; s < 8; s++) {
        x += (Math.random() - 0.5) * 60;
        y += (Math.random() - 0.5) * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
}

function texWood() {
  return makeCanvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#3b2a21";
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y++) {
      const v = 28 + ((Math.sin(y * 0.08) * 18 + Math.random() * 6) | 0);
      ctx.fillStyle = `rgba(${60+v},${38+v},${28+v},0.18)`;
      ctx.fillRect(0, y, w, 1);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * w, 0);
      ctx.lineTo(Math.random() * w, h);
      ctx.stroke();
    }
  });
}

function texRust() {
  return makeCanvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#2b2320";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 8000; i++) {
      const r = 80 + (Math.random() * 120) | 0;
      const g = 40 + (Math.random() * 60) | 0;
      const b = 30 + (Math.random() * 40) | 0;
      ctx.fillStyle = `rgba(${r},${g},${b},0.08)`;
      ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 2;
    for (let k = 0; k < 40; k++) {
      ctx.beginPath();
      const x = Math.random() * w;
      const y = Math.random() * h;
      ctx.arc(x, y, Math.random() * 9 + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

const TEX = {
  concrete: texConcrete(),
  wood: texWood(),
  rust: texRust(),
  // name/wall drip will be dynamic canvas textures later
};

function stdMat(mapTex, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: mapTex,
    roughness: opts.roughness ?? 0.95,
    metalness: opts.metalness ?? 0.05,
    color: opts.color ?? 0xffffff,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1.0
  });
  if (m.map) {
    m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
  }
  return m;
}

/* =====================================================================================
   8) WORLD DATA STRUCTURES (fast collision via grid solids)
===================================================================================== */

/**
 * We maintain two areas:
 * - SURFACE: city grid
 * - POCKET: interior grid placed far away in world space (offset)
 * Collision is grid-based: solids[][] boolean.
 */

const WORLD = {
  surface: {
    origin: new THREE.Vector3(0, 0, 0),
    size: CFG.citySize,
    cell: CFG.cell,
    solids: null,         // Uint8Array (size*size), 1=wall/solid
    meta: null,           // Uint8Array for types
    interact: [],         // interactables list
    enemies: [],
    items: [],
    posters: [],          // special look-at sanity triggers
    doors: []
  },
  pocket: {
    origin: new THREE.Vector3(260, 0, 260), // far away so it doesn't overlap
    size: CFG.pocket.areaSize,
    cell: CFG.pocket.cell,
    solids: null,
    meta: null,
    interact: [],
    enemies: [],
    items: [],
    posters: [],
    doors: [],
    exitCell: null
  }
};

function idxOf(size, x, z) { return x + z * size; }
function inBounds(area, x, z) {
  return x >= 0 && z >= 0 && x < area.size && z < area.size;
}
function worldToCell(area, wx, wz) {
  const lx = wx - area.origin.x;
  const lz = wz - area.origin.z;
  return {
    x: Math.floor(lx / area.cell),
    z: Math.floor(lz / area.cell)
  };
}
function cellToWorld(area, cx, cz, y = 0) {
  return new THREE.Vector3(
    area.origin.x + cx * area.cell + area.cell * 0.5,
    y,
    area.origin.z + cz * area.cell + area.cell * 0.5
  );
}
function areaGet(area) {
  return STATE.inPocket ? WORLD.pocket : WORLD.surface;
}

/* =====================================================================================
   9) GEOMETRY HELPERS (instancing for props)
===================================================================================== */

function makeInstanced(meshGeo, meshMat, max) {
  const inst = new THREE.InstancedMesh(meshGeo, meshMat, max);
  inst.castShadow = true;
  inst.receiveShadow = true;
  inst.frustumCulled = true;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.count = 0;
  return inst;
}

const INST = {
  trees: null,
  deadTrees: null,
  nails: null,
  beds: null,
  rubble: null
};

function initInstancedProps() {
  // Tree: trunk + cone top (merged-ish by group, but instancing wants one geo; we fake with one stylized geo)
  const treeGeo = new THREE.ConeGeometry(1.1, 3.6, 6, 1);
  const treeMat = stdMat(TEX.concrete, { color: 0x2e4b34, roughness: 1.0, metalness: 0.0 });
  INST.trees = makeInstanced(treeGeo, treeMat, 1800);
  scene.add(INST.trees);

  const deadGeo = new THREE.CylinderGeometry(0.18, 0.35, 3.2, 5, 1);
  const deadMat = stdMat(TEX.wood, { color: 0x2a201a, roughness: 1.0, metalness: 0.0 });
  INST.deadTrees = makeInstanced(deadGeo, deadMat, 1200);
  scene.add(INST.deadTrees);

  const nailGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 5);
  const nailMat = stdMat(TEX.rust, { color: 0x7a4a34, roughness: 0.9, metalness: 0.25 });
  INST.nails = makeInstanced(nailGeo, nailMat, 2500);
  scene.add(INST.nails);

  const bedGeo = new THREE.BoxGeometry(1.9, 0.55, 0.95);
  const bedMat = stdMat(TEX.wood, { color: 0x3a2b22, roughness: 0.85, metalness: 0.05 });
  INST.beds = makeInstanced(bedGeo, bedMat, 700);
  scene.add(INST.beds);

  const rubbleGeo = new THREE.DodecahedronGeometry(0.55, 0);
  const rubbleMat = stdMat(TEX.concrete, { color: 0x2e2e35, roughness: 1.0, metalness: 0.0 });
  INST.rubble = makeInstanced(rubbleGeo, rubbleMat, 2000);
  scene.add(INST.rubble);
}

/* =====================================================================================
   10) DYNAMIC “NAME DRIP” TEXTURE SYSTEM (cranberry juice)
===================================================================================== */

function makeNameDripTexture(name) {
  const w = 512, h = 256;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");

  // drip particles
  const drips = [];
  for (let i = 0; i < 90; i++) {
    drips.push({
      x: Math.random() * w,
      y: Math.random() * h * 0.6,
      vy: 20 + Math.random() * 140,
      r: 2 + Math.random() * 10,
      a: 0.35 + Math.random() * 0.55
    });
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);

    // dirty wall base
    ctx.fillStyle = "rgba(10,10,12,0.85)";
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < 8000; i++) {
      const v = (Math.random() * 55) | 0;
      ctx.fillStyle = `rgba(${v},${v},${v+8},0.05)`;
      ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
    }

    // text
    ctx.save();
    ctx.translate(w * 0.5, h * 0.48);
    ctx.rotate(Math.sin(t * 0.3) * 0.02);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 78px Courier New";
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillText(name, 2, 2);

    ctx.fillStyle = "rgba(150,0,35,0.88)";
    ctx.fillText(name, 0, 0);
    ctx.restore();

    // drips
    for (const d of drips) {
      d.y += d.vy * 0.016;
      if (d.y > h + 30) { d.y = -Math.random() * 90; d.x = Math.random() * w; }

      ctx.beginPath();
      ctx.fillStyle = `rgba(120,0,30,${d.a})`;
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();

      // trail
      ctx.fillStyle = `rgba(120,0,30,${d.a * 0.38})`;
      ctx.fillRect(d.x - 1, d.y - 16, 2, 18 + d.r * 2);
    }

    // occasional smear
    if (Math.random() < 0.08) {
      ctx.globalAlpha = 0.22;
      ctx.drawImage(c, (Math.random() * 6 - 3) | 0, (Math.random() * 2 - 1) | 0);
      ctx.globalAlpha = 1;
    }
  }

  const tex = new THREE.CanvasTexture(c);
  setPixelArt(tex, 1);

  return { canvas: c, ctx, tex, draw };
}

let NAME_DRIP = makeNameDripTexture(STATE.name);

/* =====================================================================================
   11) INTERACTION SYSTEM (raycast to interactables, plus “look-at” posters)
===================================================================================== */

const raycaster = new THREE.Raycaster();
const tmpV2 = new THREE.Vector2(0, 0);

function updateInteraction(area) {
  STATE.currentInteract = null;

  raycaster.setFromCamera(tmpV2, camera);

  // intersect against meshes of interactables (cheap array)
  const meshes = area.interact.map(i => i.mesh);
  const hits = raycaster.intersectObjects(meshes, false);

  if (hits.length > 0 && hits[0].distance < 3.0) {
    const hit = hits[0].object;
    const i = area.interact.find(x => x.mesh === hit);
    if (i) {
      STATE.currentInteract = i;
      UI.crosshair.classList.add("interact");
      UI.interaction.style.display = "block";
      UI.interaction.textContent = `[E] ${i.text}`;
      return;
    }
  }

  UI.crosshair.classList.remove("interact");
  UI.interaction.style.display = "none";
}

// “look at” triggers for posters / scary wall images
function updateLookTriggers(area, dt) {
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);

  for (const p of area.posters) {
    // if too far, skip
    const d = p.mesh.position.distanceTo(camera.position);
    if (d > 6.0) continue;

    const to = new THREE.Vector3().subVectors(p.mesh.position, camera.position).normalize();
    const dot = camDir.dot(to);

    if (dot > CFG.sanityLookThreshold) {
      p.lookTime += dt;
      if (!p.triggered && p.lookTime > 0.35) {
        p.triggered = true;
        STATE.sawPosters++;
        const hit = randRange(CFG.sanityPosterHit[0], CFG.sanityPosterHit[1]);
        damageSanity(hit, "The wall image feels… personal.");
        // small audio/TTS nudge
        speakOnce("Do not memorize this.");
      }
    } else {
      p.lookTime = Math.max(0, p.lookTime - dt * 0.7);
    }
  }
}

/* =====================================================================================
   12) UI + OVERLAYS (notes, pause, death)
===================================================================================== */

function setBars() {
  UI.hpFill.style.width = `${clamp(STATE.hp, 0, 100)}%`;
  UI.sanFill.style.width = `${clamp(STATE.sanity, 0, 100)}%`;
  UI.ammoFill.style.width = `${clamp(STATE.ammo * 100, 0, 100)}%`;
  UI.quest.textContent = `OBJECTIVE: ${STATE.objective}`;
}

function showNote(title, body) {
  UI.noteTitle.textContent = title;
  UI.noteBody.textContent = body;
  UI.note.style.display = "flex";
  pauseGame(true, true); // pause without showing pause overlay
}

function hideNote() {
  UI.note.style.display = "none";
  pauseGame(false, true);
}

UI.noteClose.addEventListener("click", () => hideNote());

function pauseGame(on, silent = false) {
  if (!STATE.playing) return;
  STATE.paused = on;

  if (!silent) UI.pause.style.display = on ? "flex" : "none";

  if (on) {
    document.exitPointerLock?.();
  } else {
    // resume pointer lock
    setTimeout(() => {
      if (STATE.playing && !STATE.paused) {
        document.body.requestPointerLock?.();
      }
    }, 30);
  }
}

UI.resumeBtn?.addEventListener("click", () => pauseGame(false));
UI.restartBtn?.addEventListener("click", () => location.reload());
UI.respawnBtn?.addEventListener("click", () => location.reload());

function die(reason) {
  STATE.playing = false;
  STATE.paused = true;
  UI.deathReason.textContent = reason;
  UI.death.style.display = "flex";
  document.exitPointerLock?.();
}

/* =====================================================================================
   13) AUDIO (AudioWorklet + SpeechSynthesis real-time TTS)
===================================================================================== */

const AUDIO = {
  ctx: null,
  node: null,
  gain: null,
  ready: false,
  started: false
};

async function ensureAudio() {
  try {
    if (AUDIO.ready) return true;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn("WebAudio not supported");
      return false;
    }

    AUDIO.ctx = new Ctx({ latencyHint: "interactive" });
    AUDIO.gain = AUDIO.ctx.createGain();
    AUDIO.gain.gain.value = 0.75;
    AUDIO.gain.connect(AUDIO.ctx.destination);

    // AudioWorklet
    const url = new URL("./audio-worklet.js", import.meta.url);
    await AUDIO.ctx.audioWorklet.addModule(url);

    AUDIO.node = new AudioWorkletNode(AUDIO.ctx, "ominous-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: { gain: 0.20, fear: 0.0, breath: 0.62 }
    });

    AUDIO.node.connect(AUDIO.gain);

    AUDIO.ready = true;
    return true;
  } catch (e) {
    console.warn("Audio init failed:", e);
    return false;
  }
}

function setFearFromSanity() {
  if (!AUDIO.ready) return;
  const fear = clamp(1 - (STATE.sanity / 100), 0, 1);
  const pFear = AUDIO.node.parameters.get("fear");
  const pGain = AUDIO.node.parameters.get("gain");
  const pBreath = AUDIO.node.parameters.get("breath");

  // slightly louder and more breathy as fear rises
  pFear.setTargetAtTime(fear, AUDIO.ctx.currentTime, 0.08);
  pBreath.setTargetAtTime(0.55 + fear * 0.45, AUDIO.ctx.currentTime, 0.12);
  pGain.setTargetAtTime(0.18 + fear * 0.10, AUDIO.ctx.currentTime, 0.14);

  // duck ominous bed slightly during TTS by adjusting master gain elsewhere
}

function speakOnce(text) {
  // rate-limit to keep it eerie but not spammy
  const now = STATE.time;
  if (now - STATE.lastSpeakAt < 6.5) return;
  STATE.lastSpeakAt = now;

  const synth = window.speechSynthesis;
  if (!synth) return;

  try {
    // duck bed
    if (AUDIO.gain && AUDIO.ctx) {
      const t = AUDIO.ctx.currentTime;
      AUDIO.gain.gain.cancelScheduledValues(t);
      AUDIO.gain.gain.setTargetAtTime(0.35, t, 0.03);
      AUDIO.gain.gain.setTargetAtTime(0.75, t + 1.2, 0.2);
    }

    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92;
    u.pitch = 0.7;
    u.volume = 0.85;

    // pick a darker voice if present
    const voices = synth.getVoices?.() || [];
    const pick = voices.find(v => /en/i.test(v.lang) && /male|daniel|fred|alex/i.test(v.name.toLowerCase()))
      || voices.find(v => /en/i.test(v.lang))
      || voices[0];
    if (pick) u.voice = pick;

    synth.cancel(); // keep it clean
    synth.speak(u);
  } catch (e) {
    console.warn("TTS failed:", e);
  }
}

/* =====================================================================================
   14) WEATHER (cheap rain + lightning)
===================================================================================== */

let rain = null;
function makeRain() {
  const count = CFG.rainCount;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    pos[i * 3 + 0] = (Math.random() - 0.5) * CFG.rainArea;
    pos[i * 3 + 1] = Math.random() * CFG.rainHeight + 5;
    pos[i * 3 + 2] = (Math.random() - 0.5) * CFG.rainArea;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

  const mat = new THREE.PointsMaterial({
    color: 0xbcc7d6,
    size: 0.08,
    transparent: true,
    opacity: 0.62
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = true;
  pts.position.set(CFG.citySize * CFG.cell * 0.5, 0, CFG.citySize * CFG.cell * 0.5);
  rain = pts;
  scene.add(rain);
}

function updateRain(dt) {
  if (!rain) return;
  const arr = rain.geometry.attributes.position.array;
  const n = CFG.rainCount;

  // update in chunks for performance
  const step = 2; // fewer ops
  for (let i = 0; i < n; i += step) {
    const y = i * 3 + 1;
    arr[y] -= (14 + STATE.glitch * 12) * dt;
    if (arr[y] < 0) arr[y] = CFG.rainHeight + Math.random() * 10;
  }
  rain.geometry.attributes.position.needsUpdate = true;

  // lightning
  if (Math.random() > (0.996 - STATE.glitch * 0.004)) {
    hemi.intensity = 1.8;
    setTimeout(() => (hemi.intensity = 0.9), 90);
  }
}

/* =====================================================================================
   15) MINIMAP (with hallucinations)
===================================================================================== */

function drawMinimap(area) {
  const w = UI.minimap.width, h = UI.minimap.height;
  mapCtx.clearRect(0, 0, w, h);

  // vignette circle mask
  mapCtx.save();
  mapCtx.fillStyle = "rgba(0,0,0,0.86)";
  mapCtx.fillRect(0, 0, w, h);
  mapCtx.globalCompositeOperation = "destination-out";
  mapCtx.beginPath();
  mapCtx.arc(w / 2, h / 2, w * 0.49, 0, Math.PI * 2);
  mapCtx.fill();
  mapCtx.restore();

  mapCtx.save();
  mapCtx.beginPath();
  mapCtx.arc(w / 2, h / 2, w * 0.49, 0, Math.PI * 2);
  mapCtx.clip();

  // background
  mapCtx.fillStyle = "rgba(0,0,0,0.58)";
  mapCtx.fillRect(0, 0, w, h);

  const px = camera.position.x;
  const pz = camera.position.z;

  const zoom = STATE.inPocket ? 2.9 : 2.0;
  const scale = zoom;

  // draw nearby solids as dots
  mapCtx.fillStyle = "rgba(170,170,180,0.55)";
  const size = area.size;
  const cell = area.cell;

  // sample around player (not full grid)
  const pr = 16;
  const pc = worldToCell(area, px, pz);

  for (let dz = -pr; dz <= pr; dz++) {
    for (let dx = -pr; dx <= pr; dx++) {
      const cx = pc.x + dx;
      const cz = pc.z + dz;
      if (!inBounds(area, cx, cz)) continue;
      const id = idxOf(size, cx, cz);
      if (area.solids[id] === 1) {
        const wx = area.origin.x + cx * cell + cell * 0.5;
        const wz = area.origin.z + cz * cell + cell * 0.5;
        const rx = (wx - px) * scale + w / 2;
        const ry = (wz - pz) * scale + h / 2;
        if (rx > -2 && ry > -2 && rx < w + 2 && ry < h + 2) {
          mapCtx.fillRect(rx, ry, 2, 2);
        }
      }
    }
  }

  // enemies
  mapCtx.fillStyle = "rgba(255,60,60,0.85)";
  for (const e of area.enemies) {
    const rx = (e.pos.x - px) * scale + w / 2;
    const ry = (e.pos.z - pz) * scale + h / 2;
    if (rx > 0 && ry > 0 && rx < w && ry < h) mapCtx.fillRect(rx - 2, ry - 2, 4, 4);
  }

  // player
  mapCtx.fillStyle = "rgba(77,255,122,0.9)";
  mapCtx.beginPath();
  mapCtx.arc(w / 2, h / 2, 3.2, 0, Math.PI * 2);
  mapCtx.fill();

  // hallucinations
  const lie = clamp((CFG.minimapLieStart - STATE.sanity) / CFG.minimapLieStart, 0, 1);
  if (lie > 0) {
    const fake = Math.floor(lie * CFG.minimapLieMax);
    for (let i = 0; i < fake; i++) {
      const rx = (Math.random() * w) | 0;
      const ry = (Math.random() * h) | 0;

      if (Math.random() < 0.55) {
        mapCtx.fillStyle = "rgba(255,60,60,0.55)";
        mapCtx.fillRect(rx, ry, 3, 3);
      } else {
        mapCtx.fillStyle = "rgba(190,190,210,0.35)";
        mapCtx.fillRect(rx, ry, 2, 2);
      }
    }
  }

  // scanline overlay
  mapCtx.globalAlpha = 0.12 + 0.18 * lie;
  mapCtx.fillStyle = "#000";
  for (let y = 0; y < h; y += 4) mapCtx.fillRect(0, y, w, 1);

  mapCtx.restore();
}

/* =====================================================================================
   16) COLLISION + PLAYER PHYSICS (grid)
===================================================================================== */

const player = {
  pos: new THREE.Vector3(2, CFG.playerHeight, 2),
  vel: new THREE.Vector3(0, 0, 0),
  onGround: true,
  baseY: CFG.playerHeight,
  bob: 0,
  bobVel: 0
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function randRange(a, b) { return a + Math.random() * (b - a); }

// Check if a given point collides with solids (circle)
function collidesAt(area, x, z, radius) {
  const { x: cx, z: cz } = worldToCell(area, x, z);
  const r = Math.ceil(radius / area.cell) + 1;

  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx;
      const gz = cz + dz;
      if (!inBounds(area, gx, gz)) return true; // outside = solid
      const id = idxOf(area.size, gx, gz);
      if (area.solids[id] !== 1) continue;

      // AABB of cell
      const minX = area.origin.x + gx * area.cell;
      const minZ = area.origin.z + gz * area.cell;
      const maxX = minX + area.cell;
      const maxZ = minZ + area.cell;

      // circle vs AABB
      const nx = clamp(x, minX, maxX);
      const nz = clamp(z, minZ, maxZ);
      const dx2 = x - nx;
      const dz2 = z - nz;
      if ((dx2 * dx2 + dz2 * dz2) < (radius * radius)) return true;
    }
  }
  return false;
}

function resolveMovement(area, desired, radius) {
  // Try X then Z separately (simple sliding)
  const p = player.pos;

  let nx = desired.x, nz = p.z;
  if (!collidesAt(area, nx, nz, radius)) {
    p.x = nx;
  } else {
    // nudge away slightly
    player.vel.x *= 0.2;
  }

  nx = p.x; nz = desired.z;
  if (!collidesAt(area, nx, nz, radius)) {
    p.z = nz;
  } else {
    player.vel.z *= 0.2;
  }
}

function updatePlayer(area, dt) {
  // sanity decay
  const decay = CFG.sanityDecayPerSec * dt * (STATE.inPocket ? 1.1 : 1.0);
  damageSanity(decay, null, true);

  // movement input vector in camera space
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const wish = new THREE.Vector3();
  if (INPUT.forward) wish.add(forward);
  if (INPUT.back) wish.sub(forward);
  if (INPUT.right) wish.add(right);
  if (INPUT.left) wish.sub(right);

  const wishLen = wish.length();
  if (wishLen > 0) wish.multiplyScalar(1 / wishLen);

  const speed = INPUT.run ? CFG.runSpeed : CFG.walkSpeed;

  // ground friction
  if (player.onGround) {
    const friction = CFG.friction;
    player.vel.x -= player.vel.x * friction * dt;
    player.vel.z -= player.vel.z * friction * dt;
  }

  // accelerate
  const accel = player.onGround ? 18.0 : 18.0 * CFG.airControl;
  player.vel.x += wish.x * speed * accel * dt;
  player.vel.z += wish.z * speed * accel * dt;

  // limit horizontal speed
  const hv = Math.hypot(player.vel.x, player.vel.z);
  const maxH = speed * 1.35;
  if (hv > maxH) {
    const s = maxH / hv;
    player.vel.x *= s;
    player.vel.z *= s;
  }

  // jump
  if (INPUT.jump && player.onGround) {
    player.vel.y = CFG.jumpVel;
    player.onGround = false;
  }
  INPUT.jump = false;

  // gravity
  player.vel.y -= CFG.gravity * dt;

  // integrate
  const desired = new THREE.Vector3(
    player.pos.x + player.vel.x * dt,
    player.pos.y + player.vel.y * dt,
    player.pos.z + player.vel.z * dt
  );

  // floor
  const floorY = CFG.playerHeight;
  if (desired.y <= floorY) {
    desired.y = floorY;
    player.vel.y = 0;
    player.onGround = true;
  }

  resolveMovement(area, desired, CFG.playerRadius);
  player.pos.y = desired.y;

  // headbob (non-cumulative)
  const moving = wishLen > 0.01 && player.onGround;
  const bobTarget = moving ? (INPUT.run ? 1.0 : 0.7) : 0.0;
  player.bobVel = lerp(player.bobVel, bobTarget, 1 - Math.exp(-dt * 6.0));
  player.bob += dt * (6.5 + 5.0 * player.bobVel);

  const bobAmt = 0.035 * player.bobVel;
  const bobY = Math.sin(player.bob * 2.0) * bobAmt;
  camera.position.set(player.pos.x, player.baseY + bobY, player.pos.z);
}

/* =====================================================================================
   17) SANITY / HP DAMAGE + DARKENING
===================================================================================== */

function damageHP(amount) {
  if (amount <= 0) return;
  STATE.hp = clamp(STATE.hp - amount, 0, 100);
  setBars();
  if (STATE.hp <= 0) die("PHYSICAL TRAUMA CRITICAL");
}
function damageSanity(amount, whisperText = null, silent = false) {
  if (amount <= 0) return;
  STATE.sanity = clamp(STATE.sanity - amount, 0, 100);
  setBars();
  if (!silent && whisperText && Math.random() < 0.45) speakOnce(whisperText);
  if (STATE.sanity <= 0) die("SYSTEM CORRUPTION 100%");
}

// computed glitch intensity from sanity (0..1)
function computeGlitch() {
  const s = STATE.sanity;
  let g = 0;
  if (s < CFG.glitchJitterStart) g = (CFG.glitchJitterStart - s) / CFG.glitchJitterStart;
  if (s < CFG.glitchHardStart) g = 0.55 + (CFG.glitchHardStart - s) / CFG.glitchHardStart * 0.45;
  return clamp(g, 0, 1);
}

function updateLighting(dt) {
  const fear = clamp(1 - STATE.sanity / 100, 0, 1);

  // Start brighter, then dim with fear
  hemi.intensity = lerp(0.95, 0.12, fear);
  moon.intensity = lerp(0.65, 0.10, fear);

  // Fog thickens with fear
  const fogD = lerp(0.022, 0.060, fear);
  scene.fog.density = fogD;

  // flashlight less stable with low sanity
  flash.intensity = lerp(2.6, 1.25, fear);
  const jitter = fear * fear * 0.18;
  flash.angle = lerp(Math.PI / 7, Math.PI / 5, fear);
  flash.position.set((Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter, 0);
}

/* =====================================================================================
   18) ENEMIES (billboard PNG sprites for creepy monsters)
===================================================================================== */

function makeSprite(tex, scale = 2.1) {
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false
  });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(scale, scale, 1);
  spr.renderOrder = 3;
  return spr;
}

function spawnEnemy(area, kind = "fiend") {
  const tex = (kind === "fiend") ? ASSETS.tex.fiend : (Math.random() < 0.5 ? ASSETS.tex.npc : ASSETS.tex.npc3);
  const spr = makeSprite(tex, randRange(2.1, 3.3));
  spr.position.copy(cellToWorld(area, randInt(area.size), randInt(area.size), 1.5));
  scene.add(spr);

  const e = {
    mesh: spr,
    pos: spr.position,
    vel: new THREE.Vector3(),
    speed: randRange(CFG.enemySpeedMin, CFG.enemySpeedMax),
    attackCD: 0,
    kind
  };
  area.enemies.push(e);
}

function randInt(n) { return (Math.random() * n) | 0; }

function updateEnemies(area, dt) {
  for (const e of area.enemies) {
    // always face player
    e.mesh.lookAt(camera.position.x, e.mesh.position.y, camera.position.z);

    const d = e.pos.distanceTo(player.pos);

    if (d < CFG.enemyViewDist) {
      // chase
      const dir = new THREE.Vector3().subVectors(player.pos, e.pos);
      dir.y = 0;
      const len = dir.length() || 1;
      dir.multiplyScalar(1 / len);

      // move with collision
      const nx = e.pos.x + dir.x * e.speed * dt;
      const nz = e.pos.z + dir.z * e.speed * dt;

      if (!collidesAt(area, nx, nz, 0.35)) {
        e.pos.x = nx;
        e.pos.z = nz;
      } else {
        // slide a bit
        const sx = e.pos.x + dir.x * e.speed * dt;
        if (!collidesAt(area, sx, e.pos.z, 0.35)) e.pos.x = sx;
        const sz = e.pos.z + dir.z * e.speed * dt;
        if (!collidesAt(area, e.pos.x, sz, 0.35)) e.pos.z = sz;
      }

      // attack
      e.attackCD -= dt;
      if (d < CFG.enemyAttackDist && e.attackCD <= 0) {
        e.attackCD = 0.55 + Math.random() * 0.35;
        damageHP(CFG.enemyDamageHP * (0.6 + STATE.glitch * 0.8));
        damageSanity(CFG.enemyDamageSAN * (0.6 + STATE.glitch * 0.9), "You are not supposed to be here.");
      }
    } else {
      // idle drift
      const wob = Math.sin(STATE.time * 0.7 + e.pos.x * 0.02) * 0.3;
      e.pos.x += wob * dt * 0.6;
    }
  }
}

/* =====================================================================================
   19) ITEMS / WEAPONS / BAD OBJECTS
===================================================================================== */

function spawnPickup(area, type, cx, cz) {
  const pos = cellToWorld(area, cx, cz, 0.6);

  let geo, mat;
  if (type === "key") {
    geo = new THREE.TorusKnotGeometry(0.18, 0.07, 48, 8);
    mat = stdMat(TEX.rust, { color: 0xffd16a, roughness: 0.75, metalness: 0.45 });
  } else if (type === "charge") {
    geo = new THREE.IcosahedronGeometry(0.22, 0);
    mat = stdMat(TEX.concrete, { color: 0x6affff, emissive: 0x0b4455, emissiveIntensity: 0.8 });
  } else if (type === "med") {
    geo = new THREE.BoxGeometry(0.32, 0.32, 0.32);
    mat = stdMat(TEX.concrete, { color: 0xff6a6a, emissive: 0x2a0000, emissiveIntensity: 0.6 });
  } else if (type === "cursed") {
    geo = new THREE.DodecahedronGeometry(0.26, 0);
    mat = stdMat(TEX.concrete, { color: 0x7fff6a, emissive: 0x123b00, emissiveIntensity: 0.9 });
  } else {
    geo = new THREE.SphereGeometry(0.2, 10, 10);
    mat = stdMat(TEX.concrete, { color: 0xffffff });
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.position.copy(pos);
  scene.add(mesh);

  const item = { mesh, type, taken: false };
  area.items.push(item);

  area.interact.push({
    mesh,
    text: type === "key" ? "TAKE KEY" :
          type === "charge" ? "ABSORB CHARGE" :
          type === "med" ? "TAKE MEDKIT" :
          "TAKE CURSED OBJECT",
    action: () => takeItem(area, item)
  });
}

function takeItem(area, item) {
  if (item.taken) return;
  item.taken = true;
  scene.remove(item.mesh);

  if (item.type === "key") {
    if (STATE.inPocket) {
      STATE.keys++;
      STATE.objective = `COLLECT KEYS (${STATE.keys}/${CFG.pocket.keyCount}) • FIND EXIT`;
      speakOnce("Keys are only ideas with teeth.");
    } else {
      STATE.hasKey = true;
      STATE.objective = "FIND A DOOR • ENTER A POCKET CORRIDOR";
      speakOnce("A key that fits nowhere is still a key.");
    }
  }

  if (item.type === "charge") {
    STATE.ammo = clamp(STATE.ammo + CFG.weaponChargePerPickup, 0, 1);
    speakOnce("Energy tastes like copper.");
  }

  if (item.type === "med") {
    STATE.hp = clamp(STATE.hp + 22, 0, 100);
    speakOnce("Stitch the data. Keep moving.");
  }

  if (item.type === "cursed") {
    // immediate small help, later sanity hit
    STATE.ammo = clamp(STATE.ammo + CFG.cursedBoost, 0, 1);
    STATE.hp = clamp(STATE.hp + 10, 0, 100);
    setTimeout(() => {
      damageSanity(14 + Math.random() * 10, "You ate the wrong memory.");
    }, 4500 + Math.random() * 4500);
    speakOnce("Sweet. Wrong. Again.");
  }

  setBars();
}

function fireWeapon(area, dt) {
  if (!INPUT.fire && !INPUT.fire2) return;
  if (STATE.ammo <= 0.02) return;

  // basic ray shot with drain
  const drain = CFG.weaponDrainPerShot * (INPUT.fire2 ? 1.35 : 1.0);
  STATE.ammo = clamp(STATE.ammo - drain, 0, 1);

  // stronger pushback / stun if alt fire
  const dmg = INPUT.fire2 ? 42 : 24;
  const stun = INPUT.fire2 ? 0.28 : 0.14;

  // cast forward
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  raycaster.set(camera.position, dir);
  const enemyMeshes = area.enemies.map(e => e.mesh);
  const hits = raycaster.intersectObjects(enemyMeshes, false);

  if (hits.length > 0 && hits[0].distance < 18) {
    const hitObj = hits[0].object;
    const e = area.enemies.find(x => x.mesh === hitObj);
    if (e) {
      // “damage” = teleport jitter backwards (since sprite)
      const back = new THREE.Vector3().subVectors(e.pos, player.pos).normalize();
      e.pos.add(back.multiplyScalar(0.8 + stun * 3.0));

      // sanity relief when you hit something
      STATE.sanity = clamp(STATE.sanity + 0.8, 0, 100);

      // sometimes banish
      if (Math.random() < (INPUT.fire2 ? 0.22 : 0.12)) {
        scene.remove(e.mesh);
        area.enemies.splice(area.enemies.indexOf(e), 1);
        speakOnce("Deleted.");
      }
    }
  }

  setBars();

  // single-shot, not continuous hold spam
  INPUT.fire = false;
  INPUT.fire2 = false;
}

function quickUse() {
  if (!INPUT.quick) return;
  INPUT.quick = false;

  if (!STATE.quickItem) {
    // if no quick item, small panic speech
    if (Math.random() < 0.25) speakOnce("Nothing in your pockets but static.");
    return;
  }

  const t = STATE.quickItem;
  STATE.quickItem = null;

  if (t === "med") {
    STATE.hp = clamp(STATE.hp + 32, 0, 100);
    speakOnce("Hands remember.");
  } else if (t === "cursed") {
    STATE.ammo = clamp(STATE.ammo + 0.35, 0, 1);
    setTimeout(() => damageSanity(18, "That was not medicine."), 3000);
    speakOnce("It helps. It hurts.");
  }
  setBars();
}

/* =====================================================================================
   20) BUILDING THE WORLD (surface + pocket)
===================================================================================== */

const WORLD_MESH = new THREE.Group();
scene.add(WORLD_MESH);

function clearArea(area) {
  // remove previous meshes except instanced
  const keep = new Set([INST.trees, INST.deadTrees, INST.nails, INST.beds, INST.rubble]);
  for (let i = WORLD_MESH.children.length - 1; i >= 0; i--) {
    const c = WORLD_MESH.children[i];
    if (!keep.has(c)) WORLD_MESH.remove(c);
  }

  // also remove enemies/items/doors meshes from scene
  for (const e of area.enemies) scene.remove(e.mesh);
  for (const it of area.items) scene.remove(it.mesh);
  for (const p of area.posters) scene.remove(p.mesh);
  for (const d of area.doors) scene.remove(d.mesh);

  area.interact.length = 0;
  area.enemies.length = 0;
  area.items.length = 0;
  area.posters.length = 0;
  area.doors.length = 0;
}

function initAreaGrids(area) {
  area.solids = new Uint8Array(area.size * area.size);
  area.meta = new Uint8Array(area.size * area.size);
  area.solids.fill(0);
  area.meta.fill(0);

  // border walls
  for (let x = 0; x < area.size; x++) {
    area.solids[idxOf(area.size, x, 0)] = 1;
    area.solids[idxOf(area.size, x, area.size - 1)] = 1;
  }
  for (let z = 0; z < area.size; z++) {
    area.solids[idxOf(area.size, 0, z)] = 1;
    area.solids[idxOf(area.size, area.size - 1, z)] = 1;
  }
}

function addCellSolid(area, x, z, solid = 1, meta = 1) {
  if (!inBounds(area, x, z)) return;
  const id = idxOf(area.size, x, z);
  area.solids[id] = solid;
  area.meta[id] = meta;
}

// Batch build walls mesh from solids (fast: merge boxes in strips)
function buildSolidsMesh(area, wallH, tex, tint = 0xffffff) {
  const g = new THREE.BoxGeometry(area.cell, wallH, area.cell);
  const m = stdMat(tex, { color: tint, roughness: 0.96, metalness: 0.02 });
  m.map.repeat.set(1, 1);

  const inst = new THREE.InstancedMesh(g, m, area.size * area.size);
  inst.castShadow = true;
  inst.receiveShadow = true;

  const mat4 = new THREE.Matrix4();
  let count = 0;

  for (let z = 0; z < area.size; z++) {
    for (let x = 0; x < area.size; x++) {
      const id = idxOf(area.size, x, z);
      if (area.solids[id] !== 1) continue;

      const pos = cellToWorld(area, x, z, wallH * 0.5);
      mat4.makeTranslation(pos.x, pos.y, pos.z);
      inst.setMatrixAt(count++, mat4);
    }
  }

  inst.count = count;
  inst.instanceMatrix.needsUpdate = true;
  WORLD_MESH.add(inst);

  return inst;
}

// Ground
function buildGround(area, tex, tint = 0xffffff) {
  const geo = new THREE.PlaneGeometry(area.size * area.cell, area.size * area.cell, 1, 1);
  const mat = stdMat(tex, { color: tint, roughness: 1.0, metalness: 0.0 });
  mat.map.repeat.set(area.size / 6, area.size / 6);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(area.origin.x + area.size * area.cell * 0.5, 0, area.origin.z + area.size * area.cell * 0.5);
  mesh.receiveShadow = true;
  WORLD_MESH.add(mesh);
  return mesh;
}

// Background “billboard sky” using your back/back2
function buildBackgroundPlanes() {
  // remove old background planes if any
  const olds = WORLD_MESH.children.filter(c => c.userData && c.userData.isBackdrop);
  olds.forEach(o => WORLD_MESH.remove(o));

  const make = (tex, x, z, rotY, w, h, alpha) => {
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: alpha, depthWrite: false });
    const geo = new THREE.PlaneGeometry(w, h);
    const p = new THREE.Mesh(geo, mat);
    p.position.set(x, h * 0.45, z);
    p.rotation.y = rotY;
    p.userData.isBackdrop = true;
    p.renderOrder = -10;
    WORLD_MESH.add(p);
  };

  const center = CFG.citySize * CFG.cell * 0.5;
  make(ASSETS.tex.back,  center, -20, 0, 120, 60, 0.90);
  make(ASSETS.tex.back2, center, center + 120, Math.PI, 140, 70, 0.70);
  make(ASSETS.tex.back2, -20, center, Math.PI / 2, 140, 70, 0.55);
  make(ASSETS.tex.back,  center + 120, center, -Math.PI / 2, 120, 60, 0.55);
}

// Posters / scary wall images (image.png, image2.png)
function spawnPoster(area, cx, cz, tex, creepy = true) {
  const geo = new THREE.PlaneGeometry(area.cell * 0.9, area.cell * 0.9);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);

  const pos = cellToWorld(area, cx, cz, 1.6);
  mesh.position.copy(pos);

  // stick onto a wall face by nudging based on nearby solid direction
  // find nearest solid neighbor
  const dirs = [
    { dx: 1, dz: 0, ry: -Math.PI / 2 },
    { dx: -1, dz: 0, ry: Math.PI / 2 },
    { dx: 0, dz: 1, ry: Math.PI },
    { dx: 0, dz: -1, ry: 0 }
  ];
  for (const d of dirs) {
    const nx = cx + d.dx, nz = cz + d.dz;
    if (inBounds(area, nx, nz) && area.solids[idxOf(area.size, nx, nz)] === 1) {
      mesh.rotation.y = d.ry;
      mesh.position.x -= d.dx * (area.cell * 0.49);
      mesh.position.z -= d.dz * (area.cell * 0.49);
      break;
    }
  }

  WORLD_MESH.add(mesh);

  area.posters.push({
    mesh,
    creepy,
    lookTime: 0,
    triggered: false
  });
}

// TVs that display name drip texture
function spawnTV(area, cx, cz) {
  const pos = cellToWorld(area, cx, cz, 0.5);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.7, 0.5),
    stdMat(TEX.rust, { color: 0x2b2b32, roughness: 0.8, metalness: 0.15 })
  );
  body.position.copy(pos);
  body.castShadow = true;

  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.72, 0.46),
    new THREE.MeshBasicMaterial({ map: NAME_DRIP.tex, transparent: true })
  );
  screen.position.set(0, 0.02, 0.26);
  body.add(screen);

  // flicker light
  const l = new THREE.PointLight(0x88ccff, 0.6, 4);
  l.position.set(0, 0.1, 0.8);
  body.add(l);

  WORLD_MESH.add(body);

  // interact: “listen” (TTS)
  area.interact.push({
    mesh: body,
    text: "LISTEN TO THE TV",
    action: () => {
      speakOnce(`${STATE.name} ... the corridors remember you.`);
      damageSanity(randRange(2, 6), "The TV knows your name.");
    }
  });
}

// Doors that open into pocket corridor (surface) or deeper pocket (pocket)
function spawnDoor(area, cx, cz, kind) {
  const pos = cellToWorld(area, cx, cz, 1.2);
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(area.cell * 0.88, 2.4, 0.2),
    stdMat(TEX.wood, { color: 0x5a3b2b, roughness: 0.85, metalness: 0.05 })
  );
  frame.position.copy(pos);
  frame.castShadow = true;
  WORLD_MESH.add(frame);

  const isLocked = (kind === "pocketGate")
    ? (!STATE.hasKey)
    : (Math.random() < CFG.pocket.doorLockChance);

  const door = {
    mesh: frame,
    cx, cz,
    kind,            // "pocketGate" | "pocketDoor" | "exitDoor"
    locked: isLocked,
    open: false
  };
  area.doors.push(door);

  area.interact.push({
    mesh: frame,
    text: () => {
      if (door.kind === "pocketGate") return door.locked ? "DOOR (NEEDS A KEY)" : "ENTER POCKET CORRIDOR";
      if (door.kind === "exitDoor") return door.locked ? "EXIT (LOCKED)" : "LEAVE";
      return door.locked ? "LOCKED DOOR" : "OPEN DOOR";
    },
    action: () => onDoorInteract(area, door)
  });
}

function onDoorInteract(area, door) {
  const txt = (typeof doorText(door) === "function") ? doorText(door) : doorText(door);

  if (door.kind === "pocketGate") {
    if (!STATE.hasKey) {
      speakOnce("You do not have permission.");
      damageSanity(4, "The door laughs.");
      return;
    }
    enterPocket();
    return;
  }

  if (door.kind === "exitDoor") {
    if (door.locked) {
      speakOnce("Not yet.");
      return;
    }
    speakOnce("Wake up.");
    die("YOU ESCAPED (…FOR NOW)");
    return;
  }

  // pocket door
  if (door.locked) {
    if (STATE.keys > 0) {
      STATE.keys--;
      door.locked = false;
      speakOnce("A key becomes a memory.");
      STATE.objective = `COLLECT KEYS (${STATE.keys}/${CFG.pocket.keyCount}) • FIND EXIT`;
      setBars();
    } else {
      speakOnce("Locked.");
      damageSanity(2, "You forgot the key.");
      return;
    }
  }

  // open animation: simply clear a solid in front to create passage
  door.open = true;
  // remove solid at that cell to allow passage
  addCellSolid(area, door.cx, door.cz, 0, 0);
  // make the door fade/tilt slightly
  door.mesh.rotation.y += 0.6;
  door.mesh.position.y -= 0.05;
}

function doorText(door) {
  if (door.kind === "pocketGate") return door.locked ? "DOOR (NEEDS A KEY)" : "ENTER POCKET CORRIDOR";
  if (door.kind === "exitDoor") return door.locked ? "EXIT (LOCKED)" : "LEAVE";
  return door.locked ? "LOCKED DOOR" : "OPEN DOOR";
}

// Notes
function spawnNote(area, cx, cz, title, body, creepy = true) {
  const pos = cellToWorld(area, cx, cz, 0.08);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.45, 0.56),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.96, side: THREE.DoubleSide })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.copy(pos);
  WORLD_MESH.add(mesh);

  area.interact.push({
    mesh,
    text: "READ NOTE",
    action: () => {
      showNote(title, body);
      STATE.readNotes++;
      if (creepy) {
        const hit = randRange(CFG.sanityCreepyNoteHit[0], CFG.sanityCreepyNoteHit[1]);
        damageSanity(hit, "Reading is a form of entry.");
      } else {
        // mild “comfort”
        STATE.sanity = clamp(STATE.sanity + 3, 0, 100);
        setBars();
      }
    }
  });
}

// Decorative: place name-drip wall sign
function spawnNameWall(area, cx, cz) {
  const geo = new THREE.PlaneGeometry(area.cell * 1.2, area.cell * 0.75);
  const mat = new THREE.MeshBasicMaterial({ map: NAME_DRIP.tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  const pos = cellToWorld(area, cx, cz, 1.6);
  mesh.position.copy(pos);

  // face a random direction (wall)
  const ry = [0, Math.PI / 2, Math.PI, -Math.PI / 2][(Math.random() * 4) | 0];
  mesh.rotation.y = ry;
  // push slightly so it's like a decal
  mesh.position.x += Math.sin(ry) * (area.cell * 0.46);
  mesh.position.z += Math.cos(ry) * (area.cell * 0.46);

  WORLD_MESH.add(mesh);
}

// props with instancing
function addInst(inst, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0));
  const s = new THREE.Vector3(sx, sy, sz);
  const p = new THREE.Vector3(x, y, z);
  m.compose(p, q, s);
  const i = inst.count;
  inst.setMatrixAt(i, m);
  inst.count = i + 1;
  inst.instanceMatrix.needsUpdate = true;
}

// generate SURFACE city: roads + random buildings as solids + props
function generateSurface() {
  const area = WORLD.surface;
  clearArea(area);
  initAreaGrids(area);

  // reset instanced counts
  INST.trees.count = 0;
  INST.deadTrees.count = 0;
  INST.nails.count = 0;
  INST.beds.count = 0;
  INST.rubble.count = 0;

  // Build roads (non-solids) and blocks (some solids)
  const size = area.size;

  // Place “buildings” as solid blocks in a pattern, leaving roads
  for (let z = 2; z < size - 2; z++) {
    for (let x = 2; x < size - 2; x++) {
      const road = (x % 5 === 0) || (z % 5 === 0);
      if (road) continue;

      // building chance
      if (Math.random() < 0.18) {
        addCellSolid(area, x, z, 1, 2);
      }
    }
  }

  // ground + solids mesh
  buildGround(area, TEX.concrete, 0x2a2a30);
  buildSolidsMesh(area, CFG.surfaceWallHeight, TEX.concrete, 0x2f2f36);

  // backdrops
  buildBackgroundPlanes();

  // Place props/items/interactables on empty cells
  for (let z = 2; z < size - 2; z++) {
    for (let x = 2; x < size - 2; x++) {
      const id = idxOf(size, x, z);
      if (area.solids[id] === 1) continue;

      const r = Math.random();

      const wpos = cellToWorld(area, x, z, 0);

      // trees / dead trees
      if (r < CFG.treeChance) {
        addInst(INST.trees, wpos.x, 1.8, wpos.z, Math.random() * Math.PI * 2, 1.0, 1.0, 1.0);
      } else if (r < CFG.treeChance + CFG.deadTreeChance) {
        addInst(INST.deadTrees, wpos.x, 1.6, wpos.z, Math.random() * Math.PI * 2, 1.0, 1.0, 1.0);
      }

      // beds
      if (Math.random() < CFG.bedChance) {
        addInst(INST.beds, wpos.x, 0.28, wpos.z, Math.random() * Math.PI * 2, 1.0, 1.0, 1.0);
      }

      // nails clusters
      if (Math.random() < CFG.nailsChance) {
        const n = 1 + ((Math.random() * 4) | 0);
        for (let i = 0; i < n; i++) {
          addInst(INST.nails, wpos.x + (Math.random() - 0.5) * 0.8, 0.35, wpos.z + (Math.random() - 0.5) * 0.8, Math.random() * Math.PI);
        }
      }

      // rubble
      if (Math.random() < 0.10) {
        addInst(INST.rubble, wpos.x, 0.4, wpos.z, Math.random() * Math.PI, 0.8 + Math.random(), 0.8 + Math.random(), 0.8 + Math.random());
      }

      // posters
      if (Math.random() < CFG.posterChance) {
        const tex = Math.random() < 0.5 ? ASSETS.tex.image1 : ASSETS.tex.image2;
        spawnPoster(area, x, z, tex, true);
      }

      // TV
      if (Math.random() < CFG.tvChance) {
        spawnTV(area, x, z);
      }

      // Name wall occasionally
      if (Math.random() < 0.05) {
        spawnNameWall(area, x, z);
      }

      // Random note
      if (Math.random() < 0.07) {
        const creepy = Math.random() < 0.75;
        spawnNote(
          area,
          x,
          z,
          creepy ? "LOG: SECTOR 0" : "MAINTENANCE NOTE",
          creepy
            ? `The map updates itself when you blink.\n\nIf you see your name (${STATE.name}) on a wall, do NOT read it aloud.\n\nDoors are hungry.`
            : `Power is unstable.\nKeep moving.\nIf the lights dim, find a TV.`,
          creepy
        );
      }

      // Items
      if (Math.random() < 0.05) {
        const t = Math.random();
        if (t < 0.25) spawnPickup(area, "med", x, z);
        else if (t < 0.6) spawnPickup(area, "charge", x, z);
        else spawnPickup(area, "cursed", x, z);
      }
    }
  }

  // Place ONE surface key somewhere accessible
  for (let tries = 0; tries < 3000; tries++) {
    const x = 2 + randInt(size - 4);
    const z = 2 + randInt(size - 4);
    if (area.solids[idxOf(size, x, z)] === 0) {
      spawnPickup(area, "key", x, z);
      break;
    }
  }

  // Place a gateway door to pocket corridors
  for (let tries = 0; tries < 3000; tries++) {
    const x = 2 + randInt(size - 4);
    const z = 2 + randInt(size - 4);
    if (area.solids[idxOf(size, x, z)] === 0) {
      // carve a little “door alcove”
      addCellSolid(area, x, z, 0, 0);
      spawnDoor(area, x, z, "pocketGate");
      break;
    }
  }

  // Spawn enemies
  for (let i = 0; i < CFG.enemyCountSurface; i++) spawnEnemy(area, "fiend");
}

// generate POCKET corridors: rooms + corridors + locked doors + keys + exit
function generatePocket() {
  const area = WORLD.pocket;
  clearArea(area);
  initAreaGrids(area);

  // reset instanced counts (we reuse some props inside too)
  INST.trees.count = 0;
  INST.deadTrees.count = 0;
  INST.nails.count = 0;
  INST.beds.count = 0;
  INST.rubble.count = 0;

  // Start: fill everything solid, then carve rooms/corridors
  area.solids.fill(1);
  area.meta.fill(1);

  // border remains solid
  for (let x = 0; x < area.size; x++) {
    area.solids[idxOf(area.size, x, 0)] = 1;
    area.solids[idxOf(area.size, x, area.size - 1)] = 1;
  }
  for (let z = 0; z < area.size; z++) {
    area.solids[idxOf(area.size, 0, z)] = 1;
    area.solids[idxOf(area.size, area.size - 1, z)] = 1;
  }

  const rooms = [];

  function carveRect(x0, z0, w, h) {
    for (let z = z0; z < z0 + h; z++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x <= 1 || z <= 1 || x >= area.size - 2 || z >= area.size - 2) continue;
        addCellSolid(area, x, z, 0, 0);
      }
    }
  }

  function rectsOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.z + a.h <= b.z || b.z + b.h <= a.z);
  }

  // Place rooms
  let attempts = 0;
  while (rooms.length < CFG.pocket.roomCount && attempts < 5000) {
    attempts++;
    const w = CFG.pocket.roomMin + randInt(CFG.pocket.roomMax - CFG.pocket.roomMin + 1);
    const h = CFG.pocket.roomMin + randInt(CFG.pocket.roomMax - CFG.pocket.roomMin + 1);
    const x = 2 + randInt(area.size - w - 4);
    const z = 2 + randInt(area.size - h - 4);

    const r = { x, z, w, h, cx: (x + (w / 2)) | 0, cz: (z + (h / 2)) | 0 };
    if (rooms.some(o => rectsOverlap(r, { x: o.x - 2, z: o.z - 2, w: o.w + 4, h: o.h + 4 }))) continue;

    rooms.push(r);
    carveRect(x, z, w, h);
  }

  // Connect rooms with corridors (simple L-path)
  function carveCorridor(x1, z1, x2, z2) {
    const cw = CFG.pocket.corridorWidth;
    const carveLine = (ax, az, bx, bz) => {
      const dx = Math.sign(bx - ax);
      const dz = Math.sign(bz - az);
      let x = ax, z = az;
      const steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
      for (let i = 0; i <= steps; i++) {
        for (let oz = -((cw / 2) | 0); oz <= ((cw / 2) | 0); oz++) {
          for (let ox = -((cw / 2) | 0); ox <= ((cw / 2) | 0); ox++) {
            addCellSolid(area, x + ox, z + oz, 0, 0);
          }
        }
        x += dx;
        z += dz;
      }
    };

    if (Math.random() < 0.5) {
      carveLine(x1, z1, x2, z1);
      carveLine(x2, z1, x2, z2);
    } else {
      carveLine(x1, z1, x1, z2);
      carveLine(x1, z2, x2, z2);
    }
  }

  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1];
    const b = rooms[i];
    carveCorridor(a.cx, a.cz, b.cx, b.cz);
  }

  // Ground + walls
  buildGround(area, TEX.concrete, 0x242429);
  buildSolidsMesh(area, CFG.pocket.wallH, TEX.concrete, 0x2b2b30);

  // Place props and posters inside carved spaces
  const size = area.size;

  for (let z = 2; z < size - 2; z++) {
    for (let x = 2; x < size - 2; x++) {
      if (area.solids[idxOf(size, x, z)] === 1) continue;

      const pos = cellToWorld(area, x, z, 0);

      // more beds + nails inside
      if (Math.random() < 0.06) addInst(INST.beds, pos.x, 0.28, pos.z, Math.random() * Math.PI * 2);
      if (Math.random() < 0.14) {
        const n = 1 + randInt(5);
        for (let i = 0; i < n; i++) addInst(INST.nails, pos.x + (Math.random() - 0.5) * 0.8, 0.35, pos.z + (Math.random() - 0.5) * 0.8, Math.random() * Math.PI);
      }

      // rubble
      if (Math.random() < 0.12) addInst(INST.rubble, pos.x, 0.4, pos.z, Math.random() * Math.PI, 0.9, 0.9, 0.9);

      // posters
      if (Math.random() < 0.11) {
        const tex = Math.random() < 0.5 ? ASSETS.tex.image1 : ASSETS.tex.image2;
        spawnPoster(area, x, z, tex, true);
      }

      // notes
      if (Math.random() < 0.05) {
        spawnNote(area, x, z, "POCKET NOTE", `The corridor is a pocket.\nThe pocket is a mouth.\n\n${STATE.name}, do not let the lights learn you.`, true);
      }

      // pickups
      if (Math.random() < 0.045) {
        const t = Math.random();
        if (t < 0.22) spawnPickup(area, "med", x, z);
        else if (t < 0.62) spawnPickup(area, "charge", x, z);
        else spawnPickup(area, "cursed", x, z);
      }
    }
  }

  // Keys to unlock exit/doors
  let placedKeys = 0;
  for (let tries = 0; tries < 6000 && placedKeys < CFG.pocket.keyCount; tries++) {
    const x = 2 + randInt(size - 4);
    const z = 2 + randInt(size - 4);
    if (area.solids[idxOf(size, x, z)] === 0) {
      spawnPickup(area, "key", x, z);
      placedKeys++;
    }
  }

  // Place some locked doors in corridors for “mysterious pathways”
  for (let i = 0; i < 20; i++) {
    const x = 3 + randInt(size - 6);
    const z = 3 + randInt(size - 6);
    if (area.solids[idxOf(size, x, z)] === 0) {
      // prefer near walls for door vibe
      const nearWall =
        area.solids[idxOf(size, x + 1, z)] === 1 ||
        area.solids[idxOf(size, x - 1, z)] === 1 ||
        area.solids[idxOf(size, x, z + 1)] === 1 ||
        area.solids[idxOf(size, x, z - 1)] === 1;

      if (!nearWall) continue;
      spawnDoor(area, x, z, "pocketDoor");
    }
  }

  // Exit door: locked until you have enough keys
  // choose a room edge cell
  let exitPlaced = false;
  for (let tries = 0; tries < 7000 && !exitPlaced; tries++) {
    const r = rooms[(Math.random() * rooms.length) | 0];
    if (!r) break;
    const x = r.x + 1 + randInt(Math.max(1, r.w - 2));
    const z = r.z + 1 + randInt(Math.max(1, r.h - 2));
    if (area.solids[idxOf(size, x, z)] === 0) {
      spawnDoor(area, x, z, "exitDoor");
      // mark exit door locked until keys collected
      const d = area.doors[area.doors.length - 1];
      d.locked = true;
      area.exitCell = { x, z };
      exitPlaced = true;
    }
  }

  // Spawn enemies in pocket
  for (let i = 0; i < CFG.enemyCountPocket; i++) spawnEnemy(area, Math.random() < 0.7 ? "fiend" : "npc");
}

/* =====================================================================================
   21) ENTER / EXIT POCKET CORRIDORS
===================================================================================== */

function enterPocket() {
  // generate fresh pocket each time (always different)
  STATE.inPocket = true;
  STATE.keys = 0;
  STATE.objective = `COLLECT KEYS (0/${CFG.pocket.keyCount}) • FIND EXIT`;
  setBars();

  generatePocket();

  // move player to a carved cell near first room
  const area = WORLD.pocket;
  // find open cell
  for (let tries = 0; tries < 10000; tries++) {
    const x = 2 + randInt(area.size - 4);
    const z = 2 + randInt(area.size - 4);
    if (area.solids[idxOf(area.size, x, z)] === 0) {
      const p = cellToWorld(area, x, z, CFG.playerHeight);
      player.pos.set(p.x, CFG.playerHeight, p.z);
      camera.position.set(p.x, CFG.playerHeight, p.z);
      break;
    }
  }

  speakOnce("Pocket corridor engaged.");
}

// Exit door unlock check
function updateExitUnlock(area) {
  if (!STATE.inPocket) return;
  if (!area.exitCell) return;

  const exitDoor = area.doors.find(d => d.kind === "exitDoor");
  if (!exitDoor) return;

  if (STATE.keys >= CFG.pocket.keyCount) {
    exitDoor.locked = false;
    STATE.objective = "EXIT IS OPEN • LEAVE";
    setBars();
  } else {
    exitDoor.locked = true;
  }
}

/* =====================================================================================
   22) INTERACT KEY + DOOR TEXT FIXUP
===================================================================================== */

function interactText(area) {
  if (!STATE.currentInteract) return null;
  const t = STATE.currentInteract.text;
  return (typeof t === "function") ? t() : t;
}

function doInteract(area) {
  if (!INPUT.interact) return;
  INPUT.interact = false;
  if (!STATE.currentInteract) return;

  try {
    STATE.currentInteract.action();
  } catch (e) {
    console.warn("Interact failed:", e);
  }
}

/* =====================================================================================
   23) NAME DRIP UPDATE + APPLY TO MATERIALS
===================================================================================== */

function updateNameDrip(dt) {
  // animate texture
  NAME_DRIP.draw(STATE.time);
  NAME_DRIP.tex.needsUpdate = true;
}

/* =====================================================================================
   24) PERFORMANCE: dynamic resolution controller
===================================================================================== */

let frameCount = 0;
let fpsTimer = 0;

function updateFPS(dt) {
  fpsTimer += dt;
  frameCount++;
  if (fpsTimer >= 0.5) {
    const fps = frameCount / fpsTimer;
    STATE.fps = fps;
    STATE.fpsSmoothed = lerp(STATE.fpsSmoothed, fps, 0.35);

    frameCount = 0;
    fpsTimer = 0;

    if (CFG.useDynamicResolution) {
      // if FPS too low, increase pixelScale (lower res). If high, decrease pixelScale.
      const target = 55;
      const diff = target - STATE.fpsSmoothed;

      if (diff > 10) {
        STATE.dynResScale = clamp(STATE.dynResScale + 0.12, CFG.dynamicResMin, CFG.dynamicResMax);
        makePS2Pass();
      } else if (diff < -12) {
        STATE.dynResScale = clamp(STATE.dynResScale - 0.08, CFG.dynamicResMin, CFG.dynamicResMax);
        makePS2Pass();
      }
    }
  }
}

/* =====================================================================================
   25) MAIN LOOP
===================================================================================== */

const clock = new THREE.Clock();
let acc = 0;
let lastFrameTime = 0;

function renderPS2(dt) {
  ps2Mat.uniforms.time.value = STATE.time;
  ps2Mat.uniforms.glitch.value = STATE.glitch;

  // render world to low-res RT
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);

  // render RT to screen
  renderer.setRenderTarget(null);
  renderer.render(ps2Scene, ps2Cam);
}

function tick() {
  requestAnimationFrame(tick);

  if (!STATE.playing) return;
  if (STATE.paused) return;

  // optional FPS cap
  const now = performance.now();
  if (CFG.maxFPSCap > 0) {
    const minFrame = 1000 / CFG.maxFPSCap;
    if (now - lastFrameTime < minFrame) return;
    lastFrameTime = now;
  }

  const dtRaw = Math.min(0.05, clock.getDelta());
  const dt = dtRaw;

  STATE.time += dt;
  STATE.glitch = computeGlitch();

  const area = areaGet();

  updateFPS(dt);

  updateNameDrip(dt);
  updateLighting(dt);
  setFearFromSanity();

  updateRain(dt);

  updatePlayer(area, dt);
  updateEnemies(area, dt);

  updateExitUnlock(area);

  updateLookTriggers(area, dt);
  updateInteraction(area);
  doInteract(area);

  quickUse();
  fireWeapon(area, dt);

  // small per-frame special effects based on glitch
  if (STATE.glitch > 0.1) {
    const g = STATE.glitch;
    // camera micro roll jitter at high glitch
    camera.rotation.z = (Math.random() - 0.5) * 0.02 * g * g;
  } else {
    camera.rotation.z = 0;
  }

  // minimap
  drawMinimap(area);

  // keep bars fresh
  setBars();

  renderPS2(dt);
}

/* =====================================================================================
   26) START / RESET FLOW
===================================================================================== */

UI.howBtn.addEventListener("click", () => {
  speakOnce("WASD. Doors. Keys. The map lies when you are afraid.");
});

UI.startBtn.addEventListener("click", async () => {
  // name
  const nm = (UI.nameInput.value || "DEFER").trim().slice(0, 18);
  STATE.name = nm.length ? nm : "DEFER";

  // rebuild name drip texture
  NAME_DRIP = makeNameDripTexture(STATE.name);

  // audio
  await ensureAudio();
  try { await AUDIO.ctx?.resume?.(); } catch (e) { /* ignore */ }

  // load assets
  if (!ASSETS.ready) await loadAssets();

  // init instancing and rain
  initInstancedProps();
  if (!rain) makeRain();

  // reset state
  STATE.hp = 100;
  STATE.sanity = 100;
  STATE.ammo = CFG.weaponStartAmmo;
  STATE.weaponIndex = 0;
  STATE.quickItem = null;
  STATE.hasKey = false;
  STATE.keys = 0;
  STATE.inPocket = false;
  STATE.objective = "FIND A KEY • ENTER A POCKET CORRIDOR • REACH THE EXIT";
  STATE.exitUnlocked = false;
  setBars();

  // build world
  generateSurface();

  // spawn position: find empty cell
  const area = WORLD.surface;
  for (let tries = 0; tries < 8000; tries++) {
    const x = 2 + randInt(area.size - 4);
    const z = 2 + randInt(area.size - 4);
    if (area.solids[idxOf(area.size, x, z)] === 0) {
      const p = cellToWorld(area, x, z, CFG.playerHeight);
      player.pos.set(p.x, CFG.playerHeight, p.z);
      camera.position.set(p.x, CFG.playerHeight, p.z);
      break;
    }
  }

  // Start
  UI.start.style.display = "none";
  UI.death.style.display = "none";
  UI.pause.style.display = "none";
  UI.note.style.display = "none";

  STATE.playing = true;
  STATE.paused = false;

  // lock pointer
  document.body.requestPointerLock?.();

  // intro whisper
  setTimeout(() => speakOnce(`${STATE.name}. Sector zero welcomes you.`), 500);

  tick();
});

UI.resumeBtn.addEventListener("click", () => pauseGame(false));
UI.restartBtn.addEventListener("click", () => location.reload());

/* =====================================================================================
   27) RESIZE HANDLING
===================================================================================== */

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  makePS2Pass();
});

/* =====================================================================================
   28) UTILS / EXTRA “EASTER EGGS”
===================================================================================== */

// Periodic easter eggs based on sanity
setInterval(() => {
  if (!STATE.playing || STATE.paused) return;

  if (STATE.sanity < 55 && Math.random() < 0.33) {
    speakOnce(`${STATE.name}… stop trusting the minimap.`);
  }
  if (STATE.sanity < 35 && Math.random() < 0.25) {
    speakOnce("The corridor generator is awake.");
  }
}, 7000);

// Rare: inject a cursed quick item
setInterval(() => {
  if (!STATE.playing || STATE.paused) return;
  if (STATE.quickItem) return;
  if (Math.random() < 0.15) {
    STATE.quickItem = Math.random() < 0.55 ? "med" : "cursed";
  }
}, 11000);

/* =====================================================================================
   29) FIX: keep interaction text accurate (function-based)
===================================================================================== */

(function patchInteractionTicker(){
  setInterval(() => {
    if (!STATE.playing || STATE.paused) return;
    const area = areaGet();
    if (STATE.currentInteract) {
      const t = interactText(area);
      if (t) UI.interaction.textContent = `[E] ${t}`;
    }
  }, 120);
})();
