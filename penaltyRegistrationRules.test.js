import test from 'node:test';
import assert from 'node:assert/strict';
import { paidTournamentEntryFee, refundablePaidAmount } from './penaltyRegistrationRules.js';

test('mises valides par jeu', () => {
  for (const fee of [200, 500]) {
    assert.equal(paidTournamentEntryFee({game:'penalty',entry_fee:fee}),fee);
    assert.equal(refundablePaidAmount({game:'penalty',entry_fee:fee},{fee_paid:fee}),fee);
  }
  assert.equal(paidTournamentEntryFee({game:'monopoly',entry_fee:500}),500);
});
test('mises falsifiees ou incoherentes refusees', () => {
  for (const bad of [0,199,201,501,1000,NaN]) {
    assert.throws(()=>paidTournamentEntryFee({game:'penalty',entry_fee:bad}));
  }
  assert.throws(()=>paidTournamentEntryFee({game:'monopoly',entry_fee:200}));
  assert.throws(()=>refundablePaidAmount({game:'penalty',entry_fee:200},{fee_paid:500}));
  assert.throws(()=>refundablePaidAmount({game:'monopoly',entry_fee:500},{fee_paid:0}));
});
