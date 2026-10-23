import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoomSlots, assertHostAvailable, assertCanRequestRoom, assertPlayersAvailable, MAX_HOST_ROOMS } from './multiRooms.js'; // MAF_ROOMS_FREE_UNTIL_ACCEPTED_V1

const hosted = (game) => ({host_id: 7, guest_id: null, game});

test('jusqu a cinq salons et un seul salon par jeu', () => {
  assert.equal(MAX_HOST_ROOMS, 5);
  assert.doesNotThrow(() => validateRoomSlots([], 7, 'penalty'));
  assert.doesNotThrow(() => validateRoomSlots([hosted('penalty'), hosted('checkers')], 7, 'tank'));
  assert.throws(() => validateRoomSlots([hosted('penalty')], 7, 'penalty'), /deja un salon/);
  const games = ['a','b','c','d','e'];
  assert.throws(() => validateRoomSlots(games.map(hosted), 7, 'f'), /limite de 5/);
});

test('une demande en attente ne bloque pas la creation de ses propres salons', () => {
  assert.doesNotThrow(() => validateRoomSlots([{host_id: 2, guest_id: 7, game:'tank'}], 7, 'checkers'));
});

test('le verrou protege seulement les autres salons ready/playing', async () => {
  const client = {
    query: async (sql, [host, excluded]) => {
      assert.match(sql, /status IN \('ready','playing'\)/);
      assert.equal(host, 7); assert.equal(excluded, 9);
      return { rows: [] };
    }
  };
  await assert.doesNotReject(assertHostAvailable(client, 7, 9));
  client.query = async () => ({rows:[{id: 8}]});
  await assert.rejects(assertHostAvailable(client, 7, 9), (e) => e.status === 409);
});


test('une demande envoyee reste possible malgre cinq salons heberges', async () => {
  const client = { query: async (sql, params) => {
    assert.match(sql, /guest_id=\$1/);
    assert.deepEqual(params, [7, 19]);
    return { rows: [] };
  }};
  await assert.doesNotReject(assertCanRequestRoom(client, 7, 19));
});

test('un joueur avec deja une demande sortante ne peut pas en envoyer une seconde', async () => {
  const client = { query:async () => ({rows:[{id:11}]}) };
  await assert.rejects(assertCanRequestRoom(client, 7, 19), /demande en attente/);
});

test('deux personnes ne peuvent pas accepter deux parties en meme temps', async () => {
  const client = { query:async (sql, params) => {
    assert.match(sql, /status IN \('ready','playing'\)/);
    assert.deepEqual(params, [[7,8],19]);
    return {rows:[{id:88}]};
  }};
  await assert.rejects(assertPlayersAvailable(client,7,8,19), /deja en partie/);
});

test('une demande seule ne bloque pas la validation du match', async () => {
  const client = { query:async (sql) => {
    assert.doesNotMatch(sql, /'pending'/);
    return {rows:[]};
  }};
  await assert.doesNotReject(assertPlayersAvailable(client,7,8,19));
});
