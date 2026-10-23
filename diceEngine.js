// MAF_DICE_ENGINE_V1 — Lancers controles par le serveur ; aucun resultat anticipe au client.
import crypto from 'node:crypto';

export const DICE_ROUNDS = [1, 3, 5, 10];
export const DICE_MODES = ['separate', 'cumulative'];

export function validateDiceSettings(diceCount, rounds, mode) {
  if (diceCount !== 1 && diceCount !== 2) throw new Error('Choisis un ou deux des.');
  if (!DICE_ROUNDS.includes(rounds)) throw new Error('Choisis 1, 3, 5 ou 10 coups.');
  if (!DICE_MODES.includes(mode)) throw new Error('Mode de resultat invalide.');
  if (rounds === 1 && mode !== 'separate') throw new Error('Avec un seul lancer, utilise le mode separe.');
}

export function initialDice(diceCount, rounds, mode) {
  validateDiceSettings(diceCount, rounds, mode);
  return {
    diceCount, rounds, mode, pending: { host: null, guest: null },
    history: [], wins: { host: 0, guest: 0, draw: 0 },
    totals: { host: 0, guest: 0 },
    winner: null, draw: false, finished: false, forfeit: null,
  };
}

// Chaque joueur lance une fois par manche ; impossible de relancer ou de choisir ses valeurs.
// Les nombres sont generees avec le generateur cryptographique du serveur.
export function rollDice(state, side, randomInt = crypto.randomInt) {
  if (!['host', 'guest'].includes(side)) throw new Error('Joueur invalide.');
  if (!state || state.finished) throw new Error('La partie est terminee.');
  if (state.history.length >= state.rounds) throw new Error('Tous les coups ont ete joues.');
  if (state.pending[side] !== null) throw new Error('Tu as deja lance pour ce coup.');

  const dice = Array.from({ length: state.diceCount }, () => randomInt(1, 7));
  if (dice.some((value) => !Number.isInteger(value) || value < 1 || value > 6))
    throw new Error('Lancer invalide.');
  const total = dice.reduce((sum, value) => sum + value, 0);
  state.pending[side] = { dice, total };
  if (!state.pending.host || !state.pending.guest) return state;

  const host = state.pending.host;
  const guest = state.pending.guest;
  const winner = host.total === guest.total ? null : host.total > guest.total ? 'host' : 'guest';
  state.history.push({ round: state.history.length + 1, host, guest, winner });
  state.totals.host += host.total;
  state.totals.guest += guest.total;
  state.wins[winner || 'draw'] += 1;
  state.pending = { host: null, guest: null };

  if (state.history.length === state.rounds) {
    state.finished = true;
    const hostScore = state.mode === 'cumulative' ? state.totals.host : state.wins.host;
    const guestScore = state.mode === 'cumulative' ? state.totals.guest : state.wins.guest;
    state.winner = hostScore === guestScore ? null : hostScore > guestScore ? 'host' : 'guest';
    state.draw = state.winner === null;
  }
  return state;
}

// Jamais retourner les valeurs du lancer courant tant que l'adversaire n'a pas lance.
export function diceView(state, viewer) {
  if (!['host', 'guest'].includes(viewer)) throw new Error('Joueur invalide.');
  if (!state) return null;
  const rival = viewer === 'host' ? 'guest' : 'host';
  return {
    diceCount: state.diceCount, rounds: state.rounds, mode: state.mode,
    round: Math.min(state.rounds, state.history.length + 1),
    history: state.history, wins: state.wins, totals: state.totals,
    myRolled: state.pending[viewer] !== null,
    opponentRolled: state.pending[rival] !== null,
    finished: state.finished, winner: state.winner,
    draw: state.draw, forfeit: state.forfeit || null,
    viewer,
  };
}
