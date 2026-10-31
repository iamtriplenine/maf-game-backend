// Argent F : 19 % au total. Bonus V : 1 % de service, sans commission proprietaire.
import { feeFor } from './walletFees.js';
export function withdrawalFees(amount, currency = 'F') {
  const fee_amount = feeFor(amount);
  if (!['F','V'].includes(currency)) throw new RangeError('Devise de retrait invalide.');
  const combined = currency === 'V' ? fee_amount : Math.ceil(amount * 19 / 100);
  const owner_fee_amount = combined - fee_amount;
  return { fee_amount,owner_fee_amount,total_amount:amount + combined };
}
