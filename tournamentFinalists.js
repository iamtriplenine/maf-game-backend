// Routes lecture seule / demonstration reservees au proprietaire 999.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureQualificationTables } from './tournamentQualificationStart.js';
import { ensureFinalistsTables, loadFinalistLobby, reconcileFinalistArrivals } from './tournamentFinalistStore.js';
import { demoFinalistLobby } from './tournamentFinalistRules.js';

export const tournamentFinalistsRouter=Router();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const handle=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
const validId=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant de tournoi invalide.');return n;};
async function checkOwner(req){
  const {rows}=await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[req.userId]);
  if(rows[0]?.pseudo_key!=='999')throw fail(403,'Reserve au compte proprietaire 999.');
}
async function ensureFinalsReady(){await ensureQualificationTables();await ensureFinalistsTables();}
let pending;
export function maintainFinalistArrivals(){
  if(pending)return pending;
  pending=(async()=>{if(process.env.MAF_TOURNAMENT_REAL_START_ENABLED!=='true')return {enabled:false,created:0};
    await ensureFinalsReady();return reconcileFinalistArrivals();})().finally(()=>{pending=null;});
  return pending;
}
tournamentFinalistsRouter.use((_,res,next)=>{res.set('Cache-Control','private, no-store');next();});
tournamentFinalistsRouter.post('/qualifications/finalists/owner/preview',requireSession,handle(async(req,res)=>{
  await checkOwner(req);
  const count=req.body?.completedCount;
  // L'identite proprietaire est controlee sur la base de donnees. Aucun INSERT ici.
  res.json({...demoFinalistLobby(count),serverNow:Date.now()});
}));
tournamentFinalistsRouter.get('/qualifications/finalists/owner/:id',requireSession,handle(async(req,res)=>{
  await checkOwner(req);
  const tournamentId=validId(req.params.id);
  await ensureFinalsReady();
  const exists=(await pool.query('SELECT id FROM maf_tournaments WHERE id=$1',[tournamentId])).rows[0];
  if(!exists)throw fail(404,'Tournoi introuvable.');
  res.json({...await loadFinalistLobby(tournamentId),serverNow:Date.now()});
}));
