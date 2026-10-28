import { realTournamentFeaturesEnabled } from './tournamentLaunchPolicy.js';
// Tirage persistant, remboursement du surplus et creation atomique de 2 a 4 plateaux.
// IMPORTANT : le lancement REEL est volontairement desactive tant que le
// parcours joueur des qualifications n'a pas ete valide.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureTournamentCancellation } from './tournamentCancellation.js';
import { createQualificationGame, playQualificationAction } from './tournamentQualificationGame.js';
import { qualificationDraw, REQUIRED_PLAYERS } from './tournamentDraw.js';
import { tournamentSeats } from './tournamentDynamicBudget.js';
import { ensureFinalistsTables, recordWinnerForMatch } from './tournamentFinalistStore.js';
import { initPresence, setPresence, expirePresence } from './monopolyPresence.js';
import { tickTurnClock, normalizeTurnClock } from './monopolyTurnClock.js';
import { lobbyDeadline, lobbyOutcome, launchWithAbsences } from './tournamentLiveRules.js';
import { privateMatchView } from './tournamentPrivateView.js';
import { ensureFinaleTables } from './tournamentFinale.js';
import { qualificationReference, tournamentReference } from './tournamentMatchReferences.js';

export const tournamentQualificationRouter = Router();
export const realQualificationEnabled = () => realTournamentFeaturesEnabled();
const fail = (status, message) => Object.assign(new Error(message), { status });
const route = fn => async (req,res,next)=>{try{await fn(req,res);}catch(e){
  if(e.status)return res.status(e.status).json({error:e.message});next(e);
}};
const numericId = value => {const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant invalide.');return n;};
// Ne jamais exposer l'ordre des cartes restants (decks), ni les identifiants internes des adversaires.
const playerView = privateMatchView;
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
      // Le meme journal de remboursement empeche tout double credit.
      await c.query(`ALTER TABLE maf_tournament_refunds
        DROP CONSTRAINT IF EXISTS maf_tournament_refunds_reason_check`);
      await c.query(`ALTER TABLE maf_tournament_refunds
        ADD CONSTRAINT maf_tournament_refunds_reason_check
        CHECK(reason IN ('owner_deleted','incomplete','late_incomplete_group'))`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_qualification_matches (
        id bigserial PRIMARY KEY,
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        table_no integer NOT NULL CHECK (table_no BETWEEN 1 AND 4),
        state jsonb NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        started_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        scheduled_at timestamptz,
        lobby_status text NOT NULL DEFAULT 'waiting',
        UNIQUE(tournament_id,table_no)
      )`);
      await c.query(`ALTER TABLE maf_tournament_qualification_matches
        ADD COLUMN IF NOT EXISTS scheduled_at timestamptz`);
      await c.query(`ALTER TABLE maf_tournament_qualification_matches
        ADD COLUMN IF NOT EXISTS lobby_status text NOT NULL DEFAULT 'waiting'`);
      await c.query(`UPDATE maf_tournament_qualification_matches SET scheduled_at=started_at
        WHERE scheduled_at IS NULL`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_qualification_presence (
        match_id bigint NOT NULL REFERENCES maf_tournament_qualification_matches(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        joined_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(match_id,user_id)
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
  await ensureFinaleTables();
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
      const active = (await c.query(`SELECT user_id FROM maf_tournament_entries
        WHERE tournament_id=$1 AND status='reserved' ORDER BY created_at,user_id`,[id])).rows;
      const expected=tournamentSeats(active.map(r=>Number(r.user_id))).groupSizes.length;
      if(existing.length!==expected||existing.some((p,i)=>p.table_no!==i+1))throw fail(409,'Etat partiel des qualifications : intervention necessaire.');
      await c.query('COMMIT');return false;
    }
    const rows=(await c.query(`SELECT e.user_id,e.fee_paid,u.pseudo FROM maf_tournament_entries e
      JOIN maf_users u ON u.id=e.user_id WHERE e.tournament_id=$1 AND e.status='reserved'
      ORDER BY e.created_at ASC,e.user_id ASC FOR UPDATE OF e`,[id])).rows;
    if (Number(tournament.capacity)!==REQUIRED_PLAYERS || Number(tournament.entry_fee)!==500)
      throw fail(409,'Parametres du tournoi incompatibles.');
    const seats=tournamentSeats(rows.map(r=>Number(r.user_id)));
    // L'annulation sous 10 inscrits reste geree par tournamentCancellation.
    if(seats.status==='cancel_and_refund') {await c.query('COMMIT');return false;}
    if(rows.some(r=>Number(r.fee_paid)!==500)) throw fail(409,'Mises des inscrits incoherentes.');
    // Remboursement atomique de la/les derniere(s) reservation(s), une seule fois.
    for(const userId of seats.refundIds) {
      const ledger=await c.query(`INSERT INTO maf_tournament_refunds (tournament_id,user_id,amount,reason)
        VALUES($1,$2,500,'late_incomplete_group')
        ON CONFLICT(tournament_id,user_id) DO NOTHING RETURNING user_id`,[id,userId]);
      if(ledger.rowCount!==1)throw fail(409,'Remboursement de surplus deja enregistre : verification necessaire.');
      const credit=await c.query('UPDATE maf_users SET balance=balance+500 WHERE id=$1 RETURNING id',[userId]);
      if(credit.rowCount!==1)throw fail(409,'Compte a rembourser introuvable.');
      const updated=await c.query(`UPDATE maf_tournament_entries SET status='refunded'
        WHERE tournament_id=$1 AND user_id=$2 AND status='reserved'`,[id,userId]);
      if(updated.rowCount!==1)throw fail(409,'Inscription a rembourser introuvable.');
      await c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
        VALUES('system:tournament','tournament_surplus_refunded',$1::jsonb)`,
        [JSON.stringify({tournament_id:id,user_id:userId,amount:500})]);
    }
    const eligible=rows.filter(r=>seats.eligibleIds.includes(Number(r.user_id)));
    const groups=qualificationDraw(eligible.map(r=>({userId:Number(r.user_id),name:r.pseudo})));
    for(const group of groups){
      const game=createQualificationGame(group.players);
      await c.query(`INSERT INTO maf_tournament_qualification_matches (tournament_id,table_no,state,scheduled_at,lobby_status)
        VALUES($1,$2,$3::jsonb,$4,'waiting')`,[id,group.table,JSON.stringify(game),new Date(Math.max(Date.now(),new Date(tournament.starts_at).getTime())).toISOString()]);
    }
    // La finale est preparee en base des le tirage, mais cachee aux non-qualifies.
    await c.query(`INSERT INTO maf_tournament_final_schedules(tournament_id,planned_at,next_start_at)
      VALUES($1,$2,$2) ON CONFLICT(tournament_id) DO NOTHING`,[id,tournament.final_at]);
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
  const result=await pool.query(`SELECT id,table_no,revision,started_at,state FROM maf_tournament_qualification_matches
    WHERE tournament_id=$1 ORDER BY table_no`,[tournamentId]);
  res.json({tournamentId,tournamentReference:tournamentReference(tournamentId),groups:result.rows.map(r=>({table:r.table_no,reference:qualificationReference(tournamentId,r.table_no,r.id),revision:r.revision,
    startedAt:r.started_at,players:r.state.seats.map(p=>({name:p.name,seat:p.seat,userId:p.userId}))})),
    realStartEnabled:realQualificationEnabled()});
}));
// Les joueurs ouvrent volontairement le plateau ; un simple GET n'est jamais une preuve de presence.
tournamentQualificationRouter.get('/qualifications/mine',requireSession,route(async(req,res)=>{
  if(!realQualificationEnabled())return res.json({match:null,enabled:false,serverNow:Date.now()});
  await ensureQualificationTables();
  const rows=(await pool.query(`SELECT q.id,q.tournament_id,q.table_no,q.state,q.revision,
    q.lobby_status,q.scheduled_at,t.title FROM maf_tournament_qualification_matches q
    JOIN maf_tournaments t ON t.id=q.tournament_id
    WHERE q.state @> $1::jsonb AND t.deleted_at IS NULL AND t.cancelled_at IS NULL
    ORDER BY q.started_at DESC LIMIT 1`,
    [JSON.stringify({seats:[{userId:req.userId}]})])).rows;
  const found=rows[0];
  if(!found)return res.json({match:null,enabled:true,serverNow:Date.now()});
  const joined=(await pool.query(`SELECT user_id FROM maf_tournament_qualification_presence
    WHERE match_id=$1 AND last_seen_at>=now()-interval '20 seconds'`,[found.id])).rows.map(r=>Number(r.user_id));
  res.json({match:{id:Number(found.id),reference:qualificationReference(found.tournament_id,found.table_no,found.id),tournamentReference:tournamentReference(found.tournament_id),tournamentId:Number(found.tournament_id),title:found.title,
    table:Number(found.table_no),revision:found.revision,state:playerView(found.state,req.userId),
    lobbyStatus:found.lobby_status,joinedCount:joined.length,totalCount:found.state.seats.length,
    waitingFor:found.state.seats.filter(p=>!joined.includes(Number(p.userId))).map(p=>p.name),
    deadlineAt:new Date(lobbyDeadline(found.scheduled_at)).toISOString()},
    enabled:true,serverNow:Date.now()});
}));
// Heartbeat uniquement depuis le plateau ouvert. L'ordre d'arrivee est fixe cote base.
tournamentQualificationRouter.post('/qualifications/:id/presence',requireSession,route(async(req,res)=>{
  if(!realQualificationEnabled())throw fail(403,'Qualifications non ouvertes.');
  if(!['here','away'].includes(req.body?.state))throw fail(400,'Presence invalide.');
  await ensureQualificationTables();
  const id=numericId(req.params.id), c=await pool.connect();
  try{
    await c.query('BEGIN');
    const row=(await c.query('SELECT * FROM maf_tournament_qualification_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw fail(404,'Plateau inconnu.');
    const seats=row.state.seats;
    if(!seats.some(s=>Number(s.userId)===req.userId))throw fail(403,'Tu ne participes pas a ce plateau.');
    if(row.lobby_status==='waiting'){
      if(req.body.state==='here'){
        if(Date.now()>=lobbyDeadline(row.scheduled_at))throw fail(409,'Les cinq minutes pour rejoindre sont terminees.');
        await c.query(`INSERT INTO maf_tournament_qualification_presence(match_id,user_id)
          VALUES($1,$2) ON CONFLICT(match_id,user_id) DO UPDATE SET last_seen_at=now()`,[id,req.userId]);
      }
    } else if(row.lobby_status==='playing' && row.state.game.phase!=='over'){
      let match=structuredClone(row.state);
      const members=seats.map(s=>({id:s.userId}));
      if(setPresence(match.game,members,req.userId,req.body.state)){
        await c.query(`UPDATE maf_tournament_qualification_matches SET state=$2::jsonb,updated_at=now()
          WHERE id=$1`,[id,JSON.stringify(match)]);
      }
    }
    await c.query('COMMIT');res.json({ok:true,serverNow:Date.now()});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
// La maintenance traite le forfait et la limite de tour meme si tout le monde ferme son navigateur.
let maintaining;
export function maintainQualificationMatches(){
  if(maintaining)return maintaining;
  maintaining=(async()=>{
    if(!realQualificationEnabled())return {enabled:false};
    await ensureQualificationTables();await ensureFinalistsTables();
    const rows=(await pool.query(`SELECT id FROM maf_tournament_qualification_matches
      WHERE lobby_status IN ('waiting','playing') ORDER BY id DESC LIMIT 150`)).rows;
    let updated=0;
    for(const {id} of rows){
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        const row=(await c.query('SELECT * FROM maf_tournament_qualification_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!row || !['waiting','playing'].includes(row.lobby_status)){await c.query('COMMIT');continue;}
        const now=Date.now();let next=row.state,status=row.lobby_status,changed=false;
        if(status==='waiting'){
          const attendance=(await c.query("SELECT user_id FROM maf_tournament_qualification_presence WHERE match_id=$1 AND last_seen_at>=now()-interval '20 seconds'",[id]))
            .rows.map(r=>Number(r.user_id));
          const outcome=lobbyOutcome(next.seats,attendance,row.scheduled_at,now);
          if(outcome==='play'||outcome==='forfeit'){
            next=launchWithAbsences(next,attendance,now);
            status=next.game.phase==='over'?'finished':'playing';changed=true;
          } else if(outcome==='attention'){status='attention';changed=true;}
        } else {
          const members=next.seats.map(s=>({id:s.userId}));
          const presence=expirePresence(structuredClone(next.game),members,now);
          const clock=tickTurnClock(presence.game,{now,autoEnd:true});
          if(presence.changed||clock.changed){next={...next,game:clock.game};changed=true;}
          if(next.game.phase==='over')status='finished';
        }
        if(changed){
          await c.query(`UPDATE maf_tournament_qualification_matches
            SET state=$2::jsonb,lobby_status=$3,revision=revision+1,updated_at=now() WHERE id=$1`,
            [id,JSON.stringify(next),status]);
          await recordWinnerForMatch(c,{...row,state:next});updated++;
        }
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
    }
    return {enabled:true,updated};
  })().finally(()=>{maintaining=null;});
  return maintaining;
}
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
    if(row.lobby_status!=='playing')throw fail(409,'Plateau en attente des joueurs ou deja termine.');
    if(row.revision!==expectedRevision)throw fail(409,'Cette action a deja ete remplacee. Recharge le plateau.');
    if(row.state.game.presence?.away?.[String(req.userId)]!==undefined)
      throw fail(409,'Rejoins ton plateau avant de jouer.');
    const next=playQualificationAction(row.state,{userId:req.userId,action:req.body?.action,square:req.body?.square});
    normalizeTurnClock(next.game);
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
