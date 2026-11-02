import test from 'node:test';
import assert from 'node:assert/strict';
import {beginPenaltyDuel,choosePenaltyDuel,abandonPenaltyDuel,visiblePenaltyDuel} from './penaltyTournamentMatchRules.js';

test('3, 5, 10 tirs acceptes ; reglages invalides refuses',()=>{
  for(const n of [3,5,10])assert.equal(beginPenaltyDuel(n).regularPerPlayer,n);
  for(const n of [0,4,11,'bad'])assert.throws(()=>beginPenaltyDuel(n));
});
test('la direction de l adversaire reste secrete avant resolution',()=>{
  const s=beginPenaltyDuel(3);
  choosePenaltyDuel(s,'host','right');
  const v=visiblePenaltyDuel(s,'guest');
  assert.equal(v.myChoice,null);
  assert.equal(v.otherReady,true);
  assert.equal(v.history.length,0);
  assert.equal(JSON.stringify(v).includes('right'),false);
  assert.equal(Object.hasOwn(v,'pending'),false);
  assert.throws(()=>choosePenaltyDuel(s,'host','center'));
  choosePenaltyDuel(s,'guest','left');
  assert.equal(visiblePenaltyDuel(s,'guest').history[0].shot,'right');
});
test('choix frauduleux et joueurs invalides refuses',()=>{
  const s=beginPenaltyDuel(5);
  assert.throws(()=>choosePenaltyDuel(s,'admin','left'));
  assert.throws(()=>choosePenaltyDuel(s,'host','up'));
  assert.throws(()=>visiblePenaltyDuel(s,'visitor'));
});
test('certification d une victoire sur une serie complete de cinq tirs',()=>{
  const s=beginPenaltyDuel(5);
  for(let i=0;i<10;i++){
    const shooter=i%2===0?'host':'guest',keeper=i%2===0?'guest':'host';
    choosePenaltyDuel(s,shooter,i%2===0?'left':'right');
    choosePenaltyDuel(s,keeper,'right');
  }
  assert.equal(s.finished,true);
  assert.equal(s.winner,'host');
  assert.deepEqual(s.scores,{host:5,guest:0});
  assert.throws(()=>choosePenaltyDuel(s,'guest','left'));
  assert.throws(()=>abandonPenaltyDuel(s,'host'));
});
test('prolongation de 3 tirs puis gagnant unique',()=>{
  const s=beginPenaltyDuel(3);
  for(let i=0;i<6;i++){
    const shooter=i%2===0?'host':'guest',keeper=i%2===0?'guest':'host';
    choosePenaltyDuel(s,shooter,'left');choosePenaltyDuel(s,keeper,'left');
  }
  assert.equal(s.overtime,1);
  assert.equal(s.finished,false);
  for(let i=0;i<6;i++){
    const shooter=i%2===0?'host':'guest',keeper=i%2===0?'guest':'host';
    choosePenaltyDuel(s,shooter,i%2===1?'right':'left');choosePenaltyDuel(s,keeper,'left');
  }
  assert.equal(s.winner,'guest');
  assert.equal(s.finished,true);
});
test('abandon certifie adversaire et efface choix en attente',()=>{
  const s=beginPenaltyDuel(5);
  choosePenaltyDuel(s,'host','left');
  abandonPenaltyDuel(s,'host');
  assert.equal(s.finished,true);assert.equal(s.winner,'guest');assert.equal(s.forfeit,'host');
  assert.deepEqual(s.pending,{shooter:null,keeper:null});
});
