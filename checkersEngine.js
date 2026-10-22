// Moteur de dames 10x10 (dames internationales) : aucun acces DB, aucun solde, fonctions testables.
// Le meme fichier sera copie dans le front (partie 3) pour l'entrainement contre le robot.
//
// Plateau : 100 cases, index = ligne * 10 + colonne (ligne 0 = haut). Cases jouables : (ligne + colonne) impair.
// Pieces : 'w' pion blanc, 'W' dame blanche, 'b' pion noir, 'B' dame noire, '.' case vide.
// 'host' (createur) = blancs, en bas, joue en premier. 'guest' = noirs, en haut.
export const SIZE = 10;
export const NO_PROGRESS_PLIES = 50; // 25 coups chacun avec seulement des dames, sans prise : partie nulle
export const MOVE_LIMIT_MS = 120_000; // temps maximum par coup (applique par le serveur, partie 2)

export const idx = (r, c) => r * SIZE + c;
const rc = (i) => [Math.floor(i / SIZE), i % SIZE];
const inside = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
export const other = (side) => (side === 'host' ? 'guest' : 'host');
const colorOf = (piece) => (piece === '.' ? null : piece.toLowerCase() === 'w' ? 'host' : 'guest');
const isKing = (piece) => piece !== '.' && piece === piece.toUpperCase();

export function blankCheckers() {
  const board = Array(SIZE * SIZE).fill('.');
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if ((r + c) % 2 !== 1) continue;
      if (r < 4) board[idx(r, c)] = 'b';
      if (r > 5) board[idx(r, c)] = 'w';
    }
  }
  return {
    game: 'checkers', board, toMove: 'host', ply: 0, history: [], noProgress: 0,
    drawOffer: null, lastMoveAt: null,
    winner: null, finished: false, draw: false, reason: null, forfeit: null,
  };
}

// Position personnalisee (tests) : pieces = { [index]: 'w' | 'W' | 'b' | 'B' }.
export function customState(pieces, toMove = 'host', extra = {}) {
  const state = blankCheckers();
  state.board = Array(SIZE * SIZE).fill('.');
  for (const [i, piece] of Object.entries(pieces)) state.board[Number(i)] = piece;
  state.toMove = toMove;
  return Object.assign(state, extra);
}

// Toutes les suites de prises possibles pour la piece placee en `from`.
// Les pieces prises restent sur le plateau jusqu'a la fin du coup (elles bloquent, on ne les saute pas 2 fois).
function captureSequences(board, from) {
  const piece = board[from];
  const side = colorOf(piece);
  const king = isKing(piece);
  const work = board.slice();
  work[from] = '.'; // la case de depart est libre pendant le coup
  const found = [];
  const walk = (pos, captured, path) => {
    let more = false;
    const [r0, c0] = rc(pos);
    for (const [dr, dc] of DIRS) {
      let r = r0 + dr;
      let c = c0 + dc;
      if (king) while (inside(r, c) && work[idx(r, c)] === '.') { r += dr; c += dc; }
      if (!inside(r, c)) continue;
      const enemy = idx(r, c);
      if (colorOf(work[enemy]) !== other(side) || captured.includes(enemy)) continue;
      let lr = r + dr;
      let lc = c + dc;
      while (inside(lr, lc) && work[idx(lr, lc)] === '.') {
        more = true;
        walk(idx(lr, lc), [...captured, enemy], [...path, idx(lr, lc)]);
        if (!king) break; // un pion atterrit juste derriere la piece prise
        lr += dr;
        lc += dc;
      }
    }
    if (!more && captured.length) found.push({ from, path, captured });
  };
  walk(from, [], []);
  return found;
}

// Coups legaux : la prise est obligatoire, et il faut prendre le maximum de pieces.
export function legalMoves(state, side = state.toMove) {
  if (state.finished) return [];
  const captures = [];
  for (let i = 0; i < state.board.length; i += 1) {
    if (colorOf(state.board[i]) === side) captures.push(...captureSequences(state.board, i));
  }
  if (captures.length) {
    const most = Math.max(...captures.map((m) => m.captured.length));
    return captures.filter((m) => m.captured.length === most);
  }
  const moves = [];
  for (let i = 0; i < state.board.length; i += 1) {
    const piece = state.board[i];
    if (colorOf(piece) !== side) continue;
    const [r0, c0] = rc(i);
    if (isKing(piece)) {
      for (const [dr, dc] of DIRS) {
        let r = r0 + dr;
        let c = c0 + dc;
        while (inside(r, c) && state.board[idx(r, c)] === '.') {
          moves.push({ from: i, path: [idx(r, c)], captured: [] });
          r += dr;
          c += dc;
        }
      }
    } else {
      const dr = side === 'host' ? -1 : 1;
      for (const dc of [-1, 1]) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (inside(r, c) && state.board[idx(r, c)] === '.') moves.push({ from: i, path: [idx(r, c)], captured: [] });
      }
    }
  }
  return moves;
}

const isSquare = (v) => Number.isInteger(v) && v >= 0 && v < SIZE * SIZE;
export function parseMove(req) {
  if (!req || !isSquare(req.from) || !Array.isArray(req.path) || req.path.length < 1
    || req.path.length > 40 || !req.path.every(isSquare)) throw new Error('Coup invalide.');
  return { from: req.from, path: req.path };
}
const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// A appeler SOUS verrou transactionnel. `req` = { from, path } (les cases d'arrivee, une par saut).
export function applyMove(state, side, req, now = Date.now()) {
  if (state.finished) throw new Error('Partie terminee.');
  if (side !== state.toMove) throw new Error("Ce n'est pas ton tour.");
  const wanted = parseMove(req);
  const move = legalMoves(state).find((m) => m.from === wanted.from && samePath(m.path, wanted.path));
  if (!move) throw new Error('Coup interdit.');

  const piece = state.board[move.from];
  const end = move.path.at(-1);
  state.board[move.from] = '.';
  for (const taken of move.captured) state.board[taken] = '.';
  const man = !isKing(piece);
  const row = Math.floor(end / SIZE);
  const promote = man && ((side === 'host' && row === 0) || (side === 'guest' && row === SIZE - 1));
  state.board[end] = promote ? piece.toUpperCase() : piece;

  state.ply += 1;
  state.history.push({ n: state.ply, side, from: move.from, path: move.path, captured: move.captured, promoted: promote });
  state.noProgress = !man && !move.captured.length ? state.noProgress + 1 : 0;
  state.toMove = other(side);
  state.drawOffer = null; // une proposition de nulle tombe des qu'un coup est joue
  state.lastMoveAt = now;

  if (legalMoves(state).length === 0) {
    state.finished = true;
    state.winner = side;
    state.reason = 'no_moves';
  } else if (state.noProgress >= NO_PROGRESS_PLIES) {
    state.finished = true;
    state.draw = true;
    state.reason = 'no_progress';
  }
  return state;
}

function agreeDraw(state) {
  state.finished = true;
  state.draw = true;
  state.winner = null;
  state.drawOffer = null;
  state.reason = 'agreement';
}

// Proposer nulle. Si l'adversaire avait deja propose, la partie est nulle tout de suite.
export function offerDraw(state, side) {
  if (state.finished) throw new Error('Partie terminee.');
  if (state.drawOffer === side) throw new Error('Proposition de nulle deja envoyee.');
  if (state.drawOffer === other(side)) agreeDraw(state);
  else state.drawOffer = side;
  return state;
}

export function respondDraw(state, side, accept) {
  if (state.finished) throw new Error('Partie terminee.');
  if (state.drawOffer !== other(side)) throw new Error('Aucune proposition de nulle a repondre.');
  if (accept) agreeDraw(state);
  else state.drawOffer = null;
  return state;
}

// Abandon, ou depart non revenu a temps, ou temps de coup depasse : l'autre joueur gagne.
export function forfeitCheckers(state, loser, reason = 'forfeit') {
  state.finished = true;
  state.draw = false;
  state.winner = other(loser);
  state.forfeit = loser;
  state.reason = reason;
  state.drawOffer = null;
  return state;
}

// Vue envoyee au joueur : partie a information complete, rien a cacher. Les coups legaux sont calcules par le serveur.
export function checkersView(state, viewer) {
  const myTurn = !state.finished && state.toMove === viewer;
  const counts = { host: 0, guest: 0 };
  for (const piece of state.board) if (piece !== '.') counts[colorOf(piece)] += 1;
  return {
    game: 'checkers', board: state.board, toMove: state.toMove, ply: state.ply,
    lastMove: state.history.at(-1) || null, counts, noProgress: state.noProgress,
    winner: state.winner, finished: state.finished, draw: state.draw, reason: state.reason,
    forfeit: state.forfeit || null, drawOffer: state.drawOffer, lastMoveAt: state.lastMoveAt,
    myTurn, legal: myTurn ? legalMoves(state).map(({ from, path }) => ({ from, path })) : [],
  };
}
