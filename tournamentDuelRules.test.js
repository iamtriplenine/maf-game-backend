import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDuel,duelRewards,duelStartDecision,DUEL_STAKE} from './tournamentDuelRules.js';
const players=[{user_id:999},{user_id:42}];
test('deux mises, 900 et 100 sans bonus',()=>{
 assert.equal(DUEL_STAKE,500);
 assert.deepEqual(duelRewards(players,42),[{userId:42,place:1,amount:900},{userId:999,place:2,amount:100}]);
 assert.equal(duelRewards(players,999).reduce((n,v)=>n+v.amount,0),1000);
});
test('un compte non inscrit ne peut gagner',()=>assert.throws(()=>duelRewards(players,18)));
test('les doublons sont refuses',()=>assert.throws(()=>duelRewards([{user_id:1},{user_id:1}],1)));
test('date cadeau superieure a date depart',()=>{
 const s=new Date(Date.now()+120000).toISOString(),g=new Date(Date.now()+3600000).toISOString();
 assert.equal(validateDuel({startsAt:s,giftsAt:g}).startsAt,s);
 assert.throws(()=>validateDuel({startsAt:g,giftsAt:s}));
});
test('2 joueurs au depart = lancement, 1 = remboursement',()=>{
 const t=new Date(Date.now()-10000).toISOString();
 assert.equal(duelStartDecision({startsAt:t,count:2}),'start');
 assert.equal(duelStartDecision({startsAt:t,count:1}),'refund');
});
