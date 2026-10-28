// Identifiants permanents Studio 3D. Les six skins existants restent publics.
// Un nouveau skin doit être ajoute au catalogue ET son asset importe dans
// frontend/src/characters/skins.js avant d'etre propose comme prix exclusif.
export const STUDIO_SKINS = Object.freeze([
  { id:'loki', name:'Loki', access:'public' },
  { id:'bailarina', name:'Bailarina', access:'public' },
  { id:'samba', name:'Samba', access:'public' },
  { id:'messi', name:'Messi', access:'public' },
  { id:'kushina', name:'Kushina', access:'public' },
  { id:'mutant-swipe', name:'Mutant', access:'public' },
]);
const allowed = new Map(STUDIO_SKINS.map(s=>[s.id,s]));
export const studioSkin = id => allowed.get(id) || null;
export function selectedTournamentSkin(id) {
  if (id == null || id === '') return null;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,59}$/.test(id) || studioSkin(id)?.access !== 'exclusive') {
    throw new Error('Choisir un skin exclusif existant dans le Studio 3D.');
  }
  return id;
}
export function selectedSkinGrants(lines, participantId, winnerId) {
  const participant = selectedTournamentSkin(participantId);
  const winner = selectedTournamentSkin(winnerId);
  return buildSkinGrantRecipients(lines,participant,winner);
}
// Les resultats sont deja certifies dans le traitement financier cote serveur.
// Fonction pure pour verifier toutes les repartitions possibles.
export function buildSkinGrantRecipients(lines, participant, winner) {
  if (!Array.isArray(lines)) throw new Error('Resultats manquants.');
  const ids = new Set();
  const grants=[];
  let championCount=0;
  for (const line of lines) {
    const id=Number(line.userId ?? line.user_id);
    if(!Number.isSafeInteger(id)||id<1||ids.has(id))throw new Error('Joueur invalide ou duplique.');
    ids.add(id);
    if(participant)grants.push({userId:id,skinId:participant,kind:'participation'});
    if(line.place===1){championCount++;if(winner)grants.push({userId:id,skinId:winner,kind:'winner'});}
  }
  if(championCount!==1)throw new Error('Champion certifie manquant.');
  return grants;
}
