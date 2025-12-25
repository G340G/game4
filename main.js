import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

// ---------------------------
// CONFIG
// ---------------------------
const CFG = {
  seed: (Math.random() * 1e9) | 0,
  mapSize: 44,
  cell: 4.0,
  worldY: 0,

  // performance knobs
  maxParticles: 4500,        // (was 10000) keep smooth
  instancedTrees: 220,
  instancedDeadTrees: 120,
  instancedNails: 320,
  instancedDebris: 260,

  enemyCount: 8,
  npcCount: 4,
  itemCount: 18,
  posterCount: 22,
  doorCount: 8,

  player: {
    height: 1.72,
    radius: 0.35,
    walk: 4.2,
    run: 6.4,
    jump: 6.6,
    gravity: 18.0,
    mouse: 0.0022,
    mouseSmoothing: 0.65,
  },

  interactDist: 3.2,
  enemy: {
    speedMin: 1.35,
    speedMax: 2.35,
    aggroDist: 22,
    hitDist: 1.35,
    damageHP: 12,
    damageSAN: 6,
  },

  sanity: {
    decayPerSec: 0.55,         // time decay
    creepyNotePenalty: 8,
    wallImagePenalty: 14,
    tvWhisperPenalty: 6,
    regainSmall: 6,
  }
};

// ---------------------------
// DOM
// ---------------------------
const mount = document.getElementById("mount");
const uiCross = document.getElementById("crosshair");
const hint = document.getElementById("interactHint");
const hpFill = document.getElementById("hpFill");
const sanFill = document.getElementById("sanFill");
const objective = document.getElementById("objective");
const pickup = document.getElementById("pickup");

const startScreen = document.getElementById("start");
const startBtn = document.getElementById("startBtn");
const playerNameInput = document.getElementById("playerName");

const deathScreen = document.getElementById("death");
const deathReason = document.getElementById("deathReason");
const respawnBtn = document.getElementById("respawnBtn");

const notePanel = document.getElementById("note");
const noteTitle = document.getElementById("noteTitle");
const noteBody = document.getElementById("noteBody");
const noteClose = document.getElementById("noteClose");

const mapCanvas = document.getElementById("minimap");
const mapCtx = mapCanvas.getContext("2d", { alpha: true });

// ---------------------------
// STATE
// ---------------------------
const S = {
  running: false,
  locked: false,
  time: 0,
  dt: 0,
  hp: 100,
  san: 100,
  name: "DEFER",
  keyFound: false,
  glitch: 0,                 // 0..1
  fear: 0,                   // sanity inverse
  flashlightOn: true,

  inventory: [],
  equipped: null,            // { id, type }
  msgCooldown: 0,

  // for stable mouse
  yaw: 0,
  pitch: 0,
  targetYaw: 0,
  targetPitch: 0,

  // movement
  move: { f:0, b:0, l:0, r:0, run:0, jump:0 },
  vel: new THREE.Vector3(),
  onGround: false,

  // interactions
  currentTarget: null,

  // minimap lying
  mapLie: 0,

  // audio
  audio: { ctx: null, node: null, gain: null, ok: false },

  // tts
  ttsReady: "speechSynthesis" in window
};

// ---------------------------
// RNG
// ---------------------------
function mulberry32(a){
  return function(){
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(CFG.seed);
const r01 = () => rnd();
const rSign = () => (r01() < 0.5 ? -1 : 1);
const rRange = (a,b) => a + (b-a)*r01();
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const lerp = (a,b,t) => a + (b-a)*t;

// ---------------------------
// THREE CORE
// ---------------------------
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.08,
  180
);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
  alpha: false,
  stencil: false,
  depth: true
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
mount.appendChild(renderer.domElement);

// PS2-ish: slightly lower internal sharpness via post
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// cheap film/noise + vignette + mild chroma warp (single pass)
const CRTShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    fear: { value: 0 },
    glitch: { value: 0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float fear;
    uniform float glitch;
    varying vec2 vUv;

    float hash(vec2 p){
      return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123);
    }

    void main(){
      vec2 uv = vUv;

      // mild barrel distortion increases with fear
      vec2 p = uv * 2.0 - 1.0;
      float k = 0.06 + fear * 0.16;
      p *= 1.0 + k * dot(p,p);
      uv = (p * 0.5 + 0.5);

      // scanlines
      float scan = sin((uv.y + time*0.15) * 900.0) * 0.02;
      float scan2 = sin((uv.y + time*0.05) * 220.0) * 0.015;

      // chroma shift (fear+glitch)
      float c = (fear*0.006 + glitch*0.02);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + vec2(c,0.0)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - vec2(c,0.0)).b;

      // noise
      float n = hash(uv * (900.0 + fear*1200.0) + time) - 0.5;
      col += n * (0.06 + fear*0.12);

      col += scan + scan2;

      // vignette (fear stronger)
      float v = smoothstep(1.2, 0.25, length(uv - 0.5));
      col *= (0.75 + 0.25*v);
      col *= (1.0 - fear*0.18);

      // rare tear glitch
      if (glitch > 0.4) {
        float y = floor(uv.y * 80.0) / 80.0;
        float t = hash(vec2(y, time)) * 0.08 * glitch;
        col = texture2D(tDiffuse, uv + vec2(t,0.0)).rgb;
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `
};
const crtPass = new ShaderPass(CRTShader);
composer.addPass(crtPass);

// ---------------------------
// LIGHTING: starts brighter -> darker with sanity
// ---------------------------
scene.background = new THREE.Color(0x273040);

const hemi = new THREE.HemisphereLight(0xbfd0ff, 0x1a2230, 0.9);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xe7f1ff, 0.85);
keyLight.position.set(30, 60, 18);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -50;
keyLight.shadow.camera.right = 50;
keyLight.shadow.camera.top = 50;
keyLight.shadow.camera.bottom = -50;
scene.add(keyLight);

const fillLight = new THREE.PointLight(0xa9d2ff, 0.35, 35);
fillLight.position.set(15, 8, 15);
scene.add(fillLight);

// flashlight
const flashlight = new THREE.SpotLight(0xffffff, 1.55, 26, Math.PI/7, 0.5, 1);
flashlight.castShadow = false;
scene.add(flashlight);
const flashlightTarget = new THREE.Object3D();
scene.add(flashlightTarget);
flashlight.target = flashlightTarget;

// fog: ramps with fear
scene.fog = new THREE.FogExp2(0x1a2030, 0.012);

// ---------------------------
// TEXTURES (your images + procedural)
// ---------------------------
const loader = new THREE.TextureLoader();

function tex(path, opts = {}) {
  const t = loader.load(path);
  t.wrapS = t.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// your images
const T = {
  back: tex("./assets/back.png"),
  back2: tex("./assets/back2.png"),
  object1: tex("./assets/object1.png"),
  npc: tex("./assets/npc.png"),
  npc3: tex("./assets/npc3.png"),
  fiend: tex("./assets/fiend.png"),
  sh2: tex("./assets/Schermata 2025-12-25 alle 16.41.47.png"),
  wallScare1: tex("./assets/image.png"),
  wallScare2: tex("./assets/image2.png"),
};

// procedural “PS2 concrete / asphalt”
function makeCanvasTex(drawFn, size=256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  drawFn(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.anisotropy = 4;
  return t;
}

const P = {
  asphalt: makeCanvasTex((g,s)=>{
    g.fillStyle="#2b2f36"; g.fillRect(0,0,s,s);
    for(let i=0;i<12000;i++){
      const x=(r01()*s)|0, y=(r01()*s)|0;
      const v=(r01()*60)|0;
      g.fillStyle=`rgba(${30+v},${30+v},${38+v},0.35)`;
      g.fillRect(x,y,1,1);
    }
    // faint cracks
    g.strokeStyle="rgba(0,0,0,0.35)";
    g.lineWidth=2;
    for(let i=0;i<12;i++){
      g.beginPath();
      g.moveTo(r01()*s, r01()*s);
      for(let k=0;k<6;k++) g.lineTo(r01()*s, r01()*s);
      g.stroke();
    }
  }),
  concrete: makeCanvasTex((g,s)=>{
    g.fillStyle="#5a616a"; g.fillRect(0,0,s,s);
    for(let i=0;i<16000;i++){
      const x=(r01()*s)|0, y=(r01()*s)|0;
      const v=(r01()*90)|0;
      g.fillStyle=`rgba(${70+v},${75+v},${80+v},0.22)`;
      g.fillRect(x,y,1,1);
    }
    g.fillStyle="rgba(0,0,0,0.12)";
    for(let i=0;i<200;i++){
      g.fillRect(r01()*s, r01()*s, rRange(8,28), rRange(2,6));
    }
  }),
  moss: makeCanvasTex((g,s)=>{
    g.fillStyle="#2b3a2a"; g.fillRect(0,0,s,s);
    for(let i=0;i<14000;i++){
      const x=(r01()*s)|0, y=(r01()*s)|0;
      const v=(r01()*70)|0;
      g.fillStyle=`rgba(${20+v},${60+v},${25+v},0.18)`;
      g.fillRect(x,y,1,1);
    }
  }),
};

// sky “SH2 vibe” blending your sh2 + back2
const skyGeo = new THREE.SphereGeometry(90, 28, 18);
skyGeo.scale(-1,1,1);
const skyMat = new THREE.MeshBasicMaterial({
  map: T.sh2,
  transparent: false
});
const sky = new THREE.Mesh(skyGeo, skyMat);
scene.add(sky);

// ---------------------------
// WORLD REGISTRIES
// ---------------------------
const colliders = [];      // simplified collider boxes: { min, max }
const interactables = [];  // { id, mesh, radius, textFn, action }
const decals = [];         // wall name decals
const enemies = [];        // sprite monsters
const npcs = [];           // sprite npcs
const items = [];          // pickups

// grid occupancy for cheap collision
const grid = {
  w: CFG.mapSize,
  h: CFG.mapSize,
  a: new Uint8Array(CFG.mapSize * CFG.mapSize),
  idx(x,z){ return x + z*CFG.mapSize; },
  in(x,z){ return x>=0 && z>=0 && x<CFG.mapSize && z<CFG.mapSize; },
  get(x,z){ return this.a[this.idx(x,z)]; },
  set(x,z,v){ this.a[this.idx(x,z)] = v; }
};

// cell values
const CELL = {
  EMPTY: 0,
  ROAD: 1,
  SOLID: 2,
  DOOR: 3
};

// ---------------------------
// GEOMETRY / MATERIALS
// ---------------------------
const mat = {
  ground: new THREE.MeshStandardMaterial({ map: P.moss, roughness: 1.0, metalness: 0.0 }),
  road: new THREE.MeshStandardMaterial({ map: P.asphalt, roughness: 0.95, metalness: 0.05 }),
  concrete: new THREE.MeshStandardMaterial({ map: P.concrete, roughness: 0.92, metalness: 0.02 }),
  wall: new THREE.MeshStandardMaterial({ map: P.concrete, roughness: 0.95 }),
  door: new THREE.MeshStandardMaterial({ map: P.concrete, roughness: 0.9, metalness: 0.05, color: 0x7b6a5a }),
  bed: new THREE.MeshStandardMaterial({ color: 0x6e7685, roughness: 0.9 }),
  rusty: new THREE.MeshStandardMaterial({ color: 0x5a2a1f, roughness: 0.85, metalness: 0.25 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x3d2c1f, roughness: 0.95 }),
};

// “poster” materials from your images, randomized
const posterTex = [T.back, T.back2, T.object1, T.npc3, T.sh2, T.wallScare1, T.wallScare2];
function makePosterMat(){
  const t = posterTex[(r01()*posterTex.length)|0];
  const m = new THREE.MeshBasicMaterial({
    map: t,
    transparent: true,
    opacity: 0.95
  });
  return m;
}

// sprite helpers
function makeSprite(texture, scale=2.4){
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(scale, scale, 1);
  return sp;
}

// ---------------------------
// PLAYER “RIG” (stable mouse)
// ---------------------------
const rig = new THREE.Object3D();
rig.position.set(6, CFG.player.height, 6);
scene.add(rig);

const head = new THREE.Object3D();
rig.add(head);
head.add(camera);

function updateCameraFromState(){
  // smoothing
  S.yaw = lerp(S.yaw, S.targetYaw, 1 - Math.pow(S.mouseSmoothing(), S.dt*60));
}

// We’ll implement smoothing manually (stable)
S.mouseSmoothing = () => CFG.player.mouseSmoothing;

// ---------------------------
// AUDIO WORKLET + TTS
// ---------------------------
async function ensureAudio(){
  if (S.audio.ok) return;
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.audioWorklet.addModule("./audio-worklet.js");
    const node = new AudioWorkletNode(ctx, "ominous-processor", { numberOfOutputs: 1, outputChannelCount: [2] });
    const gain = ctx.createGain();
    gain.gain.value = 0.16;
    node.connect(gain).connect(ctx.destination);
    S.audio = { ctx, node, gain, ok: true };
  }catch(err){
    console.warn("AudioWorklet failed:", err);
    S.audio.ok = false;
  }
}

function setFearAudio(fear){
  if (!S.audio.ok) return;
  const now = S.audio.ctx.currentTime;
  S.audio.node.parameters.get("fear").setTargetAtTime(fear, now, 0.05);
  S.audio.node.parameters.get("gain").setTargetAtTime(lerp(0.12, 0.22, fear), now, 0.08);
}

function speak(text){
  if (!S.ttsReady) return;
  try{
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.pitch = 0.72;
    u.volume = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }catch(_){}
}

// ---------------------------
// WORLD BUILD
// ---------------------------
let worldGroup = null;

function clearWorld(){
  if (worldGroup) scene.remove(worldGroup);
  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  colliders.length = 0;
  interactables.length = 0;
  decals.length = 0;
  enemies.length = 0;
  npcs.length = 0;
  items.length = 0;
  grid.a.fill(0);

  S.keyFound = false;
  objective.textContent = "OBJECTIVE: FIND THE SERVER ROOM KEY";
}

function cellToWorld(x,z){
  return new THREE.Vector3(x*CFG.cell, 0, z*CFG.cell);
}

function addColliderBox(center, half){
  colliders.push({
    min: new THREE.Vector3(center.x - half.x, center.y - half.y, center.z - half.z),
    max: new THREE.Vector3(center.x + half.x, center.y + half.y, center.z + half.z),
  });
}

function carveRoads(){
  for(let x=2; x<CFG.mapSize; x+=4){
    for(let z=0; z<CFG.mapSize; z++) grid.set(x,z, CELL.ROAD);
  }
  for(let z=2; z<CFG.mapSize; z+=4){
    for(let x=0; x<CFG.mapSize; x++) grid.set(x,z, CELL.ROAD);
  }
}

// ground + roads
function buildGround(){
  const size = CFG.mapSize*CFG.cell;

  const groundGeo = new THREE.PlaneGeometry(size, size, 1, 1);
  const ground = new THREE.Mesh(groundGeo, mat.ground);
  ground.rotation.x = -Math.PI/2;
  ground.position.set(size/2, CFG.worldY, size/2);
  ground.receiveShadow = true;
  worldGroup.add(ground);

  // roads: instanced tiles
  const tileGeo = new THREE.PlaneGeometry(CFG.cell, CFG.cell, 1, 1);
  tileGeo.rotateX(-Math.PI/2);

  const roadMat = mat.road;
  const inst = new THREE.InstancedMesh(tileGeo, roadMat, CFG.mapSize*CFG.mapSize);
  let n=0;
  const m4 = new THREE.Matrix4();

  for(let x=0;x<CFG.mapSize;x++){
    for(let z=0;z<CFG.mapSize;z++){
      if(grid.get(x,z) === CELL.ROAD){
        m4.makeTranslation(x*CFG.cell, CFG.worldY+0.01, z*CFG.cell);
        inst.setMatrixAt(n++, m4);
      }
    }
  }
  inst.count = n;
  inst.receiveShadow = true;
  worldGroup.add(inst);
}

function buildCityBlocks(){
  // a few larger “structures” + posters + props
  for(let x=0;x<CFG.mapSize;x++){
    for(let z=0;z<CFG.mapSize;z++){
      if(grid.get(x,z) === CELL.ROAD) continue;

      const wx = x*CFG.cell;
      const wz = z*CFG.cell;

      const roll = r01();

      if(roll > 0.84){
        spawnBuilding(wx, wz);
        grid.set(x,z, CELL.SOLID);
      }else if(roll > 0.76){
        spawnBed(wx, wz);
      }else if(roll > 0.72){
        spawnPoster(wx, wz);
      }
    }
  }
}

// more refined building: stacked boxes + trims
function spawnBuilding(x,z){
  const h = rRange(6, 16);
  const geo = new THREE.BoxGeometry(3.6, h, 3.6, 2, 3, 2);
  const m = mat.concrete.clone();
  m.map = P.concrete;
  const b = new THREE.Mesh(geo, m);
  b.position.set(x, h/2, z);
  b.castShadow = true;
  b.receiveShadow = true;
  worldGroup.add(b);

  // trim
  const trimGeo = new THREE.BoxGeometry(3.9, 0.25, 3.9);
  const trim = new THREE.Mesh(trimGeo, mat.rusty);
  trim.position.set(x, h-0.4, z);
  trim.castShadow = true;
  worldGroup.add(trim);

  addColliderBox(b.position, new THREE.Vector3(1.9, h/2, 1.9));
}

function spawnBed(x,z){
  // quick “PS2 bed” with more polys than a cube
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.55, 1.4, 2, 1, 2), mat.bed);
  frame.position.set(x, 0.28, z);
  frame.castShadow = true;
  frame.receiveShadow = true;

  const mattress = new THREE.Mesh(new THREE.BoxGeometry(2.55, 0.35, 1.35, 3, 1, 3),
    new THREE.MeshStandardMaterial({ color: 0xb9b9c6, roughness: 0.95 })
  );
  mattress.position.set(0, 0.45, 0);
  frame.add(mattress);

  // random stain
  if(r01() > 0.55){
    const stain = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8), makePosterMat());
    stain.rotation.x = -Math.PI/2;
    stain.position.set(rRange(-0.4,0.4), 0.32, rRange(-0.2,0.2));
    stain.material.opacity = 0.65;
    frame.add(stain);
  }

  worldGroup.add(frame);
  addColliderBox(new THREE.Vector3(x,0.4,z), new THREE.Vector3(1.35,0.6,0.8));

  if(r01() > 0.75){
    spawnItem(x + rRange(-1,1), z + rRange(-1,1), r01()>0.5 ? "PIPE" : "CALM_TAPE");
  }
}

function spawnPoster(x,z, forceScary=false){
  const g = new THREE.PlaneGeometry(1.8, 1.2);
  const m = forceScary ? new THREE.MeshBasicMaterial({ map: (r01()>0.5?T.wallScare1:T.wallScare2) }) : makePosterMat();
  const p = new THREE.Mesh(g, m);
  p.position.set(x + rRange(-0.6,0.6), rRange(1.2,2.2), z + rRange(-0.6,0.6));
  p.rotation.y = rRange(0, Math.PI*2);
  p.castShadow = false;
  worldGroup.add(p);

  // a “look trigger” for scary ones
  if(forceScary){
    interactables.push({
      id: "WALL_SCARE",
      mesh: p,
      radius: 1.2,
      textFn: () => "…IT LOOKS BACK",
      action: () => {
        applySanity(-CFG.sanity.wallImagePenalty);
        S.glitch = clamp(S.glitch + 0.45, 0, 1);
        if(S.msgCooldown<=0){
          speak(`${S.name}… do not read the surface.`);
          S.msgCooldown = 6;
        }
      },
      passiveLook: true
    });
  }

  return p;
}

// name decal with “cranberry drip”
function makeNameDecalTexture(text){
  const w=512,h=256;
  const c=document.createElement("canvas");
  c.width=w; c.height=h;
  const g=c.getContext("2d");
  g.fillStyle="rgba(0,0,0,0)";
  g.fillRect(0,0,w,h);

  // base text
  g.font="bold 86px 'Courier New', monospace";
  g.textAlign="center";
  g.textBaseline="middle";

  // shadow
  g.fillStyle="rgba(0,0,0,0.55)";
  g.fillText(text, w/2+4, h/2+4);

  // blood-ish cranberry
  const grad=g.createLinearGradient(0,h/2-60,0,h/2+90);
  grad.addColorStop(0,"rgba(160,0,30,0.95)");
  grad.addColorStop(1,"rgba(80,0,10,0.85)");
  g.fillStyle=grad;
  g.fillText(text, w/2, h/2);

  // drips
  for(let i=0;i<44;i++){
    const x = rRange(w*0.18, w*0.82);
    const y = h/2 + rRange(12, 26);
    const len = rRange(12, 120) * (r01()>0.7 ? 1.6 : 1);
    g.strokeStyle=`rgba(${120+r01()*60|0},0,${10+r01()*20|0},${0.35+r01()*0.35})`;
    g.lineWidth=rRange(2,6);
    g.beginPath();
    g.moveTo(x,y);
    g.lineTo(x + rRange(-6,6), y+len);
    g.stroke();
  }

  // speckle
  for(let i=0;i<6000;i++){
    const x=(r01()*w)|0, y=(r01()*h)|0;
    if(r01() < 0.08){
      g.fillStyle="rgba(120,0,20,0.10)";
      g.fillRect(x,y,1,1);
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function spawnNameOnWall(x,z){
  const tex = makeNameDecalTexture(S.name);
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92 });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), m);
  plane.position.set(x, 1.8, z);
  plane.rotation.y = rRange(0, Math.PI*2);
  worldGroup.add(plane);
  decals.push(plane);
}

function spawnDoor(x,z, label, toPocket=true){
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3.2, 0.2, 2, 6, 1), mat.door);
  door.position.set(x, 1.6, z);
  door.rotation.y = rRange(0, Math.PI*2);
  door.castShadow = true;
  worldGroup.add(door);

  addColliderBox(new THREE.Vector3(x,1.6,z), new THREE.Vector3(0.9,1.7,0.25));

  interactables.push({
    id: "DOOR",
    mesh: door,
    radius: 1.0,
    textFn: () => `OPEN ${label}`,
    action: () => {
      // “swing” + optional pocket teleport
      const sign = r01()>0.5 ? 1 : -1;
      const startRot = door.rotation.y;
      const targetRot = startRot + sign * (Math.PI/2);

      let t = 0;
      const tick = () => {
        t += 0.08;
        door.rotation.y = lerp(startRot, targetRot, clamp(t,0,1));
        if(t < 1) requestAnimationFrame(tick);
      };
      tick();

      // remove collider by NOT pushing player through it (cheap: move player)
      rig.position.add(new THREE.Vector3(Math.cos(targetRot),0,Math.sin(targetRot)).multiplyScalar(1.2));

      if(toPocket){
        enterPocketRoom(label);
      }
    }
  });
}

function enterPocketRoom(label){
  // a “mysterious pathway”: teleport to separate area outside city bounds
  const base = new THREE.Vector3(CFG.mapSize*CFG.cell + 18, 0, 18);
  rig.position.set(base.x, CFG.player.height, base.z);

  S.glitch = clamp(S.glitch + 0.25, 0, 1);
  applySanity(-4);

  if(S.msgCooldown<=0){
    speak(`${S.name}. ${label} opens into a corridor that remembers you.`);
    S.msgCooldown = 7;
  }

  // spawn a few props in pocket if not already
  if(!scene.getObjectByName("pocket")){
    const pocket = new THREE.Group();
    pocket.name = "pocket";

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60,60), mat.concrete);
    floor.rotation.x = -Math.PI/2;
    floor.position.copy(base).add(new THREE.Vector3(20,0,20));
    floor.receiveShadow = true;
    pocket.add(floor);

    // corridor walls
    const wallMat = mat.wall.clone();
    wallMat.map = P.concrete;
    const wallGeo = new THREE.BoxGeometry(60, 6, 1);
    const w1 = new THREE.Mesh(wallGeo, wallMat); w1.position.copy(floor.position).add(new THREE.Vector3(0,3,-30)); pocket.add(w1);
    const w2 = new THREE.Mesh(wallGeo, wallMat); w2.position.copy(floor.position).add(new THREE.Vector3(0,3,30)); pocket.add(w2);
    const w3 = new THREE.Mesh(new THREE.BoxGeometry(1,6,60), wallMat); w3.position.copy(floor.position).add(new THREE.Vector3(-30,3,0)); pocket.add(w3);
    const w4 = new THREE.Mesh(new THREE.BoxGeometry(1,6,60), wallMat); w4.position.copy(floor.position).add(new THREE.Vector3(30,3,0)); pocket.add(w4);

    // posters (more intense)
    for(let i=0;i<10;i++){
      const px = floor.position.x + rRange(-24,24);
      const pz = floor.position.z + rRange(-24,24);
      spawnPoster(px, pz, r01()>0.55);
    }

    scene.add(pocket);
  }
}

function spawnTV(x,z){
  // body
  const tv = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 0.85, 2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9, metalness: 0.05 })
  );
  tv.position.set(x, 0.55, z);
  tv.castShadow = true;
  worldGroup.add(tv);

  // screen: dynamic canvas texture
  const scrC = document.createElement("canvas");
  scrC.width = 256; scrC.height = 192;
  const g = scrC.getContext("2d");
  const scrT = new THREE.CanvasTexture(scrC);
  const scrM = new THREE.MeshBasicMaterial({ map: scrT });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.68), scrM);
  screen.position.set(0, 0.05, 0.45);
  tv.add(screen);

  // light flicker
  const light = new THREE.PointLight(0xaadfff, 0.7, 3.5);
  light.position.set(0, 0.05, 0.8);
  tv.add(light);

  function drawTV(){
    // noisy frames + name insertion
    g.fillStyle = "rgb(5,5,8)";
    g.fillRect(0,0,256,192);

    // pick a random source image occasionally
    const src = posterTex[(r01()*posterTex.length)|0];
    try{
      // draw source with jitter
      const jx = (rSign()*rRange(0,12))|0;
      const jy = (rSign()*rRange(0,8))|0;
      g.globalAlpha = 0.9;
      g.drawImage(src.image, jx-10, jy-8, 276, 208);
    }catch(_){}

    // scanline + static
    g.globalAlpha = 0.25;
    for(let y=0;y<192;y+=2){
      g.fillStyle = `rgba(0,0,0,${0.14 + r01()*0.12})`;
      g.fillRect(0,y,256,1);
    }
    g.globalAlpha = 0.18;
    for(let i=0;i<4500;i++){
      const x=(r01()*256)|0, y=(r01()*192)|0;
      const v=(r01()*255)|0;
      g.fillStyle = `rgba(${v},${v},${v},0.45)`;
      g.fillRect(x,y,1,1);
    }

    // name message
    g.globalAlpha = 0.95;
    g.font = "bold 22px 'Courier New', monospace";
    g.fillStyle = "rgba(255,220,90,0.85)";
    g.fillText(S.name, 10, 26);

    // ominous caption
    g.globalAlpha = 0.85;
    g.font = "14px 'Courier New', monospace";
    g.fillStyle = "rgba(255,255,255,0.75)";
    const captions = [
      "DO NOT TRUST THE MAP",
      "THE SKY IS A RECORDING",
      "BREATHING IS OPTIONAL",
      "RUNNING MAKES IT HEAR YOU",
      "SOMETHING BORROWED YOUR NAME"
    ];
    g.fillText(captions[(r01()*captions.length)|0], 10, 46);

    scrT.needsUpdate = true;
  }

  // update function stored
  tv.userData = { drawTV, light };

  interactables.push({
    id: "TV",
    mesh: tv,
    radius: 1.2,
    textFn: () => "LISTEN",
    action: () => {
      drawTV();
      applySanity(-CFG.sanity.tvWhisperPenalty);
      S.glitch = clamp(S.glitch + 0.22, 0, 1);
      if(S.msgCooldown<=0){
        speak(`${S.name}. The television repeats you.`);
        S.msgCooldown = 5;
      }
    }
  });

  return tv;
}

function spawnItem(x,z, kind){
  const color = kind === "PIPE" ? 0x7a7a7a : (kind==="CALM_TAPE" ? 0x2aa8ff : 0x00ff7a);
  const mesh = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.22, 1),
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2, emissive: 0x090909 })
  );
  mesh.position.set(x, 0.3, z);
  mesh.castShadow = true;
  worldGroup.add(mesh);

  const label = kind === "PIPE" ? "RUSTY PIPE" : (kind==="CALM_TAPE" ? "CALMING TAPE" : "UNKNOWN OBJECT");

  interactables.push({
    id: "PICKUP",
    mesh,
    radius: 0.8,
    textFn: () => `TAKE ${label}`,
    action: () => {
      worldGroup.remove(mesh);
      S.inventory.push(kind);
      pickup.textContent = `PICKED UP: ${label}`;
      setTimeout(()=> pickup.textContent = " ", 1400);

      if(kind==="CALM_TAPE"){
        applySanity(+CFG.sanity.regainSmall);
      }
      if(kind==="PIPE"){
        S.equipped = { id:"PIPE", type:"WEAPON" };
      }
    }
  });

  items.push({ kind, mesh });
}

function spawnEnemySprite(x,z){
  const sp = makeSprite(T.fiend, 2.6);
  sp.position.set(x, 1.4, z);
  worldGroup.add(sp);

  enemies.push({
    mesh: sp,
    speed: rRange(CFG.enemy.speedMin, CFG.enemy.speedMax),
    phase: rRange(0, 10),
    hp: 100
  });
}

function spawnNPC(x,z){
  const t = r01()>0.5 ? T.npc : T.npc3;
  const sp = makeSprite(t, 2.2);
  sp.position.set(x, 1.25, z);
  worldGroup.add(sp);

  const questions = [
    { q:"You are happy. Confirm?", a:["YES","NO","I FORGOT"], good:0, bad:1 },
    { q:"Do you remember your first room?", a:["YES","NO","I WAS NEVER THERE"], good:1, bad:0 },
    { q:"If the map lies, do you?", a:["YES","NO","I AM THE MAP"], good:2, bad:0 }
  ];

  npcs.push({ mesh: sp, questions });

  interactables.push({
    id: "NPC",
    mesh: sp,
    radius: 1.3,
    textFn: () => "TALK",
    action: () => {
      const set = questions[(r01()*questions.length)|0];
      const pick = set.a[(r01()*set.a.length)|0];
      // pseudo “answer outcome”
      const creepy = (pick === "I FORGOT" || pick === "I WAS NEVER THERE" || pick === "I AM THE MAP");
      if(creepy){
        applySanity(-10);
        S.glitch = clamp(S.glitch + 0.25, 0, 1);
        speak(`${S.name}. ${pick}.`);
      } else {
        applySanity(+4);
        speak(`${S.name}. ${set.q}`);
      }
    }
  });
}

// ---------------------------
// INSTANCED PROPS: trees / dead trees / nails
// ---------------------------
function buildInstancedProps(){
  // tree geometry (more than cones)
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.22, 2.8, 8, 2);
  const leafGeo = new THREE.IcosahedronGeometry(0.95, 1);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1d, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x1d3b22, roughness: 1 });

  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.y = 1.4;
  const leaf = new THREE.Mesh(leafGeo, leafMat);
  leaf.position.y = 2.55;
  tree.add(trunk); tree.add(leaf);

  // bake group into single geometry via InstancedMesh? simplest: use two instanced meshes (trunks+leaves)
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, CFG.instancedTrees);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, CFG.instancedTrees);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();

  let n=0;
  while(n < CFG.instancedTrees){
    const x = (r01()*CFG.mapSize)|0;
    const z = (r01()*CFG.mapSize)|0;
    if(grid.get(x,z) === CELL.ROAD) continue;

    p.set(x*CFG.cell + rRange(-0.6,0.6), 0, z*CFG.cell + rRange(-0.6,0.6));
    q.setFromEuler(new THREE.Euler(0, rRange(0, Math.PI*2), 0));
    const sc = rRange(0.85, 1.35);
    s.set(sc, sc, sc);

    m4.compose(new THREE.Vector3(p.x, 1.4, p.z), q, new THREE.Vector3(sc, sc, sc));
    trunks.setMatrixAt(n, m4);

    m4.compose(new THREE.Vector3(p.x, 2.55, p.z), q, new THREE.Vector3(sc, sc, sc));
    leaves.setMatrixAt(n, m4);

    n++;
  }
  trunks.castShadow = true; leaves.castShadow = true;
  worldGroup.add(trunks); worldGroup.add(leaves);

  // dead trees
  const deadGeo = new THREE.CylinderGeometry(0.08, 0.2, 3.4, 7, 3);
  const deadMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 1 });
  const dead = new THREE.InstancedMesh(deadGeo, deadMat, CFG.instancedDeadTrees);
  n=0;
  while(n < CFG.instancedDeadTrees){
    const x=(r01()*CFG.mapSize)|0, z=(r01()*CFG.mapSize)|0;
    if(grid.get(x,z) === CELL.ROAD) continue;
    p.set(x*CFG.cell + rRange(-0.5,0.5), 1.7, z*CFG.cell + rRange(-0.5,0.5));
    q.setFromEuler(new THREE.Euler(rRange(-0.15,0.15), rRange(0, Math.PI*2), rRange(-0.15,0.15)));
    const sc=rRange(0.7,1.35);
    s.set(sc,sc,sc);
    m4.compose(p,q,s);
    dead.setMatrixAt(n++, m4);
  }
  dead.castShadow = true;
  worldGroup.add(dead);

  // nails (rusty spikes)
  const nailGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.9, 6, 1);
  const nail = new THREE.InstancedMesh(nailGeo, mat.rusty, CFG.instancedNails);
  n=0;
  while(n < CFG.instancedNails){
    const x=(r01()*CFG.mapSize)|0, z=(r01()*CFG.mapSize)|0;
    if(grid.get(x,z) === CELL.ROAD) continue;
    p.set(x*CFG.cell + rRange(-1,1), 0.45, z*CFG.cell + rRange(-1,1));
    q.setFromEuler(new THREE.Euler(rRange(-0.6,-0.2), rRange(0, Math.PI*2), rRange(-0.2,0.2)));
    const sc=rRange(0.8,1.6);
    s.set(sc,sc,sc);
    m4.compose(p,q,s);
    nail.setMatrixAt(n++, m4);
  }
  nail.castShadow = true;
  worldGroup.add(nail);
}

// ---------------------------
// WEATHER PARTICLES (snow-ish like your SH2 ref)
// ---------------------------
let snow = null;
function buildSnow(){
  const count = CFG.maxParticles;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count*3);

  const size = CFG.mapSize*CFG.cell;
  for(let i=0;i<count;i++){
    pos[i*3+0] = rRange(-10, size+10);
    pos[i*3+1] = rRange(0, 35);
    pos[i*3+2] = rRange(-10, size+10);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos,3));
  const matp = new THREE.PointsMaterial({ size: 0.08, color: 0xe8eef8, transparent: true, opacity: 0.75 });
  snow = new THREE.Points(geo, matp);
  worldGroup.add(snow);
}

function updateSnow(){
  if(!snow) return;
  const a = snow.geometry.attributes.position.array;
  const size = CFG.mapSize*CFG.cell;
  for(let i=0;i<CFG.maxParticles;i++){
    const iy = i*3+1;
    a[iy] -= (0.55 + S.fear*0.9);
    if(a[iy] < 0){
      a[iy] = rRange(18, 36);
      a[i*3+0] = rRange(-10, size+10);
      a[i*3+2] = rRange(-10, size+10);
    }
  }
  snow.geometry.attributes.position.needsUpdate = true;
}

// ---------------------------
// MAP / SPECIAL SPAWNS
// ---------------------------
function placeSpecials(){
  // TV cluster
  for(let i=0;i<6;i++){
    spawnTV(rRange(8, CFG.mapSize*CFG.cell - 8), rRange(8, CFG.mapSize*CFG.cell - 8));
  }

  // scary posters (explicit)
  for(let i=0;i<6;i++){
    spawnPoster(rRange(6, CFG.mapSize*CFG.cell - 6), rRange(6, CFG.mapSize*CFG.cell - 6), true);
  }

  // doors
  for(let i=0;i<CFG.doorCount;i++){
    spawnDoor(rRange(6, CFG.mapSize*CFG.cell - 6), rRange(6, CFG.mapSize*CFG.cell - 6), "PATHWAY", true);
  }

  // name decals sprinkled
  for(let i=0;i<12;i++){
    spawnNameOnWall(rRange(6, CFG.mapSize*CFG.cell - 6), rRange(6, CFG.mapSize*CFG.cell - 6));
  }

  // items
  for(let i=0;i<CFG.itemCount;i++){
    const kind = r01()>0.55 ? "PIPE" : "CALM_TAPE";
    spawnItem(rRange(6, CFG.mapSize*CFG.cell - 6), rRange(6, CFG.mapSize*CFG.cell - 6), kind);
  }

  // NPCs
  for(let i=0;i<CFG.npcCount;i++){
    spawnNPC(rRange(10, CFG.mapSize*CFG.cell - 10), rRange(10, CFG.mapSize*CFG.cell - 10));
  }

  // enemies
  for(let i=0;i<CFG.enemyCount;i++){
    spawnEnemySprite(rRange(10, CFG.mapSize*CFG.cell - 10), rRange(10, CFG.mapSize*CFG.cell - 10));
  }

  // “server room key” as an interactable note
  const keyMesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.22, 0.06, 64, 10), new THREE.MeshStandardMaterial({
    color: 0xffd84a, roughness: 0.35, metalness: 0.65, emissive: 0x151100
  }));
  keyMesh.position.set(CFG.mapSize*CFG.cell*0.62, 0.45, CFG.mapSize*CFG.cell*0.42);
  keyMesh.castShadow = true;
  worldGroup.add(keyMesh);

  interactables.push({
    id: "KEY",
    mesh: keyMesh,
    radius: 1.0,
    textFn: () => "TAKE SERVER KEY",
    action: () => {
      worldGroup.remove(keyMesh);
      S.keyFound = true;
      objective.textContent = "OBJECTIVE: FIND A DOOR AND ESCAPE";
      pickup.textContent = "YOU TOOK THE KEY. THE MAP HATES THAT.";
      setTimeout(()=> pickup.textContent=" ", 1600);
      applySanity(-6);
      S.glitch = clamp(S.glitch + 0.25, 0, 1);
      speak(`${S.name}. You took the key.`);
    }
  });

  // note system
  spawnNote(
    rRange(8, CFG.mapSize*CFG.cell - 8),
    rRange(8, CFG.mapSize*CFG.cell - 8),
    "WELCOME",
    "The city is glitching.\n\nFind food. Avoid red eyes.\nThe map remembers what you deny."
  );
  spawnNote(
    rRange(8, CFG.mapSize*CFG.cell - 8),
    rRange(8, CFG.mapSize*CFG.cell - 8),
    "LOG 07",
    "If you read this, your sanity becomes a hallway.\n\nDo not look at the walls for too long."
  );
}

function spawnNote(x,z,title,body){
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.55, 0.7),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent:true, opacity:0.9, side:THREE.DoubleSide })
  );
  mesh.rotation.x = -Math.PI/2;
  mesh.position.set(x, 0.03, z);
  worldGroup.add(mesh);

  interactables.push({
    id: "NOTE",
    mesh,
    radius: 1.2,
    textFn: () => "READ NOTE",
    action: () => {
      openNote(title, body);
      // creepier notes cause more sanity loss
      const creepy = /hallway|deny|walls|sanity|remember|watch/i.test(body);
      applySanity(-(creepy ? CFG.sanity.creepyNotePenalty : 3));
      if(creepy) S.glitch = clamp(S.glitch + 0.12, 0, 1);
    }
  });
}

// ---------------------------
// UI: NOTES
// ---------------------------
function openNote(title, body){
  noteTitle.textContent = title;
  noteBody.textContent = body;
  notePanel.style.display = "block";
  unlockPointer();
}
function closeNote(){
  notePanel.style.display = "none";
  lockPointer();
}
noteClose.addEventListener("click", closeNote);

// ---------------------------
// POINTER LOCK + INPUT
// ---------------------------
function lockPointer(){
  renderer.domElement.requestPointerLock?.();
}
function unlockPointer(){
  document.exitPointerLock?.();
}

document.addEventListener("pointerlockchange", ()=>{
  S.locked = document.pointerLockElement === renderer.domElement;
});

document.addEventListener("mousemove", (e)=>{
  if(!S.running || !S.locked) return;

  // stable mouse: accumulate targets, clamp pitch
  const mx = e.movementX || 0;
  const my = e.movementY || 0;

  S.targetYaw   -= mx * CFG.player.mouse;
  S.targetPitch -= my * CFG.player.mouse;

  const pitchLimit = Math.PI/2 - 0.08;
  S.targetPitch = clamp(S.targetPitch, -pitchLimit, pitchLimit);
});

document.addEventListener("keydown", (e)=>{
  if(!S.running) return;

  if(e.code === "KeyW") S.move.f = 1;
  if(e.code === "KeyS") S.move.b = 1;  // FIXED: S is backward
  if(e.code === "KeyA") S.move.l = 1;
  if(e.code === "KeyD") S.move.r = 1;
  if(e.code === "ShiftLeft") S.move.run = 1;
  if(e.code === "Space") S.move.jump = 1;

  if(e.code === "KeyE"){
    if(S.currentTarget) S.currentTarget.action();
  }

  if(e.code === "KeyF"){
    S.flashlightOn = !S.flashlightOn;
    pickup.textContent = S.flashlightOn ? "FLASHLIGHT ON" : "FLASHLIGHT OFF";
    setTimeout(()=> pickup.textContent=" ", 900);
  }

  // drop
  if(e.code === "KeyQ"){
    if(S.equipped){
      pickup.textContent = `DROPPED: ${S.equipped.id}`;
      setTimeout(()=> pickup.textContent=" ", 900);
      S.equipped = null;
    }
  }
});

document.addEventListener("keyup", (e)=>{
  if(e.code === "KeyW") S.move.f = 0;
  if(e.code === "KeyS") S.move.b = 0;
  if(e.code === "KeyA") S.move.l = 0;
  if(e.code === "KeyD") S.move.r = 0;
  if(e.code === "ShiftLeft") S.move.run = 0;
  if(e.code === "Space") S.move.jump = 0;
});

document.addEventListener("mousedown", (e)=>{
  if(!S.running) return;
  if(!S.locked){
    lockPointer();
    return;
  }
  // attack
  if(e.button === 0) attack();
});

function attack(){
  if(!S.equipped || S.equipped.id !== "PIPE"){
    // still allow “panic shove”
    S.glitch = clamp(S.glitch + 0.05, 0, 1);
    return;
  }

  // raycast forward short distance to hit enemy
  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
  const origin = new THREE.Vector3().copy(rig.position);
  origin.y = CFG.player.height*0.9;

  let hit = null;
  let best = 999;
  for(const e of enemies){
    const d = e.mesh.position.distanceTo(origin);
    if(d < 2.2){
      const to = new THREE.Vector3().subVectors(e.mesh.position, origin).normalize();
      const dp = to.dot(dir);
      if(dp > 0.75 && d < best){
        best = d;
        hit = e;
      }
    }
  }

  if(hit){
    hit.hp -= 55;
    S.glitch = clamp(S.glitch + 0.15, 0, 1);
    pickup.textContent = "HIT!";
    setTimeout(()=> pickup.textContent=" ", 450);

    if(hit.hp <= 0){
      worldGroup.remove(hit.mesh);
      enemies.splice(enemies.indexOf(hit),1);
      applySanity(+4);
      speak("It folds.");
    }
  }else{
    pickup.textContent = "SWING";
    setTimeout(()=> pickup.textContent=" ", 300);
  }
}

// ---------------------------
// COLLISION (cheap)
// ---------------------------
function collidePoint(p){
  for(const b of colliders){
    if(p.x >= b.min.x && p.x <= b.max.x &&
       p.y >= b.min.y && p.y <= b.max.y &&
       p.z >= b.min.z && p.z <= b.max.z) return true;
  }
  return false;
}

// ---------------------------
// INTERACTION CHECK
// ---------------------------
const ray = new THREE.Raycaster();
function updateInteraction(){
  S.currentTarget = null;
  hint.style.display = "none";
  uiCross.classList.remove("active");

  if(!S.locked) return;

  const origin = new THREE.Vector3().copy(rig.position);
  origin.y = CFG.player.height*0.95;

  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
  ray.set(origin, dir);
  ray.far = CFG.interactDist;

  // small: just test distance + angle against interactables
  let best = null;
  let bestD = 999;

  for(const it of interactables){
    const d = it.mesh.position.distanceTo(origin);
    if(d > CFG.interactDist) continue;

    // “in front” test
    const to = new THREE.Vector3().subVectors(it.mesh.position, origin).normalize();
    const dp = to.dot(dir);
    if(dp < 0.75) continue;

    if(d < bestD){
      bestD = d;
      best = it;
    }
  }

  // passive look triggers for wall scares
  if(best && best.passiveLook){
    // auto trigger sometimes when stared at
    if(r01() > 0.985) best.action();
    // no hint spam
    return;
  }

  if(best){
    S.currentTarget = best;
    uiCross.classList.add("active");
    hint.style.display = "block";
    hint.textContent = `[E] ${best.textFn ? best.textFn() : "INTERACT"}`;
  }
}

// ---------------------------
// MINIMAP (lies with low sanity)
// ---------------------------
function updateMinimap(){
  const W = mapCanvas.width, H = mapCanvas.height;
  mapCtx.clearRect(0,0,W,H);

  // background
  mapCtx.fillStyle = "rgba(0,0,0,0.6)";
  mapCtx.beginPath();
  mapCtx.arc(W/2,H/2, W/2, 0, Math.PI*2);
  mapCtx.fill();

  // fear-based distort / lie
  const lie = S.mapLie; // 0..1
  const rot = lie * rSign() * 0.6;
  const scale = 2.1 + lie*1.0;

  mapCtx.save();
  mapCtx.translate(W/2, H/2);
  mapCtx.rotate(rot);
  mapCtx.translate(-W/2, -H/2);

  const px = rig.position.x;
  const pz = rig.position.z;

  // draw buildings as dots (approx by collider centers)
  mapCtx.fillStyle = "rgba(180,180,180,0.5)";
  for(const b of colliders){
    const cx = (b.min.x + b.max.x)/2;
    const cz = (b.min.z + b.max.z)/2;

    let dx = (cx - px)*scale;
    let dz = (cz - pz)*scale;

    if(lie > 0.25){
      dx += Math.sin(S.time*0.9 + cx*0.02) * (lie*14);
      dz += Math.cos(S.time*1.1 + cz*0.02) * (lie*14);
    }

    const x = W/2 + dx;
    const y = H/2 + dz;
    if((x-W/2)**2 + (y-H/2)**2 > (W/2)**2) continue;
    mapCtx.fillRect(x-1, y-1, 2, 2);
  }

  // enemies
  mapCtx.fillStyle = "rgba(255,40,40,0.85)";
  for(const e of enemies){
    let dx = (e.mesh.position.x - px)*scale;
    let dz = (e.mesh.position.z - pz)*scale;

    if(lie > 0.45 && r01() > 0.55){
      dx *= -1;
      dz *= -1;
    }

    const x = W/2 + dx;
    const y = H/2 + dz;
    if((x-W/2)**2 + (y-H/2)**2 > (W/2)**2) continue;
    mapCtx.fillRect(x-2, y-2, 4, 4);
  }

  // player
  mapCtx.fillStyle = "rgba(10,255,102,0.95)";
  mapCtx.beginPath();
  mapCtx.arc(W/2, H/2, 4, 0, Math.PI*2);
  mapCtx.fill();

  mapCtx.restore();

  // ring
  mapCtx.strokeStyle = "rgba(255,255,255,0.35)";
  mapCtx.lineWidth = 2;
  mapCtx.beginPath();
  mapCtx.arc(W/2,H/2, W/2-2, 0, Math.PI*2);
  mapCtx.stroke();

  if(lie > 0.6){
    mapCtx.fillStyle = "rgba(255,216,74,0.6)";
    mapCtx.font = "10px Courier New";
    mapCtx.fillText("FALSE", 8, 14);
  }
}

// ---------------------------
// SANITY/HP
// ---------------------------
function applySanity(delta){
  S.san = clamp(S.san + delta, 0, 100);
}
function applyHP(delta){
  S.hp = clamp(S.hp + delta, 0, 100);
}
function updateHUD(){
  hpFill.style.width = `${S.hp}%`;
  sanFill.style.width = `${S.san}%`;
}

// ---------------------------
// GAME LOOP
// ---------------------------
let last = performance.now();
function loop(now){
  requestAnimationFrame(loop);
  if(!S.running) return;

  S.dt = clamp((now - last)/1000, 0, 0.05);
  last = now;
  S.time += S.dt;

  // cooldowns
  S.msgCooldown = Math.max(0, S.msgCooldown - S.dt);

  // fear / glitch
  S.fear = clamp(1 - S.san/100, 0, 1);
  S.glitch = Math.max(0, S.glitch - S.dt*0.18);
  S.mapLie = clamp(S.fear + (r01()>0.985 ? 0.35 : 0), 0, 1);

  // sanity decay over time
  applySanity(-CFG.sanity.decayPerSec * S.dt);

  // lighting ramp
  const fear = S.fear;
  hemi.intensity = lerp(0.95, 0.28, fear);
  keyLight.intensity = lerp(0.85, 0.35, fear);
  fillLight.intensity = lerp(0.35, 0.08, fear);

  // fog thickens with fear
  scene.fog.density = lerp(0.010, 0.030, fear);

  // sky shifts between your textures depending on fear
  sky.material.map = fear < 0.45 ? T.sh2 : (fear < 0.75 ? T.back2 : T.back);
  sky.material.needsUpdate = true;

  // flashlight
  flashlight.intensity = S.flashlightOn ? lerp(1.35, 2.1, fear) : 0.0;

  // camera smoothing
  S.yaw = lerp(S.yaw, S.targetYaw, 1 - Math.pow(0.0005, S.dt));
  S.pitch = lerp(S.pitch, S.targetPitch, 1 - Math.pow(0.0005, S.dt));
  rig.rotation.y = S.yaw;
  head.rotation.x = S.pitch;

  // flashlight follows view
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  flashlight.position.copy(camPos);
  const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
  flashlightTarget.position.copy(camPos).add(fwd.multiplyScalar(6));

  // movement
  if(S.locked){
    const forward = new THREE.Vector3(0,0,-1).applyQuaternion(rig.quaternion);
    const right = new THREE.Vector3(1,0,0).applyQuaternion(rig.quaternion);

    const wish = new THREE.Vector3();
    if(S.move.f) wish.add(forward);
    if(S.move.b) wish.sub(forward);       // FIXED
    if(S.move.r) wish.add(right);
    if(S.move.l) wish.sub(right);
    if(wish.lengthSq() > 0) wish.normalize();

    const speed = (S.move.run ? CFG.player.run : CFG.player.walk);
    const accel = 22.0;

    // accelerate in XZ
    S.vel.x = lerp(S.vel.x, wish.x * speed, clamp(accel*S.dt,0,1));
    S.vel.z = lerp(S.vel.z, wish.z * speed, clamp(accel*S.dt,0,1));

    // gravity
    S.vel.y -= CFG.player.gravity * S.dt;

    // jump
    if(S.move.jump && S.onGround){
      S.vel.y = CFG.player.jump;
      S.onGround = false;
    }

    // integrate
    const next = new THREE.Vector3().copy(rig.position);
    next.x += S.vel.x * S.dt;
    next.y += S.vel.y * S.dt;
    next.z += S.vel.z * S.dt;

    // floor
    if(next.y < CFG.player.height){
      next.y = CFG.player.height;
      S.vel.y = 0;
      S.onGround = true;
    }

    // collider push (simple axis)
    const test = new THREE.Vector3(next.x, next.y-0.9, next.z);

    // X axis
    const xTry = new THREE.Vector3(next.x, test.y, rig.position.z);
    if(collidePoint(xTry)) next.x = rig.position.x;

    // Z axis
    const zTry = new THREE.Vector3(rig.position.x, test.y, next.z);
    if(collidePoint(zTry)) next.z = rig.position.z;

    // finalize
    rig.position.copy(next);
  }

  // enemy AI (sprite monsters)
  for(const e of enemies){
    e.phase += S.dt * (1.0 + fear*1.2);

    const d = e.mesh.position.distanceTo(rig.position);
    // jitter animation / distortion
    e.mesh.material.opacity = 0.92 + Math.sin(e.phase*7.0)*0.06;
    e.mesh.position.y = 1.35 + Math.sin(e.phase*3.3)*0.12;

    if(d < CFG.enemy.aggroDist){
      // chase
      const dir = new THREE.Vector3().subVectors(rig.position, e.mesh.position);
      dir.y = 0;
      dir.normalize();
      e.mesh.position.add(dir.multiplyScalar(e.speed * (1.0 + fear*0.35) * S.dt));

      // damage
      if(d < CFG.enemy.hitDist){
        applyHP(-(CFG.enemy.damageHP * S.dt));
        applySanity(-(CFG.enemy.damageSAN * S.dt));
        S.glitch = clamp(S.glitch + 0.12, 0, 1);
      }
    }else{
      // wander
      e.mesh.position.x += Math.sin(e.phase*0.7) * 0.15 * S.dt;
      e.mesh.position.z += Math.cos(e.phase*0.8) * 0.15 * S.dt;
    }
  }

  // update TVs
  worldGroup.traverse((o)=>{
    if(o.userData && o.userData.drawTV){
      if(r01() > 0.88 || fear > 0.6) o.userData.drawTV();
      if(o.userData.light) o.userData.light.intensity = 0.4 + r01()*0.8;
    }
  });

  // interaction + minimap + snow
  updateInteraction();
  updateMinimap();
  updateSnow();

  // postprocess uniforms
  crtPass.uniforms.time.value = S.time;
  crtPass.uniforms.fear.value = S.fear;
  crtPass.uniforms.glitch.value = S.glitch;

  // audio fear
  setFearAudio(S.fear);

  // death check
  updateHUD();
  if(S.hp <= 0 || S.san <= 0){
    S.running = false;
    unlockPointer();
    deathScreen.classList.remove("hidden");
    deathReason.textContent = (S.hp<=0) ? "PHYSICAL TRAUMA CRITICAL" : "SYSTEM CORRUPTION 100%";
    return;
  }

  // render
  composer.render();
}

// ---------------------------
// START / RESET
// ---------------------------
async function startGame(){
  S.name = (playerNameInput.value || "DEFER").trim().slice(0,18).toUpperCase();
  if(!S.name) S.name = "DEFER";

  // reset state
  S.hp = 100; S.san = 100;
  S.glitch = 0;
  S.fear = 0;
  S.inventory.length = 0;
  S.equipped = null;
  S.msgCooldown = 0;

  // reset view
  S.yaw = 0; S.pitch = 0;
  S.targetYaw = 0; S.targetPitch = 0;

  clearWorld();
  carveRoads();
  buildGround();
  buildInstancedProps();
  buildSnow();
  buildCityBlocks();
  placeSpecials();

  // start in-bounds
  rig.position.set(6, CFG.player.height, 6);

  // audio
  await ensureAudio();
  if(S.audio.ctx && S.audio.ctx.state !== "running"){
    try{ await S.audio.ctx.resume(); }catch(_){}
  }

  // UI
  startScreen.classList.add("hidden");
  deathScreen.classList.add("hidden");
  S.running = true;

  lockPointer();
  last = performance.now();
  requestAnimationFrame(loop);

  // intro line
  speak(`${S.name}. Welcome to sector zero.`);
}

startBtn.addEventListener("click", startGame);
respawnBtn.addEventListener("click", ()=> location.reload());

// click canvas to lock
renderer.domElement.addEventListener("click", ()=>{
  if(S.running && !S.locked) lockPointer();
});

window.addEventListener("resize", ()=>{
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------
// EXTRA: sanity-driven random events / easter eggs
// ---------------------------
setInterval(()=>{
  if(!S.running) return;
  const fear = S.fear;

  // rare: whisper when very low sanity
  if(fear > 0.72 && r01() > 0.70){
    S.glitch = clamp(S.glitch + 0.2, 0, 1);
    if(S.msgCooldown <= 0){
      const lines = [
        `${S.name}. the map is a mouth.`,
        `${S.name}. turn around slowly.`,
        `${S.name}. your name is leaking.`,
        `you are not in the city. the city is in you.`,
      ];
      speak(lines[(r01()*lines.length)|0]);
      S.msgCooldown = 7;
    }
  }

  // secret “easter” restore if you stand still (anti-cheap: subtle)
  if(S.locked && S.vel.length() < 0.2 && r01() > 0.85){
    applySanity(+1.5);
  }
}, 1600);
