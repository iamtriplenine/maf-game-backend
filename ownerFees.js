// Le total facture correspond exactement a 19% arrondis au franc superieur.
// Le service garde son 1% precedent, le reste revient au proprietaire.
import { feeFor } from './walletFees.js';
export function withdrawalFees(amount) {
  const fee_amount = feeFor(amount);
  const combined = Math.ceil(amount * 19 / 100);
  const owner_fee_amount = combined - fee_amount;
  return { fee_amount,owner_fee_amount,total_amount:amount + combined };
}
