// MAF Game - Tank Battle : moteur deterministe, sans navigateur ni DB.
// Unites : arena 100x100 (y augmente vers le bas), cellules de sol 0..100.
export const TANK_WIDTH = 100;
export const TANK_TURN_MS = 120_000;
export const TANK_MAX_ROUNDS = 30;
// speed = multiplicateur de vitesse de depart : a 100 % de puissance, chaque arme balistique
// peut depasser l'adversaire (portee max > 100). gravity = chute (plus grand = retombe vite).
// minAngle = angle minimum de tir (le missile vertical ne tire pas a plat).
export const TANK_WEAPONS = Object.freeze({
  shell: { label: 'Obus classique', damage: 26, radius: 8, crater: 5, ammo: null, gravity: 44, speed: 1.21 },
  heavy: { label: 'Missile lourd', damage: 36, radius: 10, crater: 8, ammo: 3, gravity: 42, speed: 1.13 },
  stone: { label: 'Bombe ronde', damage: 21, radius: 9, crater: 6, ammo: 4, gravity: 66, speed: 1.38 },
  direct: { label: 'Missile direct', damage: 22, radius: 7, crater: 3, ammo: 5, gravity: 0, speed: 1 },
  sky: { label: 'Missile vertical', damage: 30, radius: 9, crater: 7, ammo: 3, gravity: 40, speed: 1.15, minAngle: 55 },
  cluster: { label: 'Fragmentation', damage: 22, radius: 7, crater: 4, ammo: 2, gravity: 45, speed: 1.18 },
});
const rounded = (n, places = 2) => Math.round(n * (10 ** places)) / (10 ** places);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const opposite = (side) => side === 'host' ? 'guest' : 'host';
export const tankSurface = (terrain, x) => {
  const i = clamp(Math.floor(x), 0, 99);
  const t = clamp(x - i, 0, 1);
  return terrain[i] * (1 - t) + terrain[i + 1] * t;
};
export function tankTerrain(seed = 12345) {
  const s = Number(seed) >>> 0;
  return Array.from({ length: 101 }, (_, i) => {
    const phase = (s % 53) / 25;
    const noise = Math.sin(i * .21 + phase) * 6 + Math.sin(i * .087 + phase * .31) * 5 + Math.cos(i * .38) * 2;
    return rounded(clamp(71 + noise, 56, 85), 1);
  });
}
export function tankInitial(seed = 12345, now = Date.now()) {
  const terrain = tankTerrain(seed);
  const ammo = Object.fromEntries(Object.entries(TANK_WEAPONS).map(([k, w]) => [k, w.ammo]));
  return {
    game: 'tank', seed: Number(seed) >>> 0, terrain, toMove: 'host', round: 0,
    lastMoveAt: now, drawOffer: null, finished: false, draw: false, winner: null,
    forfeit: null, reason: null, lastShot: null,
    tanks: {
      host: { x: 13, hp: 100, fuel: 100, ammo: { ...ammo } },
      guest: { x: 87, hp: 100, fuel: 100, ammo: { ...ammo } },
    },
  };
}
export function tankCarve(terrain, cx, radius, depth) {
  const copy = terrain.slice();
  for (let i = 0; i <= 100; i++) {
    const d = Math.abs(i - cx);
    if (d < radius) {
      // Un cratere = le sol descend (y augmente), limite au bas de l'ecran.
      const delta = depth * Math.sqrt(Math.max(0, 1 - (d / radius) ** 2));
      copy[i] = rounded(clamp(copy[i] + delta, 0, 96), 1);
    }
  }
  return copy;
}
function sampleFlight(terrain, tank, opponent, angle, power, weapon, side) {
  const dir = side === 'host' ? 1 : -1;
  let x = tank.x + dir * 2.6;
  let y = tankSurface(terrain, tank.x) - 3;
  const shots = [{ x: rounded(x), y: rounded(y) }];
  const speed = (18 + (power / 100) * 41) * (TANK_WEAPONS[weapon].speed || 1);
  let vx = dir * speed * Math.cos(angle * Math.PI / 180);
  let vy = -speed * Math.sin(angle * Math.PI / 180);
  const dt = .045;
  for (let step = 0; step < 600; step++) {
    x += vx * dt;
    y += vy * dt;
    vy += TANK_WEAPONS[weapon].gravity * dt;
    if (step % 3 === 0) shots.push({ x: rounded(x), y: rounded(y) });
    if (x < 0 || x > 100 || y >= 101) return { impact: { x: rounded(clamp(x,0,100)), y: rounded(clamp(y,0,99)) }, points: shots };
    if (y < -30) continue;
    if (step > 5 && Math.hypot(x - opponent.x, y - (tankSurface(terrain,opponent.x)-2.6)) < 2.7) {
      return { impact: {x:rounded(x), y:rounded(y)}, points:shots };
    }
    if (step > 4 && y >= tankSurface(terrain,x)) return {impact:{x:rounded(x),y:rounded(tankSurface(terrain,x))},points:shots};
  }
  return { impact: {x: rounded(clamp(x,0,100)), y: rounded(clamp(y,0,99))}, points:shots };
}
function explosion(state, point, config, hits) {
  const before = state.terrain;
  state.terrain = tankCarve(before, point.x, config.radius, config.crater);
  for (const side of ['host','guest']) {
    const tank = state.tanks[side];
    const tankY = tankSurface(before,tank.x) - 2;
    const dist = Math.hypot(tank.x - point.x, tankY - point.y);
    const splash = Math.max(0, 1 - dist / (config.radius + 3));
    const drop = Math.max(0, tankSurface(state.terrain,tank.x) - tankSurface(before,tank.x));
    const damage = Math.max(0, Math.round(config.damage * splash) + Math.floor(drop / 4));
    tank.hp = Math.max(0, tank.hp - damage);
    hits[side] += damage;
  }
}
function assertSide(state, side) {
  if (!['host', 'guest'].includes(side)) throw new Error('Joueur invalide.');
  if (state.finished) throw new Error('Partie terminee.');
  if (state.toMove !== side) throw new Error("Ce n'est pas ton tour.");
}
export function tankFire(state, side, move = {}, now = Date.now()) {
  assertSide(state, side);
  const { weapon, angle, power, drive = 0 } = move || {};
  const config = TANK_WEAPONS[weapon];
  if (!config) throw new Error('Arme inconnue.');
  if (!Number.isFinite(angle) || angle < 0 || angle > 89 || !Number.isFinite(power) || power < 20 || power > 100)
    throw new Error('Angle ou puissance invalide.');
  if (config.minAngle && angle < config.minAngle) throw new Error('Angle trop bas pour ce missile.');
  if (!Number.isFinite(drive) || Math.abs(drive) > 8) throw new Error('Deplacement invalide.');
  const me = state.tanks[side], enemy = state.tanks[opposite(side)];
  if (!me || !enemy) throw new Error('Etat de chars invalide.');
  const fuel = Math.ceil(Math.abs(drive) * 3);
  if (fuel > me.fuel) throw new Error('Carburant insuffisant.');
  if (config.ammo !== null && !(me.ammo[weapon] > 0)) throw new Error('Munitions epuisees.');
  const destination = rounded(me.x + drive);
  if (destination < 5 || destination > 95 || Math.abs(destination - enemy.x) < 8)
    throw new Error('Deplacement impossible.');
  // On ne modifie l'etat qu'apres validation de tous les parametres.
  const beforeTerrain = state.terrain.slice();
  const beforeTanks = JSON.parse(JSON.stringify(state.tanks));
  me.x = destination;
  me.fuel -= fuel;
  if (config.ammo !== null) me.ammo[weapon] -= 1;
  const { impact, points } = sampleFlight(state.terrain, me, enemy, angle, power, weapon, side);
  const hits = {host:0,guest:0};
  explosion(state, impact, config, hits);
  if (weapon === 'cluster') {
    for (const offset of [-4,4]) explosion(state, {x:clamp(impact.x+offset,0,100),y:impact.y},
      {damage:8,radius:4,crater:3}, hits);
  }
  state.lastShot = {side,weapon,angle:rounded(angle),power:rounded(power),drive:rounded(drive),
    at:now, impact, points, damage:hits, round:state.round+1, beforeTerrain, beforeTanks};
  state.round += 1;
  state.lastMoveAt = now;
  state.drawOffer = null;
  if (state.tanks.host.hp <= 0 || state.tanks.guest.hp <= 0 || state.round >= TANK_MAX_ROUNDS) {
    const hostHp = state.tanks.host.hp, guestHp = state.tanks.guest.hp;
    state.finished = true;
    state.winner = hostHp === guestHp ? null : hostHp > guestHp ? 'host' : 'guest';
    state.draw = state.winner === null;
    state.reason = state.round >= TANK_MAX_ROUNDS ? 'limite_tours' : 'destruction';
  } else state.toMove = opposite(side);
  return state;
}
export function tankOfferDraw(state, side) {
  assertSideForOffer(state, side);
  if (state.drawOffer) throw new Error('Une proposition existe deja.');
  state.drawOffer = side;
  return state;
}
function assertSideForOffer(state,side) {
  if (!['host','guest'].includes(side)) throw new Error('Joueur invalide.');
  if (state.finished) throw new Error('Partie terminee.');
}
export function tankRespondDraw(state, side, accept) {
  assertSideForOffer(state, side);
  if (!state.drawOffer || state.drawOffer === side) throw new Error('Aucune proposition adverse.');
  if (typeof accept !== 'boolean') throw new Error('Reponse invalide.');
  state.drawOffer = null;
  if (accept) { state.draw = true; state.finished = true; state.winner = null; state.reason = 'accord_nul'; }
  return state;
}
export function tankCancelDraw(state, side) {
  assertSideForOffer(state, side);
  if (state.drawOffer !== side) throw new Error('Pas de proposition a annuler.');
  state.drawOffer = null;
  return state;
}
export function tankForfeit(state, side, reason = 'forfeit') {
  assertSideForOffer(state, side);
  state.finished = true; state.winner = opposite(side); state.draw = false;
  state.forfeit = side; state.reason = reason;
  return state;
}
export const tankView = (state, viewer) => ({
  ...state,
  viewer,
  myTurn: !state.finished && state.toMove === viewer,
});
