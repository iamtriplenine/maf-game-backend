import test from 'node:test';
import assert from 'node:assert/strict';
import {tankInitial,tankFire,tankCarve,tankSurface,tankForfeit,tankOfferDraw,tankCancelDraw,tankRespondDraw,TANK_WEAPONS,tankSimulate} from './tankEngine.js';
test('terrain deterministe', () => {assert.deepEqual(tankInitial(4).terrain,tankInitial(4).terrain);assert.equal(tankInitial(4).terrain.length,101);});
test('cratere modifie sol seulement autour impact', () => {let t=tankInitial(2).terrain;let n=tankCarve(t,45,10,6);assert.equal(n[1],t[1]);assert.ok(n[45]>t[45]);});
test('tir normal change le tour sans supprimer les autres tirs', () => {let s=tankInitial(4);tankFire(s,'host',{weapon:'shell',angle:40,power:70});assert.equal(s.round,1);assert.equal(s.toMove,'guest');assert.ok(s.lastShot.points.length>2);});
test('seul joueur actif peut agir', () => {let s=tankInitial();assert.throws(()=>tankFire(s,'guest',{weapon:'shell',angle:30,power:80}),/tour/);});
test('carburant debit correct, pas de valeur negative', () => {let s=tankInitial();tankFire(s,'host',{weapon:'direct',angle:15,power:85,drive:2});assert.equal(s.tanks.host.fuel,94);assert.equal(s.tanks.host.x,15);});
test('validation atomique munitions/carburant', () => {let s=tankInitial();assert.throws(()=>tankFire(s,'host',{weapon:'heavy',angle:42,power:55,drive:100}),/Deplacement/);assert.equal(s.tanks.host.ammo.heavy,3);assert.equal(s.round,0);});
test('munition decrementee', () => {let s=tankInitial();tankFire(s,'host',{weapon:'heavy',angle:40,power:50});assert.equal(s.tanks.host.ammo.heavy,2);});
test('armes disponibles', () => {for(const k of ['shell','heavy','stone','direct','sky','cluster']) assert.ok(TANK_WEAPONS[k]);});
test('proposition nulle, annulation, reponse', () => {let s=tankInitial();tankOfferDraw(s,'host');assert.throws(()=>tankCancelDraw(s,'guest'));tankCancelDraw(s,'host');tankOfferDraw(s,'host');tankRespondDraw(s,'guest',true);assert.equal(s.draw,true);});
test('forfait gagne a adversaire', () => {let s=tankInitial();tankForfeit(s,'host');assert.equal(s.winner,'guest');});
test('terrain prend en charge interpolation', () => {let s=tankInitial();assert.ok(tankSurface(s.terrain,27.6)>0);});
test('a 100 % de puissance, chaque arme peut depasser l adversaire', () => {
  for (const [key, w] of Object.entries(TANK_WEAPONS)) {
    let passe = false;
    for (let angle = w.minAngle || 1; angle <= 89 && !passe; angle++) {
      const s = tankInitial(4);
      tankFire(s, 'host', { weapon: key, angle, power: 100 });
      if (s.lastShot.impact.x >= 95) passe = true;
    }
    assert.ok(passe, key + ' ne depasse pas l adversaire a 100 %');
  }
});
test('missile vertical : angle minimum impose', () => {
  const s = tankInitial(4);
  assert.throws(() => tankFire(s, 'host', { weapon: 'sky', angle: 30, power: 80 }), /Angle trop bas/);
  assert.equal(s.round, 0);
  assert.equal(s.tanks.host.ammo.sky, 3);
});
test('missile vertical : monte, retombe avec la gravite et peut rater', () => {
  const s = tankInitial(4);
  tankFire(s, 'host', { weapon: 'sky', angle: 75, power: 40 });
  const ys = s.lastShot.points.map((p) => p.y);
  assert.ok(Math.min(...ys) < ys[0] - 10, 'le missile doit monter');
  assert.ok(s.lastShot.impact.x < 70, 'tir trop faible : retombe avant l adversaire');
  assert.equal(s.lastShot.damage.guest, 0);
});
test('tankSimulate donne exactement le resultat de tankFire (sans rien modifier)', () => {
  const armes = Object.keys(TANK_WEAPONS);
  for (let seed = 1; seed <= 12; seed++) for (const weapon of armes) for (const [angle, power] of [[40, 60], [62, 85], [80, 100], [25, 45]]) {
    const a = Math.max(angle, TANK_WEAPONS[weapon].minAngle || 0);
    const s = tankInitial(seed);
    const avant = JSON.stringify(s);
    const sim = tankSimulate(s, 'host', { weapon, angle: a, power, drive: 0 });
    assert.equal(JSON.stringify(s), avant, 'la simulation ne doit rien modifier');
    tankFire(s, 'host', { weapon, angle: a, power, drive: 0 });
    assert.deepEqual(sim.damage, s.lastShot.damage);
    assert.deepEqual(sim.impact, s.lastShot.impact);
    assert.deepEqual(sim.points, s.lastShot.points);
  }
});
