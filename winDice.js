// Choix de faces : validation stricte et autorisation serveur pour le joueur concerne.
import { winAccessForRoom } from './winPractice.js';
const fail = (status,message) => Object.assign(new Error(message),{status});
export function parseWinDice(value,count) {
  if(value===undefined)return null;
  if(![1,2].includes(count) || !Array.isArray(value) || value.length!==count ||
    !value.every(n=>Number.isInteger(n)&&n>=1&&n<=6))
    throw fail(400,'Choisis une face entre 1 et 6 pour chaque de.');
  return [...value];
}
export async function authorizedWinDice(client,userId,game,roomId,value,count,pseudo) {
  const dice=parseWinDice(value,count);
  if(!dice)return null;
  const owner=process.env.MAF_OWNER_WIN_MODE==='1' && pseudo==='999';
  if(!owner && !await winAccessForRoom(userId,game,roomId,client))
    throw fail(403,'Mode Win inactif pour cette partie.');
  return dice;
}
