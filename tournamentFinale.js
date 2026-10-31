import { isOwnerAccount } from './accountRoles.js';
import { realTournamentFeaturesEnabled } from './tournamentLaunchPolicy.js';
import { captureFinalCertification } from './tournamentFinalCertification.js';
import { finaleReference, tournamentReference } from './tournamentMatchReferences.js';
// Etape 7 : orchestration de la finale. Demonstration owner en lecture seule.
// Le jeu reel exige qualification activee et presence des 2 a 4 finalistes.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { createGame } from './engine.js';
import { tournamentSeats } from './tournamentDynamicBudget.js';
import { ensureQualificationTables } from './tournamentQualificationStart.js';
import { ensureFinalistsTables } from './tournamentFinalistStore.js';
import { finalistOverview, finalistFromMatch } from './tournamentFinalistRules.js';
import { FINAL_DELAY_MS, nextFinalSlot, finalePreview, createFinaleMatch } from './tournamentFinalScheduleRules.js';
import { privateMatchView } from './tournamentPrivateView.js';
import { finalAction } from './tournamentFinalGame.js';
import { initPresence, setPresence, expirePresence } from './monopolyPresence.js';
import { normalizeTurnClock, tickTurnClock } from './monopolyTurnClock.js';

export const tournamentFinaleRouter = Router();
export const finaleEnabled = () => realTournamentFeaturesEnabled();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const handler=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
const positiveId=x=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant invalide.');return n;};
const PING_MS = 60_000;
async function owner(req){if (!await isOwnerAccount(req.userId, pool))throw fail(403,'Reserve au proprietaire 999.');}
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
function validFinalists(matches, finalists, expectedCount){
  const overview=finalistOverview(matches,finalists);
  if(!overview.ready || matches.length!==expectedCount || finalists.length!==expectedCount ||
    matches.some(m=>m.state?.game?.phase!=='over')) return null;
  return finalists.map(f=>{
    const match=matches.find(m=>Number(m.table_no)===Number(f.table_no));
    const final=finalistFromMatch(match);
    if(!final || final.userId!==Number(f.user_id)||final.matchId!==Number(f.match_id))
      throw fail(409,'Finaliste incompatible avec le resultat de qualification.');
    return {table:final.table,userId:final.userId,name:final.name};
  });
}
function projectedStatus(t, matches, finalists, schedule, finalMatch, now, expectedCount){
  const count=finalists.length, complete=matches.length===expectedCount && matches.every(x=>x.state?.game?.phase==='over');
  const projection=finalePreview({finalAt:t.final_at,now,qualifiedCount:Math.min(4,count),
    qualificationsComplete:complete,started:!!finalMatch,expectedFinalists:expectedCount});
  return {
    tournamentId:Number(t.id),reference:finaleReference(t.id),tournamentReference:tournamentReference(t.id),title:t.title,plannedAt:new Date(t.final_at).toISOString(),
    nextAt:schedule ? (schedule.status==='started'?null:new Date(schedule.next_start_at).toISOString()):projection.nextAt,
    status:finalMatch?'started':schedule?.status==='pending'?'waiting':projection.status,
    expectedFinalists:expectedCount,
    startedAt:finalMatch?.started_at??null,qualifiedCount:count,
    qualificationsComplete:complete,finalists:finalists.map(f=>({table:Number(f.table_no)})),
    realFinaleEnabled:finaleEnabled(),presenceRequired:true,
    disclaimer:`Les ${expectedCount} finalistes doivent signaler leur presence avant un depart reel.`
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
    const active=(await c.query(`SELECT user_id FROM maf_tournament_entries
      WHERE tournament_id=$1 AND status='reserved' ORDER BY created_at,user_id FOR UPDATE`,[id])).rows;
    const expected=tournamentSeats(active.map(x=>Number(x.user_id))).groupSizes.length;
    if(expected<2 || matches.length!==expected){await c.query('COMMIT');return {skipped:true};}
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
    const ready=validFinalists(matches,finalists,expected);
    let present=false;
    if(ready){
      const p=(await c.query(`SELECT user_id FROM maf_tournament_final_presence
        WHERE tournament_id=$1 AND present_at >= $2::timestamptz
        ORDER BY user_id`,[id,new Date(time.getTime()-PING_MS).toISOString()])).rows;
      present=p.length===expected && ready.every(f=>p.some(x=>Number(x.user_id)===f.userId));
    }
    if(!ready||!present){
      const next=nextFinalSlot(t.final_at,time.getTime()+1);
      await c.query(`UPDATE maf_tournament_final_schedules
        SET next_start_at=$2,updated_at=now() WHERE tournament_id=$1`,[id,new Date(next).toISOString()]);
      await c.query('COMMIT');return {started:false,reason:!ready?'qualifications':'presence',nextAt:new Date(next).toISOString()};
    }
    const state=createFinaleMatch(ready,createGame);
    initPresence(state.game,state.seats.map(p=>p.userId),time.getTime());
    normalizeTurnClock(state.game,time.getTime());
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
      AND (SELECT count(*) FROM maf_tournament_qualification_matches m WHERE m.tournament_id=t.id) BETWEEN 2 AND 4
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
    qualifiedCount:b.qualifiedCount,qualificationsComplete:b.qualificationsComplete,
    expectedFinalists:b.expectedFinalists??4}),serverNow:Date.now()});
}));
tournamentFinaleRouter.get('/qualifications/finale/owner/:id',requireSession,handler(async(req,res)=>{
  await owner(req);await ensureFinaleTables();const id=positiveId(req.params.id);
  const t=(await pool.query('SELECT * FROM maf_tournaments WHERE id=$1',[id])).rows[0];
  if(!t)throw fail(404,'Tournoi introuvable.');
  const matches=(await pool.query('SELECT table_no,state FROM maf_tournament_qualification_matches WHERE tournament_id=$1 ORDER BY table_no',[id])).rows;
  const finalists=(await pool.query('SELECT table_no FROM maf_tournament_finalists WHERE tournament_id=$1 ORDER BY table_no',[id])).rows;
  const schedule=(await pool.query('SELECT * FROM maf_tournament_final_schedules WHERE tournament_id=$1',[id])).rows[0];
  const finalMatch=(await pool.query('SELECT started_at FROM maf_tournament_final_matches WHERE tournament_id=$1',[id])).rows[0];
  const active=(await pool.query(`SELECT user_id FROM maf_tournament_entries
    WHERE tournament_id=$1 AND status='reserved' ORDER BY created_at,user_id`,[id])).rows;
  const expected=tournamentSeats(active.map(x=>Number(x.user_id))).groupSizes.length || 4;
  res.json({...projectedStatus(t,matches,finalists,schedule,finalMatch,Date.now(),expected),serverNow:Date.now()});
}));
// Heartbeat reel ; route inaccessible lorsque le mode joueur n'est pas ouvert.
tournamentFinaleRouter.post('/qualifications/finale/:id/presence',requireSession,handler(async(req,res)=>{
  if(!finaleEnabled())throw fail(403,'Finale reelle non ouverte.');
  await ensureFinaleTables();const id=positiveId(req.params.id);
  const tournament=(await pool.query(`SELECT id FROM maf_tournaments WHERE id=$1 AND status='published'
    AND deleted_at IS NULL AND cancelled_at IS NULL`,[id])).rows[0];
  if(!tournament)throw fail(404,'Tournoi indisponible.');
  const member=(await pool.query('SELECT 1 FROM maf_tournament_finalists WHERE tournament_id=$1 AND user_id=$2',[id,req.userId])).rows[0];
  if(!member)throw fail(403,'Tu ne fais pas partie des finalistes.');
  if(!['here','away'].includes(req.body?.state))throw fail(400,'Presence invalide.');
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    // Verrou du match : la presence et le tour ne se remplacent pas mutuellement.
    const live=(await c.query('SELECT * FROM maf_tournament_final_matches WHERE tournament_id=$1 FOR UPDATE',[id])).rows[0];
    if(live){
      const state=structuredClone(live.state);
      if(setPresence(state.game,state.seats.map(p=>({id:p.userId})),req.userId,req.body.state)){
        await c.query(`UPDATE maf_tournament_final_matches SET state=$2::jsonb
          WHERE tournament_id=$1`,[id,JSON.stringify(state)]);
      }
    }else if(req.body.state==='here'){
      await c.query(`INSERT INTO maf_tournament_final_presence(tournament_id,user_id,present_at)
        VALUES($1,$2,now()) ON CONFLICT(tournament_id,user_id) DO UPDATE SET present_at=now()`,[id,req.userId]);
    }
    await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));

// Salon unique: aucun non-finaliste n'a acces a la finale (ni a ses pseudos).
// L'espace final est deja reserve en base, mais reste invisible avant la certification.
tournamentFinaleRouter.get('/qualifications/finale/mine',requireSession,handler(async(req,res)=>{
  if(!realTournamentFeaturesEnabled())return res.json({finale:null,enabled:false,serverNow:Date.now()});
  await ensureFinaleTables();
  const rows=(await pool.query(`SELECT t.id,t.title,t.final_at,f.table_no,sc.next_start_at,sc.status AS schedule_status
    FROM maf_tournament_finalists f
    JOIN maf_tournaments t ON t.id=f.tournament_id
    LEFT JOIN maf_tournament_final_schedules sc ON sc.tournament_id=t.id
    WHERE f.user_id=$1 AND t.status='published' AND t.deleted_at IS NULL AND t.cancelled_at IS NULL
    ORDER BY t.starts_at DESC LIMIT 1`,[req.userId])).rows;
  const row=rows[0];
  if(!row)return res.json({finale:null,enabled:true,serverNow:Date.now()});
  const roster=(await pool.query(`SELECT f.table_no,u.pseudo FROM maf_tournament_finalists f
    JOIN maf_users u ON u.id=f.user_id WHERE f.tournament_id=$1 ORDER BY f.table_no`,[row.id])).rows;
  const expectedRows=(await pool.query(`SELECT count(*)::int AS count FROM maf_tournament_qualification_matches
    WHERE tournament_id=$1`,[row.id])).rows;
  const live=(await pool.query(`SELECT state,revision,started_at FROM maf_tournament_final_matches WHERE tournament_id=$1`,[row.id])).rows[0];
  res.json({finale:{tournamentId:Number(row.id),reference:finaleReference(row.id),tournamentReference:tournamentReference(row.id),title:row.title,qualified:true,
    plannedAt:new Date(row.final_at).toISOString(),nextAt:live?null:new Date(row.next_start_at||row.final_at).toISOString(),
    status:live?(live.state.game.phase==='over'?'finished':'playing'):'waiting',
    finalistCount:roster.length,expectedFinalists:Number(expectedRows[0].count),
    finalists:roster.map(p=>({table:Number(p.table_no),name:p.pseudo})),
    revision:live?.revision||null,state:live?privateMatchView(live.state,req.userId):null,
    enabled:finaleEnabled()},enabled:true,serverNow:Date.now()});
}));

// Controle de chaque mouvement par le serveur, avec version optimiste et ID de session.
tournamentFinaleRouter.post('/qualifications/finale/:id/action',requireSession,handler(async(req,res)=>{
  if(!finaleEnabled())throw fail(403,'La finale est desactivee.');
  await ensureFinaleTables();const id=positiveId(req.params.id),revision=req.body?.revision;
  if(!Number.isSafeInteger(revision)||revision<1)throw fail(400,'Version de partie requise.');
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const row=(await c.query('SELECT * FROM maf_tournament_final_matches WHERE tournament_id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw fail(404,'Finale non commencee.');
    if(!row.state.seats.some(s=>Number(s.userId)===req.userId))throw fail(403,'Finale privee.');
    if(row.revision!==revision)throw fail(409,'La finale a change : recharge.');
    if(row.state.game.presence?.away?.[String(req.userId)]!==undefined)throw fail(409,'Reviens sur le plateau avant de jouer.');
    const next=finalAction(row.state,{userId:req.userId,action:req.body?.action,square:req.body?.square});
    normalizeTurnClock(next.game);
    const result=await c.query(`UPDATE maf_tournament_final_matches
      SET state=$2::jsonb,revision=revision+1 WHERE tournament_id=$1 RETURNING revision`,[id,JSON.stringify(next)]);
    await c.query('COMMIT');res.json({state:privateMatchView(next,req.userId),revision:result.rows[0].revision});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});
    if(!e.status && (e.message.includes('finale')||e.message.includes('tour')||e.message.includes('Action')||e.message.includes('phase')))throw fail(409,'Action impossible pour ce tour.');
    throw e;
  }finally{c.release();}
}));

// Maintenance autonome de la finale, meme navigateur ferme.
let tickingFinales;
export function maintainFinaleMatches(){
  if(tickingFinales)return tickingFinales;
  tickingFinales=(async()=>{
    if(!finaleEnabled())return {enabled:false};
    await ensureFinaleTables();
    const {rows}=await pool.query(`SELECT tournament_id FROM maf_tournament_final_matches
      WHERE state->'game'->>'phase'<>'over' ORDER BY tournament_id DESC LIMIT 100`);
    let changed=0;
    for(const {tournament_id:id} of rows){
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        const row=(await c.query('SELECT * FROM maf_tournament_final_matches WHERE tournament_id=$1 FOR UPDATE',[id])).rows[0];
        if(!row||row.state.game.phase==='over'){await c.query('COMMIT');continue;}
        const state=structuredClone(row.state),now=Date.now();
        const members=state.seats.map(s=>({id:s.userId}));
        const presence=expirePresence(state.game,members,now);
        const turn=tickTurnClock(presence.game,{now,autoEnd:true});
        if(presence.changed||turn.changed){
          const certified=captureFinalCertification(state,turn.game);
          state.game=certified.game;
          state.eliminationOrder=certified.eliminationOrder;
          if(certified.certification)state.certification=certified.certification;
          await c.query(`UPDATE maf_tournament_final_matches SET state=$2::jsonb,revision=revision+1
            WHERE tournament_id=$1`,[id,JSON.stringify(state)]);
          changed++;
        }
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
    }
    return {enabled:true,changed};
  })().finally(()=>{tickingFinales=null;});return tickingFinales;
}
