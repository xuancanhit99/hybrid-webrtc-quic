import crypto from 'node:crypto';

const MAGIC = Buffer.from('HYB1');
const HEADER_BYTES = 16;

export const FrameType = Object.freeze({
  control: 1,
  fileStart: 2,
  fileChunk: 3,
  fileAck: 4,
  fileComplete: 5,
  error: 255
});

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function encodeFrame(type, payload = Buffer.alloc(0), flags = 0) {
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new RangeError('type must be a byte');
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[4] = 1;
  header[5] = type;
  header.writeUInt16BE(flags & 0xffff, 6);
  header.writeUInt32BE(body.length, 8);
  header.writeUInt32BE(crc32(body), 12);
  return Buffer.concat([header, body]);
}

export function decodeFrames(input, { maxPayloadBytes = 16 * 1024 * 1024 } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsed = parseFrame(buffer, offset, maxPayloadBytes);
    if (!parsed) throw new Error(offset ? 'Incomplete frame payload' : 'Incomplete frame header');
    frames.push(parsed.frame);
    offset = parsed.nextOffset;
  }
  return frames;
}

export class FrameDecoder {
  constructor({ maxPayloadBytes = 16 * 1024 * 1024 } = {}) {
    this.maxPayloadBytes = maxPayloadBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(input) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(input)]);
    const frames = [];
    let offset = 0;
    while (offset < this.buffer.length) {
      const parsed = parseFrame(this.buffer, offset, this.maxPayloadBytes);
      if (!parsed) break;
      frames.push(parsed.frame);
      offset = parsed.nextOffset;
    }
    if (offset) this.buffer = this.buffer.subarray(offset);
    return frames;
  }

  end() {
    if (this.buffer.length) throw new Error('Incomplete frame at end of stream');
    return [];
  }
}

export function frameJson(type, value, flags = 0) {
  return encodeFrame(type, Buffer.from(JSON.stringify(value), 'utf8'), flags);
}

export function readJson(frame) {
  try { return JSON.parse(frame.payload.toString('utf8')); } catch { throw new Error('Invalid JSON frame payload'); }
}

// CRC32 detects accidental corruption before the cryptographic file hash is checked.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseFrame(buffer, offset, maxPayloadBytes) {
  if (buffer.length - offset < HEADER_BYTES) return null;
  if (!buffer.subarray(offset, offset + 4).equals(MAGIC)) throw new Error('Invalid frame magic');
  if (buffer[offset + 4] !== 1) throw new Error('Unsupported protocol version');
  const type = buffer[offset + 5];
  const flags = buffer.readUInt16BE(offset + 6);
  const length = buffer.readUInt32BE(offset + 8);
  const expectedCrc = buffer.readUInt32BE(offset + 12);
  if (length > maxPayloadBytes) throw new Error('Frame payload exceeds limit');
  if (buffer.length - offset - HEADER_BYTES < length) return null;
  const payload = buffer.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
  if (crc32(payload) !== expectedCrc) throw new Error('Frame checksum mismatch');
  return { frame: { type, flags, payload }, nextOffset: offset + HEADER_BYTES + length };
}
