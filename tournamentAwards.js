// Etape 8 : calculs, historique preparatoire et demo administrateur.
// AUCUN mouvement d'argent n'est accessible depuis ces routes.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureFinaleTables } from './tournamentFinale.js';
import { buildTournamentAwardPlan, certifiedFinalOrder, francText } from './tournamentAwardRules.js';

export const tournamentAwardsRouter = Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const handle = fn => async (req,res,next) => { try { await fn(req,res); } catch(e) {
  if(e.status) return res.status(e.status).json({error:e.message}); next(e);
}};
const integerId = value => {const v=Number(value);if(!Number.isSafeInteger(v)||v<=0)throw fail(400,'Tournoi invalide.');return v;};
async function owner(req) {
  const {rows}=await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[req.userId]);
  if(rows[0]?.pseudo_key!=='999')throw fail(403,'Reserve au proprietaire 999.');
}
let installed;
export function ensureTournamentAwardTables() {
  if(!installed)installed=(async()=>{
    await ensureFinaleTables();
    const c=await pool.connect();
    try {await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(62498469)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_award_batches (
        tournament_id integer PRIMARY KEY REFERENCES maf_tournaments(id),
        status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','credited')),
        final_order jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), credited_at timestamptz
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_award_lines (
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        place integer CHECK(place BETWEEN 1 AND 4),
        outcome text NOT NULL CHECK(outcome IN ('finalist','eliminated')),
        real_cents integer NOT NULL CHECK(real_cents>0),
        bonus_cents integer NOT NULL CHECK(bonus_cents=10000),
        status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','credited')),
        created_at timestamptz NOT NULL DEFAULT now(), credited_at timestamptz,
        PRIMARY KEY(tournament_id,user_id),
        UNIQUE(tournament_id,place),
        CHECK ((place IS NULL AND outcome='eliminated' AND real_cents=6250) OR
               (place IS NOT NULL AND outcome='finalist'))
      )`);
      await c.query('COMMIT');
    } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{installed=null;throw e;});
  return installed;
}
function simplePlan(plan) {
  return {
    stakes:francText(plan.stakesCents), totalReal:francText(plan.totalRealCents),
    totalBonus:francText(plan.totalBonusCents), remaining:francText(plan.remainingCents),
    lines:plan.lines.map(l=>({userId:l.userId,place:l.place,outcome:l.outcome,
      real:francText(l.realCents),bonus:francText(l.bonusCents)}))
  };
}

// Reserve au processus serveur futur, jamais appele par la demo.
// Genere un plan immuable ; ne touche ni a maf_users.balance ni au bonus_balance.
// Ne pas assimiler 'prepared' a 'paid' : la migration exacte du portefeuille est a valider.
export async function prepareCertifiedTournamentAwards(tournamentId) {
  const id=integerId(tournamentId);
  await ensureTournamentAwardTables();
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const tournament=(await c.query('SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!tournament || tournament.cancelled_at || tournament.deleted_at || Number(tournament.entry_fee)!==500)
      throw fail(409,'Tournoi absent, annule ou incompatible.');
    const entries=(await c.query(`SELECT user_id FROM maf_tournament_entries
      WHERE tournament_id=$1 AND status='reserved' ORDER BY user_id FOR UPDATE`,[id])).rows;
    const finalists=(await c.query(`SELECT user_id FROM maf_tournament_finalists
      WHERE tournament_id=$1 ORDER BY table_no`,[id])).rows;
    const final=(await c.query('SELECT state FROM maf_tournament_final_matches WHERE tournament_id=$1 FOR UPDATE',[id])).rows[0];
    if(entries.length!==20 || finalists.length!==4 || !final)throw fail(409,'Tournoi non termine : aucun plan cree.');
    const order=certifiedFinalOrder(final.state);
    if(new Set(finalists.map(f=>Number(f.user_id))).size!==4 ||
      order.some(u=>!finalists.some(f=>Number(f.user_id)===u)))
      throw fail(409,'Classement non conforme aux qualifies.');
    const plan=buildTournamentAwardPlan(entries.map(e=>Number(e.user_id)),order);
    const inserted=await c.query(`INSERT INTO maf_tournament_award_batches(tournament_id,final_order)
      VALUES($1,$2::jsonb) ON CONFLICT(tournament_id) DO NOTHING RETURNING tournament_id`,[id,JSON.stringify(order)]);
    if(inserted.rowCount===0){
      const saved=(await c.query('SELECT final_order,status FROM maf_tournament_award_batches WHERE tournament_id=$1 FOR UPDATE',[id])).rows[0];
      if(JSON.stringify(saved?.final_order)!==JSON.stringify(order))throw fail(409,'Classement deja prepare different : aucun changement.');
    }
    for(const line of plan.lines){
      await c.query(`INSERT INTO maf_tournament_award_lines(tournament_id,user_id,place,outcome,real_cents,bonus_cents)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tournament_id,user_id) DO NOTHING`,
      [id,line.userId,line.place,line.outcome,line.realCents,line.bonusCents]);
    }
    const saved=(await c.query(`SELECT user_id,place,outcome,real_cents,bonus_cents FROM maf_tournament_award_lines
      WHERE tournament_id=$1 ORDER BY user_id FOR UPDATE`,[id])).rows;
    if(saved.length!==20 || plan.lines.some(line=>{
      const row=saved.find(x=>Number(x.user_id)===line.userId);
      return !row || (row.place===null?null:Number(row.place))!==line.place || row.outcome!==line.outcome ||
        Number(row.real_cents)!==line.realCents || Number(row.bonus_cents)!==line.bonusCents;
    })) throw fail(409,'Historique de recompenses incoherent : operation annulee.');
    await c.query('COMMIT');
    return {prepared:true,alreadyPrepared:inserted.rowCount===0,lines:20,credited:false};
  } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}

tournamentAwardsRouter.use((_,res,next)=>{res.set('Cache-Control','private, no-store');next();});
tournamentAwardsRouter.post('/awards/owner/preview',requireSession,handle(async(req,res)=>{
  await owner(req);
  const p=buildTournamentAwardPlan(Array.from({length:20},(_,i)=>i+1),[1,2,3,4]);
  res.json({type:'demo',...simplePlan(p),credited:false,availableForPlayers:false,
    note:'Simulation uniquement. Aucun solde reel ou bonus ne change.'});
}));
tournamentAwardsRouter.get('/awards/owner/:id',requireSession,handle(async(req,res)=>{
  await owner(req);await ensureTournamentAwardTables();
  const id=integerId(req.params.id);
  const t=(await pool.query('SELECT id,title,status,cancelled_at FROM maf_tournaments WHERE id=$1',[id])).rows[0];
  if(!t)throw fail(404,'Tournoi introuvable.');
  const entries=(await pool.query(`SELECT count(*)::integer AS n FROM maf_tournament_entries
    WHERE tournament_id=$1 AND status='reserved'`,[id])).rows[0];
  const finalists=(await pool.query(`SELECT count(*)::integer AS n FROM maf_tournament_finalists WHERE tournament_id=$1`,[id])).rows[0];
  const last=(await pool.query('SELECT state FROM maf_tournament_final_matches WHERE tournament_id=$1',[id])).rows[0];
  const batch=(await pool.query('SELECT status,created_at,credited_at FROM maf_tournament_award_batches WHERE tournament_id=$1',[id])).rows[0];
  const audit=(await pool.query(`SELECT count(*)::integer AS n,
    COALESCE(sum(real_cents),0)::bigint AS real,COALESCE(sum(bonus_cents),0)::bigint AS bonus
    FROM maf_tournament_award_lines WHERE tournament_id=$1`,[id])).rows[0];
  let rankingCertified=false;
  try { if(last) { certifiedFinalOrder(last.state); rankingCertified=true; } } catch { /* non certifie */ }
  res.json({type:'inspection',tournamentId:id,title:t.title,
    registeredCount:entries.n,qualifiedCount:finalists.n,finalOver:last?.state?.game?.phase==='over',
    rankingCertified,preparedCount:audit.n,batchStatus:batch?.status||null,
    preparedReal:francText(Number(audit.real)),preparedBonus:francText(Number(audit.bonus)),
    credited:false,payoutsEnabled:false,
    note:'Aucun versement depuis ce panneau. Classement et portefeuille decimal a valider.'});
}));
