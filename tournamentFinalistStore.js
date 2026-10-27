// Persistance serveur des quatre qualifiés. Un seul resultat par plateau.
import { pool } from './db.js';
import { finalistFromMatch, finalistOverview } from './tournamentFinalistRules.js';

let installed;
export function ensureFinalistsTables() {
  if (!installed) installed = (async () => {
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498466)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_finalists (
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        table_no integer NOT NULL CHECK (table_no BETWEEN 1 AND 4),
        match_id bigint NOT NULL REFERENCES maf_tournament_qualification_matches(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        qualified_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tournament_id,table_no),
        UNIQUE(tournament_id,user_id),
        UNIQUE(match_id)
      )`);
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK').catch(()=>{}); throw e; }
    finally { c.release(); }
  })().catch(e=>{installed=null;throw e;});
  return installed;
}

// A appeler dans la MEME transaction que la mise a jour du jeu termine.
export async function recordWinnerForMatch(client, match) {
  const winner=finalistFromMatch(match);
  if (!winner) return false;
  await client.query(`INSERT INTO maf_tournament_finalists(tournament_id,table_no,match_id,user_id)
    VALUES($1,$2,$3,$4) ON CONFLICT (tournament_id,table_no) DO NOTHING`,
    [winner.tournamentId,winner.table,winner.matchId,winner.userId]);
  const saved=(await client.query(`SELECT match_id,user_id FROM maf_tournament_finalists
    WHERE tournament_id=$1 AND table_no=$2`,[winner.tournamentId,winner.table])).rows[0];
  if (!saved || Number(saved.user_id)!==winner.userId || Number(saved.match_id)!==winner.matchId)
    throw new Error('Conflit de qualifie : aucune modification du plateau validee.');
  return true;
}

export async function loadFinalistLobby(tournamentId) {
  const matches=(await pool.query(`SELECT id,tournament_id,table_no,state
    FROM maf_tournament_qualification_matches WHERE tournament_id=$1 ORDER BY table_no`,[tournamentId])).rows;
  const finalists=(await pool.query(`SELECT tournament_id,table_no,match_id,user_id,qualified_at
    FROM maf_tournament_finalists WHERE tournament_id=$1 ORDER BY table_no`,[tournamentId])).rows;
  return {...finalistOverview(matches,finalists),tournamentId,live:true};
}

// Rattrapage des qualifications qui etaient deja terminees (redemarrage/ancien deploiement).
export async function reconcileFinalistArrivals() {
  if (process.env.MAF_TOURNAMENT_REAL_START_ENABLED !== 'true') return {enabled:false,created:0};
  await ensureFinalistsTables();
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const matches=(await c.query(`SELECT m.id,m.tournament_id,m.table_no,m.state
      FROM maf_tournament_qualification_matches m
      WHERE m.state->'game'->>'phase'='over'
      AND NOT EXISTS(SELECT 1 FROM maf_tournament_finalists f
        WHERE f.tournament_id=m.tournament_id AND f.table_no=m.table_no)
      ORDER BY m.id LIMIT 100 FOR UPDATE OF m SKIP LOCKED`)).rows;
    let created=0;
    for (const match of matches) if(await recordWinnerForMatch(c,match)) created++;
    await c.query('COMMIT');
    return {enabled:true,created};
  } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally {c.release();}
}
