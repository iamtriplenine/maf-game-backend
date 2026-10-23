// Regles transversales des salons. Ne depend d'aucun moteur de jeu.
export const MAX_HOST_ROOMS = 5;

const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const active = "('open','pending','ready','playing')";

// Fonction pure pour tester la politique sans se connecter a PostgreSQL.
export function validateRoomSlots(memberships, userId, game) {
  const uid = Number(userId);
  if (memberships.some((room) => Number(room.guest_id) === uid)) {
    throw conflict('Tu participes deja a un salon comme adversaire. Termine ou quitte ce salon avant de creer le tien.');
  }
  const hosted = memberships.filter((room) => Number(room.host_id) === uid);
  if (hosted.some((room) => room.game === game)) {
    throw conflict('Tu as deja un salon actif pour ce jeu. Ferme-le pour en creer un autre.');
  }
  if (hosted.length >= MAX_HOST_ROOMS) {
    throw conflict('Tu as atteint la limite de 5 salons actifs. Ferme un salon pour en creer un nouveau.');
  }
}

// Appeler dans la transaction globale du module rooms.js.
export async function assertCanCreateRoom(client, userId, game) {
  const { rows } = await client.query(`
    SELECT host_id, guest_id, game FROM maf_rooms
    WHERE status IN ${active} AND (host_id=$1 OR guest_id=$1)`, [userId]);
  validateRoomSlots(rows, userId, game);
}

// Deux salons d'un meme createur ne peuvent jamais recevoir des demandes en parallele.
// Ce controle est aussi effectue a l'acceptation pour proteger les anciens salons.
export async function assertHostAvailable(client, hostId, roomId) {
  const { rows } = await client.query(`
    SELECT id FROM maf_rooms WHERE host_id=$1 AND id<>$2
    AND status IN ('pending','ready','playing') LIMIT 1`, [hostId, roomId]);
  if (rows.length) {
    throw conflict('Le createur est occupe dans un autre salon. Reessaie apres la fin de sa partie ou de sa demande.');
  }
}
