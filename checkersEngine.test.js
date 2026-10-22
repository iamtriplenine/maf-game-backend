import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blankCheckers, customState, legalMoves, applyMove, offerDraw, respondDraw,
  forfeitCheckers, checkersView, idx,
} from './checkersEngine.js';

test('position de depart : 20 pions chacun, 9 premiers coups pour les blancs', () => {
  const state = blankCheckers();
  assert.equal(state.board.filter((p) => p === 'w').length, 20);
  assert.equal(state.board.filter((p) => p === 'b').length, 20);
  assert.equal(state.toMove, 'host');
  assert.equal(legalMoves(state).length, 9);
});

test('mauvais tour et coup interdit refuses', () => {
  const state = blankCheckers();
  const first = legalMoves(state)[0];
  assert.throws(() => applyMove(state, 'guest', first), /tour/);
  assert.throws(() => applyMove(state, 'host', { from: first.from, path: [0] }), /interdit/);
  assert.throws(() => applyMove(state, 'host', { from: 'x', path: [] }), /invalide/);
  applyMove(state, 'host', first);
  assert.equal(state.toMove, 'guest');
  assert.equal(state.ply, 1);
});

test('la prise est obligatoire et la partie est gagnee quand l adversaire n a plus de pieces', () => {
  const state = customState({ [idx(5, 4)]: 'w', [idx(9, 2)]: 'w', [idx(4, 3)]: 'b' });
  const moves = legalMoves(state);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].from, idx(5, 4));
  assert.deepEqual(moves[0].path, [idx(3, 2)]);
  applyMove(state, 'host', { from: idx(5, 4), path: [idx(3, 2)] });
  assert.equal(state.board[idx(4, 3)], '.');
  assert.equal(state.finished, true);
  assert.equal(state.winner, 'host');
});

test('prise majoritaire : on doit jouer la rafle la plus longue', () => {
  const state = customState({
    [idx(6, 9)]: 'w', [idx(5, 8)]: 'b',
    [idx(9, 0)]: 'w', [idx(8, 1)]: 'b', [idx(6, 3)]: 'b',
  });
  const moves = legalMoves(state);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].from, idx(9, 0));
  assert.deepEqual(moves[0].path, [idx(7, 2), idx(5, 4)]);
  assert.equal(moves[0].captured.length, 2);
});

test('un pion prend aussi en arriere', () => {
  const state = customState({ [idx(4, 3)]: 'w', [idx(5, 4)]: 'b', [idx(0, 1)]: 'b' });
  const moves = legalMoves(state);
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].path, [idx(6, 5)]);
});

test('dame volante : prend de loin et peut se poser sur toute case libre derriere', () => {
  const state = customState({ [idx(9, 0)]: 'W', [idx(6, 3)]: 'b', [idx(0, 5)]: 'b' });
  const moves = legalMoves(state);
  const landings = moves.map((m) => m.path.at(-1)).sort((a, b) => a - b);
  assert.deepEqual(landings, [idx(0, 9), idx(1, 8), idx(2, 7), idx(3, 6), idx(4, 5), idx(5, 4)].sort((a, b) => a - b));
  assert.ok(moves.every((m) => m.from === idx(9, 0) && m.captured.length === 1));
});

test('promotion en fin de coup, mais pas en passant par la derniere ligne', () => {
  const simple = customState({ [idx(1, 2)]: 'w', [idx(4, 5)]: 'b' });
  applyMove(simple, 'host', { from: idx(1, 2), path: [idx(0, 1)] });
  assert.equal(simple.board[idx(0, 1)], 'W');

  const passing = customState({ [idx(2, 1)]: 'w', [idx(1, 2)]: 'b', [idx(1, 4)]: 'b', [idx(8, 9)]: 'b' });
  const moves = legalMoves(passing);
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].path, [idx(0, 3), idx(2, 5)]);
  applyMove(passing, 'host', { from: idx(2, 1), path: [idx(0, 3), idx(2, 5)] });
  assert.equal(passing.board[idx(2, 5)], 'w'); // reste un pion

  const ends = customState({ [idx(2, 3)]: 'w', [idx(1, 2)]: 'b', [idx(5, 6)]: 'b' });
  applyMove(ends, 'host', { from: idx(2, 3), path: [idx(0, 1)] });
  assert.equal(ends.board[idx(0, 1)], 'W');
  assert.equal(ends.finished, false);
});

test('nulle apres 25 coups chacun de dames sans prise', () => {
  const state = customState({ [idx(9, 0)]: 'W', [idx(0, 9)]: 'B' }, 'host', { noProgress: 49 });
  applyMove(state, 'host', { from: idx(9, 0), path: [idx(8, 1)] });
  assert.equal(state.finished, true);
  assert.equal(state.draw, true);
  assert.equal(state.winner, null);
});

test('nulle d un commun accord, et la proposition tombe si un coup est joue', () => {
  const agreed = blankCheckers();
  offerDraw(agreed, 'host');
  assert.throws(() => offerDraw(agreed, 'host'), /deja/);
  assert.throws(() => respondDraw(agreed, 'host', true), /Aucune/);
  respondDraw(agreed, 'guest', true);
  assert.equal(agreed.draw, true);
  assert.equal(agreed.finished, true);

  const lapsed = blankCheckers();
  offerDraw(lapsed, 'guest');
  applyMove(lapsed, 'host', legalMoves(lapsed)[0]);
  assert.equal(lapsed.drawOffer, null);
  offerDraw(lapsed, 'host');
  respondDraw(lapsed, 'guest', false);
  assert.equal(lapsed.drawOffer, null);
  assert.equal(lapsed.finished, false);
});

test('abandon et vue du joueur', () => {
  const state = blankCheckers();
  const mine = checkersView(state, 'host');
  assert.equal(mine.myTurn, true);
  assert.equal(mine.legal.length, 9);
  assert.equal(checkersView(state, 'guest').legal.length, 0);
  forfeitCheckers(state, 'guest', 'return_timeout');
  assert.equal(state.winner, 'host');
  assert.equal(state.forfeit, 'guest');
  assert.equal(checkersView(state, 'host').finished, true);
});

test('une partie entiere au hasard se termine sans erreur', () => {
  for (let game = 0; game < 20; game += 1) {
    const state = blankCheckers();
    let guard = 0;
    while (!state.finished && guard < 800) {
      const moves = legalMoves(state);
      assert.ok(moves.length > 0);
      const move = moves[Math.floor(Math.random() * moves.length)];
      applyMove(state, state.toMove, { from: move.from, path: move.path });
      guard += 1;
    }
    assert.ok(state.board.length === 100);
  }
});
