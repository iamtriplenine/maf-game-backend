// MAF_TOURNOI_ETAPE2_V1 : reservation payante d'une place de tournoi Monopoly.
// Une seule transaction : verrou du tournoi -> controles -> debit du solde reel -> place -> trace d'audit.
// Si une etape echoue, tout est annule (jamais de place sans debit, ni de debit sans place).
// Aucune annulation, aucun remboursement et aucune recompense dans cette etape.
import { pool } from './db.js';
import { requireSession } from './auth.js';
import { publicTournamentBookingsEnabled } from './tournamentLaunchPolicy.js';

const ENTRY_FEE = 500;

export async function ensureReservationTables(client) {
  await client.query(`ALTER TABLE maf_tournaments ADD COLUMN IF NOT EXISTS registration_open boolean NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE maf_tournament_entries ADD COLUMN IF NOT EXISTS fee_paid integer NOT NULL DEFAULT 0`);
  // Meme definition que le portefeuille : permet de tracer meme si le portefeuille n'a pas encore ete initialise.
  await client.query(`CREATE TABLE IF NOT EXISTS maf_wallet_audit (
    id bigserial PRIMARY KEY, actor text NOT NULL, event text NOT NULL,
    details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
}

export function mountReservations(router, { select, view, fail, run, owner }) {
  // Places reservees par le joueur connecte (la liste publique reste sans donnee personnelle).
  router.get('/mine', requireSession, run(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT tournament_id FROM maf_tournament_entries WHERE user_id=$1 AND status='reserved' ORDER BY tournament_id",
      [req.userId]);
    res.json({ reserved: rows.map(r => r.tournament_id), serverNow: Date.now() });
  }));

  // Proprietaire : ouvrir ou fermer les reservations d'une annonce publiee.
  router.post('/owner/:id/registration', requireSession, run(async (req, res) => {
    await owner(req);
    const id = Number(req.params.id), revision = req.body?.revision, open = req.body?.open;
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(revision) || revision < 1 || typeof open !== 'boolean')
      throw fail(400, 'Demande invalide.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw fail(404, 'Tournoi introuvable.');
      if (row.revision !== revision) throw fail(409, 'Ce tournoi a été modifié ailleurs. Recharge la liste avant de réessayer.');
      if (open && !publicTournamentBookingsEnabled()) throw fail(409, 'Ouverture payante suspendue : qualifications, finale et paiements doivent etre valides en preproduction avant activation.');
      if (open && row.status !== 'published') throw fail(409, 'Publie l’annonce avant d’ouvrir les réservations.');
      if (open && Date.parse(row.starts_at) <= Date.now()) throw fail(409, 'L’heure des qualifications est passée.');
      await client.query('UPDATE maf_tournaments SET registration_open=$2,revision=revision+1,updated_at=now() WHERE id=$1', [id, open]);
      await client.query(`INSERT INTO maf_wallet_audit(actor,event,details) VALUES('system:tournament',$1,$2)`,
        [open ? 'tournament_registration_opened' : 'tournament_registration_closed',
         JSON.stringify({ tournament_id: id, by: req.userId })]);
      await client.query('COMMIT');
      const fresh = (await pool.query(select + ' WHERE t.id=$1', [id])).rows[0];
      res.json({ tournament: view(fresh), serverNow: Date.now() });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }));

  // Joueur : reserver une place (500 F du solde reel). Rejouer la meme demande ne debite jamais deux fois.
  router.post('/:id/reserve', requireSession, run(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw fail(400, 'Tournoi invalide.');
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      // Le verrou du tournoi serialise toutes les reservations : la capacite ne peut pas etre depassee.
      const t = (await client.query('SELECT * FROM maf_tournaments WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!t || t.status !== 'published') throw fail(404, 'Tournoi introuvable.');
      if (!publicTournamentBookingsEnabled()) throw fail(409, 'Reservations payantes suspendues pendant la validation du grand tournoi.');
      if (!t.registration_open) throw fail(409, 'Les inscriptions ne sont pas ouvertes.');
      if (Date.parse(t.starts_at) <= Date.now()) throw fail(409, 'Les inscriptions sont closes : les qualifications ont commencé.');
      const mine = (await client.query(
        'SELECT status FROM maf_tournament_entries WHERE tournament_id=$1 AND user_id=$2', [id, req.userId])).rows[0];
      if (mine?.status === 'reserved') {
        await client.query('COMMIT');
        result = { alreadyReserved: true, balanceAfter: null };
      } else if (mine) {
        throw fail(409, 'Ta réservation précédente a été annulée : une nouvelle réservation n’est pas possible pour le moment.');
      } else {
        // Nouvelle requete apres le verrou : elle voit les reservations validees par les transactions precedentes.
        const taken = (await client.query(
          "SELECT count(*)::int AS n FROM maf_tournament_entries WHERE tournament_id=$1 AND status='reserved'", [id])).rows[0].n;
        if (taken >= t.capacity) throw fail(409, `Complet : les ${t.capacity} places sont prises.`);
        const debit = await client.query(
          'UPDATE maf_users SET balance=balance-$2 WHERE id=$1 AND balance>=$2 RETURNING balance', [req.userId, ENTRY_FEE]);
        if (!debit.rowCount) {
          const exists = (await client.query('SELECT 1 FROM maf_users WHERE id=$1', [req.userId])).rowCount;
          throw exists ? fail(402, `Solde réel insuffisant : il faut ${ENTRY_FEE} F pour réserver une place.`) : fail(401, 'Compte introuvable.');
        }
        await client.query(
          "INSERT INTO maf_tournament_entries(tournament_id,user_id,status,fee_paid) VALUES($1,$2,'reserved',$3)",
          [id, req.userId, ENTRY_FEE]);
        await client.query(`INSERT INTO maf_wallet_audit(actor,event,details) VALUES('system:tournament','tournament_entry',$1)`,
          [JSON.stringify({ tournament_id: id, user_id: req.userId, amount: ENTRY_FEE, balance_after: debit.rows[0].balance, place: taken + 1 })]);
        await client.query('COMMIT');
        result = { alreadyReserved: false, balanceAfter: debit.rows[0].balance, place: taken + 1 };
      }
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    const fresh = (await pool.query(select + ' WHERE t.id=$1', [id])).rows[0];
    res.status(result.alreadyReserved ? 200 : 201).json({
      reservation: { tournamentId: id, fee: ENTRY_FEE, ...result }, tournament: view(fresh), serverNow: Date.now() });
  }));
}
