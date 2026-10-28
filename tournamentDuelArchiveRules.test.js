import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {duelArchiveDecision} from './tournamentDuelArchiveRules.js';

test('brouillon, annule, termine et paye: archiver sans remboursement supplementaire',()=>{
 for (const status of ['draft','cancelled','finished','paid'])
  assert.deepEqual(duelArchiveDecision({status}),{allowed:true,refund:false});
});
test('publie ou en cours: annulation et remboursement avant masquage',()=>{
 for (const status of ['published','playing'])
  assert.deepEqual(duelArchiveDecision({status}),{allowed:true,refund:true});
});
test('aucun remboursement si gains ou gagnant deja enregistres',()=>{
 for (const situation of [{hasAwards:true},{paidAt:true},{winnerId:42}])
  assert.equal(duelArchiveDecision({status:'playing',...situation}).allowed,false);
});
test('statut inconnu interdit',()=>assert.equal(duelArchiveDecision({status:'other'}).allowed,false));
