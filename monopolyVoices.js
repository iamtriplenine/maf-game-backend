// Vocaux prives aux participants d'une partie Monopoly en cours.
// Le trigger PostgreSQL purge les audios des la cloture d'une partie, y compris hors connexion.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureMonopolyRooms } from './monopolyRooms.js';
import { VOICE_LIMIT, VOICE_MAX_MS, VOICE_MAX_BYTES, parseVoiceDuration, sniffVoiceMime } from './monopolyVoiceRules.js';

export const monopolyVoicesRouter = Router();
const fail = (status, message) => Object.assign(new Error(message), {status});
const parseId = x => { const id=Number(x); if(!Number.isSafeInteger(id)||id<=0)throw fail(400,'Identifiant invalide.'); return id; };
let prepared;
export async function ensureMonopolyVoices() {
  if (!prepared) prepared=(async()=>{
    if(!pool) return;
    await ensureMonopolyRooms();
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_monopoly_voices (
        id bigserial primary key,
        room_id bigint NOT NULL REFERENCES maf_monopoly_rooms(id) ON DELETE CASCADE,
        user_id integer NOT NULL REFERENCES maf_users(id),
        audio bytea NOT NULL, audio_mime text NOT NULL, audio_ms integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query('CREATE INDEX IF NOT EXISTS maf_monopoly_voices_room_idx ON maf_monopoly_voices(room_id, id DESC)');
      await c.query(`CREATE OR REPLACE FUNCTION maf_monopoly_delete_finished_voices() RETURNS trigger
        LANGUAGE plpgsql AS $$BEGIN
          IF NEW.status IN ('finished','closed') THEN
            DELETE FROM maf_monopoly_voices WHERE room_id=NEW.id;
          END IF;
          RETURN NEW;
        END$$`);
      await c.query('DROP TRIGGER IF EXISTS maf_monopoly_voices_cleanup ON maf_monopoly_rooms');
      await c.query(`CREATE TRIGGER maf_monopoly_voices_cleanup
        AFTER UPDATE OF status ON maf_monopoly_rooms FOR EACH ROW
        WHEN (NEW.status IN ('finished','closed') AND OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION maf_monopoly_delete_finished_voices()`);
      // Rattrape les matchs deja termines lors d'un redemarrage.
      await c.query(`DELETE FROM maf_monopoly_voices v USING maf_monopoly_rooms r
        WHERE r.id=v.room_id AND r.status IN ('finished','closed')`);
      await c.query('COMMIT');
    } catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  })().catch(error=>{prepared=null;throw error;});
  return prepared;
}
const handler=fn=>(async(req,res,next)=>{try{await fn(req,res);}catch(error){
  if(error.status)return res.status(error.status).json({error:error.message});
  next(error);
}});
async function checkMember(c,roomId,userId,lock=false){
  const row=(await c.query(`SELECT status FROM maf_monopoly_rooms WHERE id=$1 ${lock?'FOR UPDATE':''}`,[roomId])).rows[0];
  if(!row)throw fail(404,'Partie introuvable.');
  const member=(await c.query(`SELECT 1 FROM maf_monopoly_players WHERE room_id=$1 AND user_id=$2`,[roomId,userId])).rowCount;
  if(!member)throw fail(403,'Tu ne participes pas a cette partie.');
  if(row.status!=='playing')throw fail(410,'Les vocaux de cette partie ont ete supprimes.');
}
const meta=r=>({id:Number(r.id),userId:Number(r.user_id),name:r.pseudo || `Joueur #${r.user_id}`,
  ms:r.audio_ms,createdAt:r.created_at});
// Authentification obligatoire, y compris pour lire l'audio : jamais d'URL publique permanente.
monopolyVoicesRouter.use((req,res,next)=>pool?next():res.status(503).json({error:'Base de donnees indisponible.'}));
monopolyVoicesRouter.use(requireSession);
monopolyVoicesRouter.use((_req,_res,next)=>{ensureMonopolyVoices().then(()=>next(),next);});
monopolyVoicesRouter.get('/:roomId',handler(async(req,res)=>{
  const roomId=parseId(req.params.roomId);
  const c=await pool.connect();
  try{
    await checkMember(c,roomId,req.userId);
    const result=await c.query(`SELECT v.id,v.user_id,v.audio_ms,v.created_at,u.pseudo
      FROM maf_monopoly_voices v JOIN maf_users u ON u.id=v.user_id
      WHERE v.room_id=$1 ORDER BY v.id DESC LIMIT $2`,[roomId,VOICE_LIMIT]);
    res.set('Cache-Control','no-store');
    res.json({voices:result.rows.reverse().map(meta)});
  }finally{c.release();}
}));
monopolyVoicesRouter.post('/:roomId',handler(async(req,res)=>{
  const roomId=parseId(req.params.roomId);
  const ms=parseVoiceDuration(req.body?.ms);
  const encoded=typeof req.body?.audio==='string'?req.body.audio:'';
  if(ms===null)throw fail(400,'Un vocal doit durer entre 0,6 et 20 secondes.');
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length>VOICE_MAX_BYTES*1.4)
    throw fail(400,'Vocal invalide ou trop lourd.');
  const audio=Buffer.from(encoded,'base64');
  if(!audio.length||audio.length>VOICE_MAX_BYTES)throw fail(400,'Vocal invalide ou trop lourd.');
  const mime=sniffVoiceMime(audio);
  if(!mime)throw fail(400,'Format audio non reconnu.');
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await checkMember(c,roomId,req.userId,true);
    const newest=(await c.query(`SELECT created_at FROM maf_monopoly_voices
      WHERE room_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 1`,[roomId,req.userId])).rows[0];
    if(newest && Date.now()-new Date(newest.created_at).getTime()<1000)throw fail(429,'Attends une seconde avant un autre vocal.');
    const insert=(await c.query(`INSERT INTO maf_monopoly_voices(room_id,user_id,audio,audio_mime,audio_ms)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,[roomId,req.userId,audio,mime,ms])).rows[0];
    await c.query(`DELETE FROM maf_monopoly_voices WHERE room_id=$1 AND id NOT IN
      (SELECT id FROM maf_monopoly_voices WHERE room_id=$1 ORDER BY id DESC LIMIT $2)`,[roomId,VOICE_LIMIT]);
    await c.query('COMMIT');
    res.status(201).json({id:Number(insert.id)});
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}));
monopolyVoicesRouter.get('/:roomId/:voiceId/audio',handler(async(req,res)=>{
  const roomId=parseId(req.params.roomId),voiceId=parseId(req.params.voiceId);
  const c=await pool.connect();
  try{
    await checkMember(c,roomId,req.userId);
    const r=(await c.query(`SELECT audio,audio_mime FROM maf_monopoly_voices WHERE id=$1 AND room_id=$2`,[voiceId,roomId])).rows[0];
    if(!r)throw fail(404,'Vocal supprime.');
    res.set({'Content-Type':r.audio_mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Length':String(r.audio.length)});
    res.end(r.audio);
  }finally{c.release();}
}));
