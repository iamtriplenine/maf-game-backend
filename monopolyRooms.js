// Salon Monopoly 2 a 4 joueurs. Le moteur et les mouvements d'argent sont autoritaires sur le serveur.
import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from './db.js';
import { ensureTable, requireSession } from './auth.js';
import { ensureWallet } from './wallet.js';
import { validateSetup, proposeStart, voteStart } from './monopolyRoomRules.js';
import { createGame, rollDice, buy, build, sell, endTurn, giveUp, canBuy, buildOptions, sellOptions } from './engine.js';
import { initPresence, setPresence, expirePresence } from './monopolyPresence.js';
import { normalizeTurnClock, tickTurnClock } from './monopolyTurnClock.js';
import { winAccessForRoom } from './winPractice.js';
import { authorizedWinDice } from './winDice.js';

export const monopolyRoomsRouter = Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const rand = () => crypto.randomInt(0, 16777216) / 16777216;
const parseId = value => { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'Salon invalide.'); return id; };
const handler = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error:e.message }); if (e.code === '23505') return res.status(409).json({error:'Salon deja existant.'}); next(e); } };
let schemaReady = null;
export function ensureMonopolyRooms() {
  if (!schemaReady) schemaReady = (async () => {
    await ensureTable(); await ensureWallet();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498449)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_monopoly_rooms (
        id bigserial PRIMARY KEY, code varchar(6) NOT NULL UNIQUE,
        host_id integer NOT NULL REFERENCES maf_users(id),
        max_players smallint NOT NULL CHECK (max_players BETWEEN 2 AND 4),
        stake integer NOT NULL CHECK (stake BETWEEN 100 AND 1000000),
        status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','proposed','playing','finished','closed')),
        proposal jsonb, match_state jsonb, escrow integer NOT NULL DEFAULT 0,
        winner_id integer REFERENCES maf_users(id), payout integer NOT NULL DEFAULT 0,
        settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_monopoly_players (
        room_id bigint NOT NULL REFERENCES maf_monopoly_rooms(id) ON DELETE CASCADE,
        user_id integer NOT NULL REFERENCES maf_users(id),
        seat smallint NOT NULL CHECK (seat BETWEEN 0 AND 3),
        PRIMARY KEY(room_id,user_id), UNIQUE(room_id,seat)
      )`);
      await c.query(`CREATE INDEX IF NOT EXISTS maf_monopoly_public ON maf_monopoly_rooms(status,created_at DESC)`);
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}
async function transaction(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(62498450)');
    const r = await fn(c); await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const memberQuery = `SELECT p.user_id AS id,p.seat,u.pseudo FROM maf_monopoly_players p
  JOIN maf_users u ON u.id=p.user_id WHERE p.room_id=$1 ORDER BY p.seat`;
async function load(c,id) {
  const room = (await c.query('SELECT * FROM maf_monopoly_rooms WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!room) throw fail(404,'Salon introuvable.');
  const members = (await c.query(memberQuery,[id])).rows.map(m => ({id:Number(m.id), seat:m.seat, name:m.pseudo}));
  return {room,members};
}
async function view({room,members},viewer) {
  const me = members.some(p => p.id===viewer);
  const winAvailable = me && room.status==='playing' &&
    ((process.env.MAF_OWNER_WIN_MODE==='1' && members.find(p=>p.id===viewer)?.name==='999') ||
      await winAccessForRoom(viewer,'monopoly',room.id));
  return {id:Number(room.id),code:room.code,hostId:room.host_id,maxPlayers:room.max_players,
    stake:room.stake,status:room.status,players:members,proposal:me ? room.proposal:null,
    game:me && room.match_state ? {...room.match_state,decks:undefined} : null,
    escrow:me ? room.escrow : 0,winnerId:room.winner_id,payout:room.payout,
    ...(winAvailable ? {winModeAvailable:true} : {}),
    createdAt:room.created_at,serverNow:Date.now()};
}
function participant(members,uid) { if(!members.some(m=>m.id===uid)) throw fail(403,'Tu ne participes pas a ce salon.'); }
async function audit(c,event,details){ await c.query(`INSERT INTO maf_wallet_audit(actor,event,details)
 VALUES($1,$2,$3)`,['system:monopoly',event,JSON.stringify(details)]); }
async function balancesLocked(c,ids){
  const sorted=[...ids].sort((a,b)=>a-b);
  // row locking in stable order avoids deadlocks
  const result=[];
  for(const id of sorted){const row=(await c.query('SELECT id,balance FROM maf_users WHERE id=$1 FOR UPDATE',[id])).rows[0]; if(!row) throw fail(404,'Joueur introuvable.'); result.push(row);}
  return result;
}
async function start(c,room,members) {
  const ids=members.map(m=>m.id);
  const balances=await balancesLocked(c,ids);
  const missing=balances.find(x=>x.balance<room.stake);
  if(missing) throw fail(402,`Le joueur #${missing.id} n'a pas la mise necessaire. Aucun compte n'a ete debite.`);
  await c.query('UPDATE maf_users SET balance=balance-$2 WHERE id=ANY($1::int[])',[ids,room.stake]);
  const game=normalizeTurnClock(initPresence(createGame({names:members.map(p=>p.name),dice:2,rng:rand}),ids));
  const escrow=members.length*room.stake;
  await c.query(`UPDATE maf_monopoly_rooms SET status='playing',proposal=NULL,
    match_state=$2::jsonb,escrow=$3,updated_at=now() WHERE id=$1`,[room.id,JSON.stringify(game),escrow]);
  await audit(c,'monopoly_stake_locked',{roomId:Number(room.id),ids,stake:room.stake,escrow});
}
async function settle(c,room,members,game){
  if(game.phase!=='over'||room.settled_at||room.escrow<=0)return;
  const winner=Number.isInteger(game.winner) && game.winner>=0 ? members[game.winner]?.id : null;
  if(winner!=null) await c.query('UPDATE maf_users SET balance=balance+$2 WHERE id=$1',[winner,room.escrow]);
  else await c.query('UPDATE maf_users SET balance=balance+$2 WHERE id=ANY($1::int[])',[members.map(m=>m.id),room.stake]);
  await c.query(`UPDATE maf_monopoly_rooms SET status='finished',escrow=0,payout=$2,
    winner_id=$3,settled_at=now(),updated_at=now() WHERE id=$1`,[room.id,winner!=null?room.escrow:0,winner]);
  await audit(c,winner!=null?'monopoly_payout':'monopoly_refund',{roomId:Number(room.id),winner,stake:room.stake,pot:room.escrow});
}
async function advancePresence(c, info) {
  if (info.room.status !== 'playing' || !info.room.match_state) return info;
  const initialized = !info.room.match_state.presence;
  if (initialized) initPresence(info.room.match_state, info.members.map(m=>m.id));
  const result = expirePresence(info.room.match_state, info.members);
  const clock = tickTurnClock(result.game,{rng:rand,autoEnd:true});
  if (!result.changed && !clock.changed && !initialized) return info;
  await c.query(`UPDATE maf_monopoly_rooms SET match_state=$2::jsonb,updated_at=now() WHERE id=$1`,
    [info.room.id, JSON.stringify(clock.game)]);
  if (clock.game.phase === 'over') await settle(c, info.room, info.members, clock.game);
  return load(c,info.room.id);
}
async function maintain(c){
  // Traiter les absences meme si tous les joueurs ont ferme la page.
  const active = (await c.query(`SELECT id FROM maf_monopoly_rooms WHERE status='playing' ORDER BY id LIMIT 200`)).rows;
  for (const row of active) await advancePresence(c,await load(c,row.id));
  // Les salons jamais demarres n'ont aucune mise. Les parties inactives sont remboursees apres 24h.
  const waiting=(await c.query(`SELECT id FROM maf_monopoly_rooms WHERE status IN ('waiting','proposed')
    AND created_at < now()-interval '30 minutes' FOR UPDATE`)).rows;
  if(waiting.length) await c.query(`UPDATE maf_monopoly_rooms SET status='closed',proposal=NULL,updated_at=now()
    WHERE id=ANY($1::bigint[])`,[waiting.map(r=>r.id)]);
  const stale=(await c.query(`SELECT * FROM maf_monopoly_rooms WHERE status='playing'
    AND updated_at < now()-interval '24 hours' AND escrow>0 FOR UPDATE`)).rows;
  for(const room of stale){
    const members=(await c.query(memberQuery,[room.id])).rows;
    await balancesLocked(c,members.map(m=>Number(m.id)));
    await c.query('UPDATE maf_users SET balance=balance+$2 WHERE id=ANY($1::int[])',[members.map(m=>Number(m.id)),room.stake]);
    await c.query(`UPDATE maf_monopoly_rooms SET status='closed',escrow=0,settled_at=now(),updated_at=now() WHERE id=$1`,[room.id]);
    await audit(c,'monopoly_timeout_refund',{roomId:Number(room.id),stake:room.stake});
  }
}
export async function maintainMonopolyRooms() {
  if (!pool) return;
  await ensureMonopolyRooms();
  await transaction(maintain);
}
monopolyRoomsRouter.use((_req,res,next)=>{res.set('Cache-Control','no-store'); if(!pool)return res.status(503).json({error:'Base de donnees indisponible.'}); ensureMonopolyRooms().then(()=>next(),next);});
monopolyRoomsRouter.get('/',handler(async(req,res)=>{
  const rows=(await pool.query(`SELECT r.id,r.code,r.max_players,r.stake,r.status,r.host_id,r.created_at,u.pseudo AS host,
    count(p.user_id)::int AS present FROM maf_monopoly_rooms r
    JOIN maf_users u ON u.id=r.host_id LEFT JOIN maf_monopoly_players p ON p.room_id=r.id
    WHERE r.status IN ('waiting','proposed') AND r.created_at>now()-interval '30 minutes'
    GROUP BY r.id,u.pseudo ORDER BY r.created_at DESC LIMIT 50`)).rows;
  res.json({rooms:rows.map(r=>({id:Number(r.id),code:r.code,maxPlayers:r.max_players,stake:r.stake,status:r.status,host:r.host,present:r.present,createdAt:r.created_at,serverNow:Date.now()}))});
}));
// Recherche publique d'un code Monopoly (6 chiffres), dans l'onglet Salon commun.
monopolyRoomsRouter.get('/code/:code',handler(async(req,res)=>{
  const code=String(req.params.code||'');
  if(!/^\d{6}$/.test(code))throw fail(400,'Le code Monopoly contient 6 chiffres.');
  const r=(await pool.query(`SELECT r.id,r.code,r.max_players,r.stake,r.status,r.host_id,r.created_at,u.pseudo AS host,
    count(p.user_id)::int AS present FROM maf_monopoly_rooms r
    JOIN maf_users u ON u.id=r.host_id LEFT JOIN maf_monopoly_players p ON p.room_id=r.id
    WHERE r.code=$1 AND r.status IN ('waiting','proposed') AND r.created_at>now()-interval '30 minutes'
    GROUP BY r.id,u.pseudo`,[code])).rows[0];
  if(!r)throw fail(404,'Aucun salon Monopoly ouvert pour ce code.');
  res.json({room:{id:Number(r.id),code:r.code,maxPlayers:r.max_players,stake:r.stake,
    status:r.status,host:r.host,present:r.present,createdAt:r.created_at,serverNow:Date.now()}});
}));
monopolyRoomsRouter.get('/mine',requireSession,handler(async(req,res)=>{
  const rows=(await pool.query(`SELECT r.id FROM maf_monopoly_rooms r
    JOIN maf_monopoly_players p ON p.room_id=r.id WHERE p.user_id=$1
    AND r.status IN ('waiting','proposed','playing') ORDER BY r.created_at DESC LIMIT 1`,[req.userId])).rows;
  res.json({room:rows[0]?await view(await transaction(async c=>advancePresence(c,await load(c,rows[0].id))),req.userId):null});
}));
monopolyRoomsRouter.get('/:id',requireSession,handler(async(req,res)=>{
  const info=await transaction(async c=>advancePresence(c,await load(c,parseId(req.params.id))));
  participant(info.members,req.userId);
  res.json({room:await view(info,req.userId)});
}));
monopolyRoomsRouter.post('/',requireSession,handler(async(req,res)=>{
  const {maxPlayers,stake}=req.body||{};
  try{validateSetup(maxPlayers,stake);}catch(e){throw fail(400,e.message);}
  const info=await transaction(async c=>{
    await maintain(c);
    // Eviter plusieurs parties Monopoly concurrentes pour un meme joueur.
    const active=(await c.query(`SELECT 1 FROM maf_monopoly_players p
      JOIN maf_monopoly_rooms r ON r.id=p.room_id WHERE p.user_id=$1
      AND r.status IN ('waiting','proposed','playing') LIMIT 1`,[req.userId])).rowCount;
    if(active)throw fail(409,'Tu participes deja a un salon Monopoly.');
    const funds=(await c.query('SELECT balance FROM maf_users WHERE id=$1',[req.userId])).rows[0];
    if(!funds || funds.balance<stake)throw fail(402,'Ton solde est insuffisant pour cette mise. Recharge ton compte.');
    let row;
    for(let attempt=0;attempt<10;attempt++){
      const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
      const used=(await c.query('SELECT 1 FROM maf_monopoly_rooms WHERE code=$1',[code])).rowCount;
      if(used)continue;
      row=(await c.query(`INSERT INTO maf_monopoly_rooms(code,host_id,max_players,stake)
       VALUES($1,$2,$3,$4) RETURNING id`,[code,req.userId,maxPlayers,stake])).rows[0];break;
    }
    if(!row)throw fail(503,'Impossible de generer un code. Reessaie.');
    await c.query('INSERT INTO maf_monopoly_players(room_id,user_id,seat) VALUES($1,$2,0)',[row.id,req.userId]);
    return load(c,row.id);
  });res.status(201).json({room:await view(info,req.userId)});
}));
monopolyRoomsRouter.post('/:id/join',requireSession,handler(async(req,res)=>{
  const info=await transaction(async c=>{
    const i=await load(c,parseId(req.params.id));
    if(i.members.some(m=>m.id===req.userId))return i;
    if(i.room.status!=='waiting')throw fail(409,'Salon en cours de validation ou deja demarre.');
    if(i.members.length>=i.room.max_players)throw fail(409,'Salon complet.');
    const other=(await c.query(`SELECT 1 FROM maf_monopoly_players p JOIN maf_monopoly_rooms r ON r.id=p.room_id
     WHERE p.user_id=$1 AND r.status IN ('waiting','proposed','playing') LIMIT 1`,[req.userId])).rowCount;
    if(other)throw fail(409,'Quitte ton autre salon Monopoly avant de rejoindre celui-ci.');
    const funds=(await c.query('SELECT balance FROM maf_users WHERE id=$1',[req.userId])).rows[0];
    if(!funds || funds.balance<i.room.stake)throw fail(402,'Ton solde est insuffisant pour rejoindre ce salon.');
    const seats=new Set(i.members.map(m=>m.seat));
    const seat=Array.from({length:4},(_,n)=>n).find(n=>!seats.has(n));
    await c.query('INSERT INTO maf_monopoly_players(room_id,user_id,seat) VALUES($1,$2,$3)',[i.room.id,req.userId,seat]);
    await c.query('UPDATE maf_monopoly_rooms SET updated_at=now() WHERE id=$1',[i.room.id]);
    return load(c,i.room.id);
  });res.json({room:await view(info,req.userId)});
}));
monopolyRoomsRouter.post('/:id/leave',requireSession,handler(async(req,res)=>{
  const info=await transaction(async c=>{
    const i=await load(c,parseId(req.params.id));participant(i.members,req.userId);
    if(i.room.status==='playing')throw fail(409,'Pendant la partie, utilise Abandonner.');
    if(!['waiting','proposed'].includes(i.room.status))throw fail(409,'Ce salon est termine.');
    if(i.room.host_id===req.userId){await c.query(`UPDATE maf_monopoly_rooms SET status='closed',proposal=NULL,updated_at=now() WHERE id=$1`,[i.room.id]);}
    else {await c.query('DELETE FROM maf_monopoly_players WHERE room_id=$1 AND user_id=$2',[i.room.id,req.userId]);
      await c.query(`UPDATE maf_monopoly_rooms SET status='waiting',proposal=NULL,updated_at=now() WHERE id=$1`,[i.room.id]);}
    return load(c,i.room.id);
  });res.json({room:await view(info,req.userId)});
}));
monopolyRoomsRouter.post('/:id/propose',requireSession,handler(async(req,res)=>{
  const info=await transaction(async c=>{
    const i=await load(c,parseId(req.params.id));
    participant(i.members,req.userId);
    let proposal;try{proposal=proposeStart(i.room,i.members.map(m=>m.id),req.body?.count,req.userId);}catch(e){throw fail(409,e.message);}
    await c.query(`UPDATE maf_monopoly_rooms SET status='proposed',proposal=$2::jsonb,updated_at=now() WHERE id=$1`,[i.room.id,JSON.stringify(proposal)]);
    return load(c,i.room.id);
  });res.json({room:await view(info,req.userId)});
}));
monopolyRoomsRouter.post('/:id/vote',requireSession,handler(async(req,res)=>{
  const info=await transaction(async c=>{
    const i=await load(c,parseId(req.params.id));participant(i.members,req.userId);
    if(i.room.status!=='proposed')throw fail(409,'Aucune proposition en cours.');
    let vote;try{vote=voteStart(i.room.proposal,i.members.map(m=>m.id),req.userId,req.body?.accept);}catch(e){throw fail(400,e.message);}
    if(!vote.proposal){await c.query(`UPDATE maf_monopoly_rooms SET status='waiting',proposal=NULL,updated_at=now() WHERE id=$1`,[i.room.id]);}
    else if(vote.unanimous){await start(c,i.room,i.members);}
    else {await c.query(`UPDATE maf_monopoly_rooms SET proposal=$2::jsonb,updated_at=now() WHERE id=$1`,[i.room.id,JSON.stringify(vote.proposal)]);}
    return load(c,i.room.id);
  });res.json({room:await view(info,req.userId)});
}));
monopolyRoomsRouter.post('/:id/presence',requireSession,handler(async(req,res)=>{
  const state=req.body?.state;
  if(!['here','away'].includes(state))throw fail(400,'Presence invalide.');
  const info=await transaction(async c=>{
    const i=await advancePresence(c,await load(c,parseId(req.params.id)));
    participant(i.members,req.userId);
    if(i.room.status!=='playing') return i;
    const game=structuredClone(i.room.match_state);
    if(setPresence(game,i.members,req.userId,state)){
      await c.query('UPDATE maf_monopoly_rooms SET match_state=$2::jsonb WHERE id=$1',[i.room.id,JSON.stringify(game)]);
    }
    return load(c,i.room.id);
  });
  res.json({room:await view(info,req.userId)});
}));
monopolyRoomsRouter.post('/:id/action',requireSession,handler(async(req,res)=>{
  const info=await transaction(async c=>{
    const i=await advancePresence(c,await load(c,parseId(req.params.id))); participant(i.members,req.userId);
    if(i.room.status!=='playing'||!i.room.match_state)throw fail(409,'Aucune partie active.');
    const g=i.room.match_state;
    const index=i.members.findIndex(m=>m.id===req.userId);
    const action=req.body?.action;
    if(!['roll','buy','build','sell','end','abandon'].includes(action))throw fail(400,'Action invalide.');
    if(action!=='abandon'&&index!==g.current)throw fail(403,"Ce n'est pas ton tour.");
    if(action!=='abandon' && g.phase==='over')throw fail(409,'Partie terminee.');
    let next=g;
    if(action==='roll') {
      if(g.phase!=='roll')throw fail(409,'Lancer non autorise dans cette phase.');
      const forced=await authorizedWinDice(c,req.userId,'monopoly',i.room.id,
        req.body?.dice,g.dice,i.members[index]?.name);
      next=rollDice(g,{rng:rand,forced});
    }
    if(action==='buy')next=buy(g);
    if(action==='build')next=build(g,req.body?.square);
    if(action==='sell')next=sell(g,req.body?.square);
    if(action==='end')next=endTurn(g);
    if(action==='abandon'){
      if(g.players[index].bankrupt)throw fail(409,'Tu as deja abandonne la partie.');
      if(index===g.current)next=giveUp(g);
      else {
        next=structuredClone(g);
        next.players[index].bankrupt=true;next.players[index].balance=0;
        for(let sq=0;sq<40;sq++)if(next.owners[sq]===index){next.owners[sq]=null;next.houses[sq]=0;}
        next.seq+=1;next.log.unshift({n:next.seq,player:index,text:'a abandonne la partie',kind:'bankrupt'});
        if(next.players.filter(p=>!p.bankrupt).length===1){next.phase='over';next.winner=next.players.find(p=>!p.bankrupt).id;}
      }
    }
    if(next===g)throw fail(409,'Action non autorisee dans cette phase.');
    normalizeTurnClock(next);
    await c.query(`UPDATE maf_monopoly_rooms SET match_state=$2::jsonb,updated_at=now() WHERE id=$1`,[i.room.id,JSON.stringify(next)]);
    if(next.phase==='over')await settle(c,i.room,i.members,next);
    return load(c,i.room.id);
  });res.json({room:await view(info,req.userId)});
}));
