// Regles pures des deux skins de tournoi MAF Monopoly.
// Un skin de participation par inscrit; un skin finaliste en plus pour les 4 premiers.
export const PARTICIPATION_SKIN = 'participation';
export const FINALIST_SKIN = 'finalist';
export const EXPECTED_SKIN_ENTITLEMENTS = 24; // reference au tournoi de 20 joueurs

export function buildTournamentSkinPlan(awardLines) {
  if (!Array.isArray(awardLines) || ![10,14,15,18,19,20].includes(awardLines.length)) {
    throw new Error('Effectif valide de 10, 14, 15, 18, 19 ou 20 participants requis.');
  }
  const seen = new Set();
  const places = new Set();
  const result = [];
  for (const line of awardLines) {
    const userId = Number(line?.userId ?? line?.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0 || seen.has(userId)) {
      throw new Error('Identifiants de joueurs invalides ou en double.');
    }
    seen.add(userId);
    const place = line?.place == null ? null : Number(line.place);
    if (place !== null && (!Number.isInteger(place) || place < 1 || place > 4 || places.has(place))) {
      throw new Error('Classement des finalistes incoherent.');
    }
    if ((place === null && line.outcome !== 'eliminated') ||
        (place !== null && line.outcome !== 'finalist')) {
      throw new Error('Etat des resultats incompatible avec le classement.');
    }
    if (place !== null) places.add(place);
    result.push({userId, kind: PARTICIPATION_SKIN, place});
    if (place !== null) result.push({userId, kind: FINALIST_SKIN, place});
  }
  const finalCount=awardLines.length===10?2:awardLines.length<=15?3:4;
  if (places.size !== finalCount || result.length !== awardLines.length+finalCount || seen.size !== awardLines.length) {
    throw new Error('Le plan doit comporter un finaliste par plateau et tous les participants.');
  }
  return result;
}

export function resultAnimationSteps(plan) {
  if (!Array.isArray(plan) || ![12,17,18,22,23,24].includes(plan.length)) {
    throw new Error('Plan des skins incomplet.');
  }
  const ids = new Set(plan.map(x => x.userId));
  return {
    participants: ids.size,
    participation: plan.filter(x => x.kind === PARTICIPATION_SKIN).length,
    finalists: plan.filter(x => x.kind === FINALIST_SKIN).length,
    total: plan.length,
  };
}
