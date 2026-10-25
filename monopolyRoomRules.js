// Etats de salon : la proposition ne declenche aucun debit tant que tous n'ont pas accepte.
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const MIN_STAKE = 100;
export const MAX_STAKE = 1000000;
export function validateSetup(maxPlayers, stake) {
  if (![2, 3, 4].includes(maxPlayers)) throw new Error('Choisis 2, 3 ou 4 joueurs.');
  if (!Number.isSafeInteger(stake) || stake < MIN_STAKE || stake > MAX_STAKE)
    throw new Error('Mise par joueur entre 100 et 1 000 000 F CFA.');
}
export function proposeStart(room, memberIds, count, hostId) {
  if (room.status !== 'waiting') throw new Error('Une proposition est deja en cours.');
  if (!Number.isInteger(count) || count < MIN_PLAYERS || count !== memberIds.length || count > room.max_players)
    throw new Error('Tous les joueurs presents doivent participer (2 a 4).');
  return { count, votes: { [hostId]: true }, createdAt: Date.now() };
}
export function voteStart(proposal, memberIds, userId, accept) {
  if (!proposal || !memberIds.includes(userId) || typeof accept !== 'boolean') throw new Error('Vote invalide.');
  if (!accept) return { status: 'waiting', proposal: null, unanimous: false };
  const votes = { ...proposal.votes, [userId]: true };
  return { status: 'proposed', proposal: { ...proposal, votes }, unanimous: memberIds.every((id) => votes[id] === true) };
}
