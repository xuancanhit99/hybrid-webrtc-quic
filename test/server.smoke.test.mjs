import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridServer } from '../src/server.mjs';

let app;
let origin;

before(async () => {
  app = createHybridServer({ config: {
    host: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1:0',
    sessionSecret: 't'.repeat(64), tokenTtlSeconds: 3600, maxBodyBytes: 1024 * 1024,
    enrollmentToken: '', turnUrl: '', turnUsername: '', turnSecret: '', nodeEnv: 'test'
  } });
  const address = await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => { await app.close(); });

async function json(path, options = {}) {
  const response = await fetch(`${origin}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  return { response, body: await response.json() };
}

function waitForMessage(socket, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('Timed out waiting for WebSocket message')); }, timeout);
    const onMessage = (event) => { const data = JSON.parse(event.data); if (!predicate(data)) return; clearTimeout(timer); socket.removeEventListener('message', onMessage); resolve(data); };
    socket.addEventListener('message', onMessage);
  });
}

function waitOpen(socket) { return new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); }

test('health, auth, device/session APIs and signaling relay work', async () => {
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src/);
  assert.match(await page.text(), /Hybrid Mesh Lab/);
  const browserScript = await fetch(`${origin}/app.js`);
  assert.equal(browserScript.status, 200);
  assert.match(browserScript.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${origin}/favicon.ico`)).status, 204);

  const enrolled = await json('/api/v1/auth/enroll', { method: 'POST', body: { email: 'smoke@example.test', name: 'Smoke' } });
  assert.equal(enrolled.response.status, 201);
  const auth = { authorization: `Bearer ${enrolled.body.token}` };
  const first = await json('/api/v1/devices', { method: 'POST', headers: auth, body: { name: 'A', platform: 'test' } });
  const second = await json('/api/v1/devices', { method: 'POST', headers: auth, body: { name: 'B', platform: 'test' } });
  assert.equal(first.response.status, 201); assert.equal(second.response.status, 201);
  const created = await json('/api/v1/sessions', { method: 'POST', headers: auth, body: { sourceDeviceId: first.body.device.id, targetDeviceId: second.body.device.id } });
  assert.equal(created.response.status, 201);
  const ticketA = await json('/api/v1/signal-tickets', { method: 'POST', headers: auth, body: { sessionId: created.body.session.id, deviceId: first.body.device.id } });
  const ticketB = await json('/api/v1/signal-tickets', { method: 'POST', headers: auth, body: { sessionId: created.body.session.id, deviceId: second.body.device.id } });
  const socketA = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}/signal?ticket=${ticketA.body.ticket}`);
  const socketB = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}/signal?ticket=${ticketB.body.ticket}`);
  const welcomeA = waitForMessage(socketA, (message) => message.type === 'welcome');
  const welcomeB = waitForMessage(socketB, (message) => message.type === 'welcome');
  await Promise.all([waitOpen(socketA), waitOpen(socketB), welcomeA, welcomeB]);
  const ready = waitForMessage(socketB, (message) => message.type === 'offer');
  socketA.send(JSON.stringify({ type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } }));
  const forwarded = await ready;
  assert.equal(forwarded.from, first.body.device.id);
  assert.equal(forwarded.sdp.type, 'offer');
  const replacementTicket = await json('/api/v1/signal-tickets', { method: 'POST', headers: auth, body: { sessionId: created.body.session.id, deviceId: first.body.device.id } });
  const replacement = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}/signal?ticket=${replacementTicket.body.ticket}`);
  const replacementWelcome = waitForMessage(replacement, (message) => message.type === 'welcome');
  await waitOpen(replacement); await replacementWelcome;
  assert.equal(app.hub.connectionCount, 2);
  socketA.close(); socketB.close();

  const reused = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}/signal?ticket=${ticketA.body.ticket}`);
  await new Promise((resolve) => { reused.addEventListener('close', resolve, { once: true }); reused.addEventListener('error', resolve, { once: true }); });
  assert.notEqual(reused.readyState, WebSocket.OPEN);
  replacement.close();
});
