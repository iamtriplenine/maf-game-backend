import crypto from 'node:crypto';
import { accountRole } from './accountRoles.js';
import { referralCode, issueReferralProof, readReferralProof } from './referralProof.js';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const invalid=()=>fail(400,'Ce lien de parrainage est invalide ou désactivé.');
let ready;
export function ensureReferralTables(pool){
 if(!ready)ready=(async()=>{
  const c=await pool.connect();
  try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(62498108)');
   await c.query(`CREATE TABLE IF NOT EXISTS maf_partner_invites (
     id uuid PRIMARY KEY,partner_id integer NOT NULL REFERENCES maf_users(id),
     code text NOT NULL UNIQUE CHECK(code ~ '^MAF-[A-F0-9]{24}$'),
     active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
     UNIQUE(id,partner_id),CHECK((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL))
   )`);
   await c.query('CREATE UNIQUE INDEX IF NOT EXISTS maf_partner_invites_active_unique ON maf_partner_invites(partner_id) WHERE active=true');
   await c.query(`CREATE TABLE IF NOT EXISTS maf_user_referrals (
     user_id integer PRIMARY KEY REFERENCES maf_users(id),partner_id integer NOT NULL REFERENCES maf_users(id),
     invitation_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CHECK(user_id<>partner_id),
     FOREIGN KEY(invitation_id,partner_id) REFERENCES maf_partner_invites(id,partner_id)
   )`);
   await c.query('CREATE INDEX IF NOT EXISTS maf_user_referrals_partner_date ON maf_user_referrals(partner_id,created_at DESC)');
   await c.query(`CREATE OR REPLACE FUNCTION maf_protect_user_referrals() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION 'Referral attribution is immutable'; END $$`);
   await c.query(`DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='maf_user_referrals'::regclass AND tgname='maf_user_referrals_immutable') THEN
       CREATE TRIGGER maf_user_referrals_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON maf_user_referrals
         FOR EACH STATEMENT EXECUTE FUNCTION maf_protect_user_referrals();
     END IF;
   END $$`);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 })().catch(e=>{ready=null;throw e;});
 return ready;
}
export async function revokePartnerInvites(c,userId){
 await c.query('UPDATE maf_partner_invites SET active=false,revoked_at=now() WHERE partner_id=$1 AND active=true',[userId]);
}
export async function partnerInvitation(pool,userId){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const user=(await c.query('SELECT id,account_role FROM maf_users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
  if(!user||accountRole(user)!=='partner')throw fail(403,'Accès réservé aux partenaires actifs.');
  let invite=(await c.query('SELECT code FROM maf_partner_invites WHERE partner_id=$1 AND active=true FOR UPDATE',[userId])).rows[0];
  for(let attempt=0;!invite&&attempt<3;attempt++){
   invite=(await c.query(`INSERT INTO maf_partner_invites(id,partner_id,code) VALUES($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING code`,[crypto.randomUUID(),userId,'MAF-'+crypto.randomBytes(12).toString('hex').toUpperCase()])).rows[0];
  }
  if(!invite)throw fail(503,'Impossible de préparer ton lien. Réessaie.');
  const count=(await c.query('SELECT count(*)::int AS count FROM maf_user_referrals WHERE partner_id=$1',[userId])).rows[0].count;
  await c.query('COMMIT');return{code:invite.code,referral_count:count};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function resolveInvitation(pool,code){
 referralCode(code);
 const row=(await pool.query(`SELECT i.id AS invitation_id,i.code,u.id,u.pseudo,u.account_role FROM maf_partner_invites i
   JOIN maf_users u ON u.id=i.partner_id WHERE i.code=$1 AND i.active=true`,[code])).rows[0];
 if(!row||accountRole(row)!=='partner')throw invalid();
 return{code:row.code,partner_pseudo:row.pseudo,...issueReferralProof(row.invitation_id)};
}
export async function registerWithReferral(pool,input,salt,hash,proof){
 const inviteId=proof===undefined?null:readReferralProof(proof);
 const c=await pool.connect();
 try{
  await c.query('BEGIN');let invite;
  if(inviteId){
   const info=(await c.query('SELECT partner_id FROM maf_partner_invites WHERE id=$1',[inviteId])).rows[0];
   if(!info)throw invalid();
   // Same lock order as role revocation: partner account, then invitation.
   const partner=(await c.query('SELECT id,account_role FROM maf_users WHERE id=$1 FOR UPDATE',[info.partner_id])).rows[0];
   invite=(await c.query('SELECT id,partner_id,active FROM maf_partner_invites WHERE id=$1 FOR UPDATE',[inviteId])).rows[0];
   if(!partner||accountRole(partner)!=='partner'||!invite?.active||invite.partner_id!==partner.id)throw invalid();
  }
  const row=(await c.query(`insert into maf_users (pseudo, pseudo_key, code_salt, code_hash)
    values ($1, $2, $3, $4) returning *`,[input.pseudo,input.pseudoKey,salt,hash])).rows[0];
  if(invite)await c.query('INSERT INTO maf_user_referrals(user_id,partner_id,invitation_id) VALUES($1,$2,$3)',[row.id,invite.partner_id,invite.id]);
  await c.query('COMMIT');return row;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
