// Moteur de tir au but : aucun acces DB, aucun solde, fonctions testables.
export const roleFor = (turn, player) =>
  (turn % 2 === 0 ? player === 'host' : player === 'guest') ? 'shooter' : 'keeper';

export const blankMatch = (shots) => ({
  turn: 0, totalPerPlayer: shots, regularPerPlayer: shots, overtime: 0,
  scores: { host: 0, guest: 0 }, history: [],
  pending: { shooter: null, keeper: null }, winner: null, finished: false,
});

// A appeler SOUS verrou transactionnel. Le resultat n'est revele qu'apres deux choix.
export function recordChoice(state, viewer, direction) {
  if (state.finished) throw new Error('Match termine.');
  const role = roleFor(state.turn, viewer);
  if (state.pending[role] !== null) throw new Error('Choix deja enregistre.');
  state.pending[role] = direction;
  if (!state.pending.shooter || !state.pending.keeper) return state;

  const shooter = state.turn % 2 === 0 ? 'host' : 'guest';
  const goal = state.pending.shooter !== state.pending.keeper;
  if (goal) state.scores[shooter] += 1;
  state.history.push({ number: state.turn + 1, shooter, goal,
    shot: state.pending.shooter, save: state.pending.keeper,
    scores: { ...state.scores },
  });
  state.turn += 1;
  state.pending = { shooter: null, keeper: null };
  if (state.turn === state.totalPerPlayer * 2) {
    if (state.scores.host !== state.scores.guest) {
      state.winner = state.scores.host > state.scores.guest ? 'host' : 'guest';
      state.finished = true;
    } else {
      state.overtime += 1;
      state.totalPerPlayer += 3;
    }
  }
  return state;
}
