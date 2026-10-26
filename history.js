// Historique prive : lectures uniquement, aucun recalcul des soldes du compte.
import { Router } from 'express';
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { ensureRooms } from './rooms.js';
import { ensureMonopolyRooms } from './monopolyRooms.js';

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
historyRouter.use((_req,_res,next) => { ensureRooms().then(() => ensureMonopolyRooms()).then(() => next(),next); });

// Une demande de depot/retrait garde une seule ligne avec son etat courant.
// Les mouvements des jeux proviennent du journal atomique, sans doubler les paiements.
const transactions = `
  SELECT 'wallet:' || t.id::text AS id,t.kind,t.amount,t.currency,t.status,
    CASE WHEN t.kind='deposit' AND t.status='approved' THEN t.amount
      WHEN t.kind='withdrawal' AND t.status IN ('pending','approved') THEN -(t.amount+coalesce(t.fee_amount,0)+coalesce(t.owner_fee_amount,0)) ELSE 0 END AS delta,
    t.phone,t.admin_note AS note,t.payment_reference AS reference,
    t.created_at,t.decided_at,NULL::text AS room_code,
    coalesce(t.fee_amount,0)::integer AS fee_amount,(t.amount+coalesce(t.fee_amount,0)+coalesce(t.owner_fee_amount,0))::integer AS total_amount
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
  UNION ALL
  SELECT 'monopoly:' || a.id::text,
    CASE a.event WHEN 'monopoly_stake_locked' THEN 'game_stake'
      WHEN 'monopoly_payout' THEN 'game_payout' ELSE 'game_refund' END,
    CASE WHEN a.event='monopoly_payout' THEN (a.details->>'pot')::integer
      ELSE (a.details->>'stake')::integer END,
    'F','approved',
    CASE WHEN a.event='monopoly_stake_locked' THEN -(a.details->>'stake')::integer
      WHEN a.event='monopoly_payout' THEN (a.details->>'pot')::integer
      ELSE (a.details->>'stake')::integer END,
    NULL,'Monopoly',r.id::text,a.created_at,NULL,trim(r.code),0,
    CASE WHEN a.event='monopoly_payout' THEN (a.details->>'pot')::integer
      ELSE (a.details->>'stake')::integer END
  FROM maf_wallet_audit a
    JOIN maf_monopoly_rooms r ON r.id::text=a.details->>'roomId'
    JOIN maf_monopoly_players p ON p.room_id=r.id AND p.user_id=$1
  WHERE (a.event='monopoly_stake_locked' AND a.details->'ids' @> jsonb_build_array($1::integer))
    OR (a.event='monopoly_payout' AND a.details->>'winner'=$1::text)
    OR a.event IN ('monopoly_refund','monopoly_timeout_refund')
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
  UNION ALL
  SELECT r.id::text,trim(r.code),'monopoly',NULL::integer,r.stake,r.status,r.payout,r.escrow,
    r.created_at,r.updated_at,r.settled_at,
    p.seat::text,
    (SELECT string_agg(u.pseudo,', ' ORDER BY other.seat)
      FROM maf_monopoly_players other JOIN maf_users u ON u.id=other.user_id
      WHERE other.room_id=r.id AND other.user_id<>$1),
    NULL::jsonb,r.winner_id::text,NULL::text,
    CASE WHEN r.status='closed' THEN 'cancelled'
      WHEN r.status='finished' AND r.winner_id=$1 THEN 'won'
      WHEN r.status='finished' AND r.winner_id IS NOT NULL THEN 'lost'
      WHEN r.status='finished' AND r.settled_at IS NOT NULL THEN 'cancelled'
      WHEN r.status='finished' THEN 'unknown' ELSE 'ongoing' END,
    CASE WHEN r.settled_at IS NULL THEN NULL
      WHEN r.winner_id IS NULL THEN 0
      WHEN r.winner_id=$1 THEN r.payout-r.stake ELSE -r.stake END,
    CASE WHEN r.settled_at IS NULL THEN NULL
      WHEN r.winner_id IS NULL THEN r.stake
      WHEN r.winner_id=$1 THEN r.payout ELSE 0 END
  FROM maf_monopoly_rooms r
    JOIN maf_monopoly_players p ON p.room_id=r.id AND p.user_id=$1
  WHERE jsonb_typeof(r.match_state)='object' OR r.escrow>0 OR r.settled_at IS NOT NULL
`;
historyRouter.get('/games',route(async (req,res) => {
  const { limit,offset } = pagination(req);
  const { rows } = await pool.query(`WITH entries AS (${games})
    SELECT (SELECT count(*)::integer FROM entries) AS total,
      (SELECT jsonb_build_object('played',count(*) FILTER (WHERE status='finished'),
        'won',count(*) FILTER (WHERE outcome='won'),'lost',count(*) FILTER (WHERE outcome='lost'),
        'cancelled',count(*) FILTER (WHERE outcome='cancelled'),'net',coalesce(sum(net),0),
        'unsettled',count(*) FILTER (WHERE status='finished' AND net IS NULL)) FROM entries) AS summary,
      coalesce((SELECT jsonb_agg(p ORDER BY p.updated_at DESC,p.id::bigint DESC,p.game DESC)
        FROM (SELECT * FROM entries ORDER BY updated_at DESC,id::bigint DESC,game DESC LIMIT $2 OFFSET $3) p),'[]'::jsonb) AS items`,
    [req.userId,limit,offset]);
  res.json({ ...rows[0],limit,offset });
}));
