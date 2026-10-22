import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankMatch, roleFor, recordChoice } from './penaltyEngine.js';

const choosePair = (m, shot, save) => {
  const shooter = m.turn % 2 === 0 ? 'host' : 'guest';
  const keeper = shooter === 'host' ? 'guest' : 'host';
  recordChoice(m, shooter, shot);
  recordChoice(m, keeper, save);
};

test('les 2 joueurs doivent choisir : choix de gardien secret jusque-la', () => {
  const state = blankMatch(3);
  assert.equal(roleFor(0,'host'), 'shooter');
  assert.equal(roleFor(0,'guest'), 'keeper');
  recordChoice(state, 'guest', 'center');
  assert.equal(state.turn, 0);
  assert.equal(state.history.length, 0);
  assert.equal(state.pending.keeper, 'center');
  recordChoice(state, 'host', 'right');
  assert.equal(state.turn, 1);
  assert.equal(state.scores.host, 1);
  assert.equal(roleFor(1,'guest'), 'shooter');
  assert.equal(roleFor(1,'host'), 'keeper');
});

test('3, 5 et 10 tirs par joueur et victoire', () => {
  for (const shots of [3,5,10]) {
    const s=blankMatch(shots);
    for(let i=0;i<shots*2;i++) {
      choosePair(s, i%2===0?'left':'center', i%2===0?'right':'center');
    }
    assert.equal(s.turn,shots*2);
    assert.equal(s.history.length,shots*2);
    assert.equal(s.scores.host,shots);
    assert.equal(s.scores.guest,0);
    assert.equal(s.winner,'host');
    assert.equal(s.finished,true);
  }
});

test('egalite -> 3 tirs de plus par joueur, puis winner', () => {
  const m=blankMatch(3);
  for(let i=0;i<6;i++) choosePair(m,'left','left');
  assert.equal(m.finished,false);
  assert.equal(m.totalPerPlayer,6);
  assert.equal(m.overtime,1);
  for(let i=0;i<6;i++) choosePair(m,i%2===1?'right':'left','left');
  assert.equal(m.turn,12);
  assert.equal(m.scores.guest,3);
  assert.equal(m.winner,'guest');
});

test('egalite persistante -> nouvelle serie de trois',()=>{
  const m=blankMatch(3);
  for(let i=0;i<12;i++) choosePair(m,'left','left');
  assert.equal(m.totalPerPlayer,9);
  assert.equal(m.overtime,2);
});
