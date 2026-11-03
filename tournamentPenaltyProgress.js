// Qualifications, exemptions et champion des tournois Tir-au-but.
// Un seul verrou PostgreSQL sur le tournoi empeche tout tour cree deux fois.
import {Router} from 'express';
import {pool} from './db.js';
import {requireSession} from './auth.js';
import {isOwnerAccount} from './accountRoles.js';
import {ensurePenaltyMatchState} from './tournamentPenaltyMatch.js';
import {beginPenaltyDuel} from './penaltyTournamentMatchRules.js';
import {buildNextPenaltyRound,penaltyAbsenceDecision,penaltyDoubleForfeitReplays} from './penaltyTournamentProgressRules.js';
import {realTournamentFeaturesEnabled} from './tournamentLaunchPolicy.js';

export const tournamentPenaltyProgressRouter=Router();
let ready,processing;
export function ensurePenaltyProgressTables(){
  if(!ready)ready=(async()=>{
    await ensurePenaltyMatchState();
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498468)');
      await c.query(`ALTER TABLE maf_tournament_penalty_matches
        ADD COLUMN IF NOT EXISTS host_seen_at timestamptz,
        ADD COLUMN IF NOT EXISTS guest_seen_at timestamptz,
        ADD COLUMN IF NOT EXISTS host_joined_at timestamptz,
        ADD COLUMN IF NOT EXISTS guest_joined_at timestamptz,
        ADD COLUMN IF NOT EXISTS playing_at timestamptz,
        ADD COLUMN IF NOT EXISTS attention_reason text`);
      // Les matchs deja en cours avant cette mise a jour ont une nouvelle marge de reconnexion.
      await c.query(`UPDATE maf_tournament_penalty_matches SET playing_at=now()
        WHERE status='playing' AND playing_at IS NULL`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_penalty_byes (
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        round_no integer NOT NULL CHECK(round_no>=2),
        user_id integer NOT NULL REFERENCES maf_users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tournament_id,round_no)
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_penalty_champions (
        tournament_id integer PRIMARY KEY REFERENCES maf_tournaments(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        completed_at timestamptz NOT NULL DEFAULT now(),
        awarded_at timestamptz
      )`);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{ready=null;throw e;});
  return ready;
}
const idNumber=x=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<1)throw Object.assign(new Error('Identifiant invalide.'),{status:400});return n;};
const audit=async(c,event,details)=>c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
  VALUES('system:tournament',$1,$2::jsonb)`,[event,JSON.stringify(details)]);
// Exige une victoire certifiee, jamais une valeur envoye par un client.
function certified(m){
  if(m.status==='finished'&&!m.winner_id&&m.match_state?.doubleForfeit===true)return true; // deux disqualifies
  if(m.status!=='finished'||!m.winner_id||!m.match_state?.finished ||
     !['host','guest'].includes(m.match_state.winner))return false;
  return Number(m.winner_id)===Number(m.match_state.winner==='host'?m.host_id:m.guest_id);
}
async function updateTimeout(c,m,decision){
  if(!decision)return false;
  if(!decision.winner&&['deux_absents','deux_deconnectes','deux_inactifs'].includes(decision.reason)){
    // Deux absents : les deux sont disqualifies sans remboursement, le tournoi continue.
    const state=m.match_state||beginPenaltyDuel(Number(m.penalty_shots));
    state.finished=true;state.winner=null;state.doubleForfeit=true;state.pending={shooter:null,keeper:null};
    await c.query(`UPDATE maf_tournament_penalty_matches SET status='finished',winner_id=NULL,
      match_state=$2::jsonb,attention_reason=$3,revision=revision+1 WHERE id=$1 AND status IN ('scheduled','waiting','playing')`,
      [m.id,JSON.stringify(state),decision.reason]);
    await audit(c,'tournament_penalty_double_forfeit',{tournament_id:m.tournament_id,match_id:String(m.id),
      host_id:m.host_id,guest_id:m.guest_id,reason:decision.reason});
    return true;
  }
  if(!decision.winner){
    await c.query(`UPDATE maf_tournament_penalty_matches SET status='attention',attention_reason=$2,
      revision=revision+1 WHERE id=$1 AND status IN ('scheduled','waiting','playing')`,[m.id,decision.reason]);
    await audit(c,'tournament_penalty_attention',{tournament_id:m.tournament_id,match_id:String(m.id),reason:decision.reason});
    return true;
  }
  const state=m.match_state||beginPenaltyDuel(Number(m.penalty_shots));
  state.finished=true;state.winner=decision.winner;
  state.forfeit=decision.winner==='host'?'guest':'host';
  state.pending={shooter:null,keeper:null};
  const winner=decision.winner==='host'?m.host_id:m.guest_id;
  await c.query(`UPDATE maf_tournament_penalty_matches SET status='finished',winner_id=$2,
    match_state=$3::jsonb,attention_reason=NULL,revision=revision+1 WHERE id=$1`,[m.id,winner,JSON.stringify(state)]);
  await audit(c,'tournament_penalty_forfeit',{tournament_id:m.tournament_id,match_id:String(m.id),winner_id:winner,reason:decision.reason});
  return true;
}
export async function progressPenaltyTournament(tournamentId){
  if(!realTournamentFeaturesEnabled())return {changed:false,disabled:true};
  await ensurePenaltyProgressTables();
  const id=idNumber(tournamentId),c=await pool.connect();
  try{
    await c.query('BEGIN');
    const t=(await c.query(`SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if(!t||t.game!=='penalty'||t.status!=='published'||t.cancelled_at||t.deleted_at){await c.query('COMMIT');return {changed:false};}
    const matches=(await c.query(`SELECT m.*,t.penalty_shots FROM maf_tournament_penalty_matches m
      JOIN maf_tournaments t ON t.id=m.tournament_id WHERE m.tournament_id=$1
      ORDER BY m.round_no,m.match_no FOR UPDATE OF m`,[id])).rows;
    if(!matches.length){await c.query('COMMIT');return {changed:false};}
    const round=Math.max(...matches.map(x=>Number(x.round_no)));
    const current=matches.filter(m=>Number(m.round_no)===round);
    let changed=false;
    // Reparation : un champion non verse issu d'un tour avec double forfait n'a joue aucune finale.
    const champRow=(await c.query(`SELECT user_id,awarded_at FROM maf_tournament_penalty_champions
      WHERE tournament_id=$1 FOR UPDATE`,[id])).rows[0];
    if(champRow){
      const wrong=penaltyDoubleForfeitReplays(current,0);
      let paid=Boolean(champRow.awarded_at);
      if(!paid&&(await c.query(`SELECT to_regclass('maf_tournament_penalty_award_batches') AS t`)).rows[0].t){
        paid=(await c.query(`SELECT 1 FROM maf_tournament_penalty_award_batches WHERE tournament_id=$1`,[id])).rowCount>0;
      }
      if(wrong.length&&!paid){
        await c.query('DELETE FROM maf_tournament_penalty_champions WHERE tournament_id=$1',[id]);
        for(const m of wrong)await c.query(`UPDATE maf_tournament_penalty_matches SET status='attention',
          attention_reason='double_forfait_a_rejouer',revision=revision+1 WHERE id=$1`,[m.id]);
        await audit(c,'tournament_penalty_champion_revoked',{tournament_id:id,round,
          match_ids:wrong.map(m=>String(m.id)),reason:'double_forfait_sans_finale'});
        await c.query('COMMIT');return {changed:true,round,replay:true};
      }
      await c.query('COMMIT');return {changed:false,round,complete:true};
    }
    for(const m of current){
      const action=penaltyAbsenceDecision(m);
      if(action){await updateTimeout(c,m,action);changed=true;
        if(action.winner){m.status='finished';m.winner_id=action.winner==='host'?m.host_id:m.guest_id;
          m.match_state={...(m.match_state||beginPenaltyDuel(Number(m.penalty_shots))),finished:true,winner:action.winner};
        }else if(['deux_absents','deux_deconnectes','deux_inactifs'].includes(action.reason)){
          m.status='finished';m.winner_id=null;
          m.match_state={...(m.match_state||beginPenaltyDuel(Number(m.penalty_shots))),finished:true,winner:null,doubleForfeit:true};
        }else m.status='attention';}
    }
    if(current.some(m=>!certified(m))){await c.query('COMMIT');return {changed,round,waiting:true};}
    const champion=(await c.query(`SELECT user_id FROM maf_tournament_penalty_champions WHERE tournament_id=$1`,[id])).rows[0];
    if(champion){await c.query('COMMIT');return {changed,round,complete:true};}
    const exemptions=(await c.query(`SELECT user_id FROM maf_tournament_penalty_byes WHERE tournament_id=$1 AND round_no=$2`,[id,round])).rows;
    const qualifiers=current.filter(m=>m.winner_id).map(m=>Number(m.winner_id)).concat(exemptions.map(x=>Number(x.user_id)));
    const replays=penaltyDoubleForfeitReplays(current,qualifiers.length);
    if(replays.length){
      for(const m of replays)await c.query(`UPDATE maf_tournament_penalty_matches SET status='attention',
        attention_reason='double_forfait_a_rejouer',revision=revision+1 WHERE id=$1 AND status='finished' AND winner_id IS NULL`,[m.id]);
      await audit(c,'tournament_penalty_double_forfeit_replay',{tournament_id:id,round,
        match_ids:replays.map(m=>String(m.id)),qualifiers:qualifiers.length});
      await c.query('COMMIT');return {changed:true,round,replay:true};
    }
    if(!qualifiers.length){await c.query('COMMIT');return {changed,round,noQualifier:true};} // tous disqualifies : a traiter par le proprietaire
    const plan=buildNextPenaltyRound(qualifiers);
    if(plan.champion){
      await c.query(`INSERT INTO maf_tournament_penalty_champions(tournament_id,user_id) VALUES($1,$2)
        ON CONFLICT(tournament_id) DO NOTHING`,[id,plan.champion]);
      await audit(c,'tournament_penalty_champion_certified',{tournament_id:id,user_id:plan.champion,round});
      await c.query('COMMIT');return {changed:true,round,champion:plan.champion};
    }
    // Les exemptions sont pour le tour suivant. Aucune partie fictive.
    const next=round+1;
    if(plan.bye){
      await c.query(`INSERT INTO maf_tournament_penalty_byes(tournament_id,round_no,user_id)
        VALUES($1,$2,$3)`,[id,next,plan.bye]);
    }
    // La finale respecte l'heure configuree si celle-ci est encore a venir.
    const finalAt=Date.parse(t.final_at);
    const scheduled=new Date(plan.pairs.length===1 && plan.bye===null && Number.isFinite(finalAt)
      ? Math.max(Date.now()+15000,finalAt) : Date.now()+15000);
    for(const p of plan.pairs){
      await c.query(`INSERT INTO maf_tournament_penalty_matches
        (tournament_id,round_no,match_no,host_id,guest_id,scheduled_at)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [id,next,p.matchNo,p.hostId,p.guestId,scheduled]);
    }
    await audit(c,'tournament_penalty_next_round',{tournament_id:id,round:next,
      matches:plan.pairs.length,bye_user_id:plan.bye});
    await c.query('COMMIT');
    return {changed:true,round:next,duels:plan.pairs.length,bye:plan.bye};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export function maintainPenaltyTournamentProgress(){
  if(processing)return processing;
  processing=(async()=>{
    if(!realTournamentFeaturesEnabled())return {disabled:true};
    await ensurePenaltyProgressTables();
    const {rows}=await pool.query(`SELECT t.id FROM maf_tournaments t
      JOIN maf_tournament_penalty_draws d ON d.tournament_id=t.id
      WHERE t.game='penalty' AND t.status='published' AND t.deleted_at IS NULL
        AND t.cancelled_at IS NULL AND (NOT EXISTS
        (SELECT 1 FROM maf_tournament_penalty_champions ch WHERE ch.tournament_id=t.id)
        OR EXISTS (SELECT 1 FROM maf_tournament_penalty_champions ch WHERE ch.tournament_id=t.id AND ch.awarded_at IS NULL
          AND EXISTS (SELECT 1 FROM maf_tournament_penalty_matches m WHERE m.tournament_id=t.id AND m.status='finished'
            AND m.winner_id IS NULL AND m.match_state->>'doubleForfeit'='true'
            AND m.round_no=(SELECT max(x.round_no) FROM maf_tournament_penalty_matches x WHERE x.tournament_id=t.id))))
      ORDER BY t.starts_at,t.id LIMIT 100`);
    let updated=0;
    for(const row of rows){if((await progressPenaltyTournament(Number(row.id))).changed)updated++;}
    return {updated};
  })().finally(()=>{processing=null;});
  return processing;
}
const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
tournamentPenaltyProgressRouter.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
// Les matchs sans aucun joueur ne peuvent designer un vainqueur.
// Le proprietaire peut les reprogrammer pour laisser une nouvelle chance aux deux joueurs.
tournamentPenaltyProgressRouter.post('/penalty/matches/:id/reschedule',requireSession,route(async(req,res)=>{
  if(!await isOwnerAccount(req.userId,pool))return res.status(403).json({error:'Acces reserve au proprietaire.'});
  if(!realTournamentFeaturesEnabled())return res.status(503).json({error:'Tournoi indisponible.'});
  await ensurePenaltyProgressTables();
  const matchId=String(req.params.id);
  if(!/^[1-9]\d{0,15}$/.test(matchId))return res.status(400).json({error:'Identifiant invalide.'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const m=(await c.query(`SELECT m.*,t.status AS tournament_status,t.cancelled_at,t.deleted_at FROM maf_tournament_penalty_matches m
      JOIN maf_tournaments t ON t.id=m.tournament_id WHERE m.id=$1 FOR UPDATE OF m`,[matchId])).rows[0];
    if(!m||m.status!=='attention'||m.tournament_status!=='published'||m.cancelled_at||m.deleted_at){
      await c.query('ROLLBACK');return res.status(409).json({error:'Affrontement non reprogrammable.'});
    }
    await c.query(`UPDATE maf_tournament_penalty_matches SET status='scheduled',scheduled_at=now()+interval '1 minute',
      match_state=NULL,winner_id=NULL,playing_at=NULL,host_seen_at=NULL,guest_seen_at=NULL,
      host_joined_at=NULL,guest_joined_at=NULL,attention_reason=NULL,revision=revision+1 WHERE id=$1`,[matchId]);
    await audit(c,'tournament_penalty_match_rescheduled',{tournament_id:m.tournament_id,match_id:matchId,by:req.userId});
    await c.query('COMMIT');
    res.json({ok:true,matchId});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
