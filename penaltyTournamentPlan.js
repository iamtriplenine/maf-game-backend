// Planification par nombre d'inscrits ; aucune opération financière ici.
// Le dernier inscrit est remboursé si l'effectif initial est impair.
// Après la première phase, un exempt avance sans élimination arbitraire.
export function penaltyBracketPlan(capacity, entryFee, registered) {
  if (![8, 16, 32].includes(capacity) || ![200, 500].includes(entryFee)) throw new Error('Paramètres de compétition invalides.');
  if (!Number.isInteger(registered) || registered < 0 || registered > capacity) throw new Error('Effectif invalide.');
  const refunded = registered < 2 ? registered : registered % 2;
  const players = registered - refunded;
  const rounds = [];
  let alive = players;
  while (alive > 1) {
    const matches = Math.floor(alive / 2);
    const byes = alive % 2;
    rounds.push({ round: rounds.length + 1, players: alive, matches, byes, qualified: matches + byes });
    alive = matches + byes;
  }
  return {
    capacity, entryFee, registered, refunded, players, placesAvailable: capacity - registered,
    gross: registered * entryFee, refundsAmount: refunded * entryFee, pot: players * entryFee,
    initialMatches: rounds[0]?.matches || 0,
    totalMatches: rounds.reduce((sum, round) => sum + round.matches, 0), rounds,
    ready: players >= 2,
  };
}
