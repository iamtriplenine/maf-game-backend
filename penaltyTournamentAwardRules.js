// Regles financieres Tir-au-but : budget en F CFA entiers, immutable et conservatif.
// Part organisateur 12,5% (arrondie vers le bas). Solde partage entre
// champion (8 parts), finaliste (4 parts) et chacun des demi-finalistes (1 part).
// Lorsque la compétition compte moins de 4 joueurs, les parts non attribuables
// sont redistribuees proportionnellement aux autres vainqueurs.
const positive=x=>Number.isSafeInteger(x)&&x>0;
const unique=ids=>new Set(ids).size===ids.length;
export function penaltyAwardBudget(ids, fee, champion, runnerUp, semiLosers=[], allowNoSemi=false) {
  if(!Array.isArray(ids)||ids.length<2||ids.length>32||ids.length%2||
    ids.some(x=>!positive(x))||!unique(ids)||![200,500].includes(fee))
    throw new Error('Inscriptions ou mises invalides.');
  if(!positive(champion)||!positive(runnerUp)||champion===runnerUp||
    !ids.includes(champion)||!ids.includes(runnerUp) || !Array.isArray(semiLosers) ||
    semiLosers.length>2||semiLosers.some(x=>!positive(x)||!ids.includes(x))||
    !unique([champion,runnerUp,...semiLosers]))throw new Error('Classement incoherent.');
  if(ids.length>=4 && !(allowNoSemi&&semiLosers.length===0) && ![1,2].includes(semiLosers.length))throw new Error('Demi-finalistes attendus.');
  if(ids.length===2 && semiLosers.length!==0)throw new Error('Aucun demi-finaliste attendu.');
  const pot=ids.length*fee,organizerFranc=Math.floor(pot/8),prizes=pot-organizerFranc;
  const positions=[{userId:champion,place:1,weight:8,role:'champion'},
    {userId:runnerUp,place:2,weight:4,role:'finaliste'},
    ...semiLosers.map(x=>({userId:x,place:3,weight:1,role:'demi_finaliste'}))];
  const totalWeight=positions.reduce((a,x)=>a+x.weight,0);
  const assigned=positions.map((p,index)=>({...p,index,
    amountFranc:Math.floor(prizes*p.weight/totalWeight),
    remainder:(prizes*p.weight)%totalWeight}));
  let remainder=prizes-assigned.reduce((a,x)=>a+x.amountFranc,0);
  for(const line of [...assigned].sort((a,b)=>b.remainder-a.remainder||a.index-b.index)) {
    if(remainder>0){line.amountFranc++;remainder--;}
  }
  if(remainder!==0 || assigned.reduce((a,x)=>a+x.amountFranc,0)+organizerFranc!==pot)
    throw new Error('Budget non equilibre.');
  return {participants:ids.length,fee,potFranc:pot,organizerFranc,
    awardedFranc:prizes,lines:assigned.map(({userId,place,role,amountFranc})=>({userId,place,role,amountFranc}))};
}

// Certification du bracket a partir des lignes serveur (pas de classement fourni par le client).
export function certifyPenaltyBracket(entries,draw,matches,byes,championRow) {
  const ids=entries.map(x=>Number(x.user_id));
  const fee=Number(entries[0]?.fee_paid);
  if(!draw||ids.length!==Number(draw.eligible_count)||!ids.length||
    ids.some(x=>!positive(x))||!unique(ids)||entries.some(x=>Number(x.fee_paid)!==fee))
    throw new Error('Reservations non certifiees.');
  if(!Array.isArray(matches)||!Array.isArray(byes)||!championRow)
    throw new Error('Tableau incomplet.');
  const finalChampion=Number(championRow.user_id);
  let entrants=ids.slice(),round=1,roundMatches=[],lastMatch=null,prevSemi=[],hadDouble=false;
  const rounds=new Set(matches.map(x=>Number(x.round_no)));
  if(rounds.size<1||Math.min(...rounds)!==1||rounds.size>32)
    throw new Error('Tours invalides.');
  while(entrants.length>1){
    if(round>32)throw new Error('Trop de tours.');
    roundMatches=matches.filter(m=>Number(m.round_no)===round);
    const exempt=byes.filter(b=>Number(b.round_no)===round);
    if(exempt.length>(round===1?0:1)||roundMatches.length*2+exempt.length!==entrants.length)
      throw new Error('Appariements ou exemptions incoherents.');
    const arranged=roundMatches.flatMap(m=>[Number(m.host_id),Number(m.guest_id)]).concat(exempt.map(b=>Number(b.user_id)));
    if(!unique(arranged)||arranged.length!==entrants.length||arranged.some(x=>!entrants.includes(x)))
      throw new Error('Participants manquants ou en double.');
    const winners=[];
    for(const match of roundMatches){
      if(match.status==='finished'&&!match.winner_id&&match.match_state?.finished&&match.match_state.doubleForfeit===true){hadDouble=true;continue;} // deux disqualifies
      const winner=Number(match.winner_id),host=Number(match.host_id),guest=Number(match.guest_id);
      if(match.status!=='finished'||!match.match_state?.finished||
        !['host','guest'].includes(match.match_state.winner)||
        winner!==(match.match_state.winner==='host'?host:guest))
        throw new Error('Victoire non certifiee.');
      winners.push(winner);
    }
    if(roundMatches.length!==Number(draw.initial_match_count) && round===1)
      throw new Error('Nombre de matchs initial incoherent.');
    if(entrants.length<=4 && entrants.length>=3) {
      // Il n'existe pas de classement fictif : seuls les vrais perdants des demies comptent.
      prevSemi=roundMatches.filter(m=>m.winner_id).map(m=>Number(m.winner_id)===Number(m.host_id)?Number(m.guest_id):Number(m.host_id));
    }
    if(entrants.length===2){
      if(roundMatches.length!==1||exempt.length!==0)throw new Error('Finale invalide.');
      lastMatch=roundMatches[0];
    }
    entrants=winners.concat(exempt.map(x=>Number(x.user_id)));
    if(!unique(entrants))throw new Error('Qualifies en double.');
    round++;
  }
  if(entrants.length!==1||entrants[0]!==finalChampion || !lastMatch ||
    rounds.size!==round-1 || byes.some(b=>Number(b.round_no)>=round))
    throw new Error('Champion non conforme a la finale.');
  const runner=Number(lastMatch.host_id)===finalChampion?Number(lastMatch.guest_id):Number(lastMatch.host_id);
  // Pour 4+ joueurs, les deux demi-finalistes doivent preceder immediatement la finale.
  if(ids.length>=4 && !(hadDouble&&prevSemi.length===0) && ![1,2].includes(prevSemi.length))throw new Error('Classement des demi-finales absent.');
  const budget=penaltyAwardBudget(ids,fee,finalChampion,runner,prevSemi,hadDouble);
  return {...budget,championId:finalChampion,runnerId:runner,
    finalMatchId:String(lastMatch.id),rounds:round-1,eligibleIds:ids};
}
