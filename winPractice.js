// Codes Win temporaires : assignation a un compte, a un jeu et a une partie eventuelle.
// Les regles des salons, les debits et les versements ne sont pas modifies.
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
      match_room_id bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((kind='duration' AND duration_seconds IS NOT NULL) OR
             (kind='match' AND duration_seconds IS NULL))
    )`);
    await pool.query('ALTER TABLE maf_win_practice_codes ADD COLUMN IF NOT EXISTS match_room_id bigint');
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
      (row.kind !== 'match' || row.matches_left > 0 || row.match_room_id != null)};
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


// Autorisation par le serveur, jamais a partir d'un simple drapeau du navigateur.
// La premiere lecture d'un match a deux consomme atomiquement les codes "une partie" :
// les appels suivants du MEME match restent autorises; les autres salons ne le sont pas.
export async function winAccessForRoom(userId, game, roomId) {
  if (!['penalty','tank'].includes(game) || !Number.isSafeInteger(Number(roomId)) || Number(roomId) < 1) return false;
  await ensureWinPractice();
  const { rowCount } = await pool.query(`
    UPDATE maf_win_practice_codes AS win
    SET matches_left = CASE WHEN win.kind='match' AND win.match_room_id IS NULL THEN 0 ELSE win.matches_left END,
        match_room_id = CASE WHEN win.kind='match' AND win.match_room_id IS NULL THEN $3::bigint ELSE win.match_room_id END
    WHERE win.code = (
      SELECT code FROM maf_win_practice_codes
      WHERE redeemed_by=$1 AND expires_at>now() AND (game='all' OR game=$2)
        AND (kind='duration' OR match_room_id=$3::bigint OR (matches_left=1 AND match_room_id IS NULL))
      ORDER BY redeemed_at DESC LIMIT 1
    )
      AND win.redeemed_by=$1 AND win.expires_at>now() AND (win.game='all' OR win.game=$2)
      AND (win.kind='duration' OR win.match_room_id=$3::bigint
           OR (win.matches_left=1 AND win.match_room_id IS NULL))
    RETURNING win.code
  `, [userId,game,String(roomId)]);
  return rowCount > 0;
}
