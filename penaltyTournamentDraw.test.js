import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPenaltyDraw,penaltyDuelReference} from './penaltyTournamentDraw.js';
const mk=(n,fee=200)=>Array.from({length:n},(_,i)=>({user_id:i+1,pseudo:`P${i+1}`,fee_paid:fee}));
for(const capacity of [8,16,32])for(let n=2;n<=capacity;n++){
  test(`${capacity} places / ${n} inscrits : uniquement des duels disjoints`,()=>{
    const entries=mk(n);const d=buildPenaltyDraw({capacity,entry_fee:200},entries,()=>0);
    const expected=n-(n%2);
    assert.equal(d.pairs.length,expected/2);
    assert.equal(d.refundedUserId,n%2?n:null);
    const ids=d.pairs.flatMap(p=>[p.host.userId,p.guest.userId]);
    assert.equal(new Set(ids).size,expected);
    assert.equal(ids.includes(n),n%2===0);
    assert.equal(d.plan.pot,expected*200);
    assert.equal(d.plan.totalMatches,expected-1);
    assert.deepEqual(d.pairs.map(p=>p.matchNo),d.pairs.map((_,i)=>i+1));
  });
}
test('Inscription unique, argent conforme et nombre minimal',()=>{
  assert.throws(()=>buildPenaltyDraw({capacity:8,entry_fee:200},mk(1)));
  assert.throws(()=>buildPenaltyDraw({capacity:8,entry_fee:200},[...mk(2),mk(1)[0]]));
  assert.throws(()=>buildPenaltyDraw({capacity:8,entry_fee:500},mk(2,200)));
  assert.throws(()=>buildPenaltyDraw({capacity:8,entry_fee:200},mk(9)));
  assert.throws(()=>buildPenaltyDraw({capacity:8,entry_fee:200},mk(2),()=>3));
});
test('Reference stable',()=>assert.equal(penaltyDuelReference(21,1,2,'102'), 'MAF-T000021-P1-D02-M000102'));
