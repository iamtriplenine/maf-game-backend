// MAF_TANKRUN_LAG_V1 : le tir part la ou le joueur visait, meme avec du retard reseau.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getTankRunRuntime, tankRunPress, tankRunAngleAt, dropTankRunRuntime } from './tankRunRealtime.js';

const STEP = 1 / 60;
function makeRuntime(id) {
  const room = { id, status: 'playing', host_id: 1, guest_id: 2,
    match_state: { type: 'tankrun', arena: 'original', skins: ['origine', 'origine'] } };
  const x = getTankRunRuntime(room, () => {}, null);
  clearInterval(x.timer); // on pilote le temps a la main : test deterministe
  const step = (seconds) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      x.g.update(STEP);
      for (const b of x.g.bullets) if (b.id == null) b.id = ++x.bulletId;
      x.hist.push({ t: x.g.time, a: [x.g.tanks[0].angle, x.g.tanks[1].angle] });
    }
  };
  step(3.2); // compte a rebours
  assert.equal(x.g.phase, 'playing');
  return { x, step };
}
const deg = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180 / Math.PI;
const lastShot = (x) => { const b = x.g.bullets.filter((q) => q.owner === 0).pop(); return b ? Math.atan2(b.vy, b.vx) : null; };

test('le tir part a l\'angle vu par le joueur (300 ms de retard)', () => {
  const { x, step } = makeRuntime(9001);
  step(0.37);
  const vt = x.g.time - 0.3;
  const seen = tankRunAngleAt(x, 0, vt);
  assert.ok(deg(x.g.tanks[0].angle, seen) > 20, 'le serveur est bien en avance sur l\'ecran');
  tankRunPress(x, 0, true, null, 1, 'epoch-test-aa', { vt, aim: seen });
  step(0.05);
  tankRunPress(x, 0, false, null, 2, 'epoch-test-aa', { held: 0.05 });
  step(STEP);
  const shot = lastShot(x);
  assert.notEqual(shot, null, 'un tir doit partir');
  assert.ok(deg(shot, seen) < 0.5, `ecart de visee ${deg(shot, seen)}`);
  dropTankRunRuntime(9001);
});

test('appui/relachement recus dans le desordre : le tir n\'est pas perdu', () => {
  const { x, step } = makeRuntime(9002);
  step(0.2);
  const seen = tankRunAngleAt(x, 0, x.g.time - 0.2);
  tankRunPress(x, 0, false, null, 2, 'epoch-test-bb', { held: 0.06 });
  assert.equal(x.g.bullets.filter((q) => q.owner === 0).length, 0, 'le relachement attend l\'appui');
  tankRunPress(x, 0, true, null, 1, 'epoch-test-bb', { vt: x.g.time - 0.2, aim: seen });
  step(STEP);
  assert.ok(lastShot(x) != null, 'tir effectue malgre le desordre');
  assert.equal(x.inq[0].next, 3);
  dropTankRunRuntime(9002);
});

test('un tap en retard reseau reste un tap (duree mesuree par le client)', () => {
  const { x, step } = makeRuntime(9003);
  const t0 = x.g.tanks[0];
  const before = { x: t0.x, y: t0.y };
  t0.angle = Math.atan2(x.g.h / 2 - t0.y, x.g.w / 2 - t0.x); // vers le centre, pas vers un mur
  step(0.02);
  const aim = tankRunAngleAt(x, 0, x.g.time);
  tankRunPress(x, 0, true, null, 1, 'epoch-test-cc', { vt: x.g.time, aim });
  step(0.45); // le relachement arrive tres tard
  tankRunPress(x, 0, false, null, 2, 'epoch-test-cc', { held: 0.08 });
  step(STEP);
  assert.ok(lastShot(x) != null, 'tap = tir, pas un deplacement');
  assert.ok(Math.hypot(x.g.tanks[0].x - before.x, x.g.tanks[0].y - before.y) < 60);
  dropTankRunRuntime(9003);
});

test('un angle truque est ignore (retour a l\'historique serveur)', () => {
  const { x, step } = makeRuntime(9004);
  step(0.3);
  const vt = x.g.time - 0.1;
  const real = tankRunAngleAt(x, 0, vt);
  tankRunPress(x, 0, true, null, 1, 'epoch-test-dd', { vt, aim: real + 2 });
  tankRunPress(x, 0, false, null, 2, 'epoch-test-dd', { held: 0.05 });
  step(STEP);
  assert.ok(deg(lastShot(x), real) < 0.5);
  dropTankRunRuntime(9004);
});

test('le snapshot leger est petit et sans donnees fixes', () => {
  const { x } = makeRuntime(9005);
  const lite = x.lite(false), full = x.lite(true);
  assert.equal(lite.rects, undefined);
  assert.ok(Array.isArray(full.rects) && full.cfg);
  assert.ok(JSON.stringify(lite).length < 6000, 'snapshot leger');
  assert.ok(JSON.stringify(x.snapshot()).length > JSON.stringify(lite).length);
  dropTankRunRuntime(9005);
});
