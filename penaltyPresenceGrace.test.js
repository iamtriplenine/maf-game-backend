import test from 'node:test';
import assert from 'node:assert/strict';
import {penaltyAbsenceDecision} from './penaltyTournamentProgressRules.js';
const iso=ms=>new Date(ms).toISOString();
const base={status:'waiting',scheduled_at:iso(0),host_seen_at:null,guest_seen_at:null,host_joined_at:null,guest_joined_at:null};
test('arrive a 2 min, ecran verrouille, adversaire jamais venu : il gagne a 5 min',()=>{
  const m={...base,host_joined_at:iso(120000),host_seen_at:iso(120000)}; // plus vu depuis > 45 s
  assert.equal(penaltyAbsenceDecision(m,299000),null);
  assert.deepEqual(penaltyAbsenceDecision(m,300000),{winner:'host',reason:'absence_initiale'});
});
test('meme cas cote invite',()=>{
  const m={...base,guest_joined_at:iso(60000),guest_seen_at:iso(60000)};
  assert.equal(penaltyAbsenceDecision(m,300000).winner,'guest');
});
test('personne n est venu : 10 min puis les deux disqualifies',()=>{
  assert.equal(penaltyAbsenceDecision(base,300000),null);
  assert.deepEqual(penaltyAbsenceDecision(base,600000),{winner:null,reason:'deux_absents'});
});
test('venus chacun a leur tour sans se croiser : verification, pas de disqualification',()=>{
  const m={...base,host_joined_at:iso(60000),host_seen_at:iso(60000),guest_joined_at:iso(200000),guest_seen_at:iso(200000)};
  assert.equal(penaltyAbsenceDecision(m,300000),null);
  assert.deepEqual(penaltyAbsenceDecision(m,600000),{winner:null,reason:'jamais_ensemble'});
});
test('un seul connecte maintenant, les deux deja venus : le connecte gagne',()=>{
  const m={...base,host_joined_at:iso(60000),host_seen_at:iso(299000),guest_joined_at:iso(100000),guest_seen_at:iso(100000)};
  assert.equal(penaltyAbsenceDecision(m,300000).winner,'host');
});
