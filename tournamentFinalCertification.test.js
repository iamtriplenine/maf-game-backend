import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureFinalCertification} from './tournamentFinalCertification.js';
import {certifiedFinalOrder} from './tournamentAwardRules.js';
const base=n=>({format:`monopoly_final_${n}`,
  seats:Array.from({length:n},(_,i)=>({userId:100+i})),
  game:{phase:'roll',winner:null,players:Array.from({length:n},(_,i)=>({id:i,bankrupt:false})),log:[]},
  eliminationOrder:[]});
for(const n of [2,3,4])test(`${n} finalistes : ordre complet uniquement depuis les faillites moteur`,()=>{
  let state=base(n);
  for(let i=0;i<n-1;i++){
    const game=structuredClone(state.game);
    game.players[i].bankrupt=true;
    game.log.unshift({n:i+1,player:i,kind:'bankrupt'});
    if(i===n-2){game.phase='over';game.winner=n-1;}
    state=captureFinalCertification(state,game);
  }
  assert.deepEqual(state.eliminationOrder,Array.from({length:n-1},(_,i)=>100+i));
  assert.deepEqual(certifiedFinalOrder(state),[100+n-1,...Array.from({length:n-1},(_,i)=>100+n-2-i)]);
});
test('deux forfaits simultanes : ordre determine par sequence de logs, pas index',()=>{
  const s=base(4),game=structuredClone(s.game);
  game.players[2].bankrupt=true;game.players[0].bankrupt=true;
  game.log=[{n:2,player:0,kind:'bankrupt'},{n:1,player:2,kind:'bankrupt'}];
  const next=captureFinalCertification(s,game);
  assert.deepEqual(next.eliminationOrder,[102,100]);
});
test('interdit de deviner un classement sans journal moteur',()=>{
  const s=base(3),game=structuredClone(s.game);
  game.players[0].bankrupt=true;
  assert.throws(()=>captureFinalCertification(s,game),/non prouve/);
});
test('finale terminee sans vainqueur valide : aucun classement certifie',()=>{
  const s=base(2),game=structuredClone(s.game);game.phase='over';game.winner=-1;
  assert.throws(()=>captureFinalCertification(s,game),/sans classement entier/);
});
test('historique deja absent : pas de paiement retroactif non prouve',()=>{
  const s=base(2);delete s.eliminationOrder;
  assert.throws(()=>captureFinalCertification(s,s.game),/manquant/);
});
test('faux ordre certifie refuse si historique ne correspond pas',()=>{
  const s=base(3);s.game.phase='over';s.game.winner=2;s.game.players[0].bankrupt=true;s.game.players[1].bankrupt=true;s.eliminationOrder=[100,101];
  s.certification={kind:'server-elimination-order-v1',source:'authoritative-game-events',order:[102,100,101]};
  assert.throws(()=>certifiedFinalOrder(s),/non coherent/);
});
