import { FILE_CHUNK_BYTES, decryptFile, decryptFileChunk, downloadFile, downloadFilePart } from './protocol.js?v=3.3.0';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'yaml', 'yml', 'py', 'sql', 'gcode', 'ini', 'toml', 'svg']);
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };

export function previewType(file) {
  const extension = file.name.toLowerCase().split('.').at(-1);
  if (['stl', '3mf'].includes(extension)) return { kind: 'model', extension };
  if (IMAGE_TYPES[extension]) return { kind: 'image', extension, mime: IMAGE_TYPES[extension] };
  if (extension === 'pdf') return { kind: 'pdf', extension, mime: 'application/pdf' };
  if (TEXT_EXTENSIONS.has(extension) || (file.type?.startsWith('text/') && extension !== 'blend')) return { kind: 'text', extension };
  return null;
}

/** Decrypt locally. Preview and download use the same authenticated transport. */
export async function readSharedFile(room, message, { signal, onProgress = () => {}, maxBytes = Infinity } = {}) {
  const { file } = message;
  const limit = Math.min(file.size, maxBytes);
  const parts = [];
  let loaded = 0;
  const fetcher = (url, options) => fetch(url, { ...options,
    ...(signal ? { signal: AbortSignal.any([options.signal, signal]) } : {}) });
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Vista previa cancelada', 'AbortError'); };
  checkAbort();
  if (file.format === 'chunks-v1') {
    const count = Math.max(1, Math.min(file.chunks, Math.ceil(limit / FILE_CHUNK_BYTES)));
    for (let index = 0; index < count; index++) {
      checkAbort();
      const encrypted = await downloadFilePart(room.topic, file.id, index, fetcher);
      checkAbort();
      const expected = Math.min(FILE_CHUNK_BYTES, file.size - index * FILE_CHUNK_BYTES);
      const bytes = await decryptFileChunk(room.key, file.id, index, encrypted, expected);
      checkAbort();
      const keep = Math.min(bytes.byteLength, Math.max(0, limit - loaded));
      parts.push(new Blob([bytes.subarray(0, keep)]));
      loaded += keep;
      onProgress(loaded, limit);
    }
  } else {
    const encrypted = await downloadFile(room.topic, file.id, fetcher);
    checkAbort();
    const bytes = await decryptFile(room.key, file.id, encrypted, file.size);
    checkAbort();
    parts.push(new Blob([bytes.subarray(0, limit)]));
    onProgress(limit, limit);
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
