import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserFileReceiver, encodeBrowserChunk, sha256Hex } from '../public/file-receiver.js';

test('browser receiver verifies ordered chunks and returns a downloadable Blob', async () => {
  const data = new TextEncoder().encode('browser file transfer works');
  const hash = await sha256Hex(data);
  const receiver = new BrowserFileReceiver({ maxBytes: 1024, maxChunkBytes: 64 });
  assert.equal((await receiver.consume(JSON.stringify({ type: 'file-start', name: '../note.txt', size: data.byteLength, mime: 'text/plain', sha256: hash }))).status, 'started');
  await receiver.consume(encodeBrowserChunk(0, data.slice(0, 10)));
  await receiver.consume(encodeBrowserChunk(10, data.slice(10)));
  const result = await receiver.consume(JSON.stringify({ type: 'file-complete' }));
  assert.equal(result.name, '.._note.txt');
  assert.equal(result.size, data.byteLength);
  assert.equal(await result.blob.text(), 'browser file transfer works');
});

test('browser receiver rejects overlap, gaps and oversized chunks', async () => {
  const data = new Uint8Array(10);
  const hash = await sha256Hex(data);
  const receiver = new BrowserFileReceiver({ maxBytes: 20, maxChunkBytes: 8 });
  await receiver.consume(JSON.stringify({ type: 'file-start', name: 'x.bin', size: 10, sha256: hash }));
  await assert.rejects(() => receiver.consume(encodeBrowserChunk(1, data.slice(0, 4))), /overlap or are out of order/);
  await receiver.consume(JSON.stringify({ type: 'file-start', name: 'x.bin', size: 10, sha256: hash }));
  await assert.rejects(() => receiver.consume(encodeBrowserChunk(0, new Uint8Array(9))), /exceeds declared size/);
});
