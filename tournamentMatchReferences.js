// References de support stables derivees des identifiants persistants en base.
// Elles servent a retrouver une partie, PAS a autoriser son acces.
function positiveDatabaseId(value) {
  const raw=typeof value==='number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw!=='string' || !/^[0-9]{1,20}$/.test(raw) || !/[1-9]/.test(raw))
    throw new Error('Identifiant de partie invalide.');
  // BigInt garantit la stabilite des bigserial au-dela de Number.MAX_SAFE_INTEGER.
  return BigInt(raw).toString().padStart(6,'0');
}
export const tournamentReference = tournamentId => `MAF-T${positiveDatabaseId(tournamentId)}`;
export function qualificationReference(tournamentId,tableNo,matchId) {
  if (!Number.isInteger(Number(tableNo)) || Number(tableNo)<1 || Number(tableNo)>4)
    throw new Error('Numero de plateau invalide.');
  return `${tournamentReference(tournamentId)}-Q${Number(tableNo)}-M${positiveDatabaseId(matchId)}`;
}
export const finaleReference = tournamentId => `${tournamentReference(tournamentId)}-F`;
