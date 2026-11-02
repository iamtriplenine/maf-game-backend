// Tournois Tir-au-but : lancement automatique des duels et remboursement du dernier
// inscrit en cas d'effectif impair. Aucun match n'est joue pendant le tirage.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { isOwnerAccount } from './accountRoles.js';
import { ensureTournamentCancellation } from './tournamentCancellation.js';
import { buildPenaltyDraw, penaltyDuelReference } from './penaltyTournamentDraw.js';
import { tournamentReference } from './tournamentMatchReferences.js';
import { realTournamentFeaturesEnabled } from './tournamentLaunchPolicy.js';

export const tournamentPenaltyDrawRouter=Router();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
const numericId=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant invalide.');return n;};
let ready;
export function ensurePenaltyDrawTables(){
  if(!ready)ready=(async()=>{
    await ensureTournamentCancellation();
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      // Meme verrou de schema que les qualifications Monopoly (raison de remboursement partagee).
      await c.query('SELECT pg_advisory_xact_lock(62498465)');
      await c.query(`ALTER TABLE maf_tournament_refunds DROP CONSTRAINT IF EXISTS maf_tournament_refunds_reason_check`);
      await c.query(`ALTER TABLE maf_tournament_refunds ADD CONSTRAINT maf_tournament_refunds_reason_check
        CHECK (reason IN ('owner_deleted','incomplete','late_incomplete_group'))`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_penalty_draws (
        tournament_id integer PRIMARY KEY REFERENCES maf_tournaments(id),
        eligible_count integer NOT NULL CHECK(eligible_count BETWEEN 2 AND 32 AND eligible_count % 2 = 0),
        initial_match_count integer NOT NULL CHECK(initial_match_count BETWEEN 1 AND 16),
        refunded_user_id integer REFERENCES maf_users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_penalty_matches (
        id bigserial PRIMARY KEY,
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        round_no integer NOT NULL CHECK(round_no >= 1),
        match_no integer NOT NULL CHECK(match_no >= 1),
        host_id integer NOT NULL REFERENCES maf_users(id),
        guest_id integer NOT NULL REFERENCES maf_users(id),
        status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','waiting','playing','finished','attention')),
        scheduled_at timestamptz NOT NULL DEFAULT now(),
        winner_id integer REFERENCES maf_users(id),
        revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (host_id <> guest_id),
        UNIQUE(tournament_id,round_no,match_no)
      )`);
      await c.query(`CREATE INDEX IF NOT EXISTS maf_penalty_matches_host ON maf_tournament_penalty_matches(host_id,tournament_id)`);
      await c.query(`CREATE INDEX IF NOT EXISTS maf_penalty_matches_guest ON maf_tournament_penalty_matches(guest_id,tournament_id)`);
      await c.query(`CREATE INDEX IF NOT EXISTS maf_penalty_refunds_lookup ON maf_tournament_refunds(user_id,reason,created_at DESC)`);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{ready=null;throw e;});
  return ready;
}

export async function startPenaltyTournament(id){
  if(!realTournamentFeaturesEnabled())return false;
  await ensurePenaltyDrawTables();
  id=numericId(id);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    // Meme verrou que la reservation / annulation ; aucune place ne change en cours de tirage.
    const t=(await c.query('SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!t||t.game!=='penalty'||t.status!=='published'||t.cancelled_at||t.deleted_at||
       Date.parse(t.starts_at)>Date.now()) { await c.query('COMMIT');return false; }
    const previous=(await c.query('SELECT tournament_id FROM maf_tournament_penalty_draws WHERE tournament_id=$1',[id])).rows[0];
    if(previous){await c.query('COMMIT');return false;}
    const entries=(await c.query(`SELECT e.user_id,e.fee_paid,u.pseudo FROM maf_tournament_entries e
      JOIN maf_users u ON u.id=e.user_id
      WHERE e.tournament_id=$1 AND e.status='reserved'
      ORDER BY e.created_at ASC,e.user_id ASC FOR UPDATE OF e`,[id])).rows;
    if(entries.length<2){await c.query('COMMIT');return false;} // Annulation du tournoi incomplet par le circuit existant.
    let draw;
    try{draw=buildPenaltyDraw(t,entries);}catch{throw fail(409,'Tirage impossible : inscriptions ou mises incoherentes.');}
    if(draw.refundedUserId!==null){
      const last=entries[entries.length-1];
      const fee=Number(last.fee_paid);
      const ledger=await c.query(`INSERT INTO maf_tournament_refunds(tournament_id,user_id,amount,reason)
        VALUES($1,$2,$3,'late_incomplete_group')
        ON CONFLICT(tournament_id,user_id) DO NOTHING RETURNING user_id`,[id,draw.refundedUserId,fee]);
      if(ledger.rowCount!==1)throw fail(409,'Remboursement de surplus deja inscrit.');
      const user=await c.query('UPDATE maf_users SET balance=balance+$2 WHERE id=$1 RETURNING id',[draw.refundedUserId,fee]);
      if(user.rowCount!==1)throw fail(409,'Compte du joueur rembourse introuvable.');
      const updated=await c.query(`UPDATE maf_tournament_entries SET status='refunded'
        WHERE tournament_id=$1 AND user_id=$2 AND status='reserved'`,[id,draw.refundedUserId]);
      if(updated.rowCount!==1)throw fail(409,'Reservation a rembourser introuvable.');
      await c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
        VALUES('system:tournament','tournament_surplus_refunded',$1::jsonb)`,
        [JSON.stringify({tournament_id:id,user_id:draw.refundedUserId,amount:fee})]);
    }
    await c.query(`INSERT INTO maf_tournament_penalty_draws(tournament_id,eligible_count,initial_match_count,refunded_user_id)
      VALUES($1,$2,$3,$4)`,[id,draw.plan.players,draw.pairs.length,draw.refundedUserId]);
    for(const p of draw.pairs){
      await c.query(`INSERT INTO maf_tournament_penalty_matches
        (tournament_id,round_no,match_no,host_id,guest_id,scheduled_at)
        VALUES($1,1,$2,$3,$4,$5)`,[id,p.matchNo,p.host.userId,p.guest.userId,t.starts_at]);
    }
    await c.query(`UPDATE maf_tournaments SET registration_open=false,revision=revision+1,updated_at=now() WHERE id=$1`,[id]);
    await c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
      VALUES('system:tournament','tournament_penalty_draw_created',$1::jsonb)`,
      [JSON.stringify({tournament_id:id,participants:draw.plan.players,matches:draw.pairs.length,refunded:draw.refundedUserId!==null})]);
    await c.query('COMMIT');return true;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
let processing;
export function maintainPenaltyDrawStarts(){
  if(processing)return processing;
  processing=(async()=>{
    if(!realTournamentFeaturesEnabled())return {enabled:false,started:0};
    await ensurePenaltyDrawTables();
    const {rows}=await pool.query(`SELECT t.id FROM maf_tournaments t
      WHERE t.game='penalty' AND t.status='published' AND t.deleted_at IS NULL AND t.cancelled_at IS NULL
        AND t.starts_at<=now() AND (SELECT count(*) FROM maf_tournament_entries e
          WHERE e.tournament_id=t.id AND e.status='reserved')>=2 AND NOT EXISTS
        (SELECT 1 FROM maf_tournament_penalty_draws d WHERE d.tournament_id=t.id)
      ORDER BY t.starts_at,t.id LIMIT 100`);
    let started=0;
    for(const row of rows)if(await startPenaltyTournament(Number(row.id)))started++;
    return {enabled:true,started};
  })().finally(()=>{processing=null;});
  return processing;
}
function renderMatch(r){return {
  id:String(r.id),reference:penaltyDuelReference(Number(r.tournament_id),Number(r.round_no),Number(r.match_no),r.id),
  tournamentId:Number(r.tournament_id),round:Number(r.round_no),matchNo:Number(r.match_no),
  title:r.title,status:r.status,scheduledAt:r.scheduled_at,
  host:r.host_name,guest:r.guest_name,winner:r.winner_name||null,
};}
tournamentPenaltyDrawRouter.use((_,res,next)=>{res.set('Cache-Control','no-store');next();});
// Chaque participant ne voit que SON prochain salon, pas les salons des autres.
tournamentPenaltyDrawRouter.get('/penalty/mine',requireSession,route(async(req,res)=>{
  if(!realTournamentFeaturesEnabled())return res.json({match:null,serverNow:Date.now()});
  await ensurePenaltyDrawTables();
  const {rows}=await pool.query(`SELECT m.*,t.title,uh.pseudo AS host_name,ug.pseudo AS guest_name,uw.pseudo AS winner_name
    FROM maf_tournament_penalty_matches m
    JOIN maf_tournaments t ON t.id=m.tournament_id
    JOIN maf_users uh ON uh.id=m.host_id JOIN maf_users ug ON ug.id=m.guest_id
    LEFT JOIN maf_users uw ON uw.id=m.winner_id
    WHERE (m.host_id=$1 OR m.guest_id=$1) AND t.deleted_at IS NULL AND t.cancelled_at IS NULL
    ORDER BY CASE WHEN m.status='finished' THEN 1 ELSE 0 END,m.created_at DESC LIMIT 1`,[req.userId]);
  const lastRefund=(await pool.query(`SELECT t.title,r.tournament_id,r.amount,r.created_at FROM maf_tournament_refunds r
    JOIN maf_tournaments t ON t.id=r.tournament_id
    WHERE r.user_id=$1 AND t.game='penalty' AND r.reason='late_incomplete_group'
    ORDER BY r.created_at DESC LIMIT 1`,[req.userId])).rows[0];
  res.json({match:rows[0]?renderMatch(rows[0]):null,
    refunded:lastRefund?{tournamentId:Number(lastRefund.tournament_id),title:lastRefund.title,
      amount:Number(lastRefund.amount),at:lastRefund.created_at}:null,serverNow:Date.now()});
}));
// Tableau lisible par tous : ne pas retourner les IDs de comptes ni les choix secrets.
tournamentPenaltyDrawRouter.get('/penalty/bracket/:id',route(async(req,res)=>{
  await ensurePenaltyDrawTables();
  const id=numericId(req.params.id);
  const tour=(await pool.query(`SELECT id,title,game,status,deleted_at,cancelled_at,starts_at FROM maf_tournaments WHERE id=$1`,[id])).rows[0];
  if(!tour||tour.game!=='penalty'||tour.deleted_at||tour.cancelled_at||tour.status!=='published')throw fail(404,'Tournoi indisponible.');
  const draw=(await pool.query(`SELECT eligible_count,initial_match_count,created_at FROM maf_tournament_penalty_draws WHERE tournament_id=$1`,[id])).rows[0];
  if(!draw)return res.json({tournamentId:id,reference:tournamentReference(id),started:false,matches:[],serverNow:Date.now()});
  const {rows}=await pool.query(`SELECT m.*,t.title,uh.pseudo AS host_name,ug.pseudo AS guest_name,uw.pseudo AS winner_name
    FROM maf_tournament_penalty_matches m JOIN maf_tournaments t ON t.id=m.tournament_id
    JOIN maf_users uh ON uh.id=m.host_id JOIN maf_users ug ON ug.id=m.guest_id
    LEFT JOIN maf_users uw ON uw.id=m.winner_id WHERE m.tournament_id=$1 ORDER BY m.round_no,m.match_no`,[id]);
  res.json({tournamentId:id,reference:tournamentReference(id),started:true,
    participants:Number(draw.eligible_count),matches:rows.map(renderMatch),serverNow:Date.now()});
}));
