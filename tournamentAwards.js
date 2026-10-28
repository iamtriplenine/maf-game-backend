import { realTournamentFeaturesEnabled } from './tournamentLaunchPolicy.js';
// MAF Monopoly - credits reels transactionnels apres classement certifie.
// Aucun client / proprietaire ne peut transmettre un classement ou payer manuellement.
// Publication et paiement reel restent derriere trois indicateurs Render.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureWallet } from './wallet.js';
import { ensureFinaleTables } from './tournamentFinale.js';
import { ensureTournamentSkinTables } from './tournamentSkins.js';
import { buildTournamentSkinPlan } from './tournamentSkinRules.js';
import { selectedSkinGrants } from './studioSkinCatalog.js';
import { payoutPlan } from './tournamentPayoutRules.js';
import { certifiedFinalOrder, francText } from './tournamentAwardRules.js';
import { finalistFromMatch } from './tournamentFinalistRules.js';
import { tournamentSeats } from './tournamentDynamicBudget.js';

export const tournamentAwardsRouter = Router();
export const realTournamentPayoutsEnabled = () => realTournamentFeaturesEnabled();
const fail = (status, message) => Object.assign(new Error(message), { status });
const handle = fn => async (req,res,next) => {try { await fn(req,res); } catch(e) {
  if(e.status)return res.status(e.status).json({error:e.message});next(e);
}};
const integerId = value => { const v=Number(value);if(!Number.isSafeInteger(v)||v<=0)throw fail(400,'Tournoi invalide.');return v; };
async function owner(req) {
  const {rows}=await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[req.userId]);
  if(rows[0]?.pseudo_key!=='999')throw fail(403,'Reserve au proprietaire 999.');
}
let installed;
export function ensureTournamentAwardTables() {
  if(!installed)installed=(async()=>{
    await ensureFinaleTables();await ensureWallet();
    const c=await pool.connect();
    try {
      await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(62498469)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_award_batches (
        tournament_id integer PRIMARY KEY REFERENCES maf_tournaments(id),
        status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','credited')),
        final_order jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), credited_at timestamptz
      )`);
      await c.query(`ALTER TABLE maf_tournament_award_batches
        ADD COLUMN IF NOT EXISTS organizer_franc integer,
        ADD COLUMN IF NOT EXISTS total_real_franc integer,
        ADD COLUMN IF NOT EXISTS total_bonus_franc integer`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_award_lines (
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        place integer CHECK(place BETWEEN 1 AND 4),
        outcome text NOT NULL CHECK(outcome IN ('finalist','eliminated')),
        real_cents integer NOT NULL CHECK(real_cents>=0),
        bonus_cents integer NOT NULL CHECK(bonus_cents>=0),
        status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','credited')),
        created_at timestamptz NOT NULL DEFAULT now(), credited_at timestamptz,
        PRIMARY KEY(tournament_id,user_id), UNIQUE(tournament_id,place)
      )`);
      // Anciennes contraintes de simulation : 20 joueurs, 62,50 F et 100 F fixes.
      // Remplace ces checks, sans effacer ni accrediter les anciens lots prepares.
      await c.query(`DO $ddl$ DECLARE con record; BEGIN
        FOR con IN SELECT conname FROM pg_constraint
          WHERE conrelid='maf_tournament_award_lines'::regclass AND contype='c'
        LOOP EXECUTE format('ALTER TABLE maf_tournament_award_lines DROP CONSTRAINT %I',con.conname); END LOOP;
      END $ddl$`);
      await c.query(`ALTER TABLE maf_tournament_award_lines
        ADD CONSTRAINT maf_tournament_award_line_values_chk CHECK (
          (place IS NULL OR place BETWEEN 1 AND 4) AND
          ((place IS NULL AND outcome='eliminated') OR (place IS NOT NULL AND outcome='finalist')) AND
          real_cents>=0 AND bonus_cents>=0 AND status IN ('prepared','credited'))`);
      await c.query(`ALTER TABLE maf_tournament_award_lines
        ADD COLUMN IF NOT EXISTS real_franc integer,
        ADD COLUMN IF NOT EXISTS bonus_franc integer`);
      await c.query(`ALTER TABLE maf_tournament_award_lines
        ADD CONSTRAINT maf_tournament_award_whole_franc_chk CHECK (
          (real_franc IS NULL OR real_franc>=0) AND (bonus_franc IS NULL OR bonus_franc>=0))`);
      await c.query('COMMIT');
    } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{installed=null;throw e;});
  return installed;
}
function same(a,b) {return JSON.stringify(a)===JSON.stringify(b);}
function walletLimitQuery(c,id,real,bonus) {
  return c.query(`UPDATE maf_users SET balance=balance+$2,bonus_balance=bonus_balance+$3
    WHERE id=$1 AND balance BETWEEN 0 AND 2147483647-$2
      AND bonus_balance BETWEEN 0 AND 2147483647-$3 RETURNING id`,[id,real,bonus]);
}
function verifiedRows(expected, actual) {
  if(expected.length!==actual.length)throw fail(409,'Lignes de paiement preexistantes incompatibles.');
  const saved=new Map(actual.map(r=>[Number(r.user_id),r]));
  return expected.every(l=>{
    const r=saved.get(l.userId);
    return r && (r.place===null?null:Number(r.place))===l.place && r.outcome===l.outcome &&
      Number(r.real_cents)===l.realCents && Number(r.bonus_cents)===l.bonusCents &&
      Number(r.real_franc)===l.realFranc && Number(r.bonus_franc)===l.bonusFranc &&
      r.status==='prepared';
  });
}

// Unique transaction PostgreSQL : serialisation par verrou tournoi, controles
// des qualifications + finale, registre immuable, credits aux joueurs + au compte 999.
// En cas d'erreur : ROLLBACK, aucun solde ni registre accredite partiellement.
export async function settleCertifiedTournamentAwards(tournamentId) {
  if(!realTournamentPayoutsEnabled())return {enabled:false,credited:false};
  const id=integerId(tournamentId);
  await ensureTournamentAwardTables();await ensureTournamentSkinTables();
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const t=(await c.query('SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!t || t.status!=='published' || t.deleted_at || t.cancelled_at || Number(t.entry_fee)!==500 || Number(t.capacity)!==20)
      throw fail(409,'Tournoi annule, non publie ou incompatible.');
    const batch=(await c.query('SELECT * FROM maf_tournament_award_batches WHERE tournament_id=$1 FOR UPDATE',[id])).rows[0];
    if(batch?.status==='credited') {await c.query('COMMIT');return {credited:true,alreadyCredited:true};}
    const entries=(await c.query(`SELECT user_id,fee_paid FROM maf_tournament_entries
      WHERE tournament_id=$1 AND status='reserved' ORDER BY created_at,user_id FOR UPDATE`,[id])).rows;
    const ids=entries.map(r=>Number(r.user_id));
    const seats=tournamentSeats(ids);
    if(seats.status!=='eligible' || seats.refundIds.length || entries.some(x=>Number(x.fee_paid)!==500))
      throw fail(409,'Inscriptions payees incompletes, remboursement de surplus en attente.');
    const refunded=(await c.query(`SELECT 1 FROM maf_tournament_refunds
      WHERE tournament_id=$1 AND user_id=ANY($2::integer[]) LIMIT 1`,[id,ids])).rowCount;
    if(refunded)throw fail(409,'Inscription eligible deja remboursee.');
    const matches=(await c.query(`SELECT id,tournament_id,table_no,state FROM maf_tournament_qualification_matches
      WHERE tournament_id=$1 ORDER BY table_no FOR UPDATE`,[id])).rows;
    if(matches.length!==seats.groupSizes.length || matches.some(x=>x.state?.game?.phase!=='over'))
      throw fail(409,'Qualifications encore en cours ou incompletes.');
    const finalistRows=(await c.query(`SELECT table_no,user_id,match_id FROM maf_tournament_finalists
      WHERE tournament_id=$1 ORDER BY table_no FOR UPDATE`,[id])).rows;
    if(finalistRows.length!==matches.length || finalistRows.some((f,i)=>{
      const m=matches[i],winner=finalistFromMatch(m);
      return Number(f.table_no)!==i+1 || !winner || winner.userId!==Number(f.user_id) ||
        winner.matchId!==Number(f.match_id) || !ids.includes(winner.userId);
    }))throw fail(409,'Gagnants des plateaux non certifies.');
    const finished=(await c.query(`SELECT state FROM maf_tournament_final_matches
      WHERE tournament_id=$1 FOR UPDATE`,[id])).rows[0];
    if(!finished)throw fail(409,'Finale absente.');
    const order=certifiedFinalOrder(finished.state);
    const qualified=finalistRows.map(x=>Number(x.user_id));
    if(order.length!==qualified.length || order.some(x=>!qualified.includes(x)))
      throw fail(409,'Classement de finale different des qualifiés.');
    const plan=payoutPlan(ids,order);
    if(batch && (!same(batch.final_order,order) ||
       Number(batch.organizer_franc)!==plan.organizerFranc ||
       Number(batch.total_real_franc)!==plan.totalRealFranc ||
       Number(batch.total_bonus_franc)!==plan.totalBonusFranc))
      throw fail(409,'Ancien lot de gains incompatible : paiement bloque.');
    const ownerUser=(await c.query("SELECT id FROM maf_users WHERE pseudo_key='999' FOR UPDATE")).rows;
    if(ownerUser.length!==1)throw fail(409,'Compte organisateur 999 introuvable ou ambigu.');
    if(!batch)await c.query(`INSERT INTO maf_tournament_award_batches
      (tournament_id,final_order,organizer_franc,total_real_franc,total_bonus_franc)
      VALUES($1,$2::jsonb,$3,$4,$5)`,[id,JSON.stringify(order),plan.organizerFranc,plan.totalRealFranc,plan.totalBonusFranc]);
    for(const l of plan.lines)await c.query(`INSERT INTO maf_tournament_award_lines
      (tournament_id,user_id,place,outcome,real_cents,bonus_cents,real_franc,bonus_franc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tournament_id,user_id) DO NOTHING`,
      [id,l.userId,l.place,l.outcome,l.realCents,l.bonusCents,l.realFranc,l.bonusFranc]);
    const saved=(await c.query(`SELECT * FROM maf_tournament_award_lines
      WHERE tournament_id=$1 ORDER BY user_id FOR UPDATE`,[id])).rows;
    if(!verifiedRows(plan.lines,saved))throw fail(409,'Historique de gains prepare incompatible.');
    const skins=buildTournamentSkinPlan(plan.lines);
    for(const sk of skins)await c.query(`INSERT INTO maf_tournament_skin_entitlements
      (tournament_id,user_id,skin_kind) VALUES($1,$2,$3)
      ON CONFLICT(tournament_id,user_id,skin_kind) DO NOTHING`,[id,sk.userId,sk.kind]);
    const rights=(await c.query(`SELECT user_id,skin_kind FROM maf_tournament_skin_entitlements
      WHERE tournament_id=$1 ORDER BY user_id,skin_kind FOR UPDATE`,[id])).rows;
    if(rights.length!==skins.length || rights.some(x=>!skins.some(s=>s.userId===Number(x.user_id)&&s.kind===x.skin_kind)))
      throw fail(409,'Droits de skins incoherents.');
    // Les nouveaux skins exclusifs sont attribues avec les memes garanties
    // transactionnelles que les francs : aucun gain partiel et aucun doublon.
    const skinGrants=selectedSkinGrants(plan.lines,t.participant_skin_id,t.winner_skin_id);
    for (const g of skinGrants) await c.query(`INSERT INTO maf_studio_skin_unlocks
      (user_id,skin_id,tournament_id,prize_kind) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id,skin_id) DO NOTHING`,[g.userId,g.skinId,id,g.kind]);
    // Les utilisateurs sont toujours verrouilles dans le meme ordre pour limiter les deadlocks.
    for(const l of [...plan.lines].sort((a,b)=>a.userId-b.userId)) {
      const result=await walletLimitQuery(c,l.userId,l.realFranc,l.bonusFranc);
      if(result.rowCount!==1)throw fail(409,'Solde du joueur indisponible ou plafond atteint : paiement annule.');
      await c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
        VALUES('system:tournament','tournament_reward_credited',$1::jsonb)`,
        [JSON.stringify({tournament_id:id,user_id:l.userId,place:l.place,real_f:l.realFranc,bonus_v:l.bonusFranc})]);
    }
    const org=await walletLimitQuery(c,Number(ownerUser[0].id),plan.organizerFranc,0);
    if(org.rowCount!==1)throw fail(409,'Compte organisateur indisponible : paiement annule.');
    await c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
      VALUES('system:tournament','tournament_organizer_credited',$1::jsonb)`,
      [JSON.stringify({tournament_id:id,user_id:Number(ownerUser[0].id),real_f:plan.organizerFranc})]);
    await c.query(`UPDATE maf_tournament_award_lines SET status='credited',credited_at=now()
      WHERE tournament_id=$1 AND status='prepared'`,[id]);
    await c.query(`UPDATE maf_tournament_award_batches SET status='credited',credited_at=now()
      WHERE tournament_id=$1 AND status='prepared'`,[id]);
    await c.query('COMMIT');
    return {credited:true,alreadyCredited:false,players:plan.lines.length,
      realFranc:plan.totalRealFranc,bonusFranc:plan.totalBonusFranc,organizerFranc:plan.organizerFranc};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}

let running;
export function maintainTournamentAwardCredits() {
  if(running)return running;
  running=(async()=>{
    if(!realTournamentPayoutsEnabled())return {enabled:false,credited:0};
    await ensureTournamentAwardTables();
    const {rows}=await pool.query(`SELECT t.id FROM maf_tournaments t
      JOIN maf_tournament_final_matches f ON f.tournament_id=t.id
      LEFT JOIN maf_tournament_award_batches b ON b.tournament_id=t.id
      WHERE t.status='published' AND t.cancelled_at IS NULL AND t.deleted_at IS NULL
        AND f.state->'game'->>'phase'='over' AND (b.status IS NULL OR b.status='prepared')
      ORDER BY t.id LIMIT 100`);
    let credited=0,blocked=0;
    for(const r of rows){
      try {if((await settleCertifiedTournamentAwards(Number(r.id))).credited)credited++;}
      catch(e){blocked++;console.error('Tournoi paiement bloque',r.id,e.message);}
    }
    return {enabled:true,credited,blocked};
  })().finally(()=>{running=null;});return running;
}

tournamentAwardsRouter.use((_,res,next)=>{res.set('Cache-Control','private, no-store');next();});
tournamentAwardsRouter.post('/awards/owner/preview',requireSession,handle(async(req,res)=>{
  await owner(req);
  const n=Number(req.body?.players ?? 20);
  if(!Number.isInteger(n) || n<10 || n>20)throw fail(400,'Effectif entre 10 et 20.');
  const seats=tournamentSeats(Array.from({length:n},(_,i)=>i+1));
  const p=payoutPlan(seats.eligibleIds,seats.eligibleIds.slice(0,seats.groupSizes.length));
  res.json({type:'demo',players:p.eligibleCount,realFranc:p.totalRealFranc,bonusFranc:p.totalBonusFranc,
    organizerFranc:p.organizerFranc,lines:p.lines,credited:false,
    note:'Simulation uniquement : aucun transfert depuis cette route.'});
}));
tournamentAwardsRouter.get('/awards/owner/:id',requireSession,handle(async(req,res)=>{
  await owner(req);await ensureTournamentAwardTables();
  const id=integerId(req.params.id);
  const t=(await pool.query('SELECT id,title,status,cancelled_at FROM maf_tournaments WHERE id=$1',[id])).rows[0];
  if(!t)throw fail(404,'Tournoi introuvable.');
  const entries=(await pool.query(`SELECT count(*)::integer AS n FROM maf_tournament_entries
    WHERE tournament_id=$1 AND status='reserved'`,[id])).rows[0];
  const finalists=(await pool.query('SELECT count(*)::int AS n FROM maf_tournament_finalists WHERE tournament_id=$1',[id])).rows[0];
  const last=(await pool.query('SELECT state FROM maf_tournament_final_matches WHERE tournament_id=$1',[id])).rows[0];
  const batch=(await pool.query('SELECT * FROM maf_tournament_award_batches WHERE tournament_id=$1',[id])).rows[0];
  const audit=(await pool.query(`SELECT count(*)::int AS n,COALESCE(sum(real_franc),0)::bigint AS real,
    COALESCE(sum(bonus_franc),0)::bigint AS bonus FROM maf_tournament_award_lines WHERE tournament_id=$1`,[id])).rows[0];
  let rankingCertified=false;try{if(last){certifiedFinalOrder(last.state);rankingCertified=true;}}catch{}
  res.json({type:'inspection',tournamentId:id,title:t.title,registeredCount:entries.n,
    qualifiedCount:finalists.n,finalOver:last?.state?.game?.phase==='over',rankingCertified,
    preparedCount:audit.n,batchStatus:batch?.status||null,credited:batch?.status==='credited',
    preparedRealFranc:Number(audit.real),preparedBonusFranc:Number(audit.bonus),
    organizerFranc:batch?.organizer_franc == null?null:Number(batch.organizer_franc),
    payoutsEnabled:realTournamentPayoutsEnabled(),
    note:'Creditable automatiquement seulement apres preuve serveur et validation de tous les controles.'});
}));
