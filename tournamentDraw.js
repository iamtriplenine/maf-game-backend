// Tirage des qualifications : les formats 10, 14, 15, 18, 19 et 20
// sont les seuls a pouvoir produire des plateaux. Pas de transaction ici.
import crypto from 'node:crypto';
import { tournamentSeats } from './tournamentDynamicBudget.js';

export const TABLE_COUNT = 4;
export const SEATS_PER_TABLE = 5;
export const REQUIRED_PLAYERS = TABLE_COUNT * SEATS_PER_TABLE; // capacite maximum

export function qualificationDraw(participants, randomInt = crypto.randomInt) {
  if (!Array.isArray(participants)) throw new Error('Liste des inscrits invalide.');
  const unique = new Set();
  for (const p of participants) {
    if (!p || !Number.isSafeInteger(p.userId) || p.userId <= 0 ||
        typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || unique.has(p.userId))
      throw new Error('Liste des inscrits invalide ou repetee.');
    unique.add(p.userId);
  }
  const seats = tournamentSeats(participants.map(p => p.userId));
  if (seats.status !== 'eligible' || seats.refundIds.length !== 0)
    throw new Error('Effectif incompatible : rembourser les derniers inscrits avant le tirage.');
  const shuffled = participants.map(p => ({userId:p.userId,name:p.name.trim()}));
  for (let i=shuffled.length-1; i>0; i--) {
    const j = randomInt(i + 1);
    if (!Number.isSafeInteger(j) || j<0 || j>i) throw new Error('Generateur de tirage invalide.');
    [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
  }
  let offset = 0;
  return seats.groupSizes.map((size,k) => {
    const group = {table:k+1,players:shuffled.slice(offset,offset+size).map((p,seat)=>({...p,seat}))};
    offset += size;
    return group;
  });
}
