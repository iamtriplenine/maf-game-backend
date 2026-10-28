import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDuelSchedule,duelFinancingPreview} from './tournamentTwoPlayerRules.js';
const start='2030-10-31T19:00:00Z', gifts='2030-10-31T20:45:00Z';
test('deux joueurs distincts et partie unique directement en finale',()=>{
 const p=validateDuelSchedule({userIds:[999,123],startsAt:start,giftsAt:gifts,now:Date.parse('2029-01-01T00:00:00Z')});
 assert.equal(p.boards.length,1);assert.equal(p.finalSeats,2);assert.equal(p.qualificationRound,false);
 assert.equal(p.finalAt,p.startsAt);
});
test('compte duplique et heures invalides refuses',()=>{
 assert.throws(()=>validateDuelSchedule({userIds:[999,999],startsAt:start,giftsAt:gifts,now:0}));
 assert.throws(()=>validateDuelSchedule({userIds:[999,123],startsAt:start,giftsAt:'2030-10-31T18:00:00Z',now:0}));
});
test('montants annonces avec cadeau 1100 + 100 par joueur = deficit',()=>{
 const p=duelFinancingPreview();
 assert.equal(p.receiptsCents,100_000);assert.equal(p.obligationCents,130_000);
 assert.equal(p.shortfallCents,30_000);assert.equal(p.financed,false);
});
test('si benefice signifie net et mises rendues, deficit encore plus grand',()=>{
 const p=duelFinancingPreview({alsoReturnEntryFees:true});
 assert.equal(p.shortfallCents,130_000);
});
test('un financement supplementaire est obligatoire et n autorise pas a payer',()=>{
 const p=duelFinancingPreview({sponsorCents:30_000});
 assert.equal(p.financed,true);assert.equal(p.status,'BUDGET_SUFFICIENT_NOT_AUTHORIZED_TO_PAY');
});
test('pas de montants negatifs ou flottants',()=>{
 assert.throws(()=>duelFinancingPreview({firstProfitCents:-1}));
 assert.throws(()=>duelFinancingPreview({giftCents:10.5}));
});
