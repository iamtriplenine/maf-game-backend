import { partnerInvitation, revokePartnerInvites } from './referrals.js';
import { Router } from 'express';
import { pool } from './db.js';
import { ensureWallet } from './wallet.js';
import { ensureTable, requireSession } from './auth.js';
import { isOwnerAccount, ownerAccountId, accountRole } from './accountRoles.js';
import { partnerAccountId, partnerSearch, partnerRoleChange } from './partnerRoleRules.js';

export const partnerAccountsRouter=Router();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const run=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch(e){if(e.status)return res.status(e.status).json({error:e.message});if(e.code==='23505')return res.status(409).json({error:'Cette demande a deja ete utilisee. Actualise la liste.'});next(e);}};
const view=row=>({id:row.id,client_id:row.client_id,pseudo:row.pseudo,account_role:accountRole(row)});
let ready;
export function ensurePartnerAccounts(){
  if(!ready)ready=(async()=>{
    await ensureTable();
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498107)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_partner_role_events (
        request_key uuid PRIMARY KEY,
        owner_id integer NOT NULL REFERENCES maf_users(id),
        user_id integer NOT NULL REFERENCES maf_users(id),
        expected_role text NOT NULL CHECK(expected_role IN ('player','partner')),
        previous_role text NOT NULL CHECK(previous_role IN ('player','partner')),
        new_role text NOT NULL CHECK(new_role IN ('player','partner')),
        changed boolean NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query('CREATE INDEX IF NOT EXISTS maf_partner_role_events_user_date ON maf_partner_role_events(user_id,created_at DESC)');
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  })().catch(e=>{ready=null;throw e;});
  return ready;
}

partnerAccountsRouter.use(['/owner/partners','/partner/commissions'],run(async(req,res,next)=>{
  res.set('Cache-Control','no-store');
  await ensureTable();
  next();
}),requireSession);
partnerAccountsRouter.use('/owner/partners',run(async(req,res,next)=>{
  // Neither an API admin key nor a test-admin session grants this permission.
  if(!await isOwnerAccount(req.userId,pool))throw fail(403,'Gestion reservee au proprietaire.');
  await ensurePartnerAccounts();next();
}));

partnerAccountsRouter.get('/owner/partners',run(async(req,res)=>{
  const {q,offset,limit}=partnerSearch(req.query);
  const ownerId=await ownerAccountId(pool);
  const {rows}=await pool.query(`SELECT id,client_id,pseudo,account_role FROM maf_users
    WHERE id<>$1 AND ($2='' OR strpos(pseudo_key,$2)>0 OR client_id::text=$2)
    ORDER BY (account_role='partner') DESC,pseudo_key,id LIMIT $3 OFFSET $4`,[ownerId,q,limit+1,offset]);
  const count=(await pool.query("SELECT count(*)::int AS count FROM maf_users WHERE id<>$1 AND account_role='partner'",[ownerId])).rows[0].count;
  const recent=(await pool.query(`SELECT e.user_id,u.pseudo,u.client_id,e.previous_role,e.new_role,e.created_at
    FROM maf_partner_role_events e JOIN maf_users u ON u.id=e.user_id WHERE e.changed=true
    ORDER BY e.created_at DESC,e.request_key DESC LIMIT 10`)).rows;
  res.json({accounts:rows.slice(0,limit).map(view),active_partner_count:count,offset,has_more:rows.length>limit,recent_changes:recent});
}));

partnerAccountsRouter.patch('/owner/partners/:id',run(async(req,res)=>{
  const userId=partnerAccountId(req.params.id),change=partnerRoleChange(req.body);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    // Serialize retries before taking user locks, including cross-account reuse.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['maf-partner-role|'+change.requestKey]);
    if(!await isOwnerAccount(req.userId,c))throw fail(403,'Gestion reservee au proprietaire.');
    if(userId===await ownerAccountId(c))throw fail(403,'Le statut du proprietaire ne peut pas etre modifie.');
    const row=(await c.query('SELECT id,client_id,pseudo,account_role FROM maf_users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
    if(!row)throw fail(404,'Compte introuvable.');
    const recorded=(await c.query('SELECT * FROM maf_partner_role_events WHERE request_key=$1',[change.requestKey])).rows[0];
    if(recorded){
      if(recorded.owner_id!==req.userId||recorded.user_id!==userId||recorded.new_role!==change.desiredRole||recorded.expected_role!==change.expectedRole)throw fail(409,'Cette demande correspond a une autre modification.');
      // Return today's role; never reapply an old activation after a later revocation.
      await c.query('COMMIT');
      return res.json({account:view(row),changed:false,already_applied:true});
    }
    if(row.account_role!==change.expectedRole)throw fail(409,'Le statut a change dans une autre fenetre. Actualise la liste.');
    const previous=row.account_role,changed=previous!==change.desiredRole;
    if(changed)await c.query('UPDATE maf_users SET account_role=$2 WHERE id=$1',[userId,change.desiredRole]);
    if(change.desiredRole==='player')await revokePartnerInvites(c,userId);
    await c.query(`INSERT INTO maf_partner_role_events(request_key,owner_id,user_id,expected_role,previous_role,new_role,changed)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[change.requestKey,req.userId,userId,change.expectedRole,previous,change.desiredRole,changed]);
    row.account_role=change.desiredRole;
    await c.query('COMMIT');
    res.json({account:view(row),changed,already_applied:false});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}));

partnerAccountsRouter.get('/partner/commissions',run(async(req,res)=>{
  await ensureWallet();
  const row=(await pool.query('SELECT id,client_id,pseudo,account_role,bonus_balance FROM maf_users WHERE id=$1',[req.userId])).rows[0];
  if(!row)throw fail(401,'Compte introuvable.');
  if(accountRole(row)!=='partner')throw fail(403,'Acces reserve aux partenaires actifs.');
  const invitation=await partnerInvitation(pool,req.userId);
  res.json({account:view(row),referrals_enabled:true,commissions_enabled:false,invitation,today:0,last_7_days:0,total:0,bonus_balance:Number(row.bonus_balance||0),daily:[]});
}));
