import { captureFinalCertification } from './tournamentFinalCertification.js';
// Une finale applique les memes actions et les memes regles que le Monopoly multijoueur.
import {rollDice,buy,build,sell,endTurn,giveUp} from './engine.js';
const allowed = new Set(['roll','buy','build','sell','end','abandon']);
export function finalMember(state, userId){
  if(!state || !Array.isArray(state.seats) || state.seats.length<2 || state.seats.length>4 ||
      state.format!==`monopoly_final_${state.seats.length}` || state.game?.players?.length!==state.seats.length)
    throw new Error('Etat de finale invalide.');
  return state.seats.findIndex(s=>Number(s.userId)===Number(userId));
}
export function finalAction(state,{userId,action,square}={},rng=Math.random){
  const seat=finalMember(state,userId);
  if(seat<0)throw new Error('Joueur absent de la finale.');
  if(!allowed.has(action))throw new Error('Action de finale interdite.');
  if(state.game.phase==='over' || seat!==state.game.current || state.game.players[seat].bankrupt)
    throw new Error('Ce nest pas ton tour ou la finale est terminee.');
  const game= action==='roll'?rollDice(state.game,{rng}):
    action==='buy'?buy(state.game):action==='build'?build(state.game,square):
    action==='sell'?sell(state.game,square):action==='end'?endTurn(state.game):giveUp(state.game);
  if(game===state.game)throw new Error('Action impossible dans cette phase.');
  return captureFinalCertification(state,game);
}
