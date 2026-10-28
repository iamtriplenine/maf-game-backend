import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tournamentSeats,calculateTournamentBudget,describeBudgetScenario,
  MIN_ORGANIZER_CENTS,STAKE_CENTS} from './tournamentDynamicBudget.js';

const C=f=>Math.round(f*100);
function total(p){return p.totalRealCents+p.totalBonusCents+p.remainingCents;}
for(const [n,sizes,refunds] of [
  [10,[5,5],0],[11,[5,5],1],[12,[5,5],2],[13,[5,5],3],
  [14,[5,5,4],0],[15,[5,5,5],0],[16,[5,5,5],1],
  [17,[5,5,5],2],[18,[5,5,4,4],0],[19,[5,5,5,4],0],[20,[5,5,5,5],0]]) {
  test(`effectif ${n}: plateaux et derniers remboursements`,()=>{
    const p=tournamentSeats(Array.from({length:n},(_,i)=>i+1));
    assert.deepEqual(p.groupSizes,sizes);
    assert.equal(p.refundIds.length,refunds);
    assert.deepEqual(p.refundIds,Array.from({length:refunds},(_,i)=>n-refunds+i+1));
  });
}
for(let n=10;n<=20;n++){
  test(`budget ${n}: centimes exacts, pas de double attribution, minimum 500`,()=>{
    const p=describeBudgetScenario(n);
    assert.equal(p.status,'planned');
    assert.equal(total(p),p.potCents);
    assert.equal(p.potCents,p.eligibleCount*STAKE_CENTS);
    assert.ok(p.remainingCents>=MIN_ORGANIZER_CENTS);
    assert.equal(new Set(p.lines.map(x=>x.userId)).size,p.eligibleCount);
    assert.equal(p.refundLines.length,n-p.eligibleCount);
    assert.equal(p.lines.length,p.eligibleCount);
    assert.equal(p.lines.filter(l=>l.place!==null).length,p.finalCount);
    assert.equal(p.lines.find(l=>l.place===1).realCents,n<=13?C(1900):C(2000));
    assert.equal(p.lines.find(l=>l.place===2).realCents,n<=13?C(1500):C(1600));
    assert.equal(p.refundsExecuted,false);
    assert.equal(p.paymentEnabled,false);
  });
}
test('cas de 18 joueurs: repartition exacte deja convenue',()=>{
  const p=describeBudgetScenario(18);
  const places=[1,2,3,4].map(i=>p.lines.find(l=>l.place===i));
  assert.deepEqual(places.map(x=>x.realCents),[200000,160000,135000,125000]);
  assert.deepEqual(places.map(x=>x.bonusCents),[10000,10000,15000,10000]);
  assert.equal(p.lines.filter(x=>x.place===null).length,14);
  assert.ok(p.lines.filter(x=>x.place===null).every(x=>x.realCents===2500&&x.bonusCents===10000));
  assert.equal(p.totalRealCents,655000);
  assert.equal(p.totalBonusCents,185000);
  assert.equal(p.remainingCents,60000);
});
test('20 inscrits: regle initiale conservee',()=>{
  const p=describeBudgetScenario(20);
  assert.equal(p.totalRealCents,750000);
  assert.equal(p.totalBonusCents,200000);
  assert.equal(p.remainingCents,50000);
  assert.ok(p.lines.filter(x=>x.place===null).every(x=>x.realCents===6250));
});
for(const n of [10,11,12,13])test(`${n} inscrits: prix reduits, remboursements, budget sur dix joueurs`,()=>{
  const p=describeBudgetScenario(n);
  assert.equal(p.status,'planned');
  assert.deepEqual(p.groupSizes,[5,5]);
  assert.equal(p.eligibleCount,10);
  assert.equal(p.refundIds.length,n-10);
  assert.equal(p.refundedCents,(n-10)*STAKE_CENTS);
  assert.equal(p.potCents,C(5000));
  assert.equal(p.totalRealCents,C(3500));
  assert.equal(p.totalBonusCents,C(1000));
  assert.equal(p.remainingCents,C(500));
  assert.deepEqual(p.lines.filter(x=>x.place!==null).map(x=>x.realCents),[C(1900),C(1500)]);
  assert.equal(p.lines.filter(x=>x.place===null).length,8);
  assert.ok(p.lines.filter(x=>x.place===null).every(x=>x.realCents===C(12.50)&&x.bonusCents===C(100)));
  assert.ok(p.lines.every(x=>x.bonusCents===C(100)));
  assert.equal(p.paymentEnabled,false);
  assert.equal(p.refundsExecuted,false);
});
for(let n=0;n<10;n++)test(`moins de dix (${n}): annulation et remboursement integral a effectuer`,()=>{
  const p=describeBudgetScenario(n);
  assert.equal(p.status,'cancel_and_refund');
  assert.equal(p.refundedCents,n*50000);
  assert.equal(p.potCents,0);
});
test('on ne peut pas dupliquer un inscrit, introduire un finaliste absent ou changer le classement',()=>{
  assert.throws(()=>tournamentSeats([1,1]));
  assert.throws(()=>calculateTournamentBudget(Array.from({length:18},(_,i)=>i+1),[1,2,3,99]));
  assert.throws(()=>calculateTournamentBudget(Array.from({length:18},(_,i)=>i+1),[1,2,2,3]));
});
test('les derniers payeurs sont remboursables selon ordre chronologique, pas ID',()=>{
  const ids=[101,50,23,9,24,65,4,33,22,19,2,1];
  const s=tournamentSeats(ids);
  assert.deepEqual(s.eligibleIds,ids.slice(0,10));
  assert.deepEqual(s.refundIds,[2,1]);
});
