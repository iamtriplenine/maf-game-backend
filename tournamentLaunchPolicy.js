// Interrupteur de securite des inscriptions payantes du GRAND tournoi.
// Les duels restent independants de cette protection.
export function publicTournamentBookingsEnabled(env=process.env) {
  return env.MAF_TOURNAMENT_REAL_START_ENABLED==='true' &&
    env.MAF_TOURNAMENT_FINAL_START_ENABLED==='true' &&
    env.MAF_TOURNAMENT_PAYOUTS_ENABLED==='true';
}
