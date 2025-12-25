import * as THREE from "three";
import { makePost } from "./post.js";
import { World } from "./world.js";
import { Player } from "./player.js";
import { AIController } from "./ai.js";
import { UI } from "./ui.js";
import { GameAudio } from "./audio.js";

function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }

class Assets {
  constructor() {
    this.loader = new THREE.TextureLoader();
    this.tex = {};
  }

  async loadAll() {
    // IMPORTANT: set PS2-ish filtering
    const load = (url) => new Promise((res, rej) => {
      this.loader.load(url, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 1;
        t.minFilter = THREE.NearestMipmapNearestFilter;
        t.magFilter = THREE.NearestFilter;
        t.generateMipmaps = true;
        res(t);
      }, undefined, rej);
    });

    // Your images
    this.tex.backdrop = await load("./assets/Schermata 2025-12-25 alle 16.41.47.png");
    this.tex.back2    = await load("./assets/back2.png");
    this.tex.object1  = await load("./assets/object1.png");
    this.tex.fiend    = await load("./assets/fiend.png");
    this.tex.npc      = await load("./assets/npc.png");
    this.tex.npc3     = await load("./assets/npc3.png");
    this.tex.image1   = await load("./assets/image.png");
    this.tex.image2   = await load("./assets/image2.png");

    // Procedural-ish textures built from your assets (higher “art” feel than plain colors)
    this.tex.ground = this._makeTiledFrom(this.tex.back2, { repeat: 8 });
    this.tex.wall   = this._makeTiledFrom(this.tex.object1, { repeat: 6, tint:[0.95,0.95,0.95] });
    this.tex.stain  = this._makeFilmStain();
    this.tex.wood   = this._makeWood();
    this.tex.metal  = this._makeRust();
    this.tex.sheet  = this._makeSheet();
    this.tex.door   = this._makeDoor();
    this.tex.tvScreen = this._makeTVScreen();
  }

  _makeCanvasTex(w,h,drawFn) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    drawFn(g,w,h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.NearestMipmapNearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = true;
    t.anisotropy = 1;
    return t;
  }

  _makeTiledFrom(baseTex, { repeat=4, tint=null } = {}) {
    // draw base texture into canvas and repeat it (keeps “your art” in the world)
    return this._makeCanvasTex(512,512,(g,w,h)=>{
      // paint
      g.fillStyle="#101010";
      g.fillRect(0,0,w,h);

      // tile “baseTex” by drawing its image
      const img = baseTex.image;
      // if image not ready, fallback
      if (!img) return;

      const tw = w/repeat;
      const th = h/repeat;
      for(let y=0;y<repeat;y++){
        for(let x=0;x<repeat;x++){
          g.globalAlpha = 0.85;
          g.drawImage(img, x*tw, y*th, tw, th);
          g.globalAlpha = 1;
        }
      }

      if (tint) {
        g.globalCompositeOperation = "multiply";
        g.fillStyle = `rgb(${Math.floor(255*tint[0])},${Math.floor(255*tint[1])},${Math.floor(255*tint[2])})`;
        g.fillRect(0,0,w,h);
        g.globalCompositeOperation = "source-over";
      }

      // grain
      g.globalAlpha = 0.12;
      for(let i=0;i<26000;i++){
        const v = (Math.random()*255)|0;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(Math.random()*w, Math.random()*h, 1, 1);
      }
      g.globalAlpha = 1;
    });
  }

  _makeFilmStain(){
    return this._makeCanvasTex(512,512,(g,w,h)=>{
      g.clearRect(0,0,w,h);
      g.globalAlpha = 0.35;
      for(let i=0;i<1200;i++){
        const r = 6+Math.random()*60;
        g.fillStyle = `rgba(0,0,0,${0.05+Math.random()*0.18})`;
        g.beginPath();
        g.ellipse(Math.random()*w, Math.random()*h, r, r*(0.4+Math.random()), Math.random()*Math.PI, 0, Math.PI*2);
        g.fill();
      }
      g.globalAlpha = 1;
    });
  }

  _makeWood(){
    return this._makeCanvasTex(512,512,(g,w,h)=>{
      g.fillStyle="#3b261a";
      g.fillRect(0,0,w,h);
      g.strokeStyle="rgba(0,0,0,0.25)";
      for(let y=0;y<h;y+=6){
        g.beginPath();
        g.moveTo(0,y+Math.random()*2);
        g.lineTo(w,y+Math.random()*2);
        g.stroke();
      }
      g.globalAlpha=0.15;
      for(let i=0;i<12000;i++){
        g.fillStyle="#000";
        g.fillRect(Math.random()*w, Math.random()*h, 1, 1);
      }
      g.globalAlpha=1;
    });
  }

  _makeRust(){
    return this._makeCanvasTex(512,512,(g,w,h)=>{
      g.fillStyle="#2a2a2a";
      g.fillRect(0,0,w,h);
      for(let i=0;i<2400;i++){
        const r = 2+Math.random()*20;
        g.fillStyle=`rgba(140,60,20,${0.04+Math.random()*0.12})`;
        g.beginPath();
        g.arc(Math.random()*w, Math.random()*h, r, 0, Math.PI*2);
        g.fill();
      }
      g.globalAlpha=0.12;
      for(let i=0;i<18000;i++){
        const v=(Math.random()*255)|0;
        g.fillStyle=`rgb(${v},${v},${v})`;
        g.fillRect(Math.random()*w, Math.random()*h, 1, 1);
      }
      g.globalAlpha=1;
    });
  }

  _makeSheet(){
    return this._makeCanvasTex(512,512,(g,w,h)=>{
      g.fillStyle="#cfcfcf";
      g.fillRect(0,0,w,h);
      g.globalAlpha=0.16;
      for(let i=0;i<900;i++){
        g.strokeStyle="rgba(0,0,0,0.25)";
        g.beginPath();
        g.moveTo(Math.random()*w, Math.random()*h);
        g.lineTo(Math.random()*w, Math.random()*h);
        g.stroke();
      }
      g.globalAlpha=1;
    });
  }

  _makeDoor(){
    return this._makeCanvasTex(512,512,(g,w,h)=>{
      g.fillStyle="#3a2520";
      g.fillRect(0,0,w,h);
      g.fillStyle="rgba(0,0,0,0.25)";
      for(let x=32;x<w;x+=96) g.fillRect(x,0,8,h);
      g.globalAlpha=0.15;
      for(let i=0;i<14000;i++){
        g.fillStyle="#000";
        g.fillRect(Math.random()*w, Math.random()*h, 1, 1);
      }
      g.globalAlpha=1;
      // handle
      g.fillStyle="#e3c06e";
      g.beginPath();
      g.arc(w*0.78,h*0.5,18,0,Math.PI*2);
      g.fill();
    });
  }

  _makeTVScreen(){
    return this._makeCanvasTex(256,256,(g,w,h)=>{
      g.fillStyle="#000";
      g.fillRect(0,0,w,h);
      for(let i=0;i<26000;i++){
        const v = (Math.random()*255)|0;
        g.fillStyle=`rgb(${v},${v},${v})`;
        g.fillRect(Math.random()*w, Math.random()*h, 1, 1);
      }
      g.globalAlpha=0.12;
      g.fillStyle="#6bdcff";
      g.fillRect(0,h*0.6,w,3);
      g.globalAlpha=1;
    });
  }

  makeNameSprite(text, { mode="tv" } = {}) {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 128;
    const g = c.getContext("2d");
    g.clearRect(0,0,c.width,c.height);

    g.fillStyle = "rgba(0,0,0,0.65)";
    g.fillRect(0,0,c.width,c.height);

    g.font = mode==="tv" ? "bold 44px Courier New" : "bold 56px Courier New";
    g.fillStyle = mode==="tv" ? "#a9f5ff" : "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, c.width/2, c.height/2);

    // scanline
    g.globalAlpha = 0.18;
    g.fillStyle="#000";
    for(let y=0;y<c.height;y+=4) g.fillRect(0,y,c.width,1);
    g.globalAlpha=1;

    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;

    const mat = new THREE.SpriteMaterial({ map:t, transparent:true });
    const s = new THREE.Sprite(mat);
    s.scale.set(1.2, 0.3, 1);
    return s;
  }

  makeIconSprite(text, color="#fff") {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 96;
    const g = c.getContext("2d");
    g.fillStyle="rgba(0,0,0,0.65)";
    g.fillRect(0,0,c.width,c.height);
    g.font="bold 42px Courier New";
    g.fillStyle=color;
    g.textAlign="center";
    g.textBaseline="middle";
    g.fillText(text, c.width/2, c.height/2);
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map:t, transparent:true }));
    s.scale.set(0.8,0.3,1);
    return s;
  }

  makeDripNameSprite(playerName) {
    // “cranberry juice drip” effect: draw text + animated drip mask handled by main (swap textures)
    // Here we build the base texture; main will occasionally regenerate drips.
    const make = () => {
      const c = document.createElement("canvas");
      c.width = 512; c.height = 256;
      const g = c.getContext("2d");

      g.fillStyle = "rgba(0,0,0,0)";
      g.clearRect(0,0,c.width,c.height);

      g.font = "bold 86px Courier New";
      g.textAlign = "left";
      g.textBaseline = "top";

      // “cranberry”
      g.fillStyle = "#7a0f1a";
      g.fillText(playerName, 22, 26);

      // outline
      g.strokeStyle = "rgba(0,0,0,0.55)";
      g.lineWidth = 6;
      g.strokeText(playerName, 22, 26);

      // drips
      for (let i=0;i<18;i++){
        const x = 24 + Math.random()*(c.width-60);
        const y = 110 + Math.random()*20;
        const len = 30 + Math.random()*120;
        g.strokeStyle = `rgba(122,15,26,${0.45+Math.random()*0.4})`;
        g.lineWidth = 3 + Math.random()*5;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.random()*14-7, y+len);
        g.stroke();

        g.fillStyle = `rgba(122,15,26,${0.4+Math.random()*0.35})`;
        g.beginPath();
        g.arc(x, y+len, 6+Math.random()*10, 0, Math.PI*2);
        g.fill();
      }

      // grime
      g.globalAlpha = 0.12;
      for(let k=0;k<12000;k++){
        g.fillStyle="#000";
        g.fillRect(Math.random()*c.width, Math.random()*c.height, 1, 1);
      }
      g.globalAlpha = 1;

      return c;
    };

    const canvas = make();
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;

    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent:true });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.6), mat);
    mesh.userData.regenDrips = () => {
      const c = make();
      tex.image = c;
      tex.needsUpdate = true;
    };
    return mesh;
  }
}

(async function boot(){
  const start = document.getElementById("start");
  const startBtn = document.getElementById("startBtn");
  const nameInput = document.getElementById("nameInput");
  const difficultySel = document.getElementById("difficulty");

  const ui = new UI();
  const audio = new GameAudio();

  // THREE init
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b0c12, 0.018);

  const camera = new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.08, 260);
  camera.position.set(6, 1.7, 6);

  const renderer = new THREE.WebGLRenderer({ antialias:false, powerPreference:"high-performance" });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);

  const post = makePost(renderer, scene, camera);
  post.onResize(innerWidth, innerHeight);

  // Assets
  const assets = new Assets();
  await assets.loadAll();

  // World
  const world = new World({ scene, assets });

  // Player
  const player = new Player({ camera, dom: renderer.domElement });

  // Flashlight
  const flashlight = new THREE.SpotLight(0xfff4d6, 2.2, 22, Math.PI/6, 0.45, 1.0);
  flashlight.position.set(0,0,0);
  flashlight.target.position.set(0,0,-1);
  camera.add(flashlight);
  camera.add(flashlight.target);
  scene.add(camera);

  let flashlightOn = true;
  document.addEventListener("keydown", (e) => {
    if (e.code === "KeyF") {
      flashlightOn = !flashlightOn;
      flashlight.intensity = flashlightOn ? 2.2 : 0.0;
      ui.flashMessage(flashlightOn ? "FLASHLIGHT ON" : "FLASHLIGHT OFF");
    }
  });

  // AI
  const ai = new AIController({ scene, assets, world });

  // State
  const state = {
    playerName: "UNKNOWN",
    difficulty: 0,
    hp: 100,
    sanity: 100,
    inventory: new Set(),
    items: [],
    playing: false,
    // timers
    sanityDrain: 0.65, // per minute baseline-ish (scaled in update)
    timeAlive: 0,
  };

  const api = {
    audio,
    fear: 0,
    addSanity: (v) => {
      state.sanity = clamp(state.sanity + v, 0, 100);
    },
    damage: (hp, san) => {
      state.hp = clamp(state.hp - hp, 0, 100);
      state.sanity = clamp(state.sanity - san, 0, 100);
    },
    flashMessage: (msg) => ui.flashMessage(msg),
    openNote: (t,c) => ui.openNote(t,c),
    giveKey: (id) => state.inventory.add(id),
    hasKey: (id) => state.inventory.has(id),
    consumeKey: (id) => state.inventory.delete(id),
    pickItem: (kind) => {
      state.items.push(kind);
      // immediate effects for some
      if (kind === "MEDKIT") { state.hp = clamp(state.hp + 25, 0, 100); ui.flashMessage("HEALED."); }
      if (kind === "FLASHBATTERY") { flashlight.intensity = Math.min(3.0, flashlight.intensity + 0.5); ui.flashMessage("FLASH POWER UP."); }
      if (kind === "CHARM") { state.sanity = clamp(state.sanity + 15, 0, 100); ui.flashMessage("CALMING OBJECT."); }
      if (kind === "ROTTEN") { state.sanity = clamp(state.sanity - 18, 0, 100); ui.flashMessage("SOMETHING IS WRONG."); }
      if (kind === "NEEDLE") { state.hp = clamp(state.hp - 12, 0, 100); state.sanity = clamp(state.sanity - 10, 0, 100); ui.flashMessage("INFECTION."); }
      if (kind === "MIRROR") { state.sanity = clamp(state.sanity - 22, 0, 100); ui.flashMessage("YOU SAW YOURSELF."); audio.speak(`${state.playerName}.`, { pitch:0.6, rate:0.9 }); }
    },
    openDoor: (doorMesh) => {
      // open animation + “enter pocket corridor” feel: shove forward
      doorMesh.userData.openT = 0;
      doorMesh.userData.opening = true;
      ui.flashMessage("DOOR OPENING...");
    }
  };

  // Use item (Q)
  document.addEventListener("keydown", (e) => {
    if (e.code !== "KeyQ") return;
    if (!state.playing) return;

    // easter egg: random effects
    if (state.items.length === 0) {
      if (Math.random() < 0.33) {
        ui.flashMessage("NOTHING…");
        return;
      }
      ui.flashMessage("THE AIR SHIFTS.");
      state.sanity = clamp(state.sanity - 4, 0, 100);
      audio.speak("wrong.", { pitch:0.66, rate:0.92 });
      return;
    }

    const item = state.items.shift();
    ui.flashMessage(`USED: ${item}`);
    // “weapon-ish”: using NEEDLE is bad, using CHARM is good etc already applied on pickup;
    // here we add another layer of weirdness:
    if (item === "CHARM") state.sanity = clamp(state.sanity + 6, 0, 100);
    if (item === "MIRROR") state.sanity = clamp(state.sanity - 8, 0, 100);
  });

  // Interactions
  const ray = new THREE.Raycaster();
  let current = null;

  function checkInteract() {
    current = null;
    ui.setInteract(false);

    ray.setFromCamera({ x:0, y:0 }, camera);
    const ints = ray.intersectObjects(world.getInteractables().map(i => i.mesh), false);
    if (!ints.length) return;

    const hit = ints[0];
    if (hit.distance > 2.3) return;

    const obj = hit.object;
    const data = world.getInteractables().find(i => i.mesh === obj);
    if (!data) return;

    current = data;
    ui.setInteract(true, `[E] ${data.text}`);
  }

  document.addEventListener("keydown", (e) => {
    if (e.code !== "KeyE") return;
    if (!current || !state.playing) return;
    current.action(api);
  });

  // Start game
  startBtn.addEventListener("click", async () => {
    state.playerName = (nameInput.value || "UNKNOWN").trim().slice(0, 18) || "UNKNOWN";
    state.difficulty = parseInt(difficultySel.value, 10) || 0;

    start.style.display = "none";
    state.playing = true;

    await audio.start();
    audio.speak(`welcome, ${state.playerName}.`, { pitch:0.8, rate:0.98 });

    world.generate({ playerName: state.playerName, difficulty: state.difficulty });
    camera.position.copy(world.playerSpawn);

    ai.spawnEnemies(10, state.difficulty);

    ui.setObjective("OBJECTIVE: FIND A KEY. OPEN A DOOR. ENTER A POCKET CORRIDOR.");
  });

  // Resize
  addEventListener("resize", () => {
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.onResize(innerWidth, innerHeight);
  });

  // Performance-friendly fixed timestep loop
  let last = performance.now();
  let acc = 0;
  const step = 1/60;

  function updateOne(dt, time) {
    // baseline sanity drain over time (starts bright, decays)
    state.timeAlive += dt;
    const fear = 1 - (state.sanity/100);
    api.fear = fear;

    // drain increases with time + fear (subtle)
    const drain = (0.35 + fear*0.9 + (state.difficulty*0.2)) * dt;
    state.sanity = clamp(state.sanity - drain, 0, 100);

    // apply sanity to audio
    audio.setSanity01(state.sanity/100);

    // lighting / fog respond to sanity (start brighter, then darker)
    // We do this by dimming renderer exposure feel using fog density + post glitch.
    scene.fog.density = 0.014 + fear * 0.028;
    post.lowResPass.uniforms.vignette.value = 0.25 + fear*0.55;
    post.glitchPass.uniforms.glitch.value = clamp(fear*1.2, 0, 1);

    // player update
    player.update(dt, world);

    // doors opening animation (done via interactables group traversal)
    for (const it of world.getInteractables()) {
      if (it.kind === "door") {
        const m = it.mesh;
        if (m.userData.opening) {
          m.userData.openT += dt;
          const t = Math.min(1, m.userData.openT / 0.55);
          // rotate open
          m.rotation.y += dt * 2.3;
          if (t >= 1) m.userData.opening = false;
        }
      }
      // cranberry drip sprite regen sometimes
      if (it.mesh && it.mesh.userData && typeof it.mesh.userData.regenDrips === "function") {
        if (fear > 0.5 && Math.random() < 0.003) it.mesh.userData.regenDrips();
      }
    }

    // world updates
    world.update(dt, time);

    // “scary wall images” sanity drain when stared at
    if (world.wallImages && world.wallImages.length) {
      ray.setFromCamera({x:0,y:0}, camera);
      const hits = ray.intersectObjects(world.wallImages, false);
      if (hits.length && hits[0].distance < 2.6) {
        // drain more as fear increases
        state.sanity = clamp(state.sanity - (0.9 + fear*2.4) * dt, 0, 100);
        if (Math.random() < 0.002 + fear*0.006) ui.flashMessage("DON'T STARE.");
      }
    }

    // AI
    ai.update(dt, time, player, api);

    // interaction scan
    checkInteract();

    // UI
    ui.setBars(state.hp, state.sanity);
    ui.update(dt);

    // minimap (lies when fear high)
    ui.drawMinimap({
      playerX: player.position.x,
      playerZ: player.position.z,
      enemies: ai.enemies,
      world,
      fear
    });

    // death
    if (state.hp <= 0 || state.sanity <= 0) {
      state.playing = false;
      ui.die(state.hp <= 0 ? "PHYSICAL TRAUMA CRITICAL" : "SYSTEM CORRUPTION 100%");
      audio.speak("connection lost.", { pitch:0.62, rate:0.9 });
    }

    // occasional TTS “system interjections” at low sanity
    if (fear > 0.55 && Math.random() < 0.0022) {
      audio.speak(`${state.playerName}. keep moving.`, { pitch:0.74, rate:0.95, volume:0.85 });
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!state.playing) {
      // still render menu background if you want; for now just idle
      return;
    }

    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    acc += dt;

    // fixed-step
    while (acc >= step) {
      updateOne(step, now/1000);
      acc -= step;
    }

    post.lowResPass.uniforms.time.value = now/1000;
    post.glitchPass.uniforms.time.value = now/1000;

    post.composer.render();
  }

  requestAnimationFrame(frame);
})();

