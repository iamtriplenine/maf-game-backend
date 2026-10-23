import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoomSlots, assertHostAvailable, MAX_HOST_ROOMS } from './multiRooms.js';

const hosted = (game) => ({host_id: 7, guest_id: null, game});

test('jusqu a cinq salons et un seul salon par jeu', () => {
  assert.equal(MAX_HOST_ROOMS, 5);
  assert.doesNotThrow(() => validateRoomSlots([], 7, 'penalty'));
  assert.doesNotThrow(() => validateRoomSlots([hosted('penalty'), hosted('checkers')], 7, 'tank'));
  assert.throws(() => validateRoomSlots([hosted('penalty')], 7, 'penalty'), /deja un salon/);
  const games = ['a','b','c','d','e'];
  assert.throws(() => validateRoomSlots(games.map(hosted), 7, 'f'), /limite de 5/);
});

test('un invite ne peut pas creer un autre salon', () => {
  assert.throws(() => validateRoomSlots([{host_id: 2, guest_id: 7, game:'tank'}], 7, 'checkers'), /adversaire/);
});

test('le verrou protege seulement les autres salons pending/ready/playing', async () => {
  const client = {
    query: async (sql, [host, excluded]) => {
      assert.match(sql, /status IN \('pending','ready','playing'\)/);
      assert.equal(host, 7); assert.equal(excluded, 9);
      return { rows: [] };
    }
  };
  await assert.doesNotReject(assertHostAvailable(client, 7, 9));
  client.query = async () => ({rows:[{id: 8}]});
  await assert.rejects(assertHostAvailable(client, 7, 9), (e) => e.status === 409);
});
