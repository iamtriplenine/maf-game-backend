import test from 'node:test';
import assert from 'node:assert/strict';
import {penaltyAbsenceDecision,penaltyIdleDecision,PENALTY_IDLE_MS} from './penaltyTournamentProgressRules.js';
import {beginPenaltyDuel} from './penaltyTournamentMatchRules.js';
import {certifyPenaltyBracket} from './penaltyTournamentAwardRules.js';
const base={status:'waiting',scheduled_at:new Date(0).toISOString(),host_seen_at:null,guest_seen_at:null};
test('un present, un absent : 5 min puis le present gagne',()=>{
  const m={...base,host_seen_at:new Date(300000).toISOString()};
  assert.equal(penaltyAbsenceDecision(m,299000),null);
  assert.equal(penaltyAbsenceDecision(m,300000).winner,'host');
});
test('deux absents : 10 min puis les deux disqualifies',()=>{
  assert.equal(penaltyAbsenceDecision(base,300000),null);
  assert.deepEqual(penaltyAbsenceDecision(base,600000),{winner:null,reason:'deux_absents'});
});
test('en jeu, deux deconnectes : 10 min',()=>{
  const m={...base,status:'playing',playing_at:new Date(0).toISOString(),host_seen_at:new Date(1000).toISOString(),guest_seen_at:new Date(1000).toISOString()};
  assert.equal(penaltyAbsenceDecision(m,400000),null);
  assert.equal(penaltyAbsenceDecision(m,601000).reason,'deux_deconnectes');
});
test('en jeu, deux inactifs : 10 min',()=>{
  const s=beginPenaltyDuel(5),m={status:'playing',match_state:s};
  assert.equal(penaltyIdleDecision(m,s.turnStartedAt+PENALTY_IDLE_MS*2-1),null);
  assert.deepEqual(penaltyIdleDecision(m,s.turnStartedAt+PENALTY_IDLE_MS*2),{winner:null,reason:'deux_inactifs'});
});
const paid=ids=>ids.map(user_id=>({user_id,fee_paid:500}));
const win=(r,id,h,g,w)=>({id,round_no:r,match_no:id,host_id:h,guest_id:g,winner_id:w,status:'finished',match_state:{finished:true,winner:w===h?'host':'guest'}});
const dbl=(r,id,h,g)=>({id,round_no:r,match_no:id,host_id:h,guest_id:g,winner_id:null,status:'finished',match_state:{finished:true,winner:null,doubleForfeit:true}});
test('tableau certifiable avec un duel a deux disqualifies (8 joueurs)',()=>{
  const matches=[win(1,1,1,2,1),win(1,2,3,4,3),dbl(1,3,5,6),win(1,4,7,8,7),
    win(2,5,1,3,1),win(2,6,7,1,7)]; // tour 2 : 3 qualifies = 1 duel + 1 exempte (7)
  // 3 qualifies (1,3,7) : 1 duel (1-3) + exempte 7 ; puis finale 1 vs 7
  const m2=[matches[0],matches[1],matches[2],matches[3],win(2,5,1,3,1),win(3,6,1,7,1)];
  const p=certifyPenaltyBracket(paid([1,2,3,4,5,6,7,8]),{eligible_count:8,initial_match_count:4},m2,[{round_no:2,user_id:7}],{user_id:1});
  assert.equal(p.championId,1);assert.equal(p.runnerId,7);
});
test('un duel sans doubleForfeit reste refuse',()=>{
  const bad=dbl(1,3,5,6);delete bad.match_state.doubleForfeit;
  assert.throws(()=>certifyPenaltyBracket(paid([1,2,3,4,5,6,7,8]),{eligible_count:8,initial_match_count:4},
    [win(1,1,1,2,1),win(1,2,3,4,3),bad,win(1,4,7,8,7),win(2,5,1,3,1),win(3,6,1,7,1)],[{round_no:2,user_id:7}],{user_id:1}));
});
