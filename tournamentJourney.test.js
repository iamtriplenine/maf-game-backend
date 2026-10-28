// Parcours integre EN MEMOIRE : aucune base PostgreSQL, aucun credit reel.
// Valide le contrat entre tirage, qualifications, finale, certification et budget.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tournamentSeats} from './tournamentDynamicBudget.js';
import {qualificationDraw} from './tournamentDraw.js';
import {createQualificationGame,playQualificationAction,qualificationWinnerId} from './tournamentQualificationGame.js';
import {createFinaleMatch} from './tournamentFinalScheduleRules.js';
import {finalAction} from './tournamentFinalGame.js';
import {certifiedFinalOrder} from './tournamentAwardRules.js';
import {payoutPlan} from './tournamentPayoutRules.js';
import {createGame} from './engine.js';

for(const count of [10,14,15,18,19,20]){
  test(`parcours sans SQL : ${count} reservations → salons → finale → comptabilite`,()=>{
    const people=Array.from({length:count},(_,i)=>({userId:i+1,name:`Joueur${i+1}`}));
    const layout=tournamentSeats(people.map(x=>x.userId));
    const groups=qualificationDraw(people,()=>0);
    assert.deepEqual(groups.map(g=>g.players.length),layout.groupSizes);
    const champions=[];
    for(const group of groups){
      let m=createQualificationGame(group.players,()=>0.3);
      let passes=0;
      while(m.game.phase!=='over' && passes++<5){
        const id=m.seats[m.game.current].userId;
        m=playQualificationAction(m,{userId:id,action:'abandon'});
      }
      assert.equal(m.game.phase,'over');
      const champ=qualificationWinnerId(m);
      const seat=m.seats.find(x=>x.userId===champ);
      assert.ok(seat);
      champions.push({userId:champ,name:seat.name,table:group.table});
    }
    assert.equal(new Set(champions.map(x=>x.userId)).size,groups.length);
    let finale=createFinaleMatch(champions,createGame);
    let turns=0;
    while(finale.game.phase!=='over' && turns++<4){
      finale=finalAction(finale,{userId:finale.seats[finale.game.current].userId,action:'abandon'});
    }
    assert.equal(finale.game.phase,'over');
    const certified=certifiedFinalOrder(finale);
    assert.equal(certified.length,groups.length);
    assert.equal(certified[0],finale.seats[finale.game.winner].userId);
    assert.throws(()=>payoutPlan(people.map(x=>x.userId),[...certified].reverse().slice(0,-1)),/Classement/);
    const payments=payoutPlan(people.map(x=>x.userId),certified);
    assert.equal(payments.lines.length,count);
    assert.equal(payments.totalRealFranc+payments.totalBonusFranc+payments.organizerFranc,count*500);
    assert.ok(payments.organizerFranc>=500);
  });
}
