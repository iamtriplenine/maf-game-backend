// Espace Recompenses MAF : heure de remise, coffre visuel et consultation personnelle.
// Ce routeur ne modifie JAMAIS les soldes, les bonus, les skins ou les resultats.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureTournamentAwardTables } from './tournamentAwards.js';
import { ownerDemoGift, rewardAvailability, validateReleaseAt } from './tournamentGiftRules.js';
import { postponedGiftAt } from './tournamentLiveRules.js';

export const tournamentGiftRouter = Router();
const problem=(status,message)=>Object.assign(new Error(message),{status});
const wrap=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){
  if(e.status)return res.status(e.status).json({error:e.message});
  if(e.message==='Heure UTC au format ISO obligatoire.' || e.message.startsWith('La remise doit être'))
    return res.status(400).json({error:e.message});
  next(e);
}};
const positiveId=value=>{
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<1)throw problem(400,'Tournoi invalide.');
  return n;
};
async function ensureOwner(userId){
  const r=await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[userId]);
  if(r.rows[0]?.pseudo_key!=='999')throw problem(403,'Accès réservé au propriétaire.');
}
let ready;
export function ensureTournamentGifts(){
  if(!ready)ready=(async()=>{
    await ensureTournamentAwardTables();
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498492)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_gift_schedule (
        tournament_id integer PRIMARY KEY REFERENCES maf_tournaments(id),
        release_at timestamptz NOT NULL,
        original_release_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query(`ALTER TABLE maf_tournament_gift_schedule
        ADD COLUMN IF NOT EXISTS original_release_at timestamptz`);
      await c.query(`UPDATE maf_tournament_gift_schedule SET original_release_at=release_at
        WHERE original_release_at IS NULL`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_tournament_gift_openings (
        tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        opened_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(tournament_id,user_id)
      )`);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{ready=null;throw e;});
  return ready;
}
// Dans la meme transaction que l'ouverture, bloque la remise si une qualification
// a demarre et si la finale n'est pas encore terminee. Fonctionne meme apres un
// redemarrage du serveur : la base conserve l'heure deja reportee.
async function adjustGiftClock(c,id){
  const result=await c.query(`SELECT g.release_at,g.original_release_at,
    EXISTS(SELECT 1 FROM maf_tournament_qualification_matches m WHERE m.tournament_id=g.tournament_id) AS started,
    EXISTS(SELECT 1 FROM maf_tournament_final_matches f
      WHERE f.tournament_id=g.tournament_id AND f.state->'game'->>'phase'='over') AS finale_over
    FROM maf_tournament_gift_schedule g WHERE g.tournament_id=$1 FOR UPDATE OF g`,[id]);
  const state=result.rows[0];
  if(!state || !state.started)return false;
  const now=Date.now();
  let next=null;
  if(!state.finale_over){
    next=postponedGiftAt(state.release_at,now,true);
  }else if(new Date(state.release_at).getTime()>new Date(state.original_release_at).getTime()){
    // Finale finie : les cadeaux ne sont plus retenus par les tranches futures.
    next=new Date(state.original_release_at).toISOString();
  }
  if(next && new Date(next).getTime()!==new Date(state.release_at).getTime()){
    await c.query(`UPDATE maf_tournament_gift_schedule
      SET release_at=$2,updated_at=now() WHERE tournament_id=$1`,[id,next]);
    return true;
  }
  return false;
}
let clockRun;
export function maintainTournamentGiftClock(){
  if(clockRun)return clockRun;
  clockRun=(async()=>{
    await ensureTournamentGifts();
    const matches=(await pool.query(`SELECT g.tournament_id
      FROM maf_tournament_gift_schedule g
      WHERE (g.release_at <= now() OR g.release_at>g.original_release_at)
      AND EXISTS(SELECT 1 FROM maf_tournament_qualification_matches m WHERE m.tournament_id=g.tournament_id)
      ORDER BY g.tournament_id DESC LIMIT 100`)).rows;
    let changed=0;
    for(const m of matches){
      const c=await pool.connect();
      try{await c.query('BEGIN');
        // Meme ordre de verrouillage que la route /open.
        await c.query('SELECT id FROM maf_tournaments WHERE id=$1 FOR UPDATE',[m.tournament_id]);
        if(await adjustGiftClock(c,m.tournament_id))changed++;
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
    }
    return {changed};
  })().finally(()=>{clockRun=null;});
  return clockRun;
}
function output(row,now){
  const releaseAt=row.release_at?new Date(row.release_at).toISOString():null;
  const openedAt=row.opened_at?new Date(row.opened_at).toISOString():null;
  const credited= row.batch_status==='credited' && row.award_status==='credited';
  const status=rewardAvailability({releaseAt,now,participantReserved:row.entry_status==='reserved',
    batchCredited:row.batch_status==='credited',awardCredited:row.award_status==='credited',openedAt});
  return {
    tournamentId:Number(row.id),title:row.title,releaseAt,status,openedAt,
    // Ne jamais reveler de gains prepares ou des informations d'autres comptes.
    ...(credited && ['ready','opened'].includes(status)?{
      reward:{ place:row.place===null?null:Number(row.place),realCents:Number(row.real_cents),
        bonusCents:Number(row.bonus_cents),skinsPlanned:row.place===null?1:2,
        skinsDelivered:false }
    }:{}),
  };
}
const itemSql=`SELECT t.id,t.title,e.status AS entry_status,g.release_at,o.opened_at,
  a.place,a.real_cents,a.bonus_cents,a.status AS award_status,b.status AS batch_status
  FROM maf_tournament_entries e
  JOIN maf_tournaments t ON t.id=e.tournament_id
  LEFT JOIN maf_tournament_gift_schedule g ON g.tournament_id=t.id
  LEFT JOIN maf_tournament_gift_openings o ON o.tournament_id=t.id AND o.user_id=e.user_id
  LEFT JOIN maf_tournament_award_lines a ON a.tournament_id=t.id AND a.user_id=e.user_id
  LEFT JOIN maf_tournament_award_batches b ON b.tournament_id=t.id
  WHERE e.user_id=$1 AND e.status='reserved'`;

tournamentGiftRouter.use((_,res,next)=>{res.set('Cache-Control','private, no-store');next();});
tournamentGiftRouter.get('/gifts/mine',requireSession,wrap(async(req,res)=>{
  await ensureTournamentGifts();
  await maintainTournamentGiftClock();
  const {rows}=await pool.query(itemSql+' ORDER BY t.starts_at DESC LIMIT 50',[req.userId]);
  res.json({gifts:rows.map(r=>output(r,Date.now())),serverNow:Date.now(),
    note:'Aucun montant n est attribue depuis le coffre. Les gains doivent etre certifies et credites separement.'});
}));

tournamentGiftRouter.post('/gifts/:id/open',requireSession,wrap(async(req,res)=>{
  await ensureTournamentGifts();
  const id=positiveId(req.params.id);const c=await pool.connect();
  try{
    await c.query('BEGIN');
    // Le meme verrou tournoi est pris par le proprietaire lors d'un changement d'heure.
    await c.query('SELECT id FROM maf_tournaments WHERE id=$1 FOR UPDATE',[id]);
    await adjustGiftClock(c,id);
    const {rows}=await c.query(itemSql+' AND t.id=$2 FOR UPDATE OF e',[req.userId,id]);
    if(!rows.length)throw problem(404,'Aucun cadeau pour ce compte.');
    const row=rows[0],state=output(row,Date.now());
    if(!['ready','opened'].includes(state.status))throw problem(409,'Cadeau indisponible : heure ou gains non validés.');
    await c.query(`INSERT INTO maf_tournament_gift_openings(tournament_id,user_id)
      VALUES($1,$2) ON CONFLICT(tournament_id,user_id) DO NOTHING`,[id,req.userId]);
    const saved=await c.query('SELECT opened_at FROM maf_tournament_gift_openings WHERE tournament_id=$1 AND user_id=$2',[id,req.userId]);
    await c.query('COMMIT');
    // Ce geste confirme seulement l animation de reception, sans versement supplementaire.
    res.json({...state,status:'opened',openedAt:saved.rows[0].opened_at,
      note:'Cadeau ouvert. Aucun nouveau credit ni skin attribue par cette action.'});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));

tournamentGiftRouter.get('/gifts/owner',requireSession,wrap(async(req,res)=>{
  await ensureOwner(req.userId);await ensureTournamentGifts();
  const {rows}=await pool.query(`SELECT t.id,t.title,t.final_at,g.release_at,
    (SELECT count(*)::integer FROM maf_tournament_entries e WHERE e.tournament_id=t.id AND e.status='reserved') AS registered
    FROM maf_tournaments t LEFT JOIN maf_tournament_gift_schedule g ON g.tournament_id=t.id
    ORDER BY t.created_at DESC LIMIT 100`);
  res.json({tournaments:rows.map(r=>({id:r.id,title:r.title,finalAt:r.final_at,
    registered:r.registered,releaseAt:r.release_at})),serverNow:Date.now()});
}));

tournamentGiftRouter.put('/gifts/owner/:id/schedule',requireSession,wrap(async(req,res)=>{
  await ensureOwner(req.userId);await ensureTournamentGifts();
  const id=positiveId(req.params.id);const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const row=(await c.query('SELECT final_at FROM maf_tournaments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw problem(404,'Tournoi introuvable.');
    const releaseAt=validateReleaseAt(req.body?.releaseAt,new Date(row.final_at).toISOString());
    const previous=(await c.query('SELECT count(*)::int AS n FROM maf_tournament_gift_openings WHERE tournament_id=$1',[id])).rows[0].n;
    if(previous>0)throw problem(409,'Une remise a deja été ouverte : heure verrouillée.');
    await c.query(`INSERT INTO maf_tournament_gift_schedule(tournament_id,release_at,original_release_at) VALUES($1,$2,$2)
      ON CONFLICT(tournament_id) DO UPDATE SET release_at=EXCLUDED.release_at,original_release_at=EXCLUDED.original_release_at,updated_at=now()`,[id,releaseAt]);
    await c.query('COMMIT');
    res.json({tournamentId:id,releaseAt,realPayoutsEnabled:false});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));

tournamentGiftRouter.post('/gifts/owner/preview',requireSession,wrap(async(req,res)=>{
  await ensureOwner(req.userId);
  const n=Number(req.body?.players??10);
  let demo;try{demo=ownerDemoGift(n);}catch(e){throw problem(400,e.message);}
  res.json(demo);
}));
