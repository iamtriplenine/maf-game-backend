import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicTournamentBookingsEnabled, realTournamentFeaturesEnabled, TOURNAMENT_PUBLIC_OPEN_IN_CODE } from './tournamentLaunchPolicy.js';

test('ouverture active par le code, sans parametrage Render', () => {
  assert.equal(TOURNAMENT_PUBLIC_OPEN_IN_CODE, true);
  assert.equal(publicTournamentBookingsEnabled({}), true);
  assert.equal(realTournamentFeaturesEnabled({}), true);
});

test('anciens indicateurs Render sans effet bloquant', () => {
  for (const key of ['MAF_TOURNAMENT_REAL_START_ENABLED','MAF_TOURNAMENT_FINAL_START_ENABLED','MAF_TOURNAMENT_PAYOUTS_ENABLED']) {
    assert.equal(publicTournamentBookingsEnabled({[key]:'false'}), true);
    assert.equal(realTournamentFeaturesEnabled({[key]:'false'}), true);
  }
});

test('arret d urgence : bloque tous les modules', () => {
  const env={MAF_TOURNAMENT_EMERGENCY_PAUSE:'true'};
  assert.equal(publicTournamentBookingsEnabled(env),false);
  assert.equal(realTournamentFeaturesEnabled(env),false);
  assert.equal(realTournamentFeaturesEnabled({MAF_TOURNAMENT_EMERGENCY_PAUSE:'false'}),true);
});
