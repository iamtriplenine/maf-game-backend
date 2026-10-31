import { isOwnerAccount } from './accountRoles.js';
// Tournoi officiel a deux comptes - isolement des tournois classiques.
// Duels et versements actives; MAF_DUEL_EMERGENCY_STOP=true permet un arret urgent.
// Aucune action navigateur n'autorise directement une attribution de solde.
import crypto from 'node:crypto';
import {Router} from 'express';
import {pool} from './db.js';
import {requireSession} from './auth.js';
import {ensureWallet} from './wallet.js';
import {createGame,rollDice,buy,build,sell,endTurn,giveUp} from './engine.js';
import {validateDuel,duelRewards,duelStartDecision,participantsAreValid,DUEL_STAKE} from './tournamentDuelRules.js';
import {duelArchiveDecision} from './tournamentDuelArchiveRules.js';
import { legacyGiftHiddenBefore } from './ownerGifts.js';
export const tournamentDuelRouter=Router();
export const duelPayoutEnabled=()=>process.env.MAF_DUEL_EMERGENCY_STOP!=='true';
export const duelEnabled=()=>duelPayoutEnabled();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const wrap=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){
 if(e.status)return res.status(e.status).json({error:e.message});
 if(e.code==='23505')return res.status(409).json({error:'Inscription deja enregistree.'});
 next(e);
}};
const idOf=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant invalide.');return n;};
const iso=t=>new Date(t).toISOString();
let ready;
export function ensureTournamentDuels(){
 if(!ready)ready=(async()=>{
  if(!pool)throw fail(503,'Base indisponible.');
  await ensureWallet();const c=await pool.connect();
  try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(62498537)');
   await c.query(`CREATE TABLE IF NOT EXISTS maf_monopoly_duels (
    id bigserial PRIMARY KEY, title varchar(80) NOT NULL, starts_at timestamptz NOT NULL,
    gifts_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','published','playing','finished','cancelled','paid')),
    revision integer NOT NULL DEFAULT 1, game jsonb, game_revision integer NOT NULL DEFAULT 0,
    winner_id integer REFERENCES maf_users(id), started_at timestamptz, ended_at timestamptz,
    paid_at timestamptz, created_by integer NOT NULL REFERENCES maf_users(id),
    created_at timestamptz NOT NULL DEFAULT now(), CHECK(gifts_at>starts_at))`);
   // MAF_DUEL_ARCHIVE_V1 : conserver les opérations, masquer seulement l'annonce.
   await c.query(`ALTER TABLE maf_monopoly_duels ADD COLUMN IF NOT EXISTS hidden_at timestamptz`);
   await c.query(`CREATE TABLE IF NOT EXISTS maf_monopoly_duel_entries (
    duel_id bigint NOT NULL REFERENCES maf_monopoly_duels(id), user_id integer NOT NULL REFERENCES maf_users(id),
    status text NOT NULL CHECK(status IN ('reserved','refunded')), created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(duel_id,user_id))`);
   await c.query(`CREATE TABLE IF NOT EXISTS maf_monopoly_duel_awards (
    duel_id bigint NOT NULL REFERENCES maf_monopoly_duels(id), user_id integer NOT NULL REFERENCES maf_users(id),
    place smallint NOT NULL CHECK(place IN (1,2)), amount integer NOT NULL CHECK(amount IN (900,100)),
    credited_at timestamptz, PRIMARY KEY(duel_id,user_id),UNIQUE(duel_id,place))`);
   await c.query(`CREATE TABLE IF NOT EXISTS maf_monopoly_duel_openings (
    duel_id bigint NOT NULL REFERENCES maf_monopoly_duels(id), user_id integer NOT NULL REFERENCES maf_users(id),
    opened_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(duel_id,user_id))`);
   await c.query(`CREATE TABLE IF NOT EXISTS maf_monopoly_duel_notices (
    id bigserial PRIMARY KEY, duel_id bigint NOT NULL REFERENCES maf_monopoly_duels(id),
    user_id integer NOT NULL REFERENCES maf_users(id),kind varchar(32) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(duel_id,user_id,kind))`);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 })().catch(e=>{ready=null;throw e;});
 return ready;
}
async function owner(userId){
 if (!await isOwnerAccount(userId, pool))throw fail(403,'Compte 999 requis.');
}
async function members(c,id){return (await c.query(`SELECT e.user_id,u.pseudo FROM maf_monopoly_duel_entries e
 JOIN maf_users u ON u.id=e.user_id WHERE e.duel_id=$1 AND e.status='reserved'
 ORDER BY e.created_at,e.user_id`,[id])).rows;}
async function notice(c,id,ids,kind){
 for(const uid of ids)await c.query(`INSERT INTO maf_monopoly_duel_notices(duel_id,user_id,kind)
 VALUES($1,$2,$3) ON CONFLICT(duel_id,user_id,kind) DO NOTHING`,[id,uid,kind]);
}
async function audit(c,event,detail){await c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
 VALUES($1,$2,$3::jsonb)`,['system:duel',event,JSON.stringify(detail)]);}
async function refundLocked(c,duel,rows,reason){
 // Le duel est FOR UPDATE par l'appelant; les reservations aussi ne peuvent plus changer.
 for(const r of rows){
  const userId=Number(r.user_id);
  const row=await c.query(`UPDATE maf_monopoly_duel_entries SET status='refunded'
    WHERE duel_id=$1 AND user_id=$2 AND status='reserved' RETURNING user_id`,[duel.id,userId]);
  if(!row.rowCount)continue;
  await c.query('UPDATE maf_users SET balance=balance+$2 WHERE id=$1',[userId,DUEL_STAKE]);
  await audit(c,'duel_refund',{duelId:Number(duel.id),userId,amount:DUEL_STAKE,reason});
 }
 await c.query(`UPDATE maf_monopoly_duels SET status='cancelled',revision=revision+1 WHERE id=$1`,[duel.id]);
 await notice(c,duel.id,rows.map(r=>Number(r.user_id)),'cancelled_refunded');
}
async function settleLocked(c,duel,rows,match){
 const game=match.game;
 if(game.phase!=='over')return;
 if(!Number.isInteger(game.winner)||game.winner<0){await refundLocked(c,duel,rows,'no_winner');return;}
 const winnerId=Number(rows[game.winner]?.user_id);
 const plan=duelRewards(rows,winnerId);
 for(const x of plan)await c.query(`INSERT INTO maf_monopoly_duel_awards(duel_id,user_id,place,amount)
 VALUES($1,$2,$3,$4) ON CONFLICT(duel_id,user_id) DO NOTHING`,[duel.id,x.userId,x.place,x.amount]);
 await c.query(`UPDATE maf_monopoly_duels SET status='finished',winner_id=$2,ended_at=now(),game=$3::jsonb,
 revision=revision+1 WHERE id=$1`,[duel.id,winnerId,JSON.stringify(match)]);
 await notice(c,duel.id,rows.map(r=>Number(r.user_id)),'results_ready');
}
async function updateOne(id){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const duel=(await c.query('SELECT * FROM maf_monopoly_duels WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!duel){await c.query('COMMIT');return;}
  const rows=await members(c,id);
  if(duel.status==='published' && new Date(duel.starts_at).getTime()<=Date.now()){
   if(!duelEnabled()||duelStartDecision({startsAt:iso(duel.starts_at),count:rows.length})==='refund'){
    await refundLocked(c,duel,rows,duelEnabled()?'insufficient_players':'duel_disabled');
   } else if(participantsAreValid(rows)){
    // Un seul INSERT logique: l'etat est conserve dans la ligne verrouillee du duel.
    const game=createGame({names:rows.map(x=>x.pseudo),dice:2,rng:()=>crypto.randomInt(0,1_000_000)/1_000_000});
    const state={seats:rows.map((x,i)=>({userId:Number(x.user_id),name:x.pseudo,seat:i})),game};
    await c.query(`UPDATE maf_monopoly_duels SET status='playing',game=$2::jsonb,game_revision=1,
 started_at=now(),revision=revision+1 WHERE id=$1`,[id,JSON.stringify(state)]);
    await notice(c,id,rows.map(r=>Number(r.user_id)),'started');
   }
  }
  if(duel.status==='finished' && duelPayoutEnabled() && new Date(duel.gifts_at).getTime()<=Date.now() && !duel.paid_at){
   const awards=(await c.query('SELECT user_id,place,amount,credited_at FROM maf_monopoly_duel_awards WHERE duel_id=$1 ORDER BY place FOR UPDATE',[id])).rows;
   if(awards.length!==2||!participantsAreValid(rows)||awards.some((a,i)=>a.place!==i+1)||awards.reduce((n,x)=>n+Number(x.amount),0)!==1000)
    throw fail(409,'Recompenses invalides : versement bloque.');
   // Les deux credits et leur validation sont dans la meme transaction.
   for(const line of awards){
    if(line.credited_at)throw fail(409,'Versement partiel detecte : intervention necessaire.');
    await c.query('UPDATE maf_users SET balance=balance+$2 WHERE id=$1',[line.user_id,line.amount]);
    await c.query('UPDATE maf_monopoly_duel_awards SET credited_at=now() WHERE duel_id=$1 AND user_id=$2',[id,line.user_id]);
    await audit(c,'duel_reward',{duelId:id,userId:Number(line.user_id),place:line.place,amount:line.amount});
   }
   await c.query(`UPDATE maf_monopoly_duels SET status='paid',paid_at=now(),revision=revision+1 WHERE id=$1`,[id]);
   await notice(c,id,rows.map(r=>Number(r.user_id)),'gift_available');
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
let maintenance=null;
export async function maintainTournamentDuels(){
 if(maintenance)return maintenance;
 maintenance=(async()=>{
  await ensureTournamentDuels();
  const rows=(await pool.query(`SELECT id FROM maf_monopoly_duels
   WHERE (status='published' AND starts_at<=now()) OR
         (status='finished' AND gifts_at<=now() AND paid_at IS NULL)
   ORDER BY id LIMIT 100`)).rows;
  for(const row of rows)await updateOne(Number(row.id));
  return {enabled:duelEnabled(),payoutsEnabled:duelPayoutEnabled(),checked:rows.length};
 })().finally(()=>{maintenance=null;});
 return maintenance;
}
function view(t,count){return {id:Number(t.id),title:t.title,revision:t.revision,startsAt:iso(t.starts_at),giftsAt:iso(t.gifts_at),
 status:t.status,capacity:2,registered:Number(count),entryFee:DUEL_STAKE,enabled:duelEnabled(),
 winnerId:t.status==='finished'||t.status==='paid'?t.winner_id:null};}
const select=`SELECT d.*,(SELECT count(*)::int FROM maf_monopoly_duel_entries e
 WHERE e.duel_id=d.id AND e.status='reserved') AS registered FROM maf_monopoly_duels d`;
tournamentDuelRouter.use((req,res,next)=>{res.set('Cache-Control','no-store');ensureTournamentDuels().then(()=>next(),next);});
tournamentDuelRouter.get('/',wrap(async(req,res)=>{
 const rows=(await pool.query(select+" WHERE d.status <> 'draft' AND d.hidden_at IS NULL ORDER BY d.starts_at DESC LIMIT 40")).rows;
 res.json({duels:rows.map(x=>view(x,x.registered)),serverNow:Date.now()});
}));
tournamentDuelRouter.get('/owner',requireSession,wrap(async(req,res)=>{
 await owner(req.userId);const rows=(await pool.query(select+' WHERE d.hidden_at IS NULL ORDER BY d.created_at DESC LIMIT 200')).rows;
 res.json({duels:rows.map(x=>view(x,x.registered)),serverNow:Date.now()});
}));
tournamentDuelRouter.post('/owner',requireSession,wrap(async(req,res)=>{
 await owner(req.userId);
 const t=req.body||{};
 if(typeof t.title!=='string'||!t.title.trim()||t.title.trim().length>80)throw fail(400,'Titre invalide.');
 let times;try{times=validateDuel(t);}catch(e){throw fail(400,e.message);}
 if(!['draft','published'].includes(t.status))throw fail(400,'Statut invalide.');
 if(t.status==='published'&&!duelEnabled())throw fail(409,'Duel payant desactive sur le serveur.');
 const row=(await pool.query(`INSERT INTO maf_monopoly_duels(title,starts_at,gifts_at,status,created_by)
 VALUES($1,$2,$3,$4,$5) RETURNING *`,[t.title.trim(),times.startsAt,times.giftsAt,t.status,req.userId])).rows[0];
 res.status(201).json({duel:view(row,0)});
}));
tournamentDuelRouter.put('/owner/:id',requireSession,wrap(async(req,res)=>{
 await owner(req.userId);
 const id=idOf(req.params.id),b=req.body||{};
 if(!Number.isSafeInteger(b.revision)||b.revision<1)throw fail(400,'Version du tournoi requise.');
 if(typeof b.title!=='string'||!b.title.trim()||b.title.trim().length>80)throw fail(400,'Titre invalide.');
 let times;try{times=validateDuel(b);}catch(e){throw fail(400,e.message);}
 if(!['draft','published'].includes(b.status))throw fail(400,'Statut invalide.');
 if(b.status==='published'&&!duelEnabled())throw fail(409,'Le duel payant n est pas encore active sur le serveur.');
 const c=await pool.connect();
 try{await c.query('BEGIN');
  const t=(await c.query('SELECT * FROM maf_monopoly_duels WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!t)throw fail(404,'Duel introuvable.');
  if(t.revision!==b.revision)throw fail(409,'Duel modifie ailleurs. Recharge le formulaire.');
  if(!['draft','published'].includes(t.status))throw fail(409,'Duel deja demarre ou termine.');
  if((await c.query('SELECT 1 FROM maf_monopoly_duel_entries WHERE duel_id=$1 LIMIT 1',[id])).rowCount)
   throw fail(409,'Duel avec inscriptions : modification bloquee.');
  const result=(await c.query(`UPDATE maf_monopoly_duels SET title=$2,starts_at=$3,gifts_at=$4,status=$5,
    revision=revision+1 WHERE id=$1 RETURNING *`,[id,b.title.trim(),times.startsAt,times.giftsAt,b.status])).rows[0];
  await c.query('COMMIT');res.json({duel:view(result,0)});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
// Retrait logique : l'historique, les inscriptions, les cadeaux et les versements restent intacts.
tournamentDuelRouter.post('/owner/:id/archive',requireSession,wrap(async(req,res)=>{
 await owner(req.userId);
 const id=idOf(req.params.id),c=await pool.connect();
 try {
  await c.query('BEGIN');
  const d=(await c.query('SELECT * FROM maf_monopoly_duels WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!d)throw fail(404,'Duel introuvable.');
  if(d.hidden_at){await c.query('COMMIT');return res.json({archived:true,alreadyArchived:true,refunded:0,refundTotal:0});}
  // Un client a jour fournit revision; les anciens appels restent compatibles.
  if(req.body?.revision != null && (!Number.isSafeInteger(req.body.revision) || req.body.revision !== d.revision))
   throw fail(409,'Duel modifie depuis l ouverture de la liste. Recharge et reessaie.');
  const awards=(await c.query('SELECT 1 FROM maf_monopoly_duel_awards WHERE duel_id=$1 LIMIT 1',[id])).rowCount;
  const decision=duelArchiveDecision({status:d.status,hasAwards:Boolean(awards),paidAt:Boolean(d.paid_at),winnerId:d.winner_id});
  if(!decision.allowed)throw fail(409,decision.reason);
  if(d.status==='draft'){
   const entries=(await c.query('SELECT 1 FROM maf_monopoly_duel_entries WHERE duel_id=$1 LIMIT 1',[id])).rowCount;
   if(entries)throw fail(409,'Un brouillon avec une inscription ne peut pas etre masque.');
  }
  let refunded=0;
  if(decision.refund){
   const rows=await members(c,id);
   refunded=rows.length;
   // Verrouillage du duel, remboursement et masquage dans une meme transaction.
   // Un duel en cours n'a pas encore ete paye; en cas d'incoherence, blocage ci-dessus.
   await refundLocked(c,d,rows,'owner_archived');
  }
  // Une finale terminee peut etre masquee avant le versement: maintenance continue a payer.
  await c.query('UPDATE maf_monopoly_duels SET hidden_at=now(),revision=revision+1 WHERE id=$1',[id]);
  await audit(c,'duel_archived',{duelId:id,status:d.status,refunded});
  await c.query('COMMIT');
  res.json({archived:true,financialHistoryPreserved:true,payoutPending:d.status==='finished',refunded,refundTotal:refunded*DUEL_STAKE});
 } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
tournamentDuelRouter.post('/owner/:id/cancel',requireSession,wrap(async(req,res)=>{
 await owner(req.userId);
 const id=idOf(req.params.id),c=await pool.connect();
 try{await c.query('BEGIN');
  const d=(await c.query('SELECT * FROM maf_monopoly_duels WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!d)throw fail(404,'Duel introuvable.');
  if(d.status==='cancelled'){await c.query('COMMIT');return res.json({cancelled:true,alreadyCancelled:true});}
  if(!['draft','published'].includes(d.status))throw fail(409,'Impossible d annuler une partie deja commencee.');
  const rows=await members(c,id);
  await refundLocked(c,d,rows,'owner_cancelled');
  await c.query('COMMIT');res.json({cancelled:true,refunded:rows.length});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
tournamentDuelRouter.post('/:id/reserve',requireSession,wrap(async(req,res)=>{
 if(!duelEnabled())throw fail(503,'Reservations du duel indisponibles.');
 const id=idOf(req.params.id),c=await pool.connect();
 try{
  await c.query('BEGIN');
  const t=(await c.query('SELECT * FROM maf_monopoly_duels WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!t||t.status!=='published'||Date.now()>=new Date(t.starts_at).getTime())throw fail(409,'Les inscriptions sont closes.');
  const old=(await c.query('SELECT status FROM maf_monopoly_duel_entries WHERE duel_id=$1 AND user_id=$2',[id,req.userId])).rows[0];
  if(old?.status==='reserved'){await c.query('COMMIT');return res.json({registered:true,alreadyReserved:true});}
  if(old)throw fail(409,'Une inscription a deja ete remboursee.');
  const count=(await c.query("SELECT count(*)::int AS n FROM maf_monopoly_duel_entries WHERE duel_id=$1 AND status='reserved'",[id])).rows[0].n;
  if(count>=2)throw fail(409,'Les deux places sont prises.');
  const other=(await c.query(`SELECT 1 FROM maf_monopoly_duel_entries e
   JOIN maf_monopoly_duels d ON d.id=e.duel_id WHERE e.user_id=$1 AND e.status='reserved'
   AND d.id<>$2 AND d.status IN ('published','playing') LIMIT 1`,[req.userId,id])).rowCount;
  if(other)throw fail(409,'Tu participes deja a un autre duel actif.');
  const u=(await c.query('SELECT balance FROM maf_users WHERE id=$1 FOR UPDATE',[req.userId])).rows[0];
  if(!u)throw fail(401,'Compte inexistant.');
  if(u.balance<DUEL_STAKE)throw fail(402,'Solde reel insuffisant pour reserver 500 F.');
  await c.query('UPDATE maf_users SET balance=balance-$2 WHERE id=$1',[req.userId,DUEL_STAKE]);
  await c.query("INSERT INTO maf_monopoly_duel_entries(duel_id,user_id,status) VALUES($1,$2,'reserved')",[id,req.userId]);
  await audit(c,'duel_stake',{duelId:id,userId:req.userId,amount:DUEL_STAKE});
  await notice(c,id,[req.userId],'reserved');
  if(count===1){const membersNow=await members(c,id);await notice(c,id,membersNow.map(x=>Number(x.user_id)),'full');}
  await c.query('COMMIT');res.json({registered:true,alreadyReserved:false});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
tournamentDuelRouter.get('/mine',requireSession,wrap(async(req,res)=>{
 const rows=(await pool.query(`SELECT d.id,d.title,d.status,d.starts_at,d.gifts_at,d.winner_id,d.paid_at,e.status AS entry_status
 FROM maf_monopoly_duel_entries e JOIN maf_monopoly_duels d ON d.id=e.duel_id
 WHERE e.user_id=$1 ORDER BY d.starts_at DESC LIMIT 30`,[req.userId])).rows;
 res.json({duels:rows.map(r=>({id:Number(r.id),title:r.title,status:r.status,startsAt:r.starts_at,
  giftsAt:r.gifts_at,winnerId:r.winner_id,entryStatus:r.entry_status,paidAt:r.paid_at}))});
}));
tournamentDuelRouter.get('/:id/game',requireSession,wrap(async(req,res)=>{
 const id=idOf(req.params.id);const t=(await pool.query('SELECT * FROM maf_monopoly_duels WHERE id=$1',[id])).rows[0];
 if(!t)throw fail(404,'Duel introuvable.');
 const p=(await pool.query("SELECT 1 FROM maf_monopoly_duel_entries WHERE duel_id=$1 AND user_id=$2 AND status='reserved'",[id,req.userId])).rowCount;
 if(!p)throw fail(403,'Tu ne participes pas a ce duel.');
 const game=t.game?{...t.game,game:{...t.game.game,decks:undefined}}:null;
 res.json({id,status:t.status,game,revision:t.game_revision,startsAt:t.starts_at,giftsAt:t.gifts_at,
  winnerId:t.winner_id,serverNow:Date.now()});
}));
tournamentDuelRouter.post('/:id/action',requireSession,wrap(async(req,res)=>{
 if(!duelEnabled())throw fail(403,'Duel non active.');
 const id=idOf(req.params.id),action=req.body?.action,revision=req.body?.revision;
 if(!Number.isSafeInteger(revision)||revision<1)throw fail(400,'Numero de version requis.');
 if(!['roll','buy','build','sell','end','abandon'].includes(action))throw fail(400,'Action inconnue.');
 const square=req.body?.square;
 if(['build','sell'].includes(action)&&(!Number.isInteger(square)||square<0||square>39))throw fail(400,'Terrain invalide.');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');const t=(await c.query('SELECT * FROM maf_monopoly_duels WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!t||t.status!=='playing'||!t.game)throw fail(409,'Le duel n est pas en cours.');
  if(t.game_revision!==revision)throw fail(409,'Partie mise a jour. Recharge-la.');
  const rows=await members(c,id);if(!participantsAreValid(rows))throw fail(409,'Participants incoherents.');
  const match=t.game,idx=match.seats.findIndex(x=>x.userId===req.userId);
  if(idx<0)throw fail(403,'Tu ne participes pas au duel.');
  if(match.game.current!==idx||match.game.phase==='over'||match.game.players[idx]?.bankrupt)throw fail(409,'Ce n est pas ton tour.');
  let next;
  try{
   const rand=()=>crypto.randomInt(0,1_000_000)/1_000_000;
   if(action==='roll')next=rollDice(match.game,{rng:rand});
   if(action==='buy')next=buy(match.game);
   if(action==='build')next=build(match.game,square);
   if(action==='sell')next=sell(match.game,square);
   if(action==='end')next=endTurn(match.game);
   if(action==='abandon')next=giveUp(match.game);
  }catch(e){throw fail(409,'Action invalide dans cette phase.');}
  if(!next||next===match.game)throw fail(409,'Action impossible dans cette phase.');
  await c.query(`UPDATE maf_monopoly_duels SET game=$2::jsonb,game_revision=game_revision+1 WHERE id=$1`,[id,JSON.stringify({...match,game:next})]);
  if(next.phase==='over')await settleLocked(c,t,rows,{...match,game:next});
  await c.query('COMMIT');res.json({ok:true,revision:revision+1,finished:next.phase==='over'});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
tournamentDuelRouter.get('/notices/mine',requireSession,wrap(async(req,res)=>{
 const rows=(await pool.query(`SELECT n.id,n.duel_id,n.kind,n.created_at,d.title
 FROM maf_monopoly_duel_notices n JOIN maf_monopoly_duels d ON d.id=n.duel_id
 WHERE n.user_id=$1 AND d.hidden_at IS NULL ORDER BY n.created_at DESC LIMIT 20`,[req.userId])).rows;
 res.json({notices:rows});
}));
tournamentDuelRouter.get('/gifts/mine',requireSession,wrap(async(req,res)=>{
 const rows=(await pool.query(`SELECT d.id,d.title,d.created_at,d.status,d.gifts_at,d.paid_at,a.place,a.amount,a.credited_at,o.opened_at
 FROM maf_monopoly_duel_entries e JOIN maf_monopoly_duels d ON d.id=e.duel_id
 LEFT JOIN maf_monopoly_duel_awards a ON a.duel_id=e.duel_id AND a.user_id=e.user_id
 LEFT JOIN maf_monopoly_duel_openings o ON o.duel_id=e.duel_id AND o.user_id=e.user_id
 WHERE e.user_id=$1 AND e.status='reserved' ORDER BY d.starts_at DESC LIMIT 30`,[req.userId])).rows;
 const cutoff=await legacyGiftHiddenBefore();
 res.json({gifts:rows.filter(r=>new Date(r.created_at).getTime()>=cutoff).map(r=>({duelId:Number(r.id),title:r.title,releaseAt:r.gifts_at,
  status:r.opened_at?'opened':r.credited_at?'ready':r.status==='cancelled'?'cancelled':'waiting',
  place:r.place,amount:r.credited_at?r.amount:null,openedAt:r.opened_at,skinsPlanned:2}))});
}));
tournamentDuelRouter.post('/gifts/:id/open',requireSession,wrap(async(req,res)=>{
 const id=idOf(req.params.id),c=await pool.connect();
 try{
  await c.query('BEGIN');
  const t=(await c.query('SELECT * FROM maf_monopoly_duels WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!t||t.status!=='paid'||!t.paid_at||Date.now()<new Date(t.gifts_at).getTime())throw fail(409,'Cadeau indisponible.');
  const a=(await c.query('SELECT amount,place,credited_at FROM maf_monopoly_duel_awards WHERE duel_id=$1 AND user_id=$2',[id,req.userId])).rows[0];
  if(!a?.credited_at)throw fail(403,'Cadeau non attribue a ce compte.');
  await c.query(`INSERT INTO maf_monopoly_duel_openings(duel_id,user_id) VALUES($1,$2)
   ON CONFLICT(duel_id,user_id) DO NOTHING`,[id,req.userId]);
  await c.query('COMMIT');res.json({ok:true,place:a.place,amount:a.amount,bonus:0,
   message:'Le cadeau confirme les credits deja verses; aucun second credit.'});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
