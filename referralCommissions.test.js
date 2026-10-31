import test from 'node:test';
import assert from 'node:assert/strict';
import {referralCommissionAmount,commissionHistoryOffset,creditReferralDeposit} from './referralCommissions.js';
for(const [amount,bonus] of [[100,10],[101,10],[109,10],[110,11],[999,99],[1000,100],[1000000,100000]]){
 test(`Rechargement net ${amount} : commission ${bonus} V`,()=>assert.equal(referralCommissionAmount(amount),bonus));
}
test('Les montants hors limites et fractions sont refuses',()=>{
 for(const value of [99,1000001,-100,0,100.5,NaN,Infinity,'1000'])assert.throws(()=>referralCommissionAmount(value),{status:400});
});
test('Les pages de commissions sont bornees',()=>{
 assert.equal(commissionHistoryOffset(),0);assert.equal(commissionHistoryOffset('20'),20);
 for(const value of ['-1','01','1.5','1000001',20,null,['20']])assert.throws(()=>commissionHistoryOffset(value),{status:400});
});
test('Aucun credit sur une demande non confirmee, un retrait ou une devise bonus',async()=>{
 const c={query(){throw new Error('No SQL expected');}};
 for(const changes of [{kind:'withdrawal'},{currency:'V'},{status:'awaiting_payment'},{status:'approved'},{status:'rejected'}])assert.equal(await creditReferralDeposit(c,{kind:'deposit',currency:'F',status:'pending',...changes}),false);
});

test('Un solde partenaire absent ne peut pas produire une commission perdue',async()=>{
 const writes=[];
 const c={async query(sql){
  if(sql.startsWith('SELECT partner_id FROM maf_user_referrals'))return{rows:[{partner_id:9}]};
  if(sql.startsWith('SELECT partner_id,player_id'))return{rows:[]};
  if(sql.startsWith('SELECT id,account_role'))return{rows:[{id:9,account_role:'partner',bonus_balance:null}]};
  writes.push(sql);return{rows:[]};
 }};
 await assert.rejects(creditReferralDeposit(c,{id:'test',kind:'deposit',currency:'F',status:'pending',user_id:1000,amount:1000}),{status:409});
 assert.equal(writes.length,0);
});
