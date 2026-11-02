import test from 'node:test';
import assert from 'node:assert/strict';
import {penaltyIdleDecision,penaltyAbsenceDecision,PENALTY_IDLE_MS} from './penaltyTournamentProgressRules.js';
import {beginPenaltyDuel,choosePenaltyDuel,visiblePenaltyDuel} from './penaltyTournamentMatchRules.js';
const mk=(state,extra={})=>({status:'playing',match_state:state,scheduled_at:new Date(0),playing_at:new Date(0),
  host_seen_at:new Date(),guest_seen_at:new Date(),...extra});
test('aucun chrono avant 5 minutes',()=>{
  const s=beginPenaltyDuel(5);
  assert.equal(penaltyIdleDecision(mk(s),s.turnStartedAt+PENALTY_IDLE_MS-1),null);
});
test('le joueur inactif perd apres 5 minutes (le tireur n a pas joue)',()=>{
  const s=beginPenaltyDuel(5);choosePenaltyDuel(s,'guest','left'); // gardien joue, tireur=host inactif
  assert.deepEqual(penaltyIdleDecision(mk(s),s.turnStartedAt+PENALTY_IDLE_MS),{winner:'guest',reason:'inactivite_tir'});
});
test('le gardien inactif perd',()=>{
  const s=beginPenaltyDuel(5);choosePenaltyDuel(s,'host','left');
  assert.equal(penaltyIdleDecision(mk(s),s.turnStartedAt+PENALTY_IDLE_MS).winner,'host');
});
test('le chrono repart apres chaque tir',()=>{
  const s=beginPenaltyDuel(5);s.turnStartedAt=1000;
  choosePenaltyDuel(s,'host','left');choosePenaltyDuel(s,'guest','right');
  assert.ok(s.turnStartedAt>1000);assert.equal(s.turn,1);
  assert.equal(penaltyIdleDecision(mk(s),s.turnStartedAt+10),null);
});
test('deux inactifs : pas de decision ici (cas traite a part)',()=>{
  const s=beginPenaltyDuel(5);
  assert.equal(penaltyIdleDecision(mk(s),s.turnStartedAt+PENALTY_IDLE_MS*3).reason,'deux_inactifs');
});
test('connecte (presence fraiche) mais inactif : disqualifie quand meme',()=>{
  const s=beginPenaltyDuel(5);choosePenaltyDuel(s,'guest','left');
  const now=s.turnStartedAt+PENALTY_IDLE_MS+1;
  const d=penaltyAbsenceDecision(mk(s,{host_seen_at:new Date(now),guest_seen_at:new Date(now)}),now);
  assert.equal(d.winner,'guest');
});
test('ancien match sans chrono : ignore',()=>{
  const s=beginPenaltyDuel(5);delete s.turnStartedAt;
  assert.equal(penaltyIdleDecision(mk(s),Date.now()+PENALTY_IDLE_MS*9),null);
});
test('l echeance est visible pour l interface',()=>{
  const s=beginPenaltyDuel(5);
  assert.equal(visiblePenaltyDuel(s,'host').turnDeadline,s.turnStartedAt+PENALTY_IDLE_MS);
});
