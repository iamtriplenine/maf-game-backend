import { isOwnerAccount, ownerAccountId } from './accountRoles.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

// Called inside one transaction. Locking the account serializes deletion with
// wallet credits/debits and prevents a concurrently funded account being removed.
export async function deleteEmptyAccount(c, actorId, targetId, confirmation) {
  if (!await isOwnerAccount(actorId, c)) throw fail(403, 'Suppression réservée au propriétaire.');
  if (!Number.isSafeInteger(targetId) || targetId < 1) throw fail(400, 'Identifiant invalide.');
  if (targetId === await ownerAccountId(c)) throw fail(403, 'Le compte propriétaire ne peut pas être supprimé.');
  const user = (await c.query('SELECT * FROM maf_users WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
  if (!user) throw fail(404, 'Ce compte a déjà été supprimé ou est introuvable.');
  if (confirmation !== `SUPPRIMER ${user.client_id}`) throw fail(400, 'La confirmation ne correspond pas au compte.');
  if (Number(user.balance) !== 0 || Number(user.bonus_balance) !== 0)
    throw fail(409, 'Suppression refusée : le compte doit avoir exactement 0 F et 0 V.');
  // Keep the database's foreign-key protections: never erase financial,
  // tournament or referral history to make an account deletable.
  await c.query('DELETE FROM maf_users WHERE id=$1', [targetId]);
  await c.query('INSERT INTO maf_wallet_audit(actor,event,details) VALUES($1,$2,$3)', [
    'admin:owner:' + actorId, 'empty_account_deleted',
    JSON.stringify({ user_id: user.id, client_id: user.client_id, pseudo: user.pseudo,
      created_at: user.created_at, balance: 0, bonus_balance: 0 }),
  ]);
  return { id: user.id, client_id: user.client_id, pseudo: user.pseudo };
}
