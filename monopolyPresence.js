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
  // MAF_MONOPOLY_ELIM_V1 : celui qui est parti en PREMIER est elimine en premier.
  // Plus d'annulation ni de remboursement parce que l'adversaire est lui aussi silencieux.
  if (game.phase === 'over') return { game, changed: false };
  game.presence ||= { seen: {}, away: {} };
  let changed = false;
  for (let index = 0; index < members.length; index += 1) {
    if (game.players[index]?.bankrupt) continue;
    const key = String(members[index].id);
    if (game.presence.away[key] !== undefined) continue;
    const seen = Number(game.presence.seen[key] ?? now);
    if (now - seen >= HEARTBEAT_GRACE_MS) {
      game.presence.away[key] = seen + HEARTBEAT_GRACE_MS;
      log(game, index, 'est absent : 2 minutes pour revenir.', 'player-away');
      changed = true;
    }
  }
  const expired = members
    .map((member, index) => ({ index, key: String(member.id) }))
    .filter(({ index, key }) => !game.players[index]?.bankrupt
      && game.presence.away[key] !== undefined && now - game.presence.away[key] >= RECONNECT_MS)
    .sort((a, b) => game.presence.away[a.key] - game.presence.away[b.key] || a.index - b.index);
  for (const { index, key } of expired) {
    if (game.phase === 'over') break;
    if (game.players[index].bankrupt) continue;
    if (index === game.current) {
      game = giveUp(game); // renvoie une copie : on travaille ensuite uniquement sur game.presence
      log(game, index, 'a été éliminé après 2 minutes d’absence.', 'bankrupt');
    } else {
      game.players[index].bankrupt = true;
      game.players[index].balance = 0;
      for (let sq = 0; sq < 40; sq += 1) {
        if (game.owners[sq] === index) { game.owners[sq] = null; game.houses[sq] = 0; }
      }
      log(game, index, 'a été éliminé après 2 minutes d’absence.', 'bankrupt');
      const living = game.players.filter(p => !p.bankrupt);
      if (living.length === 1) {
        game.phase = 'over'; game.winner = living[0].id;
        log(game, null, `${living[0].name} remporte la partie !`, 'game-over');
      }
    }
    delete game.presence.away[key];
    changed = true;
  }
  return { game, changed };
}
