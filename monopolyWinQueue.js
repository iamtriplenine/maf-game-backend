// Le choix est lie a un tour precis ; les routes verrouillent d'abord le salon.
import {authorizedWinDice} from './winDice.js';
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function queueMatches(game,choice){
 return !!choice&&game?.phase==='roll'&&choice.turn===game.turn&&choice.player===game.current;
}
export function assertRollTarget(game,turn,playerId,members){
 if(game?.phase!=='roll'||turn!==game.turn||Number(playerId)!==Number(members[game.current]?.id))
  throw fail(409,'Le lancer est deja parti ou le tour a change. Aucun choix applique.');
}
export async function queuedWinDice(client,room,members,game){
 const choice=room.win_roll;
 if(!queueMatches(game,choice))return null;
 const source=members.find(p=>Number(p.id)===Number(choice.by));
 if(!source||game.players[members.indexOf(source)]?.bankrupt)return null;
 try{return await authorizedWinDice(client,source.id,'monopoly',room.id,choice.dice,game.dice,source.name);}
 catch(error){if(error.status===400||error.status===403)return null;throw error;}
}
export function visibleWinChoice(room,game,viewer){
 const choice=room.win_roll;
 return choice?.by===viewer&&queueMatches(game,choice)?{dice:choice.dice,turn:choice.turn,player:choice.player}:null;
}
