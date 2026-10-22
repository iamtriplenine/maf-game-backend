// MARV GAME — Salons publics (etape 1/2).
// Les mises sont des propositions de test : cette API ne touche JAMAIS au portefeuille.
// Le resultat du match et les paiements devront etre ajoutes cote serveur en etape 2.
import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from './db.js';
import { ensureTable, readToken, requireSession } from './auth.js';

export const roomsRouter = Router();
const allowedShots = new Set([3, 5, 10]);
const ROOM_LIFETIME = '24 hours';
const CODE_PATTERN = /^\d{4}$/;
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
          game text NOT NULL CHECK(game IN ('penalty')),
          shots smallint NOT NULL CHECK(shots IN (3, 5, 10)),
          stake integer NOT NULL CHECK(stake BETWEEN 100 AND 1000000),
          status text NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'pending', 'ready', 'closed')),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          closed_at timestamptz,
          CHECK(guest_id IS NULL OR guest_id <> host_id),
          CHECK(status NOT IN ('pending','ready') OR guest_id IS NOT NULL),
          CHECK(status <> 'open' OR guest_id IS NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS maf_rooms_unique_active_code
          ON maf_rooms(code) WHERE status <> 'closed';
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
async function expireRooms(client) {
  await client.query(`UPDATE maf_rooms SET status='closed', closed_at=now(), updated_at=now()
    WHERE status <> 'closed' AND updated_at < now() - interval '${ROOM_LIFETIME}'`);
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verrou global sur les transitions de salon : codes et places ne se chevauchent pas.
    await client.query('SELECT pg_advisory_xact_lock(62498133)');
    await expireRooms(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Liste des salons : uniquement des identites publiques et aucune donnee sensible.
const SELECT = `SELECT r.*, h.pseudo AS host_pseudo, g.pseudo AS guest_pseudo
  FROM maf_rooms r JOIN maf_users h ON h.id=r.host_id
  LEFT JOIN maf_users g ON g.id=r.guest_id`;
const shown = (row, viewerId = null) => ({
  id: Number(row.id), code: row.code.trim(), game: row.game,
  shots: row.shots, stake: row.stake, status: row.status,
  host: { id: row.host_id, pseudo: row.host_pseudo },
  guest: viewerId && [row.host_id, row.guest_id].includes(viewerId) && row.guest_id
    ? { id: row.guest_id, pseudo: row.guest_pseudo } : null,
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
    WHERE status <> 'closed' AND (host_id=$1 OR guest_id=$1) LIMIT 1`, [uid]);
  return rows[0] || null;
}

roomsRouter.use((req, res, next) => {
  if (!pool) return res.status(503).json({ error: 'Base de donnees non configuree.' });
  ensureRooms().then(() => next(), next);
});
roomsRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Liste publique, sans connexion. Un salon deja accepte n'apparait plus ici.
roomsRouter.get('/', respond(async (req, res) => {
  await expireRooms(pool);
  const { rows } = await pool.query(`${SELECT}
    WHERE r.status IN ('open','pending') ORDER BY r.created_at DESC LIMIT 80`);
  res.json({ rooms: rows.map((r) => shown(r, optionalViewer(req))) });
}));

// Ma participation : permet de retrouver un salon apres rechargement / reconnexion.
roomsRouter.get('/mine', requireSession, respond(async (req, res) => {
  await expireRooms(pool);
  const { rows } = await pool.query(`${SELECT}
    WHERE r.status <> 'closed' AND (r.host_id=$1 OR r.guest_id=$1)
    ORDER BY r.updated_at DESC LIMIT 1`, [req.userId]);
  res.json({ room: rows[0] ? shown(rows[0], req.userId) : null });
}));

// Recherche par code (4 chiffres, avec zeros initiaux).
roomsRouter.get('/code/:code', respond(async (req, res) => {
  if (!CODE_PATTERN.test(req.params.code)) throw fail(400, 'Le code doit avoir 4 chiffres.');
  await expireRooms(pool);
  const { rows } = await pool.query(`${SELECT} WHERE r.code=$1 AND r.status <> 'closed'`, [req.params.code]);
  const room = rows[0];
  if (!room) throw fail(404, 'Aucun salon actif avec ce code.');
  const viewer = optionalViewer(req);
  if (room.status === 'ready' && ![room.host_id, room.guest_id].includes(viewer))
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
  if (room.status === 'ready' && ![room.host_id, room.guest_id].includes(viewer))
    throw fail(404, 'Ce salon a deja ses deux joueurs.');
  res.json({ room: shown(room, viewer) });
}));

roomsRouter.post('/', requireSession, respond(async (req, res) => {
  const { game, shots, stake } = req.body || {};
  if (game !== 'penalty') throw fail(400, 'Jeu indisponible.');
  if (!allowedShots.has(shots)) throw fail(400, 'Choisis 3, 5 ou 10 tirs par joueur.');
  if (!Number.isSafeInteger(stake) || stake < 100 || stake > 1_000_000)
    throw fail(400, 'Mise de test : entre 100 et 1 000 000 F CFA.');
  const room = await transaction(async (client) => {
    const person = await client.query('SELECT id FROM maf_users WHERE id=$1', [req.userId]);
    if (!person.rows[0]) throw fail(401, 'Compte introuvable.');
    if (await activeMembership(client, req.userId))
      throw fail(409, 'Tu es deja dans un salon. Quitte-le avant d\'en creer un autre.');
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      const used = await client.query('SELECT 1 FROM maf_rooms WHERE code=$1 AND status <> $2', [code, 'closed']);
      if (used.rowCount) continue;
      const { rows } = await client.query(`INSERT INTO maf_rooms(code,host_id,game,shots,stake)
        VALUES($1,$2,$3,$4,$5) RETURNING id`, [code, req.userId, game, shots, stake]);
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
    await client.query(`UPDATE maf_rooms SET guest_id=$2,status='pending',updated_at=now()
      WHERE id=$1`, [original.id, req.userId]);
    return load(client, original.id);
  });
  res.json({ room: shown(room, req.userId) });
}));

roomsRouter.post('/:id/accept', requireSession, respond(async (req, res) => {
  const room = await transaction(async (client) => {
    const original = await load(client, roomId(req.params.id));
    if (original.host_id !== req.userId) throw fail(403, 'Seul le createur peut accepter.');
    if (original.status !== 'pending') throw fail(409, 'Aucune demande en attente.');
    await client.query(`UPDATE maf_rooms SET status='ready',updated_at=now() WHERE id=$1`, [original.id]);
    return load(client, original.id);
  });
  res.json({ room: shown(room, req.userId) });
}));

roomsRouter.post('/:id/decline', requireSession, respond(async (req, res) => {
  const room = await transaction(async (client) => {
    const original = await load(client, roomId(req.params.id));
    if (original.host_id !== req.userId) throw fail(403, 'Seul le createur peut refuser.');
    if (original.status !== 'pending') throw fail(409, 'Aucune demande a refuser.');
    await client.query(`UPDATE maf_rooms SET guest_id=NULL,status='open',updated_at=now() WHERE id=$1`, [original.id]);
    return load(client, original.id);
  });
  res.json({ room: shown(room, req.userId) });
}));

roomsRouter.post('/:id/leave', requireSession, respond(async (req, res) => {
  const room = await transaction(async (client) => {
    const original = await load(client, roomId(req.params.id));
    if (original.host_id !== req.userId && original.guest_id !== req.userId)
      throw fail(403, 'Tu ne fais pas partie de ce salon.');
    if (original.guest_id === req.userId && original.status === 'pending') {
      await client.query(`UPDATE maf_rooms SET guest_id=NULL,status='open',updated_at=now() WHERE id=$1`, [original.id]);
      return null;
    }
    await client.query(`UPDATE maf_rooms SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1`, [original.id]);
    return null;
  });
  res.json({ room });
}));
