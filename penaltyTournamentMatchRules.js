// Regles pures des duels de tournoi, communes a chaque requete serveur.
import {blankMatch,roleFor,recordChoice} from './penaltyEngine.js';
const directions=new Set(['left','center','right']);
const sideOk=s=>s==='host'||s==='guest';
export function beginPenaltyDuel(shots){
  if(![3,5,10].includes(Number(shots)))throw new Error('Nombre de tirs invalide.');
  return blankMatch(Number(shots));
}
export function choosePenaltyDuel(state,viewer,direction){
  if(!sideOk(viewer)||!directions.has(direction))throw new Error('Choix non autorise.');
  if(!state||state.finished)throw new Error('Match termine.');
  const role=roleFor(state.turn,viewer);
  if(state.pending[role]!==null)throw new Error('Choix deja enregistre.');
  recordChoice(state,viewer,direction);
  return state;
}
export function abandonPenaltyDuel(state,viewer){
  if(!sideOk(viewer)||!state||state.finished)throw new Error('Abandon non autorise.');
  state.finished=true;state.winner=viewer==='host'?'guest':'host';state.forfeit=viewer;
  state.pending={shooter:null,keeper:null};
  return state;
}
export function visiblePenaltyDuel(state,viewer,now=Date.now()){
  if(!state)return null;
  if(!sideOk(viewer))throw new Error('Joueur invalide.');
  const role=roleFor(state.turn,viewer);
  return {
    turn:state.turn,totalPerPlayer:state.totalPerPlayer,regularPerPlayer:state.regularPerPlayer,
    overtime:state.overtime,scores:state.scores,history:state.history,winner:state.winner,
    finished:state.finished,forfeit:state.forfeit||null,viewer,role,
    shooter:state.turn%2===0?'host':'guest',myChoice:state.pending[role],
    otherReady:!!state.pending[role==='shooter'?'keeper':'shooter'],serverNow:now,
  };
}
