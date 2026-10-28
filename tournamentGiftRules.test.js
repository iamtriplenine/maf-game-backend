import test from 'node:test';
import assert from 'node:assert/strict';
import { rewardAvailability, validateReleaseAt, ownerDemoGift } from './tournamentGiftRules.js';
const future = '2035-10-30T21:00:00.000Z';
test('un invité ou un joueur non inscrit ne reçoit aucun coffre', () =>
  assert.equal(rewardAvailability({participantReserved:false,releaseAt:future,now:0,batchCredited:true,awardCredited:true}),'not_eligible'));
test('sans programmation aucun cadeau disponible', () =>
  assert.equal(rewardAvailability({participantReserved:true,releaseAt:null,now:0,batchCredited:true,awardCredited:true}),'not_scheduled'));
test('avant l heure, le coffre reste verrouille', () =>
  assert.equal(rewardAvailability({participantReserved:true,releaseAt:future,now:0,batchCredited:true,awardCredited:true}),'waiting'));
test('apres l heure sans credits certifies, aucun retrait possible', () =>
  assert.equal(rewardAvailability({participantReserved:true,releaseAt:future,now:Date.parse(future)+1,batchCredited:false,awardCredited:false}),'awaiting_credits'));
test('credits confirmes et heure arrivee: ouverture autorisee', () =>
  assert.equal(rewardAvailability({participantReserved:true,releaseAt:future,now:Date.parse(future)+1,batchCredited:true,awardCredited:true}),'ready'));
test('apres ouverture le coffre reste ouvert', () =>
  assert.equal(rewardAvailability({participantReserved:true,releaseAt:future,now:Date.parse(future)+1,batchCredited:true,awardCredited:true,openedAt:'2035-10-31T00:00:00Z'}),'opened'));
test('l heure de remise ne peut pas preceder la finale', () =>
  assert.throws(()=>validateReleaseAt('2035-10-30T19:00:00Z','2035-10-30T20:05:00Z',0)));
test('une vraie heure future apres finale est acceptee', () =>
  assert.equal(validateReleaseAt('2035-10-30T21:00:00Z','2035-10-30T20:05:00Z',0),'2035-10-30T21:00:00.000Z'));
test('simulation de dix: champion 1900 F et 100 F bonus', () => {
  const d=ownerDemoGift(10);assert.equal(d.champion.realCents,190000);
  assert.equal(d.champion.bonusCents,10000);assert.equal(d.finalists,2);
});
test('simulation 18: budget organisateur 600 F', () => {
  const d=ownerDemoGift(18);assert.equal(d.organizerCents,60000);
});
test('effectif invalide refuse', () => assert.throws(()=>ownerDemoGift(9)));
