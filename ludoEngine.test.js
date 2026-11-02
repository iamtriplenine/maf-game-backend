import test from 'node:test';
import assert from 'node:assert/strict';
import {initialLudo,rollLudo,moveLudo,forfeitLudo,validMoves} from './ludoEngine.js';
test('Tour initial + serveur impose le lancer',()=>{
 const s=initialLudo(10);assert.equal(s.toMove,'host');assert.deepEqual(validMoves(s),[]);
 const a=rollLudo(s,'host',()=>3,11);assert.equal(a.toMove,'guest');assert.equal(a.roll,null);
 assert.equal(s.toMove,'host');assert.throws(()=>rollLudo(s,'guest',()=>6));
});
test('six autorise sortie; coup illegitime refuse; six redonne le tour',()=>{
 let s=rollLudo(initialLudo(10),'host',()=>6,12);assert.deepEqual(s.valid,[0,1,2,3]);
 assert.throws(()=>moveLudo(s,'guest',0));assert.throws(()=>moveLudo(s,'host',4));
 s=moveLudo(s,'host',2,13);assert.equal(s.tokens.red[2],0);assert.equal(s.toMove,'host');
 assert.throws(()=>moveLudo(s,'host',0));
 s=rollLudo(s,'host',()=>4,14);s=moveLudo(s,'host',2,15);assert.equal(s.toMove,'guest');assert.equal(s.tokens.red[2],4);
});
test('capture, case sure et fin de plateau',()=>{
 const before=initialLudo();before.tokens.red=[26,56,56,56];before.tokens.yellow=[1,-1,-1,-1];
 let moved=moveLudo({...before,roll:1},'host',0);assert.equal(moved.tokens.yellow[0],-1);
 const near=initialLudo();near.tokens.red=[55,56,56,56];const win=moveLudo({...near,roll:1},'host',0);
 assert.equal(win.winner,'host');assert.equal(win.finished,true);
 assert.throws(()=>rollLudo(win,'host',()=>1));
});
test('expiration/forfait',()=>{const s=forfeitLudo(initialLudo(),'guest');assert.equal(s.winner,'host');assert.equal(s.forfeit,'guest')});

test('case depart protegee, depassement de 56 refuse et double lancer refuse',()=>{
 const s=initialLudo();s.tokens.red=[25,-1,-1,-1];s.tokens.yellow=[0,-1,-1,-1];
 const protect=moveLudo({...s,roll:1},'host',0);
 assert.equal(protect.tokens.yellow[0],0);
 const end=initialLudo();end.tokens.red=[55,-1,-1,-1];
 const checked={...end,roll:2};assert.deepEqual(validMoves(checked),[]);
 const six=rollLudo(initialLudo(),'host',()=>6);
 assert.throws(()=>rollLudo(six,'host',()=>1));
});
