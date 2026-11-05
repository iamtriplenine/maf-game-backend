// Fonds de profil utilisables par tous. La validation est toujours cote serveur.
export const DEFAULT_PROFILE_BACKGROUND = 'classic';
export const ALLOWED_PROFILE_BACKGROUNDS = Object.freeze(['matrix-rain', 'soap-bubbles', 'classic']);
export function isAllowedProfileBackground(id) {
  return typeof id === 'string' && ALLOWED_PROFILE_BACKGROUNDS.includes(id);
}
export function canEquipProfileBackground(id, unlocked = []) {
  return id === 'classic' || (isAllowedProfileBackground(id) && unlocked.includes(id));
}
export function publicProfileBackground(id) {
  return isAllowedProfileBackground(id) ? id : DEFAULT_PROFILE_BACKGROUND;
}
