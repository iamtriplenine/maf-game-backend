import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOwnerGift,validateGiftLot,MAX_GIFT_LOTS,summarizeOwnerGift} from './ownerGiftRules.js';
const base={title:'Coffre multi-lots',message:'Bravo !',targetMode:'clientId',targetValue:'12345'};
const money={kind:'balance',amount:100};
const bonus={kind:'bonus',amount:25};
const coupon={kind:'coupon',amount:80,currency:'V'};
test('deux lots : argent + bonus dans un coffre',()=>{
 const gift=validateOwnerGift({...base,lots:[money,bonus]});
 assert.equal(gift.kind,'bundle');assert.deepEqual(gift.payload.lots,[money,bonus]);
});
test('cinq lots maximum et rejection des coffres vides',()=>{
 assert.equal(validateOwnerGift({...base,lots:Array.from({length:MAX_GIFT_LOTS},()=>money)}).payload.lots.length,5);
 assert.throws(()=>validateOwnerGift({...base,lots:[money]}),/2 à 5/);
 assert.throws(()=>validateOwnerGift({...base,lots:Array.from({length:6},()=>money)}),/2 à 5/);
});
test('validation independante de chaque lot et des coupons',()=>{
 assert.deepEqual(validateGiftLot(coupon),coupon);
 assert.throws(()=>validateOwnerGift({...base,lots:[money,{kind:'balance',amount:-1}]}),/Montant/);
 assert.throws(()=>validateOwnerGift({...base,lots:[money,{kind:'coupon',amount:10,currency:'X'}]}),/Coupon/);
 assert.throws(()=>validateOwnerGift({...base,lots:[money,{kind:'bundle'}]}),/Type de lot/);
});
test('un seul lot historique reste compatible',()=>{
 const gift=validateOwnerGift({...base,...money});
 assert.equal(gift.kind,'balance');assert.equal(gift.payload.amount,100);
});
test('liste un coffre scelle sans divulguer les images source',()=>{
 const row={id:4,title:'Coffre',kind:'bundle',payload:{lots:[money,{kind:'image',imageData:'donnees_secretes'}]},recipient_count:4,opened_count:0};
 const g=summarizeOwnerGift(row);
 assert.equal(g.lotCount,2);assert.equal(g.lots[1].kind,'image');assert.ok(!JSON.stringify(g).includes('donnees_secretes'));
});
