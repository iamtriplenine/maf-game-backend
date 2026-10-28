// Fonds de profil utilisables par tous. La validation est toujours cote serveur.
export const DEFAULT_PROFILE_BACKGROUND = 'matrix-rain';
export const ALLOWED_PROFILE_BACKGROUNDS = Object.freeze(['matrix-rain', 'classic']);
export function isAllowedProfileBackground(id) {
  return typeof id === 'string' && ALLOWED_PROFILE_BACKGROUNDS.includes(id);
}
export function publicProfileBackground(id) {
  return isAllowedProfileBackground(id) ? id : DEFAULT_PROFILE_BACKGROUND;
}
