import {describeBudgetScenario,francText} from './tournamentDynamicBudget.js';
console.log('MAF - Budgets fictifs, aucun versement ni remboursement');
console.log('Inscrits | Jouent | Rembourses | Finale | Recompenses reelles | Bonus | Reste | Statut');
for(let n=0;n<=20;n++){
  const p=describeBudgetScenario(n);
  console.log([n,p.eligibleCount,p.refundIds.length,p.groupSizes.length,
    francText(p.totalRealCents),francText(p.totalBonusCents),
    francText(p.remainingCents),p.status].join(' | '));
}
