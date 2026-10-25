import assert from 'node:assert/strict';
import { createGame, rollDice, endTurn } from './engine.js';
import { normalizeTurnClock,tickTurnClock,ROLL_MS,END_MS } from './monopolyTurnClock.js';
const t=1_000_000;
let g=normalizeTurnClock(createGame({names:['A','B']}),t);
assert.equal(g.turnClock.dueAt,t+50_000);
assert.equal(tickTurnClock(g,{now:t+49_999,rng:()=>0}).changed,false);
let r=tickTurnClock(g,{now:t+ROLL_MS,rng:()=>0});
assert.equal(r.auto,'roll');assert.equal(r.game.lastRoll.total,1);assert.equal(r.game.phase,'after');
assert.equal(r.game.turnClock.dueAt,t+ROLL_MS+END_MS);
// Plusieurs achats/constructions doivent conserver le meme delai.
const due=r.game.turnClock.dueAt;
normalizeTurnClock(r.game,t+ROLL_MS+10_000);assert.equal(r.game.turnClock.dueAt,due);
// Roll non disponible si la phase n'est plus roll.
assert.equal(tickTurnClock(r.game,{now:due+1000}).auto,undefined);
let ended=endTurn(r.game);normalizeTurnClock(ended,due);
assert.equal(ended.current,1);assert.equal(ended.turnClock.dueAt,due+ROLL_MS);
const expired=tickTurnClock(r.game,{now:due,autoEnd:true});
assert.equal(expired.auto,'end');assert.equal(expired.game.current,1);
assert.equal(expired.game.phase,'roll');assert.equal(expired.game.turnClock.dueAt,due+ROLL_MS);
console.log('OK - delais serveur 50s lancer et 60s fin, tour avance automatiquement.');
