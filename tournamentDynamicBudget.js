// MAF Monopoly - calculateur de tournoi variable, SANS versement.
// Montants entiers en centimes de franc CFA. Aucune ecriture en base.
// IMPORTANT: la mise en place de la repartition/remboursement et les paiements
// reels exigent une integration transactionnelle distincte, encore desactivee.

export const STAKE_CENTS = 50_000;
export const PARTICIPATION_BONUS_CENTS = 10_000;
export const MIN_ORGANIZER_CENTS = 50_000;
export const DEFAULT_FINAL_PRIZES_CENTS = Object.freeze([200_000, 160_000, 150_000, 140_000]);
export const DEFAULT_ELIMINATED_CENTS = 6_250;

const isId = x => Number.isSafeInteger(x) && x > 0;
const sum = numbers => numbers.reduce((a, b) => a + b, 0);

function uniquePositiveIds(ids, label) {
  if (!Array.isArray(ids)) throw new TypeError(`${label}: tableau attendu.`);
  if (ids.some(x => !isId(x)) || new Set(ids).size !== ids.length)
    throw new Error(`${label}: identifiants invalides ou repetes.`);
  return ids;
}

// Les inscriptions sont triees CHRONOLOGIQUEMENT par le serveur, et non par ID.
// En production, l'ordre doit etre fige dans la meme transaction que la cloture.
export function tournamentSeats(orderedReservations) {
  const all = uniquePositiveIds(orderedReservations, 'Reservations');
  if (all.length > 20) throw new Error('Capacite maximum: 20 reservations.');
  const registeredCount = all.length;
  if (registeredCount < 10) return {
    registeredCount, eligibleCount: 0, eligibleIds: [], refundIds: [...all],
    groupSizes: [], status: 'cancel_and_refund',
  };
  const groupsByCount = {
    10:[5,5],11:[5,5],12:[5,5],13:[5,5],
    14:[5,5,4],15:[5,5,5],16:[5,5,5],17:[5,5,5],
    18:[5,5,4,4],19:[5,5,5,4],20:[5,5,5,5],
  };
  const groupSizes = groupsByCount[registeredCount];
  const eligibleCount = sum(groupSizes);
  return {
    registeredCount, eligibleCount, eligibleIds:all.slice(0,eligibleCount),
    refundIds:all.slice(eligibleCount),groupSizes:[...groupSizes],status:'eligible',
  };
}

// Divise un montant entier en centimes sans perdre de centime.
// Le petit reste (+1 centime) est attribue dans l'ordre stable du tableau.
function equalSplits(totalCents, count) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !Number.isInteger(count) || count < 1)
    throw new Error('Division de budget invalide.');
  const base = Math.floor(totalCents / count);
  const rem = totalCents % count;
  return Array.from({length:count},(_,i)=>base+(i<rem?1:0));
}

function moneyLine(userId, place, realCents, bonusCents) {
  return {userId,place,outcome:place===null?'eliminated':'finalist',realCents,bonusCents};
}

// Prend l'ordre des FINALISTES certifie cote serveur : champion, deuxieme, etc.
// Ne jamais accepter ce classement depuis un navigateur pour de vrais paiements.
export function calculateTournamentBudget(orderedReservations, certifiedFinalOrder) {
  const seats=tournamentSeats(orderedReservations);
  const refundLines=seats.refundIds.map(userId=>({userId,amountCents:STAKE_CENTS,reason: 'late_incomplete_group'}));
  const grossStakesCents=seats.registeredCount*STAKE_CENTS;
  const refundedCents=refundLines.length*STAKE_CENTS;
  const potCents=grossStakesCents-refundedCents;

  if(seats.status==='cancel_and_refund') {
    if(certifiedFinalOrder !== undefined && certifiedFinalOrder.length) throw new Error('Aucun finaliste dans un tournoi annule.');
    return {...seats,refundLines,grossStakesCents,refundedCents,potCents,
      lines:[],totalRealCents:0,totalBonusCents:0,remainingCents:0,
      note:'Moins de dix inscrits: tous les paiements doivent etre rembourses transactionnellement.'};
  }

  const finalCount=seats.groupSizes.length;
  const finalOrder=uniquePositiveIds(certifiedFinalOrder,'Classement certifie');
  if(finalOrder.length!==finalCount || finalOrder.some(id=>!seats.eligibleIds.includes(id)))
    throw new Error(`Classement final invalide: ${finalCount} finalistes eligibles, tous distincts, requis.`);
  const finalSet=new Set(finalOrder);
  const eliminated=seats.eligibleIds.filter(id=>!finalSet.has(id));
  const finalistReal=DEFAULT_FINAL_PRIZES_CENTS.slice(0,finalCount);
  let eliminatedReal=eliminated.map(()=>DEFAULT_ELIMINATED_CENTS);
  const bonusByUser=new Map(seats.eligibleIds.map(id=>[id,PARTICIPATION_BONUS_CENTS]));
  let splitReduction={eliminatedCents:0,lowerFinalistsCents:0};
  const organizerTargetCents=seats.eligibleCount===18?60_000:MIN_ORGANIZER_CENTS;

  if (seats.eligibleCount === 10) {
    // Deux plateaux de cinq -> finale entre deux vainqueurs.
    // Reduction equilibree des deux prix de tete, petite compensation
    // aux huit elimines, bonus de 100 F conserve pour chaque joueur.
    // 1900 + 1500 + 8 * 12,50 + 10 * 100 + 500 = 5000 F exacts.
    finalistReal[0] = 190_000;
    finalistReal[1] = 150_000;
    eliminatedReal = eliminated.map(() => 1_250);
    splitReduction = { eliminatedCents: 40_000, lowerFinalistsCents: 0, topFinalistsCents: 20_000 };
  } else if(seats.eligibleCount===18) {
    // Decision deja chiffree avec le proprietaire, a conserver exactement.
    finalistReal[2]=135_000;
    finalistReal[3]=125_000;
    eliminatedReal=eliminated.map(()=>2_500);
    bonusByUser.set(finalOrder[2],15_000);
  } else {
    const baselineReal=sum(finalistReal)+sum(eliminatedReal);
    const baselineBonus=seats.eligibleCount*PARTICIPATION_BONUS_CENTS;
    const cutNeeded=baselineReal+baselineBonus+organizerTargetCents-potCents;
    if(cutNeeded>0){
      const loserCut=Math.floor(cutNeeded*70/100);
      const lowerCut=cutNeeded-loserCut;
      if (loserCut>sum(eliminatedReal) || finalCount<3 || lowerCut>sum(finalistReal.slice(2))) {
        return {...seats,status:'requires_policy',refundLines,grossStakesCents,refundedCents,potCents,
          lines:[],totalRealCents:0,totalBonusCents:0,remainingCents:null,
          requiredReductionCents:cutNeeded,
          note:'Impossible de garantir 500 F tout en conservant les gains du 1er, du 2e et 100 F de bonus par joueur. Aucune distribution autorisee.'};
      }
      const loserCuts=equalSplits(loserCut,eliminatedReal.length);
      eliminatedReal=eliminatedReal.map((v,i)=>v-loserCuts[i]);
      const finalistCuts=equalSplits(lowerCut,finalCount-2);
      for(let i=2;i<finalCount;i++) finalistReal[i]-=finalistCuts[i-2];
      splitReduction={eliminatedCents:loserCut,lowerFinalistsCents:lowerCut};
    }
  }

  const ranked=new Map(finalOrder.map((id,i)=>[id,i]));
  const losers=new Map(eliminated.map((id,i)=>[id,eliminatedReal[i]]));
  const lines=seats.eligibleIds.map(userId=>{
    const r=ranked.get(userId);
    return moneyLine(userId,r===undefined?null:r+1,
      r===undefined?losers.get(userId):finalistReal[r],bonusByUser.get(userId));
  });
  const totalRealCents=sum(lines.map(l=>l.realCents));
  const totalBonusCents=sum(lines.map(l=>l.bonusCents));
  const remainingCents=potCents-totalRealCents-totalBonusCents;
  if(lines.some(l=>!Number.isSafeInteger(l.realCents)||l.realCents<0||!Number.isSafeInteger(l.bonusCents)) ||
     remainingCents<MIN_ORGANIZER_CENTS || totalRealCents+totalBonusCents+remainingCents!==potCents)
    throw new Error('Budget invalide: calcul interrompu, aucun paiement autorise.');
  return {...seats,status:'planned',refundLines,grossStakesCents,refundedCents,potCents,
    finalCount,organizerTargetCents,remainingCents,totalRealCents,totalBonusCents,lines,splitReduction,
    paymentEnabled:false,refundsExecuted:false,
    note:'Simulation pure : aucun remboursement, bonus, gain ou skin n est credite.'};
}

export function describeBudgetScenario(registeredCount) {
  if(!Number.isInteger(registeredCount)||registeredCount<0||registeredCount>20)
    throw new Error('Effectif attendu entre 0 et 20.');
  const ids=Array.from({length:registeredCount},(_,i)=>i+1);
  const p=tournamentSeats(ids);
  return calculateTournamentBudget(ids,p.eligibleIds.slice(0,p.groupSizes.length));
}

export const francText = cents => cents===null?'indetermine':
  `${Math.floor(cents/100)},${String(cents%100).padStart(2,'0')}`;
