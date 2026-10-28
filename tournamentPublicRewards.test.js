import test from 'node:test';
import assert from 'node:assert/strict';
import { rewardScenario, PUBLIC_REWARD_SCENARIOS, TOURNAMENT_FORMATS } from './tournamentPublicRewards.js';
import { payoutPlan } from './tournamentPayoutRules.js';

for (const n of TOURNAMENT_FORMATS) {
  test(`affichage public et paiement certifie identiques pour ${n} joueurs`,()=>{
    const preview=rewardScenario(n);
    const ids=Array.from({length:n},(_,i)=>i+1);
    const paid=payoutPlan(ids,ids.slice(0,preview.groupSizes.length));
    assert.deepEqual(preview.groupSizes.map((size)=>size).reduce((a,b)=>a+b,0),n);
    assert.deepEqual(preview.finalists.map(x=>x.realFranc),paid.lines.filter(l=>l.place!==null).map(l=>l.realFranc));
    assert.deepEqual(preview.finalists.map(x=>x.bonusFranc),paid.lines.filter(l=>l.place!==null).map(l=>l.bonusFranc));
    const eliminated=paid.lines.filter(l=>l.place===null);
    assert.equal(preview.eliminatedCount,eliminated.length);
    assert.equal(preview.eliminatedMinFranc,Math.min(...eliminated.map(x=>x.realFranc)));
    assert.equal(preview.eliminatedMaxFranc,Math.max(...eliminated.map(x=>x.realFranc)));
    assert.equal(preview.organizerFranc,paid.organizerFranc);
    assert.equal(preview.totalRealFranc+preview.totalBonusFranc+preview.organizerFranc,n*500);
  });
}
test('les six formats publics sont uniques et correspondent aux effets de bord reels',()=>{
  assert.deepEqual(PUBLIC_REWARD_SCENARIOS.map(x=>x.players),TOURNAMENT_FORMATS);
  assert.equal(rewardScenario(18).finalists[2].bonusFranc,150);
  assert.deepEqual([rewardScenario(20).eliminatedMinFranc,rewardScenario(20).eliminatedMaxFranc],[62,63]);
  assert.throws(()=>rewardScenario(17),/non eligible/);
  assert.throws(()=>rewardScenario(21),/non eligible/);
});
