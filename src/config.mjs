import crypto from 'node:crypto';

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProduction) {
      throw new Error('SESSION_SECRET is required when NODE_ENV=production');
    }
    sessionSecret = crypto.randomBytes(32).toString('base64url');
    console.warn('[hybrid] SESSION_SECRET is unset; using an ephemeral development key.');
  }
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  const host = env.HOST || '127.0.0.1';
  const enrollmentToken = env.ENROLLMENT_TOKEN || '';
  if ((isProduction || !['127.0.0.1', 'localhost', '::1'].includes(host)) && enrollmentToken.length < 16) {
    throw new Error('ENROLLMENT_TOKEN (16+ characters) is required outside loopback development');
  }
  return Object.freeze({
    host,
    port: positiveInt(env.PORT, 8787),
    publicOrigin: env.PUBLIC_ORIGIN || `http://${env.HOST || '127.0.0.1'}:${positiveInt(env.PORT, 8787)}`,
    sessionSecret,
    tokenTtlSeconds: positiveInt(env.TOKEN_TTL_SECONDS, 3600),
    enrollmentToken,
    maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, 1024 * 1024),
    turnUrl: env.TURN_URL || '',
    turnUsername: env.TURN_USERNAME || '',
    turnSecret: env.TURN_SECRET || '',
    nodeEnv: env.NODE_ENV || 'development'
  });
}

export function buildIceServers(config, identity = 'guest') {
  const servers = [];
  if (config.turnUrl && config.turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const prefix = config.turnUsername ? `${String(config.turnUsername).slice(0, 40)}:` : '';
    const username = `${expiry}:${prefix}${String(identity).slice(0, 80)}`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    servers.push({
      urls: config.turnUrl,
      username,
      credential
    });
  }
  return servers;
}
