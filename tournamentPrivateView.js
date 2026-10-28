// Vue privee : le navigateur ne recoit jamais les IDs des autres membres ni les cartes du deck.
export function privateMatchView(match,userId){
  if(!match || !Array.isArray(match.seats) || !match.game)throw new Error('Salon invalide.');
  if(!match.seats.some(s=>Number(s.userId)===Number(userId)))throw new Error('Joueur non autorise.');
  const ids=new Map(match.seats.map((s,i)=>[String(s.userId),Number(s.userId)===Number(userId)?Number(userId):-(i+1)]));
  const {decks:_decks,...game}=match.game;
  const presence=game.presence;
  const remap=raw=>Object.fromEntries(Object.entries(raw||{}).filter(([k])=>ids.has(k))
    .map(([k,value])=>[String(ids.get(k)),value]));
  return {format:match.format,game:{...game,...(presence?{presence:{seen:remap(presence.seen),away:remap(presence.away)}}:{})},
    seats:match.seats.map((s,i)=>({seat:i,name:s.name,clientId:ids.get(String(s.userId)),isYou:Number(s.userId)===Number(userId)}))};
}
