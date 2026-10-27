import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualificationGame, qualificationWinnerId } from './tournamentQualificationGame.js';
import { demoFinalistLobby, finalistFromMatch, finalistOverview } from './tournamentFinalistRules.js';
const users=Array.from({length:5},(_,i)=>({userId:101+i,name:`Joueur ${i+1}`}));
const match=()=>({id:50,tournament_id:9,table_no:2,state:createQualificationGame(users,()=>0.5)});
test('pas de finalist avant la victoire',()=>{
  const m=match();assert.equal(qualificationWinnerId(m.state),null);
  assert.equal(finalistFromMatch(m),null);
});
test('vainqueur exact et associe au plateau une seule fois',()=>{
  const m=match();m.state.game.phase='over';m.state.game.winner=3;
  assert.deepEqual(finalistFromMatch(m),{tournamentId:9,table:2,matchId:50,userId:104,name:'Joueur 4'});
  const rows=[{table_no:2,user_id:104,match_id:50}];
  const lobby=finalistOverview([m],rows);
  assert.equal(lobby.qualifiedCount,1);assert.equal(lobby.ready,false);
  assert.equal(lobby.tables[1].winner.name,'Joueur 4');
  assert.deepEqual(lobby.tables.filter(x=>x.status==='not_started').map(x=>x.table),[1,3,4]);
});
test('match termine avant synchronisation reste en attente',()=>{
  const m=match();m.state.game.phase='over';m.state.game.winner=1;
  assert.equal(finalistOverview([m],[]).tables[1].status,'pending_sync');
});
test('aucun vainqueur si partie terminee sans vainqueur',()=>{
  const m=match();m.state.game.phase='over';m.state.game.winner=-1;
  const lobby=finalistOverview([m],[]);assert.equal(lobby.tables[1].status,'review');
});
test('refus des contradictions dans le salon final',()=>{
  const m=match();m.state.game.phase='over';m.state.game.winner=0;
  assert.throws(()=>finalistOverview([m],[{table_no:2,user_id:104,match_id:50}]),/incompatible/);
  assert.throws(()=>finalistOverview([m],[{table_no:2,user_id:101,match_id:50},{table_no:2,user_id:102,match_id:51}]),/duplique/);
});
test('simulation 0 a 4 finalistes, sans donnees reelles',()=>{
  for(let count=0;count<=4;count++){
    const demo=demoFinalistLobby(count);
    assert.equal(demo.qualifiedCount,count);
    assert.equal(demo.finalists.length,count);
    assert.equal(demo.ready,count===4);
    assert.equal(new Set(demo.finalists.map(f=>f.name)).size,count);
    assert.equal(demo.tables.length,4);
  }
  assert.throws(()=>demoFinalistLobby(5),/invalide/);
  assert.throws(()=>demoFinalistLobby('2'),/invalide/);
});
