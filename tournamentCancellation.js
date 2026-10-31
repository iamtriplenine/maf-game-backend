import { isOwnerAccount } from './accountRoles.js';
// Annulation administrateur et tournoi incomplet, etape 3.
// La suppression visible est une suppression logique pour garder l'historique financier.
import { Router } from 'express';
import { pool } from './db.js';
import { ensureTournaments } from './tournaments.js';
import { requireSession } from './auth.js';

export const tournamentCancellationRouter = Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
let schemaReady;
export function ensureTournamentCancellation() {
  if (!schemaReady) schemaReady = (async () => {
    await ensureTournaments();
    if (!pool) throw fail(503, 'Base de donnees indisponible.');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(62498462)');
      await c.query(`
        ALTER TABLE maf_tournaments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
        ALTER TABLE maf_tournaments ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
        ALTER TABLE maf_tournaments ADD COLUMN IF NOT EXISTS cancellation_reason text;
        CREATE TABLE IF NOT EXISTS maf_tournament_refunds (
          tournament_id integer NOT NULL REFERENCES maf_tournaments(id),
          user_id integer NOT NULL REFERENCES maf_users(id),
          amount integer NOT NULL CHECK (amount=500),
          reason text NOT NULL CHECK(reason IN ('owner_deleted','incomplete')),
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(tournament_id,user_id)
        );
        -- Verrouille aussi les nouvelles reservations : pas de course entre
        -- une inscription payante et une suppression/annulation.
        CREATE OR REPLACE FUNCTION maf_tournament_reservation_guard()
        RETURNS trigger LANGUAGE plpgsql AS $guard$
        DECLARE tour record;
        BEGIN
          IF NEW.status <> 'reserved' THEN RETURN NEW; END IF;
          SELECT status,deleted_at,starts_at INTO tour
            FROM maf_tournaments WHERE id=NEW.tournament_id FOR UPDATE;
          IF NOT FOUND OR tour.status <> 'published' OR tour.deleted_at IS NOT NULL
             OR tour.starts_at <= now() THEN
            RAISE EXCEPTION 'Reservation de tournoi fermee ou annulee.' USING ERRCODE='P0001';
          END IF;
          RETURN NEW;
        END;
        $guard$;
        DROP TRIGGER IF EXISTS maf_tournament_reservation_guard_trigger ON maf_tournament_entries;
        CREATE TRIGGER maf_tournament_reservation_guard_trigger
          BEFORE INSERT OR UPDATE OF status ON maf_tournament_entries
          FOR EACH ROW EXECUTE FUNCTION maf_tournament_reservation_guard();
      `);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

async function owner(req) {
  if (!await isOwnerAccount(req.userId, pool)) throw fail(403, 'Acces reserve au proprietaire.');
}

/**
 * Verrouille le tournoi avant ses inscriptions. Le reserveur de l'etape 2
 * DOIT verrouiller la meme ligne avant de debiter ou inserer sa reservation.
 * Une erreur rollback annule TOUS les remboursements et la suppression.
 */
export async function cancelTournament(id, reason, expectedRevision = null) {
  if (!Number.isSafeInteger(id) || id < 1 || !['owner_deleted','incomplete'].includes(reason))
    throw fail(400, 'Demande invalide.');
  await ensureTournamentCancellation();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const tournament = (await c.query(
      'SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE', [id]
    )).rows[0];
    if (!tournament) throw fail(404, 'Tournoi introuvable.');
    if (reason === 'owner_deleted' && tournament.deleted_at) {
      await c.query('COMMIT');
      return { deleted: true, refunded: 0, refundTotal: 0, alreadyDeleted: true };
    }
    if (reason === 'owner_deleted' && tournament.revision !== expectedRevision)
      throw fail(409, 'Tournoi modifie entretemps : actualise la liste.');
    if (reason === 'incomplete' && (
      tournament.status !== 'published' || tournament.cancelled_at ||
      new Date(tournament.starts_at).getTime() > Date.now()
    )) { await c.query('COMMIT'); return null; }

    const entries = (await c.query(`
      SELECT user_id FROM maf_tournament_entries
      WHERE tournament_id=$1 AND status='reserved' ORDER BY user_id FOR UPDATE`, [id]
    )).rows;
    if (reason === 'incomplete' && entries.length >=
        (10)) {
      await c.query('COMMIT');
      return null;
    }
    // Apres un depart presume complet, eviter un remboursement qui
    // contredirait les gains d'une partie eventuellement en cours.
    if (reason === 'owner_deleted' && new Date(tournament.starts_at).getTime() <= Date.now()
        && entries.length >= 10)
      throw fail(409, 'Tournoi complet deja arrive a son heure : suppression bloquee pour proteger les gains.');
    // Une qualification deja lancee ne doit JAMAIS etre remboursee
    // par la tache d'annulation, meme si le feature flag est desactive plus tard.
    const matchTable = (await c.query(`SELECT to_regclass('maf_tournament_qualification_matches') AS name`)).rows[0]?.name;
    const started = matchTable ? await c.query(`SELECT 1 FROM maf_tournament_qualification_matches
      WHERE tournament_id=$1 LIMIT 1`, [id]) : {rowCount:0};
    if (started.rowCount) {
      if (reason === 'incomplete') { await c.query('COMMIT'); return null; }
      throw fail(409, 'Qualifications deja lancees : suppression bloquee.');
    }
    if (Number(tournament.entry_fee) !== 500)
      throw fail(409, 'Mise differente de 500 F : remboursement bloque.');

    await c.query(`UPDATE maf_tournaments SET status='archived',
      cancelled_at=COALESCE(cancelled_at,now()),
      cancellation_reason=COALESCE(cancellation_reason,$2),
      deleted_at=CASE WHEN $2='owner_deleted' THEN now() ELSE deleted_at END,
      revision=revision+1, updated_at=now() WHERE id=$1`, [id, reason]);
    let refunded = 0;
    for (const entry of entries) {
      const ledger = await c.query(`INSERT INTO maf_tournament_refunds
        (tournament_id,user_id,amount,reason) VALUES($1,$2,500,$3)
        ON CONFLICT(tournament_id,user_id) DO NOTHING RETURNING user_id`, [id, entry.user_id, reason]);
      if (ledger.rowCount === 1) {
        const credited = await c.query('UPDATE maf_users SET balance=balance+500 WHERE id=$1 RETURNING id', [entry.user_id]);
        if (credited.rowCount !== 1) throw fail(500, 'Compte introuvable, remboursement annule.');
        refunded++;
      }
      await c.query(`UPDATE maf_tournament_entries SET status='refunded'
        WHERE tournament_id=$1 AND user_id=$2 AND status='reserved'`, [id,entry.user_id]);
    }
    await c.query('COMMIT');
    return { deleted: reason === 'owner_deleted', refunded, refundTotal: refunded * 500, reason };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

// Rattrape les heures passees apres redemarrage. Aucune minuterie navigateur.
let running;
export function maintainTournamentCancellations() {
  if (running) return running;
  running = (async () => {
    await ensureTournamentCancellation();
    const minPlayers = 10;
    const { rows } = await pool.query(`SELECT t.id FROM maf_tournaments t
      WHERE t.status='published' AND t.cancelled_at IS NULL AND t.starts_at <= now()
        AND (SELECT count(*) FROM maf_tournament_entries e
             WHERE e.tournament_id=t.id AND e.status='reserved') < $1
      ORDER BY t.starts_at,t.id LIMIT 100`, [minPlayers]);
    let cancelled = 0;
    for (const row of rows) {
      if (await cancelTournament(Number(row.id), 'incomplete')) cancelled++;
    }
    return cancelled;
  })().finally(() => { running = null; });
  return running;
}

// Les GET permettent aussi le rattrapage apres reveil d'un Render en veille.
let nextCheck = 0;
tournamentCancellationRouter.use((req, _res, next) => {
  if (req.method !== 'GET' || (req.path !== '/' && req.path !== '/owner')) return next();
  if (Date.now() < nextCheck) return next();
  nextCheck = Date.now() + 15000;
  maintainTournamentCancellations().then(() => next(), next);
});

tournamentCancellationRouter.delete('/owner/:id', requireSession, async (req,res,next) => {
  try {
    await ensureTournamentCancellation();
    await owner(req);
    const id = Number(req.params.id);
    const revision = req.body?.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) throw fail(400, 'Version du tournoi requise.');
    const result = await cancelTournament(id, 'owner_deleted', revision);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch(e) {
    if (e.status) return res.status(e.status).json({error:e.message});
    next(e);
  }
});
