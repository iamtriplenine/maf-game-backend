import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankCheckers, offerDraw, cancelDraw, respondDraw, legalMoves, applyMove, checkersView } from './checkersEngine.js';

test('la proposition peut etre annulee par son auteur', () => {
  const s = blankCheckers(); offerDraw(s, 'host');
  assert.equal(checkersView(s, 'guest').drawOffer, 'host');
  cancelDraw(s, 'host');
  assert.equal(checkersView(s, 'guest').drawOffer, null);
  assert.equal(s.finished, false);
  assert.equal(s.draw, false);
});
test('un adversaire ne peut pas annuler la proposition recue', () => {
  const s = blankCheckers(); offerDraw(s, 'guest');
  assert.throws(() => cancelDraw(s, 'host'), /Aucune proposition/);
  assert.equal(s.drawOffer, 'guest');
});
test('annuler sans proposition est refuse', () => {
  assert.throws(() => cancelDraw(blankCheckers(), 'host'), /Aucune proposition/);
});
test('le proposant peut reproposer apres annulation', () => {
  const s = blankCheckers(); offerDraw(s, 'host'); cancelDraw(s, 'host'); offerDraw(s, 'host');
  assert.equal(s.drawOffer, 'host');
  respondDraw(s, 'guest', false);
  assert.equal(s.drawOffer, null);
  assert.equal(s.finished, false);
});
test('annulation impossible apres acceptation d une nulle', () => {
  const s = blankCheckers(); offerDraw(s, 'host'); respondDraw(s, 'guest', true);
  assert.throws(() => cancelDraw(s, 'host'), /Partie terminee/);
  assert.equal(s.finished, true);
  assert.equal(s.draw, true);
});
test('annulation ne touche ni aux pions ni au compteur de coups', () => {
  const s = blankCheckers();
  const before = [...s.board]; offerDraw(s, 'host'); cancelDraw(s, 'host');
  assert.deepEqual(s.board, before); assert.equal(s.ply, 0);
  applyMove(s, 'host', legalMoves(s)[0]); assert.equal(s.ply, 1);
});
