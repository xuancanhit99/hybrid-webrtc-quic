export class BrowserFileReceiver {
  constructor({ maxBytes = 8 * 1024 * 1024, maxChunkBytes = 256 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.maxChunkBytes = maxChunkBytes;
    this.active = null;
  }

  async consume(data) {
    if (typeof data === 'string') return this.consumeControl(data);
    if (!this.active) throw new Error('binary chunk without file manifest');
    const envelope = await toArrayBuffer(data);
    if (envelope.byteLength < 8) { this.abort(); throw new Error('binary chunk envelope is truncated'); }
    const view = new DataView(envelope);
    const offset = view.getBigUint64(0);
    const chunk = envelope.slice(8);
    if (offset !== BigInt(this.active.bytes)) { this.abort(); throw new Error('file chunks overlap or are out of order'); }
    if (!chunk.byteLength || chunk.byteLength > this.maxChunkBytes || this.active.bytes + chunk.byteLength > this.active.size || this.active.bytes + chunk.byteLength > this.maxBytes) {
      this.abort();
      throw new Error('file exceeds declared size');
    }
    this.active.chunks.push(chunk);
    this.active.bytes += chunk.byteLength;
    return { status: 'chunk', receivedBytes: this.active.bytes, expectedBytes: this.active.size };
  }

  async consumeControl(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return { status: 'message', text: raw }; }
    if (message.type === 'file-start') {
      if (this.active) throw new Error('another file transfer is already active');
      if (!Number.isSafeInteger(message.size) || message.size < 0 || message.size > this.maxBytes) throw new Error('invalid or oversized file');
      if (!/^[a-f0-9]{64}$/i.test(String(message.sha256 || ''))) throw new Error('valid SHA-256 is required');
      this.active = {
        name: sanitizeName(message.name),
        size: message.size,
        mime: String(message.mime || 'application/octet-stream').slice(0, 160),
        sha256: String(message.sha256).toLowerCase(),
        chunks: [],
        bytes: 0
      };
      return { status: 'started', name: this.active.name, size: this.active.size };
    }
    if (message.type === 'file-complete') {
      if (!this.active) throw new Error('file completion without an active transfer');
      const incoming = this.active;
      this.active = null;
      if (incoming.bytes !== incoming.size) throw new Error('incomplete file');
      const blob = new Blob(incoming.chunks, { type: incoming.mime });
      const digest = await sha256Hex(await blob.arrayBuffer());
      if (digest !== incoming.sha256) throw new Error('file SHA-256 mismatch');
      return { status: 'complete', name: incoming.name, size: incoming.size, blob };
    }
    return { status: 'message', value: message };
  }

  abort() {
    this.active = null;
  }
}

export function encodeBrowserChunk(offset, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const envelope = new Uint8Array(8 + bytes.byteLength);
  new DataView(envelope.buffer).setBigUint64(0, BigInt(offset));
  envelope.set(bytes, 8);
  return envelope;
}

export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data && typeof data.arrayBuffer === 'function') return data.arrayBuffer();
  throw new Error('unsupported binary chunk');
}

function sanitizeName(value) {
  const name = String(value || '').replace(/[\\/\0]/g, '_').trim().slice(0, 240);
  return name && name !== '.' && name !== '..' ? name : 'download.bin';
}
