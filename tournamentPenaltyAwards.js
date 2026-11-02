// Recompenses Tir-au-but : preuve serveur, transaction unique et paiement unique.
import {Router} from 'express';
import {pool} from './db.js';
import {requireSession} from './auth.js';
import {ownerAccountId,isOwnerAccount} from './accountRoles.js';
import {ensureTournamentSkinTables} from './tournamentSkins.js';
import {selectedSkinGrants} from './studioSkinCatalog.js';
import {ensurePenaltyProgressTables} from './tournamentPenaltyProgress.js';
import {realTournamentFeaturesEnabled} from './tournamentLaunchPolicy.js';
import {penaltyAwardBudget,certifyPenaltyBracket} from './penaltyTournamentAwardRules.js';

export const tournamentPenaltyAwardsRouter=Router();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const id=x=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant invalide.');return n;};
const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
let schemaReady,processing;
export function ensurePenaltyAwardTables(){
 if(!schemaReady)schemaReady=(async()=>{
  await ensurePenaltyProgressTables();
  await ensureTournamentSkinTables();
  const c=await pool.connect();
  try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(62498472)');
   await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_penalty_award_batches (
    tournament_id integer PRIMARY KEY REFERENCES maf_tournaments(id),
    champion_id integer NOT NULL REFERENCES maf_users(id),
    final_match_id bigint NOT NULL REFERENCES maf_tournament_penalty_matches(id),
    participants integer NOT NULL,
    fee integer NOT NULL,
    pot_franc integer NOT NULL,
    organizer_franc integer NOT NULL,
    status text NOT NULL DEFAULT 'credited' CHECK(status='credited'),
    created_at timestamptz NOT NULL DEFAULT now(),
    credited_at timestamptz NOT NULL DEFAULT now()
   )`);
   await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_penalty_award_lines (
    tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
    user_id integer NOT NULL REFERENCES maf_users(id),
    place integer NOT NULL CHECK(place IN (1,2,3)),
    role text NOT NULL CHECK(role IN ('champion','finaliste','demi_finaliste')),
    amount_franc integer NOT NULL CHECK(amount_franc>=0),
    credited_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tournament_id,user_id)
   )`);
   await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_penalty_skin_grants (
    tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
    user_id integer NOT NULL REFERENCES maf_users(id),
    skin_id text NOT NULL,
    prize_kind text NOT NULL CHECK(prize_kind IN ('participation','winner')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tournament_id,user_id,skin_id)
   )`);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 })().catch(e=>{schemaReady=null;throw e;});
 return schemaReady;
}
async function credit(c,user,amount){
 if(!Number.isSafeInteger(amount)||amount<0)throw fail(409,'Montant invalide.');
 const r=await c.query(`UPDATE maf_users SET balance=balance+$2 WHERE id=$1
  AND balance BETWEEN 0 AND 2147483647-$2 RETURNING id`,[user,amount]);
 if(r.rowCount!==1)throw fail(409,'Solde indisponible ou plafond atteint.');
}
function grantsFor(plan,participantSkin,winnerSkin){
 const recipients=plan.eligibleIds.map(userId=>({userId,place:userId===plan.championId?1:null}));
 const grants=selectedSkinGrants(recipients,participantSkin,winnerSkin);
 // Un meme skin choisi pour participation et victoire ne peut etre attribue deux fois.
 const merged=new Map();
 for(const grant of grants){
  const key=grant.userId+':'+grant.skinId;
  if(!merged.has(key)||grant.kind==='winner')merged.set(key,grant);
 }
 return [...merged.values()].sort((a,b)=>a.userId-b.userId||a.skinId.localeCompare(b.skinId));
}
export async function settlePenaltyTournamentAwards(tournamentId){
 if(!realTournamentFeaturesEnabled())return {enabled:false,credited:false};
 const tournament=id(tournamentId);
 await ensurePenaltyAwardTables();
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  // Verrou commun avec tirages, annulations et progression : aucun classement mouvant.
  const t=(await c.query(`SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE`,[tournament])).rows[0];
  if(!t || t.game!=='penalty'||t.status!=='published'||t.cancelled_at||t.deleted_at)
   throw fail(409,'Tournoi indisponible.');
  const existing=(await c.query(`SELECT * FROM maf_tournament_penalty_award_batches
    WHERE tournament_id=$1 FOR UPDATE`,[tournament])).rows[0];
  if(existing?.status==='credited'){
   await c.query('COMMIT');return {credited:true,alreadyCredited:true,tournamentId:tournament};
  }
  // Toutes les pieces du dossier sont lues dans la transaction et revérifiees.
  const draw=(await c.query(`SELECT * FROM maf_tournament_penalty_draws
    WHERE tournament_id=$1`,[tournament])).rows[0];
  const entries=(await c.query(`SELECT user_id,fee_paid FROM maf_tournament_entries
    WHERE tournament_id=$1 AND status='reserved' ORDER BY user_id FOR UPDATE`,[tournament])).rows;
  if(!draw || entries.some(x=>Number(x.fee_paid)!==Number(t.entry_fee)) ||
    ![200,500].includes(Number(t.entry_fee)))throw fail(409,'Mises non concordantes.');
  const ref=(await c.query(`SELECT count(*)::integer AS n FROM maf_tournament_refunds
    WHERE tournament_id=$1 AND user_id=ANY($2::integer[])`,[tournament,entries.map(x=>Number(x.user_id))])).rows[0];
  if(Number(ref.n)!==0)throw fail(409,'Joueur rembourse parmi les inscrits retenus.');
  const matches=(await c.query(`SELECT * FROM maf_tournament_penalty_matches
    WHERE tournament_id=$1 ORDER BY round_no,match_no FOR UPDATE`,[tournament])).rows;
  const byes=(await c.query(`SELECT * FROM maf_tournament_penalty_byes WHERE tournament_id=$1
    ORDER BY round_no FOR UPDATE`,[tournament])).rows;
  const champion=(await c.query(`SELECT * FROM maf_tournament_penalty_champions
    WHERE tournament_id=$1 FOR UPDATE`,[tournament])).rows[0];
  let plan;
  try{plan=certifyPenaltyBracket(entries,draw,matches,byes,champion);}catch(e){throw fail(409,e.message);}
  if(plan.fee!==Number(t.entry_fee))throw fail(409,'Mise du tournoi modifiee.');
  const organizerId=Number(await ownerAccountId(c));
  if(!Number.isSafeInteger(organizerId)||organizerId<1)throw fail(409,'Organisateur introuvable.');
  // Le budget, les crediteurs et la certification sont atomiques.
  const grants=grantsFor(plan,t.participant_skin_id,t.winner_skin_id);
  for(const line of plan.lines){
   await c.query(`INSERT INTO maf_tournament_penalty_award_lines
     (tournament_id,user_id,place,role,amount_franc) VALUES($1,$2,$3,$4,$5)`,
     [tournament,line.userId,line.place,line.role,line.amountFranc]);
  }
  for(const grant of grants){
   await c.query(`INSERT INTO maf_tournament_penalty_skin_grants
     (tournament_id,user_id,skin_id,prize_kind) VALUES($1,$2,$3,$4)`,
     [tournament,grant.userId,grant.skinId,grant.kind]);
   await c.query(`INSERT INTO maf_studio_skin_unlocks(user_id,skin_id,tournament_id,prize_kind)
     VALUES($1,$2,$3,$4) ON CONFLICT(user_id,skin_id) DO NOTHING`,
     [grant.userId,grant.skinId,tournament,grant.kind]);
  }
  // Verrouiller les comptes par ID croissant reduit le risque d'interblocage.
  const creditByUser=new Map([[organizerId,plan.organizerFranc]]);
  for(const line of plan.lines)creditByUser.set(line.userId,(creditByUser.get(line.userId)||0)+line.amountFranc);
  for(const [userId,amount] of [...creditByUser].sort((a,b)=>a[0]-b[0]))await credit(c,userId,amount);
  await c.query(`INSERT INTO maf_tournament_penalty_award_batches
   (tournament_id,champion_id,final_match_id,participants,fee,pot_franc,organizer_franc)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,
   [tournament,plan.championId,plan.finalMatchId,plan.participants,plan.fee,plan.potFranc,plan.organizerFranc]);
  await c.query(`UPDATE maf_tournament_penalty_champions SET awarded_at=COALESCE(awarded_at,now())
    WHERE tournament_id=$1`,[tournament]);
  await c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
    VALUES('system:tournament','tournament_penalty_awards_credited',$1::jsonb)`,
    [JSON.stringify({tournament_id:tournament,champion_id:plan.championId,pot_franc:plan.potFranc,
      organizer_id:organizerId,organizer_franc:plan.organizerFranc,
      lines:plan.lines.map(x=>({user_id:x.userId,role:x.role,amount:x.amountFranc})),
      skins:grants.length})]);
  await c.query('COMMIT');
  return {credited:true,alreadyCredited:false,tournamentId:tournament,
    players:plan.participants,potFranc:plan.potFranc,championId:plan.championId};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export function maintainPenaltyTournamentAwards(){
 if(processing)return processing;
 processing=(async()=>{
  if(!realTournamentFeaturesEnabled())return {enabled:false};
  await ensurePenaltyAwardTables();
  const {rows}=await pool.query(`SELECT t.id FROM maf_tournaments t
   JOIN maf_tournament_penalty_champions ch ON ch.tournament_id=t.id
   LEFT JOIN maf_tournament_penalty_award_batches b ON b.tournament_id=t.id
   WHERE t.game='penalty' AND t.status='published' AND t.cancelled_at IS NULL
    AND t.deleted_at IS NULL AND b.tournament_id IS NULL
   ORDER BY t.id LIMIT 100`);
  let credited=0,blocked=0;
  for(const t of rows){
   try{const result=await settlePenaltyTournamentAwards(Number(t.id));if(result.credited)credited++;}
   catch(e){blocked++;console.error('Paiement Tir-au-but bloque',t.id,e.message);}
  }
  return {credited,blocked};
 })().finally(()=>{processing=null;});
 return processing;
}

tournamentPenaltyAwardsRouter.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
tournamentPenaltyAwardsRouter.get('/penalty/awards/preview',route(async(req,res)=>{
 const players=Number(req.query.players),fee=Number(req.query.fee);
 if(!Number.isInteger(players)||players<2||players>32||players%2||![200,500].includes(fee))
  throw fail(400,'Nombre de joueurs ou mise invalide.');
 const ids=Array.from({length:players},(_,i)=>i+1);
 let remaining=players;while(remaining>4)remaining=Math.ceil(remaining/2);
 const semis=remaining===2?[]:remaining===3?[3]:[3,4];
 const plan=penaltyAwardBudget(ids,fee,1,2,semis);
 res.json({participants:players,fee,potFranc:plan.potFranc,
  organizerFranc:plan.organizerFranc,prizes:plan.lines.map(x=>({role:x.role,place:x.place,amountFranc:x.amountFranc}))});
}));
tournamentPenaltyAwardsRouter.get('/penalty/awards/history',requireSession,route(async(req,res)=>{
 await ensurePenaltyAwardTables();
 const {rows}=await pool.query(`SELECT l.tournament_id,t.title,t.starts_at,l.place,l.role,l.amount_franc,
    l.credited_at,b.pot_franc FROM maf_tournament_penalty_award_lines l
    JOIN maf_tournaments t ON t.id=l.tournament_id
    JOIN maf_tournament_penalty_award_batches b ON b.tournament_id=l.tournament_id
    WHERE l.user_id=$1 AND b.status='credited' ORDER BY l.credited_at DESC LIMIT 60`,[req.userId]);
 res.json({awards:rows.map(r=>({tournamentId:Number(r.tournament_id),title:r.title,
  at:r.credited_at,place:Number(r.place),role:r.role,amountFranc:Number(r.amount_franc),
  potFranc:Number(r.pot_franc)}))});
}));
tournamentPenaltyAwardsRouter.get('/penalty/awards/:id',requireSession,route(async(req,res)=>{
 await ensurePenaltyAwardTables();
 const tournament=id(req.params.id);
 const t=(await pool.query(`SELECT id,title,game FROM maf_tournaments WHERE id=$1`,[tournament])).rows[0];
 if(!t||t.game!=='penalty')throw fail(404,'Tournoi introuvable.');
 const b=(await pool.query(`SELECT * FROM maf_tournament_penalty_award_batches WHERE tournament_id=$1`,[tournament])).rows[0];
 if(!b)return res.json({tournamentId:tournament,status:'pending'});
 const {rows}=await pool.query(`SELECT l.place,l.role,l.amount_franc,u.pseudo AS name,l.user_id
  FROM maf_tournament_penalty_award_lines l JOIN maf_users u ON u.id=l.user_id
  WHERE l.tournament_id=$1 ORDER BY l.place,l.user_id`,[tournament]);
 const mine=rows.find(r=>Number(r.user_id)===Number(req.userId));
 res.json({tournamentId:tournament,status:b.status,participants:Number(b.participants),
  potFranc:Number(b.pot_franc),organizerFranc:Number(b.organizer_franc),
  champion:rows.find(x=>Number(x.place)===1)?.name||null,
  winners:rows.map(r=>({place:Number(r.place),role:r.role,amountFranc:Number(r.amount_franc),name:r.name})),
  myAward:mine?{place:Number(mine.place),amountFranc:Number(mine.amount_franc)}:null,
  creditedAt:b.credited_at});
}));
// Acces proprietaire : vue sur l'etat, aucune route pour saisir un vainqueur ou ordonner un paiement.
tournamentPenaltyAwardsRouter.get('/penalty/awards/owner/:id',requireSession,route(async(req,res)=>{
 if(!await isOwnerAccount(req.userId,pool))throw fail(403,'Acces reserve au proprietaire.');
 await ensurePenaltyAwardTables();
 const tournament=id(req.params.id);
 const b=(await pool.query('SELECT * FROM maf_tournament_penalty_award_batches WHERE tournament_id=$1',[tournament])).rows[0];
 res.json({tournamentId:tournament,credited:Boolean(b),creditedAt:b?.credited_at||null,
   potFranc:b?Number(b.pot_franc):null,organizerFranc:b?Number(b.organizer_franc):null});
}));
