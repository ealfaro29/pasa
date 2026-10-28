// The relay receives only ciphertext. The room key stays in the URL fragment.
export const RELAY = 'https://ntfy.sh';
export const HISTORY_MS = 12 * 60 * 60 * 1000;
export const MAX_TEXT_BYTES = 128 * 1024;
// JSON can expand control characters to six bytes each before compression.
const MAX_JSON_BYTES = MAX_TEXT_BYTES * 6 + 2048;
export const MAX_ENVELOPE_BYTES = Math.ceil((MAX_JSON_BYTES + 16) * 4 / 3) + 128;
export const INLINE_BYTES = 4096;
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
  constructor(message, retryable = false, retryAfter = 0) {
    super(message);
    this.name = 'RelayError';
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

export async function publishEnvelope(topic, envelope, fetcher = fetch) {
  const attachment = encoder.encode(envelope).length > INLINE_BYTES;
  let response;
  try {
    response = await fetcher(`${RELAY}/${topic}`, {
      method: 'POST',
      headers: attachment ? { 'Content-Type': 'text/plain', Filename: 'pasa.enc' } : { 'Content-Type': 'text/plain' },
      body: envelope,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(25000),
    });
  } catch { throw new RelayError('No se pudo enviar. Revisa la conexión e inténtalo otra vez.', true); }
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Math.max(60000, Math.min(86400000, (Number(response.headers.get('Retry-After')) || 60) * 1000));
      throw new RelayError('Límite temporal del servicio. Espera un momento para reintentar.', false, retryAfter);
    }
    throw new RelayError(response.status >= 500 ? 'El servicio está temporalmente ocupado.' : 'El servicio no pudo aceptar este texto.', response.status >= 500);
  }
  let event;
  try { event = await response.json(); }
  catch { throw new RelayError('No se pudo confirmar el envío.', true); }
  if (event.event !== 'message' || typeof event.id !== 'string') throw new RelayError('No se pudo confirmar el envío.', true);
  return event;
}

export async function envelopeFromEvent(event, fetcher = fetch) {
  try { return await readEnvelopeFromEvent(event, fetcher); }
  catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('No se pudo descargar el texto largo. Reintentando la conexión.', true);
  }
}

async function readEnvelopeFromEvent(event, fetcher) {
  if (!event || event.event !== 'message') return null;
  if (!event.attachment) {
    if (typeof event.message !== 'string' || event.message.length > INLINE_BYTES) return null;
    return event.message;
  }
  const file = event.attachment;
  if (file.name !== 'pasa.enc' || !Number.isFinite(file.size) || file.size > MAX_ENVELOPE_BYTES || file.size < 1) return null;
  let url;
  try { url = new URL(file.url); } catch { return null; }
  if (url.origin !== RELAY || !/^\/file\/[a-zA-Z0-9._-]+$/.test(url.pathname) || url.username || url.password || url.search) return null;
  if (file.expires * 1000 <= Date.now()) throw new RelayError('Este texto largo ya expiró. Vuelve a enviarlo desde el otro PC.');
  const response = await fetcher(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new RelayError(response.status === 404 ? 'Este texto largo ya expiró.' : 'No se pudo descargar el texto largo.', response.status !== 404);
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > MAX_ENVELOPE_BYTES) return null;
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_ENVELOPE_BYTES) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return decoder.decode(bytes);
}

// A fresh cursor with a small overlap recovers interrupted connections without gaps.
// De-duplication is based on the authenticated message ID, not the relay ID.
export function subscribe(topic, { onEvent, onStatus }, makeSocket = url => new WebSocket(url)) {
  let socket;
  let timer;
  let watchdog;
  let failures = 0;
  let closed = false;
  let lastTime = 0;
  function connect() {
    if (closed) return;
    clearTimeout(timer);
    clearTimeout(watchdog);
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      onStatus('offline');
      timer = setTimeout(connect, 15000);
      return;
    }
    onStatus(failures ? 'reconnecting' : 'connecting');
    const since = lastTime ? Math.max(0, lastTime - 5) : 'all';
    socket = makeSocket(`wss://ntfy.sh/${topic}/ws?since=${since}`);
    const active = socket;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { if (active === socket) active.close(); }, 65000);
    };
    arm();
    active.onmessage = event => {
      if (active !== socket || closed) return;
      arm();
      try {
        const value = JSON.parse(event.data);
        if (value.event === 'open' || value.event === 'keepalive') {
          failures = 0;
          onStatus('connected');
        }
        if (value.event === 'message') {
          if (Number.isFinite(value.time)) lastTime = Math.max(lastTime, Math.min(value.time, Math.floor(Date.now() / 1000)));
          onEvent(value);
        }
      } catch { /* Ignore malformed relay events. */ }
    };
    active.onerror = () => active.close();
    active.onclose = () => {
      if (active !== socket || closed) return;
      clearTimeout(watchdog);
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
      clearTimeout(timer);
      clearTimeout(watchdog);
      socket?.close();
    },
  };
}
