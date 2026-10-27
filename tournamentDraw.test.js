import test from 'node:test';
import assert from 'node:assert/strict';
import { qualificationDraw } from './tournamentDraw.js';
const players=Array.from({length:20},(_,i)=>({userId:i+1,name:`Joueur ${i+1}`}));
test('quatre plateaux de cinq, sans oubli ni doublon',()=>{
  const groups=qualificationDraw(players);
  assert.deepEqual(groups.map(g=>g.players.length),[5,5,5,5]);
  assert.deepEqual(groups.map(g=>g.table),[1,2,3,4]);
  assert.deepEqual(new Set(groups.flatMap(g=>g.players.map(p=>p.userId))).size,20);
  groups.forEach(g=>assert.deepEqual(g.players.map(p=>p.seat),[0,1,2,3,4]));
});
test('randomisation controlee, borne superieure valide',()=>{
  const groups=qualificationDraw(players,()=>0);
  assert.notDeepEqual(groups.flatMap(g=>g.players.map(p=>p.userId)),players.map(p=>p.userId));
});
test('controle strict des inscriptions',()=>{
  assert.throws(()=>qualificationDraw(players.slice(0,19)),/vingt/);
  assert.throws(()=>qualificationDraw([...players.slice(0,19),players[0]]),/repetee/);
  assert.throws(()=>qualificationDraw([...players.slice(0,19),{userId:21,name:''}]),/invalide/);
  assert.throws(()=>qualificationDraw(players,()=>999),/Generateur/);
});
test('le tableau initial reste intact',()=>{
  const before=structuredClone(players);
  qualificationDraw(players);assert.deepEqual(players,before);
});
