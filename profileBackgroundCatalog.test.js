import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PROFILE_BACKGROUND, isAllowedProfileBackground, publicProfileBackground, canEquipProfileBackground } from './profileBackgroundCatalog.js';

test('Classic est le fond par defaut apres migration', () => {
  assert.equal(DEFAULT_PROFILE_BACKGROUND, 'classic');
  assert.equal(publicProfileBackground(null), 'classic');
});
test('le decor Classique peut etre selectionne', () => {
  assert.equal(isAllowedProfileBackground('classic'), true);
  assert.equal(publicProfileBackground('classic'), 'classic');
});
test('les identifiants arbitraires sont refuses', () => {
  for (const invalid of ['admin', '<script>', '', {}, null]) assert.equal(isAllowedProfileBackground(invalid), false);
});

test('Matrix necessite un droit, meme pour le proprietaire', () => {
  assert.equal(canEquipProfileBackground('matrix-rain', []), false);
  assert.equal(canEquipProfileBackground('matrix-rain', ['matrix-rain']), true);
  assert.equal(canEquipProfileBackground('classic', []), true);
  assert.equal(canEquipProfileBackground('inconnu', ['matrix-rain']), false);
});
