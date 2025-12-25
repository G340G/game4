export class UI {
  constructor() {
    this.hpBar = document.getElementById("hpBar");
    this.sanBar = document.getElementById("sanBar");
    this.crosshair = document.getElementById("crosshair");
    this.interact = document.getElementById("interact");
    this.objective = document.getElementById("objective");

    this.noteOverlay = document.getElementById("noteOverlay");
    this.noteTitle = document.getElementById("noteTitle");
    this.noteText = document.getElementById("noteText");
    this.noteClose = document.getElementById("noteClose");

    this.death = document.getElementById("death");
    this.deathReason = document.getElementById("deathReason");

    this.minimap = document.getElementById("minimap");
    this.mctx = this.minimap.getContext("2d");

    this._flashMsg = "";
    this._flashT = 0;

    this.noteClose.addEventListener("click", () => this.closeNote());
  }

  setBars(hp, san) {
    this.hpBar.style.width = `${Math.max(0, Math.min(100, hp))}%`;
    this.sanBar.style.width = `${Math.max(0, Math.min(100, san))}%`;
  }

  setObjective(text) {
    this.objective.textContent = text;
  }

  setInteract(active, text="") {
    if (active) {
      this.crosshair.classList.add("active");
      this.interact.style.display = "block";
      this.interact.textContent = text;
    } else {
      this.crosshair.classList.remove("active");
      this.interact.style.display = "none";
    }
  }

  openNote(title, content) {
    this.noteTitle.textContent = title;
    this.noteText.textContent = content;
    this.noteOverlay.style.display = "flex";
    document.exitPointerLock();
  }

  closeNote() {
    this.noteOverlay.style.display = "none";
    // mouse relock happens when player clicks canvas again
  }

  die(reason) {
    this.deathReason.textContent = reason;
    this.death.style.display = "flex";
    document.exitPointerLock();
  }

  flashMessage(msg) {
    this._flashMsg = msg;
    this._flashT = 1.6;
  }

  update(dt) {
    if (this._flashT > 0) {
      this._flashT -= dt;
      this.objective.textContent = this._flashMsg;
      if (this._flashT <= 0) this._flashMsg = "";
    }
  }

  // minimap with “lie mode”
  drawMinimap({ playerX, playerZ, enemies, world, fear }) {
    const ctx = this.mctx;
    const w = this.minimap.width;
    const h = this.minimap.height;

    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(0,0,w,h);

    // map lies more when fear is high
    const lie = Math.min(1, fear*1.25);
    const scale = 3.2;

    // draw walls
    ctx.fillStyle = "rgba(180,180,180,0.35)";
    const cx0 = Math.floor(playerX / world.cell);
    const cz0 = Math.floor(playerZ / world.cell);
    const radius = 18;

    for (let dz=-radius; dz<=radius; dz++){
      for (let dx=-radius; dx<=radius; dx++){
        const cx = cx0+dx, cz = cz0+dz;
        if (cx<0||cz<0||cx>=world.gridW||cz>=world.gridH) continue;

        let isWall = world.isWallCell(cx,cz);

        // lie: sometimes flip wall info
        if (Math.random() < lie*0.06) isWall = !isWall;

        if (!isWall) continue;

        const sx = w/2 + dx*scale + (Math.random()-0.5)*lie*1.2;
        const sy = h/2 + dz*scale + (Math.random()-0.5)*lie*1.2;
        ctx.fillRect(sx, sy, 2, 2);
      }
    }

    // enemies
    ctx.fillStyle = "rgba(255,60,60,0.85)";
    for (const e of enemies) {
      const dx = (e.root.position.x - playerX) / world.cell;
      const dz = (e.root.position.z - playerZ) / world.cell;
      const sx = w/2 + dx*scale;
      const sy = h/2 + dz*scale;
      // lie: random offsets
      ctx.fillRect(sx + (Math.random()-0.5)*lie*10, sy + (Math.random()-0.5)*lie*10, 3, 3);
    }

    // player
    ctx.fillStyle = "rgba(120,255,120,0.95)";
    ctx.beginPath();
    ctx.arc(w/2, h/2, 4, 0, Math.PI*2);
    ctx.fill();
  }
}
