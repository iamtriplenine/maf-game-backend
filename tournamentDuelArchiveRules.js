// Decision pure : l'archivage ne detruit jamais les ecritures financieres.
export function duelArchiveDecision({status,hasAwards=false,paidAt=false,winnerId=null}) {
 if (status === 'published' || status === 'playing') {
  if (hasAwards || paidAt || winnerId != null) return {allowed:false,reason:'Des recompenses existent : le duel ne peut pas etre rembourse automatiquement.'};
  return {allowed:true,refund:true};
 }
 if (['draft','finished','paid','cancelled'].includes(status)) return {allowed:true,refund:false};
 return {allowed:false,reason:'Statut de duel non pris en charge.'};
}
