// Message transport sends ciphertext. The key stays in the URL fragment.
import { API_ORIGIN } from './config.js?v=3.1.0';
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_FILE_BYTES = 250 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 8 * 1024 * 1024;
const LEGACY_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_PARTS = 32;
const MAX_FILE_ENVELOPE_BYTES = 16 * 1024;
const FILE_OVERHEAD_BYTES = 28;
const FILE_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MESSAGE_ID_PATTERN = /^[a-zA-Z0-9-]{16,64}$/;
// JSON can expand control characters to six bytes each before compression.
const MAX_JSON_BYTES = MAX_TEXT_BYTES * 6 + 2048;
export const MAX_ENVELOPE_BYTES = Math.ceil((MAX_JSON_BYTES + 16) * 4 / 3) + 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function toBase64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(result).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Formato inválido');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

export function newSecret() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export function isRoomSecret(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value || '')) return false;
  try {
    const bytes = fromBase64(value);
    return bytes.length === 32 && toBase64(bytes) === value;
  } catch { return false; }
}

export async function createRoom(secret) {
  if (!isRoomSecret(secret)) throw new Error('El enlace de conexión no es válido');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`pasa/topic/v1/${secret}`));
  const topic = 'pasa_' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 56);
  const key = await crypto.subtle.importKey('raw', fromBase64(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic, key };
}

async function transform(bytes, stream, maxBytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error('El texto supera el límite de tamaño');
    }
    parts.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function validArchiveURL(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href === value;
  } catch { return false; }
}

export function validateMessage(message) {
  if (!message || message.v !== 1 || typeof message.id !== 'string' || !MESSAGE_ID_PATTERN.test(message.id) ||
      typeof message.device !== 'string' || !MESSAGE_ID_PATTERN.test(message.device) ||
      typeof message.text !== 'string' || encoder.encode(message.text).length > MAX_TEXT_BYTES ||
      !Number.isSafeInteger(message.created) || message.created < 0 || message.created > Date.now() + 5 * 60 * 1000) {
    throw new Error('Mensaje inválido');
  }
  if (message.kind === 'file') {
    const file = message.file;
    if (message.text !== '' || !file || !FILE_ID_PATTERN.test(file.id) || file.id !== message.id ||
        typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 ||
        /[\\/\u0000-\u001f\u007f]/.test(file.name) || ['.', '..'].includes(file.name) ||
        typeof file.type !== 'string' || file.type.length > 255 || /[^\x20-\x7e]/.test(file.type) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) {
      throw new Error('Archivo inválido');
    }
    if (file.format === 'chunks-v1') {
      if (file.chunkSize !== FILE_CHUNK_BYTES || file.chunks !== Math.max(1, Math.ceil(file.size / FILE_CHUNK_BYTES)) ||
          file.chunks > MAX_FILE_PARTS) throw new Error('Formato de archivo inválido');
    } else if (file.format !== undefined || file.size > LEGACY_MAX_FILE_BYTES) {
      throw new Error('Formato de archivo inválido');
    }
  } else if (message.kind === 'archive') {
    const target = message.target;
    if (message.text !== '' || !target || typeof target.id !== 'string' || !MESSAGE_ID_PATTERN.test(target.id) ||
        (target.url !== undefined && !validArchiveURL(target.url)) ||
        (target.seq !== undefined && (!Number.isSafeInteger(target.seq) || target.seq < 1 || target.seq >= Number.MAX_SAFE_INTEGER)) ||
        typeof message.archived !== 'boolean') {
      throw new Error('Estado de archivado inválido');
    }
  } else if ((message.kind !== undefined && message.kind !== 'text') || !message.text.trim()) {
    throw new Error('Mensaje inválido');
  }
  return message;
}

function fileBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Archivo inválido');
}

function fileId(id) {
  if (typeof id !== 'string' || !FILE_ID_PATTERN.test(id)) throw new Error('Identificador de archivo inválido');
  return id;
}

export async function encryptFile(key, id, value) {
  fileId(id);
  const bytes = fileBytes(value);
  if (bytes.byteLength > LEGACY_MAX_FILE_BYTES) throw new Error('Este formato de archivo admite hasta 10 MB.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(`pasa/file/v1/${id}`),
  }, key, bytes));
  const sealed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(ciphertext, iv.byteLength);
  return sealed;
}

export async function decryptFile(key, id, value, expectedSize) {
  fileId(id);
  const bytes = fileBytes(value);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > LEGACY_MAX_FILE_BYTES ||
      bytes.byteLength !== expectedSize + FILE_OVERHEAD_BYTES) throw new Error('El tamaño del archivo recibido no es válido.');
  return new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode(`pasa/file/v1/${id}`),
  }, key, bytes.subarray(12)));
}

function filePart(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_FILE_PARTS) throw new Error('Parte de archivo inválida');
  return index;
}

export async function encryptFileChunk(key, id, index, value) {
  fileId(id);
  filePart(index);
  const bytes = fileBytes(value);
  if (bytes.byteLength > FILE_CHUNK_BYTES) throw new Error('La parte del archivo supera 8 MB.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(`pasa/file/chunks-v1/${id}/${index}`),
  }, key, bytes));
  const sealed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(ciphertext, iv.byteLength);
  return sealed;
}

export async function decryptFileChunk(key, id, index, value, expectedSize) {
  fileId(id);
  filePart(index);
  const bytes = fileBytes(value);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > FILE_CHUNK_BYTES ||
      bytes.byteLength !== expectedSize + FILE_OVERHEAD_BYTES) throw new Error('El tamaño de la parte recibida no es válido.');
  return new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode(`pasa/file/chunks-v1/${id}/${index}`),
  }, key, bytes.subarray(12)));
}

export async function encryptMessage(key, message) {
  validateMessage(message);
  let bytes = encoder.encode(JSON.stringify(message));
  let zip = 0;
  if (bytes.length > 1500 && typeof CompressionStream !== 'undefined') {
    const compressed = await transform(bytes, new CompressionStream('gzip'), MAX_JSON_BYTES);
    if (compressed.length < bytes.length) { bytes = compressed; zip = 1; }
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`pasa/v1/${zip}`) }, key, bytes);
  return JSON.stringify({ v: 1, zip, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) });
}

export async function decryptMessage(key, envelope) {
  if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_BYTES) throw new Error('Mensaje demasiado grande');
  const box = JSON.parse(envelope);
  if (box.v !== 1 || ![0, 1].includes(box.zip) || typeof box.iv !== 'string' || box.iv.length !== 16 || typeof box.data !== 'string') {
    throw new Error('Formato de mensaje desconocido');
  }
  let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(box.iv), additionalData: encoder.encode(`pasa/v1/${box.zip}`) }, key, fromBase64(box.data)));
  if (box.zip) bytes = await transform(bytes, new DecompressionStream('gzip'), MAX_JSON_BYTES);
  if (bytes.length > MAX_JSON_BYTES) throw new Error('Mensaje demasiado grande');
  return validateMessage(JSON.parse(decoder.decode(bytes)));
}

export class RelayError extends Error {
  constructor(message, retryable = false, retryAfter = 0, status = 0) {
    super(message);
    this.name = 'RelayError';
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.status = status;
  }
}

function roomURL(topic, suffix) {
  if (!/^pasa_[a-f0-9]{56}$/.test(topic)) throw new RelayError('El enlace de conexión no es válido.');
  return `${API_ORIGIN}/api/rooms/${topic}/${suffix}`;
}

function backendEvent(event) {
  return event?.event === 'message' && Number.isSafeInteger(event.seq) && event.seq > 0 &&
    event.id === String(event.seq) && typeof event.message === 'string' && event.message.length <= MAX_ENVELOPE_BYTES;
}

async function boundedJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new RelayError('No se pudo leer la respuesta del servidor.', true);
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4 * 1024 * 1024) {
      await reader.cancel();
      throw new RelayError('La respuesta del servidor es demasiado grande.', true);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(decoder.decode(bytes));
}

function responseError(status, file = false) {
  const messages = {
    404: file ? 'El archivo o el espacio no está disponible. Revisa el enlace de conexión.' : 'Este espacio no existe. Abre tu enlace privado completo en ambos PCs.',
    409: 'Este archivo ya existe con otro contenido. Vuelve a seleccionarlo para enviarlo.',
    413: file ? 'Cada archivo puede ocupar hasta 250 MB.' : 'El texto es demasiado grande para este envío.',
    429: 'El servidor está temporalmente ocupado. Inténtalo de nuevo.',
  };
  return new RelayError(messages[status] || 'El servidor no pudo completar la operación.', status >= 500 || status === 429, 0, status);
}

async function requestJSON(url, options, fetcher, { timeout = 25000, file = false } = {}) {
  let response;
  try {
    response = await fetcher(url, {
      ...options,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new RelayError('No se pudo conectar. Revisa la conexión e inténtalo otra vez.', true); }
  if (!response.ok) throw responseError(response.status, file);
  try { return await boundedJSON(response); }
  catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('No se pudo confirmar la respuesta del servidor.', true);
  }
}

async function publishTo(topic, suffix, envelope, fetcher) {
  if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_BYTES) throw new RelayError('El texto es demasiado grande.');
  const event = await requestJSON(roomURL(topic, suffix), {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: envelope,
  }, fetcher);
  if (!backendEvent(event)) throw new RelayError('No se pudo confirmar el envío.', true);
  return event;
}

export function publishEnvelope(topic, envelope, fetcher = fetch) {
  return publishTo(topic, 'messages', envelope, fetcher);
}

export function publishArchiveEnvelope(topic, envelope, fetcher = fetch) {
  return publishTo(topic, 'archives', envelope, fetcher);
}

export async function uploadFile(topic, id, envelope, value, fetcher = fetch) {
  fileId(id);
  const bytes = fileBytes(value);
  if (bytes.byteLength < FILE_OVERHEAD_BYTES || bytes.byteLength > LEGACY_MAX_FILE_BYTES + FILE_OVERHEAD_BYTES) {
    throw new RelayError('Cada archivo puede ocupar hasta 10 MB.');
  }
  if (typeof envelope !== 'string' || !envelope || encoder.encode(envelope).byteLength > MAX_FILE_ENVELOPE_BYTES) {
    throw new RelayError('Los datos del archivo no son válidos.');
  }
  const url = roomURL(topic, `files/${id}`);
  const body = new FormData();
  body.set('envelope', envelope);
  body.set('file', new Blob([bytes], { type: 'application/octet-stream' }), 'encrypted.bin');
  const event = await requestJSON(url, { method: 'POST', body }, fetcher, { timeout: 120000, file: true });
  if (!backendEvent(event)) throw new RelayError('No se pudo confirmar la subida del archivo.', true);
  return event;
}

export async function startFileUpload(topic, id, envelope, parts, bytes, fetcher = fetch) {
  fileId(id);
  const plaintextBytes = bytes - parts * FILE_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > MAX_FILE_PARTS ||
      !Number.isSafeInteger(bytes) || plaintextBytes < 0 || plaintextBytes > MAX_FILE_BYTES ||
      parts !== Math.max(1, Math.ceil(plaintextBytes / FILE_CHUNK_BYTES))) {
    throw new RelayError('Los datos del archivo no son válidos. El máximo es 250 MB.');
  }
  if (typeof envelope !== 'string' || !envelope || encoder.encode(envelope).byteLength > MAX_FILE_ENVELOPE_BYTES) {
    throw new RelayError('Los datos del archivo no son válidos.');
  }
  const result = await requestJSON(roomURL(topic, `files/${id}/start`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, parts, bytes }),
  }, fetcher, { timeout: 120000, file: true });
  if (!result || result.id !== id || !Array.isArray(result.uploaded) ||
      result.uploaded.length > parts || new Set(result.uploaded).size !== result.uploaded.length ||
      !result.uploaded.every(index => Number.isSafeInteger(index) && index >= 0 && index < parts) ||
      (result.event !== undefined && !backendEvent(result.event))) {
    throw new RelayError('No se pudo confirmar la preparación del archivo.', true);
  }
  return result;
}

export async function uploadFilePart(topic, id, index, value, fetcher = fetch) {
  fileId(id);
  filePart(index);
  const bytes = fileBytes(value);
  if (bytes.byteLength < FILE_OVERHEAD_BYTES || bytes.byteLength > FILE_CHUNK_BYTES + FILE_OVERHEAD_BYTES) {
    throw new RelayError('El tamaño de la parte del archivo no es válido.');
  }
  const result = await requestJSON(roomURL(topic, `files/${id}/parts/${index}`), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  }, fetcher, { timeout: 120000, file: true });
  if (!result || result.id !== id || result.part !== index) throw new RelayError('No se pudo confirmar la subida de la parte.', true);
  return result;
}

export async function completeFileUpload(topic, id, fetcher = fetch) {
  fileId(id);
  const event = await requestJSON(roomURL(topic, `files/${id}/complete`), { method: 'POST' }, fetcher, { timeout: 120000, file: true });
  if (!backendEvent(event)) throw new RelayError('No se pudo confirmar la subida del archivo.', true);
  return event;
}

async function downloadBinary(url, maxBytes, fetcher) {
  let response;
  try {
    response = await fetcher(url, {
      method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      signal: AbortSignal.timeout(120000),
    });
  } catch { throw new RelayError('No se pudo descargar el archivo. Revisa la conexión e inténtalo otra vez.', true); }
  if (!response.ok) throw responseError(response.status, true);
  if (Number(response.headers.get('Content-Length')) > maxBytes) {
    await response.body?.cancel();
    throw new RelayError('El archivo recibido es demasiado grande.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RelayError('No se pudo leer el archivo recibido.', true);
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RelayError('El archivo recibido es demasiado grande.');
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('Se interrumpió la descarga. Inténtalo de nuevo.', true);
  }
  if (size < FILE_OVERHEAD_BYTES) throw new RelayError('El archivo recibido está incompleto.', true);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

export function downloadFile(topic, id, fetcher = fetch) {
  try {
    fileId(id);
    return downloadBinary(roomURL(topic, `files/${id}`), LEGACY_MAX_FILE_BYTES + FILE_OVERHEAD_BYTES, fetcher);
  } catch (error) { return Promise.reject(error); }
}

export function downloadFilePart(topic, id, index, fetcher = fetch) {
  try {
    fileId(id);
    filePart(index);
    return downloadBinary(roomURL(topic, `files/${id}/parts/${index}`), FILE_CHUNK_BYTES + FILE_OVERHEAD_BYTES, fetcher);
  } catch (error) { return Promise.reject(error); }
}

export async function envelopeFromEvent(event) {
  return backendEvent(event) ? event.message : null;
}

async function loadCatalog(topic, suffix, { before, after, limit = 30 }, fetcher) {
  const url = new URL(roomURL(topic, suffix));
  if (before !== undefined && after !== undefined) throw new RelayError('Cursor de historial no válido.');
  for (const [name, value] of [['before', before], ['after', after]]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || (name === 'before' && value === 0)) throw new RelayError('Cursor de historial no válido.');
    url.searchParams.set(name, String(value));
  }
  url.searchParams.set('limit', String(Math.max(1, Math.min(50, Math.floor(limit) || 30))));
  const page = await requestJSON(url.href, { method: 'GET' }, fetcher);
  if (!page || !Array.isArray(page.messages) || page.messages.length > 50 || !page.messages.every(backendEvent) ||
    !Number.isSafeInteger(page.latestSeq) || page.latestSeq < 0 || typeof page.hasMore !== 'boolean') {
    throw new RelayError('El historial recibido no es válido.', true);
  }
  return page;
}

export function loadHistory(topic, cursors = {}, fetcher = fetch) {
  return loadCatalog(topic, 'messages', cursors, fetcher);
}

export function loadFiles(topic, cursors = {}, fetcher = fetch) {
  return loadCatalog(topic, 'files', cursors, fetcher);
}

export function loadArchives(topic, cursors = {}, fetcher = fetch) {
  return loadCatalog(topic, 'archives', cursors, fetcher);
}

// WebSockets carry only live updates. onSync triggers gap recovery over paginated HTTP.
// The backend auto-replies to ping while its SQLite room is hibernating.
export function subscribe(topic, { onEvent, onStatus, onSync = () => {} }, makeSocket = url => new WebSocket(url)) {
  const socketURL = roomURL(topic, 'ws').replace(/^http/, 'ws');
  let socket;
  let timer;
  let watchdog;
  let heartbeat;
  let failures = 0;
  let closed = false;
  function clearTimers() {
    clearTimeout(timer);
    clearTimeout(watchdog);
    clearInterval(heartbeat);
  }
  function connect() {
    if (closed) return;
    clearTimers();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      onStatus('offline');
      timer = setTimeout(connect, 15000);
      return;
    }
    onStatus(failures ? 'reconnecting' : 'connecting');
    socket = makeSocket(socketURL);
    const active = socket;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { if (active === socket) active.close(); }, 70000);
    };
    arm();
    active.onopen = () => {
      if (active !== socket || closed) return;
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (active === socket && active.readyState === 1) {
          try { active.send('ping'); } catch { active.close(); }
        }
      }, 25000);
    };
    active.onmessage = event => {
      if (active !== socket || closed) return;
      arm();
      if (event.data === 'pong') return;
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      if (value.event === 'open' && Number.isSafeInteger(value.latestSeq) && value.latestSeq >= 0) {
        failures = 0;
        onStatus('connected');
        onSync(value.latestSeq);
      } else if (backendEvent(value)) onEvent(value);
    };
    active.onerror = () => active.close();
    active.onclose = () => {
      if (active !== socket || closed) return;
      clearTimers();
      failures += 1;
      onStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'reconnecting');
      timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) + Math.random() * 500);
    };
  }
  connect();
  return {
    reconnect() {
      if (closed) return;
      if (socket) { socket.onclose = null; socket.close(); }
      connect();
    },
    close() {
      closed = true;
      clearTimers();
      socket?.close();
    },
  };
}
