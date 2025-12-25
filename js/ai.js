import * as THREE from "three";

function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }

export class AIController {
  constructor({ scene, assets, world }) {
    this.scene = scene;
    this.assets = assets;
    this.world = world;

    this.enemies = [];
    this.maxEnemies = 10;
  }

  spawnEnemies(count, difficulty=0) {
    this.clear();

    const n = count + difficulty*4;
    for (let i=0;i<n;i++){
      this.enemies.push(this._makeEnemy(i, difficulty));
    }
  }

  clear() {
    for (const e of this.enemies) {
      this.scene.remove(e.root);
    }
    this.enemies.length = 0;
  }

  _makeEnemy(i, difficulty) {
    // sprite-like billboarding plane with your PNGs
    const tex = [this.assets.tex.fiend, this.assets.tex.npc, this.assets.tex.npc3][i % 3];
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent:true, depthWrite:false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.8, 1, 1), mat);
    plane.position.y = 1.0;

    // subtle “alive” wobble shader-ish via scaling / offset
    plane.userData.wob = Math.random()*10;

    const root = new THREE.Group();
    root.add(plane);

    // spawn on empty cell away from spawn
    root.position.set(20 + Math.random()*120, 0, 20 + Math.random()*120);

    this.scene.add(root);

    const speed = 1.65 + Math.random()*0.9 + difficulty*0.45;

    return {
      root,
      plane,
      speed,
      state: "wander",
      nextTurn: 0,
      hitCooldown: 0
    };
  }

  update(dt, time, player, api) {
    const p = player.position;

    for (const e of this.enemies) {
      // billboard to camera
      e.plane.lookAt(player.camera.position);

      // wobble
      e.plane.userData.wob += dt * (2.2 + api.fear*2.0);
      const w = 1.0 + Math.sin(e.plane.userData.wob) * 0.03;
      e.plane.scale.set(w, w, 1);

      const ex = e.root.position.x;
      const ez = e.root.position.z;
      const dx = p.x - ex;
      const dz = p.z - ez;
      const d2 = dx*dx + dz*dz;

      const chaseRadius = 18 + api.fear*10;
      const chase2 = chaseRadius * chaseRadius;

      if (d2 < chase2) {
        e.state = "chase";
      } else if (e.state !== "wander") {
        e.state = "wander";
        e.nextTurn = time + 0.3 + Math.random()*2.0;
      }

      if (e.state === "chase") {
        const d = Math.sqrt(d2) + 0.00001;
        const vx = (dx/d) * e.speed;
        const vz = (dz/d) * e.speed;

        e.root.position.x += vx * dt;
        e.root.position.z += vz * dt;

        // collide with walls
        this.world.collideSphere(e.root.position, 0.55);

        // attack
        if (d < 1.3) {
          if (e.hitCooldown <= 0) {
            e.hitCooldown = 0.55;
            api.damage(6 + api.fear*6, 2.5 + api.fear*5);
            api.flashMessage("THE PNG IS TOO CLOSE.");
          }
        }
      } else {
        // wander
        if (time > e.nextTurn) {
          e.nextTurn = time + 0.6 + Math.random()*2.2;
          e.root.userData.wdir = Math.random()*Math.PI*2;
        }
        const ang = e.root.userData.wdir || 0;
        e.root.position.x += Math.cos(ang) * (0.55 + api.fear*0.25) * dt;
        e.root.position.z += Math.sin(ang) * (0.55 + api.fear*0.25) * dt;
        this.world.collideSphere(e.root.position, 0.55);
      }

      e.hitCooldown -= dt;

      // “glitch teleport” at very low sanity
      if (api.fear > 0.75 && Math.random() < 0.0025) {
        e.root.position.x = p.x + (Math.random()*2-1)*10;
        e.root.position.z = p.z + (Math.random()*2-1)*10;
        api.flashMessage("ENTITY DESYNC.");
      }
    }
  }
}
