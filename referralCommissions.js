import { accountRole } from './accountRoles.js';
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function referralCommissionAmount(amount){
 if(!Number.isSafeInteger(amount)||amount<100||amount>1000000)throw fail(400,'Montant de rechargement invalide.');
 return Math.floor(amount/10);
}
export function commissionHistoryOffset(value='0'){
 if(typeof value!=='string'||! /^(0|[1-9]\d*)$/.test(value)||Number(value)>1000000)throw fail(400,'Page de commissions invalide.');
 return Number(value);
}
// Called inside the wallet schema transaction, after users/referrals/transactions exist.
export async function ensureReferralCommissions(c){
 await c.query('CREATE UNIQUE INDEX IF NOT EXISTS maf_user_referrals_pair_unique ON maf_user_referrals(user_id,partner_id)');
 await c.query(`CREATE TABLE IF NOT EXISTS maf_referral_commissions (
   transaction_id uuid PRIMARY KEY REFERENCES maf_transactions(id),
   partner_id integer NOT NULL REFERENCES maf_users(id),player_id integer NOT NULL,
   deposit_amount integer NOT NULL CHECK(deposit_amount BETWEEN 100 AND 1000000),
   amount integer NOT NULL CHECK(amount=deposit_amount/10 AND amount>0),
   created_at timestamptz NOT NULL DEFAULT now(),CHECK(partner_id<>player_id),
   FOREIGN KEY(player_id,partner_id) REFERENCES maf_user_referrals(user_id,partner_id)
 )`);
 await c.query('CREATE INDEX IF NOT EXISTS maf_referral_commissions_partner_date ON maf_referral_commissions(partner_id,created_at DESC,transaction_id)');
 await c.query(`CREATE OR REPLACE FUNCTION maf_protect_referral_commissions() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'Referral commissions are immutable'; END $$`);
 await c.query(`DO $$ BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='maf_referral_commissions'::regclass AND tgname='maf_referral_commissions_immutable') THEN
     CREATE TRIGGER maf_referral_commissions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON maf_referral_commissions
       FOR EACH STATEMENT EXECUTE FUNCTION maf_protect_referral_commissions();
   END IF;
 END $$`);
 // A rolling deployment must not silently approve a referred recharge on an old server.
 await c.query(`CREATE OR REPLACE FUNCTION maf_require_referral_deposit_credit() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE sponsor integer;
   BEGIN
     IF OLD.status='approved' OR NEW.status<>'approved' OR NEW.kind<>'deposit' OR NEW.currency<>'F' THEN RETURN NULL; END IF;
     SELECT r.partner_id INTO sponsor FROM maf_user_referrals r JOIN maf_users p ON p.id=r.partner_id
       WHERE r.user_id=NEW.user_id AND p.account_role='partner'
       AND NOT EXISTS(SELECT 1 FROM maf_owner_identity o WHERE o.owner_user_id=p.id);
     IF sponsor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM maf_referral_commissions c WHERE c.transaction_id=NEW.id
       AND c.partner_id=sponsor AND c.player_id=NEW.user_id AND c.deposit_amount=NEW.amount AND c.amount=NEW.amount/10) THEN
       RAISE EXCEPTION 'Referral credit required before approving this deposit';
     END IF;
     RETURN NULL;
   END $$`);
 await c.query(`CREATE OR REPLACE FUNCTION maf_require_confirmed_referral_credit() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NOT EXISTS(SELECT 1 FROM maf_transactions t WHERE t.id=NEW.transaction_id AND t.kind='deposit'
       AND t.currency='F' AND t.status='approved' AND t.user_id=NEW.player_id AND t.amount=NEW.deposit_amount) THEN
       RAISE EXCEPTION 'Referral commission requires a confirmed matching deposit';
     END IF;
     RETURN NULL;
   END $$`);
 await c.query(`DO $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='maf_transactions'::regclass AND tgname='maf_deposit_referral_credit_required') THEN
     CREATE CONSTRAINT TRIGGER maf_deposit_referral_credit_required AFTER UPDATE OF status ON maf_transactions
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maf_require_referral_deposit_credit();
   END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='maf_referral_commissions'::regclass AND tgname='maf_referral_credit_confirmed') THEN
     CREATE CONSTRAINT TRIGGER maf_referral_credit_confirmed AFTER INSERT ON maf_referral_commissions
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maf_require_confirmed_referral_credit();
   END IF;
 END $$`);

}
// The caller locks both accounts in ascending ID order, then the deposit row.
// This credit, the player's recharge, payment decision and audit share ONE SQL transaction.
export async function creditReferralDeposit(c,t,actor='system:referral-commission'){
 if(t.kind!=='deposit'||t.currency!=='F'||t.status!=='pending')return false;
 const referral=(await c.query('SELECT partner_id FROM maf_user_referrals WHERE user_id=$1',[t.user_id])).rows[0];
 if(!referral)return false;
 const amount=referralCommissionAmount(Number(t.amount));
 const existing=(await c.query('SELECT partner_id,player_id,deposit_amount,amount FROM maf_referral_commissions WHERE transaction_id=$1',[t.id])).rows[0];
 if(existing){
  if(existing.partner_id!==referral.partner_id||existing.player_id!==t.user_id||existing.deposit_amount!==Number(t.amount)||existing.amount!==amount)throw fail(409,'Commission existante incompatible : validation suspendue.');
  return false;
 }
 const partner=(await c.query('SELECT id,account_role,bonus_balance FROM maf_users WHERE id=$1 FOR UPDATE',[referral.partner_id])).rows[0];
 if(!partner)throw fail(409,'Compte partenaire introuvable : validation suspendue.');
 if(accountRole(partner)!=='partner'){
  await c.query('INSERT INTO maf_wallet_audit(actor,event,details) VALUES($1,$2,$3)',[actor,'referral_commission_skipped',JSON.stringify({transaction_id:t.id,partner_id:partner.id,player_id:t.user_id,reason:'inactive_partner'})]);
  return false;
 }
 if(partner.bonus_balance==null||!Number.isSafeInteger(Number(partner.bonus_balance))||Number(partner.bonus_balance)<0||Number(partner.bonus_balance)>2147483647-amount)throw fail(409,'Solde bonus du partenaire au plafond. Réessaie la validation après un retrait de ses bonus.');
 const recorded=await c.query(`INSERT INTO maf_referral_commissions(transaction_id,partner_id,player_id,deposit_amount,amount)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT(transaction_id) DO NOTHING RETURNING transaction_id`,[t.id,partner.id,t.user_id,t.amount,amount]);
 if(!recorded.rowCount)return false;
 await c.query('UPDATE maf_users SET bonus_balance=bonus_balance+$2 WHERE id=$1',[partner.id,amount]);
 await c.query('INSERT INTO maf_wallet_audit(actor,event,details) VALUES($1,$2,$3)',[actor,'referral_commission_credited',JSON.stringify({transaction_id:t.id,partner_id:partner.id,player_id:t.user_id,deposit_amount:Number(t.amount),amount,currency:'V'})]);
 return true;
}
export async function referralCommissionSummary(pool,userId,offset=0){
 const c=await pool.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const partner=(await c.query('SELECT id,account_role,bonus_balance FROM maf_users WHERE id=$1',[userId])).rows[0];
  if(!partner||accountRole(partner)!=='partner')throw fail(403,'Accès réservé aux partenaires actifs.');
  const s=(await c.query(`SELECT coalesce(sum(amount),0)::bigint AS total,count(*)::int AS deposit_count,
    coalesce(sum(amount) FILTER(WHERE (created_at AT TIME ZONE 'Africa/Abidjan')::date=(now() AT TIME ZONE 'Africa/Abidjan')::date),0)::bigint AS today,
    coalesce(sum(amount) FILTER(WHERE (created_at AT TIME ZONE 'Africa/Abidjan')::date BETWEEN (now() AT TIME ZONE 'Africa/Abidjan')::date-6 AND (now() AT TIME ZONE 'Africa/Abidjan')::date),0)::bigint AS last_7_days
    FROM maf_referral_commissions WHERE partner_id=$1`,[userId])).rows[0];
  const daily=(await c.query(`SELECT to_char(created_at AT TIME ZONE 'Africa/Abidjan','YYYY-MM-DD') AS date,
    sum(amount)::bigint AS amount,count(*)::int AS deposits FROM maf_referral_commissions WHERE partner_id=$1
    GROUP BY 1 ORDER BY 1 DESC LIMIT 30`,[userId])).rows;
  const history=(await c.query(`SELECT c.transaction_id,c.deposit_amount,c.amount,c.created_at,u.pseudo AS player_pseudo
    FROM maf_referral_commissions c JOIN maf_users u ON u.id=c.player_id WHERE c.partner_id=$1
    ORDER BY c.created_at DESC,c.transaction_id DESC LIMIT 21 OFFSET $2`,[userId,offset])).rows;
  await c.query('COMMIT');
  return{today:Number(s.today),last_7_days:Number(s.last_7_days),total:Number(s.total),deposit_count:s.deposit_count,bonus_balance:Number(partner.bonus_balance),
    daily:daily.map(x=>({...x,amount:Number(x.amount)})),history:history.slice(0,20),history_offset:offset,has_more:history.length>20};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
