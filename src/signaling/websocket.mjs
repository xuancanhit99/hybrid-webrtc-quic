import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

export function websocketAccept(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

export class WebSocketPeer extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0), { maxPayloadBytes = 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.maxPayloadBytes = maxPayloadBytes;
    this.state = OPEN;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('error', (error) => this.finish(error));
    socket.on('end', () => this.finish());
    socket.on('close', () => this.finish());
    if (head.length) queueMicrotask(() => this.feed(head));
  }

  feed(chunk) {
    if (this.state === CLOSED) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.parseOne()) {}
    } catch (error) {
      this.close(1002, error.message || 'Protocol error');
      this.emit('error', error);
    }
  }

  parseOne() {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (!fin) throw new Error('Fragmented frames are not supported');
    if (!masked) throw new Error('Client frames must be masked');
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const largeLength = this.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Frame is too large');
      length = Number(largeLength);
      offset = 10;
    }
    if (length > this.maxPayloadBytes) throw new Error('Frame exceeds maximum payload');
    if (this.buffer.length < offset + 4 + length) return false;
    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    this.buffer = this.buffer.subarray(offset + length);
    this.handleFrame(opcode, payload);
    return this.buffer.length > 0;
  }

  handleFrame(opcode, payload) {
    if (opcode === 0x8) {
      if (this.state === OPEN) this.socket.write(frame(0x8, payload.subarray(0, 125)));
      this.state = CLOSING;
      this.socket.end();
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(frame(0xA, payload.subarray(0, 125)));
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x1) {
      this.emit('message', payload.toString('utf8'));
      return;
    }
    if (opcode === 0x2) {
      this.emit('binary', payload);
      return;
    }
    throw new Error(`Unsupported opcode ${opcode}`);
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  sendText(value) {
    if (this.state !== OPEN) return false;
    this.socket.write(frame(0x1, String(value)));
    return true;
  }

  sendBinary(value) {
    if (this.state !== OPEN) return false;
    this.socket.write(frame(0x2, Buffer.from(value)));
    return true;
  }

  close(code = 1000, reason = '') {
    if (this.state !== OPEN) return;
    const reasonBuffer = Buffer.from(String(reason).slice(0, 100));
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket.write(frame(0x8, payload));
    this.state = CLOSING;
    this.socket.end();
  }

  finish(error) {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    this.emit('closed', error);
  }
}

export function upgradeWebSocket(request, socket, head, options = {}) {
  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];
  if (!key || version !== '13' || !String(request.headers.upgrade || '').toLowerCase().includes('websocket')) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    '\r\n'
  ].join('\r\n'));
  return new WebSocketPeer(socket, head, options);
}
