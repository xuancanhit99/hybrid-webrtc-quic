import crypto from 'node:crypto';
import { FrameType, encodeFrame, frameJson, readJson, sha256, decodeFrames } from './framing.mjs';

export const DEFAULT_CHUNK_BYTES = 64 * 1024;

export function createFileManifest({ name, size, mime = 'application/octet-stream', data, chunkSize = DEFAULT_CHUNK_BYTES } = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
  if (!name || typeof name !== 'string' || name.includes('..') || /[\\/]/.test(name)) throw new Error('File name must be a simple basename');
  if (bytes.length !== size && size !== undefined) throw new Error('Manifest size does not match data');
  return {
    fileId: crypto.randomUUID(),
    name,
    size: bytes.length,
    mime,
    chunkSize: Math.max(1024, Math.min(Number(chunkSize) || DEFAULT_CHUNK_BYTES, 4 * 1024 * 1024)),
    sha256: sha256(bytes)
  };
}

export function encodeFile(data, manifest) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length !== manifest.size || sha256(bytes) !== manifest.sha256) throw new Error('File does not match manifest');
  const frames = [frameJson(FrameType.fileStart, manifest)];
  let sequence = 0;
  for (let offset = 0; offset < bytes.length || (bytes.length === 0 && sequence === 0); offset += manifest.chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + manifest.chunkSize, bytes.length));
    frames.push(encodeFrame(FrameType.fileChunk, chunk, sequence));
    sequence += 1;
    if (bytes.length === 0) break;
  }
  frames.push(frameJson(FrameType.fileComplete, { fileId: manifest.fileId, chunks: sequence, sha256: manifest.sha256 }));
  return Buffer.concat(frames);
}

export class FileTransferReceiver {
  constructor({ maxBytes = 1024 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.reset();
  }

  reset() {
    this.manifest = null;
    this.chunks = [];
    this.bytes = 0;
    this.nextSequence = 0;
  }

  consume(input) {
    const frames = decodeFrames(input);
    for (const frame of frames) {
      if (frame.type === FrameType.fileStart) {
        this.manifest = readJson(frame);
        if (!this.manifest.fileId || !Number.isSafeInteger(this.manifest.size) || this.manifest.size > this.maxBytes) throw new Error('Invalid or oversized file manifest');
      } else if (frame.type === FrameType.fileChunk) {
        if (!this.manifest) throw new Error('File chunk arrived before manifest');
        if (frame.flags !== this.nextSequence) throw new Error(`Unexpected file chunk sequence ${frame.flags}`);
        this.bytes += frame.payload.length;
        if (this.bytes > this.manifest.size || this.bytes > this.maxBytes) throw new Error('File exceeds manifest size');
        this.chunks.push(Buffer.from(frame.payload));
        this.nextSequence += 1;
      } else if (frame.type === FrameType.fileComplete) {
        const done = readJson(frame);
        if (!this.manifest || done.fileId !== this.manifest.fileId || this.bytes !== this.manifest.size) throw new Error('Incomplete file transfer');
        const data = Buffer.concat(this.chunks);
        if (sha256(data) !== this.manifest.sha256 || done.sha256 !== this.manifest.sha256) throw new Error('Final file hash mismatch');
        return { manifest: { ...this.manifest }, data };
      }
    }
    return null;
  }
}

export class MemoryTransport {
  constructor() { this.peer = null; this.queue = []; }
  connect(peer) { this.peer = peer; }
  async send(bytes) {
    if (!this.peer) throw new Error('Transport is not connected');
    this.peer.queue.push(Buffer.from(bytes));
  }
  drain() { const output = this.queue; this.queue = []; return output; }
}

// A transport-neutral interface. A QUIC implementation can implement send()/close()
// and use the same framing/file-transfer code without changing the application layer.
export class QuicTransport {
  constructor() { this.kind = 'quic'; }
  async send() { throw new Error('QUIC transport adapter is not installed in this Node build'); }
  close() {}
}
