// Montants du portefeuille MAF en francs entiers (integer PostgreSQL).
// Le calculateur reste la seule source des prix en centimes. Le reste inferieur
// a un franc est distribue par plus grands restes, avec departage par userId.
import { calculateTournamentBudget } from './tournamentDynamicBudget.js';

const sum = a => a.reduce((n, x) => n + x, 0);
function inFranc(lines, key) {
  const sorted = [...lines].map((line, index) => ({
    index, userId: line.userId, cents: line[key],
    units: Math.floor(line[key] / 100), remainder: line[key] % 100,
  }));
  if(sorted.some(x => !Number.isSafeInteger(x.cents) || x.cents < 0))
    throw new Error('Montant fractionnaire invalide.');
  const target = Math.floor(sum(sorted.map(x => x.cents)) / 100);
  const extras = target - sum(sorted.map(x => x.units));
  sorted.sort((a,b) => b.remainder - a.remainder || a.userId - b.userId);
  for(let i = 0; i < extras; i++) sorted[i].units += 1;
  return sorted.sort((a,b) => a.index - b.index).map(x => x.units);
}
export function payoutPlan(orderedActiveIds, certifiedOrder) {
  const p = calculateTournamentBudget(orderedActiveIds, certifiedOrder);
  if(p.status !== 'planned' || p.refundIds.length || p.eligibleCount !== orderedActiveIds.length)
    throw new Error('Inscriptions remboursees, incompletes ou budget non payable.');
  const real = inFranc(p.lines, 'realCents');
  const bonus = inFranc(p.lines, 'bonusCents');
  const lines = p.lines.map((line,i) => ({...line,realFranc:real[i],bonusFranc:bonus[i]}));
  const totalRealFranc = sum(real), totalBonusFranc = sum(bonus);
  const organizerFranc = p.potCents / 100 - totalRealFranc - totalBonusFranc;
  if(!Number.isSafeInteger(organizerFranc) || organizerFranc < 500 ||
      totalRealFranc + totalBonusFranc + organizerFranc !== p.eligibleCount * 500)
    throw new Error('Comptabilite des francs entiers invalide.');
  return {...p,lines,totalRealFranc,totalBonusFranc,organizerFranc};
}
