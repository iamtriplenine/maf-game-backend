// Matchs Tir-au-but des tournois : chaque action est validee et historisee en base.
// Aucun debit / credit du portefeuille ici : la mise est prelevee a l'inscription.
import {Router} from 'express';
import {pool} from './db.js';
import {requireSession} from './auth.js';
import {beginPenaltyDuel,choosePenaltyDuel,abandonPenaltyDuel,visiblePenaltyDuel} from './penaltyTournamentMatchRules.js';
import {ensurePenaltyDrawTables} from './tournamentPenaltyDraw.js';
import {penaltyDuelReference} from './penaltyTournamentDraw.js';
import {realTournamentFeaturesEnabled} from './tournamentLaunchPolicy.js';
import {penaltyAbsenceDecision,penaltyIdleDecision} from './penaltyTournamentProgressRules.js';

export const tournamentPenaltyMatchRouter=Router();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
const validId=value=>{if(!/^[1-9]\d{0,15}$/.test(String(value)))throw fail(400,'Identifiant de duel invalide.');return String(value);};
let ready;
export function ensurePenaltyMatchState(){
  if(!ready)ready=(async()=>{
    await ensurePenaltyDrawTables();
    // Migration idempotente, partagee par tous les serveurs.
    await pool.query(`ALTER TABLE maf_tournament_penalty_matches
      ADD COLUMN IF NOT EXISTS match_state jsonb,
      ADD COLUMN IF NOT EXISTS host_seen_at timestamptz,
      ADD COLUMN IF NOT EXISTS guest_seen_at timestamptz,
      ADD COLUMN IF NOT EXISTS host_joined_at timestamptz,
      ADD COLUMN IF NOT EXISTS guest_joined_at timestamptz,
      ADD COLUMN IF NOT EXISTS playing_at timestamptz,
      ADD COLUMN IF NOT EXISTS attention_reason text`);
  })().catch(e=>{ready=null;throw e;});
  return ready;
}
const SELECT=`SELECT m.*,t.title,t.game,t.penalty_shots,t.entry_fee,t.status AS tournament_status,
 t.deleted_at,t.cancelled_at,uh.pseudo AS host_name,ug.pseudo AS guest_name
 FROM maf_tournament_penalty_matches m JOIN maf_tournaments t ON t.id=m.tournament_id
 JOIN maf_users uh ON uh.id=m.host_id JOIN maf_users ug ON ug.id=m.guest_id`;
const side=(r,uid)=>Number(uid)===Number(r.host_id)?'host':Number(uid)===Number(r.guest_id)?'guest':null;
function view(r,uid){
  const viewer=side(r,uid);
  if(!viewer)throw fail(404,'Ce salon est indisponible.');
  const match=visiblePenaltyDuel(r.match_state,viewer);
  const now=Date.now();
  const fresh=x=>x && now-new Date(x).getTime()<=45000;
  const bothHere=fresh(r.host_seen_at)&&fresh(r.guest_seen_at);
  const opponentSeen=viewer==='host'?r.guest_seen_at:r.host_seen_at;
  if(match && r.status==='playing' && !fresh(opponentSeen)){
    const from=opponentSeen ? new Date(opponentSeen).getTime() : (r.playing_at?new Date(r.playing_at).getTime():now);
    match.opponentReturnDeadline=from+120000;
  }
  return {room:{id:String(r.id),code:penaltyDuelReference(Number(r.tournament_id),Number(r.round_no),Number(r.match_no),r.id),
    reference:penaltyDuelReference(Number(r.tournament_id),Number(r.round_no),Number(r.match_no),r.id),
    tournamentTitle:r.title,game:'penalty',shots:Number(r.penalty_shots),
    stake:Number(r.entry_fee),escrow:0,payout:0,status:r.status==='scheduled'||r.status==='waiting'?'ready':r.status,
    is_host:viewer==='host',is_guest:viewer==='guest',
    canStart:Date.parse(r.scheduled_at)<=now && bothHere,
    waitingForOpponent:!bothHere,attentionReason:r.attention_reason||null,
    host:{pseudo:r.host_name},guest:{pseudo:r.guest_name}},match,
    scheduledAt:r.scheduled_at,serverNow:now};
}
async function load(db,id,uid,lock=false){
  const {rows}=await db.query(`${SELECT} WHERE m.id=$1${lock?' FOR UPDATE OF m':''}`,[id]);
  const row=rows[0];
  if(!row||row.game!=='penalty'||row.tournament_status!=='published'||row.cancelled_at||row.deleted_at||!side(row,uid))
    throw fail(404,'Ce salon est indisponible.');
  return row;
}
async function mutate(req,res,fn){
  if(!realTournamentFeaturesEnabled())throw fail(503,'Match temporairement indisponible.');
  await ensurePenaltyMatchState();
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const row=await load(c,validId(req.params.id),req.userId,true);
    const next=await fn(row);
    if(next){
      await c.query(`UPDATE maf_tournament_penalty_matches SET status=$2,match_state=$3::jsonb,
        winner_id=$4,playing_at=$5,host_seen_at=$6,guest_seen_at=$7,
        host_joined_at=$8,guest_joined_at=$9,revision=revision+1 WHERE id=$1`,[
          row.id,row.status,JSON.stringify(row.match_state),row.winner_id,row.playing_at,
          row.host_seen_at,row.guest_seen_at,row.host_joined_at,row.guest_joined_at]);
    }
    await c.query('COMMIT');
    res.set('Cache-Control','no-store').json(view(row,req.userId));
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
tournamentPenaltyMatchRouter.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
tournamentPenaltyMatchRouter.get('/penalty/matches/:id',requireSession,route(async(req,res)=>{
  if(!realTournamentFeaturesEnabled())throw fail(503,'Match temporairement indisponible.');
  await ensurePenaltyMatchState();
  const row=await load(pool,validId(req.params.id),req.userId);
  res.json(view(row,req.userId));
}));
// Seule une entree reelle dans SON salon actualise la presence, pas la liste publique.
tournamentPenaltyMatchRouter.post('/penalty/matches/:id/presence',requireSession,route(async(req,res)=>mutate(req,res,r=>{
  if(r.status==='finished'||r.status==='attention')return false;
  const now=Date.now();
  if(Date.parse(r.scheduled_at)>now+300000)throw fail(409,'Salon pas encore ouvert.');
  if(['scheduled','waiting'].includes(r.status) && now-Date.parse(r.scheduled_at)>=300000)
    throw fail(409,'Delai d arrivee depasse : resultat en verification.');
  if(r.status==='playing'){
    const seen=side(r,req.userId)==='host'?r.host_seen_at:r.guest_seen_at;
    const since=seen?Date.parse(seen):(r.playing_at?Date.parse(r.playing_at):now);
    if(now-since>=120000)throw fail(409,'Delai de reconnexion depasse : resultat en verification.');
  }
  const viewer=side(r,req.userId),field=viewer+'_seen_at',joined=viewer+'_joined_at';
  r[field]=new Date(now);
  if(!r[joined])r[joined]=new Date(now);
  if(r.status==='scheduled'&&now>=Date.parse(r.scheduled_at))r.status='waiting';
  const recent=x=>x && now-Date.parse(x)<=45000;
  if(['scheduled','waiting'].includes(r.status) && now>=Date.parse(r.scheduled_at) &&
     recent(r.host_seen_at)&&recent(r.guest_seen_at)){
    r.match_state=beginPenaltyDuel(Number(r.penalty_shots));
    r.status='playing';r.playing_at=new Date(now);
  }
  return true;
})));
tournamentPenaltyMatchRouter.post('/penalty/matches/:id/start',requireSession,route(async(req,res)=>mutate(req,res,(r)=>{
  if(r.status==='playing'||r.status==='finished')return false; // retry sans double creation
  if(!['scheduled','waiting'].includes(r.status))throw fail(409,'Match non disponible.');
  if(Date.parse(r.scheduled_at)>Date.now())throw fail(409,'Le match n a pas encore commence.');
  const fresh=x=>x && Date.now()-Date.parse(x)<=45000;
  if(!fresh(r.host_seen_at)||!fresh(r.guest_seen_at))throw fail(409,'Attends que les deux joueurs soient presents.');
  if(![3,5,10].includes(Number(r.penalty_shots)))throw fail(409,'Regles des tirs invalides.');
  r.match_state=beginPenaltyDuel(Number(r.penalty_shots));
  r.status='playing';r.playing_at=new Date();
  return true;
})));
tournamentPenaltyMatchRouter.post('/penalty/matches/:id/choose',requireSession,route(async(req,res)=>{
  const direction=req.body?.direction;
  if(!['left','center','right'].includes(direction))throw fail(400,'Direction invalide.');
  return mutate(req,res,r=>{
    if(r.status!=='playing'||!r.match_state||r.match_state.finished)throw fail(409,'Le match n est pas en cours.');
    const viewer=side(r,req.userId),s=r.match_state;
    if(penaltyIdleDecision(r)?.winner===(viewer==='host'?'guest':'host'))throw fail(409,'Temps ecoule : tu es disqualifie.');
    try{choosePenaltyDuel(s,viewer,direction);}catch(e){throw fail(409,e.message);}
    r[viewer+'_seen_at']=new Date();
    if(s.finished){
      if(!['host','guest'].includes(s.winner))throw fail(409,'Resultat non certifiable.');
      r.winner_id=s.winner==='host'?r.host_id:r.guest_id;
      r.status='finished';
    }
    return true;
  });
}));
tournamentPenaltyMatchRouter.post('/penalty/matches/:id/forfeit',requireSession,route(async(req,res)=>mutate(req,res,r=>{
  if(r.status!=='playing'||!r.match_state||r.match_state.finished)throw fail(409,'Match non abandonnable.');
  const viewer=side(r,req.userId),s=r.match_state;
  try{abandonPenaltyDuel(s,viewer);}catch(e){throw fail(409,e.message);}
  r[viewer+'_seen_at']=new Date();
  r.winner_id=s.winner==='host'?r.host_id:r.guest_id;
  r.status='finished';
  return true;
})));
