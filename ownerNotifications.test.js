import test from 'node:test';
import assert from 'node:assert/strict';
import {validOwnerNoticeEvent} from './ownerNotificationsRules.js';
test('seuls les evenements de demande et de depot soumis sont valides', () => {
  assert.equal(validOwnerNoticeEvent('requested'),true);
  assert.equal(validOwnerNoticeEvent('submitted'),true);
  for (const value of ['dismissed','withdrawal',null,'',{},1])
    assert.equal(validOwnerNoticeEvent(value),false);
});
