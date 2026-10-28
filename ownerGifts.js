// Cadeaux hors tournois, decidés exclusivement par le propriétaire 999.
// Les crédits sont appliqués une seule fois lors de l'ouverture, dans une transaction.
import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureWallet } from './wallet.js';
import { ensureTournamentSkinTables } from './tournamentSkins.js';
import { validateOwnerGift, summarizeOwnerGift } from './ownerGiftRules.js';

export const ownerGiftsRouter=Router();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const wrap=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
const idOf=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identifiant invalide.');return n;};
async function requireOwner(userId,c=pool){
  const r=(await c.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[userId])).rows[0];
  if(r?.pseudo_key!=='999')throw fail(403,'Réservé au propriétaire 999.');
}
let ready;
export function ensureOwnerGifts(){
  if(!ready)ready=(async()=>{
    await ensureWallet();await ensureTournamentSkinTables();
    const c=await pool.connect();
    try{
      await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(62498619)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_owner_gifts (
        id bigserial PRIMARY KEY, created_by integer NOT NULL REFERENCES maf_users(id),
        kind text NOT NULL CHECK(kind IN ('coupon','skin','background','image','balance','bonus')),
        title varchar(80) NOT NULL, message varchar(300) NOT NULL DEFAULT '',
        target_mode text NOT NULL CHECK(target_mode IN ('all','pseudo','clientId')),
        payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_owner_gift_recipients (
        gift_id bigint NOT NULL REFERENCES maf_owner_gifts(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        coupon_code text, opened_at timestamptz, outcome jsonb,
        PRIMARY KEY(gift_id,user_id)
      )`);
      await c.query('CREATE INDEX IF NOT EXISTS maf_owner_gift_recipient_by_user ON maf_owner_gift_recipients(user_id,gift_id DESC)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_gift_display_settings (
        id integer PRIMARY KEY CHECK(id=1), legacy_hidden_before timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query('INSERT INTO maf_gift_display_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING');
      // Un skin exclusif peut aussi provenir d'un cadeau du compte propriétaire.
      // L'ancien historique des tournois demeure inchangé.
      await c.query('ALTER TABLE maf_studio_skin_unlocks ALTER COLUMN tournament_id DROP NOT NULL');
      await c.query('ALTER TABLE maf_studio_skin_unlocks DROP CONSTRAINT IF EXISTS maf_studio_skin_unlocks_prize_kind_check');
      await c.query(`ALTER TABLE maf_studio_skin_unlocks ADD CONSTRAINT maf_studio_skin_unlocks_prize_kind_check
        CHECK(prize_kind IN ('participation','winner','owner_gift'))`);
      await c.query("ALTER TABLE maf_users ADD COLUMN IF NOT EXISTS profile_background_id text NOT NULL DEFAULT 'matrix-rain'");
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{ready=null;throw e;});
  return ready;
}
export async function legacyGiftHiddenBefore(){
  await ensureOwnerGifts();
  const row=(await pool.query('SELECT legacy_hidden_before FROM maf_gift_display_settings WHERE id=1')).rows[0];
  return row?.legacy_hidden_before?new Date(row.legacy_hidden_before).getTime():0;
}
async function giftTargets(c,form){
  if(form.targetMode==='all')return (await c.query('SELECT id,client_id FROM maf_users ORDER BY id')).rows;
  if(form.targetMode==='pseudo')return (await c.query('SELECT id,client_id FROM maf_users WHERE pseudo_key=lower($1)',[form.targetValue])).rows;
  return (await c.query('SELECT id,client_id FROM maf_users WHERE client_id=$1',[Number(form.targetValue)])).rows;
}
async function audit(c,event,details){
  await c.query('INSERT INTO maf_wallet_audit(actor,event,details) VALUES($1,$2,$3::jsonb)',
    ['owner:999',event,JSON.stringify(details)]);
}
ownerGiftsRouter.use((_,res,next)=>{res.set('Cache-Control','private, no-store');next();});
ownerGiftsRouter.get('/mine',requireSession,wrap(async(req,res)=>{
  await ensureOwnerGifts();
  const {rows}=await pool.query(`SELECT g.*,r.opened_at,r.outcome,r.coupon_code
    FROM maf_owner_gift_recipients r JOIN maf_owner_gifts g ON g.id=r.gift_id
    WHERE r.user_id=$1 AND g.revoked_at IS NULL ORDER BY g.id DESC LIMIT 100`,[req.userId]);
  res.json({gifts:rows.map(r=>({...summarizeOwnerGift(r),openedAt:r.opened_at,
    receipt:r.opened_at?r.outcome:null})),legacyHiddenBefore:await legacyGiftHiddenBefore()});
}));
ownerGiftsRouter.get('/owner',requireSession,wrap(async(req,res)=>{
  await ensureOwnerGifts();await requireOwner(req.userId);
  const {rows}=await pool.query(`SELECT g.*,count(r.user_id)::integer AS recipient_count,
    count(r.opened_at)::integer AS opened_count FROM maf_owner_gifts g
    LEFT JOIN maf_owner_gift_recipients r ON r.gift_id=g.id
    GROUP BY g.id ORDER BY g.id DESC LIMIT 100`);
  res.json({gifts:rows.map(summarizeOwnerGift),legacyHiddenBefore:await legacyGiftHiddenBefore()});
}));
ownerGiftsRouter.post('/owner',requireSession,wrap(async(req,res)=>{
  await ensureOwnerGifts();await requireOwner(req.userId);
  const form=validateOwnerGift(req.body);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const targets=await giftTargets(c,form);
    if(!targets.length)throw fail(404,'Aucun compte correspondant au destinataire.');
    const created=(await c.query(`INSERT INTO maf_owner_gifts(created_by,kind,title,message,target_mode,payload)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [req.userId,form.kind,form.title,form.message,form.targetMode,JSON.stringify(form.payload)])).rows[0];
    const giftId=Number(created.id);
    // Une cible est une photo des comptes actuels : les prochains inscrits ne
    // recevront pas retroactivement une distribution deja programmee.
    for(const target of targets){
      let code=null;
      if(form.kind==='coupon'){
        code='MG-'+crypto.randomBytes(10).toString('hex').toUpperCase();
        await c.query(`INSERT INTO maf_coupons(code,amount,currency,max_uses,target_client_id)
          VALUES($1,$2,$3,1,$4)`,[code,form.payload.amount,form.payload.currency,target.client_id]);
      }
      await c.query(`INSERT INTO maf_owner_gift_recipients(gift_id,user_id,coupon_code)
        VALUES($1,$2,$3)`,[giftId,target.id,code]);
    }
    await audit(c,'owner_gift_created',{gift_id:giftId,kind:form.kind,recipients:targets.length,mode:form.targetMode});
    await c.query('COMMIT');
    res.status(201).json({id:giftId,recipientCount:targets.length});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
ownerGiftsRouter.post('/:id/open',requireSession,wrap(async(req,res)=>{
  await ensureOwnerGifts();const id=idOf(req.params.id),c=await pool.connect();
  try{
    await c.query('BEGIN');
    const row=(await c.query(`SELECT g.*,r.opened_at,r.outcome,r.coupon_code
      FROM maf_owner_gift_recipients r JOIN maf_owner_gifts g ON g.id=r.gift_id
      WHERE g.id=$1 AND r.user_id=$2 FOR UPDATE OF g,r`,[id,req.userId])).rows[0];
    if(!row || row.revoked_at)throw fail(404,'Cadeau indisponible pour ce compte.');
    if(row.opened_at){await c.query('COMMIT');return res.json({alreadyOpened:true,receipt:row.outcome});}
    const p=row.payload,kind=row.kind;
    let receipt={kind,title:row.title,message:row.message};
    if(['balance','bonus'].includes(kind)){
      const column=kind==='balance'?'balance':'bonus_balance';
      const updated=await c.query(`UPDATE maf_users SET ${column}=${column}+$2
        WHERE id=$1 AND ${column} BETWEEN 0 AND 2147483647-$2 RETURNING id`,[req.userId,p.amount]);
      if(updated.rowCount!==1)throw fail(409,'Solde indisponible ou plafond atteint.');
      receipt.amount=p.amount;
      await audit(c,'owner_gift_wallet_credited',{gift_id:id,user_id:req.userId,kind,amount:p.amount});
    }else if(kind==='skin'){
      await c.query(`INSERT INTO maf_studio_skin_unlocks(user_id,skin_id,tournament_id,prize_kind)
        VALUES($1,$2,NULL,'owner_gift') ON CONFLICT(user_id,skin_id) DO NOTHING`,[req.userId,p.skinId]);
      receipt.skinId=p.skinId;
    }else if(kind==='background'){
      await c.query('UPDATE maf_users SET profile_background_id=$2 WHERE id=$1',[req.userId,p.backgroundId]);
      receipt.backgroundId=p.backgroundId;
    }else if(kind==='coupon'){
      receipt={...receipt,code:row.coupon_code,amount:p.amount,currency:p.currency};
    }else if(kind==='image'){
      receipt.imageData=p.imageData;
    }
    await c.query(`UPDATE maf_owner_gift_recipients
      SET opened_at=now(),outcome=$3::jsonb WHERE gift_id=$1 AND user_id=$2`,
      [id,req.userId,JSON.stringify(receipt)]);
    await audit(c,'owner_gift_opened',{gift_id:id,user_id:req.userId,kind});
    await c.query('COMMIT');res.json({receipt});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
ownerGiftsRouter.post('/owner/cleanup-tests',requireSession,wrap(async(req,res)=>{
  await ensureOwnerGifts();await requireOwner(req.userId);
  if(req.body?.confirmation!=='MASQUER ANCIENS CADEAUX')throw fail(400,'Confirmation explicite requise.');
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const row=(await c.query(`UPDATE maf_gift_display_settings
      SET legacy_hidden_before=now(),updated_at=now() WHERE id=1
      RETURNING legacy_hidden_before`)).rows[0];
    await audit(c,'legacy_gifts_archived',{before:row.legacy_hidden_before,reason:'duel_tests_cleanup'});
    await c.query('COMMIT');res.json({ok:true,legacyHiddenBefore:new Date(row.legacy_hidden_before).getTime()});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
ownerGiftsRouter.post('/owner/:id/revoke',requireSession,wrap(async(req,res)=>{
  await ensureOwnerGifts();await requireOwner(req.userId);const id=idOf(req.params.id);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const row=(await c.query('SELECT id,revoked_at FROM maf_owner_gifts WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw fail(404,'Cadeau introuvable.');
    if(!row.revoked_at){
      // Un coupon non ouvert est desactive lors du retrait du cadeau.
      await c.query(`UPDATE maf_coupons SET active=false WHERE code IN (
        SELECT coupon_code FROM maf_owner_gift_recipients
        WHERE gift_id=$1 AND opened_at IS NULL AND coupon_code IS NOT NULL
      )`,[id]);
      await c.query('UPDATE maf_owner_gifts SET revoked_at=now() WHERE id=$1',[id]);
      await audit(c,'owner_gift_revoked',{gift_id:id,note:'Crédits déjà ouverts conservés'});
    }
    await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));
