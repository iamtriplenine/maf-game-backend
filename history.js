// Historique prive : lectures uniquement, aucun recalcul des soldes du compte.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureRooms } from './rooms.js';

export const historyRouter = Router();
const route = fn => async (req,res,next) => {
  try { await fn(req,res); } catch(error) {
    if (error.status) return res.status(error.status).json({ error:error.message });
    next(error);
  }
};
function pagination(req) {
  const parse = (value,fallback,max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{1,10}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
      throw Object.assign(new Error('Pagination invalide.'),{ status:400 });
    return Number(value);
  };
  const limit = parse(req.query.limit,20,100), offset = parse(req.query.offset,0,1000000000);
  if (limit < 1) throw Object.assign(new Error('Pagination invalide.'),{ status:400 });
  return { limit,offset };
}
historyRouter.use((_req,res,next) => {
  res.set('Cache-Control','no-store');
  if (!pool) return res.status(503).json({ error:'Base de donnees non configuree.' });
  next();
});
historyRouter.use(requireSession);
historyRouter.use((_req,_res,next) => { ensureRooms().then(() => next(),next); });

// Une demande de depot/retrait garde une seule ligne avec son etat courant.
// Les mouvements des jeux proviennent du journal atomique, sans doubler les paiements.
const transactions = `
  SELECT 'wallet:' || t.id::text AS id,t.kind,t.amount,t.currency,t.status,
    CASE WHEN t.kind='deposit' AND t.status='approved' THEN t.amount
      WHEN t.kind='withdrawal' AND t.status IN ('pending','approved') THEN -(t.amount+coalesce(t.fee_amount,0)) ELSE 0 END AS delta,
    t.phone,t.admin_note AS note,t.payment_reference AS reference,
    t.created_at,t.decided_at,NULL::text AS room_code,
    coalesce(t.fee_amount,0)::integer AS fee_amount,(t.amount+coalesce(t.fee_amount,0))::integer AS total_amount
  FROM maf_transactions t WHERE t.user_id=$1
  UNION ALL
  SELECT 'coupon:' || cu.code,'coupon',c.amount,c.currency,'approved',c.amount,
    NULL,NULL,cu.code,cu.created_at,NULL,NULL,0,c.amount
  FROM maf_coupon_uses cu JOIN maf_coupons c ON c.code=cu.code WHERE cu.user_id=$1
  UNION ALL
  SELECT 'game:' || a.id::text,
    CASE a.event WHEN 'room_stakes_held' THEN 'game_stake' WHEN 'room_payout' THEN 'game_payout' ELSE 'game_refund' END,
    CASE WHEN a.event='room_payout' THEN (a.details->>'amount')::integer ELSE (a.details->>'amount_each')::integer END,
    'F','approved',
    CASE WHEN a.event='room_stakes_held' THEN -(a.details->>'amount_each')::integer
      WHEN a.event='room_payout' THEN (a.details->>'amount')::integer ELSE (a.details->>'amount_each')::integer END,
    NULL,NULL,r.id::text,a.created_at,NULL,trim(r.code),0,
    CASE WHEN a.event='room_payout' THEN (a.details->>'amount')::integer ELSE (a.details->>'amount_each')::integer END
  FROM maf_wallet_audit a JOIN maf_rooms r ON r.id::text=a.details->>'room_id'
  WHERE (a.event IN ('room_stakes_held','room_refund') AND a.details->'users' @> jsonb_build_array($1::integer))
    OR (a.event='room_payout' AND a.details->>'winner_id'=$1::text)
    OR (a.event='room_refund_expired' AND (r.host_id=$1 OR r.guest_id=$1))
`;
historyRouter.get('/transactions',route(async (req,res) => {
  const { limit,offset } = pagination(req);
  const { rows } = await pool.query(`WITH entries AS (${transactions})
    SELECT (SELECT count(*)::integer FROM entries) AS total,
      coalesce((SELECT jsonb_agg(p ORDER BY p.created_at DESC,p.id DESC)
        FROM (SELECT * FROM entries ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3) p),'[]'::jsonb) AS items`,
    [req.userId,limit,offset]);
  res.json({ ...rows[0],limit,offset });
}));

const games = `
  SELECT r.id::text AS id,trim(r.code) AS code,r.game,r.shots,r.stake,r.status,r.payout,r.escrow,
    r.created_at,r.updated_at,r.settled_at,
    CASE WHEN r.host_id=$1 THEN 'host' ELSE 'guest' END AS viewer_side,
    CASE WHEN r.host_id=$1 THEN g.pseudo ELSE h.pseudo END AS opponent,
    r.match_state->'scores' AS scores,r.match_state->>'winner' AS winner_side,
    r.match_state->>'forfeit' AS forfeit_side,
    CASE WHEN r.status='closed' THEN 'cancelled'
      WHEN r.status='finished' AND r.match_state->>'winner'=CASE WHEN r.host_id=$1 THEN 'host' ELSE 'guest' END THEN 'won'
      WHEN r.status='finished' AND r.match_state->>'winner' IN ('host','guest') THEN 'lost'
      WHEN r.status='finished' THEN 'unknown' ELSE 'ongoing' END AS outcome,
    CASE WHEN r.status='closed' AND r.settled_at IS NOT NULL THEN 0
      WHEN r.status='finished' AND r.settled_at IS NOT NULL AND r.payout>0
        AND r.match_state->>'winner' IN ('host','guest') THEN
          CASE WHEN r.match_state->>'winner'=CASE WHEN r.host_id=$1 THEN 'host' ELSE 'guest' END
          THEN r.payout-r.stake ELSE -r.stake END ELSE NULL END AS net,
    CASE WHEN r.status='closed' AND r.settled_at IS NOT NULL THEN r.stake
      WHEN r.status='finished' AND r.settled_at IS NOT NULL AND r.payout>0
        AND r.match_state->>'winner' IN ('host','guest') THEN
          CASE WHEN r.match_state->>'winner'=CASE WHEN r.host_id=$1 THEN 'host' ELSE 'guest' END
          THEN r.payout ELSE 0 END ELSE NULL END AS received
  FROM maf_rooms r JOIN maf_users h ON h.id=r.host_id LEFT JOIN maf_users g ON g.id=r.guest_id
  WHERE (r.host_id=$1 OR r.guest_id=$1)
    AND (jsonb_typeof(r.match_state)='object' OR r.escrow>0 OR r.settled_at IS NOT NULL)
`;
historyRouter.get('/games',route(async (req,res) => {
  const { limit,offset } = pagination(req);
  const { rows } = await pool.query(`WITH entries AS (${games})
    SELECT (SELECT count(*)::integer FROM entries) AS total,
      (SELECT jsonb_build_object('played',count(*) FILTER (WHERE status='finished'),
        'won',count(*) FILTER (WHERE outcome='won'),'lost',count(*) FILTER (WHERE outcome='lost'),
        'cancelled',count(*) FILTER (WHERE outcome='cancelled'),'net',coalesce(sum(net),0),
        'unsettled',count(*) FILTER (WHERE status='finished' AND net IS NULL)) FROM entries) AS summary,
      coalesce((SELECT jsonb_agg(p ORDER BY p.updated_at DESC,p.id::bigint DESC)
        FROM (SELECT * FROM entries ORDER BY updated_at DESC,id::bigint DESC LIMIT $2 OFFSET $3) p),'[]'::jsonb) AS items`,
    [req.userId,limit,offset]);
  res.json({ ...rows[0],limit,offset });
}));
