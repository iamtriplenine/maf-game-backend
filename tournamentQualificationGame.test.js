import assert from 'node:assert/strict';
import { createQualificationGame, playQualificationAction, qualificationWinnerId } from './tournamentQualificationGame.js';
import { createGame, rollDice, endTurn } from './engine.js';

const members = Array.from({length:5},(_,i)=>({userId:i+101,name:`Joueur ${i+1}`}));
const rng = () => 0;
const match = createQualificationGame(members,rng);
assert.equal(match.game.players.length,5);
assert.equal(match.game.dice,2);
assert.equal(match.seats[4].seat,4);
assert.equal(match.game.players[4].piece,4);
assert.equal(qualificationWinnerId(match),null);
assert.throws(()=>createQualificationGame(members.slice(0,4),rng),/exactement cinq/);
assert.throws(()=>createQualificationGame([...members.slice(0,4),members[0]],rng),/distincts/);
assert.throws(()=>playQualificationAction(match,{userId:102,action:'roll'},rng),/pas le tour/);
assert.throws(()=>playQualificationAction(match,{userId:999,action:'roll'},rng),/ne participe pas/);
assert.throws(()=>playQualificationAction(match,{userId:101,action:'build',square:1},rng),/interdite/);
let state=match;
for(let seat=0;seat<5;seat++) {
  state=playQualificationAction(state,{userId:members[seat].userId,action:'roll'},rng);
  assert.equal(state.game.current,seat);
  state=playQualificationAction(state,{userId:members[seat].userId,action:'end'},rng);
  assert.equal(state.game.current,(seat+1)%5);
}
assert.equal(state.game.players.length,5);
assert.equal(state.game.turn,6);
let rollNumber=0;
let buyState=playQualificationAction(match,{userId:101,action:'roll'},()=>rollNumber++===0?0:0.2);
assert.equal(buyState.game.players[0].location,3);
buyState=playQualificationAction(buyState,{userId:101,action:'buy'},rng);
assert.equal(buyState.game.owners[3],0);
assert.equal(buyState.game.players[0].balance,1440);
let ending=match;
for(let seat=0;seat<4;seat++) {
  ending=playQualificationAction(ending,{userId:members[seat].userId,action:'abandon'},rng);
}
assert.equal(ending.game.phase,'over');
assert.equal(qualificationWinnerId(ending),105);
assert.throws(()=>playQualificationAction(ending,{userId:105,action:'roll'},rng),/terminee/);
// Regression : le moteur ordinaire a deux joueurs reste utilisable.
let standard=createGame({names:['A','B'],dice:2,rng});
standard=endTurn(rollDice(standard,{rng}));
assert.equal(standard.players.length,2);
assert.equal(standard.current,1);
console.log('OK : moteur tournoi 5 joueurs, tour de chaque siege, achat, victoire, protections, regression 2 joueurs.');
