import { Router } from 'express';
import { pool } from './db.js';
import { ensureWallet } from './wallet.js';
import { readToken } from './auth.js';
import { validOwnerNoticeEvent } from './ownerNotificationsRules.js';

export const ownerNotificationsRouter = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let receiptsReady;
function ensureReceipts() {
  if (!receiptsReady) receiptsReady = pool.query(`CREATE TABLE IF NOT EXISTS maf_owner_notification_receipts (
    owner_id integer NOT NULL REFERENCES maf_users(id),
    transaction_id uuid NOT NULL REFERENCES maf_transactions(id),
    event text NOT NULL CHECK (event IN ('requested','submitted')),
    dismissed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(owner_id,transaction_id,event)
  )`).catch(error=>{ receiptsReady=null; throw error; });
  return receiptsReady;
}
const guarded = fn => async (req,res,next) => {
  try { await fn(req,res); } catch (error) { next(error); }
};

// Identite verifiee en base apres validation du jeton signe : ne jamais faire
// confiance a un pseudo envoye par le navigateur ou au code admin de test.
ownerNotificationsRouter.use(async (req,res,next) => {
  try {
  if (!pool) return res.status(503).json({error:'Base de donnees indisponible.'});
  if ((process.env.TOKEN_SECRET || '').length < 32) return res.status(503).json({error:'TOKEN_SECRET absent.'});
  await ensureWallet();
  const bearer=String(req.headers.authorization || '');
  const data=readToken(bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
  if (!data || !Number.isSafeInteger(data.uid)) return res.status(401).json({error:'Session expiree.'});
  req.userId=data.uid;
  const {rows} = await pool.query('SELECT pseudo_key FROM maf_users WHERE id=$1',[req.userId]);
  if (rows[0]?.pseudo_key !== '999') return res.status(403).json({error:'Acces prive refuse.'});
  await ensureReceipts();
  req.ownerId = req.userId;
  next();
  } catch(error) {next(error);}
});

ownerNotificationsRouter.get('/notifications', guarded(async (req,res) => {
  if (res.headersSent || !req.ownerId) return;
  // Une alerte a la creation et une seconde lorsque la preuve du depot arrive.
  // La fermeture d'une alerte n'efface jamais la demande ni les autres alertes.
  const {rows} = await pool.query(`
    WITH events AS (
      SELECT t.id,t.kind,t.amount,t.currency,t.status,t.created_at AS happened_at,
        t.created_at,t.submitted_at,t.user_id,u.pseudo,'requested'::text AS event
      FROM maf_transactions t JOIN maf_users u ON u.id=t.user_id
      UNION ALL
      SELECT t.id,t.kind,t.amount,t.currency,t.status,t.submitted_at AS happened_at,
        t.created_at,t.submitted_at,t.user_id,u.pseudo,'submitted'::text AS event
      FROM maf_transactions t JOIN maf_users u ON u.id=t.user_id
      WHERE t.kind='deposit' AND t.submitted_at IS NOT NULL
    )
    SELECT e.* FROM events e
    WHERE NOT EXISTS (
      SELECT 1 FROM maf_owner_notification_receipts a
      WHERE a.owner_id=$1 AND a.transaction_id=e.id AND a.event=e.event
    )
    ORDER BY e.happened_at DESC,e.id DESC LIMIT 100`,[req.ownerId]);
  res.set('Cache-Control','no-store');
  res.json({notifications:rows,has_more:rows.length===100});
}));

ownerNotificationsRouter.post('/notifications/:id/ack', guarded(async (req,res) => {
  if (res.headersSent || !req.ownerId) return;
  const id = req.params.id, event = req.body?.event;
  if (!uuid.test(id) || !validOwnerNoticeEvent(event)) return res.status(400).json({error:'Alerte invalide.'});
  // L'evenement doit exister reellement pour eviter les recus inventes.
  const {rowCount}=await pool.query(`SELECT 1 FROM maf_transactions t WHERE t.id=$1
    AND ($2='requested' OR ($2='submitted' AND t.kind='deposit' AND t.submitted_at IS NOT NULL))`,[id,event]);
  if (!rowCount) return res.status(404).json({error:'Demande introuvable.'});
  await pool.query(`INSERT INTO maf_owner_notification_receipts(owner_id,transaction_id,event)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[req.ownerId,id,event]);
  res.set('Cache-Control','no-store');
  res.json({ok:true});
}));
