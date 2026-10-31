import test from 'node:test';
import assert from 'node:assert/strict';
import { partnerAccountId, partnerSearch, partnerRoleChange } from './partnerRoleRules.js';
const key='12345678-1234-4234-8234-123456789abc';
test('Les identifiants internes sont des entiers positifs PostgreSQL',()=>{
 assert.equal(partnerAccountId('7'),7);assert.equal(partnerAccountId('2147483647'),2147483647);
 for(const value of ['0','-1','01','7.5','1e3','2147483648','x',7,null])assert.throws(()=>partnerAccountId(value),{status:400});
});
test('Une activation ou desactivation exige un role connu et une cle de demande',()=>{
 assert.deepEqual(partnerRoleChange({active:true,expected_role:'player',request_key:key}),{active:true,expectedRole:'player',requestKey:key,desiredRole:'partner'});
 assert.equal(partnerRoleChange({active:false,expected_role:'partner',request_key:key.toUpperCase()}).desiredRole,'player');
});
test('Aucun champ ne permet de demander les droits proprietaire',()=>{
 for(const body of [{active:true,expected_role:'owner',request_key:key},{active:true,expected_role:'player',request_key:key,role:'owner'},{active:true,expected_role:'player',request_key:key,permissions:['owner']},{active:'true',expected_role:'player',request_key:key},{active:true,expected_role:'player',request_key:'invalid'},null,[]])assert.throws(()=>partnerRoleChange(body),{status:400});
});
test('Recherche et pagination sont bornees sans interpretrer les caracteres SQL',()=>{
 assert.deepEqual(partnerSearch({q:'  User_Name% ',offset:'30'}),{q:'user_name%',offset:30,limit:30});
 assert.deepEqual(partnerSearch(),{q:'',offset:0,limit:30});
 for(const query of [{q:'x'.repeat(41)},{q:['a','b']},{offset:'-1'},{offset:'30.5'},{offset:'1000001'},{offset:30}])assert.throws(()=>partnerSearch(query),{status:400});
});
