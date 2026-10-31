import { feeFor } from './walletFees.js';
const fail = message => Object.assign(new Error(message), { status: 409 });

// Caller holds the user lock, then the transaction lock, inside one SQL transaction.
// Paid/refused withdrawals retain their historical amounts. Pending bonus requests
// receive the new rate and the excess previously reserved is returned exactly once.
export async function normalizeBonusWithdrawalFees(c,t,u,actor='system:bonus-withdrawal-fees') {
  if (t.kind !== 'withdrawal' || t.currency !== 'V' || t.status !== 'pending' || Number(t.owner_fee_amount || 0) <= 0) return false;
  if (t.user_id !== u.id) throw fail('Compte de remboursement incompatible.');
  const service = feeFor(Number(t.amount));
  const refund = Number(t.fee_amount || 0) + Number(t.owner_fee_amount) - service;
  if (!Number.isSafeInteger(refund) || refund < 0 || Number(u.bonus_balance) > 2147483647-refund)
    throw fail('Regularisation des frais bonus impossible : plafond ou montant invalide.');
  await c.query('UPDATE maf_users SET bonus_balance=bonus_balance+$2 WHERE id=$1',[u.id,refund]);
  await c.query('UPDATE maf_transactions SET fee_amount=$2,owner_fee_amount=0 WHERE id=$1',[t.id,service]);
  await c.query('INSERT INTO maf_wallet_audit(actor,event,details) VALUES($1,$2,$3)',[
    actor,'bonus_withdrawal_fees_refunded',JSON.stringify({transaction_id:t.id,user_id:u.id,refund,previous_owner_fee:Number(t.owner_fee_amount),service_fee:service})
  ]);
  u.bonus_balance = Number(u.bonus_balance)+refund;
  t.fee_amount = service;
  t.owner_fee_amount = 0;
  return true;
}

export async function refundPendingBonusWithdrawalFees(c) {
  const users=(await c.query(`SELECT DISTINCT user_id FROM maf_transactions
    WHERE kind='withdrawal' AND currency='V' AND status='pending' AND owner_fee_amount>0 ORDER BY user_id`)).rows;
  for(const {user_id} of users) {
    const u=(await c.query('SELECT id,bonus_balance FROM maf_users WHERE id=$1 FOR UPDATE',[user_id])).rows[0];
    if (!u) throw fail('Compte de remboursement introuvable.');
    const pending=(await c.query(`SELECT * FROM maf_transactions WHERE user_id=$1
      AND kind='withdrawal' AND currency='V' AND status='pending' AND owner_fee_amount>0 ORDER BY id FOR UPDATE`,[user_id])).rows;
    for(const t of pending) await normalizeBonusWithdrawalFees(c,t,u);
  }
}
