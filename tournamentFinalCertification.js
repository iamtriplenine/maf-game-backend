// Classement probant capture lors des transitions serveur du moteur Monopoly.
// Ne jamais accepter ce classement, ou une elimination, venant du navigateur.
export function captureFinalCertification(state, game) {
  const before = state.game;
  if(!Array.isArray(state.seats) || !Array.isArray(before?.players) || !Array.isArray(game?.players) ||
    state.seats.length!==game.players.length || before.players.length!==game.players.length ||
    !Array.isArray(state.eliminationOrder))
    throw new Error('Historique serveur de finale manquant : aucun paiement autorise.');
  const order = [...state.eliminationOrder];
  if(new Set(order).size !== order.length || order.some(id => !state.seats.some(s => s.userId === id)))
    throw new Error('Historique de faillites corrompu.');
  const newly = game.players.map((p,i) => ({i,p}))
    .filter(({i,p}) => p.bankrupt && !before.players[i].bankrupt);
  if(newly.length) {
    // L'ordre est garanti par les numeros de sequences des evenements du moteur,
    // y compris plusieurs forfaits successifs au cours d'un meme entretien serveur.
    const journal = game.log || [];
    const marked = newly.map(({i}) => ({i, n:Math.max(-1,...journal.filter(e => e.player===i && e.kind==='bankrupt').map(e=>e.n))}));
    if(marked.some(e => e.n<0) || new Set(marked.map(e=>e.n)).size!==marked.length)
      throw new Error('Ordre des eliminations non prouve.');
    marked.sort((a,b)=>a.n-b.n);
    for(const {i} of marked) {
      const id = state.seats[i].userId;
      if(order.includes(id))throw new Error('Elimination repetee.');
      order.push(id);
    }
  }
  const output = {...state,game,eliminationOrder:order};
  if(game.phase==='over') {
    const winner = state.seats[game.winner]?.userId;
    if(!winner || game.players.filter(p=>!p.bankrupt).length!==1 ||
      order.length!==state.seats.length-1 || order.includes(winner))
      throw new Error('Finale sans classement entier certifiable : paiement bloque.');
    output.certification = {kind:'server-elimination-order-v1',source:'authoritative-game-events',
      order:[winner,...order.slice().reverse()]};
  }
  return output;
}
