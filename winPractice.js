// Codes de Mode Win pour les parties SOLO (sans mise) exclusivement.
// Aucun acces aux parties multijoueurs, aux choix caches de l'adversaire ou aux soldes.
import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from './db.js';
import { ensureTable, requireSession } from './auth.js';

export const winPracticeRouter = Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const run = fn => async (req, res, next) => {
  try { await fn(req,res); } catch (e) {
    if (e.status) return res.status(e.status).json({error:e.message});
    if (e.code === '23505') return res.status(409).json({error:'Code deja existant.'});
    next(e);
  }
};
let ready;
export function ensureWinPractice() {
  if (!ready) ready = (async () => {
    await ensureTable();
    await pool.query(`CREATE TABLE IF NOT EXISTS maf_win_practice_codes (
      code text PRIMARY KEY,
      creator_id integer NOT NULL REFERENCES maf_users(id),
      game text NOT NULL CHECK (game IN ('all','penalty','tank')),
      kind text NOT NULL CHECK (kind IN ('duration','match')),
      duration_seconds integer CHECK (duration_seconds BETWEEN 60 AND 86400),
      redeemed_by integer REFERENCES maf_users(id),
      redeemed_at timestamptz,
      expires_at timestamptz,
      matches_left integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((kind='duration' AND duration_seconds IS NOT NULL) OR
             (kind='match' AND duration_seconds IS NULL))
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS maf_win_practice_redeemed_by ON maf_win_practice_codes(redeemed_by)');
  })().catch(e => { ready = null; throw e; });
  return ready;
}
const codeRE = /^WIN-[A-F0-9]{24}$/;
function view(row) {
  if (!row) return null;
  return {code:row.code,game:row.game,kind:row.kind,
    expires_at:new Date(row.expires_at).toISOString(),
    matches_left:row.matches_left ?? null,
    active:new Date(row.expires_at).getTime() > Date.now() &&
      (row.kind !== 'match' || row.matches_left > 0)};
}
async function requireOwner(req) {
  const { rows } = await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[req.userId]);
  if (rows[0]?.pseudo_key !== '999') throw fail(403,'Acces reserve au proprietaire.');
}
winPracticeRouter.use(requireSession);
winPracticeRouter.use((req,res,next) => ensureWinPractice().then(() => next(), next));

winPracticeRouter.post('/create', run(async (req,res) => {
  await requireOwner(req);
  const { game, kind, duration_seconds:seconds } = req.body || {};
  if (!['all','tank','penalty'].includes(game) || !['match','duration'].includes(kind))
    throw fail(400,'Jeu ou duree invalide.');
  if (kind === 'duration' && (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400))
    throw fail(400,'Duree comprise entre 1 minute et 1 jour.');
  const duration = kind === 'match' ? null : seconds;
  const code = 'WIN-' + crypto.randomBytes(12).toString('hex').toUpperCase();
  const {rows} = await pool.query(
    `INSERT INTO maf_win_practice_codes(code,creator_id,game,kind,duration_seconds)
     VALUES($1,$2,$3,$4,$5) RETURNING code,game,kind,duration_seconds,created_at`,
     [code,req.userId,game,kind,duration]);
  res.set('Cache-Control','no-store');
  res.status(201).json({coupon:rows[0]});
}));

export async function redeemWinPractice(code, userId) {
  if (!codeRE.test(code)) return null;
  await ensureWinPractice();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      'SELECT * FROM maf_win_practice_codes WHERE code=$1 FOR UPDATE',[code])).rows[0];
    if (!row) throw fail(404,'Coupon introuvable.');
    if (row.redeemed_by && row.redeemed_by !== userId)
      throw fail(409,'Ce coupon a deja ete utilise.');
    if (!row.redeemed_by) {
      const fresh = (await client.query(
        `UPDATE maf_win_practice_codes SET redeemed_by=$2,redeemed_at=now(),
         expires_at=now()+($3::integer*interval '1 second'),
         matches_left=$4 WHERE code=$1 RETURNING *`,
        [code,userId,row.kind === 'match' ? 86400 : row.duration_seconds,
         row.kind === 'match' ? 1 : null])).rows[0];
      await client.query('COMMIT');
      return view(fresh);
    }
    await client.query('COMMIT');
    return view(row);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

winPracticeRouter.get('/me', run(async (req,res) => {
  const {rows} = await pool.query(
    `SELECT * FROM maf_win_practice_codes WHERE redeemed_by=$1 AND expires_at>now()
     AND (kind='duration' OR matches_left>0)
     ORDER BY redeemed_at DESC LIMIT 1`,[req.userId]);
  res.set('Cache-Control','no-store');
  res.json({win_access:view(rows[0])});
}));

// Une seule partie d'entrainement est consommee par le coupon de type "match".
winPracticeRouter.post('/start', run(async (req,res) => {
  const game = req.body?.game, code = req.body?.code;
  if (!['tank','penalty'].includes(game) || !codeRE.test(code))
    throw fail(400,'Partie ou coupon invalide.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      'SELECT * FROM maf_win_practice_codes WHERE code=$1 AND redeemed_by=$2 FOR UPDATE',
      [code,req.userId])).rows[0];
    if (!row || new Date(row.expires_at).getTime() <= Date.now() ||
        (row.game !== 'all' && row.game !== game) ||
        (row.kind === 'match' && row.matches_left !== 1))
      throw fail(409,'Code Win inactif pour ce jeu.');
    if (row.kind === 'match') await client.query(
      'UPDATE maf_win_practice_codes SET matches_left=0 WHERE code=$1',[code]);
    await client.query('COMMIT');
    res.set('Cache-Control','no-store');
    res.json({win_access:view(row),game});
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));
