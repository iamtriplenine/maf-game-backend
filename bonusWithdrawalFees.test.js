import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBonusWithdrawalFees } from './bonusWithdrawalFees.js';
const pending=()=>({id:'test-withdrawal',user_id:7,kind:'withdrawal',currency:'V',status:'pending',amount:1000,fee_amount:10,owner_fee_amount:180});
const client=()=>({calls:[],async query(sql,args){this.calls.push({sql,args});return{rows:[]};}});

test('Une ancienne demande bonus recupere les 18 % reserves, une seule fois',async()=>{
 const c=client(),t=pending(),u={id:7,bonus_balance:3810};
 assert.equal(await normalizeBonusWithdrawalFees(c,t,u),true);
 assert.equal(u.bonus_balance,3990);assert.equal(t.owner_fee_amount,0);assert.equal(t.fee_amount,10);
 assert.equal(c.calls[0].args[1],180);
 assert.equal(JSON.parse(c.calls[2].args[2]).refund,180);
 const count=c.calls.length;
 assert.equal(await normalizeBonusWithdrawalFees(c,t,u),false);assert.equal(c.calls.length,count);
});

test('L argent, les depots et les retraits deja payes ou refuses ne changent pas',async()=>{
 for(const changes of [{currency:'F'},{kind:'deposit'},{status:'approved'},{status:'rejected'},{owner_fee_amount:0}]){
  const c=client(),t={...pending(),...changes},u={id:7,bonus_balance:10};
  assert.equal(await normalizeBonusWithdrawalFees(c,t,u),false);assert.equal(c.calls.length,0);assert.equal(u.bonus_balance,10);
 }
});

test('Le remboursement ne peut pas changer de beneficiaire',async()=>{
 const c=client();await assert.rejects(normalizeBonusWithdrawalFees(c,pending(),{id:8,bonus_balance:0}),{status:409});assert.equal(c.calls.length,0);
});

test('Un depassement de plafond ou des frais incoherents arretent la regularisation',async()=>{
 for(const [t,u] of [[pending(),{id:7,bonus_balance:2147483647}],[{...pending(),fee_amount:0,owner_fee_amount:1},{id:7,bonus_balance:0}]]){
  const c=client();await assert.rejects(normalizeBonusWithdrawalFees(c,t,u),{status:409});assert.equal(c.calls.length,0);
 }
});
