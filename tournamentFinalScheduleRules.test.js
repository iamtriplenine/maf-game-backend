import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextFinalSlot, finalePreview, createFinaleMatch } from './tournamentFinalScheduleRules.js';
const at = t => `2026-10-30T${t}:00.000Z`;
test('l heure choisie reste la premiere plage',()=>assert.equal(new Date(nextFinalSlot(at('20:30'),at('20:25'))).toISOString(),at('20:30')));
test('reports exacts a cinq minutes',()=>{
  assert.equal(new Date(nextFinalSlot(at('20:05'),at('20:05'))).toISOString(),at('20:05'));
  assert.equal(new Date(nextFinalSlot(at('20:05'),at('20:06'))).toISOString(),at('20:10'));
  assert.equal(new Date(nextFinalSlot(at('20:05'),at('20:11'))).toISOString(),at('20:15'));
});
test('qualification non finie reporte le depart',()=>{
  const p=finalePreview({finalAt:at('20:05'),now:at('20:05'),qualifiedCount:3,qualificationsComplete:false});
  assert.equal(p.nextAt,at('20:10'));assert.equal(p.delayMinutes,5);
});
test('quatre finalistes avec des plateaux non termines ne declenchent pas la finale',()=>{
  const p=finalePreview({finalAt:at('20:05'),now:at('20:10'),qualifiedCount:4,qualificationsComplete:false});
  assert.equal(p.status,'waiting');assert.equal(p.nextAt,at('20:15'));
});
test('quatre finalistes et quatre qualifications terminees peuvent partir a l heure',()=>{
  const p=finalePreview({finalAt:at('20:05'),now:at('20:05'),qualifiedCount:4,qualificationsComplete:true});
  assert.equal(p.status,'ready');assert.equal(p.nextAt,at('20:05'));
});
test('programmation en avance reste programmee',()=>{
  const p=finalePreview({finalAt:at('20:30'),now:at('20:05'),qualifiedCount:4,qualificationsComplete:true});
  assert.equal(p.status,'scheduled');assert.equal(p.nextAt,at('20:30'));
});
test('quatre joueurs distincts creent quatre sieges',()=>{
  const f=[1,2,3,4].map(n=>({table:n,userId:n,name:`Joueur ${n}`}));
  const result=createFinaleMatch(f,({names})=>({players:names.map(x=>({name:x}))}));
  assert.equal(result.seats.length,4);assert.equal(result.game.players.length,4);
  assert.equal(result.format,'monopoly_final_4');
});
test('refus de doublons et de finalistes insuffisants',()=>{
  assert.throws(()=>createFinaleMatch([1,2,3].map(n=>({table:n,userId:n,name:'X'})),()=>({players:[]})));
  assert.throws(()=>createFinaleMatch([1,2,3,4].map(n=>({table:n,userId:1,name:'X'})),()=>({players:[]})));
});
test('dates invalides rejetees',()=>assert.throws(()=>nextFinalSlot('invalide',at('20:05'))));
test('une finale deja lancee ne se relance pas en simulation',()=>{
  const p=finalePreview({finalAt:at('20:05'),now:at('20:35'),qualifiedCount:4,qualificationsComplete:true,started:true});
  assert.equal(p.status,'started');assert.equal(p.nextAt,null);
});
