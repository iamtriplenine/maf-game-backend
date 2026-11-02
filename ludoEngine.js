// MAF_LUDO_STAGE4 — Moteur serveur, aucune confiance dans le navigateur.
import crypto from 'node:crypto';
const COLORS = ['red', 'yellow'];
const START = { red: 0, yellow: 26 };
const SAFE_GLOBAL = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const bad = (message) => { throw new Error(message); };
export const LUDO_TURN_MS = 120000;
export function validMoves(state) {
  if (state.finished || state.roll == null) return [];
  const who = state.toMove;
  const color = state.colors[who];
  return state.tokens[color].flatMap((position, index) => {
    if (position === -1 && state.roll === 6) return [index];
    if (position >= 0 && position < 56 && position + state.roll <= 56) return [index];
    return [];
  });
}
export function initialLudo(now=Date.now()) {
  return { type:'ludo', colors: {host:'red',guest:'yellow'},
    tokens:{red:[-1,-1,-1,-1],yellow:[-1,-1,-1,-1]},
    toMove:'host',roll:null,valid:[],version:0,finished:false,winner:null,
    lastMoveAt:now,lastAction:'Partie commencée',forfeit:null };
}
export function rollLudo(before,side,random=() => crypto.randomInt(1,7),now=Date.now()) {
  if (before?.type !== 'ludo' || before.finished) bad('Partie terminée.');
  if (side !== before.toMove) bad('Ce n’est pas ton tour.');
  if (before.roll != null) bad('Sélectionne d’abord un pion.');
  const rolled = random();
  if (!Number.isInteger(rolled) || rolled < 1 || rolled > 6) bad('Dé invalide.');
  const next = structuredClone(before);
  next.roll=rolled;
  next.lastMoveAt=now;
  next.lastAction=`${side} a obtenu ${rolled}`;
  next.version++;
  next.valid=validMoves(next);
  if (next.valid.length===0) {
    next.roll=null;
    next.toMove=side==='host'?'guest':'host';
    next.lastAction+= ' · aucun déplacement possible';
  }
  return next;
}
export function moveLudo(before,side,index,now=Date.now()) {
  if (before?.type!=='ludo' || before.finished) bad('Partie terminée.');
  if (side !== before.toMove) bad('Ce n’est pas ton tour.');
  if (!Number.isInteger(index) || !validMoves(before).includes(index)) bad('Pion ou déplacement interdit.');
  const next=structuredClone(before);
  const color=next.colors[side];const opponent=side==='host'?'guest':'host';
  const rivalColor=next.colors[opponent];
  const oldPos=next.tokens[color][index];
  const position=oldPos===-1?0:oldPos+next.roll;
  next.tokens[color][index]=position;
  const global=(pos, col)=>(START[col]+pos)%52;
  // Les quatre cases départ et les autres cases sûres empêchent les captures.
  if(position>=0 && position<51 && !SAFE_GLOBAL.has(global(position,color))) {
    for(let i=0;i<4;i++) {
      const enemy=next.tokens[rivalColor][i];
      if(enemy>=0 && enemy<51 && global(enemy,rivalColor)===global(position,color)) {
        next.tokens[rivalColor][i]=-1;
      }
    }
  }
  const six=next.roll===6;
  next.roll=null;next.valid=[];next.version++;next.lastMoveAt=now;
  next.lastAction=`${side} a déplacé le pion ${index+1}`;
  if(next.tokens[color].every(x=>x===56)) {
    next.finished=true;next.winner=side;next.lastAction=`Victoire de ${side}`;
  } else if(!six) next.toMove=opponent;
  return next;
}
export function forfeitLudo(before,side,reason='abandon') {
  if(before?.type!=='ludo' || before.finished) bad('Partie terminée.');
  const next=structuredClone(before);
  next.finished=true;next.winner=side==='host'?'guest':'host';
  next.forfeit=side;next.forfeitReason=reason;next.version++;
  next.roll=null;next.valid=[];
  next.lastAction=reason==='move_timeout'?'Temps de jeu écoulé':'Abandon de la partie';
  return next;
}
