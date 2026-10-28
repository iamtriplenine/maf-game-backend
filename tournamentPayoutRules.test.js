import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutPlan } from './tournamentPayoutRules.js';
import { tournamentSeats } from './tournamentDynamicBudget.js';
for(const size of [10,14,15,18,19,20]){
  test(`paiements ${size} inscrits : francs entiers, budget conserve, les bons finalistes`,()=>{
    const ids=Array.from({length:size},(_,i)=>i+1);
    const finalists=ids.slice(0,tournamentSeats(ids).groupSizes.length).reverse();
    const plan=payoutPlan(ids,finalists);
    assert.equal(plan.lines.length,size);
    assert.deepEqual(plan.lines.filter(x=>x.place!==null).map(x=>x.userId),finalists.slice().reverse());
    assert.ok(plan.lines.every(x=>Number.isInteger(x.realFranc) && Number.isInteger(x.bonusFranc)&&x.realFranc>=0&&x.bonusFranc>=0));
    assert.equal(plan.lines.reduce((n,x)=>n+x.realFranc+x.bonusFranc,0)+plan.organizerFranc,size*500);
    assert.ok(plan.organizerFranc>=500);
    assert.equal(plan.totalRealFranc,plan.lines.reduce((n,x)=>n+x.realFranc,0));
    assert.equal(plan.totalBonusFranc,plan.lines.reduce((n,x)=>n+x.bonusFranc,0));
    assert.deepEqual(payoutPlan(ids,finalists),plan); // retries deterministes
  });
}
test('a 20, les 62,50 F deviennent 8 x 62 et 8 x 63 F (aucun centime perdu du pot)',()=>{
  const ids=Array.from({length:20},(_,i)=>i+1);
  const plan=payoutPlan(ids,[1,2,3,4]);
  assert.equal(plan.totalRealFranc,7500);
  assert.equal(plan.totalBonusFranc,2000);
  assert.equal(plan.organizerFranc,500);
  assert.deepEqual(plan.lines.slice(4).map(x=>x.realFranc),[63,63,63,63,63,63,63,63,62,62,62,62,62,62,62,62]);
});
test('a 18, regle speciale des 600 F organisateur conservee',()=>{
  const ids=Array.from({length:18},(_,i)=>i+1);
  assert.equal(payoutPlan(ids,[1,2,3,4]).organizerFranc,600);
});
test('pas de versement sur 11, 13, 16, 17 inscriptions, ni rang incoherent',()=>{
  for(const n of [11,13,16,17]){
    const ids=Array.from({length:n},(_,i)=>i+1);
    assert.throws(()=>payoutPlan(ids,ids.slice(0,2)),/remboursees|non payable|invalide/);
  }
  assert.throws(()=>payoutPlan(Array.from({length:10},(_,i)=>i+1),[1,1]),/repetes/);
});
