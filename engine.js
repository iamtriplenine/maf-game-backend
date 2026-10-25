// MAF_MONOPOLY_V1_ENGINE : regles du Monopoly (portage du GameManager.cs d'origine).
// Fonctions pures : chaque action renvoie un NOUVEL etat (JSON simple), sans reseau ni serveur.
import {
  SQUARES, GROUPS, RAILROADS, UTILITIES, CHANCE_CARDS, CHEST_CARDS,
  START_BALANCE, GO_SALARY, JAIL_FEE, PIECES, PLAYER_COLORS,
} from './data.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const BUYABLE = ['prop', 'rail', 'util'];

function shuffled(list, rng) {
  const a = list.map((c) => c.id);
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const cardById = (id) => CHANCE_CARDS.find((c) => c.id === id) || CHEST_CARDS.find((c) => c.id === id);

export function createGame({ names, rng = Math.random, dice = 1 } = {}) {
  const list = (names && names.length ? names : ['Joueur 1', 'Joueur 2']).slice(0, 7);
  return {
    version: 1,
    dice: dice === 2 ? 2 : 1,
    players: list.map((name, i) => ({
      id: i, name, piece: i % PIECES.length, color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      balance: START_BALANCE, location: 0, bankrupt: false,
    })),
    owners: Array(40).fill(null),
    houses: Array(40).fill(0),
    builtThisTurn: [],
    purchasedThisTurn: null, // une seule construction par propriete au cours du tour actuel
    decks: { chance: shuffled(CHANCE_CARDS, rng), chest: shuffled(CHEST_CARDS, rng) },
    current: 0,
    phase: 'roll', // roll | after | debt | over
    lastRoll: null, // { dice:[..], total }
    debt: null, // { amount, creditor (index|null), label }
    card: null, // { deck, text } derniere carte tiree
    winner: null, // index du gagnant, ou -1 si personne
    turn: 1,
    seq: 0,
    log: [],
    stats: { paid: 0, received: 0 },
  };
}

function say(s, player, text, kind = 'general') {
  s.seq += 1;
  s.log.unshift({ n: s.seq, player, text, kind });
  if (s.log.length > 80) s.log.length = 80;
}

// ----------------------------------------------------------------- lectures
export const squareAt = (i) => SQUARES[i];
export const ownedBy = (s, p) => SQUARES.filter((q) => s.owners[q.id] === p).map((q) => q.id);
export const groupOf = (i) => Object.values(GROUPS).find((g) => g.includes(i)) || null;
export const ownsGroup = (s, p, i) => { const g = groupOf(i); return !!g && g.every((x) => s.owners[x] === p); };

export function rentOf(s, i, roll = s.lastRoll?.total || 0) {
  const q = SQUARES[i];
  const owner = s.owners[i];
  if (owner === null || owner === undefined) return 0;
  if (q.type === 'prop') {
    const base = q.rent;
    switch (s.houses[i]) {
      case 0: return ownsGroup(s, owner, i) ? base * 2 : base;
      case 1: return base * 5;
      case 2: return base * 5 * 3;
      case 3: return base * 5 * 3 * 3;
      case 4: return base * 5 * 3 * 3 + 200;
      default: return base * 5 * 3 * 3 + 400;
    }
  }
  if (q.type === 'rail') {
    const n = RAILROADS.filter((r) => s.owners[r] === owner).length;
    return [0, 25, 50, 100, 200][n];
  }
  if (q.type === 'util') {
    const n = UTILITIES.filter((u) => s.owners[u] === owner).length;
    return (n === 2 ? 10 : 4) * roll;
  }
  return 0;
}

// Prix de revente : moitie du prix + moitie des maisons (comme l'original)
export function sellValue(s, i) {
  const q = SQUARES[i];
  if (!BUYABLE.includes(q.type)) return 0;
  let v = Math.floor(0.5 * q.price);
  if (q.type === 'prop') v += Math.floor(0.5 * q.house * s.houses[i]);
  return v;
}
export const liquidationValue = (s, p) => ownedBy(s, p).reduce((sum, i) => sum + sellValue(s, i), 0);

export function canBuy(s) {
  if (s.phase !== 'after') return false;
  const p = s.players[s.current];
  const q = SQUARES[p.location];
  return BUYABLE.includes(q.type) && s.owners[q.id] === null && p.balance >= q.price;
}

// Regles MAF : aucune collection de couleur exigee. Une construction par terrain et par tour,
// uniquement AVANT de lancer les des, sur les proprietes possedees (ni gares ni compagnies).
export function buildOptions(s, p = s.current) {
  if (p !== s.current || s.players[p]?.bankrupt) return [];
  // Avant le de : construction sur ses terrains. Apres l'achat : uniquement le
  // terrain tout juste achete, sans attendre le prochain tour.
  if (s.phase !== 'roll' && (s.phase !== 'after' || !Number.isInteger(s.purchasedThisTurn))) return [];
  const spent = s.builtThisTurn || []; // compatibilite avec les anciennes parties sauvegardees
  const balance = s.players[p].balance;
  return SQUARES.filter((q) => q.type === 'prop' && s.owners[q.id] === p
    && (s.phase === 'roll' || q.id === s.purchasedThisTurn)
    && s.houses[q.id] < 5 && !spent.includes(q.id) && q.house <= balance)
    .map((q) => ({ square: q.id, price: q.house }));
}
export const sellOptions = (s, p = s.current) => ownedBy(s, p).map((i) => ({ square: i, value: sellValue(s, i) }));

// ----------------------------------------------------------------- argent
function credit(s, p, amount) {
  s.players[p].balance += amount;
  s.stats.received += amount;
}

function declareBankrupt(s, p) {
  const me = s.players[p];
  me.bankrupt = true;
  me.balance = 0;
  for (let i = 0; i < 40; i += 1) {
    if (s.owners[i] === p) { s.owners[i] = null; s.houses[i] = 0; }
  }
  s.debt = null;
  say(s, p, 'a fait faillite !', 'bankrupt');
  const alive = s.players.filter((x) => !x.bankrupt);
  if (alive.length <= 1) {
    s.phase = 'over';
    s.winner = alive.length === 1 ? alive[0].id : -1;
    say(s, null, alive.length === 1 ? `${alive[0].name} remporte la partie !` : 'Partie terminée : aucun gagnant.', 'game-over');
    return;
  }
  nextPlayer(s);
}

// Fait payer un joueur. Si l'argent manque : il doit vendre (phase "debt"), sinon faillite.
function charge(s, p, amount, creditor, label) {
  if (amount <= 0) return true;
  const me = s.players[p];
  if (me.balance >= amount) {
    me.balance -= amount;
    s.stats.paid += amount;
    if (creditor !== null && creditor !== undefined) credit(s, creditor, amount);
    const kind = creditor !== null && creditor !== undefined
      ? 'rent-paid'
      : label === 'taxe'
        ? 'tax-paid'
        : label === 'prison'
          ? 'jail-fee'
          : label === 'carte'
            ? 'card-payment'
            : 'payment';
    say(s, p, creditor !== null && creditor !== undefined
      ? `a payé ${amount} $ de loyer à ${s.players[creditor].name}`
      : `a payé ${amount} $${label ? ` (${label})` : ''}`, kind);
    return true;
  }
  if (me.balance + liquidationValue(s, p) >= amount) {
    s.debt = { amount, creditor: creditor ?? null, label: label || '' };
    s.phase = 'debt';
    say(s, p, `doit ${amount} $ mais n'a que ${me.balance} $ : il faut vendre des propriétés`, 'debt-warning');
    return false;
  }
  say(s, p, `ne peut pas payer ${amount} $`, 'cannot-pay');
  declareBankrupt(s, p);
  return false;
}

// ----------------------------------------------------------------- deplacement
function landOn(s, roll) {
  const p = s.current;
  const me = s.players[p];
  const q = SQUARES[me.location];
  say(s, p, `est arrivé sur ${q.name}`, 'arrive');
  if (BUYABLE.includes(q.type)) {
    const owner = s.owners[q.id];
    if (owner !== null && owner !== p) charge(s, p, rentOf(s, q.id, roll), owner, 'loyer');
    return;
  }
  switch (q.type) {
    case 'go': credit(s, p, GO_SALARY); say(s, p, `a reçu ${GO_SALARY} $ (case GO)`, 'go-reward'); break;
    case 'tax': charge(s, p, q.tax, null, 'taxe'); break;
    case 'gojail':
      me.location = 10;
      say(s, p, 'est envoyé en prison', 'go-to-jail');
      charge(s, p, JAIL_FEE, null, 'prison');
      break;
    case 'chance':
    case 'chest': drawCard(s, q.type === 'chance' ? 'chance' : 'chest', roll); break;
    default: break; // prison (simple visite) et parc gratuit : rien
  }
}

function drawCard(s, deckName, roll) {
  const p = s.current;
  const me = s.players[p];
  const deck = s.decks[deckName];
  const id = deck.shift();
  deck.push(id); // la carte retourne en bas du paquet
  const card = cardById(id);
  s.card = { deck: deckName, text: card.text, id };
  say(s, p, `a tiré une carte ${deckName === 'chance' ? 'Chance' : 'Caisse de communauté'} : ${card.text}`, deckName === 'chance' ? 'chance-card' : 'chest-card');
  if (card.amount > 0) { credit(s, p, card.amount); say(s, p, `a reçu ${card.amount} $`, 'card-credit'); }
  if (card.moveTo !== null) {
    me.location = card.moveTo; // pas de prime GO en passant, comme l'original (seulement en arrivant sur GO)
    landOn(s, roll);
    if (card.amount < 0 && s.phase !== 'over') charge(s, p, -card.amount, null, 'carte');
    return;
  }
  if (card.amount < 0) charge(s, p, -card.amount, null, 'carte');
}

export function rollDice(state, { rng = Math.random, forced = null } = {}) {
  if (state.phase !== 'roll') return state;
  const s = clone(state);
  const count = s.dice;
  const values = Array.from({ length: count }, (_, i) => {
    const f = forced && forced[i];
    return Number.isInteger(f) && f >= 1 && f <= 6 ? f : 1 + Math.floor(rng() * 6);
  });
  const total = values.reduce((a, b) => a + b, 0);
  s.lastRoll = { dice: values, total };
  s.card = null;
  s.purchasedThisTurn = null;
  const p = s.current;
  const me = s.players[p];
  say(s, p, `a lancé ${count === 2 ? `${values.join(' + ')} = ` : ''}${total}`, 'roll');
  let loc = me.location + total;
  if (loc > 39) {
    loc -= 40;
    if (loc !== 0) { credit(s, p, GO_SALARY); say(s, p, `est passé par GO : +${GO_SALARY} $`, 'go-pass'); }
  }
  me.location = loc;
  s.phase = 'after';
  landOn(s, total);
  return s;
}

export function buy(state) {
  if (!canBuy(state)) return state;
  const s = clone(state);
  const p = s.current;
  const me = s.players[p];
  const q = SQUARES[me.location];
  me.balance -= q.price;
  s.stats.paid += q.price;
  s.owners[q.id] = p;
  s.purchasedThisTurn = q.type === 'prop' ? q.id : null;
  say(s, p, `a acheté ${q.name} (${q.price} $)`, 'purchase');
  return s;
}

export function build(state, square) {
  const opt = buildOptions(state).find((o) => o.square === square);
  if (!opt) return state;
  const s = clone(state);
  const me = s.players[s.current];
  me.balance -= opt.price;
  s.stats.paid += opt.price;
  s.houses[square] += 1;
  (s.builtThisTurn ||= []).push(square);
  say(s, s.current, s.houses[square] === 5
    ? `a construit un hôtel sur ${SQUARES[square].name}`
    : `a construit une maison sur ${SQUARES[square].name}`, s.houses[square] === 5 ? 'hotel-built' : 'house-built');
  return s;
}

export function sell(state, square) {
  if (state.phase === 'over' || state.owners[square] !== state.current) return state;
  const s = clone(state);
  const p = s.current;
  const value = sellValue(s, square);
  s.players[p].balance += value;
  s.stats.received += value;
  s.owners[square] = null;
  s.houses[square] = 0;
  say(s, p, `a vendu ${SQUARES[square].name} (+${value} $)`, 'sale');
  if (s.phase === 'debt' && s.debt) {
    const { amount, creditor, label } = s.debt;
    const me = s.players[p];
    if (me.balance >= amount) {
      s.debt = null;
      s.phase = 'after';
      charge(s, p, amount, creditor, label);
    } else if (me.balance + liquidationValue(s, p) < amount) {
      declareBankrupt(s, p);
    }
  }
  return s;
}

// Le joueur en dette peut aussi abandonner
export function giveUp(state) {
  if (state.phase === 'over') return state;
  const s = clone(state);
  declareBankrupt(s, s.current);
  return s;
}

function nextPlayer(s) {
  if (s.phase === 'over') return;
  const n = s.players.length;
  let i = s.current;
  for (let k = 0; k < n; k += 1) {
    i = (i + 1) % n;
    if (!s.players[i].bankrupt) break;
  }
  s.current = i;
  s.phase = 'roll';
  s.lastRoll = null;
  s.debt = null;
  s.builtThisTurn = [];
  s.purchasedThisTurn = null;
  s.turn += 1;
}

export function endTurn(state) {
  if (state.phase !== 'after') return state;
  const s = clone(state);
  nextPlayer(s);
  return s;
}

// ----------------------------------------------------------------- outils d'entrainement
// Donne ou retire de l'argent au joueur actif (pour tester les debits / la faillite)
export function setBalance(state, amount) {
  if (state.phase === 'over') return state;
  const s = clone(state);
  s.players[s.current].balance = Math.max(0, Math.floor(amount));
  say(s, s.current, `(test) solde fixé à ${s.players[s.current].balance} $`, 'debug');
  return s;
}
// Donne une propriete au joueur actif (pour tester loyers et constructions)
export function grantProperty(state, square) {
  if (state.phase === 'over' || !BUYABLE.includes(SQUARES[square]?.type)) return state;
  const s = clone(state);
  s.owners[square] = s.current;
  say(s, s.current, `(test) reçoit ${SQUARES[square].name}`, 'debug');
  return s;
}

// Joue automatiquement le tour du joueur actif (mode "Auto" de l'entrainement)
export function autoTurn(state, rng = Math.random) {
  let s = state;
  if (s.phase === 'roll') {
    const b = buildOptions(s)[0];
    if (b && s.players[s.current].balance > 400) s = build(s, b.square);
    s = rollDice(s, { rng });
  }
  if (s.phase === 'debt') {
    const opts = sellOptions(s).sort((a, b) => a.value - b.value);
    for (const o of opts) { if (s.phase !== 'debt') break; s = sell(s, o.square); }
    if (s.phase === 'debt') s = giveUp(s);
  }
  if (s.phase === 'after') {
    if (canBuy(s)) {
      s = buy(s);
      const newPlot = buildOptions(s)[0];
      if (newPlot && s.players[s.current].balance > 400) s = build(s, newPlot.square);
    }
    s = endTurn(s);
  }
  return s;
}
