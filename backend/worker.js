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
  const match = /^\/api\/rooms\/(pasa_[a-f0-9]{56})\/(messages|ws|preview|image)$/.exec(url.pathname);
  if (!match || !allowedRooms(env).has(match[1])) throw new ApiError(404, 'Espacio no encontrado');
  return { url, room: match[1], action: match[2] };
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
      if (!['messages', 'ws'].includes(route.action)) throw new ApiError(404, 'Ruta no encontrada');
      if (request.method === 'OPTIONS') return options(request);
      if (route.action === 'ws') {
        if (request.method !== 'GET') throw new ApiError(405, 'Método no permitido');
        return this.upgrade(request);
      }
      if (request.method === 'GET') return this.history(request, route.url);
      if (request.method === 'POST') return await this.publish(request);
      throw new ApiError(405, 'Método no permitido');
    } catch (error) { return failure(request, error); }
  }

  history(request, url) {
    if (url.searchParams.has('before') && url.searchParams.has('after')) throw new ApiError(400, 'Usa un solo cursor');
    const forward = url.searchParams.has('after');
    const position = cursor(url.searchParams.get(forward ? 'after' : 'before'), forward ? 0 : Number.MAX_SAFE_INTEGER);
    const requestedLimit = cursor(url.searchParams.get('limit'), 30);
    if (requestedLimit < 1) throw new ApiError(400, 'Tamaño de página no válido');
    const limit = Math.min(50, requestedLimit);
    const latestSeq = this.latestSeq();
    const rows = this.sql.exec(
      forward ? 'SELECT seq, envelope, created FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?' :
        'SELECT seq, envelope, created FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?', position, limit);
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
      forward ? 'SELECT seq FROM messages WHERE seq > ? LIMIT 1' : 'SELECT seq FROM messages WHERE seq < ? LIMIT 1', lastSeq).toArray().length > 0;
    return json(request, {
      messages,
      ...(forward ? { nextAfter: lastSeq } : { nextBefore: hasMore ? lastSeq : null }),
      hasMore,
      latestSeq,
    });
  }

  async publish(request) {
    const { envelope, bytes } = await boundedEnvelope(request);
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const digest = [...digestBytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const stored = this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec('SELECT seq, envelope, created FROM messages WHERE digest = ?', digest).toArray()[0];
      if (existing) return { row: existing, inserted: false };
      const row = this.sql.exec('INSERT INTO messages (digest, envelope, created) VALUES (?, ?, ?) RETURNING seq, envelope, created', digest, envelope, Date.now()).one();
      return { row, inserted: true };
    });
    // No client receives a success or live event before the write is durable.
    await this.ctx.storage.sync();
    const event = toEvent(stored.row);
    if (stored.inserted) {
      const data = JSON.stringify(event);
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(data); }
        catch { try { socket.close(1011, 'Reconecta para recuperar el historial'); } catch {} }
      }
    }
    return json(request, event);
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
        return json(request, { status: 'ok', version: 'pasa-own-v2' });
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
