import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, FrameType, decodeFrames, encodeFrame, frameJson, readJson } from '../src/protocol/framing.mjs';
import { FileTransferReceiver, MemoryTransport, createFileManifest, encodeFile } from '../src/protocol/file-transfer.mjs';

test('frames round-trip with checksum and JSON payload', () => {
  const encoded = Buffer.concat([frameJson(FrameType.control, { action: 'hello' }), encodeFrame(FrameType.fileChunk, Buffer.from('abc'), 7)]);
  const frames = decodeFrames(encoded);
  assert.deepEqual(readJson(frames[0]), { action: 'hello' });
  assert.equal(frames[1].flags, 7);
  assert.equal(frames[1].payload.toString(), 'abc');
  const corrupted = Buffer.from(encoded); corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => decodeFrames(corrupted), /checksum/);
});

test('file protocol verifies manifest, order, size and final hash', () => {
  const data = Buffer.from('hybrid transfer '.repeat(4000));
  const manifest = createFileManifest({ name: 'sample.txt', data, mime: 'text/plain', chunkSize: 4096 });
  const receiver = new FileTransferReceiver();
  const result = receiver.consume(encodeFile(data, manifest));
  assert.equal(result.manifest.fileId, manifest.fileId);
  assert.deepEqual(result.data, data);
  const bad = encodeFile(data, manifest);
  bad[bad.length - 20] ^= 1;
  assert.throws(() => new FileTransferReceiver().consume(bad));
});

test('transport-neutral memory pair preserves framed bytes', async () => {
  const left = new MemoryTransport(); const right = new MemoryTransport(); left.connect(right); right.connect(left);
  const payload = encodeFrame(FrameType.control, Buffer.from('ok'));
  await left.send(payload);
  assert.deepEqual(right.drain()[0], payload);
});

test('incremental decoder handles QUIC stream segmentation', () => {
  const encoded = Buffer.concat([encodeFrame(FrameType.control, Buffer.from('one')), encodeFrame(FrameType.control, Buffer.from('two'))]);
  const decoder = new FrameDecoder();
  assert.equal(decoder.push(encoded.subarray(0, 5)).length, 0);
  assert.equal(decoder.push(encoded.subarray(5, 18)).length, 0);
  const frames = decoder.push(encoded.subarray(18));
  assert.deepEqual(frames.map((frame) => frame.payload.toString()), ['one', 'two']);
  assert.deepEqual(decoder.end(), []);
});
