// ============================================================
//  TYPES DE MUNITIONS
//   standard  — tir d'origine (valeurs de DEFAULT_CONFIG)
//   rapide    — petite balle très rapide, cadence élevée
//   lourd     — obus lent, 2 dégâts, cadence lente
//   explosif  — explose à l'impact, dégâts de zone
//   ricochet  — rebondit 2 fois sur les murs
//  Chaque joueur a son type : config={{ ammo: ['lourd','rapide'] }}
// ============================================================

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

export const AMMO = {
  standard: { label: 'Standard' },
  rapide:   { label: 'Rapide',   speed: 600, r: 2.5, damage: 1, cooldown: 0.07, life: 1.6 },
  lourd:    { label: 'Lourd',    speed: 260, r: 7,   damage: 2, cooldown: 0.85, life: 3.2 },
  explosif: { label: 'Explosif', speed: 320, r: 5,   damage: 1, cooldown: 0.65, life: 2.6, splash: 46, splashDamage: 1 },
  ricochet: { label: 'Ricochet', speed: 400, r: 4,   damage: 1, cooldown: 0.4,  life: 3.4, bounces: 2 },
};
export const AMMO_NAMES = Object.keys(AMMO);

/** valeur unique ('lourd') ou tableau par joueur (['lourd','rapide']) */
export function perPlayer(v, i) {
  return Array.isArray(v) ? v[i] : v;
}

function def(name) { return AMMO[name] || AMMO.standard; }

export function createBullet(game, t, x, y, ca, sa) {
  const c = game.cfg;
  const name = AMMO[t.ammo] ? t.ammo : 'standard';
  const a = def(name);
  const std = name === 'standard';
  const speed = std ? c.bulletSpeed : a.speed;
  return {
    x, y, px: x, py: y, vx: ca * speed, vy: sa * speed,
    owner: t.i, color: t.color.main, ammo: name, bounces: 0,
    life: std ? c.bulletLife : a.life,
    r: std ? c.bulletRadius : a.r,
    damage: std ? c.damage : a.damage * c.damage,
  };
}

export function ammoCooldown(game, t) {
  const a = def(t.ammo);
  return a.cooldown != null && AMMO[t.ammo] && t.ammo !== 'standard' ? a.cooldown : game.cfg.fireCooldown;
}

/** Appelé quand un projectile touche un mur. Retourne true s'il doit disparaître. */
export function bulletHitWall(game, b, rc) {
  const a = def(b.ammo);
  if (a.bounces && b.bounces < a.bounces) {
    b.bounces++;
    const outX = b.px < rc.x || b.px > rc.x + rc.w;
    const outY = b.py < rc.y || b.py > rc.y + rc.h;
    if (outX && !outY) b.vx = -b.vx;
    else if (outY && !outX) b.vy = -b.vy;
    else { b.vx = -b.vx; b.vy = -b.vy; }
    b.x = b.px; b.y = b.py;
    game.impact(b.px, b.py, -b.vx, -b.vy);
    return false;
  }
  if (a.splash) explode(game, b, null);
  else game.impact(b.x, b.y, b.vx, b.vy);
  return true;
}

/** Appelé quand un projectile touche un char (avant le test d'élimination). */
export function afterHit(game, b, target) {
  if (def(b.ammo).splash) explode(game, b, target);
}

function explode(game, b, skip) {
  const a = def(b.ammo), R = a.splash;
  game.impact(b.x, b.y, b.vx, b.vy);
  for (let i = 0; i < 20; i++) {
    const an = Math.random() * TAU, s = 30 + Math.random() * 150;
    game.addParticle({ k: 'fire', x: b.x, y: b.y, vx: Math.cos(an) * s, vy: Math.sin(an) * s, life: 0.25 + Math.random() * 0.35, size: 5 + Math.random() * 8, drag: 3 });
  }
  game.addParticle({ k: 'ring', x: b.x, y: b.y, life: 0.4, size: R + 10 });
  game.shake = Math.max(game.shake, 0.5);
  for (const t of game.tanks) {
    if (!t.alive || t === skip || t.i === b.owner) continue;
    if (Math.hypot(t.x - b.x, t.y - b.y) < R + t.r) {
      t.hp -= a.splashDamage != null ? a.splashDamage : 1;
      t.hitFlash = 1;
      if (t.hp <= 0) game.kill(t);
    }
  }
}

// ---------------- Rendu des projectiles spéciaux ----------------
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Retourne true si le projectile a été dessiné (sinon le rendu standard s'applique). */
export function drawAmmoBullet(g, b, alpha) {
  if (!b.ammo || b.ammo === 'standard') return false;
  const x = lerp(b.px, b.x, alpha), y = lerp(b.py, b.y, alpha);
  g.save();
  g.translate(x, y);
  g.rotate(Math.atan2(b.vy, b.vx));
  g.lineCap = 'round';
  switch (b.ammo) {
    case 'rapide':
      g.strokeStyle = hexA(b.color, 0.5); g.lineWidth = 4.5;
      g.beginPath(); g.moveTo(-18, 0); g.lineTo(0, 0); g.stroke();
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(-9, 0); g.lineTo(3, 0); g.stroke();
      break;
    case 'lourd': {
      g.fillStyle = 'rgba(255,150,30,.3)'; g.beginPath(); g.arc(0, 0, 14, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,159,28,.85)';
      g.beginPath(); g.moveTo(-b.r, -4); g.lineTo(-b.r - 15, 0); g.lineTo(-b.r, 4); g.closePath(); g.fill();
      g.fillStyle = '#2b2d33'; g.beginPath(); g.ellipse(0, 0, b.r + 2, b.r, 0, 0, TAU); g.fill();
      g.strokeStyle = b.color; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#ffb703'; g.beginPath(); g.arc(b.r - 1, 0, 2.2, 0, TAU); g.fill();
      break;
    }
    case 'explosif': {
      const p = 0.5 + 0.5 * Math.sin(b.life * 28);
      g.fillStyle = `rgba(255,90,20,${0.25 + 0.2 * p})`; g.beginPath(); g.arc(0, 0, 9 + 3 * p, 0, TAU); g.fill();
      g.rotate(b.life * 6);
      g.strokeStyle = '#ffb703'; g.lineWidth = 1.5;
      for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU; g.beginPath(); g.moveTo(Math.cos(a) * 4, Math.sin(a) * 4); g.lineTo(Math.cos(a) * 8, Math.sin(a) * 8); g.stroke(); }
      g.fillStyle = '#ff4d2e'; g.beginPath(); g.arc(0, 0, b.r, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, 2, 0, TAU); g.fill();
      break;
    }
    case 'ricochet':
      g.strokeStyle = 'rgba(94,242,201,.4)'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(-14, 0); g.lineTo(-3, 0); g.stroke();
      g.rotate(b.life * 10);
      g.fillStyle = '#5ef2c9';
      g.beginPath(); g.moveTo(0, -6); g.lineTo(5, 0); g.lineTo(0, 6); g.lineTo(-5, 0); g.closePath(); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
      break;
    default:
      g.restore();
      return false;
  }
  g.restore();
  return true;
}
