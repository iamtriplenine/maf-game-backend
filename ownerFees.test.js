import test from 'node:test';
import assert from 'node:assert/strict';
import { withdrawalFees } from './ownerFees.js';
for(const [amount,service,commission,total] of [[100,1,18,119],[101,2,18,121],[150,2,27,179],[500,5,90,595],[1000,10,180,1190],[1000000,10000,180000,1190000]]) {
  test(`Retrait ${amount}: service ${service} proprietaire ${commission} total ${total}`, () => {
    assert.deepEqual(withdrawalFees(amount),{fee_amount:service,owner_fee_amount:commission,total_amount:total});
  });
}
test('Montants rejetes',()=>{for(const amount of [0,99,-1,NaN,100.2,1000001]) assert.throws(()=>withdrawalFees(amount));});
