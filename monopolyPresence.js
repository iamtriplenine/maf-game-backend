// Controle serveur de presence : 2 minutes pour revenir a la partie.
import { giveUp } from './engine.js';
export const RECONNECT_MS = 120_000;
export const HEARTBEAT_GRACE_MS = 20_000;
function log(game, index, text, kind) {
  game.seq += 1;
  game.log.unshift({ n: game.seq, player: index, text, kind });
  if (game.log.length > 80) game.log.length = 80;
}
export function initPresence(game, ids, now = Date.now()) {
  game.presence = { seen: Object.fromEntries(ids.map(id => [String(id), now])), away: {} };
  return game;
}
export function setPresence(game, members, userId, state, now = Date.now()) {
  const index = members.findIndex(m => Number(m.id) === Number(userId));
  if (index < 0 || !['here', 'away'].includes(state)) return false;
  const p = game.players[index];
  if (!p || p.bankrupt || game.phase === 'over') return false;
  game.presence ||= { seen: {}, away: {} };
  const key = String(userId);
  if (state === 'here') {
    game.presence.seen[key] = now;
    if (game.presence.away[key] !== undefined) {
      delete game.presence.away[key];
      log(game, index, 'est revenu dans la partie.', 'player-return');
    }
  } else if (game.presence.away[key] === undefined) {
    game.presence.away[key] = now;
    log(game, index, 'a quitté le plateau : 2 minutes pour revenir.', 'player-away');
  }
  return true;
}
export function expirePresence(game, members, now = Date.now()) {
  if (game.phase === 'over') return { game, changed: false };
  const presence = game.presence ||= { seen: {}, away: {} };
  let changed = false;
  for (let index = 0; index < members.length; index += 1) {
    if (game.phase === 'over') break;
    const member = members[index];
    if (game.players[index]?.bankrupt) continue;
    const key = String(member.id);
    if (presence.away[key] === undefined) {
      const seen = Number(presence.seen[key] ?? now);
      if (now - seen >= HEARTBEAT_GRACE_MS) {
        presence.away[key] = seen + HEARTBEAT_GRACE_MS;
        log(game, index, 'est absent : 2 minutes pour revenir.', 'player-away');
        changed = true;
      }
    }
    if (presence.away[key] === undefined || now - presence.away[key] < RECONNECT_MS) continue;
    if (index === game.current) {
      game = giveUp(game);
    } else {
      game.players[index].bankrupt = true;
      game.players[index].balance = 0;
      for (let sq = 0; sq < 40; sq += 1) {
        if (game.owners[sq] === index) { game.owners[sq] = null; game.houses[sq] = 0; }
      }
      log(game, index, 'a été éliminé après 2 minutes d’absence.', 'bankrupt');
      const living = game.players.filter(p => !p.bankrupt);
      if (living.length === 1) { game.phase = 'over'; game.winner = living[0].id; }
    }
    game.presence ||= presence;
    delete game.presence.away[key];
    // Aucun paiement a un gagnant lui-meme absent : annuler la partie
    // et laisser le reglement serveur rembourser toutes les mises.
    if (game.phase === 'over' && game.winner >= 0) {
      const remaining=members[game.winner];
      if (remaining && presence.away[String(remaining.id)] !== undefined) {
        game.winner = -1;
        log(game, null, 'Partie annulee : aucun joueur encore present.', 'game-over');
      }
    }
    changed = true;
  }
  return { game, changed };
}
