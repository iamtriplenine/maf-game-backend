import assert from 'node:assert/strict';
import { validateSetup, proposeStart, voteStart } from './monopolyRoomRules.js';
import { createGame, rollDice, buy, build, buildOptions, endTurn } from './engine.js';
for(const n of [2,3,4])validateSetup(n,100);
for(const n of [1,5,9])assert.throws(()=>validateSetup(n,100));
assert.throws(()=>validateSetup(4,99));
const ids=[4,7,9],room={status:'waiting',max_players:4};
let p=proposeStart(room,ids,3,4);
assert.deepEqual(p.votes,{'4':true});
assert.equal(voteStart(p,ids,7,true).unanimous,false);
p=voteStart(p,ids,7,true).proposal;
assert.equal(voteStart(p,ids,9,true).unanimous,true);
assert.equal(voteStart(p,ids,9,false).status,'waiting');
assert.throws(()=>proposeStart(room,ids,2,4));
for(const count of [2,3,4]){
 let g=createGame({names:Array.from({length:count},(_,i)=>`Joueur ${i+1}`),dice:2});
 assert.equal(g.players.length,count);
 g=rollDice(g,{forced:[1,2]});assert.equal(g.lastRoll.total,3);
 assert.equal(g.players[0].location,3);
}
console.log('OK : validation 2-4 joueurs, votes unanimes et moteur 2-4 joueurs.');
