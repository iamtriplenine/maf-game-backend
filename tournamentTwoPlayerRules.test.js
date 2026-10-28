import test from 'node:test';
import assert from 'node:assert/strict';
import {
 DUEL_CAPACITY,DUEL_STAKE_CENTS,DUEL_PRIZES_CENTS,
 validateDuelSchedule,assertDuelParticipants,duelBudgetPreview,duelReadiness,
} from './tournamentTwoPlayerRules.js';
const starts='2030-10-31T19:00:00Z', gifts='2030-10-31T21:00:00Z';
test('programmation du duel independante des reservations',()=>{
 const s=validateDuelSchedule({startsAt:starts,giftsAt:gifts,now:Date.parse('2029-10-31T19:00:00Z')});
 assert.equal(s.capacity,2);assert.equal(s.gameCount,1);assert.equal(s.qualifications,0);
 assert.equal(s.startsAt,s.finalAt);assert.equal(s.giftsAt,gifts);
});
test('cadeaux avant depart et programmation passee refuses',()=>{
 assert.throws(()=>validateDuelSchedule({startsAt:starts,giftsAt:'2030-10-31T18:59:00Z',now:0}));
 assert.throws(()=>validateDuelSchedule({startsAt:starts, giftsAt:gifts, now:Date.parse(starts)}));
});
test('deux comptes reellement distincts obligatoires',()=>{
 assert.deepEqual(assertDuelParticipants([999,123]),[999,123]);
 for(const v of [[999,999],[999],[],[0,999],[999,1.5]]) assert.throws(()=>assertDuelParticipants(v));
});
test('900 F pour le premier et 100 F pour le deuxieme sans bonus additionnel',()=>{
 const d=duelBudgetPreview({userIds:[999,123],winnerId:999});
 assert.equal(DUEL_CAPACITY,2);assert.equal(DUEL_STAKE_CENTS,50000);
 assert.deepEqual(DUEL_PRIZES_CENTS,[90000,10000]);
 assert.equal(d.stakesCents,100000);assert.equal(d.payoutCents,100000);assert.equal(d.remainingCents,0);
 assert.equal(d.lines[0].realCents,90000);assert.equal(d.lines[1].realCents,10000);
 assert.equal(d.lines[0].bonusCents+d.lines[1].bonusCents,0);
 assert.equal(d.paymentsEnabled,false);assert.equal(d.skinsAttributed,false);
});
test('classement inverse lorsque le second utilisateur remporte la partie',()=>{
 const d=duelBudgetPreview({userIds:[999,123],winnerId:123});
 assert.equal(d.lines[0].userId,123);assert.equal(d.lines[1].userId,999);
});
test('gagnant exterieur, joueurs en doublon ou absents refuses',()=>{
 assert.throws(()=>duelBudgetPreview({userIds:[999,123],winnerId:100}));
 assert.throws(()=>duelBudgetPreview({userIds:[999,999],winnerId:999}));
});
test('depart seulement a deux reserves et a l heure programmee',()=>{
 assert.equal(duelReadiness({confirmedUserIds:[999,123],startsAt:starts,now:Date.parse(starts)}).canStart,true);
 assert.equal(duelReadiness({confirmedUserIds:[999],startsAt:starts,now:Date.parse(starts)}).status,'cancel_and_refund');
 assert.equal(duelReadiness({confirmedUserIds:[999,123],startsAt:starts,now:Date.parse(starts)-1}).status,'scheduled');
 assert.equal(duelReadiness({confirmedUserIds:[999,123],startsAt:starts,now:Date.parse(starts),settled:true}).canStart,false);
});
