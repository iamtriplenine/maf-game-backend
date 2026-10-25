// Chronometres persistants et autoritaires (horloge du serveur uniquement).
import { rollDice, endTurn, sell, sellOptions, giveUp } from './engine.js';
export const ROLL_MS = 50_000;
export const END_MS = 60_000;
const phaseMs = phase => phase === 'roll' ? ROLL_MS : END_MS;
export function normalizeTurnClock(game, now=Date.now()) {
  if(game.phase==='over'){game.turnClock=null;return game;}
  const old=game.turnClock;
  // Des achats et constructions ne prolongent jamais le delai.
  if(!old || old.player!==game.current || old.phase!==game.phase) {
    game.turnClock={player:game.current,phase:game.phase,startedAt:now,dueAt:now+phaseMs(game.phase)};
  }
  return game;
}
export function tickTurnClock(state, {now=Date.now(), rng=Math.random, autoEnd=false}={}) {
  let game=structuredClone(state),changed=!game.turnClock;
  normalizeTurnClock(game,now);
  if(game.phase==='over')return {game,changed};
  // Traiter un seul changement de phase par passage, pour laisser un vrai delai suivant.
  if(now<game.turnClock.dueAt)return {game,changed};
  if(game.phase==='roll'){
    game=rollDice(game,{rng});
    normalizeTurnClock(game,now);
    return {game,changed:true,auto:'roll'};
  }
  if(!autoEnd)return {game,changed};
  if(game.phase==='debt'){
    const current=game.current;
    for(const o of sellOptions(game,current).sort((a,b)=>a.value-b.value)){
      if(game.phase!=='debt' || game.current!==current)break;
      game=sell(game,o.square);
    }
    if(game.phase==='debt' && game.current===current) game=giveUp(game);
  }
  if(game.phase==='after')game=endTurn(game);
  normalizeTurnClock(game,now);
  return {game,changed:true,auto:'end'};
}
