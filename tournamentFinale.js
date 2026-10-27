// Etape 7 : orchestration de la finale. Demonstration owner en lecture seule.
// Le jeu reel exige qualification activee ET verification de presence des 4 joueurs.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { createGame } from './engine.js';
import { ensureQualificationTables } from './tournamentQualificationStart.js';
import { ensureFinalistsTables } from './tournamentFinalistStore.js';
import { finalistOverview, finalistFromMatch } from './tournamentFinalistRules.js';
import { FINAL_DELAY_MS, nextFinalSlot, finalePreview, createFinaleMatch } from './tournamentFinalScheduleRules.js';

export const tournamentFinaleRouter = Router();
export const finaleEnabled = () => process.env.MAF_TOURNAMENT_REAL_START_ENABLED === 'true' &&
  process.env.MAF_TOURNAMENT_FINAL_START_ENABLED === 'true';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const handler=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
const positiveId=x=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant invalide.');return n;};
const PING_MS = 60_000;
async function owner(req){const {rows}=await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[req.userId]);
  if(rows[0]?.pseudo_key!=='999')throw fail(403,'Reserve au proprietaire 999.');}
let initialized;
export function ensureFinaleTables(){
  if(!initialized)initialized=(async()=>{
    await ensureQualificationTables();await ensureFinalistsTables();
    const c=await pool.connect();
    try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(62498467)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_final_schedules (
        tournament_id integer PRIMARY KEY REFERENCES maf_tournaments(id),
        planned_at timestamptz NOT NULL, next_start_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','started')),
        updated_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_final_matches (
        tournament_id integer PRIMARY KEY REFERENCES maf_tournaments(id),
        state jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
        started_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_final_presence (
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        present_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tournament_id,user_id)
      )`);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{initialized=null;throw e;});
  return initialized;
}
function validFinalists(matches, finalists){
  const overview=finalistOverview(matches,finalists);
  if(!overview.ready || matches.length!==4 || finalists.length!==4 ||
    matches.some(m=>m.state?.game?.phase!=='over')) return null;
  return finalists.map(f=>{
    const match=matches.find(m=>Number(m.table_no)===Number(f.table_no));
    const final=finalistFromMatch(match);
    if(!final || final.userId!==Number(f.user_id)||final.matchId!==Number(f.match_id))
      throw fail(409,'Finaliste incompatible avec le resultat de qualification.');
    return {table:final.table,userId:final.userId,name:final.name};
  });
}
function projectedStatus(t, matches, finalists, schedule, finalMatch, now){
  const count=finalists.length, complete=matches.length===4 && matches.every(x=>x.state?.game?.phase==='over');
  const projection=finalePreview({finalAt:t.final_at,now,qualifiedCount:Math.min(4,count),
    qualificationsComplete:complete,started:!!finalMatch});
  return {
    tournamentId:Number(t.id),title:t.title,plannedAt:new Date(t.final_at).toISOString(),
    nextAt:schedule ? (schedule.status==='started'?null:new Date(schedule.next_start_at).toISOString()):projection.nextAt,
    status:finalMatch?'started':schedule?.status==='pending'?'waiting':projection.status,
    startedAt:finalMatch?.started_at??null,qualifiedCount:count,
    qualificationsComplete:complete,finalists:finalists.map(f=>({table:Number(f.table_no)})),
    realFinaleEnabled:finaleEnabled(),presenceRequired:true,
    disclaimer:'Les quatre finalistes doivent signaler leur presence avant un depart reel.'
  };
}
export async function startFinaleIfDue(tournamentId, now = new Date()) {
  if(!finaleEnabled())return {enabled:false};
  await ensureFinaleTables();
  const id=positiveId(tournamentId), time=new Date(now);
  if(!Number.isFinite(time.getTime()))throw new Error('Date serveur invalide.');
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const t=(await c.query('SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!t||t.status!=='published'||t.deleted_at||t.cancelled_at){await c.query('COMMIT');return {skipped:true};}
    // Ne pas creer de finale sans qualifications; ne pas toucher aux brouillons.
    const matches=(await c.query(`SELECT m.id,m.tournament_id,m.table_no,m.state
      FROM maf_tournament_qualification_matches m WHERE tournament_id=$1 ORDER BY table_no FOR UPDATE`,[id])).rows;
    if(matches.length!==4){await c.query('COMMIT');return {skipped:true};}
    await c.query(`INSERT INTO maf_tournament_final_schedules(tournament_id,planned_at,next_start_at)
      VALUES($1,$2,$2) ON CONFLICT(tournament_id) DO NOTHING`,[id,t.final_at]);
    const schedule=(await c.query(`SELECT * FROM maf_tournament_final_schedules
      WHERE tournament_id=$1 FOR UPDATE`,[id])).rows[0];
    if(new Date(schedule.planned_at).getTime()!==new Date(t.final_at).getTime())
      throw fail(409,'Date finale modifiee apres la creation des plateaux. Intervention necessaire.');
    const existing=(await c.query('SELECT started_at FROM maf_tournament_final_matches WHERE tournament_id=$1',[id])).rows[0];
    if(existing){await c.query('COMMIT');return {started:false,alreadyStarted:true};}
    if(time.getTime() < new Date(schedule.next_start_at).getTime()){
      await c.query('COMMIT');return {started:false,nextAt:schedule.next_start_at};
    }
    const finalists=(await c.query(`SELECT table_no,user_id,match_id
      FROM maf_tournament_finalists WHERE tournament_id=$1 ORDER BY table_no`,[id])).rows;
    const ready=validFinalists(matches,finalists);
    let present=false;
    if(ready){
      const p=(await c.query(`SELECT user_id FROM maf_tournament_final_presence
        WHERE tournament_id=$1 AND present_at >= $2::timestamptz
        ORDER BY user_id`,[id,new Date(time.getTime()-PING_MS).toISOString()])).rows;
      present=p.length===4 && ready.every(f=>p.some(x=>Number(x.user_id)===f.userId));
    }
    if(!ready||!present){
      const next=nextFinalSlot(t.final_at,time.getTime()+1);
      await c.query(`UPDATE maf_tournament_final_schedules
        SET next_start_at=$2,updated_at=now() WHERE tournament_id=$1`,[id,new Date(next).toISOString()]);
      await c.query('COMMIT');return {started:false,reason:!ready?'qualifications':'presence',nextAt:new Date(next).toISOString()};
    }
    const state=createFinaleMatch(ready,createGame);
    await c.query(`INSERT INTO maf_tournament_final_matches(tournament_id,state) VALUES($1,$2::jsonb)`,[id,JSON.stringify(state)]);
    await c.query(`UPDATE maf_tournament_final_schedules SET status='started',started_at=$2,updated_at=now()
      WHERE tournament_id=$1`,[id,time.toISOString()]);
    await c.query('COMMIT');return {started:true,tournamentId:id};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
let maintenance;
export function maintainFinaleStarts(){
  if(maintenance)return maintenance;
  maintenance=(async()=>{
    if(!finaleEnabled())return {enabled:false,started:0};
    await ensureFinaleTables();
    const {rows}=await pool.query(`SELECT t.id FROM maf_tournaments t
      WHERE t.status='published' AND t.deleted_at IS NULL AND t.cancelled_at IS NULL
      AND t.final_at <= now()
      AND (SELECT count(*) FROM maf_tournament_qualification_matches m WHERE m.tournament_id=t.id)=4
      AND NOT EXISTS(SELECT 1 FROM maf_tournament_final_matches f WHERE f.tournament_id=t.id)
      ORDER BY t.final_at,t.id LIMIT 100`);
    let started=0;
    for(const row of rows) if((await startFinaleIfDue(Number(row.id))).started)started++;
    return {enabled:true,started};
  })().finally(()=>{maintenance=null;});return maintenance;
}
tournamentFinaleRouter.use((_,res,next)=>{res.set('Cache-Control','private, no-store');next();});
tournamentFinaleRouter.post('/qualifications/finale/owner/preview',requireSession,handler(async(req,res)=>{
  await owner(req);const b=req.body||{};
  if(typeof b.finalAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(b.finalAt)||
    !Number.isSafeInteger(b.now)||typeof b.qualificationsComplete!=='boolean')throw fail(400,'Parametres de demo invalides.');
  res.json({type:'demo',...finalePreview({finalAt:b.finalAt,now:b.now,
    qualifiedCount:b.qualifiedCount,qualificationsComplete:b.qualificationsComplete}),serverNow:Date.now()});
}));
tournamentFinaleRouter.get('/qualifications/finale/owner/:id',requireSession,handler(async(req,res)=>{
  await owner(req);await ensureFinaleTables();const id=positiveId(req.params.id);
  const t=(await pool.query('SELECT * FROM maf_tournaments WHERE id=$1',[id])).rows[0];
  if(!t)throw fail(404,'Tournoi introuvable.');
  const matches=(await pool.query('SELECT table_no,state FROM maf_tournament_qualification_matches WHERE tournament_id=$1 ORDER BY table_no',[id])).rows;
  const finalists=(await pool.query('SELECT table_no FROM maf_tournament_finalists WHERE tournament_id=$1 ORDER BY table_no',[id])).rows;
  const schedule=(await pool.query('SELECT * FROM maf_tournament_final_schedules WHERE tournament_id=$1',[id])).rows[0];
  const finalMatch=(await pool.query('SELECT started_at FROM maf_tournament_final_matches WHERE tournament_id=$1',[id])).rows[0];
  res.json({...projectedStatus(t,matches,finalists,schedule,finalMatch,Date.now()),serverNow:Date.now()});
}));
// Heartbeat reel ; route inaccessible lorsque le mode joueur n'est pas ouvert.
tournamentFinaleRouter.post('/qualifications/finale/:id/presence',requireSession,handler(async(req,res)=>{
  if(!finaleEnabled())throw fail(403,'Finale reelle non ouverte.');
  await ensureFinaleTables();const id=positiveId(req.params.id);
  const tournament=(await pool.query(`SELECT id FROM maf_tournaments WHERE id=$1 AND status='published'
    AND deleted_at IS NULL AND cancelled_at IS NULL`,[id])).rows[0];
  if(!tournament)throw fail(404,'Tournoi indisponible.');
  const member=(await pool.query('SELECT 1 FROM maf_tournament_finalists WHERE tournament_id=$1 AND user_id=$2',[id,req.userId])).rows[0];
  if(!member)throw fail(403,'Tu ne fais pas partie des quatre finalistes.');
  await pool.query(`INSERT INTO maf_tournament_final_presence(tournament_id,user_id,present_at)
    VALUES($1,$2,now()) ON CONFLICT(tournament_id,user_id) DO UPDATE SET present_at=now()`,[id,req.userId]);
  res.json({ok:true});
}));
