// Etape 1 : annonces uniquement. Aucune route de reservation ou de mouvement de solde.
import { Router } from 'express';
import { pool } from './db.js';
import { ensureTable, requireSession } from './auth.js';
export const tournamentsRouter = Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const run = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};
let ready;
export function ensureTournaments() {
  if (!ready) ready = (async () => {
    if (!pool) throw fail(503, 'Les tournois sont temporairement indisponibles.');
    await ensureTable();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(62498461)');
      await client.query(`CREATE TABLE IF NOT EXISTS maf_tournaments (
        id serial PRIMARY KEY, game text NOT NULL DEFAULT 'monopoly' CHECK(game='monopoly'),
        title text NOT NULL, description text NOT NULL DEFAULT '',
        starts_at timestamptz NOT NULL, final_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
        capacity integer NOT NULL DEFAULT 20 CHECK(capacity=20),
        entry_fee integer NOT NULL DEFAULT 500 CHECK(entry_fee=500),
        revision integer NOT NULL DEFAULT 1,
        creator_id integer NOT NULL REFERENCES maf_users(id),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(final_at>starts_at)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS maf_tournament_entries (
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        status text NOT NULL CHECK(status IN ('reserved','refunded')),
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tournament_id,user_id)
      )`);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  })().catch(e => { ready = null; throw e; });
  return ready;
}
const select = `SELECT t.*, (SELECT count(*)::int FROM maf_tournament_entries e
  WHERE e.tournament_id=t.id AND e.status='reserved') AS registered FROM maf_tournaments t`;
function view(row) {
  return { id: row.id, game: row.game, title: row.title, description: row.description,
    startsAt: new Date(row.starts_at).toISOString(), finalAt: new Date(row.final_at).toISOString(),
    status: row.status, capacity: row.capacity, entryFee: row.entry_fee,
    registered: Number(row.registered || 0), revision: row.revision, registrationOpen: false,
    rewards: { real: [2000, 1600, 1500, 1400], eliminatedReal: 62.5, bonusEach: 100,
      participantSkins: 1, finalistSkins: 2 } };
}
function input(body) {
  if (!body || typeof body.title !== 'string' || typeof body.description !== 'string')
    throw fail(400, 'Titre et description requis.');
  const title = body.title.trim(), description = body.description.trim();
  if (!title || title.length > 80 || description.length > 1500)
    throw fail(400, 'Titre : 1 à 80 caractères. Description : 1 500 caractères maximum.');
  if (!['draft','published','archived'].includes(body.status)) throw fail(400, 'Etat invalide.');
  const dates = [body.startsAt, body.finalAt].map(value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value))
      throw fail(400, 'Dates UTC invalides.');
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,19) !== value.slice(0,19))
      throw fail(400, 'Date invalide.');
    return time;
  });
  if (dates[1] <= dates[0]) throw fail(400, 'La finale doit suivre les qualifications.');
  if (body.status === 'published' && dates[0] <= Date.now())
    throw fail(400, 'Choisis une date de qualification future pour publier cette annonce.');
  // Les montants et capacites ne peuvent pas etre remplaces par le navigateur.
  if (['capacity','entryFee','registered','rewards','registrationOpen','game'].some(k => k in body))
    throw fail(400, 'Le format Monopoly est fixé à 20 places et 500 F.');
  return [title, description, new Date(dates[0]).toISOString(), new Date(dates[1]).toISOString(), body.status];
}
async function owner(req) {
  const { rows } = await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1', [req.userId]);
  if (rows[0]?.pseudo_key !== '999') throw fail(403, 'Accès réservé au propriétaire.');
}
tournamentsRouter.use((req,res,next) => { res.set('Cache-Control','no-store'); next(); });
// Initialisation paresseuse : l'indisponibilite des tournois ne bloque pas les autres jeux.
tournamentsRouter.use((req,res,next) => ensureTournaments().then(() => next()).catch(next));
tournamentsRouter.get('/', run(async (req,res) => {
  const { rows } = await pool.query(select + " WHERE t.status='published' ORDER BY t.starts_at,t.id");
  res.json({ tournaments: rows.map(view), serverNow: Date.now() });
}));
tournamentsRouter.get('/owner', requireSession, run(async (req,res) => {
  await owner(req);
  const { rows } = await pool.query(select + ' ORDER BY t.created_at DESC,t.id DESC LIMIT 100');
  res.json({ tournaments: rows.map(view), serverNow: Date.now() });
}));
tournamentsRouter.post('/owner', requireSession, run(async (req,res) => {
  await owner(req);
  const values = input(req.body);
  const { rows } = await pool.query(`INSERT INTO maf_tournaments(title,description,starts_at,final_at,status,creator_id)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [...values, req.userId]);
  res.status(201).json({ tournament: view(rows[0]), serverNow: Date.now() });
}));
tournamentsRouter.put('/owner/:id', requireSession, run(async (req,res) => {
  await owner(req);
  const id = Number(req.params.id), revision = req.body?.revision;
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(revision) || revision < 1)
    throw fail(400, 'Identifiant ou version invalide.');
  const values = input(req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(select + ' WHERE t.id=$1 FOR UPDATE OF t', [id]);
    const row = rows[0];
    if (!row) throw fail(404, 'Tournoi introuvable.');
    if (row.revision !== revision) throw fail(409, 'Ce tournoi a été modifié ailleurs. Recharge la liste avant de réessayer.');
    if (Number(row.registered) > 0) throw fail(409, 'Ce tournoi comporte des réservations : modification bloquée.');
    const updated = await client.query(`UPDATE maf_tournaments SET title=$1,description=$2,starts_at=$3,
      final_at=$4,status=$5,revision=revision+1,updated_at=now() WHERE id=$6 RETURNING *`, [...values,id]);
    await client.query('COMMIT');
    res.json({ tournament: view(updated.rows[0]), serverNow: Date.now() });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));
