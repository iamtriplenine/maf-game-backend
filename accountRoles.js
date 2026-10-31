// One immutable owner identity; the partner role never grants owner privileges.
// The legacy pseudo is used only once, when migrating the existing database.
let ownerId = null;
const unavailable = () => Object.assign(new Error('Compte proprietaire non initialise.'), { status: 503 });

export async function ensureAccountRoles(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(62498106)');
    await c.query(`ALTER TABLE maf_users ADD COLUMN IF NOT EXISTS account_role text NOT NULL DEFAULT 'player'`);
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='maf_users'::regclass AND conname='maf_users_account_role_check') THEN
        ALTER TABLE maf_users ADD CONSTRAINT maf_users_account_role_check CHECK(account_role IN ('player','partner'));
      END IF;
    END $$`);
    await c.query(`CREATE TABLE IF NOT EXISTS maf_owner_identity (
      singleton integer PRIMARY KEY CHECK(singleton=1),
      owner_user_id integer NOT NULL UNIQUE REFERENCES maf_users(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Never pick the owner again after migration, even if another account uses 999.
    await c.query(`INSERT INTO maf_owner_identity(singleton,owner_user_id)
      SELECT 1,id FROM maf_users WHERE pseudo_key='999'
      ON CONFLICT(singleton) DO NOTHING`);
    const row = (await c.query(`SELECT o.owner_user_id FROM maf_owner_identity o
      JOIN maf_users u ON u.id=o.owner_user_id WHERE o.singleton=1`)).rows[0];
    if (!Number.isSafeInteger(row?.owner_user_id) || row.owner_user_id < 1) throw unavailable();
    await c.query(`CREATE OR REPLACE FUNCTION maf_protect_owner_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Owner identity is immutable'; END $$`);
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='maf_owner_identity'::regclass AND tgname='maf_owner_identity_immutable') THEN
        CREATE TRIGGER maf_owner_identity_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON maf_owner_identity
          FOR EACH STATEMENT EXECUTE FUNCTION maf_protect_owner_identity();
      END IF;
    END $$`);
    await c.query('COMMIT');
    ownerId = row.owner_user_id;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { c.release(); }
}

// Only server-loaded rows are passed here. A submitted role is never trusted.
export function accountRole(row) {
  if (Number.isSafeInteger(row?.id) && row.id === ownerId) return 'owner';
  return row?.account_role === 'partner' ? 'partner' : 'player';
}

export async function ownerAccountId(c) {
  const row = (await c.query(`SELECT o.owner_user_id FROM maf_owner_identity o
    JOIN maf_users u ON u.id=o.owner_user_id WHERE o.singleton=1`)).rows[0];
  if (!Number.isSafeInteger(row?.owner_user_id) || row.owner_user_id < 1) throw unavailable();
  return row.owner_user_id;
}

export async function isOwnerAccount(userId, c) {
  if (!Number.isSafeInteger(userId) || userId < 1) return false;
  return userId === await ownerAccountId(c);
}

export function privilegedRegistration(body) {
  return ['role','account_role','is_owner','isOwner','owner_id','owner_user_id','permissions'].some(
    key => Object.prototype.hasOwnProperty.call(body || {}, key));
}
