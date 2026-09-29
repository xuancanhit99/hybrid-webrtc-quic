import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildIceServers } from '../src/config.mjs';

const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('browser demo contains WebRTC, screen capture and DataChannel paths', async () => {
  const [html, js] = await Promise.all([read('public/index.html'), read('public/app.js')]);
  assert.match(html, /remote-video/);
  assert.match(js, /RTCPeerConnection/);
  assert.match(js, /getDisplayMedia/);
  assert.match(js, /createDataChannel/);
  assert.match(js, /signal-tickets/);
  assert.match(js, /encodeBrowserChunk/);
  assert.match(js, /input-capability-request/);
  assert.match(js, /host-screen-start/);
  assert.match(html, /Request host screen/);
  assert.match(html, /Enable remote input/);
  const receiver = await read('public/file-receiver.js');
  assert.match(receiver, /overlap or are out of order/);
  assert.match(receiver, /maxChunkBytes/);
});

test('coturn compose requires an external secret and exposes relay UDP range', async () => {
  const [compose, turn] = await Promise.all([read('docker-compose.yml'), read('coturn/turnserver.conf')]);
  assert.match(compose, /TURN_SECRET:\?Set TURN_SECRET/);
  assert.match(compose, /49160-49200:49160-49200\/udp/);
  assert.match(turn, /use-auth-secret/);
  assert.match(turn, /min-port=49160/);
  assert.doesNotMatch(compose, /password\s*:/i);
  assert.match(compose, /control:/);
  assert.match(compose, /SESSION_SECRET:\s*\$\{SESSION_SECRET:\?/);
  assert.match(compose, /CONTROL_BIND:-127\.0\.0\.1/);
  assert.match(compose, /TURN_BIND:-127\.0\.0\.1/);
  assert.match(compose, /TURN_LISTENING_IP:-0\.0\.0\.0/);
  assert.match(compose, /TURN_EXTERNAL_IP:-127\.0\.0\.1/);
  assert.match(compose, /turnutils_stunclient/);
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /FROM node:22-alpine/);
  assert.match(dockerfile, /HEALTHCHECK/);
  const smoke = await read('scripts/runtime-smoke.ps1');
  assert.match(smoke, /docker compose .*--wait/);
  assert.match(smoke, /healthz/);
  const smokeCompose = await read('docker-compose.smoke.yml');
  assert.match(smokeCompose, /!override/);
});

test('TURN credentials are short-lived and never expose the shared secret', () => {
  const servers = buildIceServers({ turnUrl: 'turn:relay.test:3478', turnUsername: '', turnSecret: 'super-secret', nodeEnv: 'test' }, 'usr_1');
  assert.equal(servers.length, 1);
  assert.match(servers[0].username, /^\d+:usr_1$/);
  assert.notEqual(servers[0].credential, 'super-secret');
});
