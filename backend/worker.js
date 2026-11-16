// Message bodies stay encrypted. Public preview URLs are fetched separately.
import { getPreview, PreviewError } from './preview.js';
import { signImage, loadPreviewImage } from './image-proxy.js';
const ROOM_PATTERN = /^pasa_[a-f0-9]{56}$/;
const ALLOWED_ORIGINS = new Set([
  'https://ealfaro29.github.io',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_JSON_BYTES = MAX_TEXT_BYTES * 6 + 2048;
export const MAX_ENVELOPE_BYTES = Math.ceil((MAX_JSON_BYTES + 16) * 4 / 3) + 128;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 250 * 1024 * 1024;
export const MAX_LEGACY_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_PART_BYTES = 8 * 1024 * 1024;
const MAX_PART_CIPHERTEXT_BYTES = FILE_PART_BYTES + 28;
const MAX_FILE_PARTS = Math.ceil(MAX_FILE_BYTES / FILE_PART_BYTES);
const MAX_FILE_ENVELOPE_BYTES = 16 * 1024;
const MAX_FILE_CIPHERTEXT_BYTES = MAX_LEGACY_FILE_BYTES + 28;
const MAX_UPLOAD_BYTES = MAX_FILE_CIPHERTEXT_BYTES + MAX_FILE_ENVELOPE_BYTES + 8192;
const FILE_CHUNK_BYTES = 256 * 1024;
const UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function headersFor(request) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function json(request, body, status = 200, additional = {}) {
  const headers = headersFor(request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(additional)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function allowedRooms(env) {
  if (typeof env.ROOM_IDS !== 'string' || !env.ROOM_IDS.trim()) return new Set();
  const rooms = env.ROOM_IDS.split(',').map(room => room.trim());
  // A malformed configuration fails closed instead of opening new namespaces.
  if (rooms.some(room => !ROOM_PATTERN.test(room))) return new Set();
  return new Set(rooms);
}

function inspect(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) throw new ApiError(403, 'Origen no permitido');
  const url = new URL(request.url);
  const match = /^\/api\/rooms\/(pasa_[a-f0-9]{56})\/(messages|archives|file-deletions|ws|preview|image|files)(?:\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(start|complete|delete|parts\/(0|[1-9]\d?)))?)?$/.exec(url.pathname);
  if (!match || (match[3] && match[2] !== 'files') || !allowedRooms(env).has(match[1])) throw new ApiError(404, 'Espacio no encontrado');
  return { url, room: match[1], action: match[2], fileId: match[3], fileAction: match[4]?.split('/')[0], part: match[5] === undefined ? undefined : Number(match[5]) };
}

function options(request) {
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (requestedMethod && !['GET', 'POST'].includes(requestedMethod.toUpperCase())) throw new ApiError(405, 'Método no permitido');
  const requestedHeaders = request.headers.get('Access-Control-Request-Headers');
  if (requestedHeaders && requestedHeaders.split(',').some(name => name.trim().toLowerCase() !== 'content-type')) {
    throw new ApiError(400, 'Cabecera no permitida');
  }
  const headers = headersFor(request);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function failure(request, error) {
  const known = error instanceof ApiError || error instanceof PreviewError;
  return json(request, { error: known ? error.message : 'Error temporal del servidor' }, known ? error.status : 500);
}

async function preview(request, env, route) {
  if (request.method !== 'POST') throw new ApiError(405, 'Método no permitido');
  if (!request.body) throw new ApiError(400, 'Falta el enlace');
  const reader = request.body.getReader();
  let size = 0;
  const parts = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new ApiError(413, 'El enlace es demasiado largo'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let body;
  try { body = JSON.parse(decoder.decode(bytes)); } catch { throw new ApiError(400, 'Enlace no válido'); }
  if (!body || typeof body.url !== 'string' || body.url.length > 4096) throw new ApiError(400, 'Enlace no válido');
  const result = await getPreview(body.url);
  let image = null;
  if (result.image) {
    try {
      const token = await signImage(result.image, route.room, env.PREVIEW_SIGNING_KEY);
      const imageURL = new URL(`/api/rooms/${route.room}/image`, request.url);
      imageURL.searchParams.set('token', token);
      image = imageURL.href;
    } catch { /* Useful text metadata remains available if the image is rejected. */ }
  }
  return json(request, { ...result, url: body.url, image });
}

async function previewImage(request, env, route) {
  if (request.method !== 'GET') throw new ApiError(405, 'Método no permitido');
  const image = await loadPreviewImage(route.url.searchParams.get('token'), route.room, env.PREVIEW_SIGNING_KEY);
  const headers = headersFor(request);
  for (const name of ['Content-Type', 'X-Content-Type-Options', 'Content-Security-Policy']) {
    const value = image.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', 'private, max-age=86400');
  return new Response(image.body, { headers });
}

async function boundedEnvelope(request) {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType && !['text/plain', 'application/json'].includes(contentType)) throw new ApiError(415, 'Formato no permitido');
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > MAX_ENVELOPE_BYTES) throw new ApiError(413, 'El texto es demasiado grande');
  if (!request.body) throw new ApiError(400, 'Falta el mensaje cifrado');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ENVELOPE_BYTES) {
        await reader.cancel();
        throw new ApiError(413, 'El texto es demasiado grande');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'No se pudo leer el mensaje cifrado');
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let envelope;
  let box;
  try { envelope = decoder.decode(bytes); box = JSON.parse(envelope); }
  catch { throw new ApiError(400, 'Mensaje cifrado no válido'); }
  if (!box || Array.isArray(box) || box.v !== 1 || ![0, 1].includes(box.zip) ||
      typeof box.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(box.iv) ||
      typeof box.data !== 'string' || box.data.length < 22 || !/^[A-Za-z0-9_-]+$/.test(box.data) ||
      Object.keys(box).some(name => !['v', 'zip', 'iv', 'data'].includes(name))) {
    throw new ApiError(400, 'Mensaje cifrado no válido');
  }
  return { envelope, bytes };
}

async function digest(bytes) {
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hashed].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function boundedUpload(request) {
  const type = request.headers.get('Content-Type');
  if (!/^multipart\/form-data\s*;/i.test(type || '')) throw new ApiError(415, 'Formato de archivo no permitido');
  if (Number(request.headers.get('Content-Length')) > MAX_UPLOAD_BYTES) throw new ApiError(413, 'El archivo supera 10 MB');
  if (!request.body) throw new ApiError(400, 'Falta el archivo cifrado');
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new ApiError(413, 'El archivo supera 10 MB');
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'No se pudo leer el archivo cifrado');
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  let form;
  try { form = await new Response(body, { headers: { 'Content-Type': type } }).formData(); }
  catch { throw new ApiError(400, 'Archivo cifrado no válido'); }
  const envelope = form.get('envelope');
  const file = form.get('file');
  if ([...form.keys()].length !== 2 || typeof envelope !== 'string' || !file || typeof file === 'string') {
    throw new ApiError(400, 'Archivo cifrado no válido');
  }
  if (encoder.encode(envelope).byteLength > MAX_FILE_ENVELOPE_BYTES) throw new ApiError(413, 'Los datos del archivo son demasiado grandes');
  if (file.type !== 'application/octet-stream') throw new ApiError(415, 'Formato de archivo no permitido');
  if (file.size > MAX_FILE_CIPHERTEXT_BYTES) throw new ApiError(413, 'El archivo supera 10 MB');
  if (file.size < 28) throw new ApiError(400, 'Archivo cifrado no válido');
  const metadata = await boundedEnvelope(new Request(request.url, { method: 'POST', body: envelope }));
  return { envelope: metadata.envelope, metadataDigest: await digest(metadata.bytes), bytes: new Uint8Array(await file.arrayBuffer()) };
}

async function boundedBytes(request, maxBytes, message) {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw new ApiError(413, message);
  if (!request.body) throw new ApiError(400, 'Faltan los datos del archivo');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, message); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'No se pudieron leer los datos del archivo');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function cursor(value, fallback) {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new ApiError(400, 'Cursor no válido');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ApiError(400, 'Cursor no válido');
  return parsed;
}

function toEvent(row) {
  return { event: 'message', id: String(row.seq), seq: row.seq, time: Math.floor(row.created / 1000), message: row.envelope };
}

export class PasaRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      digest TEXT NOT NULL UNIQUE,
      envelope TEXT NOT NULL,
      created INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS archive_messages (
      seq INTEGER PRIMARY KEY REFERENCES messages(seq)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      message_seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
      size INTEGER NOT NULL,
      created INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS file_chunks (
      file_id TEXT NOT NULL REFERENCES files(id),
      part INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (file_id, part)
    ) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS file_uploads (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      envelope TEXT NOT NULL,
      digest TEXT NOT NULL,
      parts INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      created INTEGER NOT NULL,
      committed_seq INTEGER UNIQUE REFERENCES messages(seq)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS uploaded_parts (
      file_id TEXT NOT NULL REFERENCES file_uploads(id),
      part INTEGER NOT NULL,
      digest TEXT NOT NULL,
      size INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      PRIMARY KEY (file_id, part)
    ) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS upload_cleanup (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      last_checked INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS file_deletions (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
      message_digest TEXT,
      cleanup_due INTEGER NOT NULL DEFAULT -1,
      cleanup_passes INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS file_deletions_message_digest ON file_deletions (message_digest)');
    this.deletionCleanup = new Map();
    if (typeof WebSocketRequestResponsePair !== 'undefined') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  latestSeq() {
    return this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS latest FROM messages').one().latest;
  }

  async fetch(request) {
    try {
      const route = inspect(request, this.env);
      if (!['messages', 'archives', 'files', 'file-deletions', 'ws'].includes(route.action)) throw new ApiError(404, 'Ruta no encontrada');
      if (request.method === 'OPTIONS') return options(request);
      if (route.action === 'ws') {
        if (request.method !== 'GET') throw new ApiError(405, 'Método no permitido');
        return this.upgrade(request);
      }
      if (route.action === 'files' && route.fileId) {
        if (route.fileAction === 'delete' && request.method === 'POST') return await this.deleteFile(request, route);
        if (route.fileAction === 'start' && request.method === 'POST') return await this.startUpload(request, route);
        if (route.fileAction === 'complete' && request.method === 'POST') return await this.completeUpload(request, route);
        if (route.fileAction === 'parts') {
          if (request.method === 'POST') return await this.uploadPart(request, route);
          if (request.method === 'GET') return await this.downloadPart(request, route);
        }
        if (route.fileAction) throw new ApiError(405, 'Método no permitido');
        if (request.method === 'GET') return this.download(request, route.fileId);
        if (request.method === 'POST') return await this.upload(request, route.fileId);
        throw new ApiError(405, 'Método no permitido');
      }
      if (request.method === 'GET') return this.history(request, route.url, route.action);
      if (request.method === 'POST' && ['messages', 'archives'].includes(route.action)) return await this.publish(request, route.action);
      throw new ApiError(405, 'Método no permitido');
    } catch (error) { return failure(request, error); }
  }

  history(request, url, category = 'messages') {
    if (url.searchParams.has('before') && url.searchParams.has('after')) throw new ApiError(400, 'Usa un solo cursor');
    const forward = url.searchParams.has('after');
    const position = cursor(url.searchParams.get(forward ? 'after' : 'before'), forward ? 0 : Number.MAX_SAFE_INTEGER);
    const requestedLimit = cursor(url.searchParams.get('limit'), 30);
    if (requestedLimit < 1) throw new ApiError(400, 'Tamaño de página no válido');
    const limit = Math.min(50, requestedLimit);
    const latestSeq = this.latestSeq();
    const source = category === 'files' ? 'messages m JOIN files f ON f.message_seq = m.seq LEFT JOIN file_deletions d ON d.id = f.id' :
      category === 'file-deletions' ? 'messages m JOIN file_deletions d ON d.seq = m.seq' :
        category === 'archives' ? 'messages m JOIN archive_messages a ON a.seq = m.seq' : 'messages m';
    const visible = category === 'files' ? 'd.id IS NULL AND ' : '';
    const rows = this.sql.exec(
      `SELECT m.seq, m.envelope, m.created FROM ${source} WHERE ${visible}m.seq ${forward ? '>' : '<'} ? ORDER BY m.seq ${forward ? 'ASC' : 'DESC'} LIMIT ?`, position, limit);
    const messages = [];
    let bytes = 200;
    for (const row of rows) {
      const event = toEvent(row);
      const eventBytes = encoder.encode(JSON.stringify(event)).byteLength + 1;
      if (messages.length && bytes + eventBytes > MAX_PAGE_BYTES) break;
      messages.push(event);
      bytes += eventBytes;
    }
    const lastSeq = messages.length ? messages[messages.length - 1].seq : position;
    const hasMore = messages.length > 0 && this.sql.exec(
      `SELECT m.seq FROM ${source} WHERE ${visible}m.seq ${forward ? '>' : '<'} ? LIMIT 1`, lastSeq).toArray().length > 0;
    return json(request, {
      messages,
      ...(forward ? { nextAfter: lastSeq } : { nextBefore: hasMore ? lastSeq : null }),
      hasMore,
      latestSeq,
    });
  }

  async publish(request, category = 'messages') {
    const { envelope, bytes } = await boundedEnvelope(request);
    const envelopeDigest = await digest(bytes);
    const stored = this.ctx.storage.transactionSync(() => {
      const stored = this.insertMessage(envelope, envelopeDigest);
      if (category === 'archives') this.sql.exec('INSERT OR IGNORE INTO archive_messages (seq) VALUES (?)', stored.row.seq);
      return stored;
    });
    return this.committedEvent(request, stored);
  }

  insertMessage(envelope, envelopeDigest) {
    if (this.sql.exec('SELECT id FROM file_deletions WHERE message_digest = ?', envelopeDigest).toArray().length) throw new ApiError(410, 'El archivo fue eliminado.');
    const existing = this.sql.exec('SELECT seq, envelope, created FROM messages WHERE digest = ?', envelopeDigest).toArray()[0];
    if (existing) return { row: existing, inserted: false };
    const row = this.sql.exec('INSERT INTO messages (digest, envelope, created) VALUES (?, ?, ?) RETURNING seq, envelope, created', envelopeDigest, envelope, Date.now()).one();
    return { row, inserted: true };
  }

  async committedEvent(request, stored) {
    return json(request, await this.commitStored(stored));
  }

  async commitStored(stored) {
    // No client receives a success or live event before the write is durable.
    await this.ctx.storage.sync();
    if (!this.sql.exec('SELECT seq FROM messages WHERE seq = ?', stored.row.seq).toArray().length) throw new ApiError(410, 'El archivo fue eliminado.');
    const event = toEvent(stored.row);
    if (stored.inserted) {
      const data = JSON.stringify(event);
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(data); }
        catch { try { socket.close(1011, 'Reconecta para recuperar el historial'); } catch {} }
      }
    }
    return event;
  }

  assertFileAvailable(id) {
    if (this.sql.exec('SELECT id FROM file_deletions WHERE id = ?', id).toArray().length) throw new ApiError(410, 'El archivo fue eliminado.');
  }

  async deleteFile(request, route) {
    const { envelope, bytes } = await boundedEnvelope(request);
    const envelopeDigest = await digest(bytes);
    const stored = this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec('SELECT m.seq, m.envelope, m.created FROM file_deletions d JOIN messages m ON m.seq = d.seq WHERE d.id = ?', route.fileId).toArray()[0];
      if (existing) return { row: existing, inserted: false };
      const file = this.sql.exec('SELECT m.seq, m.digest FROM files f JOIN messages m ON m.seq = f.message_seq WHERE f.id = ?', route.fileId).toArray()[0];
      const upload = this.sql.exec('SELECT digest, committed_seq FROM file_uploads WHERE id = ?', route.fileId).toArray()[0];
      const original = file || (upload ? this.sql.exec('SELECT seq, digest FROM messages WHERE digest = ?', upload.digest).toArray()[0] : undefined);
      const originalDigest = file?.digest || upload?.digest || null;
      if (originalDigest === envelopeDigest) throw new ApiError(400, 'El mensaje de eliminación no puede ser el archivo original.');
      if (this.sql.exec('SELECT seq FROM messages WHERE digest = ?', envelopeDigest).toArray().length) throw new ApiError(409, 'La eliminación necesita un mensaje nuevo.');
      const message = this.insertMessage(envelope, envelopeDigest);
      if (this.sql.exec('SELECT id FROM file_deletions WHERE seq = ?', message.row.seq).toArray().length) throw new ApiError(409, 'Los datos de esta eliminación ya están en uso.');
      const needsR2 = Boolean(upload || this.sql.exec('SELECT id FROM upload_cleanup WHERE id = ?', route.fileId).toArray().length);
      this.sql.exec('INSERT INTO file_deletions (id, room, seq, message_digest, cleanup_due) VALUES (?, ?, ?, ?, ?)', route.fileId, route.room, message.row.seq, originalDigest, needsR2 ? Date.now() : -1);
      // Remove dependent rows before the original encrypted metadata message.
      // The deletion event is retained for every other device's replay cursor.
      this.sql.exec('DELETE FROM uploaded_parts WHERE file_id = ?', route.fileId);
      this.sql.exec('DELETE FROM file_chunks WHERE file_id = ?', route.fileId);
      this.sql.exec('DELETE FROM file_uploads WHERE id = ?', route.fileId);
      this.sql.exec('DELETE FROM upload_cleanup WHERE id = ?', route.fileId);
      this.sql.exec('DELETE FROM files WHERE id = ?', route.fileId);
      if (original) {
        this.sql.exec('DELETE FROM archive_messages WHERE seq = ?', original.seq);
        this.sql.exec('DELETE FROM messages WHERE seq = ?', original.seq);
      }
      return message;
    });
    await this.scheduleCleanup();
    const event = await this.commitStored(stored);
    const cleaned = await this.cleanupDeletedFile(route.fileId, { force: true });
    return json(request, { ...event, ...(!cleaned ? { cleanupPending: true } : {}) });
  }

  async purgeFilePrefix(room, id) {
    const bucket = this.fileBucket();
    let cursor;
    do {
      const page = await bucket.list({ prefix: `${room}/${id}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  async cleanupDeletedFile(id, { force = false } = {}) {
    if (this.deletionCleanup.has(id)) return this.deletionCleanup.get(id);
    const task = this.runDeletionCleanup(id, force);
    this.deletionCleanup.set(id, task);
    try { return await task; }
    finally { this.deletionCleanup.delete(id); }
  }

  async runDeletionCleanup(id, force) {
    const deleted = this.sql.exec('SELECT * FROM file_deletions WHERE id = ?', id).toArray()[0];
    if (!deleted || deleted.cleanup_due < 0) return true;
    // The second pass is delayed even if the client retries deletion. It catches
    // writes that were already in flight at the moment the tombstone committed.
    if (deleted.cleanup_due > Date.now() && (deleted.cleanup_passes > 0 || !force)) return deleted.cleanup_passes > 0;
    let cleaned;
    try {
      await this.purgeFilePrefix(deleted.room, id);
      const passes = deleted.cleanup_passes + 1;
      this.sql.exec('UPDATE file_deletions SET cleanup_passes = ?, cleanup_due = ? WHERE id = ?', passes, passes >= 2 ? -1 : Date.now() + UPLOAD_RETENTION_MS, id);
      cleaned = true;
    } catch {
      this.sql.exec('UPDATE file_deletions SET cleanup_due = ? WHERE id = ?', Date.now() + 60000, id);
      cleaned = false;
    }
    await this.ctx.storage.sync();
    await this.scheduleCleanup();
    return cleaned;
  }

  fileBucket() {
    if (!this.env.FILES) throw new ApiError(503, 'El almacenamiento de archivos no está disponible. Inténtalo más tarde.');
    return this.env.FILES;
  }

  uploadSession(route) {
    this.assertFileAvailable(route.fileId);
    const upload = this.sql.exec('SELECT * FROM file_uploads WHERE id = ? AND room = ? AND id NOT IN (SELECT id FROM upload_cleanup)', route.fileId, route.room).toArray()[0];
    if (!upload) throw new ApiError(404, 'Subida de archivo no encontrada');
    return upload;
  }

  async startUpload(request, route) {
    this.assertFileAvailable(route.fileId);
    this.fileBucket();
    const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (type !== 'application/json') throw new ApiError(415, 'Formato de archivo no permitido');
    const bytes = await boundedBytes(request, MAX_FILE_ENVELOPE_BYTES + 4096, 'Los datos del archivo son demasiado grandes');
    let body;
    try { body = JSON.parse(decoder.decode(bytes)); } catch { throw new ApiError(400, 'Datos de archivo no válidos'); }
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['envelope', 'parts', 'bytes'].includes(key)) ||
        typeof body.envelope !== 'string' || !Number.isSafeInteger(body.parts) || body.parts < 1 || body.parts > MAX_FILE_PARTS ||
        !Number.isSafeInteger(body.bytes) || body.bytes < body.parts * 28 || body.bytes > MAX_FILE_BYTES + body.parts * 28 ||
        Math.max(1, Math.ceil((body.bytes - body.parts * 28) / FILE_PART_BYTES)) !== body.parts) {
      throw new ApiError(400, 'Datos de archivo no válidos. El máximo es 250 MB.');
    }
    if (encoder.encode(body.envelope).byteLength > MAX_FILE_ENVELOPE_BYTES) throw new ApiError(413, 'Los datos del archivo son demasiado grandes');
    const metadata = await boundedEnvelope(new Request(request.url, { method: 'POST', body: body.envelope }));
    const envelopeDigest = await digest(metadata.bytes);
    const upload = this.ctx.storage.transactionSync(() => {
      this.assertFileAvailable(route.fileId);
      if (this.sql.exec('SELECT id FROM upload_cleanup WHERE id = ?', route.fileId).toArray().length) throw new ApiError(409, 'La subida caducó. Vuelve a seleccionar el archivo.');
      const existing = this.sql.exec('SELECT * FROM file_uploads WHERE id = ?', route.fileId).toArray()[0];
      if (existing) {
        if (existing.room !== route.room || existing.envelope !== body.envelope || existing.parts !== body.parts || existing.bytes !== body.bytes) {
          throw new ApiError(409, 'Este archivo ya existe con otros datos');
        }
        if (existing.committed_seq === null) this.sql.exec('UPDATE file_uploads SET created = ? WHERE id = ?', Date.now(), route.fileId);
        return existing;
      }
      if (this.sql.exec('SELECT id FROM files WHERE id = ?', route.fileId).toArray().length) throw new ApiError(409, 'Este archivo ya existe');
      this.sql.exec('INSERT INTO file_uploads (id, room, envelope, digest, parts, bytes, created) VALUES (?, ?, ?, ?, ?, ?, ?)', route.fileId, route.room, body.envelope, envelopeDigest, body.parts, body.bytes, Date.now());
      return { committed_seq: null };
    });
    await this.ctx.storage.sync();
    await this.scheduleCleanup();
    this.assertFileAvailable(route.fileId);
    const uploaded = this.sql.exec('SELECT part FROM uploaded_parts WHERE file_id = ? ORDER BY part ASC', route.fileId).toArray().map(part => part.part);
    const event = upload.committed_seq === null ? undefined : toEvent(this.sql.exec('SELECT seq, envelope, created FROM messages WHERE seq = ?', upload.committed_seq).one());
    return json(request, { id: route.fileId, uploaded, ...(event ? { event } : {}) });
  }

  async uploadPart(request, route) {
    this.assertFileAvailable(route.fileId);
    const bucket = this.fileBucket();
    const upload = this.uploadSession(route);
    if (route.part >= upload.parts) throw new ApiError(400, 'Parte de archivo no válida');
    const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (type !== 'application/octet-stream') throw new ApiError(415, 'Formato de archivo no permitido');
    if (upload.committed_seq === null) {
      this.sql.exec('UPDATE file_uploads SET created = ? WHERE id = ?', Date.now(), route.fileId);
      await this.ctx.storage.sync();
      await this.scheduleCleanup();
    }
    const expected = route.part < upload.parts - 1 ? MAX_PART_CIPHERTEXT_BYTES : upload.bytes - (upload.parts - 1) * MAX_PART_CIPHERTEXT_BYTES;
    const bytes = await boundedBytes(request, MAX_PART_CIPHERTEXT_BYTES, 'La parte del archivo es demasiado grande');
    if (bytes.byteLength !== expected) throw new ApiError(400, 'El tamaño de la parte del archivo no es válido');
    const partDigest = await digest(bytes);
    this.assertFileAvailable(route.fileId);
    const existing = this.sql.exec('SELECT digest, size FROM uploaded_parts WHERE file_id = ? AND part = ?', route.fileId, route.part).toArray()[0];
    if (existing) {
      if (existing.digest !== partDigest || existing.size !== bytes.byteLength) throw new ApiError(409, 'Esta parte ya existe con otro contenido');
      await this.ctx.storage.sync();
      this.assertFileAvailable(route.fileId);
      return json(request, { id: route.fileId, part: route.part });
    }
    if (upload.committed_seq !== null) throw new ApiError(409, 'El archivo ya está completo');
    // Content-addressed keys keep concurrent conflicting retries from overwriting
    // the bytes selected by the database transaction.
    const objectKey = `${route.room}/${route.fileId}/${route.part}/${partDigest}`;
    await bucket.put(objectKey, bytes, { sha256: partDigest, httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' } });
    try {
      this.ctx.storage.transactionSync(() => {
        const latest = this.uploadSession(route);
        const current = this.sql.exec('SELECT digest FROM uploaded_parts WHERE file_id = ? AND part = ?', route.fileId, route.part).toArray()[0];
        if (current) {
          if (current.digest !== partDigest) throw new ApiError(409, 'Esta parte ya existe con otro contenido');
          return;
        }
        if (latest.committed_seq !== null) throw new ApiError(409, 'El archivo ya está completo');
        this.sql.exec('INSERT INTO uploaded_parts (file_id, part, digest, size, object_key) VALUES (?, ?, ?, ?, ?)', route.fileId, route.part, partDigest, bytes.byteLength, objectKey);
        this.sql.exec('UPDATE file_uploads SET created = ? WHERE id = ?', Date.now(), route.fileId);
      });
    } catch (error) {
      // Only a proven conflicting key is safe to remove: a storage error may
      // race with another identical retry committing the same object key.
      if (error instanceof ApiError && [404, 409, 410].includes(error.status)) {
        const current = this.sql.exec('SELECT object_key FROM uploaded_parts WHERE file_id = ? AND part = ?', route.fileId, route.part).toArray()[0];
        if (current?.object_key !== objectKey) {
          try { await bucket.delete(objectKey); } catch { /* Unreferenced ciphertext remains inaccessible. */ }
        }
      }
      throw error;
    }
    await this.ctx.storage.sync();
    this.assertFileAvailable(route.fileId);
    return json(request, { id: route.fileId, part: route.part });
  }

  async scheduleCleanup() {
    if (typeof this.ctx.storage.setAlarm !== 'function') return;
    const pending = this.sql.exec('SELECT MIN(created) AS earliest FROM file_uploads WHERE committed_seq IS NULL AND id NOT IN (SELECT id FROM upload_cleanup)').one().earliest;
    const cleanup = this.sql.exec('SELECT MIN(last_checked) AS earliest FROM upload_cleanup WHERE last_checked >= 0').one().earliest;
    const deletions = this.sql.exec('SELECT MIN(cleanup_due) AS earliest FROM file_deletions WHERE cleanup_due >= 0').one().earliest;
    const earliest = Math.min(pending === null ? Infinity : pending + UPLOAD_RETENTION_MS, cleanup === null ? Infinity : cleanup + UPLOAD_RETENTION_MS, deletions === null ? Infinity : deletions);
    if (!Number.isFinite(earliest)) return;
    const due = Math.max(Date.now() + 1000, earliest);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || due < current) await this.ctx.storage.setAlarm(due);
  }

  async alarm() {
    const now = Date.now();
    // A durable tombstone claims each expired UUID before any asynchronous R2
    // deletion. Completion and retries can no longer turn it into a shared file.
    const expired = this.ctx.storage.transactionSync(() => {
      const uploads = this.sql.exec('SELECT id, room FROM file_uploads WHERE committed_seq IS NULL AND created <= ? AND id NOT IN (SELECT id FROM upload_cleanup)', now - UPLOAD_RETENTION_MS).toArray();
      for (const upload of uploads) this.sql.exec('INSERT INTO upload_cleanup (id, room) VALUES (?, ?)', upload.id, upload.room);
      return this.sql.exec('SELECT id, room FROM upload_cleanup WHERE last_checked >= 0 AND last_checked <= ? ORDER BY last_checked ASC LIMIT 20', now - UPLOAD_RETENTION_MS).toArray();
    });
    await this.ctx.storage.sync();
    for (const upload of expired) {
      try {
        await this.purgeFilePrefix(upload.room, upload.id);
        this.ctx.storage.transactionSync(() => {
          const firstPass = this.sql.exec('SELECT id FROM file_uploads WHERE id = ?', upload.id).toArray().length > 0;
          this.sql.exec('DELETE FROM uploaded_parts WHERE file_id = ?', upload.id);
          this.sql.exec('DELETE FROM file_uploads WHERE id = ? AND committed_seq IS NULL', upload.id);
          // Recheck once after another day to catch late in-flight writes, then
          // retain only the UUID tombstone without recurring object-list costs.
          this.sql.exec('UPDATE upload_cleanup SET last_checked = ? WHERE id = ?', firstPass ? Date.now() : -1, upload.id);
        });
      } catch {
        this.sql.exec('UPDATE upload_cleanup SET last_checked = ? WHERE id = ?', Date.now() - UPLOAD_RETENTION_MS + 60000, upload.id);
      }
    }
    const deletions = this.sql.exec('SELECT id FROM file_deletions WHERE cleanup_due >= 0 AND cleanup_due <= ? ORDER BY cleanup_due ASC LIMIT 20', now).toArray();
    for (const deleted of deletions) await this.cleanupDeletedFile(deleted.id);
    await this.ctx.storage.sync();
    await this.scheduleCleanup();
  }

  async completeUpload(request, route) {
    this.assertFileAvailable(route.fileId);
    this.fileBucket();
    if (request.body) {
      const bytes = await boundedBytes(request, 1, 'La finalización no admite contenido');
      if (bytes.byteLength) throw new ApiError(400, 'La finalización no admite contenido');
    }
    const stored = this.ctx.storage.transactionSync(() => {
      const upload = this.uploadSession(route);
      if (upload.committed_seq !== null) return { inserted: false, row: this.sql.exec('SELECT seq, envelope, created FROM messages WHERE seq = ?', upload.committed_seq).one() };
      const parts = this.sql.exec('SELECT part, size FROM uploaded_parts WHERE file_id = ? ORDER BY part ASC', route.fileId).toArray();
      if (parts.length !== upload.parts || parts.some((part, index) => part.part !== index || part.size !== (index < upload.parts - 1 ? MAX_PART_CIPHERTEXT_BYTES : upload.bytes - index * MAX_PART_CIPHERTEXT_BYTES)) ||
          parts.reduce((sum, part) => sum + part.size, 0) !== upload.bytes) {
        throw new ApiError(409, 'Faltan partes del archivo. Reintenta la subida.');
      }
      const message = this.insertMessage(upload.envelope, upload.digest);
      if (this.sql.exec('SELECT id FROM files WHERE id = ? OR message_seq = ?', route.fileId, message.row.seq).toArray().length) throw new ApiError(409, 'Los datos de este archivo ya están en uso');
      this.sql.exec('INSERT INTO files (id, digest, message_seq, size, created) VALUES (?, ?, ?, ?, ?)', route.fileId, upload.digest, message.row.seq, upload.bytes, Date.now());
      this.sql.exec('UPDATE file_uploads SET committed_seq = ? WHERE id = ?', message.row.seq, route.fileId);
      return message;
    });
    return this.committedEvent(request, stored);
  }

  async downloadPart(request, route) {
    this.assertFileAvailable(route.fileId);
    const bucket = this.fileBucket();
    const part = this.sql.exec('SELECT p.object_key, p.size FROM uploaded_parts p JOIN file_uploads u ON u.id = p.file_id WHERE p.file_id = ? AND p.part = ? AND u.room = ? AND u.committed_seq IS NOT NULL', route.fileId, route.part, route.room).toArray()[0];
    if (!part) throw new ApiError(404, 'Archivo no encontrado');
    const object = await bucket.get(part.object_key);
    try { this.assertFileAvailable(route.fileId); }
    catch (error) {
      try { await object?.body?.cancel(); } catch {}
      throw error;
    }
    if (!object || object.size !== part.size) throw new ApiError(503, 'No se pudo recuperar el archivo. Inténtalo de nuevo.');
    const headers = headersFor(request);
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Length', String(part.size));
    headers.set('Content-Disposition', 'attachment; filename="encrypted.bin"');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    return new Response(object.body, { headers });
  }

  async upload(request, fileId) {
    this.assertFileAvailable(fileId);
    const { envelope, metadataDigest, bytes } = await boundedUpload(request);
    const fileDigest = await digest(bytes);
    const stored = this.ctx.storage.transactionSync(() => {
      this.assertFileAvailable(fileId);
      if (this.sql.exec('SELECT id FROM file_uploads WHERE id = ?', fileId).toArray().length) throw new ApiError(409, 'Este archivo ya existe');
      const existing = this.sql.exec('SELECT f.digest, m.seq, m.envelope, m.created FROM files f JOIN messages m ON m.seq = f.message_seq WHERE f.id = ?', fileId).toArray()[0];
      if (existing) {
        if (existing.digest !== fileDigest || existing.envelope !== envelope) throw new ApiError(409, 'Este archivo ya existe con otro contenido');
        return { row: existing, inserted: false };
      }
      const message = this.insertMessage(envelope, metadataDigest);
      if (this.sql.exec('SELECT id FROM files WHERE message_seq = ?', message.row.seq).toArray().length) throw new ApiError(409, 'Los datos de este archivo ya están en uso');
      this.sql.exec('INSERT INTO files (id, digest, message_seq, size, created) VALUES (?, ?, ?, ?, ?)', fileId, fileDigest, message.row.seq, bytes.byteLength, Date.now());
      for (let offset = 0, part = 0; offset < bytes.byteLength; offset += FILE_CHUNK_BYTES, part++) {
        this.sql.exec('INSERT INTO file_chunks (file_id, part, data) VALUES (?, ?, ?)', fileId, part, bytes.subarray(offset, offset + FILE_CHUNK_BYTES));
      }
      return message;
    });
    return this.committedEvent(request, stored);
  }

  download(request, fileId) {
    this.assertFileAvailable(fileId);
    const file = this.sql.exec('SELECT size FROM files WHERE id = ?', fileId).toArray()[0];
    if (!file) throw new ApiError(404, 'Archivo no encontrado');
    if (this.sql.exec('SELECT id FROM file_uploads WHERE id = ? AND committed_seq IS NOT NULL', fileId).toArray().length) throw new ApiError(409, 'Actualiza Pasa para descargar este archivo');
    if (file.size < 28 || file.size > MAX_FILE_CIPHERTEXT_BYTES) throw new Error('Invalid stored file size');
    const bytes = new Uint8Array(file.size);
    let offset = 0;
    for (const chunk of this.sql.exec('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY part ASC', fileId)) {
      const part = new Uint8Array(chunk.data);
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    if (offset !== file.size) throw new Error('Incomplete stored file');
    const headers = headersFor(request);
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Length', String(bytes.byteLength));
    headers.set('Content-Disposition', 'attachment; filename="encrypted.bin"');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    return new Response(bytes, { headers });
  }

  upgrade(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new ApiError(426, 'Se requiere WebSocket');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ event: 'open', latestSeq: this.latestSeq() }));
    return new Response(null, { status: 101, webSocket: client, headers: headersFor(request) });
  }

  webSocketMessage(socket, message) {
    // Normally the hibernation auto-response handles pings without waking us.
    if (message === 'ping') { socket.send('pong'); return; }
    socket.close(1008, 'Los mensajes se envían mediante HTTP');
  }

  webSocketClose(socket, code, reason) {
    try { socket.close(code, reason); } catch {}
  }

  webSocketError(socket) {
    try { socket.close(1011, 'Reconecta para recuperar el historial'); } catch {}
  }
}

export default {
  async fetch(request, env) {
    try {
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) throw new ApiError(403, 'Origen no permitido');
      if (new URL(request.url).pathname === '/health') {
        if (request.method !== 'GET') throw new ApiError(405, 'Método no permitido');
        return json(request, { status: 'ok', version: 'pasa-own-v3.3' });
      }
      const route = inspect(request, env);
      if (request.method === 'OPTIONS') return options(request);
      if (route.action === 'preview') return await preview(request, env, route);
      if (route.action === 'image') return await previewImage(request, env, route);
      if (!['GET', 'POST'].includes(request.method) || (route.action === 'ws' && request.method !== 'GET')) throw new ApiError(405, 'Método no permitido');
      const room = env.ROOMS.get(env.ROOMS.idFromName(route.room));
      return await room.fetch(request);
    } catch (error) { return failure(request, error); }
  },
};
