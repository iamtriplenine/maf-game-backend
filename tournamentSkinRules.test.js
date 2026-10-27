import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTournamentSkinPlan, resultAnimationSteps } from './tournamentSkinRules.js';
import { buildTournamentAwardPlan } from './tournamentAwardRules.js';
const participants = Array.from({length:20},(_,i)=>i+1);
const awards = buildTournamentAwardPlan(participants,[4,3,2,1]);
const plan = buildTournamentSkinPlan(awards.lines);

test('vingt skins de participation et quatre skins de finaliste', () => {
  assert.deepEqual(resultAnimationSteps(plan),{participants:20,participation:20,finalists:4,total:24});
});
test('chaque finaliste recoit les deux types, chaque elimine un seul', () => {
  for(const id of participants){
    const kinds=plan.filter(x=>x.userId===id).map(x=>x.kind).sort();
    assert.deepEqual(kinds, id<=4 ? ['finalist','participation'] : ['participation']);
  }
});
test('un deuxieme calcul du meme resultat est identique', () => {
  assert.deepEqual(buildTournamentSkinPlan(awards.lines),plan);
});
test('20 participants sans classement complet sont refuses', () => {
  assert.throws(()=>buildTournamentSkinPlan(awards.lines.slice(0,19)),/20 participants/);
  assert.throws(()=>buildTournamentSkinPlan(awards.lines.map((l,i)=>i===4?{...l,userId:1}:l)),/en double/);
  assert.throws(()=>buildTournamentSkinPlan(awards.lines.map(l=>l.place===4?{...l,place:3}:l)),/incoherent/);
  assert.throws(()=>buildTournamentSkinPlan(awards.lines.map(l=>l.place===1?{...l,outcome:'eliminated'}:l)),/incompatible/);
});
