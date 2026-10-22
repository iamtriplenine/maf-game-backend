// MARV GAME — Salons et tir au but.
// Mises REELLES : debitees quand le createur accepte l'adversaire, retenues sur le salon (escrow),
// versees au gagnant a la fin du match, ou remboursees si le salon est ferme avant la fin.
import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from './db.js';
import { ensureTable, readToken, requireSession } from './auth.js';
import { ensureWallet } from './wallet.js';
import { blankMatch, roleFor, recordChoice } from './penaltyEngine.js';
import {tankInitial,tankFire,tankForfeit,tankOfferDraw,tankRespondDraw,tankCancelDraw,tankView,TANK_TURN_MS} from './tankEngine.js';
// MAF_TANK_BACKEND_V1
import { blankCheckers, applyMove, offerDraw, respondDraw, cancelDraw, forfeitCheckers, checkersView, MOVE_LIMIT_MS } from './checkersEngine.js';

export const roomsRouter = Router();
const allowedShots = new Set([3, 5, 10]);
const RETURN_MS = 80_000;
const ROOM_LIFETIME = '24 hours';
const CODE_PATTERN = /^\d{4}$/;
const directions = new Set(['left', 'center', 'right']);
const checkersEmoteKinds = new Set(['laugh', 'smirk', 'clap']);
const activeStatuses = ['open', 'pending', 'ready', 'playing'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const respond = (fn) => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Salon deja cree. Reessaie.' });
    console.error('rooms:', error.message);
    next(error);
  }
};

let ready = null;
export function ensureRooms() {
  if (!ready) ready = (async () => {
    await ensureTable();
    await ensureWallet(); // table d'audit des operations d'argent
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(62498132)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS maf_rooms (
          id bigserial PRIMARY KEY,
          code char(4) NOT NULL CHECK(code ~ '^[0-9]{4}$'),
          host_id integer NOT NULL REFERENCES maf_users(id),
          guest_id integer REFERENCES maf_users(id),
          game text NOT NULL CHECK(game IN ('penalty', 'checkers', 'tank')),
          shots smallint CHECK(shots IN (3, 5, 10)),
          stake integer NOT NULL CHECK(stake BETWEEN 100 AND 1000000),
          status text NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'pending', 'ready', 'playing', 'finished', 'closed')),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          closed_at timestamptz,
          match_state jsonb,
          CHECK(guest_id IS NULL OR guest_id <> host_id),
          CHECK(status NOT IN ('pending','ready','playing','finished') OR guest_id IS NOT NULL),
          CHECK(status <> 'open' OR guest_id IS NULL)
        );
      `);
      // Mise a niveau automatique des tables creees a l'etape 1.
      await client.query(`
        ALTER TABLE maf_rooms ADD COLUMN IF NOT EXISTS match_state jsonb;
        ALTER TABLE maf_rooms ADD COLUMN IF NOT EXISTS departures jsonb NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE maf_rooms ADD COLUMN IF NOT EXISTS escrow integer NOT NULL DEFAULT 0;
        ALTER TABLE maf_rooms ADD COLUMN IF NOT EXISTS payout integer NOT NULL DEFAULT 0;
        ALTER TABLE maf_rooms ADD COLUMN IF NOT EXISTS settled_at timestamptz;
        ALTER TABLE maf_rooms ADD COLUMN IF NOT EXISTS funds_alert jsonb;
        ALTER TABLE maf_rooms DROP CONSTRAINT IF EXISTS maf_rooms_game_check;
        ALTER TABLE maf_rooms ADD CONSTRAINT maf_rooms_game_check
          CHECK(game IN ('penalty', 'checkers', 'tank'));
        ALTER TABLE maf_rooms ALTER COLUMN shots DROP NOT NULL;
        ALTER TABLE maf_rooms DROP CONSTRAINT IF EXISTS maf_rooms_shots_check;
        ALTER TABLE maf_rooms ADD CONSTRAINT maf_rooms_shots_check
          CHECK((game='penalty' AND shots IN (3,5,10)) OR (game IN ('checkers','tank') AND shots IS NULL));
        ALTER TABLE maf_rooms DROP CONSTRAINT IF EXISTS maf_rooms_status_check;
        ALTER TABLE maf_rooms ADD CONSTRAINT maf_rooms_status_check
          CHECK(status IN ('open', 'pending', 'ready', 'playing', 'finished', 'closed'));
        ALTER TABLE maf_rooms DROP CONSTRAINT IF EXISTS maf_rooms_guest_presence_check;
        ALTER TABLE maf_rooms ADD CONSTRAINT maf_rooms_guest_presence_check
          CHECK(status NOT IN ('pending','ready','playing','finished') OR guest_id IS NOT NULL);
        DROP INDEX IF EXISTS maf_rooms_unique_active_code;
        CREATE UNIQUE INDEX maf_rooms_unique_active_code ON maf_rooms(code)
          WHERE status IN ('open','pending','ready','playing');
        CREATE INDEX IF NOT EXISTS maf_rooms_public_recent
          ON maf_rooms(created_at DESC) WHERE status IN ('open','pending');
        CREATE INDEX IF NOT EXISTS maf_rooms_host_active
          ON maf_rooms(host_id) WHERE status <> 'closed';
        CREATE INDEX IF NOT EXISTS maf_rooms_guest_active
          ON maf_rooms(guest_id) WHERE status <> 'closed';
      `);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

// Fermer automatiquement les salons inactifs apres 24 heures.
// S'applique egalement aux salons qui attendaient le lancement du jeu.
async function expireRooms(db) {
  // Un salon expire avec des mises retenues : chaque joueur retrouve sa mise (un seul ordre SQL, atomique).
  await db.query(`
    WITH due AS (
      SELECT id, host_id, guest_id, stake, escrow FROM maf_rooms
      WHERE status IN ('open','pending','ready','playing') AND updated_at < now() - interval '${ROOM_LIFETIME}'
      FOR UPDATE
    ), closed AS (
      UPDATE maf_rooms r SET status='closed', closed_at=now(), updated_at=now(), escrow=0,
        settled_at = CASE WHEN d.escrow > 0 THEN now() ELSE r.settled_at END
      FROM due d WHERE r.id = d.id
      RETURNING d.id AS id, d.host_id AS host_id, d.guest_id AS guest_id, d.stake AS stake, d.escrow AS escrow
    ), logged AS (
      INSERT INTO maf_wallet_audit(actor, event, details)
      SELECT 'system:rooms', 'room_refund_expired', jsonb_build_object('room_id', id, 'amount_each', stake)
      FROM closed WHERE escrow > 0
      RETURNING id
    ), refunds AS (
      SELECT host_id AS uid, stake FROM closed WHERE escrow > 0
      UNION ALL
      SELECT guest_id AS uid, stake FROM closed WHERE escrow > 0 AND guest_id IS NOT NULL
    )
    UPDATE maf_users u SET balance = u.balance + s.total
    FROM (SELECT uid, sum(stake)::integer AS total FROM refunds GROUP BY uid) s
    WHERE u.id = s.uid`);
}

// ------------ ARGENT : verrous, retenue, paiement, remboursement ------------
const audit = (client, event, details) => client.query(
  'INSERT INTO maf_wallet_audit(actor,event,details) VALUES($1,$2,$3)',
  ['system:rooms', event, JSON.stringify(details)]);

// Toujours verrouiller les comptes dans l'ordre des identifiants (pas d'interblocage).
async function lockUsers(client, ids) {
  const sorted = [...new Set(ids.filter(Boolean))].sort((x, y) => x - y);
  const { rows } = await client.query(
    'SELECT id, balance FROM maf_users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [sorted]);
  return new Map(rows.map((row) => [row.id, row]));
}

// Match termine : la cagnotte (2 mises) va au gagnant.
async function settleRoom(client, room, winnerSide) {
  if (!(room.escrow > 0) || room.settled_at || !['host', 'guest'].includes(winnerSide)) return;
  const winnerId = winnerSide === 'host' ? room.host_id : room.guest_id;
  await lockUsers(client, [room.host_id, room.guest_id]);
  await client.query('UPDATE maf_users SET balance=balance+$2 WHERE id=$1', [winnerId, room.escrow]);
  await client.query('UPDATE maf_rooms SET escrow=0, payout=$2, settled_at=now() WHERE id=$1', [room.id, room.escrow]);
  await audit(client, 'room_payout', { room_id: Number(room.id), winner_id: winnerId, amount: room.escrow });
}

// Salon ferme avant la fin du match : chacun reprend sa mise.
async function refundRoom(client, room) {
  if (!(room.escrow > 0) || room.settled_at) return;
  const ids = [room.host_id, room.guest_id].filter(Boolean);
  await lockUsers(client, ids);
  await client.query('UPDATE maf_users SET balance=balance+$2 WHERE id = ANY($1::int[])', [ids, room.stake]);
  await client.query('UPDATE maf_rooms SET escrow=0, settled_at=now() WHERE id=$1', [room.id]);
  await audit(client, 'room_refund', { room_id: Number(room.id), amount_each: room.stake, users: ids });
}

const NO_FUNDS_SELF = "Tu n'as pas assez de fonds sur ton compte pour cette mise. Recharge ton compte.";
const NO_FUNDS_OTHER = "Ton adversaire n'a pas de fonds suffisants pour cette mise.";
const ALERT_TTL_MS = 3 * 60 * 1000;

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verrou global sur les transitions de salon : codes et places ne se chevauchent pas.
    await client.query('SELECT pg_advisory_xact_lock(62498133)');
    await resolveDepartures(client);
    await expireRooms(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Server-owned deadlines survive reloads and restarts. All transitions share the room lock.
async function resolveDepartures(client) {
  const { rows } = await client.query(`SELECT * FROM maf_rooms
    WHERE (status='playing' AND (departures <> '{}'::jsonb OR game IN ('checkers','tank')))
       OR (status='finished' AND escrow > 0 AND settled_at IS NULL)
    ORDER BY id FOR UPDATE`);
  for (const room of rows) {
    if (room.status === 'playing') {
      const due = Object.entries(room.departures || {})
        .filter(([key, deadline]) => ['host','guest'].includes(key) && Number.isFinite(deadline) && deadline <= Date.now())
        .map(([loser, deadline]) => ({ loser, deadline, reason: 'return_timeout' }));
      if (['checkers','tank'].includes(room.game) && room.match_state?.lastMoveAt != null) {
        const deadline = Number(room.match_state.lastMoveAt) + (room.game === 'tank' ? TANK_TURN_MS : MOVE_LIMIT_MS);
        if (Number.isFinite(deadline) && deadline <= Date.now())
          due.push({ loser: room.match_state.toMove, deadline, reason: 'move_timeout' });
      }
      due.sort((a,b) => a.deadline - b.deadline || a.loser.localeCompare(b.loser));
      if (!due.length || !room.match_state) continue;
      const { loser, reason } = due[0];
      const state = room.game === 'tank' ? tankForfeit(room.match_state, loser, reason)
        : room.game === 'checkers' ? forfeitCheckers(room.match_state, loser, reason)
        : { ...room.match_state, finished:true, winner:loser === 'host' ? 'guest' : 'host',
          forfeit:loser, forfeitReason:reason, pending:{shooter:null,keeper:null} };
      await client.query(`UPDATE maf_rooms SET status='finished', match_state=$2::jsonb,
        departures='{}'::jsonb, updated_at=now() WHERE id=$1`, [room.id, JSON.stringify(state)]);
      await settleRoom(client, room, state.winner);
    } else {
      // Recover a recorded result only when its money is still held and was never paid.
      if (room.match_state?.draw) await refundRoom(client, room);
      else await settleRoom(client, room, room.match_state?.winner);
    }
  }
}
export async function maintainRooms() {
  if (!pool) return;
  await ensureRooms();
  await transaction(async () => {});
}

// Liste des salons : uniquement des identites publiques et aucune donnee sensible.
const SELECT = `SELECT r.*, h.pseudo AS host_pseudo, g.pseudo AS guest_pseudo
  FROM maf_rooms r JOIN maf_users h ON h.id=r.host_id
  LEFT JOIN maf_users g ON g.id=r.guest_id`;
// Message de fonds insuffisants visible par les deux joueurs (pendant 3 minutes).
function fundsAlert(row, viewerId) {
  const alert = row.funds_alert;
  if (!alert || !viewerId || ![row.host_id, row.guest_id].includes(viewerId)) return null;
  if (!['open', 'pending'].includes(row.status)) return null;
  if (!(Date.now() - Date.parse(alert.at) < ALERT_TTL_MS)) return null;
  const mine = viewerId === row.host_id ? 'host' : 'guest';
  const theirs = mine === 'host' ? 'guest' : 'host';
  const self = !!alert[mine];
  const other = !!alert[theirs];
  return self || other ? { self, other } : null;
}
const shown = (row, viewerId = null) => ({
  id: Number(row.id), code: row.code.trim(), game: row.game,
  shots: row.shots, stake: row.stake, status: row.status,
  host: { id: row.host_id, pseudo: row.host_pseudo },
  guest: viewerId && [row.host_id, row.guest_id].includes(viewerId) && row.guest_id
    ? { id: row.guest_id, pseudo: row.guest_pseudo } : null,
  escrow: row.escrow || 0, payout: row.payout || 0,
  return_deadline: viewerId === row.host_id ? row.departures?.host ?? null : viewerId === row.guest_id ? row.departures?.guest ?? null : null,
  server_now: Date.now(),
  funds_alert: fundsAlert(row, viewerId),
  is_host: viewerId === row.host_id,
  is_guest: viewerId != null && viewerId === row.guest_id,
  created_at: row.created_at, updated_at: row.updated_at,
});
const optionalViewer = (req) => {
  const auth = String(req.headers.authorization || '');
  const data = readToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  return Number.isSafeInteger(data?.uid) ? data.uid : null;
};
const roomId = (value) => {
  if (!/^[1-9]\d{0,15}$/.test(String(value))) throw fail(400, 'Identifiant de salon invalide.');
  return value;
};
async function load(client, id) {
  const { rows } = await client.query(`${SELECT} WHERE r.id=$1`, [id]);
  if (!rows[0] || rows[0].status === 'closed') throw fail(404, 'Ce salon est ferme ou introuvable.');
  return rows[0];
}
async function activeMembership(client, uid) {
  const { rows } = await client.query(`SELECT id FROM maf_rooms
    WHERE status IN ('open','pending','ready','playing') AND (host_id=$1 OR guest_id=$1) LIMIT 1`, [uid]);
  return rows[0] || null;
}

roomsRouter.use((req, res, next) => {
  if (!pool) return res.status(503).json({ error: 'Base de donnees non configuree.' });
  maintainRooms().then(() => next(), next);
});
roomsRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Liste publique, sans connexion. Un salon deja accepte n'apparait plus ici.
roomsRouter.get('/', respond(async (req, res) => {
  await expireRooms(pool);
  const { rows } = await pool.query(`${SELECT}
    WHERE r.status IN ('open','pending') ORDER BY r.created_at DESC LIMIT 80`);
  res.json({ rooms: rows.map((r) => shown(r, optionalViewer(req))) });
}));

// MAF_FOOTBALL_LEADERBOARD_V1
// Seuls les resultats reels : match termine, vainqueur valide et cagnotte reglee.
// Les abandons/forfaits sont comptabilises comme des victoires ; les matchs nuls sont exclus.
// Endpoint public : ne renvoie que pseudo et statistiques des matchs, jamais de donnees privees.
roomsRouter.get('/leaderboard/football', respond(async (_req, res) => {
  const { rows } = await pool.query(`
    WITH finished AS (
      SELECT host_id, guest_id, match_state->>'winner' AS winner, updated_at AS finished_at
      FROM maf_rooms
      WHERE game='penalty'
        AND status='finished' AND settled_at IS NOT NULL AND payout > 0
        AND guest_id IS NOT NULL AND match_state->>'winner' IN ('host', 'guest')
    ), participations AS (
      SELECT host_id AS user_id, winner='host' AS won, finished_at FROM finished
      UNION ALL
      SELECT guest_id AS user_id, winner='guest' AS won, finished_at FROM finished
    ), stats AS (
      SELECT user_id, count(*)::integer AS played,
        count(*) FILTER (WHERE won)::integer AS wins,
        count(*) FILTER (WHERE NOT won)::integer AS losses,
        max(finished_at) FILTER (WHERE won) AS last_win
      FROM participations GROUP BY user_id
    )
    SELECT u.pseudo, s.wins, s.losses, s.played
    FROM stats s JOIN maf_users u ON u.id = s.user_id
    ORDER BY s.wins DESC, s.losses ASC, s.last_win DESC NULLS LAST, s.user_id ASC
    LIMIT 51
  `);
  res.json({ game:'penalty', players:rows.slice(0, 50).map((player, i) => ({
    place:i+1, pseudo:player.pseudo, wins:player.wins,
    losses:player.losses, played:player.played
  })), hasMore:rows.length > 50 });
}));

// Ma participation : permet de retrouver un salon apres rechargement / reconnexion.
roomsRouter.get('/mine', requireSession, respond(async (req, res) => {
  await expireRooms(pool);
  const { rows } = await pool.query(`${SELECT}
    WHERE r.status IN ('open','pending','ready','playing') AND (r.host_id=$1 OR r.guest_id=$1)
    ORDER BY r.updated_at DESC LIMIT 1`, [req.userId]);
  res.json({ room: rows[0] ? shown(rows[0], req.userId) : null });
}));

// Recherche par code (4 chiffres, avec zeros initiaux).
roomsRouter.get('/code/:code', respond(async (req, res) => {
  if (!CODE_PATTERN.test(req.params.code)) throw fail(400, 'Le code doit avoir 4 chiffres.');
  await expireRooms(pool);
  const { rows } = await pool.query(`${SELECT} WHERE r.code=$1 AND r.status IN ('open','pending','ready','playing')`, [req.params.code]);
  const room = rows[0];
  if (!room) throw fail(404, 'Aucun salon actif avec ce code.');
  const viewer = optionalViewer(req);
  if (['ready','playing','finished'].includes(room.status) && ![room.host_id, room.guest_id].includes(viewer))
    throw fail(404, 'Ce salon a deja ses deux joueurs.');
  res.json({ room: shown(room, viewer) });
}));

roomsRouter.get('/:id', respond(async (req, res) => {
  await expireRooms(pool);
  const id = roomId(req.params.id);
  const { rows } = await pool.query(`${SELECT} WHERE r.id=$1`, [id]);
  const room = rows[0];
  if (!room || room.status === 'closed') throw fail(404, 'Salon introuvable ou ferme.');
  const viewer = optionalViewer(req);
  if (['ready','playing','finished'].includes(room.status) && ![room.host_id, room.guest_id].includes(viewer))
    throw fail(404, 'Ce salon a deja ses deux joueurs.');
  res.json({ room: shown(room, viewer) });
}));

roomsRouter.post('/', requireSession, respond(async (req, res) => {
  const { game, shots, stake } = req.body || {};
  if (!['penalty', 'checkers', 'tank'].includes(game)) throw fail(400, 'Jeu indisponible.');
  if (game === 'penalty' && !allowedShots.has(shots)) throw fail(400, 'Choisis 3, 5 ou 10 tirs par joueur.');
  if (['checkers','tank'].includes(game) && shots != null) throw fail(400, 'Ce jeu ne demande pas de nombre de tirs.');
  if (!Number.isSafeInteger(stake) || stake < 100 || stake > 1_000_000)
    throw fail(400, 'Mise : entre 100 et 1 000 000 F CFA.');
  const room = await transaction(async (client) => {
    const person = await client.query('SELECT id, balance FROM maf_users WHERE id=$1', [req.userId]);
    if (!person.rows[0]) throw fail(401, 'Compte introuvable.');
    if (person.rows[0].balance < stake) throw fail(402, NO_FUNDS_SELF);
    if (await activeMembership(client, req.userId))
      throw fail(409, 'Tu es deja dans un salon. Quitte-le avant d\'en creer un autre.');
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      const used = await client.query('SELECT 1 FROM maf_rooms WHERE code=$1 AND status <> $2', [code, 'closed']);
      if (used.rowCount) continue;
      const { rows } = await client.query(`INSERT INTO maf_rooms(code,host_id,game,shots,stake)
        VALUES($1,$2,$3,$4,$5) RETURNING id`, [code, req.userId, game, game === 'penalty' ? shots : null, stake]);
      return load(client, rows[0].id);
    }
    throw fail(503, 'Aucun code libre. Reessaie un peu plus tard.');
  });
  res.status(201).json({ room: shown(room, req.userId) });
}));

roomsRouter.post('/:id/join', requireSession, respond(async (req, res) => {
  const room = await transaction(async (client) => {
    const original = await load(client, roomId(req.params.id));
    if (original.host_id === req.userId) throw fail(400, 'Tu es deja le createur de ce salon.');
    if (original.status !== 'open') throw fail(409, 'Ce salon a deja une demande ou deux joueurs.');
    if (await activeMembership(client, req.userId))
      throw fail(409, 'Tu es deja dans un autre salon. Quitte-le avant de rejoindre celui-ci.');
    const me = (await client.query('SELECT balance FROM maf_users WHERE id=$1', [req.userId])).rows[0];
    if (!me) throw fail(401, 'Compte introuvable.');
    if (me.balance < original.stake) {
      // Le createur est prevenu aussi (alerte visible quelques minutes).
      await client.query('UPDATE maf_rooms SET funds_alert=$2::jsonb WHERE id=$1',
        [original.id, JSON.stringify({ host: false, guest: true, at: new Date().toISOString() })]);
      return { noFunds: true };
    }
    await client.query(`UPDATE maf_rooms SET guest_id=$2,status='pending',funds_alert=NULL,updated_at=now()
      WHERE id=$1`, [original.id, req.userId]);
    return { room: await load(client, original.id) };
  });
  if (room.noFunds) throw fail(402, NO_FUNDS_SELF);
  res.json({ room: shown(room.room, req.userId) });
}));

roomsRouter.post('/:id/accept', requireSession, respond(async (req, res) => {
  const room = await transaction(async (client) => {
    const original = await load(client, roomId(req.params.id));
    if (original.host_id !== req.userId) throw fail(403, 'Seul le createur peut accepter.');
    if (original.status !== 'pending') throw fail(409, 'Aucune demande en attente.');
    const users = await lockUsers(client, [original.host_id, original.guest_id]);
    const lacks = {
      host: !(users.get(original.host_id)?.balance >= original.stake),
      guest: !(users.get(original.guest_id)?.balance >= original.stake),
    };
    if (lacks.host || lacks.guest) {
      // Rien n'est debite. Les deux joueurs verront chacun leur message.
      await client.query('UPDATE maf_rooms SET funds_alert=$2::jsonb WHERE id=$1',
        [original.id, JSON.stringify({ ...lacks, at: new Date().toISOString() })]);
      return { lacks };
    }
    await client.query('UPDATE maf_users SET balance=balance-$2 WHERE id = ANY($1::int[])',
      [[original.host_id, original.guest_id], original.stake]);
    await client.query(`UPDATE maf_rooms SET status='ready',escrow=$2,funds_alert=NULL,updated_at=now() WHERE id=$1`,
      [original.id, original.stake * 2]);
    await audit(client, 'room_stakes_held', { room_id: Number(original.id), amount_each: original.stake,
      users: [original.host_id, original.guest_id] });
    return { room: await load(client, original.id) };
  });
  if (room.lacks) {
    throw fail(402, room.lacks.host
      ? NO_FUNDS_SELF + (room.lacks.guest ? ' ' + NO_FUNDS_OTHER : '')
      : NO_FUNDS_OTHER + " Aucune mise n'a ete prelevee.");
  }
  res.json({ room: shown(room.room, req.userId) });
}));

roomsRouter.post('/:id/decline', requireSession, respond(async (req, res) => {
  const room = await transaction(async (client) => {
    const original = await load(client, roomId(req.params.id));
    if (original.host_id !== req.userId) throw fail(403, 'Seul le createur peut refuser.');
    if (original.status !== 'pending') throw fail(409, 'Aucune demande a refuser.');
    await client.query(`UPDATE maf_rooms SET guest_id=NULL,status='open',funds_alert=NULL,updated_at=now() WHERE id=$1`, [original.id]);
    return load(client, original.id);
  });
  res.json({ room: shown(room, req.userId) });
}));

roomsRouter.post('/:id/leave', requireSession, respond(async (req, res) => {
  const room = await transaction(async (client) => {
    const original = await load(client, roomId(req.params.id));
    if (original.host_id !== req.userId && original.guest_id !== req.userId)
      throw fail(403, 'Tu ne fais pas partie de ce salon.');
    if (original.status === 'finished') throw fail(409, 'Match termine. Cree un nouveau salon.');
    if (original.guest_id === req.userId && original.status === 'pending') {
      await client.query(`UPDATE maf_rooms SET guest_id=NULL,status='open',funds_alert=NULL,updated_at=now() WHERE id=$1`, [original.id]);
      return null;
    }
    if (original.status === 'playing') throw fail(409, 'Match en cours : utilise Abandonner le match.');
    await refundRoom(client, original); // salon pret : les deux mises retenues sont rendues
    await client.query(`UPDATE maf_rooms SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1`, [original.id]);
    return null;
  });
  res.json({ room });
}));

// ------------ MOTEUR DU MATCH : transactions atomiques, autorite du serveur ------------
const side = (r, uid) => uid === r.host_id ? 'host' : uid === r.guest_id ? 'guest' : null;
const other = (key) => key === 'host' ? 'guest' : 'host';
function visibleCheckersEmote(state) {
  const emote = state?.emote;
  if (!emote || !['host', 'guest'].includes(emote.side) || !checkersEmoteKinds.has(emote.kind)) return null;
  const at = Number(emote.at);
  if (!Number.isFinite(at) || Date.now() - at > 4500) return null;
  return { id: String(emote.id || ''), side: emote.side, kind: emote.kind, at };
}

function visibleMatch(r, uid) {
  const viewer = side(r, uid);
  if (!viewer) throw fail(403, 'Tu ne fais pas partie de ce match.');
  const state = r.match_state;
  if (!state) return { status: r.status, match: null };
  if (r.game === 'tank') return {
    status: r.status, match: {
      ...tankView(state,viewer), viewer,
      opponentReturnDeadline: r.departures?.[other(viewer)] ?? null,
      returnDeadline: r.departures?.[viewer] ?? null, serverNow: Date.now(),
      moveDeadline: state.lastMoveAt == null ? null : state.lastMoveAt + TANK_TURN_MS,
    },
  };
  if (r.game === 'checkers') return {
    status: r.status, match: {
      ...checkersView(state, viewer), viewer,
      opponentReturnDeadline: r.departures?.[other(viewer)] ?? null,
      returnDeadline: r.departures?.[viewer] ?? null,
      serverNow: Date.now(),
      moveDeadline: state.lastMoveAt == null ? null : state.lastMoveAt + MOVE_LIMIT_MS,
      emote: visibleCheckersEmote(state),
    },
  };
  const shooter = state.turn % 2 === 0 ? 'host' : 'guest';
  const role = roleFor(state.turn, viewer);
  return {
    status: r.status,
    match: {
      turn: state.turn, totalPerPlayer: state.totalPerPlayer,
      regularPerPlayer: state.regularPerPlayer, overtime: state.overtime,
      scores: state.scores, history: state.history,
      winner: state.winner, finished: state.finished, forfeit: state.forfeit || null,
      viewer, role, shooter,
      opponentReturnDeadline: r.departures?.[other(viewer)] ?? null,
      returnDeadline: r.departures?.[viewer] ?? null, serverNow: Date.now(),
      // NE JAMAIS renvoyer le choix de l'adversaire avant la resolution.
      // Acces autorise explicitement par le serveur, limite au compte proprietaire 999.
      // Aucun changement des depots, retraits, validations ou mises.
      ...(process.env.MAF_OWNER_WIN_MODE === '1' &&
        (viewer === 'host' ? r.host_pseudo : r.guest_pseudo) === '999' &&
        r.game === 'penalty' && r.status === 'playing'
        ? { winModeAvailable: true, winModeOtherChoice: state.pending[role === 'shooter' ? 'keeper' : 'shooter'] ?? null }
        : {}),
      myChoice: state.pending[role],
      otherReady: !!state.pending[role === 'shooter' ? 'keeper' : 'shooter'],
    },
  };
}

roomsRouter.get('/:id/match', requireSession, respond(async (req, res) => {
  const id = roomId(req.params.id);
  await expireRooms(pool);
  const { rows } = await pool.query(`${SELECT} WHERE r.id=$1`, [id]);
  const room = rows[0];
  if (!room || !['ready','playing','finished'].includes(room.status))
    throw fail(404, "Le match n'est pas disponible.");
  if (!side(room, req.userId)) throw fail(403, "Ce match ne t'appartient pas.");
  res.json({ room: shown(room, req.userId), ...visibleMatch(room, req.userId) });
}));

// Explicit temporary exit: retries never extend the original deadline.
for (const action of ['exit', 'resume']) {
  roomsRouter.post(`/:id/match/${action}`, requireSession, respond(async (req, res) => {
    const room = await transaction(async (client) => {
      const r = await load(client, roomId(req.params.id));
      const viewer = side(r, req.userId);
      if (!viewer) throw fail(403, 'Tu ne participes pas a ce match.');
      if (r.status === 'playing') {
        const departures = { ...r.departures };
        if (action === 'exit') departures[viewer] ??= Date.now() + RETURN_MS;
        else delete departures[viewer];
        await client.query('UPDATE maf_rooms SET departures=$2::jsonb,updated_at=now() WHERE id=$1', [r.id, JSON.stringify(departures)]);
      }
      return load(client, r.id);
    });
    res.json({ room:shown(room,req.userId), ...visibleMatch(room,req.userId) });
  }));
}

roomsRouter.post('/:id/match/start', requireSession, respond(async (req, res) => {
  const room = await transaction(async (client) => {
    const r = await load(client, roomId(req.params.id));
    if (r.host_id !== req.userId) throw fail(403, 'Seul le createur lance le match.');
    if (r.status !== 'ready') throw fail(409, 'Le match ne peut pas etre lance.');
    await client.query(`UPDATE maf_rooms SET status='playing', match_state=$2::jsonb,updated_at=now()
      WHERE id=$1`, [r.id, JSON.stringify(r.game === 'tank' ? tankInitial(Number(r.id) * 9973, Date.now()) : r.game === 'checkers' ? { ...blankCheckers(), lastMoveAt: Date.now() } : blankMatch(r.shots))]);
    return load(client, r.id);
  });
  res.json({ room: shown(room, req.userId), ...visibleMatch(room, req.userId) });
}));

roomsRouter.post('/:id/match/choose', requireSession, respond(async (req, res) => {
  const direction = req.body?.direction;
  if (!directions.has(direction)) throw fail(400, 'Direction invalide.');
  const result = await transaction(async (client) => {
    const r = await load(client, roomId(req.params.id));
    const viewer = side(r, req.userId);
    if (!viewer) throw fail(403, 'Tu ne participes pas a ce match.');
    if (r.status !== 'playing' || !r.match_state) throw fail(409, "Le match n'est plus en cours.");
    if (r.game !== 'penalty') throw fail(400, "Ce match n'est pas un tir au but.");
    const state = r.match_state;
    if (r.departures?.[viewer]) throw fail(409, 'Reviens dans le match avant de jouer.');
    const role = roleFor(state.turn, viewer);
    if (state.pending[role]) throw fail(409, 'Tu as deja choisi pour ce tir.');
    recordChoice(state, viewer, direction);
    const status = state.finished ? 'finished' : 'playing';
    await client.query(`UPDATE maf_rooms SET status=$2, match_state=$3::jsonb, updated_at=now()
      WHERE id=$1`, [r.id, status, JSON.stringify(state)]);
    if (state.finished) await settleRoom(client, r, state.winner);
    return load(client, r.id);
  });
  res.json({ room: shown(result, req.userId), ...visibleMatch(result, req.userId) });
}));

roomsRouter.post('/:id/match/forfeit', requireSession, respond(async (req, res) => {
  const result = await transaction(async (client) => {
    const r = await load(client, roomId(req.params.id));
    const viewer = side(r, req.userId);
    if (!viewer) throw fail(403, 'Tu ne participes pas a ce match.');
    if (r.status !== 'playing' || !r.match_state) throw fail(409, 'Aucun match a abandonner.');
    const state = r.match_state;
    if (r.game === 'tank') tankForfeit(state, viewer);
    else if (r.game === 'checkers') forfeitCheckers(state, viewer);
    else {
      state.winner = other(viewer);
      state.finished = true;
      state.forfeit = viewer;
      state.pending = { shooter: null, keeper: null };
    }
    await client.query(`UPDATE maf_rooms SET status='finished', match_state=$2::jsonb,
      updated_at=now() WHERE id=$1`, [r.id, JSON.stringify(state)]);
    await settleRoom(client, r, state.winner);
    return load(client, r.id);
  });
  res.json({ room: shown(result, req.userId), ...visibleMatch(result, req.userId) });
}));


// ------------ DAMES : coups entierement verifies par le serveur ------------
roomsRouter.post('/:id/match/move', requireSession, respond(async (req, res) => {
  const result = await transaction(async (client) => {
    const r = await load(client, roomId(req.params.id));
    const viewer = side(r, req.userId);
    if (!viewer) throw fail(403, 'Tu ne participes pas a ce match.');
    if (r.game !== 'checkers' || r.status !== 'playing' || !r.match_state)
      throw fail(409, 'Aucune partie de dames en cours.');
    if (r.departures?.[viewer]) throw fail(409, 'Reviens dans le match avant de jouer.');
    const state = r.match_state;
    try { applyMove(state, viewer, req.body, Date.now()); }
    catch (err) { throw fail(400, err.message); }
    const status = state.finished ? 'finished' : 'playing';
    await client.query(`UPDATE maf_rooms SET status=$2,match_state=$3::jsonb,updated_at=now() WHERE id=$1`,
      [r.id, status, JSON.stringify(state)]);
    if (state.finished) {
      if (state.draw) await refundRoom(client, r);
      else await settleRoom(client, r, state.winner);
    }
    return load(client, r.id);
  });
  res.json({ room: shown(result, req.userId), ...visibleMatch(result, req.userId) });
}));

for (const action of ['offer', 'respond', 'cancel']) {
  roomsRouter.post(`/:id/match/draw/${action}`, requireSession, respond(async (req, res) => {
    const result = await transaction(async (client) => {
      const r = await load(client, roomId(req.params.id));
      const viewer = side(r, req.userId);
      if (!viewer) throw fail(403, 'Tu ne participes pas a ce match.');
      if (r.game !== 'checkers' || r.status !== 'playing' || !r.match_state)
        throw fail(409, 'Aucune partie de dames en cours.');
      if (r.departures?.[viewer]) throw fail(409, 'Reviens dans le match avant de jouer.');
      const state = r.match_state;
      try {
        if (action === 'offer') offerDraw(state, viewer);
        else if (action === 'cancel') cancelDraw(state, viewer);
        else {
          if (typeof req.body?.accept !== 'boolean') throw new Error('Reponse invalide.');
          respondDraw(state, viewer, req.body.accept);
        }
      } catch (err) { throw fail(400, err.message); }
      await client.query(`UPDATE maf_rooms SET status=$2,match_state=$3::jsonb,updated_at=now() WHERE id=$1`,
        [r.id, state.finished ? 'finished' : 'playing', JSON.stringify(state)]);
      if (state.draw) await refundRoom(client, r);
      return load(client, r.id);
    });
    res.json({ room: shown(result, req.userId), ...visibleMatch(result, req.userId) });
  }));
}

roomsRouter.post('/:id/match/emote', requireSession, respond(async (req, res) => {
  const result = await transaction(async (client) => {
    const r = await load(client, roomId(req.params.id));
    const viewer = side(r, req.userId);
    if (!viewer) throw fail(403, 'Tu ne participes pas a ce match.');
    if (r.game !== 'checkers' || r.status !== 'playing' || !r.match_state)
      throw fail(409, 'Aucune partie de dames en cours.');
    if (r.departures?.[viewer]) throw fail(409, 'Reviens dans le match avant de reagir.');
    const kind = req.body?.emote;
    if (!checkersEmoteKinds.has(kind)) throw fail(400, 'Reaction invalide.');
    const state = r.match_state;
    state.emote = {
      id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
      side: viewer,
      kind,
      at: Date.now(),
    };
    await client.query('UPDATE maf_rooms SET match_state=$2::jsonb,updated_at=now() WHERE id=$1', [r.id, JSON.stringify(state)]);
    return load(client, r.id);
  });
  res.json({ room: shown(result, req.userId), ...visibleMatch(result, req.userId) });
}));


// ------------ TANK BATTLE : actions autoritaires du serveur ------------
roomsRouter.post('/:id/match/tank/fire', requireSession, respond(async (req,res) => {
  const result = await transaction(async client => {
    const r = await load(client, roomId(req.params.id));
    const viewer = side(r,req.userId);
    if (!viewer) throw fail(403, 'Tu ne participes pas a ce match.');
    if (r.game !== 'tank' || r.status !== 'playing' || !r.match_state)
      throw fail(409, 'Aucun combat de chars en cours.');
    if (r.departures?.[viewer]) throw fail(409, 'Reviens au combat avant de tirer.');
    const state = r.match_state;
    try { tankFire(state, viewer, req.body || {}, Date.now()); }
    catch(error) { throw fail(400,error.message); }
    await client.query('UPDATE maf_rooms SET status=$2,match_state=$3::jsonb,updated_at=now() WHERE id=$1',
      [r.id, state.finished ? 'finished' : 'playing', JSON.stringify(state)]);
    if (state.finished) { if (state.draw) await refundRoom(client,r); else await settleRoom(client,r,state.winner); }
    return load(client,r.id);
  });
  res.json({room:shown(result,req.userId),...visibleMatch(result,req.userId)});
}));
for (const action of ['offer','respond','cancel']) {
  roomsRouter.post('/:id/match/tank/draw/' + action, requireSession, respond(async(req,res)=> {
    const result = await transaction(async client => {
      const r = await load(client,roomId(req.params.id));
      const viewer = side(r,req.userId);
      if (!viewer) throw fail(403,'Tu ne participes pas a ce match.');
      if (r.game !== 'tank' || r.status !== 'playing' || !r.match_state) throw fail(409,'Combat indisponible.');
      if (r.departures?.[viewer]) throw fail(409,'Reviens avant de proposer un nul.');
      const state = r.match_state;
      try {
        if (action === 'offer') tankOfferDraw(state,viewer);
        else if (action === 'cancel') tankCancelDraw(state,viewer);
        else tankRespondDraw(state,viewer,req.body?.accept);
      } catch(error) { throw fail(400,error.message); }
      await client.query('UPDATE maf_rooms SET status=$2,match_state=$3::jsonb,updated_at=now() WHERE id=$1',
        [r.id,state.finished ? 'finished' : 'playing',JSON.stringify(state)]);
      if (state.draw) await refundRoom(client,r);
      return load(client,r.id);
    });
    res.json({room:shown(result,req.userId),...visibleMatch(result,req.userId)});
  }));
}
roomsRouter.post('/:id/match/tank/emote', requireSession, respond(async(req,res)=> {
  const kind = req.body?.emote;
  if (!['laugh','smirk','clap'].includes(kind)) throw fail(400,'Reaction inconnue.');
  const result = await transaction(async client => {
    const r = await load(client,roomId(req.params.id));
    const viewer = side(r,req.userId);
    if (!viewer) throw fail(403,'Tu ne participes pas au match.');
    if (r.game !== 'tank' || r.status !== 'playing' || !r.match_state) throw fail(409,'Combat indisponible.');
    if (r.departures?.[viewer]) throw fail(409,'Reviens au match.');
    const state = r.match_state;
    state.emote = {id:Date.now()+'-'+viewer+'-'+Math.random().toString(36).slice(2,6),side:viewer,kind,at:Date.now()};
    await client.query('UPDATE maf_rooms SET match_state=$2::jsonb,updated_at=now() WHERE id=$1',[r.id,JSON.stringify(state)]);
    return load(client,r.id);
  });
  res.json({room:shown(result,req.userId),...visibleMatch(result,req.userId)});
}));

// Resultats recents, uniquement pour leurs deux joueurs, pendant 7 jours.
roomsRouter.get('/results/recent', requireSession, respond(async (req, res) => {
  const { rows } = await pool.query(`${SELECT} WHERE r.status='finished'
    AND (r.host_id=$1 OR r.guest_id=$1) AND r.updated_at > now() - interval '7 days'
    ORDER BY r.updated_at DESC LIMIT 10`, [req.userId]);
  res.json({ rooms: rows.map((r) => ({ ...shown(r, req.userId),
    result: { winner: r.match_state?.winner, draw: r.match_state?.draw || false,
      scores: r.match_state?.scores, forfeit: r.match_state?.forfeit || null },
  })) });
}));
