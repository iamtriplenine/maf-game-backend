import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDice, rollDice, diceView, validateDiceSettings } from './diceEngine.js';

const play = (state, hostDice, guestDice) => {
  const ints = [...hostDice, ...guestDice];
  const fake = (lo, hi) => { assert.equal(lo, 1); assert.equal(hi, 7); return ints.shift(); };
  rollDice(state, 'host', fake);
  rollDice(state, 'guest', fake);
  assert.equal(ints.length, 0);
};

test('configurations: 1/2 des, 1/3/5/10 coups, mode separe/cumule', () => {
  for (const n of [1,2]) for (const shots of [1,3,5,10]) {
    for (const mode of shots === 1 ? ['separate'] : ['separate', 'cumulative']) {
      assert.doesNotThrow(() => validateDiceSettings(n, shots, mode));
    }
  }
  assert.throws(() => validateDiceSettings(3,3,'separate'));
  assert.throws(() => validateDiceSettings(1,4,'separate'));
  assert.throws(() => validateDiceSettings(1,1,'cumulative'));
});

test('lancer cache tant que les deux ne jouent pas, pas de double lancer', () => {
  const game = initialDice(2, 1, 'separate');
  rollDice(game, 'host', () => 6);
  assert.equal(diceView(game, 'guest').opponentRolled, true);
  assert.equal(JSON.stringify(diceView(game, 'guest')).includes('"dice":[6,6]'), false);
  assert.throws(() => rollDice(game, 'host', () => 1), /deja lance/);
  rollDice(game, 'guest', () => 1);
  assert.equal(game.winner, 'host');
  assert.deepEqual(game.history[0].host.dice, [6,6]);
  assert.equal(game.finished, true);
  assert.throws(() => rollDice(game, 'host'), /terminee/);
});

test('trois coups separes: celui qui gagne 2 manches l emporte meme si son total est inferieur', () => {
  const game = initialDice(1, 3, 'separate');
  play(game, [2], [1]);
  play(game, [2], [1]);
  play(game, [1], [6]);
  assert.deepEqual(game.wins, {host:2,guest:1,draw:0});
  assert.deepEqual(game.totals, {host:5,guest:8});
  assert.equal(game.winner, 'host');
});

test('cinq coups cumules: addition de chaque lancer; meilleur total gagne', () => {
  const game = initialDice(2, 5, 'cumulative');
  for (let i=0;i<5;i++) play(game, [6,5], [3,4]);
  assert.deepEqual(game.totals, {host:55,guest:35});
  assert.equal(game.winner, 'host');
});

test('dix coups separes: egalite finale = match nul et non choix arbitraire', () => {
  const game = initialDice(1, 10, 'separate');
  for (let i=0;i<10;i++) play(game, [i%2?2:6], [i%2?6:2]);
  assert.deepEqual(game.wins, {host:5,guest:5,draw:0});
  assert.equal(game.finished, true); assert.equal(game.winner, null); assert.equal(game.draw, true);
});

test('egalite de points (un coup ou mode cumule) = match nul', () => {
  const one = initialDice(1,1,'separate');
  play(one,[4],[4]); assert.equal(one.draw,true);
  const summed = initialDice(1,3,'cumulative');
  play(summed,[4],[2]); play(summed,[1],[2]); play(summed,[3],[4]);
  assert.equal(summed.draw,true);
});

test('une valeur de de hors 1..6 est rejetee', () => {
  assert.throws(() => rollDice(initialDice(1,1,'separate'),'host',()=>7), /invalide/);
});
