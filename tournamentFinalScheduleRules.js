// Etape 7. Horaire parametre par tournoi ; heures conservees en UTC (Abidjan = UTC+0).
// Aucune ecriture ni lancement dans ce module pur.
export const FINAL_DELAY_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;
function timestamp(value) {
  const n = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isSafeInteger(n) || !Number.isFinite(n)) throw new Error('Horaire de finale invalide.');
  return n;
}
export function nextFinalSlot(finalAt, now, intervalMs = FINAL_DELAY_MS) {
  const start = timestamp(finalAt), current = timestamp(now);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MINUTE || intervalMs > 60 * MINUTE)
    throw new Error('Intervalle de report invalide.');
  if (current <= start) return start;
  // Une plage deja depassee ne peut pas demarrer retroactivement.
  return start + Math.ceil((current - start) / intervalMs) * intervalMs;
}
export function finalePreview({ finalAt, now, qualifiedCount, qualificationsComplete, started = false, expectedFinalists = 4 }) {
  const start = timestamp(finalAt), current = timestamp(now);
  if (!Number.isInteger(expectedFinalists) || expectedFinalists < 2 || expectedFinalists > 4 ||
      !Number.isInteger(qualifiedCount) || qualifiedCount < 0 || qualifiedCount > expectedFinalists)
    throw new Error('Nombre de finalistes invalide.');
  if (typeof qualificationsComplete !== 'boolean' || typeof started !== 'boolean')
    throw new Error('Etat de qualification invalide.');
  if (started) return {status:'started',plannedAt:new Date(start).toISOString(),nextAt:null,delayMinutes:0,ready:true};
  const ready = qualifiedCount === expectedFinalists && qualificationsComplete;
  const at = current <= start ? start : nextFinalSlot(start, current);
  // Au passage d'un horaire, si les qualifications sont encore inachevees,
  // on passe a la prochaine plage de cinq minutes.
  const next = current >= at && !ready ? at + FINAL_DELAY_MS : at;
  return {
    status: current < start ? 'scheduled' : ready && current === at ? 'ready' : 'waiting',
    plannedAt:new Date(start).toISOString(),nextAt:new Date(next).toISOString(),
    delayMinutes:(next-start)/MINUTE,ready,
  };
}
export function createFinaleMatch(finalists, makeGame) {
  if (!Array.isArray(finalists) || finalists.length < 2 || finalists.length > 4) throw new Error('De deux a quatre finalistes obligatoires.');
  const ordered=[...finalists].sort((a,b)=>a.table-b.table);
  if(ordered.some((x,i)=>x.table!==i+1||!Number.isSafeInteger(x.userId)||x.userId<1||
      typeof x.name!=='string'||!x.name.trim()||x.name.length>80)||
      new Set(ordered.map(x=>x.userId)).size!==ordered.length) throw new Error('Finalistes invalides ou dupliques.');
  const seats=ordered.map(({userId,name,table},seat)=>({seat,table,userId,name:name.trim()}));
  const game=makeGame({names:seats.map(s=>s.name),dice:2});
  if (!game || !Array.isArray(game.players) || game.players.length!==ordered.length)
    throw new Error('Moteur finale a quatre joueurs invalide.');
  return {format:`monopoly_final_${ordered.length}`,seats,game};
}
