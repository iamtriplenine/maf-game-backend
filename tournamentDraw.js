// Tirage de qualifications MAF Monopoly. Fonction pure testable : aucune transaction.
import crypto from 'node:crypto';

export const TABLE_COUNT = 4;
export const SEATS_PER_TABLE = 5;
export const REQUIRED_PLAYERS = TABLE_COUNT * SEATS_PER_TABLE;

export function qualificationDraw(participants, randomInt = crypto.randomInt) {
  if (!Array.isArray(participants) || participants.length !== REQUIRED_PLAYERS)
    throw new Error('Le tournoi doit comporter exactement vingt inscrits.');
  const unique = new Set();
  for (const p of participants) {
    if (!p || !Number.isSafeInteger(p.userId) || p.userId <= 0 ||
        typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || unique.has(p.userId))
      throw new Error('Liste des inscrits invalide ou repetee.');
    unique.add(p.userId);
  }
  const shuffled = participants.map(p => ({userId:p.userId,name:p.name.trim()}));
  // Fisher-Yates, crypto.randomInt: entier uniforme dans [0, i] inclus.
  for (let i=shuffled.length-1; i>0; i--) {
    const j = randomInt(i + 1);
    if (!Number.isSafeInteger(j) || j<0 || j>i) throw new Error('Generateur de tirage invalide.');
    [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
  }
  return Array.from({length:TABLE_COUNT},(_,k)=>({
    table: k+1,
    players: shuffled.slice(k*SEATS_PER_TABLE,(k+1)*SEATS_PER_TABLE).map((p,seat)=>({...p,seat}))
  }));
}
