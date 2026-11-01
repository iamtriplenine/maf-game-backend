import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { penaltyBracketPlan } from './penaltyTournamentPlan.js';
for (const cap of [8,16,32]) for(const stake of [200,500]) for(let n=0;n<=cap;n++){
  test(`cap=${cap} fee=${stake} registered=${n}`,()=>{
    const plan=penaltyBracketPlan(cap,stake,n);
    assert.equal(plan.players % 2,0);
    assert.equal(plan.registered,plan.players+plan.refunded);
    assert.equal(plan.refundsAmount+plan.pot,plan.gross);
    assert.equal(plan.initialMatches,plan.players/2);
    assert.equal(plan.totalMatches,plan.players>0?plan.players-1:0);
    if(plan.players>=2) assert.equal(plan.rounds.at(-1).qualified,1);
  });
}
test('14 inscrits -> sept duels puis exemption d’un qualifié',()=>{
  const x=penaltyBracketPlan(16,500,14);
  assert.deepEqual(x.rounds.map(r=>[r.matches,r.byes]),[[7,0],[3,1],[2,0],[1,0]]);
  assert.equal(x.pot,7000);
});
test('15 inscrits -> un remboursement au dernier inscrit',()=>{
  const x=penaltyBracketPlan(16,200,15);
  assert.equal(x.refunded,1);assert.equal(x.refundsAmount,200);assert.equal(x.pot,2800);
});
test('interdiction effectifs et mises invalides',()=>{
  assert.throws(()=>penaltyBracketPlan(20,500,14));
  assert.throws(()=>penaltyBracketPlan(16,100,14));
  assert.throws(()=>penaltyBracketPlan(16,200,17));
});
