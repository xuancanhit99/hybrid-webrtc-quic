import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, buildIceServers } from './config.mjs';
import { AuthError, ControlStore, parseBearer } from './control/store.mjs';
import { upgradeWebSocket } from './signaling/websocket.mjs';
import { SignalingHub } from './signaling/hub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

function sendJson(response, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  response.end(payload);
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new AuthError('Request body is too large', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AuthError('Request body must be valid JSON', 400); }
}

function authenticate(request, store) {
  return store.verifyToken(parseBearer(request.headers.authorization));
}

async function staticResponse(request, response, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  relative = decodeURIComponent(relative);
  const resolved = path.resolve(PUBLIC, relative);
  if (!resolved.startsWith(`${PUBLIC}${path.sep}`) && resolved !== PUBLIC) return false;
  try {
    const data = await fs.readFile(resolved);
    response.writeHead(200, {
      'content-type': MIME.get(path.extname(resolved)) || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': pathname === '/' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; script-src 'self'"
    });
    response.end(data);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

export function createHybridServer(options = {}) {
  const config = options.config || loadConfig(options.env);
  const store = options.store || new ControlStore({ secret: config.sessionSecret, tokenTtlSeconds: config.tokenTtlSeconds });
  const hub = new SignalingHub(store);
  const startedAt = Date.now();
  const signalTickets = new Map();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', config.publicOrigin);
      if (request.method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, {
          status: 'ok',
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          users: store.users.size,
          devices: store.devices.size,
          sessions: store.sessions.size,
          signalingConnections: hub.connectionCount
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        response.writeHead(204, { 'cache-control': 'public, max-age=86400' });
        response.end();
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/auth/enroll') {
        if (config.enrollmentToken) {
          const provided = String(request.headers['x-enrollment-token'] || '');
          const expected = config.enrollmentToken;
          if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw new AuthError('Invalid enrollment token', 403);
        }
        const body = await readJson(request, config.maxBodyBytes);
        const user = store.createUser(body);
        sendJson(response, 201, { token: store.issueToken(user.id), user });
        return;
      }

      if (url.pathname.startsWith('/api/v1/')) {
        const user = authenticate(request, store);
        if (request.method === 'GET' && url.pathname === '/api/v1/me') {
          sendJson(response, 200, { user });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/v1/config') {
          sendJson(response, 200, { iceServers: buildIceServers(config, user.id), signalingPath: '/signal' });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/v1/devices') {
          sendJson(response, 200, { devices: store.listDevices(user.id) });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/v1/devices') {
          const device = store.enrollDevice(user.id, await readJson(request, config.maxBodyBytes));
          sendJson(response, 201, { device });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/v1/sessions') {
          const session = store.createSession(user.id, await readJson(request, config.maxBodyBytes));
          sendJson(response, 201, { session });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/v1/signal-tickets') {
          const body = await readJson(request, config.maxBodyBytes);
          const device = store.getDevice(body.deviceId);
          const session = store.getSession(body.sessionId);
          if (!device || device.ownerId !== user.id) throw new AuthError('Device not found or not owned by user', 403);
          if (!session || ![session.sourceDeviceId, session.targetDeviceId].includes(device.id)) throw new AuthError('Device is not part of this session', 403);
          const ticket = crypto.randomBytes(24).toString('base64url');
          signalTickets.set(ticket, { user, deviceId: device.id, sessionId: session.id, expiresAt: Date.now() + 30_000 });
          sendJson(response, 201, { ticket, expiresInSeconds: 30 });
          return;
        }
      }

      if (request.method === 'GET' && await staticResponse(request, response, url.pathname)) return;
      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 500;
      if (status === 500) console.error(error);
      sendJson(response, status, { error: status === 500 ? 'internal_error' : error.message });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', config.publicOrigin);
      if (url.pathname !== '/signal') throw new AuthError('WebSocket endpoint not found', 404);
      const ticketValue = url.searchParams.get('ticket') || '';
      const ticket = signalTickets.get(ticketValue);
      signalTickets.delete(ticketValue);
      if (!ticket || ticket.expiresAt < Date.now()) throw new AuthError('Signaling ticket is invalid or expired', 401);
      const peer = upgradeWebSocket(request, socket, head);
      if (peer) hub.attach(peer, ticket);
    } catch (error) {
      const status = error.status || 400;
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\nConnection: close\r\n\r\n`);
    }
  });

  async function listen(port = config.port, host = config.host) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    return server.address();
  }

  async function close() {
    hub.close();
    signalTickets.clear();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, store, hub, config, listen, close };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const application = createHybridServer();
  const address = await application.listen();
  console.log(`[hybrid] listening on http://${application.config.host}:${address.port}`);
  const shutdown = async () => {
    console.log('[hybrid] shutting down');
    await application.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
