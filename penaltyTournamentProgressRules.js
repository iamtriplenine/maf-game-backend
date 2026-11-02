// Regles pures de progression du championnat (aucune ecriture de solde ici).
import { randomInt } from 'node:crypto';
const valid = n => Number.isSafeInteger(n) && n > 0;
export function buildNextPenaltyRound(ids, rand = randomInt) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 32 ||
      ids.some(x => !valid(x)) || new Set(ids).size !== ids.length)
    throw new Error('Qualifies invalides ou en double.');
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    if (!Number.isSafeInteger(j) || j < 0 || j > i) throw new Error('Tirage invalide.');
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const bye = shuffled.length % 2 ? shuffled.pop() : null;
  const pairs = [];
  for (let i = 0; i < shuffled.length; i += 2)
    pairs.push({matchNo:pairs.length+1,hostId:shuffled[i],guestId:shuffled[i+1]});
  return {bye, pairs, champion:ids.length===1?ids[0]:null};
}
export function penaltyAbsenceDecision(match, now = Date.now()) {
  if (!['scheduled','waiting','playing'].includes(match.status)) return null;
  const d = x => x ? new Date(x).getTime() : null;
  const scheduled=d(match.scheduled_at);
  if (!Number.isFinite(scheduled) || now < scheduled) return null;
  const host=d(match.host_seen_at), guest=d(match.guest_seen_at);
  const active=(seen)=>seen!==null && now-seen<=45000;
  const hostHere=active(host),guestHere=active(guest);
  if(match.status!=='playing') {
    if(now-scheduled<300000)return null; // 5 min pour rejoindre.
    const joined=(at,seen)=>d(at)!==null||d(seen)!==null; // a rejoint le salon au moins une fois
    const hostJoined=joined(match.host_joined_at,host),guestJoined=joined(match.guest_joined_at,guest);
    if(hostJoined!==guestJoined)return {winner:hostJoined?'host':'guest',reason:'absence_initiale'}; // un seul est venu : il gagne meme si son ecran s'est verrouille
    if(hostHere!==guestHere)return {winner:hostHere?'host':'guest',reason:'absence_initiale'};
    if(!hostJoined&&!guestJoined&&now-scheduled>=600000)return {winner:null,reason:'deux_absents'}; // 10 min si personne n'est venu
    if(!hostHere&&!guestHere&&now-scheduled>=600000)return {winner:null,reason:'jamais_ensemble'}; // venus chacun a leur tour sans se croiser : verification
    return null;
  }
  const idle=penaltyIdleDecision(match,now); // connecte mais ne joue pas : disqualifie
  if(idle)return idle;
  const started=d(match.playing_at)??scheduled;
  const hostRef=host??started,guestRef=guest??started;
  if(now-hostRef<120000 && now-guestRef<120000)return null;
  if(hostHere!==guestHere && now-(hostHere?guestRef:hostRef)>=120000)
    return {winner:hostHere?'host':'guest',reason:'reconnexion_expiree'};
  if(!hostHere&&!guestHere && now-hostRef>=600000 && now-guestRef>=600000)
    return {winner:null,reason:'deux_deconnectes'};
  return null;
}

export const PENALTY_IDLE_MS = 300000; // 5 minutes sans jouer = disqualification
export function penaltyIdleDecision(match, now = Date.now()) {
  if (match.status !== 'playing') return null;
  const s = match.match_state;
  if (!s || s.finished || !Number.isFinite(s.turnStartedAt)) return null;
  if (now - s.turnStartedAt < PENALTY_IDLE_MS) return null;
  const shooter = s.turn % 2 === 0 ? 'host' : 'guest';
  const keeper = shooter === 'host' ? 'guest' : 'host';
  const idle = [];
  if (s.pending.shooter === null) idle.push(shooter);
  if (s.pending.keeper === null) idle.push(keeper);
  if (idle.length === 2) return now - s.turnStartedAt >= 600000 ? {winner: null, reason: 'deux_inactifs'} : null; // 10 min : les deux disqualifies
  if (idle.length !== 1) return null;
  return {winner: idle[0] === 'host' ? 'guest' : 'host', reason: 'inactivite_tir'};
}