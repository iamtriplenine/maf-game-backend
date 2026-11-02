// Tirage impartial, pur et testable : seuls les inscrits confirmes participent.
// Le dernier inscrit est exclu et rembourse si l'effectif est impair.
import { randomInt } from 'node:crypto';
import { penaltyBracketPlan } from './penaltyTournamentPlan.js';

export function buildPenaltyDraw(tournament, entries, getRandom = randomInt) {
  if (!Array.isArray(entries)) throw new Error('Inscriptions invalides.');
  const capacity = Number(tournament.capacity), fee = Number(tournament.entry_fee);
  const plan = penaltyBracketPlan(capacity, fee, entries.length);
  if (!plan.ready) throw new Error('Inscrits insuffisants pour un duel.');
  if (entries.some(e => !Number.isSafeInteger(Number(e.user_id)) || Number(e.user_id) < 1 ||
      Number(e.fee_paid) !== fee)) throw new Error('Inscriptions ou mises incoherentes.');
  if (new Set(entries.map(e => Number(e.user_id))).size !== entries.length)
    throw new Error('Une inscription existe plusieurs fois.');
  const refunded = plan.refunded ? entries[entries.length - 1] : null;
  const shuffled = entries.slice(0, plan.players).map(e => ({userId:Number(e.user_id), name:String(e.pseudo)}));
  for (let i=shuffled.length-1; i>0; i--) {
    const j=getRandom(i+1);
    if (!Number.isInteger(j) || j<0 || j>i) throw new Error('Tirage aleatoire invalide.');
    [shuffled[i], shuffled[j]]=[shuffled[j],shuffled[i]];
  }
  const pairs=[];
  for(let i=0;i<shuffled.length;i+=2)
    pairs.push({matchNo:pairs.length+1,host:shuffled[i],guest:shuffled[i+1]});
  return {plan, refundedUserId:refunded?Number(refunded.user_id):null, pairs};
}

export function penaltyDuelReference(tournamentId, roundNo, matchNo, rowId) {
  if(!Number.isSafeInteger(Number(tournamentId))||Number(tournamentId)<1||
     !Number.isSafeInteger(Number(roundNo))||Number(roundNo)<1||
     !Number.isSafeInteger(Number(matchNo))||Number(matchNo)<1||
     !/^\d+$/.test(String(rowId))||BigInt(String(rowId))<1n) throw new Error('Reference de duel invalide.');
  return `MAF-T${String(tournamentId).padStart(6,'0')}-P${roundNo}-D${String(matchNo).padStart(2,'0')}-M${String(rowId).padStart(6,'0')}`;
}
