import test from 'node:test';
import assert from 'node:assert/strict';
import { previewType, readSharedFile } from '../file-content.js';
import { createRoom, newSecret, encryptFile, encryptFileChunk, FILE_CHUNK_BYTES } from '../protocol.js';

test('offers 3D and common document previews without running active file types', () => {
  for (const name of ['modelo.STL', 'modelo.3MF']) assert.equal(previewType({ name }).kind, 'model');
  assert.equal(previewType({ name: 'foto.JPEG' }).mime, 'image/jpeg');
  assert.equal(previewType({ name: 'plano.pdf' }).kind, 'pdf');
  for (const name of ['nota.md', 'pagina.html', 'vector.svg']) assert.equal(previewType({ name }).kind, 'text');
  assert.equal(previewType({ name: 'escena.blend' }), null);
  assert.equal(previewType({ name: 'archivo.zip' }), null);
});

test('decrypts only the first chunk for bounded text previews and authenticates the whole chunk', async () => {
  const room = await createRoom(newSecret());
  const id = crypto.randomUUID();
  const bytes = new Uint8Array(FILE_CHUNK_BYTES).fill(65);
  const sealed = await encryptFileChunk(room.key, id, 0, bytes);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(sealed);
  };
  try {
    const file = { id, size: FILE_CHUNK_BYTES + 10, chunks: 2, format: 'chunks-v1' };
    const progress = [];
    const blob = await readSharedFile(room, { file }, { maxBytes: 100, onProgress: (...args) => progress.push(args) });
    assert.equal(blob.size, 100);
    assert.equal(await blob.text(), 'A'.repeat(100));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/parts/0'));
    assert.equal(calls[0].options.credentials, 'omit');
    assert.deepEqual(progress, [[100, 100]]);
    sealed[20] ^= 1;
    await assert.rejects(readSharedFile(room, { file }, { maxBytes: 100 }));
  } finally { globalThis.fetch = original; }
});

test('closing a preview aborts before making a request', async () => {
  const controller = new AbortController();
  controller.abort();
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('A closed preview must not download anything');
  try {
    await assert.rejects(readSharedFile({}, { file: { size: 0 } }, { signal: controller.signal }), { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});

test('full downloads preserve chunk boundaries, bytes, empty files and legacy attachments', async () => {
  const room = await createRoom(newSecret());
  const id = crypto.randomUUID();
  const first = new Uint8Array(FILE_CHUNK_BYTES).fill(123);
  const last = new Uint8Array([0, 1, 2, 254, 255]);
  const chunks = await Promise.all([encryptFileChunk(room.key, id, 0, first), encryptFileChunk(room.key, id, 1, last)]);
  const original = globalThis.fetch;
  globalThis.fetch = async url => new Response(chunks[Number(url.split('/').at(-1))]);
  try {
    const blob = await readSharedFile(room, { file: { id, size: first.length + last.length, chunks: 2, format: 'chunks-v1' } });
    assert.equal(blob.size, first.length + last.length);
    assert.deepEqual(new Uint8Array(await blob.slice(-5).arrayBuffer()), last);
    assert.deepEqual(new Uint8Array(await blob.slice(0, 2).arrayBuffer()), first.subarray(0, 2));
    const empty = await encryptFileChunk(room.key, id, 0, new Uint8Array());
    globalThis.fetch = async () => new Response(empty);
    assert.equal((await readSharedFile(room, { file: { id, size: 0, chunks: 1, format: 'chunks-v1' } })).size, 0);
    const legacy = await encryptFile(room.key, id, last);
    globalThis.fetch = async () => new Response(legacy);
    assert.deepEqual(new Uint8Array(await (await readSharedFile(room, { file: { id, size: last.length } })).arrayBuffer()), last);
  } finally { globalThis.fetch = original; }
});
