import test from 'node:test';
import assert from 'node:assert/strict';
import { feeFor, totalFor } from './walletFees.js';
for (const [amount,fee,total] of [[100,1,101],[101,2,103],[150,2,152],[200,2,202],[999,10,1009],[1000000,10000,1010000]]) {
  test(`1 % de ${amount} = ${fee}, total ${total}`, () => {
    assert.equal(feeFor(amount),fee);
    assert.equal(totalFor(amount),total);
  });
}
test('Refuser les montants hors limites', () => {
  for (const v of [0,99,1000001,100.5,-1,NaN]) assert.throws(() => feeFor(v),RangeError);
});
