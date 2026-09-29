import crypto from 'node:crypto';

const encoder = new TextEncoder();

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function stableJson(value) {
  return JSON.stringify(value);
}

function sign(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export class ControlStore {
  constructor({ secret, tokenTtlSeconds = 3600, clock = () => Date.now() } = {}) {
    if (!secret || String(secret).length < 32) throw new Error('A 32+ character signing secret is required');
    this.secret = String(secret);
    this.tokenTtlSeconds = tokenTtlSeconds;
    this.clock = clock;
    this.users = new Map();
    this.devices = new Map();
    this.sessions = new Map();
  }

  createUser({ email, name = '' }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new AuthError('A valid email is required', 400);
    const existing = [...this.users.values()].find((user) => user.email === normalizedEmail);
    if (existing) return existing;
    const user = { id: id('usr'), email: normalizedEmail, name: String(name || '').trim().slice(0, 120), createdAt: new Date(this.clock()).toISOString() };
    this.users.set(user.id, user);
    return user;
  }

  issueToken(userId) {
    const user = this.users.get(userId);
    if (!user) throw new AuthError('User not found', 404);
    const now = Math.floor(this.clock() / 1000);
    const header = base64url(stableJson({ alg: 'HS256', typ: 'HMT' }));
    const payload = base64url(stableJson({ sub: user.id, email: user.email, iat: now, exp: now + this.tokenTtlSeconds, jti: id('tok') }));
    return `${header}.${payload}.${sign(this.secret, `${header}.${payload}`)}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') throw new AuthError('Bearer token required');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('Malformed bearer token');
    const expected = sign(this.secret, `${parts[0]}.${parts[1]}`);
    const actual = parts[2];
    if (actual.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      throw new AuthError('Invalid bearer token');
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new AuthError('Invalid bearer token'); }
    if (!payload.sub || payload.exp <= Math.floor(this.clock() / 1000)) throw new AuthError('Bearer token expired');
    const user = this.users.get(payload.sub);
    if (!user) throw new AuthError('User no longer exists');
    return user;
  }

  enrollDevice(userId, { name, platform = 'unknown', publicKey = '' } = {}) {
    this.requireUser(userId);
    const device = {
      id: id('dev'),
      ownerId: userId,
      name: String(name || 'Unnamed device').trim().slice(0, 120),
      platform: String(platform || 'unknown').slice(0, 40),
      publicKey: String(publicKey || '').slice(0, 4096),
      createdAt: new Date(this.clock()).toISOString(),
      lastSeenAt: null,
      online: false
    };
    this.devices.set(device.id, device);
    return device;
  }

  listDevices(userId) {
    this.requireUser(userId);
    return [...this.devices.values()].filter((device) => device.ownerId === userId).map((device) => ({ ...device }));
  }

  getDevice(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  createSession(userId, { sourceDeviceId, targetDeviceId, mode = 'remote-desktop' } = {}) {
    this.requireUser(userId);
    const source = this.devices.get(sourceDeviceId);
    const target = this.devices.get(targetDeviceId);
    if (!source || !target) throw new AuthError('Both sourceDeviceId and targetDeviceId must exist', 404);
    if (source.id === target.id) throw new AuthError('A session needs two distinct devices', 400);
    if (source.ownerId !== userId || target.ownerId !== userId) throw new AuthError('User must own both devices or use an explicit share grant', 403);
    const session = {
      id: id('ses'),
      createdBy: userId,
      sourceDeviceId,
      targetDeviceId,
      mode: String(mode || 'remote-desktop').slice(0, 40),
      state: 'created',
      createdAt: new Date(this.clock()).toISOString(),
      updatedAt: new Date(this.clock()).toISOString(),
      participants: new Set()
    };
    this.sessions.set(session.id, session);
    return this.publicSession(session);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  joinSession(sessionId, deviceId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AuthError('Session not found', 404);
    if (![session.sourceDeviceId, session.targetDeviceId].includes(deviceId)) throw new AuthError('Device is not a session participant', 403);
    session.participants.add(deviceId);
    session.state = session.participants.size > 1 ? 'connected' : 'waiting';
    session.updatedAt = new Date(this.clock()).toISOString();
    return this.publicSession(session);
  }

  leaveSession(sessionId, deviceId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.participants.delete(deviceId);
    if (!session.participants.size) session.state = 'closed';
    else session.state = 'waiting';
    session.updatedAt = new Date(this.clock()).toISOString();
  }

  markDeviceOnline(deviceId, online) {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.online = Boolean(online);
    device.lastSeenAt = new Date(this.clock()).toISOString();
  }

  requireUser(userId) {
    const user = this.users.get(userId);
    if (!user) throw new AuthError('User not found', 404);
    return user;
  }

  publicSession(session) {
    return {
      id: session.id,
      createdBy: session.createdBy,
      sourceDeviceId: session.sourceDeviceId,
      targetDeviceId: session.targetDeviceId,
      mode: session.mode,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      participantCount: session.participants.size
    };
  }
}

export function parseBearer(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  return match?.[1] || '';
}
