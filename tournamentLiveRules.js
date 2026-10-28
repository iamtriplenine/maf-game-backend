// Horloges autoritaires des qualifications, reutilisees par le serveur, pas par le navigateur.
import { initPresence, expirePresence } from './monopolyPresence.js';
import { normalizeTurnClock } from './monopolyTurnClock.js';
export const LOBBY_WAIT_MS = 5 * 60_000;
export const MATCH_RECONNECT_MS = 2 * 60_000;
export const GIFT_DELAY_MS = 5 * 60_000;
export const lobbyDeadline = scheduledAt => new Date(scheduledAt).getTime() + LOBBY_WAIT_MS;
export function lobbyOutcome(seats, joined, scheduledAt, now=Date.now()) {
  const ids=seats.map(p=>Number(p.userId));
  const arrived=ids.filter(id=>joined.includes(id));
  if (arrived.length===ids.length) return 'play';
  if (now<lobbyDeadline(scheduledAt)) return 'wait';
  return arrived.length ? 'forfeit' : 'attention';
}
export function launchWithAbsences(match, arrivedIds, now=Date.now()) {
  let game=structuredClone(match.game);
  const members=match.seats.map(s=>({id:s.userId}));
  initPresence(game,members.map(s=>s.id),now);
  // Absents au depart : forfait a l'expiration des cinq minutes, sans nouveau delai de deux minutes.
  // Le meme moteur Monopoly elimine aussi les joueurs qui ne sont pas en train de jouer.
  for(const seat of match.seats){
    if(!arrivedIds.includes(seat.userId)) game.presence.away[String(seat.userId)] = now - MATCH_RECONNECT_MS - 1;
  }
  game=expirePresence(game,members,now).game;
  normalizeTurnClock(game,now);
  return {...match,game};
}
export function postponedGiftAt(releaseAt, now, active) {
  const scheduled=new Date(releaseAt).getTime();
  if(!Number.isFinite(scheduled)||!Number.isFinite(now))throw new Error('Horloge des cadeaux invalide.');
  if(!active || now<scheduled)return new Date(scheduled).toISOString();
  return new Date(scheduled+(Math.floor((now-scheduled)/GIFT_DELAY_MS)+1)*GIFT_DELAY_MS).toISOString();
}
