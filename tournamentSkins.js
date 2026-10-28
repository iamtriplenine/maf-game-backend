// Etape 9 : registre preparatoire et demonstration proprietaire.
// Ne modifie ni inventaire de skins joueurs ni solde : assets et schema inventaire a valider.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureTournamentAwardTables } from './tournamentAwards.js';
import { buildTournamentAwardPlan } from './tournamentAwardRules.js';
import { buildTournamentSkinPlan, resultAnimationSteps } from './tournamentSkinRules.js';
import { STUDIO_SKINS, studioSkin } from './studioSkinCatalog.js';

export const tournamentSkinsRouter = Router();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const handler=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
const positiveId=x=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant de tournoi invalide.');return n;};
async function owner(req){
  const {rows}=await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[req.userId]);
  if(rows[0]?.pseudo_key!=='999')throw fail(403,'Reserve au proprietaire 999.');
}
let schemaReady;
export function ensureTournamentSkinTables(){
  if(!schemaReady) schemaReady=(async()=>{
    await ensureTournamentAwardTables();
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498471)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_skin_entitlements (
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        skin_kind text NOT NULL CHECK(skin_kind IN ('participation','finalist')),
        status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','granted')),
        created_at timestamptz NOT NULL DEFAULT now(), granted_at timestamptz,
        PRIMARY KEY(tournament_id,user_id,skin_kind)
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_studio_skin_unlocks (
        user_id integer NOT NULL REFERENCES maf_users(id),
        skin_id text NOT NULL,
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        prize_kind text NOT NULL CHECK(prize_kind IN ('participation','winner')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id,skin_id)
      )`);
      await c.query('COMMIT');
    } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;}
    finally{c.release();}
  })().catch(e=>{schemaReady=null;throw e;});
  return schemaReady;
}

// Fonction INTERNE pour un futur pipeline de resultats certifies : elle prepare des
// droits uniquement APRES existence du registre des recompenses de l'etape 8.
// Aucune route proprietaire/demo ne l'appelle. Elle n'equipe/attribue aucun asset.
export async function prepareTournamentSkinEntitlements(tournamentId){
  const id=positiveId(tournamentId);
  await ensureTournamentSkinTables();
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const tournament=(await c.query('SELECT id,cancelled_at,deleted_at FROM maf_tournaments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!tournament || tournament.cancelled_at || tournament.deleted_at) throw fail(409,'Tournoi inexistant ou annule.');
    const batch=(await c.query('SELECT status,final_order FROM maf_tournament_award_batches WHERE tournament_id=$1 FOR UPDATE',[id])).rows[0];
    if(!batch) throw fail(409,'Classement certifie non prepare.');
    const entries=(await c.query(`SELECT user_id FROM maf_tournament_entries WHERE tournament_id=$1 AND status='reserved' ORDER BY user_id FOR UPDATE`,[id])).rows;
    const awards=(await c.query(`SELECT user_id,place,outcome FROM maf_tournament_award_lines WHERE tournament_id=$1 ORDER BY user_id FOR UPDATE`,[id])).rows;
    if(![10,14,15,18,19,20].includes(entries.length) || awards.length!==entries.length) throw fail(409,'Tournoi incomplet : droits non prepares.');
    const paid=new Set(entries.map(e=>Number(e.user_id)));
    if(awards.some(l=>!paid.has(Number(l.user_id)))) throw fail(409,'Resultats sans reservation valide.');
    // Verifier que les quatre rangs correspondent exactement au lot immuable
    // de l'etape 8, et non a une liste preparee independamment.
    const ordered=awards.filter(l=>l.place!==null).sort((a,b)=>Number(a.place)-Number(b.place)).map(l=>Number(l.user_id));
    if(ordered.length!==(entries.length===10?2:entries.length<=15?3:4) || !Array.isArray(batch.final_order) || JSON.stringify(batch.final_order.map(Number))!==JSON.stringify(ordered))
      throw fail(409,'Historique des resultats different du classement certifie.');
    const plan=buildTournamentSkinPlan(awards);
    for(const line of plan){
      await c.query(`INSERT INTO maf_tournament_skin_entitlements(tournament_id,user_id,skin_kind)
        VALUES($1,$2,$3) ON CONFLICT(tournament_id,user_id,skin_kind) DO NOTHING`,[id,line.userId,line.kind]);
    }
    const stored=(await c.query(`SELECT user_id,skin_kind,status FROM maf_tournament_skin_entitlements
      WHERE tournament_id=$1 ORDER BY user_id,skin_kind FOR UPDATE`,[id])).rows;
    const keys=new Set(plan.map(x=>`${x.userId}:${x.kind}`));
    if(stored.length!==plan.length || stored.some(x=>!keys.has(`${Number(x.user_id)}:${x.skin_kind}`)))
      throw fail(409,'Droits skins deja enregistres incoherents.');
    await c.query('COMMIT');
    return {prepared:true,count:plan.length,alreadyGranted:stored.filter(x=>x.status==='granted').length};
  } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally{c.release();}
}

tournamentSkinsRouter.use((_,res,next)=>{res.set('Cache-Control','private, no-store');next();});
// L'acces aux skins exclusifs est determine par le serveur, jamais par le navigateur.
tournamentSkinsRouter.get('/skins/mine',requireSession,handler(async(req,res)=>{
  await ensureTournamentSkinTables();
  const {rows}=await pool.query(`SELECT skin_id FROM maf_studio_skin_unlocks WHERE user_id=$1`,[req.userId]);
  res.json({unlocked:rows.map(r=>r.skin_id).filter(id=>studioSkin(id)?.access==='exclusive')});
}));
tournamentSkinsRouter.post('/skins/owner/preview',requireSession,handler(async(req,res)=>{
  await owner(req);
  const awardPlan=buildTournamentAwardPlan(Array.from({length:20},(_,i)=>i+1),[1,2,3,4]);
  const grants=buildTournamentSkinPlan(awardPlan.lines);
  res.json({type:'demo',...resultAnimationSteps(grants),
    assetsConfigured:false,granted:false,inventoryUpdated:false,
    examples:[{place:1,skins:['participation','finalist']},{place:2,skins:['participation','finalist']},
      {place:3,skins:['participation','finalist']},{place:4,skins:['participation','finalist']},
      {place:null,skins:['participation']}],
    note:'Simulation proprietaire uniquement. Aucune attribution dans un inventaire joueur.'});
}));
tournamentSkinsRouter.get('/skins/owner/:id',requireSession,handler(async(req,res)=>{
  await owner(req);
  await ensureTournamentSkinTables();
  const id=positiveId(req.params.id);
  const t=(await pool.query('SELECT id,title,cancelled_at FROM maf_tournaments WHERE id=$1',[id])).rows[0];
  if(!t)throw fail(404,'Tournoi introuvable.');
  const a=(await pool.query(`SELECT COUNT(*)::integer AS total,
    COUNT(*) FILTER(WHERE skin_kind='participation')::integer AS participation,
    COUNT(*) FILTER(WHERE skin_kind='finalist')::integer AS finalist,
    COUNT(*) FILTER(WHERE status='granted')::integer AS granted
    FROM maf_tournament_skin_entitlements WHERE tournament_id=$1`,[id])).rows[0];
  const awards=(await pool.query('SELECT COUNT(*)::integer AS total FROM maf_tournament_award_lines WHERE tournament_id=$1',[id])).rows[0];
  res.json({type:'inspection',title:t.title,tournamentId:id,cancelled:!!t.cancelled_at,
    awardsPrepared:awards.total,entitlementsPrepared:a.total,participation:a.participation,
    finalists:a.finalist,assetsConfigured:false,granted:a.granted,
    note:'Lecture seule : aucun skin equipé ni ajoute dans un inventaire.'});
}));
