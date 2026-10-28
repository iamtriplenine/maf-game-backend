// Regles de disponibilite du coffre a recompenses.
// AUCUN credit, remboursement ou ajout de skin n'est effectue par ce module.
import { describeBudgetScenario } from './tournamentDynamicBudget.js';

export function rewardAvailability({ releaseAt, now, participantReserved, batchCredited, awardCredited, openedAt }) {
  if (!participantReserved) return 'not_eligible';
  if (!releaseAt) return 'not_scheduled';
  if (!Number.isFinite(Date.parse(releaseAt))) throw new Error('Date de remise invalide.');
  if (openedAt) return 'opened';
  if (now < Date.parse(releaseAt)) return 'waiting';
  if (!batchCredited || !awardCredited) return 'awaiting_credits';
  return 'ready';
}

export function validateReleaseAt(value, finalAt, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))
    throw new Error('Heure UTC au format ISO obligatoire.');
  const release = Date.parse(value);
  const finale = Date.parse(finalAt);
  if (!Number.isFinite(release) || !Number.isFinite(finale) || release < Math.max(now + 60_000, finale))
    throw new Error('La remise doit être future et ne pas précéder la finale.');
  return new Date(release).toISOString();
}

export function ownerDemoGift(players = 10) {
  if (![10, 14, 15, 18, 19, 20].includes(players))
    throw new Error('Simulation disponible uniquement pour les effectifs retenus.');
  const plan = describeBudgetScenario(players);
  if (plan.status !== 'planned') throw new Error('Budget de simulation indisponible.');
  const champion = plan.lines.find(x => x.place === 1);
  if (!champion) throw new Error('Champion fictif introuvable.');
  return {
    type: 'owner_demo', players, finalists: plan.finalCount,
    participantCount: plan.eligibleCount, organizerCents: plan.remainingCents,
    champion: { place: champion.place, realCents: champion.realCents,
      bonusCents: champion.bonusCents, gifts: ['participation','finalist'] },
    message: 'Simulation fictive. Le compte 999 ne reçoit aucun crédit ni skin.'
  };
}
