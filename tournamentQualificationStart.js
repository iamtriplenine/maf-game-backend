// Etape 5 : tirage persistant et creation atomique des quatre plateaux.
// IMPORTANT : le lancement REEL est volontairement desactive tant que le
// parcours joueur des qualifications n'a pas ete valide.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureTournamentCancellation } from './tournamentCancellation.js';
import { createQualificationGame, playQualificationAction } from './tournamentQualificationGame.js';
import { qualificationDraw, REQUIRED_PLAYERS } from './tournamentDraw.js';
import { ensureFinalistsTables, recordWinnerForMatch } from './tournamentFinalistStore.js';

export const tournamentQualificationRouter = Router();
export const realQualificationEnabled = () => process.env.MAF_TOURNAMENT_REAL_START_ENABLED === 'true';
const fail = (status, message) => Object.assign(new Error(message), { status });
const route = fn => async (req,res,next)=>{try{await fn(req,res);}catch(e){
  if(e.status)return res.status(e.status).json({error:e.message});next(e);
}};
const numericId = value => {const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant invalide.');return n;};
// Ne jamais exposer l'ordre des cartes restants (decks), ni les identifiants internes des adversaires.
function playerView(match, userId) {
  const { decks: _decks, ...game } = match.game;
  return {format:match.format,game,seats:match.seats.map(p=>({seat:p.seat,name:p.name,isYou:p.userId===userId}))};
}
async function checkOwner(req) {
  const result=await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[req.userId]);
  if(result.rows[0]?.pseudo_key!=='999') throw fail(403,'Reserve au compte proprietaire 999.');
}
let installed;
export function ensureQualificationTables(){
  if(!installed)installed=(async()=>{
    await ensureTournamentCancellation();
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498465)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_qualification_matches (
        id bigserial PRIMARY KEY,
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        table_no integer NOT NULL CHECK (table_no BETWEEN 1 AND 4),
        state jsonb NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        started_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(tournament_id,table_no)
      )`);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{installed=null;throw e;});
  return installed;
}

// Ne jamais utiliser une route GET ou le navigateur comme minuterie principale.
// La tache d'entretien rattrape aussi un redemarrage du serveur.
export async function startDueQualifications() {
  if(!realQualificationEnabled())return {enabled:false,started:0};
  await ensureQualificationTables();
  const {rows}=await pool.query(`SELECT id FROM maf_tournaments
    WHERE status='published' AND deleted_at IS NULL AND cancelled_at IS NULL AND starts_at<=now()
    ORDER BY starts_at,id LIMIT 100`);
  let started=0;
  for(const row of rows){if(await startQualificationTournament(Number(row.id)))started++;}
  return {enabled:true,started};
}
export async function startQualificationTournament(id){
  if(!realQualificationEnabled())throw fail(403,'Le demarrage reel est desactive.');
  await ensureQualificationTables();
  id=numericId(id);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const tournament=(await c.query('SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!tournament||tournament.status!=='published'||tournament.deleted_at||tournament.cancelled_at||
       new Date(tournament.starts_at).getTime()>Date.now()){
      await c.query('COMMIT');return false;
    }
    const existing=(await c.query('SELECT table_no FROM maf_tournament_qualification_matches WHERE tournament_id=$1 ORDER BY table_no',[id])).rows;
    if(existing.length){
      if(existing.length!==4||existing.some((p,i)=>p.table_no!==i+1))throw fail(409,'Etat partiel des qualifications : intervention necessaire.');
      await c.query('COMMIT');return false;
    }
    const rows=(await c.query(`SELECT e.user_id, u.pseudo FROM maf_tournament_entries e
      JOIN maf_users u ON u.id=e.user_id WHERE e.tournament_id=$1 AND e.status='reserved'
      ORDER BY e.user_id FOR UPDATE OF e`,[id])).rows;
    // Etape 3 gere deja l'annulation/remboursement des tournois incomplets.
    if(rows.length!==REQUIRED_PLAYERS||Number(tournament.capacity)!==REQUIRED_PLAYERS){
      await c.query('COMMIT');return false;
    }
    const groups=qualificationDraw(rows.map(r=>({userId:Number(r.user_id),name:r.pseudo})));
    for(const group of groups){
      const game=createQualificationGame(group.players);
      await c.query(`INSERT INTO maf_tournament_qualification_matches (tournament_id,table_no,state)
        VALUES($1,$2,$3::jsonb)`,[id,group.table,JSON.stringify(game)]);
    }
    await c.query('COMMIT');return true;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally{c.release();}
}

let checking;
export function maintainQualificationStarts(){
  if(checking)return checking;
  checking=startDueQualifications().finally(()=>{checking=null;});return checking;
}
const demoParticipants=()=>Array.from({length:20},(_,i)=>({userId:i+1,name:`Joueur test ${i+1}`}));
tournamentQualificationRouter.use((_,res,next)=>{res.set('Cache-Control','no-store');next();});
tournamentQualificationRouter.post('/qualifications/owner/preview',requireSession,route(async(req,res)=>{
  await checkOwner(req);await ensureQualificationTables();
  // Jamais de vrais inscrits, jamais d'insertion ni de changement de solde.
  res.json({type:'demo',groups:qualificationDraw(demoParticipants()),serverNow:Date.now(),realStartEnabled:realQualificationEnabled()});
}));
tournamentQualificationRouter.get('/qualifications/owner/:id',requireSession,route(async(req,res)=>{
  await checkOwner(req);await ensureQualificationTables();
  const tournamentId=numericId(req.params.id);
  const result=await pool.query(`SELECT table_no,revision,started_at,state FROM maf_tournament_qualification_matches
    WHERE tournament_id=$1 ORDER BY table_no`,[tournamentId]);
  res.json({tournamentId,groups:result.rows.map(r=>({table:r.table_no,revision:r.revision,
    startedAt:r.started_at,players:r.state.seats.map(p=>({name:p.name,seat:p.seat,userId:p.userId}))})),
    realStartEnabled:realQualificationEnabled()});
}));
// Les routes joueur restent inactives tant que le test proprietaire est seul publie.
tournamentQualificationRouter.get('/qualifications/mine',requireSession,route(async(req,res)=>{
  if(!realQualificationEnabled())throw fail(403,'Qualifications non ouvertes.');
  await ensureQualificationTables();
  const rows=(await pool.query(`SELECT q.id,q.tournament_id,q.table_no,q.state,q.revision FROM maf_tournament_qualification_matches q
    WHERE q.state @> $1::jsonb ORDER BY q.started_at DESC LIMIT 1`,
    [JSON.stringify({seats:[{userId:req.userId}]})])).rows;
  const found=rows[0];
  res.json({match:found?{id:found.id,tournamentId:found.tournament_id,table:found.table_no,
    revision:found.revision,state:playerView(found.state,req.userId)}:null});
}));
tournamentQualificationRouter.post('/qualifications/:id/action',requireSession,route(async(req,res)=>{
  if(!realQualificationEnabled())throw fail(403,'Qualifications non ouvertes.');
  await ensureQualificationTables();
  await ensureFinalistsTables();
  const id=numericId(req.params.id), expectedRevision=req.body?.revision;
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw fail(400,'Version de partie requise.');
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const row=(await c.query('SELECT * FROM maf_tournament_qualification_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw fail(404,'Plateau introuvable.');
    if(row.revision!==expectedRevision)throw fail(409,'Cette action a deja ete remplacee. Recharge le plateau.');
    const next=playQualificationAction(row.state,{userId:req.userId,action:req.body?.action,square:req.body?.square});
    const result=await c.query(`UPDATE maf_tournament_qualification_matches SET state=$2::jsonb,revision=revision+1,updated_at=now()
      WHERE id=$1 RETURNING revision`,[id,JSON.stringify(next)]);
    await recordWinnerForMatch(c,{...row,state:next});
    await c.query('COMMIT');res.json({state:playerView(next,req.userId),revision:result.rows[0].revision});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});
    if(e.message?.includes('Ce joueur')||e.message?.includes('qualification')||e.message?.includes('Action')||
       e.message?.includes('phase')||e.message?.includes('terminee'))throw fail(409,'Action impossible pour ce plateau ou ce tour.');
    throw e;
  }finally{c.release();}
}));
