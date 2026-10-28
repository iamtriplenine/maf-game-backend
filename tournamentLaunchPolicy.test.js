import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicTournamentBookingsEnabled} from './tournamentLaunchPolicy.js';
for (const key of ['MAF_TOURNAMENT_REAL_START_ENABLED','MAF_TOURNAMENT_FINAL_START_ENABLED','MAF_TOURNAMENT_PAYOUTS_ENABLED']){
  test(`pas d'inscription payante si ${key} manque`,()=>{
    const env={MAF_TOURNAMENT_REAL_START_ENABLED:'true',MAF_TOURNAMENT_FINAL_START_ENABLED:'true',MAF_TOURNAMENT_PAYOUTS_ENABLED:'true'};
    delete env[key];assert.equal(publicTournamentBookingsEnabled(env),false);
    env[key]='false';assert.equal(publicTournamentBookingsEnabled(env),false);
  });
}
test('les trois indicateurs doivent etre exactement a true',()=>{
  assert.equal(publicTournamentBookingsEnabled({}),false);
  assert.equal(publicTournamentBookingsEnabled({MAF_TOURNAMENT_REAL_START_ENABLED:'true',MAF_TOURNAMENT_FINAL_START_ENABLED:'true',MAF_TOURNAMENT_PAYOUTS_ENABLED:'true'}),true);
});
