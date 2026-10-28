// MAF Monopoly : regles PUREs du duel programme (sans route publique ni ecriture de solde).
// IMPORTANT : les versements doivent venir d'une transaction serveur apres un resultat certifie.
// La mise de 500 F est comprise dans les 900/100 F. AUCUN bonus monetaire supplementaire.
export const DUEL_CAPACITY = 2;
export const DUEL_STAKE_CENTS = 50_000;
export const DUEL_PRIZES_CENTS = Object.freeze([90_000, 10_000]);
export const DUEL_PARTICIPATION_BONUS_CENTS = 0;
export const DUEL_ORGANIZER_REMAINDER_CENTS = 0;

const assertId = n => Number.isSafeInteger(n) && n > 0;
function validIso(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))
    throw new Error(`${label} : UTC ISO obligatoire.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,19)!==value.slice(0,19))
    throw new Error(`${label} invalide.`);
  return timestamp;
}

// L'organisateur programme l'annonce AVANT les reservations; aucun ID joueur requis ici.
export function validateDuelSchedule({startsAt,giftsAt,now=Date.now()}={}) {
  const starts=validIso(startsAt,'Depart'), gifts=validIso(giftsAt,'Cadeaux');
  if (!Number.isFinite(now) || starts<=now) throw new Error('La partie doit etre programmee dans le futur.');
  if (gifts<=starts) throw new Error('Les cadeaux doivent etre programmes apres le depart.');
  return Object.freeze({format:'monopoly_duel_2',capacity:2,feeCents:DUEL_STAKE_CENTS,
    startsAt,finalAt:startsAt,giftsAt,qualifications:0,gameCount:1,finalists:2});
}

// La finale est la SEULE partie. Pas de tirage par plateaux et pas de joueur fictif.
export function assertDuelParticipants(userIds) {
  if (!Array.isArray(userIds) || userIds.length!==2 || !userIds.every(assertId) ||
      new Set(userIds).size!==2)
    throw new Error('Deux comptes distincts ayant une reservation confirmee sont requis.');
  return [...userIds];
}

export function duelBudgetPreview({userIds,winnerId}={}) {
  const players=assertDuelParticipants(userIds);
  if (!assertId(winnerId)||!players.includes(winnerId)) throw new Error('Gagnant non admissible.');
  const secondId=players.find(id=>id!==winnerId);
  const stakesCents=DUEL_CAPACITY*DUEL_STAKE_CENTS;
  const lines=[
    {userId:winnerId,place:1,realCents:DUEL_PRIZES_CENTS[0],bonusCents:0,skinsPlanned:2},
    {userId:secondId,place:2,realCents:DUEL_PRIZES_CENTS[1],bonusCents:0,skinsPlanned:2},
  ];
  const payoutCents=lines.reduce((n,l)=>n+l.realCents+l.bonusCents,0);
  if (payoutCents!==stakesCents) throw new Error('Budget non equilibre.');
  return {format:'monopoly_duel_2',registered:2,stakesCents,payoutCents,remainingCents:0,
    bonusCents:0,lines,paymentsEnabled:false,skinsAttributed:false,
    note:'Calcul uniquement. Interdit de crediter un solde ou de declarer un skin attribue.'};
}

// Le controle ne doit pas ouvrir un duel incomplet ou payer deux fois.
export function duelReadiness({confirmedUserIds,now,startsAt,settled=false}={}) {
  const start=validIso(startsAt,'Depart');
  if (!Number.isFinite(now)) throw new Error('Horloge invalide.');
  if (settled) return {status:'settled',canStart:false};
  if (now<start) return {status:'scheduled',canStart:false};
  if (!Array.isArray(confirmedUserIds) || confirmedUserIds.length!==2) return {status:'cancel_and_refund',canStart:false};
  assertDuelParticipants(confirmedUserIds);
  return {status:'ready',canStart:true};
}
