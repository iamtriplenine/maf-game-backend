// Tarifs d'information affiches au public : derives du MEME calcul
// que les credits reels, sans lecture de comptes et sans ecriture SQL.
// Ne pas exposer d'ID, d'ordre de tirage ou de classement personnel.
import { payoutPlan } from './tournamentPayoutRules.js';
import { tournamentSeats } from './tournamentDynamicBudget.js';

export const TOURNAMENT_FORMATS = Object.freeze([10, 14, 15, 18, 19, 20]);

export function rewardScenario(eligibleCount) {
  if (!TOURNAMENT_FORMATS.includes(eligibleCount)) throw new Error('Effectif non eligible.');
  // Identifiants fictifs utilises pour simuler les arrondis de francs entiers.
  const ids = Array.from({length:eligibleCount}, (_,i)=>i+1);
  const groupSizes = tournamentSeats(ids).groupSizes;
  const finalists = ids.slice(0,groupSizes.length);
  const plan = payoutPlan(ids,finalists);
  const byPlace = new Map(plan.lines.filter(l=>l.place!==null).map(l=>[l.place,l]));
  const eliminated = plan.lines.filter(l=>l.place===null);
  return {
    players:eligibleCount,groupSizes,finalists:finalists.map((_,i)=>({
      place:i+1,realFranc:byPlace.get(i+1).realFranc,bonusFranc:byPlace.get(i+1).bonusFranc,
    })),
    eliminatedCount:eliminated.length,
    eliminatedMinFranc:Math.min(...eliminated.map(l=>l.realFranc)),
    eliminatedMaxFranc:Math.max(...eliminated.map(l=>l.realFranc)),
    eliminatedBonusFranc:100,
    organizerFranc:plan.organizerFranc,
    totalRealFranc:plan.totalRealFranc,
    totalBonusFranc:plan.totalBonusFranc,
  };
}

export const PUBLIC_REWARD_SCENARIOS = Object.freeze(TOURNAMENT_FORMATS.map(rewardScenario));
