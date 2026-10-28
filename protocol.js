// The owned backend receives only ciphertext. The key stays in the URL fragment.
import { API_ORIGIN } from './config.js?v=2.0.0';
export const MAX_TEXT_BYTES = 128 * 1024;
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

export function validateMessage(message) {
  if (!message || message.v !== 1 || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(message.id) ||
      typeof message.device !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(message.device) ||
      typeof message.text !== 'string' || !message.text.trim() || encoder.encode(message.text).length > MAX_TEXT_BYTES ||
      !Number.isSafeInteger(message.created) || message.created < 0 || message.created > Date.now() + 5 * 60 * 1000) {
    throw new Error('Mensaje inválido');
  }
  return message;
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

async function requestJSON(url, options, fetcher) {
  let response;
  try {
    response = await fetcher(url, {
      ...options,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(25000),
    });
  } catch { throw new RelayError('No se pudo conectar. Revisa la conexión e inténtalo otra vez.', true); }
  if (!response.ok) {
    const status = response.status;
    const messages = {
      404: 'Este espacio no existe. Abre tu enlace privado completo en ambos PCs.',
      413: 'El texto es demasiado grande para este envío.',
      429: 'El servidor está temporalmente ocupado. Inténtalo de nuevo.',
    };
    throw new RelayError(messages[status] || 'El servidor no pudo completar la operación.', status >= 500 || status === 429, 0, status);
  }
  try { return await boundedJSON(response); }
  catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('No se pudo confirmar la respuesta del servidor.', true);
  }
}

export async function publishEnvelope(topic, envelope, fetcher = fetch) {
  if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_BYTES) throw new RelayError('El texto es demasiado grande.');
  const event = await requestJSON(roomURL(topic, 'messages'), {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: envelope,
  }, fetcher);
  if (!backendEvent(event)) throw new RelayError('No se pudo confirmar el envío.', true);
  return event;
}

export async function envelopeFromEvent(event) {
  return backendEvent(event) ? event.message : null;
}

export async function loadHistory(topic, { before, after, limit = 30 } = {}, fetcher = fetch) {
  const url = new URL(roomURL(topic, 'messages'));
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
