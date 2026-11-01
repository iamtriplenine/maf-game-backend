// Shared business rules for penalty-tournament seat reservation and refunds.
// This module has no database dependency and can be verified independently.
export function paidTournamentEntryFee(tournament) {
  if (!tournament || !['monopoly', 'penalty'].includes(tournament.game))
    throw new Error('Jeu de tournoi invalide.');
  const fee = Number(tournament.entry_fee);
  if (tournament.game === 'monopoly' && fee !== 500)
    throw new Error('Mise Monopoly incoherente.');
  if (tournament.game === 'penalty' && ![200, 500].includes(fee))
    throw new Error('Mise Tir-au-but incoherente.');
  return fee;
}

export function refundablePaidAmount(tournament, entry) {
  const expected = paidTournamentEntryFee(tournament);
  const paid = Number(entry.fee_paid);
  if (paid !== expected) throw new Error('Mise enregistree differente du montant du tournoi.');
  return paid;
}
