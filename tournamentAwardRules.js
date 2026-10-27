// MAF Monopoly / etape 8 : calcul des recompenses EN CENTIMES, sans effet de bord.
// Aucun versement reel tant que le classement et le support des fractions de franc
// ne sont pas valides dans tout le portefeuille MAF.
export const TOTAL_PLAYERS = 20;
export const FINALISTS = 4;
export const STAKE_CENTS = 50000;
export const BONUS_CENTS = 10000;
export const ELIMINATED_CENTS = 6250;
export const PRIZES_CENTS = Object.freeze([200000, 160000, 150000, 140000]);
export const EXPECTED_REAL_CENTS = 750000;
export const EXPECTED_BONUS_CENTS = 200000;
export const EXPECTED_REMAINING_CENTS = 50000;

function playerId(value) {
  const n = typeof value === 'object' && value !== null ? value.userId : value;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Identifiant de joueur invalide.');
  return n;
}
function uniqueIds(ids, length, label) {
  if (!Array.isArray(ids) || ids.length !== length) throw new Error(`${label} : ${length} joueurs requis.`);
  const result = ids.map(playerId);
  if (new Set(result).size !== length) throw new Error(`${label} : doublons interdits.`);
  return result;
}
export function francText(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Montant en centimes invalide.');
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

// finalOrder = classement certifie : rangs 1,2,3,4 (pas l'ordre d'arrivee des qualifiés).
// Cette fonction ne doit pas accepter le classement propose par un navigateur.
export function buildTournamentAwardPlan(participants, finalOrder) {
  const all = uniqueIds(participants, TOTAL_PLAYERS, 'Inscrits');
  const rank = uniqueIds(finalOrder, FINALISTS, 'Classement finale');
  const eligible = new Set(all);
  if (rank.some(id => !eligible.has(id))) throw new Error('Finaliste non inscrit au tournoi.');
  const rankById = new Map(rank.map((id, index) => [id, index + 1]));
  const lines = all.map(userId => {
    const place = rankById.get(userId) || null;
    return {
      userId, place,
      outcome: place ? 'finalist' : 'eliminated',
      realCents: place ? PRIZES_CENTS[place - 1] : ELIMINATED_CENTS,
      bonusCents: BONUS_CENTS,
    };
  });
  const totalRealCents = lines.reduce((sum, l) => sum + l.realCents, 0);
  const totalBonusCents = lines.reduce((sum, l) => sum + l.bonusCents, 0);
  const stakesCents = TOTAL_PLAYERS * STAKE_CENTS;
  const remainingCents = stakesCents - totalRealCents - totalBonusCents;
  if (totalRealCents !== EXPECTED_REAL_CENTS ||
      totalBonusCents !== EXPECTED_BONUS_CENTS ||
      remainingCents !== EXPECTED_REMAINING_CENTS) {
    throw new Error('Budget du tournoi incoherent.');
  }
  return { lines, totalRealCents, totalBonusCents, stakesCents, remainingCents };
}

// Le moteur existant sait reconnaitre un gagnant, MAIS PAS l'ordre 2/3/4.
// Pour ne pas inventer un classement, tout versement attend une preuve
// enregistree et certifiee cote serveur (non produite par l'etape 7).
export function certifiedFinalOrder(state) {
  const seats = state?.seats;
  const game = state?.game;
  const certification = state?.certification;
  if (state?.format !== 'monopoly_final_4' || !Array.isArray(seats) || seats.length !== 4 ||
      game?.phase !== 'over' || !Number.isInteger(game.winner) || game.winner < 0 || game.winner > 3) {
    throw new Error('La finale ne dispose pas encore de resultat valide.');
  }
  if (certification?.kind !== 'server-elimination-order-v1' ||
      certification?.source !== 'authoritative-game-events' ||
      !Array.isArray(certification.order) || certification.order.length !== 4) {
    throw new Error('Classement des places 2 a 4 non certifie : paiement bloque.');
  }
  const order = uniqueIds(certification.order, FINALISTS, 'Classement certifie');
  const allowed = new Set(uniqueIds(seats.map(x => x.userId), FINALISTS, 'Sieges finale'));
  if (order.some(id => !allowed.has(id)) || order[0] !== seats[game.winner].userId) {
    throw new Error('Le classement certifie ne correspond pas au vainqueur du moteur.');
  }
  return order;
}
