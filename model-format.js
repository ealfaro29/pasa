// Keep parsing limits independent of the renderer so malformed files are refused
// before a loader allocates geometry, expands an archive, or uploads to the GPU.
export const MAX_MODEL_TRIANGLES = 2_000_000;
export const MAX_MODEL_ARCHIVE_ENTRIES = 2048;
export const MAX_MODEL_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_MODEL_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_STL_BYTES = 128 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('No se pudo leer el modelo.');
}

export function crc32(value) {
  const bytes = bytesOf(value);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function countMatches(text, pattern, maximum) {
  let count = 0;
  for (const _ of text.matchAll(pattern)) if (++count > maximum) return count;
  return count;
}

export function inspectSTL(value, { maxTriangles = MAX_MODEL_TRIANGLES } = {}) {
  const bytes = bytesOf(value);
  if (bytes.length < 84) throw new Error('El archivo STL está vacío o incompleto.');
  if (bytes.length > MAX_STL_BYTES) throw new Error('Este STL es demasiado grande para la vista previa. Puedes descargarlo.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  const expected = 84 + triangles * 50;
  if (expected === bytes.length) {
    if (!triangles) throw new Error('El STL no contiene triángulos.');
    if (triangles > maxTriangles) throw new Error('El modelo tiene demasiados triángulos para la vista previa. Puedes descargarlo.');
    return { triangles, binary: true };
  }
  // Match the Three.js STL loader's ASCII detection, including common BOMs.
  const prefix = new TextDecoder().decode(bytes.subarray(0, 9));
  if (!/^.{0,4}solid/s.test(prefix)) {
    if (triangles > maxTriangles) throw new Error('El modelo tiene demasiados triángulos para la vista previa. Puedes descargarlo.');
    throw new Error('El archivo STL está incompleto o su tamaño no es válido.');
  }
  let text;
  try { text = decoder.decode(bytes); } catch { throw new Error('El archivo STL no tiene un formato válido.'); }
  let count = 0;
  for (const _ of text.matchAll(/\bfacet\s+normal\b/gi)) {
    if (++count > maxTriangles) throw new Error('El modelo tiene demasiados triángulos para la vista previa. Puedes descargarlo.');
  }
  if (!count || countMatches(text, /\bendfacet\b/gi, count) !== count ||
      countMatches(text, /\bvertex\s+/gi, count * 3) !== count * 3 || !/\bendsolid\b/i.test(text)) {
    throw new Error('El archivo STL está vacío o incompleto.');
  }
  return { triangles: count, binary: false };
}

function invalidZIP() { throw new Error('El archivo 3MF está incompleto o no es válido.'); }

function decodedName(bytes) {
  let name;
  try { name = decoder.decode(bytes); } catch { invalidZIP(); }
  if (!name || /[\u0000-\u001f\u007f\\:]/.test(name) || name.startsWith('/') ||
      name.split('/').some(part => part === '..' || part === '.')) invalidZIP();
  return name;
}

function inspectExtras(view, start, size) {
  const end = start + size;
  while (start < end) {
    if (start + 4 > end) invalidZIP();
    const tag = view.getUint16(start, true);
    const length = view.getUint16(start + 2, true);
    if (tag === 1) throw new Error('Este 3MF usa ZIP64. Descárgalo para abrirlo en tu programa 3D.');
    start += 4 + length;
    if (start > end) invalidZIP();
  }
}

export function inspect3MF(value) {
  const bytes = bytesOf(value);
  if (bytes.length < 22) invalidZIP();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) invalidZIP();
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('Este 3MF usa ZIP64. Descárgalo para abrirlo en tu programa 3D.');
  }
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count) invalidZIP();
  if (!count || count > MAX_MODEL_ARCHIVE_ENTRIES) throw new Error('El 3MF contiene demasiadas partes para la vista previa.');
  if (centralOffset + centralSize !== end || centralOffset > bytes.length) invalidZIP();
  const entries = [];
  const names = new Set();
  let totalUncompressed = 0;
  let totalSelectedUncompressed = 0;
  let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) invalidZIP();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true);
    const extraSize = view.getUint16(offset + 30, true);
    const commentSize = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > end || view.getUint16(offset + 34, true)) invalidZIP();
    if (flags & 0x2041) throw new Error('El 3MF está protegido o cifrado y no se puede previsualizar.');
    if (![0, 8].includes(method)) throw new Error('La compresión de este 3MF no es compatible con la vista previa.');
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) invalidZIP();
    const name = decodedName(bytes.subarray(offset + 46, offset + 46 + nameSize));
    const canonicalName = name.normalize('NFC').toLowerCase();
    if (names.has(canonicalName)) invalidZIP();
    names.add(canonicalName);
    inspectExtras(view, offset + 46 + nameSize, extraSize);
    totalUncompressed += uncompressedSize;
    // Slicer projects may include enormous G-code or thumbnails. The viewer
    // never extracts these; only model XML and relationship parts use the budget.
    if (/\.(?:model|rels)$/i.test(name)) {
      totalSelectedUncompressed += uncompressedSize;
      if (uncompressedSize > MAX_MODEL_ENTRY_BYTES || totalSelectedUncompressed > MAX_MODEL_EXPANDED_BYTES) {
        throw new Error('El contenido del 3MF es demasiado grande para la vista previa. Puedes descargarlo.');
      }
    }
    if (method === 0 && compressedSize !== uncompressedSize) invalidZIP();
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) invalidZIP();
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameSize = view.getUint16(localOffset + 26, true);
    const localExtraSize = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameSize + localExtraSize;
    if (localFlags !== flags || localMethod !== method || dataOffset + compressedSize > centralOffset) invalidZIP();
    if (decodedName(bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize)) !== name) invalidZIP();
    inspectExtras(view, localOffset + 30 + localNameSize, localExtraSize);
    if (!(flags & 8) && (view.getUint32(localOffset + 14, true) !== crc ||
        view.getUint32(localOffset + 18, true) !== compressedSize || view.getUint32(localOffset + 22, true) !== uncompressedSize)) invalidZIP();
    entries.push({ name, method, compressedSize, uncompressedSize, dataOffset, localOffset, crc });
    offset = next;
  }
  if (offset !== end) invalidZIP();
  const ranges = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].localOffset < ranges[index - 1].dataOffset + ranges[index - 1].compressedSize) invalidZIP();
  }
  const modelEntries = entries.filter(entry => /^3D\/.+\.model$/i.test(entry.name));
  if (!modelEntries.length) throw new Error('El archivo 3MF no contiene un modelo 3D.');
  return { entries, totalUncompressed, totalSelectedUncompressed, modelEntries };
}
