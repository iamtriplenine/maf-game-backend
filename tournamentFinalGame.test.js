import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFinaleMatch} from './tournamentFinalScheduleRules.js';
import {finalMember,finalAction} from './tournamentFinalGame.js';
import {createGame} from './engine.js';
import {privateMatchView} from './tournamentPrivateView.js';
for(const count of [2,3,4]){
 test(`finale privee et jouable a ${count} joueurs`,()=>{
  const members=Array.from({length:count},(_,i)=>({userId:100+i,name:`Joueur${i}`,table:i+1}));
  const match=createFinaleMatch(members,createGame);
  assert.equal(finalMember(match,100),0);
  assert.equal(finalMember(match,999),-1);
  const player=privateMatchView(match,100);
  assert.equal(player.seats.filter(s=>s.isYou).length,1);
  assert.equal(player.seats[0].clientId,100);
  assert.ok(player.seats.slice(1).every(s=>s.clientId<0));
  assert.equal(player.game.decks,undefined);
  const next=finalAction(match,{userId:100,action:'roll'},()=>0.1);
  assert.notDeepEqual(next.game,match.game);
  assert.throws(()=>finalAction(match,{userId:999,action:'roll'}),/absent/);
  assert.throws(()=>finalAction(match,{userId:100,action:'bonus'}),/interdite/);
  assert.throws(()=>finalAction(match,{userId:101,action:'roll'}),/tour/);
 });
}
test('presence anonymisee et acces interdit a un non participant',()=>{
 const state=createFinaleMatch([1,2].map(n=>({userId:100+n,name:`Joueur${n}`,table:n})),createGame);
 state.game.presence={seen:{'101':123,'102':456},away:{'102':500}};
 const mine=privateMatchView(state,101);
 assert.deepEqual(mine.game.presence.away,{'-2':500});
 assert.deepEqual(mine.game.presence.seen,{'101':123,'-2':456});
 assert.throws(()=>privateMatchView(state,42),/autorise/);
});
