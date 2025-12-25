import * as THREE from "three";

function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function rand(a,b){ return a + Math.random()*(b-a); }
function irand(a,b){ return Math.floor(rand(a,b+1)); }

export class World {
  constructor({ scene, assets, rngSeed = 1337 }) {
    this.scene = scene;
    this.assets = assets;
    this.seed = rngSeed >>> 0;

    // grid-based collision world
    this.cell = 2.0;
    this.gridW = 96;
    this.gridH = 96;
    this.grid = new Uint8Array(this.gridW * this.gridH); // 0 empty, 1 wall

    // Rooms & interactables
    this.interactables = [];
    this.notes = [];
    this.doors = [];
    this.keys = [];
    this.wallImages = [];

    // Render groups
    this.staticGroup = new THREE.Group();
    this.scene.add(this.staticGroup);

    // Instanced vegetation / props
    this.instances = {
      trees: null,
      deadTrees: null,
      nails: null
    };

    // “false minimap” toggles
    this.lieMode = 0;

    // spawn points
    this.playerSpawn = new THREE.Vector3(6, 1.7, 6);

    // objective anchor
    this.serverDoor = null;
  }

  // simple deterministic RNG (LCG)
  _r() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  _pick(arr){ return arr[Math.floor(this._r()*arr.length)]; }

  worldToCell(x,z){
    return {
      cx: clamp(Math.floor(x/this.cell), 0, this.gridW-1),
      cz: clamp(Math.floor(z/this.cell), 0, this.gridH-1),
    };
  }
  cellToWorld(cx,cz){
    return { x: cx*this.cell + this.cell*0.5, z: cz*this.cell + this.cell*0.5 };
  }
  idx(cx,cz){ return cz*this.gridW + cx; }
  isWallCell(cx,cz){ return this.grid[this.idx(cx,cz)] === 1; }
  setWall(cx,cz,v){ this.grid[this.idx(cx,cz)] = v?1:0; }

  clear() {
    // remove objects from scene
    this.scene.remove(this.staticGroup);
    this.staticGroup = new THREE.Group();
    this.scene.add(this.staticGroup);

    this.interactables.length = 0;
    this.notes.length = 0;
    this.doors.length = 0;
    this.keys.length = 0;
    this.wallImages.length = 0;
    this.grid.fill(0);
  }

  generate({ playerName, difficulty = 0 }) {
    this.clear();

    // --- SKY / BACKDROP ---
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(180, 24, 16),
      new THREE.MeshBasicMaterial({
        map: this.assets.tex.backdrop,
        side: THREE.BackSide,
        color: 0xffffff
      })
    );
    sky.position.set(this.gridW*this.cell*0.5, 35, this.gridH*this.cell*0.5);
    this.staticGroup.add(sky);

    // --- GROUND ---
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(this.gridW*this.cell, this.gridH*this.cell, 1, 1),
      new THREE.MeshStandardMaterial({
        map: this.assets.tex.ground,
        roughness: 1,
        metalness: 0,
      })
    );
    ground.rotation.x = -Math.PI/2;
    ground.receiveShadow = true;
    ground.position.set(this.gridW*this.cell*0.5, 0, this.gridH*this.cell*0.5);
    this.staticGroup.add(ground);

    // --- POCKET CORRIDOR LAYOUT ---
    // carve a “city courtyard” + attach multiple pocket corridors behind doors
    this._carveCourtyard();
    const corridorAnchors = this._placePocketDoors(6 + difficulty);

    // generate corridors behind each door
    for (const a of corridorAnchors) {
      this._carvePocketCorridor(a.cx, a.cz, a.dir, irand(9, 18) + difficulty*2);
    }

    // --- BUILD WALL MESHES (instanced walls for perf) ---
    this._buildWalls();

    // --- PROPS / ATMOSPHERE ---
    this._scatterProps(playerName, difficulty);
    this._placeKeyAndServerDoor(playerName);

    // Make spawn safe
    this.playerSpawn.set(6, 1.7, 6);
  }

  _carveCourtyard() {
    // a bright-ish open start zone
    for (let cz=0; cz<this.gridH; cz++) {
      for (let cx=0; cx<this.gridW; cx++) {
        const border = (cx<2 || cz<2 || cx>this.gridW-3 || cz>this.gridH-3);
        if (border) this.setWall(cx,cz,1);
      }
    }

    // A chunky blocky “city” of rectangles
    const blocks = 22;
    for (let i=0;i<blocks;i++){
      const w = irand(4, 14);
      const h = irand(4, 14);
      const x = irand(4, this.gridW - w - 5);
      const z = irand(4, this.gridH - h - 5);
      // leave a courtyard near spawn
      if (x<18 && z<18) continue;
      for (let dz=0;dz<h;dz++){
        for (let dx=0;dx<w;dx++){
          // keep corridors by leaving some gaps
          if (this._r() < 0.06) continue;
          this.setWall(x+dx, z+dz, 1);
        }
      }
    }

    // Carve a guaranteed path network (random walk)
    let cx = 4, cz = 4;
    for (let i=0;i<900;i++){
      this.setWall(cx,cz,0);
      const dir = irand(0,3);
      if (dir===0) cx++;
      if (dir===1) cx--;
      if (dir===2) cz++;
      if (dir===3) cz--;
      cx = clamp(cx, 3, this.gridW-4);
      cz = clamp(cz, 3, this.gridH-4);
    }

    // Widen paths (makes movement smoother)
    for (let cz2=2; cz2<this.gridH-2; cz2++){
      for (let cx2=2; cx2<this.gridW-2; cx2++){
        if (!this.isWallCell(cx2,cz2)) {
          for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            if (this._r() < 0.18) this.setWall(cx2+dx, cz2+dz, 0);
          }
        }
      }
    }
  }

  _placePocketDoors(count) {
    // find wall edges near paths and place doors that lead to corridors
    const anchors = [];
    const tries = 2400;
    for (let t=0; t<tries && anchors.length<count; t++){
      const cx = irand(8, this.gridW-9);
      const cz = irand(8, this.gridH-9);
      if (this.isWallCell(cx,cz)) continue;

      // look for adjacent wall to mount a door into
      const dirs = [
        {dx:1,dz:0, dir:"E"},
        {dx:-1,dz:0, dir:"W"},
        {dx:0,dz:1, dir:"S"},
        {dx:0,dz:-1, dir:"N"},
      ];
      const d = this._pick(dirs);
      const wx = cx + d.dx;
      const wz = cz + d.dz;
      if (!this.isWallCell(wx,wz)) continue;

      // ensure some clearance around
      if (this._countWallsAround(cx,cz) > 6) continue;

      // mark wall cell as “door” by clearing it and storing anchor
      this.setWall(wx,wz,0);
      anchors.push({ cx: wx, cz: wz, dir: d.dir });
      // place actual door mesh later (in props scatter)
    }
    return anchors;
  }

  _countWallsAround(cx,cz){
    let n=0;
    for (let dz=-1;dz<=1;dz++){
      for (let dx=-1;dx<=1;dx++){
        if (dx===0 && dz===0) continue;
        if (this.isWallCell(cx+dx,cz+dz)) n++;
      }
    }
    return n;
  }

  _carvePocketCorridor(startCx, startCz, dir, length) {
    // carve a corridor segment + occasional room pockets
    let cx = startCx, cz = startCz;
    const step = (d) => {
      if (d==="E") cx++;
      if (d==="W") cx--;
      if (d==="S") cz++;
      if (d==="N") cz--;
      cx = clamp(cx, 3, this.gridW-4);
      cz = clamp(cz, 3, this.gridH-4);
      this.setWall(cx,cz,0);
      // widen a bit
      if (this._r() < 0.5) this.setWall(cx+1,cz,0);
      if (this._r() < 0.5) this.setWall(cx-1,cz,0);
      if (this._r() < 0.5) this.setWall(cx,cz+1,0);
      if (this._r() < 0.5) this.setWall(cx,cz-1,0);
    };

    // initial direction
    this.setWall(cx,cz,0);
    for (let i=0;i<length;i++){
      step(dir);

      // branch chance
      if (this._r() < 0.12) {
        const bdir = this._pick(["N","S","E","W"]);
        const bx = cx, bz = cz;
        let bc = { cx: bx, cz: bz };
        for (let j=0;j<irand(4,10);j++){
          if (bdir==="E") bc.cx++;
          if (bdir==="W") bc.cx--;
          if (bdir==="S") bc.cz++;
          if (bdir==="N") bc.cz--;
          bc.cx = clamp(bc.cx, 3, this.gridW-4);
          bc.cz = clamp(bc.cz, 3, this.gridH-4);
          this.setWall(bc.cx, bc.cz, 0);
        }
      }

      // room pocket
      if (this._r() < 0.18) {
        const rw = irand(4, 9);
        const rh = irand(4, 9);
        const rx = clamp(cx - Math.floor(rw/2), 3, this.gridW-rw-3);
        const rz = clamp(cz - Math.floor(rh/2), 3, this.gridH-rh-3);
        for (let dz=0; dz<rh; dz++){
          for (let dx=0; dx<rw; dx++){
            this.setWall(rx+dx, rz+dz, 0);
          }
        }

        // sometimes place a locked inner door in the pocket
        if (this._r() < 0.35) {
          const doorSpot = { cx: rx + irand(1,rw-2), cz: rz + irand(1,rh-2) };
          this._queueDoorAtCell(doorSpot.cx, doorSpot.cz, { locked: this._r()<0.6 });
        }
      }

      // slowly curve direction
      if (this._r() < 0.22) dir = this._pick(["N","S","E","W"]);
    }
  }

  _queueDoorAtCell(cx,cz, { locked=false } = {}) {
    // store door to spawn later
    this.doors.push({ cx, cz, locked, opened:false, keyId: locked ? `K${cx}_${cz}` : null });
  }

  _buildWalls() {
    // instanced walls (cheap)
    const wallGeo = new THREE.BoxGeometry(this.cell, 3.2, this.cell);
    const wallMat = new THREE.MeshStandardMaterial({
      map: this.assets.tex.wall,
      roughness: 0.95,
      metalness: 0.05,
    });

    // PS2 vibe: low anisotropy, nearest-ish
    this.assets.tex.wall.anisotropy = 1;

    const max = this.gridW * this.gridH;
    const inst = new THREE.InstancedMesh(wallGeo, wallMat, max);
    inst.castShadow = true;
    inst.receiveShadow = true;

    let n=0;
    const m = new THREE.Matrix4();
    for (let cz=0; cz<this.gridH; cz++){
      for (let cx=0; cx<this.gridW; cx++){
        if (!this.isWallCell(cx,cz)) continue;
        const {x,z} = this.cellToWorld(cx,cz);
        m.makeTranslation(x, 1.6, z);
        inst.setMatrixAt(n++, m);
      }
    }
    inst.count = n;
    this.staticGroup.add(inst);

    // floors inside corridors slightly darker patches
    const stain = new THREE.Mesh(
      new THREE.PlaneGeometry(this.gridW*this.cell, this.gridH*this.cell),
      new THREE.MeshStandardMaterial({ map: this.assets.tex.stain, transparent:true, opacity:0.22, roughness:1 })
    );
    stain.rotation.x = -Math.PI/2;
    stain.position.set(this.gridW*this.cell*0.5, 0.01, this.gridH*this.cell*0.5);
    this.staticGroup.add(stain);
  }

  _scatterProps(playerName, difficulty) {
    // lights (brighter start)
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.staticGroup.add(ambient);

    const moon = new THREE.DirectionalLight(0xbcd7ff, 0.55);
    moon.position.set(60, 90, 30);
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024,1024);
    moon.shadow.camera.left = -70;
    moon.shadow.camera.right = 70;
    moon.shadow.camera.top = 70;
    moon.shadow.camera.bottom = -70;
    this.staticGroup.add(moon);

    // props: trees, dead trees, nails, beds
    this._makeInstancedTrees();
    this._makeInstancedDeadTrees();
    this._makeInstancedNails();
    this._placeBeds(difficulty);

    // TVs that show your name
    this._placeTVs(playerName);

    // Doors (some prequeued)
    // also create some random doors
    const doorCount = 18 + difficulty*6;
    for (let i=0;i<doorCount;i++){
      const spot = this._randomEmptyCellFarFromSpawn();
      if (!spot) continue;
      const locked = this._r() < (0.35 + difficulty*0.12);
      this._queueDoorAtCell(spot.cx, spot.cz, { locked });
    }
    this._spawnDoors();

    // wall images that drain sanity when inspected
    this._placeWallImages();

    // notes and easter eggs
    this._placeNotesAndEggs(playerName, difficulty);
  }

  _randomEmptyCellFarFromSpawn() {
    for (let t=0;t<400;t++){
      const cx = irand(3, this.gridW-4);
      const cz = irand(3, this.gridH-4);
      if (this.isWallCell(cx,cz)) continue;
      if (cx<14 && cz<14) continue; // near spawn
      // ensure not too cramped
      if (this._countWallsAround(cx,cz) > 6) continue;
      return { cx, cz };
    }
    return null;
  }

  _makeInstancedTrees(){
    const count = 160;
    const trunk = new THREE.CylinderGeometry(0.12, 0.18, 2.2, 8);
    const leaf = new THREE.ConeGeometry(0.9, 1.8, 10);
    const g = new THREE.Group();

    // merge-like by instancing separate parts:
    const mTrunk = new THREE.MeshStandardMaterial({ map: this.assets.tex.wood, roughness:1 });
    const mLeaf  = new THREE.MeshStandardMaterial({ color: 0x2b4d2f, roughness:1 });

    const it = new THREE.InstancedMesh(trunk, mTrunk, count);
    const il = new THREE.InstancedMesh(leaf, mLeaf, count);
    it.castShadow = true; il.castShadow = true;

    const mat = new THREE.Matrix4();
    const mat2 = new THREE.Matrix4();
    let n=0;
    for (let i=0;i<count;i++){
      const c = this._randomEmptyCellFarFromSpawn();
      if (!c) continue;
      const {x,z} = this.cellToWorld(c.cx, c.cz);
      const s = rand(0.8, 1.35);
      const y = 1.1;

      mat.compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand(0,Math.PI*2), 0)),
        new THREE.Vector3(s, s, s)
      );
      it.setMatrixAt(n, mat);

      mat2.compose(
        new THREE.Vector3(x, y+1.5*s, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand(0,Math.PI*2), 0)),
        new THREE.Vector3(s, s, s)
      );
      il.setMatrixAt(n, mat2);
      n++;
    }
    it.count = n; il.count = n;
    g.add(it); g.add(il);
    this.staticGroup.add(g);
    this.instances.trees = g;
  }

  _makeInstancedDeadTrees(){
    const count = 110;
    const geo = new THREE.CylinderGeometry(0.08, 0.16, 2.6, 7);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness:1 });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.castShadow = true;

    const m = new THREE.Matrix4();
    let n=0;
    for (let i=0;i<count;i++){
      const c = this._randomEmptyCellFarFromSpawn();
      if (!c) continue;
      const {x,z} = this.cellToWorld(c.cx, c.cz);
      const s = rand(0.8, 1.6);
      m.compose(
        new THREE.Vector3(x, 1.3, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(-0.15,0.15), rand(0,Math.PI*2), rand(-0.1,0.1))),
        new THREE.Vector3(s, s, s)
      );
      inst.setMatrixAt(n++, m);
    }
    inst.count = n;
    this.staticGroup.add(inst);
    this.instances.deadTrees = inst;
  }

  _makeInstancedNails(){
    // “rusty nails” as scattered spikes
    const count = 380;
    const geo = new THREE.ConeGeometry(0.05, 0.35, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a2a22, roughness:0.7, metalness:0.25 });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.castShadow = true;

    const m = new THREE.Matrix4();
    let n=0;
    for (let i=0;i<count;i++){
      const cx = irand(3, this.gridW-4);
      const cz = irand(3, this.gridH-4);
      if (this.isWallCell(cx,cz)) continue;
      const {x,z} = this.cellToWorld(cx,cz);
      const s = rand(0.6, 1.3);
      m.compose(
        new THREE.Vector3(x + rand(-0.6,0.6), 0.16, z + rand(-0.6,0.6)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, rand(0,Math.PI*2), 0)),
        new THREE.Vector3(s, s, s)
      );
      inst.setMatrixAt(n++, m);
      if (n>=count) break;
    }
    inst.count = n;
    this.staticGroup.add(inst);
    this.instances.nails = inst;
  }

  _placeBeds(difficulty){
    const bedGeo = new THREE.BoxGeometry(1.7, 0.35, 0.8, 2, 1, 2);
    const bedMat = new THREE.MeshStandardMaterial({ map: this.assets.tex.metal, roughness:0.9, metalness:0.25 });
    const sheetGeo = new THREE.BoxGeometry(1.65, 0.18, 0.75, 2, 1, 2);
    const sheetMat = new THREE.MeshStandardMaterial({ map: this.assets.tex.sheet, roughness:1 });

    const beds = 16 + difficulty*6;
    for (let i=0;i<beds;i++){
      const c = this._randomEmptyCellFarFromSpawn();
      if (!c) continue;
      const {x,z} = this.cellToWorld(c.cx, c.cz);

      const bed = new THREE.Mesh(bedGeo, bedMat);
      bed.position.set(x, 0.18, z);
      bed.rotation.y = rand(0, Math.PI*2);
      bed.castShadow = true;
      bed.receiveShadow = true;

      const sheet = new THREE.Mesh(sheetGeo, sheetMat);
      sheet.position.set(0, 0.20, 0);
      sheet.rotation.y = rand(-0.04,0.04);
      bed.add(sheet);

      this.staticGroup.add(bed);
    }
  }

  _placeTVs(playerName){
    const tvGeo = new THREE.BoxGeometry(0.9, 0.65, 0.55, 2, 2, 2);
    const tvMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness:0.85 });

    const tvCount = 10;
    for (let i=0;i<tvCount;i++){
      const c = this._randomEmptyCellFarFromSpawn();
      if (!c) continue;
      const {x,z} = this.cellToWorld(c.cx, c.cz);

      const tv = new THREE.Mesh(tvGeo, tvMat);
      tv.position.set(x, 0.33, z);
      tv.rotation.y = rand(0, Math.PI*2);
      tv.castShadow = true;

      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(0.68, 0.42),
        new THREE.MeshBasicMaterial({ map: this.assets.tex.tvScreen, transparent:true })
      );
      screen.position.set(0, 0.03, 0.28);
      tv.add(screen);

      const glow = new THREE.PointLight(0xaadfff, 0.6, 3.0);
      glow.position.set(0, 0.05, 0.55);
      tv.add(glow);

      // attach a “name text” overlay as sprite for variability
      const label = this.assets.makeNameSprite(`HELLO, ${playerName}`, { mode:"tv" });
      label.position.set(0, 0.25, 0.30);
      tv.add(label);

      // interactable: random whisper + slight sanity shift
      this.interactables.push({
        mesh: tv,
        kind: "tv",
        text: "LISTEN",
        action: (api) => {
          // api: passed from main (audio, state)
          api.audio.speak(`${playerName}. do not trust the map.`, { pitch: 0.72, rate: 0.95, volume: 0.9 });
          api.addSanity(-rand(1.0, 4.0));
          api.flashMessage("THE TV KNOWS YOU.");
        }
      });

      this.staticGroup.add(tv);
    }
  }

  _spawnDoors() {
    const doorGeo = new THREE.BoxGeometry(1.2, 2.4, 0.16, 2, 3, 1);
    const doorMat = new THREE.MeshStandardMaterial({ map: this.assets.tex.door, roughness:0.8 });

    for (const d of this.doors) {
      const {x,z} = this.cellToWorld(d.cx, d.cz);
      const door = new THREE.Mesh(doorGeo, doorMat);

      door.position.set(x, 1.2, z);
      door.castShadow = true;
      door.userData = { doorCell: {cx:d.cx, cz:d.cz} };

      // rotation to align with nearby walls
      const nW = this.isWallCell(d.cx-1, d.cz);
      const nE = this.isWallCell(d.cx+1, d.cz);
      const nN = this.isWallCell(d.cx, d.cz-1);
      const nS = this.isWallCell(d.cx, d.cz+1);
      if (nN || nS) door.rotation.y = Math.PI*0.5;

      // lock marker
      const lockSprite = this.assets.makeIconSprite(d.locked ? "LOCKED" : "OPEN", d.locked ? "#ff2c2c" : "#b8ffcc");
      lockSprite.position.set(0, 1.0, 0.12);
      door.add(lockSprite);

      this.interactables.push({
        mesh: door,
        kind: "door",
        text: d.locked ? "UNLOCK" : "OPEN",
        action: (api) => {
          if (d.opened) return;

          if (d.locked) {
            if (!api.hasKey(d.keyId)) {
              api.audio.speak("locked.", { pitch: 0.7, rate: 0.95, volume: 0.85 });
              api.flashMessage("LOCKED. FIND A KEY.");
              api.addSanity(-0.6);
              return;
            }
            api.consumeKey(d.keyId);
            d.locked = false;
            api.flashMessage("UNLOCKED.");
            api.audio.speak("door unlocked.", { pitch: 0.72, rate: 0.95 });
          } else {
            api.audio.speak("open.", { pitch: 0.78, rate: 0.98, volume: 0.85 });
          }

          // open animation (cheap)
          d.opened = true;
          lockSprite.visible = false;
          api.openDoor(door);
        }
      });

      this.staticGroup.add(door);

      // if locked, spawn a key somewhere in the world
      if (d.keyId) this.keys.push({ keyId: d.keyId, placed: false });
    }

    // place keys after doors
    this._placeKeys();
  }

  _placeKeys() {
    const keyGeo = new THREE.TorusGeometry(0.14, 0.05, 8, 18);
    const keyMat = new THREE.MeshStandardMaterial({ color: 0xffd27a, roughness:0.35, metalness:0.75 });

    for (const k of this.keys) {
      if (k.placed) continue;
      const c = this._randomEmptyCellFarFromSpawn();
      if (!c) continue;
      const {x,z} = this.cellToWorld(c.cx, c.cz);

      const key = new THREE.Mesh(keyGeo, keyMat);
      key.position.set(x, 0.45, z);
      key.rotation.x = Math.PI*0.5;
      key.castShadow = true;

      // bob
      key.userData.bob = rand(0, Math.PI*2);

      this.interactables.push({
        mesh: key,
        kind: "key",
        text: "TAKE KEY",
        action: (api) => {
          api.giveKey(k.keyId);
          api.flashMessage("KEY OBTAINED.");
          api.audio.speak("key acquired.", { pitch: 0.8, rate: 1.0, volume: 0.8 });
          this.staticGroup.remove(key);
        }
      });

      this.staticGroup.add(key);
      k.placed = true;
    }
  }

  _placeWallImages() {
    // place "image.png" and "image2.png" as wall posters in corridors
    const posterGeo = new THREE.PlaneGeometry(1.4, 1.1);
    const mats = [this.assets.tex.image1, this.assets.tex.image2].map(t => new THREE.MeshBasicMaterial({ map:t, transparent:true }));

    const posters = 18;
    for (let i=0;i<posters;i++){
      // find wall-adjacent empty cell
      for (let t=0;t<300;t++){
        const cx = irand(4, this.gridW-5);
        const cz = irand(4, this.gridH-5);
        if (this.isWallCell(cx,cz)) continue;

        // need a wall neighbor
        const neighbors = [
          {dx:1,dz:0, ry:-Math.PI/2},
          {dx:-1,dz:0, ry: Math.PI/2},
          {dx:0,dz:1, ry: Math.PI},
          {dx:0,dz:-1, ry:0},
        ];
        const n = this._pick(neighbors);
        if (!this.isWallCell(cx+n.dx, cz+n.dz)) continue;

        const {x,z} = this.cellToWorld(cx,cz);
        const p = new THREE.Mesh(posterGeo, this._pick(mats));
        p.position.set(x + n.dx*0.95, 1.45, z + n.dz*0.95);
        p.rotation.y = n.ry;

        // random distort scale
        const sx = rand(0.9, 1.25);
        const sy = rand(0.85, 1.35);
        p.scale.set(sx, sy, 1);

        // slight tilt
        p.rotation.z = rand(-0.06, 0.06);

        // store for sanity interactions
        this.wallImages.push(p);

        this.staticGroup.add(p);
        break;
      }
    }
  }

  _placeKeyAndServerDoor(playerName) {
    // a special “server door” that ends the run
    const cx = this.gridW - 10;
    const cz = this.gridH - 10;
    // carve space
    for (let dz=-2;dz<=2;dz++){
      for (let dx=-2;dx<=2;dx++){
        this.setWall(cx+dx, cz+dz, 0);
      }
    }
    // queue the server door locked with special key
    const keyId = "SERVER_KEY";
    this.doors.push({ cx, cz, locked:true, opened:false, keyId });
    // add a guaranteed server key somewhere mid-map
    this.keys.push({ keyId, placed:false });

    // plus graffiti wall with playerName “cranberry drip”
    const spot = { cx: cx-4, cz: cz };
    const {x,z} = this.cellToWorld(spot.cx, spot.cz);
    const wallText = this.assets.makeDripNameSprite(playerName);
    wallText.position.set(x, 1.8, z);
    wallText.rotation.y = Math.PI * 0.5;
    this.staticGroup.add(wallText);

    this.serverDoor = { cx, cz };
  }

  _placeNotesAndEggs(playerName, difficulty) {
    const NOTE_BANK = [
      { t:"WELCOME", c:"The city is glitching. Do not look for meaning. It looks back." , creep:0.35 },
      { t:"LOG 02", c:"Your name is being cached in wet places.", creep:0.55 },
      { t:"LOG 07", c:"Doors are mouths. Keys are teeth.", creep:0.45 },
      { t:"FITNESS TIP", c:"Stand tall. Breathe in four counts. If you forget your name, keep going.", creep:0.25 },
      { t:"HAPPINESS", c:"Make a list of things you love. If the list writes itself, burn it.", creep:0.40 },
      { t:"ERROR", c:"A copy of you is walking ahead by exactly one corridor.", creep:0.60 },
      { t:"NOTE", c:`${playerName}, if you see yourself on the TV: do not answer.`, creep:0.70 },
      { t:"FIELD", c:"Outside the walls is a bright field that never loads.", creep:0.32 },
      { t:"EASTER EGG", c:"Press Q when you are not holding anything. Sometimes it helps. Sometimes it lies.", creep:0.48 },
    ];

    const notes = 26 + difficulty*8;
    for (let i=0;i<notes;i++){
      const c = this._randomEmptyCellFarFromSpawn();
      if (!c) continue;
      const {x,z} = this.cellToWorld(c.cx, c.cz);

      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 0.65),
        new THREE.MeshBasicMaterial({ color: 0xf5f5f5, transparent:true, opacity:0.95, side:THREE.DoubleSide })
      );
      mesh.rotation.x = -Math.PI/2;
      mesh.position.set(x, 0.02, z);

      const data = this._pick(NOTE_BANK);
      this.notes.push({ mesh, title:data.t, content:data.c, creep:data.creep });

      this.interactables.push({
        mesh,
        kind: "note",
        text: "READ",
        action: (api) => {
          api.openNote(data.t, data.c);
          // creepiness reduces sanity
          api.addSanity(-(2.0 + data.creep*6.5));
          if (data.creep > 0.55) api.audio.speak("do not read that again.", { pitch:0.68, rate:0.92 });
        }
      });

      this.staticGroup.add(mesh);
    }

    // “good/bad items” pickups
    const items = 18 + difficulty*6;
    for (let i=0;i<items;i++){
      const c = this._randomEmptyCellFarFromSpawn();
      if (!c) continue;
      const {x,z} = this.cellToWorld(c.cx, c.cz);

      const good = this._r() < 0.62;
      const kind = good ? this._pick(["MEDKIT","FLASHBATTERY","CHARM"]) : this._pick(["ROTTEN","NEEDLE","MIRROR"]);
      const color = good ? 0x7dffb3 : 0xff4a4a;

      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.18, 1),
        new THREE.MeshStandardMaterial({ color, roughness:0.4, metalness:0.25, emissive: color, emissiveIntensity: 0.10 })
      );
      mesh.position.set(x, 0.35, z);
      mesh.castShadow = true;

      this.interactables.push({
        mesh,
        kind: "item",
        text: `TAKE ${kind}`,
        action: (api) => {
          this.staticGroup.remove(mesh);
          api.pickItem(kind);
          if (good) api.audio.speak("item acquired.", { pitch:0.86, rate:1.0 });
          else api.audio.speak("bad item.", { pitch:0.70, rate:0.92 });
        }
      });

      this.staticGroup.add(mesh);
    }
  }

  update(dt, time) {
    // animate keys bob if needed
    for (const it of this.interactables) {
      if (it.kind === "key" && it.mesh && it.mesh.userData) {
        it.mesh.userData.bob = (it.mesh.userData.bob || 0) + dt * 2.2;
        it.mesh.position.y = 0.45 + Math.sin(it.mesh.userData.bob) * 0.05;
        it.mesh.rotation.y += dt * 1.1;
      }
    }
  }

  // cheap query for collision: treat walls as solid cells
  collideSphere(pos, radius) {
    const {cx,cz} = this.worldToCell(pos.x, pos.z);
    // check surrounding cells
    for (let dz=-1; dz<=1; dz++){
      for (let dx=-1; dx<=1; dx++){
        const x = cx+dx, z = cz+dz;
        if (x<0||z<0||x>=this.gridW||z>=this.gridH) continue;
        if (!this.isWallCell(x,z)) continue;
        const w = this.cellToWorld(x,z);
        // cell AABB
        const minX = w.x - this.cell*0.5;
        const maxX = w.x + this.cell*0.5;
        const minZ = w.z - this.cell*0.5;
        const maxZ = w.z + this.cell*0.5;

        // push out from AABB
        const px = clamp(pos.x, minX, maxX);
        const pz = clamp(pos.z, minZ, maxZ);
        const dxp = pos.x - px;
        const dzp = pos.z - pz;
        const d2 = dxp*dxp + dzp*dzp;
        const r2 = radius*radius;
        if (d2 < r2 && d2 > 0.000001) {
          const d = Math.sqrt(d2);
          const push = (radius - d) / d;
          pos.x += dxp * push;
          pos.z += dzp * push;
        }
      }
    }
  }

  getInteractables() {
    return this.interactables;
  }
}
