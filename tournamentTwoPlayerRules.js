// Regles pures du format special a deux joueurs. Aucun mouvement d'argent.
// IMPORTANT : ce module n'est pas branche aux routes publiques / au portefeuille.
export const DUEL_PLAYERS = 2;
export const DUEL_ENTRY_CENTS = 50_000; // 500 F CFA

const amount = (v, label) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${label} doit etre un montant positif en centimes entiers.`);
  return v;
};
const date = (v, label) => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v))
    throw new Error(`${label} doit etre une date UTC ISO complete.`);
  const d = Date.parse(v);
  if (!Number.isFinite(d) || new Date(d).toISOString().slice(0,19) !== v.slice(0,19))
    throw new Error(`${label} invalide.`);
  return d;
};

// Une partie unique, deja finale; deux comptes distincts, sans joueurs fictifs.
export function validateDuelSchedule({userIds, startsAt, giftsAt, now = Date.now()}) {
  if (!Array.isArray(userIds) || userIds.length !== 2 ||
      userIds.some(id => !Number.isSafeInteger(id) || id < 1) || userIds[0] === userIds[1])
    throw new Error('Le duel exige exactement deux comptes reels differents.');
  const startsMs = date(startsAt, 'Heure de la partie');
  const giftsMs = date(giftsAt, 'Heure des cadeaux');
  if (startsMs <= now) throw new Error('Le depart doit etre programme dans le futur.');
  if (giftsMs < startsMs) throw new Error('La remise des cadeaux ne peut pas preceder la partie.');
  return {format: 'duel', players: 2, boards: [{number:1,seats:2}], finalSeats:2,
    qualificationRound:false, startsAt, finalAt:startsAt, giftsAt};
}

// Budget de CONTROLE UNIQUEMENT. Aucun solde, bonus ou cadeau n'est credite.
// Le sens de « benefice » et du « cadeau 1 100 F » doit etre confirme par le proprietaire.
export function duelFinancingPreview({
  feeCents = DUEL_ENTRY_CENTS,
  firstProfitCents = 10_000,
  secondProfitCents = 10_000,
  giftCents = 110_000,
  alsoReturnEntryFees = false,
  sponsorCents = 0,
  reserveCents = 0,
} = {}) {
  feeCents=amount(feeCents,'Mise');
  firstProfitCents=amount(firstProfitCents,'Benefice du premier');
  secondProfitCents=amount(secondProfitCents,'Benefice du deuxieme');
  giftCents=amount(giftCents,'Cadeau');
  sponsorCents=amount(sponsorCents,'Financement externe');
  reserveCents=amount(reserveCents,'Reserve organisateur');
  const receiptsCents = 2 * feeCents;
  const obligationCents = firstProfitCents + secondProfitCents + giftCents +
    (alsoReturnEntryFees ? receiptsCents : 0) + reserveCents;
  const availableCents = receiptsCents + sponsorCents;
  const shortfallCents = Math.max(0, obligationCents - availableCents);
  return {
    receiptsCents, obligationCents, availableCents, shortfallCents,
    financed: shortfallCents === 0,
    status: shortfallCents ? 'BLOCKED_INSUFFICIENT_FUNDING' : 'BUDGET_SUFFICIENT_NOT_AUTHORIZED_TO_PAY',
  };
}
