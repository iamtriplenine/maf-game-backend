import test from 'node:test';
import assert from 'node:assert/strict';
import {tournamentReference,qualificationReference,finaleReference} from './tournamentMatchReferences.js';

test('references distinctes pour evenement, chaque plateau et finale',()=>{
  const event=tournamentReference(42);
  const a=qualificationReference(42,1,'150');
  const b=qualificationReference(42,2,'151');
  const final=finaleReference(42);
  assert.equal(event,'MAF-T000042');
  assert.equal(a,'MAF-T000042-Q1-M000150');
  assert.equal(b,'MAF-T000042-Q2-M000151');
  assert.equal(final,'MAF-T000042-F');
  assert.equal(new Set([event,a,b,final]).size,4);
  assert.notEqual(final,finaleReference(43));
});
test('reference deterministe et compatible avec les bigserial',()=>{
  assert.equal(qualificationReference('00042',4,'9007199254740993'),'MAF-T000042-Q4-M9007199254740993');
  assert.equal(qualificationReference(42,1,'150'),qualificationReference('42','1','0150'));
});
test('aucune reference valide sans identifiants positifs',()=>{
  for(const id of [0,-1,1.2,NaN,Infinity,'a','1; DROP TABLE',''])
    assert.throws(()=>tournamentReference(id));
  for(const table of [0,5,-1,1.2])
    assert.throws(()=>qualificationReference(42,table,10));
});
