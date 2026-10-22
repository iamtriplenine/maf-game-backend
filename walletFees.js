// Arrondi au franc superieur : pas de fraction de F CFA ou de V.
export function feeFor(amount) {
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 1_000_000) {
    throw new RangeError('Montant de transaction invalide.');
  }
  return Math.ceil(amount / 100);
}
export const totalFor = amount => amount + feeFor(amount);
