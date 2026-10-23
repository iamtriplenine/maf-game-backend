// Public five-digit identifiers; internal user IDs and foreign keys stay intact.
export async function ensureClientIds(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(62498105)');
    await c.query(`
      LOCK TABLE maf_users IN ACCESS EXCLUSIVE MODE;
      CREATE SEQUENCE IF NOT EXISTS maf_client_id_seq AS integer MINVALUE 10000 MAXVALUE 99999 START WITH 10000 NO CYCLE;
      ALTER TABLE maf_users ADD COLUMN IF NOT EXISTS client_id integer;
      ALTER SEQUENCE maf_client_id_seq OWNED BY maf_users.client_id;
      ALTER TABLE maf_users ALTER COLUMN client_id SET DEFAULT nextval('maf_client_id_seq');
      DO $$ DECLARE account record; BEGIN
        FOR account IN SELECT id FROM maf_users WHERE client_id IS NULL ORDER BY id LOOP
          UPDATE maf_users SET client_id=nextval('maf_client_id_seq') WHERE id=account.id;
        END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='maf_users'::regclass AND conname='maf_users_client_id_range') THEN
          ALTER TABLE maf_users ADD CONSTRAINT maf_users_client_id_range CHECK(client_id BETWEEN 10000 AND 99999);
        END IF;
      END $$;
      ALTER TABLE maf_users ALTER COLUMN client_id SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS maf_users_client_id_unique ON maf_users(client_id);
    `);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}
