// ============================================================
//  MOTEUR DU JEU — logique pure (aucune dépendance React / DOM)
//  Fonctionne en pas fixe (60 Hz). Utilisable en local ou, plus
//  tard, en ligne : il suffit d'appeler game.setInput(i, true/false).
// ============================================================

import { resolveArena } from './tankRunArenas.js';
import { createBullet, ammoCooldown, bulletHitWall, afterHit, perPlayer } from './tankRunAmmo.js'; // MAF_TANK_EXTRAS_LOCAL_V1

export const ARENA = { w: 800, h: 480 };

export const DEFAULT_CONFIG = {
  hp: 3,               // points de vie par char
  damage: 1,           // dégâts par projectile
  tankRadius: 16,
  rotSpeed: 2.6,       // rotation automatique (rad/s) ≈ 150°/s
  moveSpeed: 110,      // vitesse d'avance (px/s)
  bulletSpeed: 380,
  bulletRadius: 4,
  bulletLife: 2.4,     // durée de vie d'un projectile (s)
  fireCooldown: 0.085, // cadence rapide : un tir toutes les 85 ms
  maxBullets: 24,      // suffisamment de projectiles pour une rafale prolongee
  burstGap: 0.30,      // reprise de la rotation apres 300 ms sans nouveau tap (s)
  holdThreshold: 0.26, // un vrai tap tactile (~200 ms) ne doit plus etre confondu avec un maintien
  countdown: 3,
  botSloppiness: 0.05, // imprécision des bots (rad)
};

export const PLAYER_COLORS = [
  { name: 'Rouge', main: '#e63946', dark: '#7d1520', light: '#ff8a92' },
  { name: 'Bleu',  main: '#2f8cff', dark: '#123e7a', light: '#8cc0ff' },
  { name: 'Vert',  main: '#3ddc57', dark: '#16601f', light: '#9af0a8' },
  { name: 'Jaune', main: '#ffc62e', dark: '#8a6200', light: '#ffe28a' },
];

const T = 14; // épaisseur des murs d'enceinte
export const OBSTACLES = [
  // enceinte
  { type: 'border', x: 0, y: 0, w: 800, h: T },
  { type: 'border', x: 0, y: 480 - T, w: 800, h: T },
  { type: 'border', x: 0, y: 0, w: T, h: 480 },
  { type: 'border', x: 800 - T, y: 0, w: T, h: 480 },
  // murs d'acier (symétrie centrale)
  { type: 'steel', x: 150, y: 110, w: 110, h: 14 },
  { type: 'steel', x: 540, y: 356, w: 110, h: 14 },
  { type: 'steel', x: 200, y: 260, w: 14, h: 110 },
  { type: 'steel', x: 586, y: 110, w: 14, h: 110 },
  // caisses
  { type: 'crate', x: 378, y: 218, w: 44, h: 44 },
  { type: 'crate', x: 300, y: 60, w: 44, h: 44 },
  { type: 'crate', x: 456, y: 376, w: 44, h: 44 },
  { type: 'crate', x: 90, y: 220, w: 44, h: 44 },
  { type: 'crate', x: 666, y: 216, w: 44, h: 44 },
  // rochers
  { type: 'rock', x: 620, y: 60, w: 50, h: 40 },
  { type: 'rock', x: 130, y: 380, w: 50, h: 40 },
];

const SPAWN = {
  bl: { x: 64, y: 416, corner: 'bl' },
  br: { x: 736, y: 416, corner: 'br' },
  tl: { x: 64, y: 64, corner: 'tl' },
  tr: { x: 736, y: 64, corner: 'tr' },
};

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export function angDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

function circleRectHit(x, y, r, rc) {
  const cx = clamp(x, rc.x, rc.x + rc.w);
  const cy = clamp(y, rc.y, rc.y + rc.h);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy < r * r;
}

function pushOut(o, r, rc) {
  const cx = clamp(o.x, rc.x, rc.x + rc.w);
  const cy = clamp(o.y, rc.y, rc.y + rc.h);
  const dx = o.x - cx, dy = o.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    const p = (r - d) / d;
    o.x += dx * p;
    o.y += dy * p;
  } else {
    const l = o.x - rc.x, rt = rc.x + rc.w - o.x, tp = o.y - rc.y, bt = rc.y + rc.h - o.y;
    const m = Math.min(l, rt, tp, bt);
    if (m === l) o.x = rc.x - r;
    else if (m === rt) o.x = rc.x + rc.w + r;
    else if (m === tp) o.y = rc.y - r;
    else o.y = rc.y + rc.h + r;
  }
}

export class Game {
  /**
   * @param {{human:boolean}[]} players  2 à 4 joueurs (les non-humains sont des bots)
   * @param {object} config              surcharge de DEFAULT_CONFIG
   */
  constructor(players, config = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.w = ARENA.w;
    this.h = ARENA.h;
    this.arena = resolveArena(this.cfg.arena);
    this.rects = this.arena ? this.arena.obstacles : OBSTACLES;
    const SP = (this.arena && this.arena.spawns) || SPAWN;
    const spawns = players.length === 2 ? [SP.bl, SP.tr] : [SP.bl, SP.br, SP.tl, SP.tr];
    this.tanks = players.map((p, i) => {
      const s = spawns[i];
      const a = Math.atan2(this.h / 2 - s.y, this.w / 2 - s.x);
      return {
        i, human: !!p.human, color: PLAYER_COLORS[i], corner: s.corner, r: this.cfg.tankRadius,
        skin: perPlayer(this.cfg.skins, i), ammo: perPlayer(this.cfg.ammo, i) || 'standard',
        x: s.x, y: s.y, px: s.x, py: s.y, angle: a, pangle: a,
        dir: Math.random() < 0.5 ? 1 : -1,
        hp: this.cfg.hp, alive: true,
        pressed: false, heldFor: 0, moving: false,
        pressAngle: a, burstAngle: a, burstTime: 0, pendingShots: 0, lastTapTime: 0,
        cooldown: 0, recoil: 0, hitFlash: 0, tread: 0, dust: 0,
        bot: p.human ? null : { mode: 'idle', wait: rand(0.5, 1.2), timer: 0, goal: 0 },
      };
    });
    this.bullets = [];
    this.particles = [];
    this.flashes = [];
    this.time = 0;
    this.phase = 'countdown'; // countdown → playing → ending → over
    this.countdown = this.cfg.countdown;
    this.goTimer = 0;
    this.endTimer = 0;
    this.shake = 0;
    this.winner = null;
    this.onOver = null;
  }

  // ---------- Entrée : UNE seule commande par joueur ----------
  setInput(i, down) {
    const t = this.tanks[i];
    if (!t) return;
    const active = this.phase === 'playing' || this.phase === 'ending';
    if (!t.alive || !active) {
      if (!down) { t.pressed = false; t.heldFor = 0; }
      return;
    }
    if (down && !t.pressed) {
      t.pressed = true;
      t.heldFor = 0;
      // Figer l'angle des le contact pour que le tir parte ou le joueur a vise.
      t.pressAngle = t.angle;
    } else if (!down && t.pressed) {
      const wasHold = t.heldFor >= this.cfg.holdThreshold;
      t.pressed = false;
      t.heldFor = 0;
      t.moving = false;
      if (wasHold) {
        // Un deplacement volontaire met fin a la rafale precedente.
        t.burstTime = 0;
        t.pendingShots = 0;
      } else {
        // Un tap = une demande de tir. Ne jamais la perdre a cause des 85 ms
        // de recharge du canon : l'executer au prochain pas de simulation.
        t.lastTapTime = this.time;
        t.pendingShots = Math.min(3, t.pendingShots + 1);
        if (this.fire(t)) t.pendingShots--;
      }
    }
  }

  fire(t) {
    const c = this.cfg;
    if (t.cooldown > 0 || !t.alive) return false;
    if (this.bullets.filter((b) => b.owner === t.i).length >= c.maxBullets) return false;
    // Pendant une rafale humaine, toutes les balles conservent l'angle du premier tir.
    // Les robots utilisent la logique de rotation d'origine.
    const alreadyBursting = t.human && t.burstTime > 0;
    const aim = t.human
      ? (alreadyBursting ? t.burstAngle : t.pressAngle)
      : t.angle;
    const ca = Math.cos(aim), sa = Math.sin(aim);
    const tipX = t.x + ca * (t.r + 8), tipY = t.y + sa * (t.r + 8);
    this.bullets.push(createBullet(this, t, tipX, tipY, ca, sa));
    this.flashes.push({ x: tipX, y: tipY, angle: aim, life: 0.09, max: 0.09 });
    t.cooldown = ammoCooldown(this, t);
    t.recoil = 1;
    if (t.human) {
      t.angle = aim;
      t.burstAngle = aim;
      t.burstTime = c.burstGap; // chaque nouveau tir prolonge la rafale
      if (!alreadyBursting) t.dir *= -1; // une inversion au debut de chaque rafale
    } else {
      t.dir *= -1; // les tirs des bots conservent leur regle initiale
    }
    this.shake = Math.max(this.shake, 0.08);
    return true;
  }

  // ---------- Boucle (dt fixe recommandé : 1/60) ----------
  update(dt) {
    const c = this.cfg;
    this.time += dt;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.phase = 'playing'; this.goTimer = 0.8; }
    } else if (this.goTimer > 0) this.goTimer -= dt;

    const live = this.phase === 'playing' || this.phase === 'ending';

    for (const t of this.tanks) {
      t.px = t.x; t.py = t.y; t.pangle = t.angle;
      if (!t.alive) continue;
      t.cooldown = Math.max(0, t.cooldown - dt);
      t.burstTime = Math.max(0, t.burstTime - dt);
      // Traiter les clics arrives pendant la recharge : un seul tir par cooldown,
      // mais le premier tap et les taps tres rapides ne sont plus ignores.
      if (t.human && t.pendingShots > 0 && this.fire(t)) {
        t.pendingShots--;
        // Le delai de 300 ms part du DERNIER TAP, non d'un tir differe.
        t.burstTime = Math.max(0, c.burstGap - (this.time - t.lastTapTime));
      }
      t.recoil = Math.max(0, t.recoil - dt * 6);
      t.hitFlash = Math.max(0, t.hitFlash - dt * 4);
      if (t.bot && this.phase === 'playing') this.botThink(t, dt);
      if (t.pressed) t.heldFor += dt;
      t.moving = live && t.pressed && t.heldFor >= c.holdThreshold;
      if (t.moving) {
        // L'appui long reprend la priorite : le char avance dans la direction visee.
        t.burstTime = 0;
        t.pendingShots = 0;
        const sp = c.moveSpeed * dt;
        t.x += Math.cos(t.angle) * sp;
        t.y += Math.sin(t.angle) * sp;
        t.tread += sp;
        t.dust -= dt;
        if (t.dust <= 0) {
          t.dust = 0.07;
          this.puff(t.x - Math.cos(t.angle) * t.r, t.y - Math.sin(t.angle) * t.r);
        }
      } else if (!(t.human && (t.pressed || t.burstTime > 0 || t.pendingShots > 0))) {
        // Rotation uniquement hors appui et hors rafale humaine.
        t.angle += t.dir * c.rotSpeed * dt;
      }
    }

    this.resolveCollisions();
    this.updateBullets(dt);

    if (this.phase === 'playing') {
      const alive = this.tanks.filter((t) => t.alive);
      if (alive.length <= 1) {
        this.phase = 'ending';
        this.endTimer = 1.6;
        this.winner = alive.length ? alive[0].i : -1;
      }
    } else if (this.phase === 'ending') {
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.phase = 'over';
        for (const t of this.tanks) { t.pressed = false; t.moving = false; t.heldFor = 0; }
        if (this.onOver) this.onOver(this.winner);
      }
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      this.flashes[i].life -= dt;
      if (this.flashes[i].life <= 0) this.flashes.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (p.drag) { const f = Math.max(0, 1 - p.drag * dt); p.vx *= f; p.vy *= f; }
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }

  resolveCollisions() {
    const alive = this.tanks.filter((t) => t.alive);
    for (let pass = 0; pass < 2; pass++) {
      for (const t of alive) {
        t.x = clamp(t.x, t.r, this.w - t.r);
        t.y = clamp(t.y, t.r, this.h - t.r);
        for (const rc of this.rects) pushOut(t, t.r, rc);
      }
      for (let a = 0; a < alive.length; a++) {
        for (let b = a + 1; b < alive.length; b++) {
          const A = alive[a], B = alive[b];
          const dx = B.x - A.x, dy = B.y - A.y;
          const min = A.r + B.r;
          const d2 = dx * dx + dy * dy;
          if (d2 < min * min) {
            const d = Math.sqrt(d2) || 0.001;
            const push = (min - d) / 2;
            const nx = dx / d, ny = dy / d;
            A.x -= nx * push; A.y -= ny * push;
            B.x += nx * push; B.y += ny * push;
          }
        }
      }
    }
  }

  updateBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.px = b.x; b.py = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      let dead = b.life <= 0 || b.x < 0 || b.y < 0 || b.x > this.w || b.y > this.h;
      if (!dead) {
        for (const rc of this.rects) {
          if (circleRectHit(b.x, b.y, b.r, rc)) { dead = bulletHitWall(this, b, rc); break; }
        }
      }
      if (!dead) {
        for (const t of this.tanks) {
          if (!t.alive || t.i === b.owner) continue;
          const dx = t.x - b.x, dy = t.y - b.y;
          const rr = t.r + b.r - 2;
          if (dx * dx + dy * dy < rr * rr) { this.hit(t, b); dead = true; break; }
        }
      }
      if (dead) this.bullets.splice(i, 1);
    }
    // deux projectiles adverses qui se croisent s'annulent
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      for (let j = i - 1; j >= 0; j--) {
        const a = this.bullets[i], b = this.bullets[j];
        if (!a || !b || a.owner === b.owner) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy < 49) {
          this.impact((a.x + b.x) / 2, (a.y + b.y) / 2, a.vx, a.vy);
          this.bullets.splice(i, 1);
          this.bullets.splice(j, 1);
          break;
        }
      }
    }
  }

  hit(t, b) {
    t.hp -= b.damage != null ? b.damage : this.cfg.damage;
    afterHit(this, b, t);
    t.hitFlash = 1;
    this.shake = Math.max(this.shake, 0.3);
    this.impact(b.x, b.y, b.vx, b.vy);
    for (let i = 0; i < 3; i++) {
      this.addParticle({ k: 'debris', x: b.x, y: b.y, vx: rand(-90, 90), vy: rand(-90, 90), life: rand(0.4, 0.7), size: rand(2, 4), color: t.color.main, vr: rand(-10, 10), drag: 2 });
    }
    if (t.hp <= 0) this.kill(t);
  }

  kill(t) {
    t.alive = false; t.pressed = false; t.moving = false; t.hp = 0;
    this.shake = 1;
    const x = t.x, y = t.y;
    for (let i = 0; i < 26; i++) {
      const a = rand(0, TAU), s = rand(30, 190);
      this.addParticle({ k: 'fire', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.35, 0.8), size: rand(6, 15), drag: 2.5 });
    }
    for (let i = 0; i < 28; i++) {
      const a = rand(0, TAU), s = rand(120, 360);
      this.addParticle({ k: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.7), size: 2, color: pick(['#ffe08a', '#ffb703', '#ffffff']), drag: 1.5 });
    }
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU), s = rand(10, 70);
      this.addParticle({ k: 'smoke', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.9, 1.6), size: rand(8, 16), drag: 1.2 });
    }
    for (let i = 0; i < 9; i++) {
      const a = rand(0, TAU), s = rand(80, 240);
      this.addParticle({ k: 'debris', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.7, 1.2), size: rand(3, 6), color: pick([t.color.main, t.color.dark, '#333']), vr: rand(-12, 12), drag: 1.4 });
    }
    this.addParticle({ k: 'ring', x, y, life: 0.5, size: 70 });
  }

  impact(x, y, vx, vy) {
    const base = Math.atan2(-vy, -vx);
    for (let i = 0; i < 7; i++) {
      const a = base + rand(-1, 1), s = rand(60, 200);
      this.addParticle({ k: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.2, 0.4), size: 2, color: '#ffe08a', drag: 2 });
    }
    this.addParticle({ k: 'smoke', x, y, vx: 0, vy: 0, life: 0.5, size: 6, drag: 1 });
    this.addParticle({ k: 'ring', x, y, life: 0.22, size: 16 });
  }

  puff(x, y) {
    this.addParticle({ k: 'dust', x, y, vx: rand(-12, 12), vy: rand(-12, 12), life: 0.45, size: rand(4, 7), drag: 2 });
  }

  addParticle(p) {
    if (this.particles.length > 420) this.particles.shift();
    this.particles.push({ vx: 0, vy: 0, drag: 0, rot: 0, vr: 0, color: '#fff', size: 4, ...p, max: p.life });
  }

  // ---------- Bots (utilisent exactement la même commande unique) ----------
  hasLOS(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    const n = Math.ceil(d / 8);
    for (let k = 1; k < n; k++) {
      const x = a.x + (dx * k) / n, y = a.y + (dy * k) / n;
      for (const rc of this.rects) if (circleRectHit(x, y, 3, rc)) return false;
    }
    return true;
  }

  clearPath(t, ang, len) {
    for (let d = 18; d <= len; d += 14) {
      const x = t.x + Math.cos(ang) * d, y = t.y + Math.sin(ang) * d;
      for (const rc of this.rects) if (circleRectHit(x, y, t.r + 2, rc)) return false;
    }
    return true;
  }

  botThink(t, dt) {
    const b = t.bot, c = this.cfg;
    if (b.mode === 'tap' || b.mode === 'hold') {
      b.timer -= dt;
      if (b.timer <= 0) { this.setInput(t.i, false); b.mode = 'idle'; b.wait = rand(0.1, 0.35); }
      return;
    }
    b.wait -= dt;
    if (b.wait > 0) return;
    const enemies = this.tanks.filter((o) => o !== t && o.alive);
    if (!enemies.length) return;

    if (t.cooldown <= 0) {
      const predicted = t.angle + t.dir * c.rotSpeed * 0.07; // le tir part au relâchement
      for (const e of enemies) {
        const d = Math.hypot(e.x - t.x, e.y - t.y);
        const ta = Math.atan2(e.y - t.y, e.x - t.x);
        const tol = Math.atan2(e.r * 0.9, d) + rand(0, c.botSloppiness);
        if (Math.abs(angDiff(predicted, ta)) < tol && this.hasLOS(t, e)) {
          this.setInput(t.i, true);
          b.mode = 'tap';
          b.timer = 0.06;
          return;
        }
      }
    }

    if (b.mode === 'idle') {
      let near = enemies[0], nd = Infinity;
      for (const e of enemies) {
        const d = Math.hypot(e.x - t.x, e.y - t.y);
        if (d < nd) { nd = d; near = e; }
      }
      const base = Math.atan2(near.y - t.y, near.x - t.x);
      let off;
      if (nd > 190) off = rand(-0.7, 0.7);
      else if (Math.random() < 0.5) off = (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2) + rand(-0.3, 0.3);
      else off = Math.PI + rand(-0.5, 0.5);
      const cands = [off, off + 0.6, off - 0.6, off + 1.2, off - 1.2, off + 1.8, off - 1.8, off + Math.PI];
      let goal = base + off;
      for (const o of cands) {
        if (this.clearPath(t, base + o, 70)) { goal = base + o; break; }
      }
      b.goal = goal;
      b.mode = 'aim';
      b.timer = 3;
    } else if (b.mode === 'aim') {
      b.timer -= dt;
      if (Math.abs(angDiff(t.angle, b.goal)) < 0.1) {
        this.setInput(t.i, true);
        b.mode = 'hold';
        b.timer = rand(0.4, 0.95);
      } else if (b.timer <= 0) b.mode = 'idle';
    }
  }
}
