import { isOwnerAccount, ownerAccountId } from './accountRoles.js';
import crypto from 'node:crypto';
import { feeFor } from './walletFees.js';
import { withdrawalFees } from './ownerFees.js';
import { refundPendingBonusWithdrawalFees, normalizeBonusWithdrawalFees } from './bonusWithdrawalFees.js';
import { createTestAdminAccess, adminActor } from './adminAccess.js';
import { redeemWinPractice } from './winPractice.js';
import { Router } from 'express';
import { pool } from './db.js';
import { ensureTable, requireSession, publicUser, readToken } from './auth.js'; // MAF_OWNER_ADMIN_V1

export const walletRouter = Router();
const MIN = 100, MAX = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = ['awaiting_payment', 'pending', 'approved', 'rejected'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const route = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === '23505') return res.status(409).json({ error: 'Cette reference ou cette capture est deja utilisee.' });
    console.error('wallet:', e.message); next(e);
  }
};
let ready;
export function ensureWallet() {
  if (!ready) ready = (async () => {
    await ensureTable();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(62498102)");
      await c.query(`
        ALTER TABLE maf_users ADD COLUMN IF NOT EXISTS bonus_balance integer NOT NULL DEFAULT 0;
        ALTER TABLE maf_users ADD COLUMN IF NOT EXISTS phone_registered_at timestamptz;
        ALTER TABLE maf_users ADD COLUMN IF NOT EXISTS phone_verification_deadline timestamptz;
        ALTER TABLE maf_users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
        UPDATE maf_users SET phone_registered_at=now(), phone_verification_deadline=now()+interval '10 days'
          WHERE phone IS NOT NULL AND phone_registered_at IS NULL;
        CREATE TABLE IF NOT EXISTS maf_transactions (
          id uuid PRIMARY KEY, user_id integer NOT NULL REFERENCES maf_users(id),
          kind text NOT NULL CHECK(kind IN ('deposit','withdrawal')),
          amount integer NOT NULL CHECK(amount BETWEEN 100 AND 1000000), phone text NOT NULL,
          status text NOT NULL CHECK(status IN ('awaiting_payment','pending','approved','rejected')),
          request_key uuid NOT NULL, proof bytea, proof_type text, proof_hash text UNIQUE,
          payment_reference text UNIQUE, admin_note text,
          created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz, decided_at timestamptz,
          UNIQUE(user_id, request_key),
          CHECK(kind <> 'deposit' OR status NOT IN ('pending','approved') OR proof IS NOT NULL)
        );
        ALTER TABLE maf_transactions ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'F'
          CHECK(currency IN ('F','V'));
        -- Les operations precedentes restent avec 0 F de frais (pas de retroactivite).
        ALTER TABLE maf_transactions ADD COLUMN IF NOT EXISTS fee_amount integer NOT NULL DEFAULT 0;
        -- Zero par defaut : les retraits crees avant la mise a jour ne sont pas recalcules.
        ALTER TABLE maf_transactions ADD COLUMN IF NOT EXISTS owner_fee_amount integer NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS maf_owner_commissions (
          transaction_id uuid PRIMARY KEY REFERENCES maf_transactions(id),
          owner_id integer NOT NULL REFERENCES maf_users(id),
          player_id integer NOT NULL REFERENCES maf_users(id),
          amount integer NOT NULL CHECK (amount > 0),
          currency text NOT NULL CHECK (currency IN ('F','V')),
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS maf_owner_commissions_owner_date ON maf_owner_commissions(owner_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS maf_transactions_user_created ON maf_transactions(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS maf_transactions_status ON maf_transactions(status);
        CREATE TABLE IF NOT EXISTS maf_coupons (
          code text PRIMARY KEY, amount integer NOT NULL CHECK(amount BETWEEN 1 AND 1000000),
          currency text NOT NULL CHECK(currency IN ('F','V')), max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 100000),
          uses integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
          expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE maf_coupons ADD COLUMN IF NOT EXISTS target_client_id integer REFERENCES maf_users(client_id);
        CREATE TABLE IF NOT EXISTS maf_coupon_uses (
          code text NOT NULL REFERENCES maf_coupons(code), user_id integer NOT NULL REFERENCES maf_users(id),
          created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(code,user_id)
        );
        CREATE TABLE IF NOT EXISTS maf_wallet_audit (
          id bigserial PRIMARY KEY, actor text NOT NULL, event text NOT NULL,
          details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      await refundPendingBonusWithdrawalFees(c);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  })().catch(e => { ready = null; throw e; });
  return ready;
}
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const audit = (c, actor, event, details) => c.query(
  'INSERT INTO maf_wallet_audit(actor,event,details) VALUES($1,$2,$3)', [actor,event,JSON.stringify(details)]);
async function user(c, id) {
  const { rows } = await c.query('SELECT * FROM maf_users WHERE id=$1 FOR UPDATE', [id]);
  if (!rows[0]) throw fail(401, 'Compte introuvable.');
  return rows[0];
}
function activePhone(u) {
  if (!u.phone) throw fail(409, 'Enregistre ton numero de telephone avant de continuer.');
  if (!u.phone_verified_at && (!u.phone_verification_deadline || new Date(u.phone_verification_deadline) <= new Date()))
    throw fail(403, 'Le delai de 10 jours est termine. La verification du numero est necessaire.');
}
const amount = value => {
  if (!Number.isSafeInteger(value) || value < MIN || value > MAX) throw fail(400, 'Montant entier requis : 100 a 1 000 000 F CFA.');
  return value;
};
const key = value => { if (!UUID.test(value || '')) throw fail(400, 'request_key UUID v4 requis.'); return value; };
const couponCode = value => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) throw fail(400, 'Code coupon invalide (4 a 40 lettres, chiffres ou tirets).');
  return code;
};
export function normalizePhone(value) {
  const p = typeof value === 'string' ? value.replace(/[\s().-]/g, '') : '';
  const local = p.replace(/^(?:\+225|00225|225)/, '');
  if (!/^(01|05|07)\d{8}$/.test(local)) throw fail(400, 'Numero ivoirien invalide : 10 chiffres commencant par 01, 05 ou 07.');
  return '+225' + local;
}
export function waveUrl(value) {
  const url = new URL('https://pay.wave.com/m/M_ci_zuXWh0fj9YGV/c/ci/');
  if (!Number.isSafeInteger(value) || value < MIN || value > MAX + Math.ceil(MAX / 100))
    throw fail(400,'Montant de paiement invalide.');
  url.searchParams.set('amount', String(value)); return url.toString();
}
const view = row => {
  const { proof, proof_hash, request_key, ...safe } = row;
  const fee = Number(row.fee_amount ?? 0);
  const ownerFee = Number(row.owner_fee_amount ?? 0);
  const total = Number(row.amount) + fee + ownerFee;
  return { ...safe, fee_amount:fee, owner_fee_amount:ownerFee, total_amount:total, has_proof: Boolean(proof_hash),
    ...(row.kind === 'deposit' ? { payment_url: waveUrl(total) } : {}) };
};
export function parseProof(value) {
  if (typeof value !== 'string') throw fail(400, 'Ajoute une capture du paiement.');
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) throw fail(400, 'Capture PNG, JPEG ou WebP requise.');
  const data = Buffer.from(m[2], 'base64');
  if (data.length < 16 || data.length > 2 * 1024 * 1024) throw fail(400, 'Capture invalide ou superieure a 2 Mo.');
  const valid = m[1] === 'png' ? data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) :
    m[1] === 'jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255 :
    data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP';
  if (!valid) throw fail(400, 'Le contenu du fichier ne correspond pas au format annonce.');
  return { data, type: 'image/' + m[1], hash: crypto.createHash('sha256').update(data).digest('hex') };
}
const walletPaths = ['/wallet', '/admin'];
walletRouter.use(walletPaths, (req, res, next) => {
  if (!pool) return res.status(503).json({ error: 'Base de donnees non configuree.' });
  if ((process.env.TOKEN_SECRET || '').length < 32) return res.status(503).json({ error: 'Configurer TOKEN_SECRET (32 caracteres minimum) sur le serveur.' });
  ensureWallet().then(() => next(), next);
});
walletRouter.use('/wallet', requireSession);
walletRouter.use('/admin', (req, res, next) => {
  res.set('Cache-Control','no-store');
  req.adminActor = adminActor(req);
  if (req.adminActor) return next();
  // Acces direct reserve au compte proprietaire authentifie.
  const header = String(req.headers.authorization || '');
  const session = readToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!session || !Number.isSafeInteger(session.uid)) return res.status(403).json({error:'Acces administrateur refuse.'});
  isOwnerAccount(session.uid, pool).then(allowed => {
    if (!allowed) return res.status(403).json({error:'Acces administrateur refuse.'});
    req.adminActor = 'admin:owner:' + session.uid;
    next();
  }).catch(next);
});
walletRouter.get('/wallet', route(async (req,res) => {
  const result = await pool.query('SELECT * FROM maf_users WHERE id=$1',[req.userId]);
  if (!result.rows[0]) throw fail(401, 'Compte introuvable.');
  res.json({ user: publicUser(result.rows[0]) });
}));
// Uniquement au vrai compte 999 connecte, pas aux autres joueurs ni au code admin de test.
walletRouter.get('/wallet/owner-commissions', route(async (req,res) => {
  const owner = (await pool.query('SELECT id,pseudo_key,bonus_balance FROM maf_users WHERE id=$1',[req.userId])).rows[0];
  if (!owner || !await isOwnerAccount(owner.id, pool)) throw fail(403,'Reservé au compte proprietaire.');
  const { rows: [s] } = await pool.query(`
    SELECT coalesce(sum(amount),0)::bigint AS total,
      coalesce(sum(amount) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Abidjan')::date = (now() AT TIME ZONE 'Africa/Abidjan')::date),0)::bigint AS today,
      coalesce(sum(amount) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Abidjan')::date >= (now() AT TIME ZONE 'Africa/Abidjan')::date - 6),0)::bigint AS last_7_days,
      count(*)::integer AS withdrawal_count
    FROM maf_owner_commissions WHERE owner_id=$1`,[owner.id]);
  const { rows } = await pool.query(`
    SELECT (created_at AT TIME ZONE 'Africa/Abidjan')::date AS date,
      sum(amount)::bigint AS amount,count(*)::integer AS withdrawals
    FROM maf_owner_commissions WHERE owner_id=$1
    GROUP BY (created_at AT TIME ZONE 'Africa/Abidjan')::date
    ORDER BY date DESC LIMIT 30`,[owner.id]);
  res.set('Cache-Control','no-store');
  res.json({ owner_bonus_balance:Number(owner.bonus_balance),today:Number(s.today),
    last_7_days:Number(s.last_7_days),total:Number(s.total),withdrawal_count:s.withdrawal_count,
    daily:rows.map(r=>({date:r.date,amount:Number(r.amount),withdrawals:r.withdrawals})) });
}));
walletRouter.post('/wallet/phone', route(async (req,res) => {
  const phone = normalizePhone(req.body.phone);
  if (req.body.accepted !== true) throw fail(400, 'Confirme que ce numero sera definitif.');
  const result = await tx(async c => {
    let u = await user(c,req.userId);
    if (u.phone && normalizePhone(u.phone) !== phone) throw fail(409, 'Le numero est definitif et ne peut pas etre modifie.');
    if (!u.phone) {
      u = (await c.query(`UPDATE maf_users SET phone=$2,phone_registered_at=now(),
        phone_verification_deadline=now()+interval '10 days' WHERE id=$1 RETURNING *`,[u.id,phone])).rows[0];
      await audit(c,`user:${u.id}`,'phone_registered',{ phone });
    }
    return publicUser(u);
  }); res.json({ user: result });
}));
// Le numero est toujours lu sur le compte, jamais dans le formulaire de retrait.
walletRouter.get('/wallet/withdrawal-info', route(async (req,res) => {
  const { rows } = await pool.query(`SELECT u.*, EXISTS(
    SELECT 1 FROM maf_transactions t WHERE t.user_id=u.id AND t.kind='deposit' AND t.status='approved'
  ) AS has_deposit FROM maf_users u WHERE u.id=$1`,[req.userId]);
  if (!rows[0]) throw fail(401,'Compte introuvable.');
  res.set('Cache-Control','no-store');
  res.json({ user:publicUser(rows[0]),has_deposit:rows[0].has_deposit });
}));
for (const kind of ['deposit','withdrawal']) {
  walletRouter.post(`/wallet/${kind}s`, route(async (req,res) => {
    const currency = req.body.currency ?? 'F';
    if (!['F','V'].includes(currency) || kind === 'deposit' && currency !== 'F')
      throw fail(400,'Choisis le solde argent (F) ou bonus (V).');
    const value = amount(req.body.amount),
      breakdown = kind === 'withdrawal' ? withdrawalFees(value,currency) : { fee_amount:feeFor(value),owner_fee_amount:0 },
      transactionFee = breakdown.fee_amount, ownerFee = breakdown.owner_fee_amount,
      debit = value + transactionFee + ownerFee, requestKey = key(req.body.request_key);
    const result = await tx(async c => {
      const u = await user(c,req.userId);
      const prior = (await c.query('SELECT * FROM maf_transactions WHERE user_id=$1 AND request_key=$2',[u.id,requestKey])).rows[0];
      if (prior) {
        if (prior.kind !== kind || prior.amount !== value || prior.currency !== currency)
          throw fail(409, 'Cette cle correspond a une autre demande.');
        return { transaction:view(prior),user:publicUser(u) };
      }
      activePhone(u);
      let updated = u;
      if (kind === 'withdrawal') {
        const deposited = await c.query("SELECT 1 FROM maf_transactions WHERE user_id=$1 AND kind='deposit' AND status='approved' LIMIT 1",[u.id]);
        if (!deposited.rowCount) throw fail(409,'Effectue un premier depot confirme avant de retirer.');
        // Le compte 999 doit exister AVANT de debiter un joueur.
        const ownerAccount = await c.query('SELECT id FROM maf_users WHERE id=$1',[await ownerAccountId(c)]);
        if (!ownerAccount.rowCount) throw fail(503,'Compte de commission indisponible. Reessaie plus tard.');
        const column = currency === 'V' ? 'bonus_balance' : 'balance';
        if (u[column] < debit) throw fail(409,currency === 'V' ? 'Solde bonus insuffisant (retrait + frais de service de 1 %).' : 'Solde argent insuffisant (retrait + frais de 19 %).');
        updated = (await c.query(`UPDATE maf_users SET ${column}=${column}-$2 WHERE id=$1 RETURNING *`,[u.id,debit])).rows[0];
      }
      const row = (await c.query(`INSERT INTO maf_transactions(id,user_id,kind,amount,phone,status,request_key,currency,fee_amount,owner_fee_amount)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[crypto.randomUUID(),u.id,kind,value,u.phone,
        kind === 'deposit' ? 'awaiting_payment' : 'pending',requestKey,currency,transactionFee,ownerFee])).rows[0];
      await audit(c,`user:${u.id}`,kind+'_requested',{ id:row.id,amount:value,fee_amount:transactionFee,owner_fee_amount:ownerFee,total_amount:debit,phone:u.phone,currency });
      return { transaction:view(row),user:publicUser(updated) };
    }); res.status(201).json(result);
  }));
}
walletRouter.get('/wallet/transactions', route(async (req,res) => {
  const limit = Math.min(100,Math.max(1,Number(req.query.limit)||30));
  const offset = Math.max(0,Number(req.query.offset)||0);
  const { rows } = await pool.query(`SELECT id,kind,amount,fee_amount,owner_fee_amount,currency,phone,status,proof_hash,admin_note,created_at,submitted_at,decided_at
    FROM maf_transactions WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,[req.userId,Math.floor(limit),Math.floor(offset)]);
  res.json({ transactions:rows.map(view) });
}));
walletRouter.post('/wallet/deposits/:id/proof', route(async (req,res) => {
  key(req.params.id); const proof = parseProof(req.body.image);
  const row = await tx(async c => {
    const t = (await c.query('SELECT * FROM maf_transactions WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.userId])).rows[0];
    if (!t || t.kind !== 'deposit') throw fail(404,'Depot introuvable.');
    if (t.status !== 'awaiting_payment') {
      if (t.proof_hash === proof.hash) return t;
      throw fail(409,'Cette demande a deja ete soumise.');
    }
    const updated = (await c.query(`UPDATE maf_transactions SET proof=$2,proof_type=$3,proof_hash=$4,
      status='pending',submitted_at=now() WHERE id=$1 RETURNING *`,[t.id,proof.data,proof.type,proof.hash])).rows[0];
    await audit(c,`user:${req.userId}`,'deposit_submitted',{ id:t.id }); return updated;
  }); res.json({ transaction:view(row) });
}));
walletRouter.post('/wallet/coupons/redeem', route(async (req,res) => {
  const access = createTestAdminAccess(req,req.body.code);
  if (access) {
    const exists = await pool.query('SELECT id FROM maf_users WHERE id=$1',[req.userId]);
    if (!exists.rows[0]) throw fail(401,'Compte introuvable.');
    await audit(pool,'user:'+req.userId,'admin_test_opened',{ expires_at:access.expires_at });
    res.set('Cache-Control','no-store');
    return res.json({ admin_access:access });
  }
  const code = couponCode(req.body.code);
  // Les codes WIN donnent acces uniquement a l'entrainement solo, sans solde ni mises.
  if (code.startsWith('WIN-')) {
    const win_access = await redeemWinPractice(code,req.userId);
    if (win_access) { res.set('Cache-Control','no-store'); return res.json({win_access}); }
  }
  const result = await tx(async c => {
    const u = await user(c,req.userId);
    const coupon = (await c.query('SELECT * FROM maf_coupons WHERE code=$1 FOR UPDATE',[code])).rows[0];
    if (!coupon) throw fail(404,'Coupon introuvable.');
    if (coupon.target_client_id != null && coupon.target_client_id !== u.client_id)
      throw fail(403,'Ce coupon est dédié à une personne spécifique.');
    const used = (await c.query('SELECT 1 FROM maf_coupon_uses WHERE code=$1 AND user_id=$2',[code,u.id])).rowCount;
    if (used) return { user:publicUser(u),already_used:true,amount:coupon.amount,currency:coupon.currency };
    if (!coupon.active || coupon.uses >= coupon.max_uses || (coupon.expires_at && new Date(coupon.expires_at) <= new Date()))
      throw fail(409,'Coupon expire, desactive ou epuise.');
    if (coupon.currency === 'F' && u.balance > 2_147_483_647-coupon.amount || coupon.currency === 'V' && u.bonus_balance > 2_147_483_647-coupon.amount)
      throw fail(409,'Plafond du solde atteint.');
    await c.query('INSERT INTO maf_coupon_uses(code,user_id) VALUES($1,$2)',[code,u.id]);
    await c.query('UPDATE maf_coupons SET uses=uses+1 WHERE code=$1',[code]);
    const column = coupon.currency === 'F' ? 'balance' : 'bonus_balance';
    const updated = (await c.query(`UPDATE maf_users SET ${column}=${column}+$2 WHERE id=$1 RETURNING *`,[u.id,coupon.amount])).rows[0];
    await audit(c,`user:${u.id}`,'coupon_redeemed',{ code,amount:coupon.amount,currency:coupon.currency });
    return { user:publicUser(updated),amount:coupon.amount,currency:coupon.currency,already_used:false };
  }); res.json(result);
}));
walletRouter.get('/admin/transactions', route(async (req,res) => {
  const status = req.query.status || null, kind = req.query.kind || null;
  if (status && !statuses.includes(status) || kind && !['deposit','withdrawal'].includes(kind)) throw fail(400,'Filtre invalide.');
  const limit = Math.floor(Math.min(100,Math.max(1,Number(req.query.limit)||50)));
  const offset = Math.floor(Math.max(0,Number(req.query.offset)||0));
  const { rows } = await pool.query(`SELECT t.id,t.user_id,u.pseudo,t.kind,t.amount,t.fee_amount,t.owner_fee_amount,t.currency,t.phone,t.status,t.proof_hash,
    t.payment_reference,t.admin_note,t.created_at,t.submitted_at,t.decided_at FROM maf_transactions t JOIN maf_users u ON u.id=t.user_id
    WHERE ($1::text IS NULL OR t.status=$1) AND ($2::text IS NULL OR t.kind=$2)
    ORDER BY t.created_at DESC,t.id LIMIT $3 OFFSET $4`,[status,kind,limit,offset]);
  const total = (await pool.query(`SELECT count(*)::integer AS total FROM maf_transactions
    WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR kind=$2)`,[status,kind])).rows[0].total;
  res.json({ transactions:rows.map(view),total,limit,offset });
}));
walletRouter.get('/admin/transactions/:id', route(async (req,res) => {
  key(req.params.id);
  const {rows} = await pool.query(`SELECT t.id,t.user_id,u.pseudo,t.kind,t.amount,t.fee_amount,t.owner_fee_amount,t.currency,t.phone,t.status,t.proof_hash,
    t.payment_reference,t.admin_note,t.created_at,t.submitted_at,t.decided_at FROM maf_transactions t JOIN maf_users u ON u.id=t.user_id WHERE t.id=$1`,[req.params.id]);
  if (!rows[0]) throw fail(404,'Demande introuvable.');
  res.json({transaction:view(rows[0])});
}));
walletRouter.get('/admin/transactions/:id/proof', route(async (req,res) => {
  key(req.params.id);
  const t = (await pool.query('SELECT proof,proof_type FROM maf_transactions WHERE id=$1',[req.params.id])).rows[0];
  if (!t?.proof) throw fail(404,'Capture introuvable.');
  res.set({ 'Content-Type':t.proof_type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Content-Disposition':'inline; filename="preuve"' }).send(Buffer.from(t.proof));
}));
for (const kind of ['deposit','withdrawal']) for (const decision of ['approve','reject']) {
  walletRouter.post(`/admin/${kind}s/:id/${decision}`, route(async (req,res) => {
    key(req.params.id);
    const reference = typeof req.body.payment_reference === 'string' ? req.body.payment_reference.trim() : '';
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0,1000) : '';
    if (decision === 'approve' && (reference.length < 4 || reference.length > 160)) throw fail(400,'Reference Wave verifiee requise (4 a 160 caracteres).');
    if (decision === 'reject' && !note) throw fail(400,'Motif du refus requis.');
    const row = await tx(async c => {
      // Toujours verrouiller utilisateur puis transaction pour eviter les interblocages.
      const info = (await c.query('SELECT user_id FROM maf_transactions WHERE id=$1',[req.params.id])).rows[0];
      if (!info) throw fail(404,'Demande introuvable.');
      const u = await user(c,info.user_id);
      const t = (await c.query('SELECT * FROM maf_transactions WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if (t.kind !== kind) throw fail(404,'Demande introuvable.');
      const target = decision === 'approve' ? 'approved' : 'rejected';
      if (t.status === target) {
        if (decision === 'approve' && t.payment_reference !== reference) throw fail(409,'Demande deja confirmee avec une autre reference.');
        return t;
      }
      if (['approved','rejected'].includes(t.status)) throw fail(409,'Demande deja traitee.');
      if (decision === 'approve' && t.status !== 'pending') throw fail(409,'Attendre la capture du paiement avant confirmation.');
      await normalizeBonusWithdrawalFees(c,t,u,req.adminActor);
      if (kind === 'deposit' && decision === 'approve' || kind === 'withdrawal' && decision === 'reject') {
        const column = kind === 'withdrawal' && t.currency === 'V' ? 'bonus_balance' : 'balance';
        // Depot approuve : crediter le montant net. Retrait refuse : restituer AUSSI les frais.
        const credit = kind === 'withdrawal' ? t.amount + (t.fee_amount || 0) + (t.owner_fee_amount || 0) : t.amount;
        if (u[column] > 2_147_483_647-credit) throw fail(409,'Plafond du solde atteint.');
        await c.query(`UPDATE maf_users SET ${column}=${column}+$2 WHERE id=$1`,[u.id,credit]);
      }
      // Crediter les 18 % UNE SEULE FOIS, au moment de la validation du retrait,
      // dans la MEME transaction SQL que la validation. Aucun credit si refus.
      if (kind === 'withdrawal' && decision === 'approve' && Number(t.owner_fee_amount || 0) > 0) {
        const owner = (await c.query('SELECT id,bonus_balance FROM maf_users WHERE id=$1 FOR UPDATE',[await ownerAccountId(c)])).rows[0];
        if (!owner) throw fail(503,'Compte proprietaire introuvable : validation suspendue.');
        const commission = Number(t.owner_fee_amount);
        const recorded = await c.query(`INSERT INTO maf_owner_commissions(transaction_id,owner_id,player_id,amount,currency)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(transaction_id) DO NOTHING RETURNING transaction_id`,
          [t.id,owner.id,t.user_id,commission,t.currency]);
        if (recorded.rowCount) {
          if (owner.bonus_balance > 2147483647 - commission) throw fail(409,'Plafond bonus proprietaire atteint.');
          await c.query('UPDATE maf_users SET bonus_balance=bonus_balance+$2 WHERE id=$1',[owner.id,commission]);
          await audit(c,req.adminActor,'owner_commission_credited',
            {transaction_id:t.id,owner_id:owner.id,player_id:t.user_id,amount:commission,currency:t.currency});
        }
      }
      const updated = (await c.query(`UPDATE maf_transactions SET status=$2,payment_reference=$3,
        admin_note=$4,decided_at=now() WHERE id=$1 RETURNING *`,[t.id,target,decision === 'approve' ? reference : null,note])).rows[0];
      await audit(c,req.adminActor,kind+'_'+target,{ id:t.id,user_id:u.id,amount:t.amount,fee_amount:t.fee_amount || 0,owner_fee_amount:t.owner_fee_amount || 0,total_amount:t.amount+(t.fee_amount || 0)+(t.owner_fee_amount || 0),currency:t.currency,reference,note }); return updated;
    }); res.json({ transaction:view(row) });
  }));
}
walletRouter.get('/admin/phones', route(async (req,res) => {
  const limit = Math.floor(Math.min(100,Math.max(1,Number(req.query.limit)||50)));
  const offset = Math.floor(Math.max(0,Number(req.query.offset)||0));
  const { rows } = await pool.query(`SELECT id,pseudo,phone,phone_registered_at,phone_verification_deadline,phone_verified_at
    FROM maf_users WHERE phone IS NOT NULL AND phone_verified_at IS NULL ORDER BY phone_verification_deadline,id LIMIT $1 OFFSET $2`,[limit,offset]);
  res.json({ users:rows });
}));
walletRouter.post('/admin/users/:id/verify-phone', route(async (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw fail(400,'Identifiant invalide.');
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0,1000) : '';
  if (!note) throw fail(400,'Indique la preuve ou methode de verification dans note.');
  const result = await tx(async c => {
    const u = await user(c,id);
    if (!u.phone) throw fail(409,'Aucun numero enregistre.');
    if (u.phone_verified_at) return publicUser(u);
    const updated = (await c.query('UPDATE maf_users SET phone_verified_at=now() WHERE id=$1 RETURNING *',[id])).rows[0];
    await audit(c,req.adminActor,'phone_verified',{ user_id:id,phone:u.phone,note }); return publicUser(updated);
  }); res.json({ user:result });
}));
// Un coupon utilise n'est jamais reactive : son compteur et ses utilisations restent conserves.
const couponStatus = row => row.uses >= row.max_uses || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
  ? 'expired' : row.active ? 'active' : 'disabled';
const couponView = row => ({ ...row,status:couponStatus(row),
  expiry_reason:row.uses >= row.max_uses ? 'used' : couponStatus(row) === 'expired' ? 'date' : null });
const couponStatusSQL = "CASE WHEN uses>=max_uses OR expires_at<=now() THEN 'expired' WHEN active THEN 'active' ELSE 'disabled' END";
function couponPage(req) {
  const parse = (value,fallback,max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{1,10}$/.test(value) || Number(value)>max) throw fail(400,'Pagination invalide.');
    return Number(value);
  };
  const limit=parse(req.query.limit,25,100),offset=parse(req.query.offset,0,1000000000);
  if (limit<1) throw fail(400,'Pagination invalide.');
  return { limit,offset };
}
walletRouter.post('/admin/coupons', route(async (req,res) => {
  const code = couponCode(req.body.code === undefined ? 'MAF-'+crypto.randomBytes(12).toString('hex').toUpperCase() : req.body.code);
  if (code === (process.env.ADMIN_TEST_ACCESS_CODE || '00999').trim().toUpperCase())
    throw fail(400,'Ce code est reserve a l acces administrateur.');
  const { amount:value, currency='F', max_uses=1, expires_at=null, target_client_id=null } = req.body;
  if (target_client_id !== null && (!Number.isInteger(target_client_id) || target_client_id < 10000 || target_client_id > 99999))
    throw fail(400,'ID client à 5 chiffres requis.');
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX || !['F','V'].includes(currency) ||
    !Number.isSafeInteger(max_uses) || max_uses < 1 || max_uses > 100000) throw fail(400,'Parametres du coupon invalides.');
  if (expires_at !== null && (typeof expires_at !== 'string' || !Number.isFinite(Date.parse(expires_at))))
    throw fail(400,'Date expiration invalide.');
  const result = await tx(async c => {
    // Meme code + memes parametres : une reponse perdue ne cree pas de second coupon.
    await c.query('SELECT pg_advisory_xact_lock(62498104)');
    if (target_client_id !== null && !(await c.query('SELECT 1 FROM maf_users WHERE client_id=$1',[target_client_id])).rowCount)
      throw fail(404,'Aucun client ne correspond à cet ID.');
    const prior = (await c.query('SELECT * FROM maf_coupons WHERE code=$1 FOR UPDATE',[code])).rows[0];
    if (prior) {
      if (prior.amount !== value || prior.currency !== currency || prior.max_uses !== max_uses || (prior.target_client_id ?? null) !== target_client_id ||
        (prior.expires_at ? new Date(prior.expires_at).getTime() : null) !== (expires_at ? Date.parse(expires_at) : null))
        throw fail(409,'Ce code existe deja avec d autres parametres.');
      return { coupon:couponView(prior),already_exists:true };
    }
    if (expires_at !== null && Date.parse(expires_at) <= Date.now()) throw fail(400,'Date expiration future requise.');
    const row = (await c.query(`INSERT INTO maf_coupons(code,amount,currency,max_uses,expires_at,target_client_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[code,value,currency,max_uses,expires_at,target_client_id])).rows[0];
    await audit(c,req.adminActor,'coupon_created',row);
    return { coupon:couponView(row),already_exists:false };
  }); res.status(result.already_exists ? 200 : 201).json(result);
}));
walletRouter.get('/admin/coupons', route(async (req,res) => {
  const { limit,offset }=couponPage(req);
  const status=req.query.status || '';
  if (typeof status !== 'string' || !['','active','expired','disabled'].includes(status)) throw fail(400,'Filtre invalide.');
  const { rows } = await pool.query(`WITH entries AS (SELECT c.*,${couponStatusSQL} AS status FROM maf_coupons c),
    filtered AS (SELECT * FROM entries WHERE ($1::text='' OR status=$1))
    SELECT (SELECT count(*)::integer FROM filtered) AS total,
      (SELECT jsonb_build_object('active',count(*) FILTER (WHERE status='active'),
        'expired',count(*) FILTER (WHERE status='expired'),'disabled',count(*) FILTER (WHERE status='disabled')) FROM entries) AS summary,
      coalesce((SELECT jsonb_agg(p ORDER BY p.created_at DESC,p.code)
        FROM (SELECT * FROM filtered ORDER BY created_at DESC,code LIMIT $2 OFFSET $3) p),'[]'::jsonb) AS coupons`,[status,limit,offset]);
  res.json({ ...rows[0],coupons:rows[0].coupons.map(couponView),limit,offset });
}));
walletRouter.get('/admin/coupons/:code/uses', route(async (req,res) => {
  const code=couponCode(req.params.code), { limit,offset }=couponPage(req);
  const { rows } = await pool.query(`SELECT c.*,
    (SELECT count(*)::integer FROM maf_coupon_uses WHERE code=c.code) AS total,
    coalesce((SELECT jsonb_agg(p ORDER BY p.used_at DESC,p.user_id) FROM (
      SELECT cu.user_id,u.pseudo,cu.created_at AS used_at FROM maf_coupon_uses cu
      JOIN maf_users u ON u.id=cu.user_id WHERE cu.code=c.code
      ORDER BY cu.created_at DESC,cu.user_id LIMIT $2 OFFSET $3) p),'[]'::jsonb) AS redemptions
    FROM maf_coupons c WHERE c.code=$1`,[code,limit,offset]);
  if (!rows[0]) throw fail(404,'Coupon introuvable.');
  const { redemptions,total,...coupon }=rows[0];
  res.json({ coupon:couponView(coupon),redemptions,total,limit,offset });
}));
walletRouter.patch('/admin/coupons/:code', route(async (req,res) => {
  const code = couponCode(req.params.code);
  if (typeof req.body.active !== 'boolean') throw fail(400,'active doit etre true ou false.');
  const coupon = await tx(async c => {
    const existing=(await c.query('SELECT * FROM maf_coupons WHERE code=$1 FOR UPDATE',[code])).rows[0];
    if (!existing) throw fail(404,'Coupon introuvable.');
    if (req.body.active && couponStatus(existing)==='expired') throw fail(409,'Un coupon expire ne peut pas etre reactive.');
    if (existing.active===req.body.active) return couponView(existing);
    const row = (await c.query('UPDATE maf_coupons SET active=$2 WHERE code=$1 RETURNING *',[code,req.body.active])).rows[0];
    await audit(c,req.adminActor,'coupon_status_changed',{ code,active:row.active }); return couponView(row);
  }); res.json({ coupon });
}));

// Donnees publiques du compte uniquement : jamais de code de connexion ni de hash.
walletRouter.get('/admin/users', route(async (req,res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0,80) : '';
  const limit = Math.floor(Math.min(100,Math.max(1,Number(req.query.limit)||25)));
  const offset = Math.floor(Math.max(0,Number(req.query.offset)||0));
  if (!Number.isFinite(offset)) throw fail(400,'Pagination invalide.');
  const where = "($1::text='' OR strpos(lower(pseudo),lower($1))>0 OR strpos(coalesce(phone,''),$1)>0 OR id::text=$1 OR client_id::text=$1)";
  const { rows } = await pool.query(`SELECT id,client_id,pseudo,balance,bonus_balance,phone,created_at,
    phone_registered_at,phone_verified_at,phone_verification_deadline FROM maf_users
    WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,[q,limit,offset]);
  const total = (await pool.query(`SELECT count(*)::integer AS total FROM maf_users WHERE ${where}`,[q])).rows[0].total;
  res.json({ users:rows,total,limit,offset });
}));
walletRouter.get('/admin/summary', route(async (_req,res) => {
  const users = (await pool.query('SELECT count(*)::integer AS total FROM maf_users')).rows[0].total;
  const deposits = (await pool.query(`SELECT status,count(*)::integer AS count,
    coalesce(sum(amount),0)::text AS amount FROM maf_transactions WHERE kind='deposit' GROUP BY status`)).rows;
  res.json({ users,deposits });
}));
