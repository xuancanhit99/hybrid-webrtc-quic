import { AuthError } from '../control/store.mjs';

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice', 'renegotiate']);

export class SignalingHub {
  constructor(store) {
    this.store = store;
    this.rooms = new Map();
    this.connections = new Set();
  }

  get connectionCount() {
    return this.connections.size;
  }

  attach(peer, { user, sessionId, deviceId }) {
    const device = this.store.getDevice(deviceId);
    if (!device) throw new AuthError('Device not found', 404);
    if (device.ownerId !== user.id) throw new AuthError('The token does not own this device', 403);
    const session = this.store.getSession(sessionId);
    if (!session) throw new AuthError('Session not found', 404);
    if (![session.sourceDeviceId, session.targetDeviceId].includes(deviceId)) throw new AuthError('Device is not part of the session', 403);
    let room = this.rooms.get(sessionId);
    if (!room) {
      room = new Map();
      this.rooms.set(sessionId, room);
    }
    const previous = room.get(deviceId);
    if (previous) {
      room.delete(deviceId);
      this.connections.delete(previous);
      previous.peer.close(4001, 'Device connected from another socket');
    }
    const context = { peer, user, sessionId, deviceId };
    room.set(deviceId, context);
    this.connections.add(context);
    this.store.joinSession(sessionId, deviceId);
    this.store.markDeviceOnline(deviceId, true);

    peer.on('message', (raw) => this.onMessage(context, raw));
    peer.on('closed', () => this.detach(context));
    peer.on('error', () => {});
    peer.sendJson({
      type: 'welcome',
      sessionId,
      deviceId,
      role: session.sourceDeviceId === deviceId ? 'source' : 'target',
      peers: [...room.keys()].filter((candidate) => candidate !== deviceId)
    });
    this.broadcast(context, { type: 'peer-ready', deviceId });
    return context;
  }

  onMessage(context, raw) {
    let message;
    try { message = JSON.parse(raw); } catch {
      context.peer.sendJson({ type: 'error', code: 'invalid_json' });
      return;
    }
    if (!message || !SIGNAL_TYPES.has(message.type)) {
      context.peer.sendJson({ type: 'error', code: 'unsupported_message' });
      return;
    }
    const forwarded = { type: message.type, from: context.deviceId };
    if (message.type === 'offer' || message.type === 'answer') forwarded.sdp = message.sdp;
    if (message.type === 'ice') forwarded.candidate = message.candidate;
    this.broadcast(context, forwarded);
  }

  broadcast(context, message) {
    const room = this.rooms.get(context.sessionId);
    if (!room) return;
    for (const [deviceId, candidate] of room.entries()) {
      if (deviceId !== context.deviceId) candidate.peer.sendJson(message);
    }
  }

  detach(context) {
    if (!this.connections.delete(context)) return;
    const room = this.rooms.get(context.sessionId);
    const isCurrent = room?.get(context.deviceId) === context;
    if (!isCurrent) return;
    room.delete(context.deviceId);
    this.store.leaveSession(context.sessionId, context.deviceId);
    this.store.markDeviceOnline(context.deviceId, false);
    if (!room?.size) this.rooms.delete(context.sessionId);
    else this.broadcast(context, { type: 'peer-left', deviceId: context.deviceId });
  }

  close() {
    for (const context of [...this.connections]) context.peer.close(1001, 'Server shutting down');
    this.connections.clear();
    this.rooms.clear();
  }
}
