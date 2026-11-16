import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSTL, inspect3MF, crc32, MAX_MODEL_ENTRY_BYTES, MAX_MODEL_EXPANDED_BYTES } from '../model-format.js';

const encoder = new TextEncoder();
function binarySTL(triangles = 1) {
  const bytes = new Uint8Array(84 + triangles * 50);
  new DataView(bytes.buffer).setUint32(80, triangles, true);
  return bytes;
}

function zip(names = ['3D/3dmodel.model'], options = {}) {
  const entries = names.map(name => ({ name: encoder.encode(name), data: encoder.encode('<model/>') }));
  const size = entries.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length + 46 + entry.name.length, 22);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 6, options.flags || 0, true);
    view.setUint16(offset + 8, options.method || 0, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, options.uncompressedSize ?? entry.data.length, true);
    view.setUint16(offset + 26, entry.name.length, true);
    bytes.set(entry.name, offset + 30);
    bytes.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralOffset = offset;
  for (const entry of entries) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 8, options.flags || 0, true);
    view.setUint16(offset + 10, options.method || 0, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, options.uncompressedSize ?? entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    view.setUint32(offset + 42, entry.offset, true);
    bytes.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, offset - centralOffset, true);
  view.setUint32(offset + 16, centralOffset, true);
  return bytes;
}

test('STL preflight recognizes exact binary buffers including headers beginning with solid', () => {
  const bytes = binarySTL(2);
  bytes.set(encoder.encode('solid binary'));
  assert.deepEqual(inspectSTL(bytes), { triangles: 2, binary: true });
  const padded = new Uint8Array(bytes.length + 12);
  padded.set(bytes, 7);
  assert.deepEqual(inspectSTL(padded.subarray(7, 7 + bytes.length)), { triangles: 2, binary: true });
});

test('STL preflight accepts complete ASCII and refuses invalid, truncated and over-budget geometry', () => {
  const ascii = encoder.encode('solid cube\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid cube');
  assert.deepEqual(inspectSTL(ascii), { triangles: 1, binary: false });
  assert.throws(() => inspectSTL(new Uint8Array(20)), /incompleto/);
  assert.throws(() => inspectSTL(binarySTL().subarray(0, 100)), /incompleto/);
  assert.throws(() => inspectSTL(binarySTL(3), { maxTriangles: 2 }), /demasiados triángulos/);
  assert.throws(() => inspectSTL(encoder.encode(new TextDecoder().decode(ascii).replace('endfacet', ''))), /incompleto/);
  const forged = binarySTL();
  new DataView(forged.buffer).setUint32(80, 2_000_001, true);
  assert.throws(() => inspectSTL(forged), /demasiados triángulos/);
});

test('3MF preflight reports bounded entries and exact offsets without extracting anything', () => {
  const bytes = zip(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
  const result = inspect3MF(bytes);
  assert.equal(result.entries.length, 3);
  assert.equal(result.totalUncompressed, 24);
  assert.deepEqual(result.modelEntries.map(entry => entry.name), ['3D/3dmodel.model']);
  for (const entry of result.entries) assert.equal(new TextDecoder().decode(bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)), '<model/>');
});

test('3MF preflight rejects directory traversal, ambiguous names and external paths', () => {
  for (const name of ['../3D/part.model', '/3D/part.model', '3D/../part.model', '3D\\part.model', 'https://host/part.model']) {
    assert.throws(() => inspect3MF(zip([name])), /no es válido/);
  }
  assert.throws(() => inspect3MF(zip(['3D/model.model', '3d/MODEL.model'])), /no es válido/);
  assert.throws(() => inspect3MF(zip(['readme.txt'])), /no contiene un modelo/);
});

test('3MF preflight rejects oversized declared expansion, unsupported encryption and compression', () => {
  assert.throws(() => inspect3MF(zip(undefined, { method: 8, uncompressedSize: MAX_MODEL_ENTRY_BYTES + 1 })), /demasiado grande/);
  assert.throws(() => inspect3MF(zip(['3D/a.model', '3D/b.model', '3D/c.model'], { method: 8, uncompressedSize: Math.floor(MAX_MODEL_EXPANDED_BYTES / 3) + 1 })), /demasiado grande/);
  assert.throws(() => inspect3MF(zip(undefined, { flags: 1 })), /protegido o cifrado/);
  assert.throws(() => inspect3MF(zip(undefined, { method: 12 })), /compresión/);
});

test('3MF preflight does not expand or count unrelated G-code and image parts against the model budget', () => {
  const archive = zip(['3D/model.model', 'Metadata/plate_1.gcode'], { method: 8 });
  const view = new DataView(archive.buffer);
  const central = view.getUint32(archive.length - 22 + 16, true);
  const second = central + 46 + encoder.encode('3D/model.model').length;
  view.setUint32(second + 24, 512 * 1024 * 1024, true);
  const local = view.getUint32(second + 42, true);
  view.setUint32(local + 22, 512 * 1024 * 1024, true);
  const result = inspect3MF(archive);
  assert.equal(result.totalSelectedUncompressed, 8);
  assert.equal(result.totalUncompressed, 512 * 1024 * 1024 + 8);
});

test('CRC-32 checks use the ZIP polynomial and respect byte offsets', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
  const bytes = encoder.encode('--123456789--');
  assert.equal(crc32(bytes.subarray(2, 11)), 0xcbf43926);
});

test('3MF preflight rejects forged local offsets, local name disagreements and truncated archives', () => {
  const original = zip();
  assert.throws(() => inspect3MF(original.subarray(0, original.length - 1)), /no es válido/);
  const bytes = original.slice();
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  const central = view.getUint32(end + 16, true);
  view.setUint32(central + 42, central, true);
  assert.throws(() => inspect3MF(bytes), /no es válido/);
  const mismatch = original.slice();
  mismatch[30] = 88;
  assert.throws(() => inspect3MF(mismatch), /no es válido/);
  const huge = original.slice();
  new DataView(huge.buffer).setUint16(end + 10, 2049, true);
  new DataView(huge.buffer).setUint16(end + 8, 2049, true);
  assert.throws(() => inspect3MF(huge), /demasiadas partes/);
});
