// Droit de decor acquis par cadeau. Migration unique : Matrix n'est plus un fond par defaut.
// Aucune autre operation n'attribue Matrix gratuitement, pas meme au compte 999.
import { pool } from './db.js';

let ready;
export function ensureProfileBackgroundAccess() {
  if (!ready) ready=(async()=>{
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498620)');
      await c.query(`CREATE TABLE IF NOT EXISTS maf_profile_background_unlocks (
        user_id integer NOT NULL REFERENCES maf_users(id) ON DELETE CASCADE,
        background_id text NOT NULL CHECK (background_id IN ('matrix-rain')),
        unlocked_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id, background_id)
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS maf_profile_background_migrations (
        key text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query("ALTER TABLE maf_users ADD COLUMN IF NOT EXISTS profile_background_id text NOT NULL DEFAULT 'classic'");
      await c.query("ALTER TABLE maf_users ALTER COLUMN profile_background_id SET DEFAULT 'classic'");
      const previous=await c.query("SELECT key FROM maf_profile_background_migrations WHERE key='matrix-gift-only-v1'");
      if (!previous.rowCount) {
        // Passe une seule fois tous les comptes, y compris le proprietaire et
        // les profils ayant deja Matrix. Un cadeau ulterieur autorise a le reappliquer.
        await c.query("UPDATE maf_users SET profile_background_id='classic' WHERE profile_background_id IS DISTINCT FROM 'classic'");
        await c.query("INSERT INTO maf_profile_background_migrations(key) VALUES('matrix-gift-only-v1')");
      }
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK').catch(()=>{}); throw e; }
    finally {c.release();}
  })().catch(e=>{ready=null;throw e;});
  return ready;
}

export async function backgroundIsUnlocked(userId, backgroundId, c=pool) {
  if (backgroundId==='classic') return true;
  if (backgroundId!=='matrix-rain') return false;
  await ensureProfileBackgroundAccess();
  const r=await c.query('SELECT 1 FROM maf_profile_background_unlocks WHERE user_id=$1 AND background_id=$2',[userId,backgroundId]);
  return r.rowCount>0;
}
