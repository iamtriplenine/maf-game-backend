import test from 'node:test';
import assert from 'node:assert/strict';
import { initialLudo, rollLudo, autoTurnLudo } from './ludoEngine.js';

test('minuteur expire : de normal sans 6 passe au rival, pas de forfait', () => {
  const a = autoTurnLudo(initialLudo(100), () => 3, () => 0, 200);
  assert.equal(a.toMove, 'guest');
  assert.equal(a.finished, false);
  assert.equal(a.forfeit, null);
  assert.equal(a.lastMoveAt, 200);
  assert.match(a.lastAction, /bot automatique/);
});
test('minuteur expire : un 6 libere un pion, sans perte de partie', () => {
  const a = autoTurnLudo(initialLudo(100), () => 6, () => 0, 200);
  assert.deepEqual(a.tokens.red, [0,-1,-1,-1]);
  assert.equal(a.toMove, 'host'); // le 6 donne un nouveau lancer
  assert.equal(a.finished, false);
  assert.equal(a.roll, null);
  assert.equal(a.forfeit, null);
});
test('minuteur expire apres lancer : le bot choisit un pion autorise sans relancer', () => {
  const b = rollLudo(initialLudo(100), 'host', () => 6, 150);
  const a = autoTurnLudo(b, () => { throw new Error('pas de deuxieme lancer'); }, () => 3, 300);
  assert.deepEqual(a.tokens.red, [-1,-1,-1,0]);
  assert.equal(a.toMove, 'host');
  assert.equal(a.lastMoveAt, 300);
});
test('minuteur expire : une victoire normale peut conclure la partie', () => {
  const b=initialLudo(100);
  b.tokens.red=[56,56,56,50];
  const a=autoTurnLudo(b, () => 6, () => 0, 200);
  assert.equal(a.finished,true);
  assert.equal(a.winner,'host');
  assert.equal(a.forfeit,null);
});
test('minuteur expire : de pas de mouvement, aucune perte de mise', () => {
  const a=autoTurnLudo(initialLudo(100), () => 1, () => 0, 200);
  assert.equal(a.toMove,'guest');
  assert.equal(a.roll,null);
  assert.equal(a.finished,false);
});
test('minuteur expire : selection hors plage refusee', () => {
  assert.throws(()=>autoTurnLudo(initialLudo(100),()=>6,()=>4,200),/Choix automatique invalide/);
});
