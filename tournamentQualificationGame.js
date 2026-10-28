// Etape 4. Moteur isole pour un plateau de qualification Monopoly a cinq joueurs.
// Aucun endpoint, aucune reservation ni operation sur le portefeuille n'est active ici.
import { createGame, rollDice, buy, build, sell, endTurn, giveUp } from './engine.js';

export const QUALIFICATION_PLAYERS = 5; // nombre maximum par plateau
const validSize = count => count === 4 || count === 5;
const validMatch = match => validSize(match?.seats?.length) &&
  match.format === `monopoly_qualification_${match.seats.length}` &&
  match.game?.players?.length === match.seats.length;
const ACTIONS = new Set(['roll', 'buy', 'build', 'sell', 'end', 'abandon']);

export function createQualificationGame(participants, rng = Math.random) {
  if (!Array.isArray(participants) || !validSize(participants.length)) {
    throw new Error('Une qualification Monopoly exige quatre ou cinq joueurs.');
  }
  const seats = participants.map((person, seat) => ({
    userId: person?.userId,
    name: person?.name,
    seat,
  }));
  if (seats.some(p => !Number.isSafeInteger(p.userId) || p.userId <= 0 ||
      typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) ||
      new Set(seats.map(p => p.userId)).size !== seats.length) {
    throw new Error('Les participants doivent etre distincts, identifiables et valides.');
  }
  return {
    format: `monopoly_qualification_${seats.length}`,
    seats,
    game: createGame({ names: seats.map(p => p.name.trim()), dice: 2, rng }),
  };
}

export function qualificationWinnerId(match) {
  if (!validMatch(match))
    throw new Error('Qualification invalide.');
  if (match.game?.phase !== 'over' || !Number.isInteger(match.game.winner) || match.game.winner < 0) return null;
  return match.seats[match.game.winner]?.userId ?? null;
}

// Fonction pure. La future route serveur devra verrouiller la partie et conserver
// un numero de version afin de rejeter deux actions concurrentes (etape 5).
export function playQualificationAction(match, { userId, action, square } = {}, rng = Math.random) {
  if (!validMatch(match))
    throw new Error('Qualification invalide.');
  if (!ACTIONS.has(action)) throw new Error('Action non autorisee.');
  if (match.game.phase === 'over') throw new Error('La qualification est terminee.');
  const seat = match.seats.findIndex(p => p.userId === userId);
  if (seat < 0) throw new Error('Ce joueur ne participe pas a la qualification.');
  if (seat !== match.game.current) throw new Error("Ce n'est pas le tour de ce joueur.");
  if (match.game.players[seat].bankrupt) throw new Error('Ce joueur est elimine.');
  // Le client ne peut jamais choisir les faces des des ; seul rng vient du serveur.
  let game = match.game;
  if (action === 'roll') game = rollDice(game, { rng });
  else if (action === 'buy') game = buy(game);
  else if (action === 'build') game = build(game, square);
  else if (action === 'sell') game = sell(game, square);
  else if (action === 'end') game = endTurn(game);
  else if (action === 'abandon') game = giveUp(game);
  if (game === match.game) throw new Error('Action interdite dans cette phase.');
  return { ...match, game };
}
