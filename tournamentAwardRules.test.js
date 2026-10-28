import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTournamentAwardPlan, certifiedFinalOrder, francText,
  EXPECTED_BONUS_CENTS, EXPECTED_REAL_CENTS, EXPECTED_REMAINING_CENTS
} from './tournamentAwardRules.js';
const users = Array.from({length:20},(_,i)=>i+1);

test('20 inscrits : 4 finalistes + 16 elimines, aucun joueur oublie',()=>{
  const plan=buildTournamentAwardPlan(users,[4,3,2,1]);
  assert.equal(plan.lines.length,20);
  assert.equal(new Set(plan.lines.map(x=>x.userId)).size,20);
  assert.deepEqual(plan.lines.filter(x=>x.place).map(x=>x.place).sort(),[1,2,3,4]);
  assert.equal(plan.lines.filter(x=>x.outcome==='eliminated').length,16);
});
test('montants exacts 2000 / 1600 / 1500 / 1400 et 62,50 reels',()=>{
  const p=buildTournamentAwardPlan(users,[1,2,3,4]);
  assert.deepEqual(p.lines.slice(0,4).map(x=>x.realCents),[200000,160000,150000,140000]);
  assert.ok(p.lines.slice(4).every(x=>x.realCents===6250 && x.bonusCents===10000));
  assert.equal(francText(6250),'62,50');
});
test('budget confirme : 7500 reels, 2000 bonus, 500 restants',()=>{
  const p=buildTournamentAwardPlan(users,[1,2,3,4]);
  assert.equal(p.totalRealCents,EXPECTED_REAL_CENTS);
  assert.equal(p.totalBonusCents,EXPECTED_BONUS_CENTS);
  assert.equal(p.remainingCents,EXPECTED_REMAINING_CENTS);
  assert.equal(p.stakesCents,1000000);
});
test('un joueur non inscrit ou une repetition est refuse',()=>{
  assert.throws(()=>buildTournamentAwardPlan(users,[1,2,3,25]),/non inscrit/);
  assert.throws(()=>buildTournamentAwardPlan(users,[1,2,2,3]),/doublons/);
  assert.throws(()=>buildTournamentAwardPlan([...users.slice(0,19),19],[1,2,3,4]),/doublons/);
});
test('classement non certifie bloque, meme quand un gagnant existe',()=>{
  const state={format:'monopoly_final_4',seats:users.slice(0,4).map(userId=>({userId})),
    game:{phase:'over',winner:0,players:users.slice(0,4).map((_,i)=>({bankrupt:i!==0}))}};
  assert.throws(()=>certifiedFinalOrder(state),/non certifie/);
});
test('une certification contradictoire au vainqueur est refusee',()=>{
  const state={format:'monopoly_final_4',seats:users.slice(0,4).map(userId=>({userId})),
    game:{phase:'over',winner:0,players:users.slice(0,4).map((_,i)=>({bankrupt:i!==0}))},certification:{kind:'server-elimination-order-v1',source:'authoritative-game-events',order:[2,1,3,4]}};
  assert.throws(()=>certifiedFinalOrder(state),/ne correspond pas/);
});
test('un classement valide doit rester produit uniquement par un moteur serveur',()=>{
  const state={format:'monopoly_final_4',seats:users.slice(0,4).map(userId=>({userId})),
    game:{phase:'over',winner:2,players:users.slice(0,4).map((_,i)=>({bankrupt:i!==2}))},eliminationOrder:[2,1,4],certification:{kind:'server-elimination-order-v1',source:'authoritative-game-events',order:[3,4,1,2]}};
  assert.deepEqual(certifiedFinalOrder(state),[3,4,1,2]);
});
