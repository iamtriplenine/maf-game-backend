// Duel MAF - argent en francs entiers. Une mise de 500 par compte.
export const DUEL_STAKE = 500;
export const DUEL_PAYOUT = Object.freeze([900, 100]);
export function validateDuel({ startsAt, giftsAt, now=Date.now() }={}) {
  const strict = s => typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) && Number.isFinite(Date.parse(s));
  if(!strict(startsAt)||!strict(giftsAt)) throw Error('Dates UTC ISO invalides.');
  if(Date.parse(startsAt)<=now) throw Error('Depart dans le futur obligatoire.');
  if(Date.parse(giftsAt)<=Date.parse(startsAt)) throw Error('Remise des cadeaux apres le depart obligatoire.');
  return {startsAt,giftsAt};
}
export function participantsAreValid(rows) {
  return Array.isArray(rows)&&rows.length===2&&rows.every(x=>Number.isSafeInteger(Number(x.user_id))&&Number(x.user_id)>0)
    &&Number(rows[0].user_id)!==Number(rows[1].user_id);
}
export function duelRewards(rows,winnerId) {
  if(!participantsAreValid(rows)) throw Error('Deux joueurs distincts requis.');
  const ids=rows.map(r=>Number(r.user_id));
  if(!ids.includes(winnerId)) throw Error('Vainqueur etranger au duel.');
  const loserId=ids.find(x=>x!==winnerId);
  const rewards=[{userId:winnerId,place:1,amount:DUEL_PAYOUT[0]}, {userId:loserId,place:2,amount:DUEL_PAYOUT[1]}];
  if(rewards.reduce((n,r)=>n+r.amount,0)!==2*DUEL_STAKE)throw Error('Budget incoherent.');
  return rewards;
}
export function duelStartDecision({startsAt,count,now=Date.now()}) {
  if(now<Date.parse(startsAt))return 'waiting';
  return count===2?'start':'refund';
}
