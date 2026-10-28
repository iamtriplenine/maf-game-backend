import test from 'node:test';
import assert from 'node:assert/strict';
import {lobbyDeadline,lobbyOutcome,launchWithAbsences,postponedGiftAt} from './tournamentLiveRules.js';
import {createQualificationGame} from './tournamentQualificationGame.js';
const seats=Array.from({length:5},(_,i)=>({userId:i+1,name:`Joueur ${i+1}`}));
const start='2026-10-28T13:00:00.000Z';
test('cinq minutes exactes de salle d attente',()=>{
 assert.equal(lobbyDeadline(start),Date.parse(start)+300000);
 assert.equal(lobbyOutcome(seats,[1,2,3,4],start,Date.parse(start)+299999),'wait');
 assert.equal(lobbyOutcome(seats,[1,2,3,4],start,Date.parse(start)+300000),'forfeit');
 assert.equal(lobbyOutcome(seats,[1,2,3,4,5],start,Date.parse(start)),'play');
 assert.equal(lobbyOutcome(seats,[],start,Date.parse(start)+300000),'attention');
});
test('absent elimine a la limite, joueur present conserve',()=>{
 const match=createQualificationGame(seats,()=>0.5);
 const result=launchWithAbsences(match,[1,2,3,4],Date.parse(start)+300000);
 assert.equal(result.game.players[4].bankrupt,true);
 assert.equal(result.game.players[0].bankrupt,false);
 assert.ok(result.game.turnClock);
});
test('quatre absents : un gagnant sans blocage',()=>{
 const match=createQualificationGame(seats,()=>0.5);
 const result=launchWithAbsences(match,[3],Date.parse(start)+300000);
 assert.equal(result.game.phase,'over');
 assert.equal(result.game.winner,2);
});
test('cadeaux repousses par tranches de cinq minutes, pas apres la fin',()=>{
 assert.equal(postponedGiftAt(start,Date.parse(start)-1,true),start);
 assert.equal(postponedGiftAt(start,Date.parse(start),true),'2026-10-28T13:05:00.000Z');
 assert.equal(postponedGiftAt(start,Date.parse(start)+600000,true),'2026-10-28T13:15:00.000Z');
 assert.equal(postponedGiftAt(start,Date.parse(start)+600000,false),start);
});
