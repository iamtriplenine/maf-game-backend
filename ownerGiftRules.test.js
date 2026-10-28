import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOwnerGift,OWNER_GIFT_KINDS,OWNER_BACKGROUND_IDS,summarizeOwnerGift } from './ownerGiftRules.js';
const base={title:'Bravo !',targetMode:'clientId',targetValue:'12345',message:'Bonne chance'};
for(const kind of OWNER_GIFT_KINDS){
 test(`cadeau ${kind} accepté avec paramètres valides`,()=>{
  const options=kind==='coupon'?{amount:200,currency:'F'}:kind==='skin'?{skinId:'taunt-mixamo'}:kind==='background'?{backgroundId:'matrix-rain'}:kind==='image'?{imageData:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAA='}:{amount:125};
  assert.equal(validateOwnerGift({...base,kind,...options}).kind,kind);
 });
}
test('montants négatifs ou décimaux rejetés',()=>{
 for(const amount of [-4,0,1.2,1e10])assert.throws(()=>validateOwnerGift({...base,kind:'balance',amount}));
});
test('un skin public ne devient pas cadeau exclusif',()=>{
 assert.throws(()=>validateOwnerGift({...base,kind:'skin',skinId:'loki'}));
});
test('cible globale acceptée',()=>assert.equal(validateOwnerGift({...base,kind:'bonus',amount:20,targetMode:'all'}).targetValue,''));
test('cible ID client incorrect rejetée',()=>assert.throws(()=>validateOwnerGift({...base,kind:'bonus',amount:20,targetValue:'99'})));
test('images SVG refusées',()=>assert.throws(()=>validateOwnerGift({...base,kind:'image',imageData:'data:image/svg+xml;base64,PHN2Zz4='})));
test('arrière-plan non catalogué refusé',()=>assert.throws(()=>validateOwnerGift({...base,kind:'background',backgroundId:'intrus'})));
test('résumé ne révèle pas de coupon destinataire',()=>{
 const v=summarizeOwnerGift({id:5,kind:'coupon',title:'A',payload:{amount:50,currency:'F'},recipient_count:3,opened_count:1});
 assert.equal(v.recipientCount,3);assert.equal(v.code,undefined);
});
