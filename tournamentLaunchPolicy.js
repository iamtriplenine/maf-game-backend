// Ouverture publique pilotee par le code du backend.
// Les anciens drapeaux Render MAF_TOURNAMENT_*_ENABLED ne bloquent plus
// les inscriptions, qualifications, finales et recompenses.
// En cas d'incident, un arret d'urgence reste possible sur le serveur.
export const TOURNAMENT_PUBLIC_OPEN_IN_CODE = true;

export function realTournamentFeaturesEnabled(env = process.env) {
  return TOURNAMENT_PUBLIC_OPEN_IN_CODE && env.MAF_TOURNAMENT_EMERGENCY_PAUSE !== 'true';
}

export function publicTournamentBookingsEnabled(env = process.env) {
  return realTournamentFeaturesEnabled(env);
}
