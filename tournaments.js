import { isOwnerAccount } from './accountRoles.js';
// Etape 1 : annonces uniquement. Aucune route de reservation ou de mouvement de solde.
import { Router } from 'express';
import { PUBLIC_REWARD_SCENARIOS } from './tournamentPublicRewards.js';
import { publicTournamentBookingsEnabled } from './tournamentLaunchPolicy.js';
import { pool } from './db.js';
import { tournamentReference } from './tournamentMatchReferences.js';
import { STUDIO_SKINS, selectedTournamentSkin, studioSkin } from './studioSkinCatalog.js';
import { ensureTable, requireSession } from './auth.js';
import { ensureReservationTables, mountReservations } from './tournamentReservations.js'; // MAF_TOURNOI_ETAPE2_V1
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
      await client.query(`ALTER TABLE maf_tournaments
        ADD COLUMN IF NOT EXISTS participant_skin_id text,
        ADD COLUMN IF NOT EXISTS winner_skin_id text`);
      await ensureReservationTables(client);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  })().catch(e => { ready = null; throw e; });
  return ready;
}
const select = `SELECT t.*, (SELECT count(*)::int FROM maf_tournament_entries e
  WHERE e.tournament_id=t.id AND e.status='reserved') AS registered FROM maf_tournaments t`;
const registrationIsOpen = row => publicTournamentBookingsEnabled() && row.status === 'published' && row.registration_open === true && Date.parse(row.starts_at) > Date.now();
function view(row) {
  return { id: row.id, reference: tournamentReference(row.id), game: row.game, title: row.title, description: row.description,
    startsAt: new Date(row.starts_at).toISOString(), finalAt: new Date(row.final_at).toISOString(),
    status: row.status, capacity: row.capacity, entryFee: row.entry_fee,
    registered: Number(row.registered || 0), revision: row.revision, registrationOpen: registrationIsOpen(row),
    publicBookingsEnabled: publicTournamentBookingsEnabled(), registrationConfigured: row.registration_open === true, full: Number(row.registered || 0) >= row.capacity,
    participantSkinId: row.participant_skin_id || null, winnerSkinId: row.winner_skin_id || null,
    participantSkinName: studioSkin(row.participant_skin_id)?.name || null,
    winnerSkinName: studioSkin(row.winner_skin_id)?.name || null,
    rewardScenarios: PUBLIC_REWARD_SCENARIOS,
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
  let participantSkinId, winnerSkinId;
  try {
    participantSkinId=selectedTournamentSkin(body.participantSkinId);
    winnerSkinId=selectedTournamentSkin(body.winnerSkinId);
  } catch (error) { throw fail(400,error.message); }
  return [title, description, new Date(dates[0]).toISOString(), new Date(dates[1]).toISOString(), body.status,
    participantSkinId, winnerSkinId];
}
async function owner(req) {
  if (!await isOwnerAccount(req.userId, pool)) throw fail(403, 'Accès réservé au propriétaire.');
}
tournamentsRouter.use((req,res,next) => { res.set('Cache-Control','no-store'); next(); });
// Initialisation paresseuse : l'indisponibilite des tournois ne bloque pas les autres jeux.
tournamentsRouter.use((req,res,next) => ensureTournaments().then(() => next()).catch(next));
mountReservations(tournamentsRouter, { select, view, fail, run, owner });
// Liste publique des identifiants et de leur statut, sans données de compte.
tournamentsRouter.get('/skins/catalog', run(async (_req,res) => {
  res.json({skins:STUDIO_SKINS});
}));
tournamentsRouter.get('/', run(async (req,res) => {
  const { rows } = await pool.query(select + " WHERE t.status='published' AND t.deleted_at IS NULL AND t.cancelled_at IS NULL ORDER BY t.starts_at,t.id");
  // Seuls les pseudos publics : jamais d'ID interne, de solde ou de donnees de profil.
  const participants=await pool.query(`SELECT e.tournament_id,u.pseudo FROM maf_tournament_entries e
    JOIN maf_users u ON u.id=e.user_id JOIN maf_tournaments t ON t.id=e.tournament_id
    WHERE e.status='reserved' AND t.status='published' AND t.deleted_at IS NULL AND t.cancelled_at IS NULL
    ORDER BY e.tournament_id,e.created_at,e.user_id`);
  const byId=new Map();
  for(const row of participants.rows){const id=Number(row.tournament_id);if(!byId.has(id))byId.set(id,[]);byId.get(id).push(row.pseudo);}
  res.json({ tournaments: rows.map(row=>({...view(row),participants:(byId.get(row.id)||[])})), serverNow: Date.now() });
}));
tournamentsRouter.get('/owner', requireSession, run(async (req,res) => {
  await owner(req);
  const { rows } = await pool.query(select + ' WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC,t.id DESC LIMIT 100');
  res.json({ tournaments: rows.map(view), serverNow: Date.now() });
}));
tournamentsRouter.post('/owner', requireSession, run(async (req,res) => {
  await owner(req);
  const values = input(req.body);
  const { rows } = await pool.query(`INSERT INTO maf_tournaments
    (title,description,starts_at,final_at,status,participant_skin_id,winner_skin_id,creator_id,registration_open)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,($5='published')) RETURNING *`, [...values, req.userId]);
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
      final_at=$4,status=$5,participant_skin_id=$6,winner_skin_id=$7,registration_open=CASE
        WHEN status <> 'published' AND $5='published' THEN true
        WHEN $5 <> 'published' THEN false
        ELSE registration_open END,revision=revision+1,updated_at=now() WHERE id=$8 RETURNING *`, [...values,id]);
    await client.query('COMMIT');
    res.json({ tournament: view(updated.rows[0]), serverNow: Date.now() });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));
