import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STUDIO_SKINS,studioSkin,selectedTournamentSkin,selectedSkinGrants,buildSkinGrantRecipients} from './studioSkinCatalog.js';
test('six skins existants ont des IDs distincts et sont toujours publics',()=>{
  assert.equal(STUDIO_SKINS.length,6);
  assert.equal(new Set(STUDIO_SKINS.map(s=>s.id)).size,6);
  assert.ok(STUDIO_SKINS.every(s=>s.access==='public'));
  assert.equal(studioSkin('loki').access,'public');
});
test('une recompense refuse un skin public ou un ID invente',()=>{
  assert.equal(selectedTournamentSkin(null),null);
  assert.throws(()=>selectedTournamentSkin('loki'),/exclusif/);
  assert.throws(()=>selectedTournamentSkin('../skin'),/exclusif/);
  assert.throws(()=>selectedTournamentSkin('inconnu'),/exclusif/);
});
test('le gagnant doit etre certifie avant de preparer des droits',()=>{
  assert.deepEqual(selectedSkinGrants([{userId:1,place:1},{userId:2,place:null}],null,null),[]);
  assert.throws(()=>selectedSkinGrants([{userId:1,place:null}],null,null),/Champion/);
  assert.throws(()=>selectedSkinGrants([{userId:1,place:1},{userId:1,place:null}],null,null),/duplique/);
});

test('tous les participants et le seul champion recoivent les bons skins',()=>{
  const lines=[{userId:10,place:null},{userId:11,place:1},{userId:12,place:2}];
  assert.deepEqual(buildSkinGrantRecipients(lines,'skin-event','skin-champion'),[
    {userId:10,skinId:'skin-event',kind:'participation'},
    {userId:11,skinId:'skin-event',kind:'participation'},
    {userId:11,skinId:'skin-champion',kind:'winner'},
    {userId:12,skinId:'skin-event',kind:'participation'}
  ]);
});
