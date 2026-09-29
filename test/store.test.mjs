import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore, AuthError } from '../src/control/store.mjs';

function makeStore() { return new ControlStore({ secret: 's'.repeat(48), tokenTtlSeconds: 60 }); }

test('issues and verifies an expiring signed token', () => {
  let now = 1_700_000_000_000;
  const store = new ControlStore({ secret: 'x'.repeat(48), tokenTtlSeconds: 10, clock: () => now });
  const user = store.createUser({ email: 'A@EXAMPLE.TEST', name: 'A' });
  const token = store.issueToken(user.id);
  assert.equal(store.verifyToken(token).email, 'a@example.test');
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.throws(() => store.verifyToken(tampered), AuthError);
  now += 11_000;
  assert.throws(() => store.verifyToken(token), AuthError);
});

test('enforces device ownership and session participants', () => {
  const store = makeStore();
  const alice = store.createUser({ email: 'alice@example.test' });
  const bob = store.createUser({ email: 'bob@example.test' });
  const source = store.enrollDevice(alice.id, { name: 'source', platform: 'test' });
  const target = store.enrollDevice(bob.id, { name: 'target', platform: 'test' });
  assert.throws(() => store.createSession(alice.id, { sourceDeviceId: source.id, targetDeviceId: target.id }), AuthError);
  assert.throws(() => store.createSession(bob.id, { sourceDeviceId: source.id, targetDeviceId: target.id }), AuthError);
  const targetOwnedByAlice = store.enrollDevice(alice.id, { name: 'target-owned', platform: 'test' });
  assert.throws(() => store.createSession(alice.id, { sourceDeviceId: source.id, targetDeviceId: source.id }), AuthError);
  const session = store.createSession(alice.id, { sourceDeviceId: source.id, targetDeviceId: targetOwnedByAlice.id });
  assert.equal(session.participantCount, 0);
  assert.equal(store.joinSession(session.id, source.id).state, 'waiting');
  assert.equal(store.joinSession(session.id, targetOwnedByAlice.id).state, 'connected');
  assert.throws(() => store.joinSession(session.id, 'dev_missing'), AuthError);
});
