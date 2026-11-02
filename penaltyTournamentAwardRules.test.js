import {test} from 'node:test';
import assert from 'node:assert/strict';
import {penaltyAwardBudget,certifyPenaltyBracket} from './penaltyTournamentAwardRules.js';
const paid=(ids,fee)=>ids.map(user_id=>({user_id,fee_paid:fee}));
const match=(round,id,host,guest,winner)=>({id,round_no:round,match_no:id,host_id:host,guest_id:guest,winner_id:winner,
  status:'finished',match_state:{finished:true,winner:winner===host?'host':'guest'}});
const example=()=>({entries:paid([1,2,3,4],500),draw:{eligible_count:4,initial_match_count:2},
  matches:[match(1,1,1,2,1),match(1,2,3,4,3),match(2,3,1,3,1)],byes:[],champion:{user_id:1}});
for(const size of [2,4,6,8,12,14,16,30,32])for(const fee of [200,500]){
 test(`cagnotte ${size} joueurs ${fee} F`,()=>{
  const ids=Array.from({length:size},(_,i)=>i+1);
  const b=penaltyAwardBudget(ids,fee,1,2,size===2?[]:[3,4]);
  assert.equal(b.potFranc,size*fee);
  assert.equal(b.organizerFranc+ b.lines.reduce((s,l)=>s+l.amountFranc,0),b.potFranc);
  assert.ok(b.lines.every(l=>l.amountFranc>=0&&Number.isSafeInteger(l.amountFranc)));
  assert.deepEqual(penaltyAwardBudget(ids,fee,1,2,size===2?[]:[3,4]),b);
 });
}
test('8 000 F : repartition 4000/2000/500/500/1000',()=>{
 const ids=Array.from({length:16},(_,i)=>i+1),p=penaltyAwardBudget(ids,500,1,2,[3,4]);
 assert.deepEqual(p.lines.map(x=>x.amountFranc),[4000,2000,500,500]);assert.equal(p.organizerFranc,1000);
});
test('4 inscrits : finale et demi-finales certifiees',()=>{
 const x=example(),p=certifyPenaltyBracket(x.entries,x.draw,x.matches,x.byes,x.champion);
 assert.equal(p.championId,1);assert.equal(p.runnerId,3);assert.deepEqual(p.lines.map(x=>x.userId),[1,3,2,4]);
});
test('2 inscrits : pas de faux demi-finalistes',()=>{
 const x=certifyPenaltyBracket(paid([1,2],200),{eligible_count:2,initial_match_count:1},[match(1,1,1,2,1)],[],{user_id:1});
 assert.equal(x.lines.length,2);assert.equal(x.potFranc,400);
});
test('rejet faux champion',()=>{
 const x=example();assert.throws(()=>certifyPenaltyBracket(x.entries,x.draw,x.matches,x.byes,{user_id:3}),/Champion/);
});
test('rejet match non certifie',()=>{
 const x=example();x.matches[1].match_state.winner='host';x.matches[1].winner_id=4;
 assert.throws(()=>certifyPenaltyBracket(x.entries,x.draw,x.matches,x.byes,x.champion),/Victoire|Champion/);
});
test('rejet inscrit en double',()=>{
 const x=example();x.entries[1].user_id=1;
 assert.throws(()=>certifyPenaltyBracket(x.entries,x.draw,x.matches,x.byes,x.champion),/Reservations/);
});
test('rejet tour saute ou exempt injustifie',()=>{
 const x=example();x.byes=[{round_no:2,user_id:2}];
 assert.throws(()=>certifyPenaltyBracket(x.entries,x.draw,x.matches,x.byes,x.champion),/appariements|exemptions/);
});
test('rejet score falsifie ou match non fini',()=>{
 const x=example();x.matches[0].status='attention';
 assert.throws(()=>certifyPenaltyBracket(x.entries,x.draw,x.matches,x.byes,x.champion),/Victoire/);
});
test('regles de budget invalides',()=>{
 assert.throws(()=>penaltyAwardBudget([1,2,2,4],500,1,2,[2,4]));
 assert.throws(()=>penaltyAwardBudget([1,2,3,4],200,1,2,[]));
 assert.throws(()=>penaltyAwardBudget([1,2],200,1,1,[]));
 assert.throws(()=>penaltyAwardBudget([1,2],100,1,2,[]));
});

for(const n of [6,8,10,12,14,16,18,22,26,30,32])test(`certification avec exemptions ${n} joueurs`,()=>{
  const ids=Array.from({length:n},(_,i)=>i+1),entries=paid(ids,200);
  let entrants=ids,round=1,matchId=1,matches=[],byes=[];
  while(entrants.length>1){
    const next=[];const arr=entrants.slice();
    if(arr.length%2){const bye=arr.pop();byes.push({round_no:round,user_id:bye});next.push(bye);}
    for(let i=0;i<arr.length;i+=2){
      const winner=arr[i];matches.push(match(round,matchId++,arr[i],arr[i+1],winner));next.push(winner);
    }
    entrants=next;round++;
  }
  const p=certifyPenaltyBracket(entries,{eligible_count:n,initial_match_count:n/2},matches,byes,{user_id:entrants[0]});
  assert.equal(p.championId,entrants[0]);
  assert.equal(p.potFranc,n*200);
  assert.equal(p.lines.reduce((s,l)=>s+l.amountFranc,0)+p.organizerFranc,n*200);
  assert.ok(p.lines.length===3||p.lines.length===4);
});
