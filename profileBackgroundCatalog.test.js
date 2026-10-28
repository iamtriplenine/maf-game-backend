import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PROFILE_BACKGROUND, isAllowedProfileBackground, publicProfileBackground } from './profileBackgroundCatalog.js';

test('Matrix est public par defaut', () => {
  assert.equal(DEFAULT_PROFILE_BACKGROUND, 'matrix-rain');
  assert.equal(publicProfileBackground(null), 'matrix-rain');
});
test('le decor Classique peut etre selectionne', () => {
  assert.equal(isAllowedProfileBackground('classic'), true);
  assert.equal(publicProfileBackground('classic'), 'classic');
});
test('les identifiants arbitraires sont refuses', () => {
  for (const invalid of ['admin', '<script>', '', {}, null]) assert.equal(isAllowedProfileBackground(invalid), false);
});
