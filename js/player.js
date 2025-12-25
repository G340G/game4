import * as THREE from "three";

function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }

export class Player {
  constructor({ camera, dom }) {
    this.camera = camera;
    this.dom = dom;

    this.position = camera.position;
    this.velocity = new THREE.Vector3();

    // yaw/pitch in radians (stable)
    this.yaw = 0;
    this.pitch = 0;

    this.locked = false;
    this.sensitivity = 0.0022; // stable

    this.move = { f:0, b:0, l:0, r:0, run:false };
    this.canJump = false;

    this.radius = 0.42;
    this.eyeHeight = 1.7;
    this.walkSpeed = 4.4;
    this.runSpeed = 6.6;

    this._bind();
  }

  _bind() {
    this.dom.addEventListener("click", () => {
      if (!this.locked) this.dom.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = (document.pointerLockElement === this.dom);
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;

      // IMPORTANT: DO NOT accumulate roll, clamp pitch
      this.yaw   -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;

      // clamp pitch so it doesn't drift down forever
      const lim = Math.PI/2 - 0.02;
      this.pitch = clamp(this.pitch, -lim, lim);

      // apply to camera
      const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), this.yaw);
      const qPit = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), this.pitch);
      this.camera.quaternion.copy(qYaw).multiply(qPit);
    }, { passive:true });

    document.addEventListener("keydown", (e) => {
      if (e.code === "KeyW") this.move.f = 1;
      if (e.code === "KeyS") this.move.b = 1; // FIX: S is backward
      if (e.code === "KeyA") this.move.l = 1;
      if (e.code === "KeyD") this.move.r = 1;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.move.run = true;
      if (e.code === "Space") this._jump = true;
    });

    document.addEventListener("keyup", (e) => {
      if (e.code === "KeyW") this.move.f = 0;
      if (e.code === "KeyS") this.move.b = 0;
      if (e.code === "KeyA") this.move.l = 0;
      if (e.code === "KeyD") this.move.r = 0;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.move.run = false;
      if (e.code === "Space") this._jump = false;
    });
  }

  update(dt, world) {
    // gravity
    this.velocity.y -= 9.8 * 2.1 * dt;

    const speed = this.move.run ? this.runSpeed : this.walkSpeed;

    // movement direction based on yaw only
    const forward = new THREE.Vector3(0,0,-1).applyAxisAngle(new THREE.Vector3(0,1,0), this.yaw);
    const right   = new THREE.Vector3(1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0), this.yaw);

    let mx = (this.move.r - this.move.l);
    let mz = (this.move.f - this.move.b);

    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }

    const vx = (right.x * mx + forward.x * mz) * speed;
    const vz = (right.z * mx + forward.z * mz) * speed;

    // smooth accel
    const accel = 14.0;
    this.velocity.x += (vx - this.velocity.x) * clamp(accel*dt, 0, 1);
    this.velocity.z += (vz - this.velocity.z) * clamp(accel*dt, 0, 1);

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // collide in XZ as a sphere against wall cells
    world.collideSphere(this.position, this.radius);

    // y floor
    this.position.y += this.velocity.y * dt;
    if (this.position.y < this.eyeHeight) {
      this.position.y = this.eyeHeight;
      this.velocity.y = 0;
      this.canJump = true;
    }

    // jump
    if (this._jump && this.canJump) {
      this.velocity.y = 6.6;
      this.canJump = false;
    }
  }
}
