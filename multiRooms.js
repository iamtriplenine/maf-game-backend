// Regles transversales des salons. Ne depend d'aucun moteur de jeu.
export const MAX_HOST_ROOMS = 5;

const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const active = "('open','pending','ready','playing')";

// Fonction pure pour tester la politique sans se connecter a PostgreSQL.
export function validateRoomSlots(memberships, userId, game) {
  const uid = Number(userId);
  // Un salon cree ou une demande en attente ne bloque aucune creation.
  // MAF_ROOMS_FREE_UNTIL_ACCEPTED_V1
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

// La demande en attente ne bloque pas les autres salons.
// Des que le createur joue ailleurs (comme hote OU invite), ses salons attendent.
export async function assertHostAvailable(client, hostId, roomId) {
  const { rows } = await client.query(`
    SELECT id FROM maf_rooms WHERE id<>$2 AND status IN ('ready','playing')
      AND (host_id=$1 OR guest_id=$1) LIMIT 1`, [hostId, roomId]);
  if (rows.length) throw conflict('En partie, veuillez patienter jusqu a la fin du match du createur.');
}

// Une personne peut posseder cinq salons tout en demandant a rejoindre un autre.
// Une seule demande sortante a la fois, et aucune nouvelle demande pendant un match accepte.
export async function assertCanRequestRoom(client, userId, roomId) {
  const { rows } = await client.query(`
    SELECT id FROM maf_rooms WHERE id<>$2
      AND ((guest_id=$1 AND status IN ('pending','ready','playing'))
        OR (host_id=$1 AND status IN ('ready','playing'))) LIMIT 1`, [userId, roomId]);
  if (rows.length) throw conflict('Tu as deja une demande en attente ou une partie acceptee. Termine ou annule avant de demander un autre salon.');
}

// Au moment d'accepter, aucun des DEUX joueurs ne doit deja etre dans un match.
// Appeler sous le verrou de transaction global des salons pour eviter les doubles acceptations.
export async function assertPlayersAvailable(client, hostId, guestId, roomId) {
  const { rows } = await client.query(`
    SELECT id FROM maf_rooms WHERE id<>$2 AND status IN ('ready','playing')
      AND (host_id=ANY($1::int[]) OR guest_id=ANY($1::int[])) LIMIT 1`, [[hostId,guestId], roomId]);
  if (rows.length) throw conflict('Un des deux joueurs est deja en partie. Veuillez patienter avant d accepter.');
}
