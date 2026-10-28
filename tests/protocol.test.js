import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TEXT_BYTES, MAX_ENVELOPE_BYTES,
  toBase64, fromBase64, newSecret, isRoomSecret, createRoom,
  validateMessage, encryptMessage, decryptMessage, publishEnvelope,
  envelopeFromEvent, RelayError, subscribe, loadHistory,
} from '../protocol.js';
import { API_ORIGIN } from '../config.js';

const encoder = new TextEncoder();
const message = (text, extra = {}) => ({
  v: 1, id: crypto.randomUUID(), device: crypto.randomUUID(),
  text, created: Date.now(), ...extra,
});
const topic = 'pasa_' + 'a'.repeat(56);
const event = (seq = 1, text = 'ciphertext') => ({
  event: 'message', id: String(seq), seq,
  time: 1700000000, message: text,
});
const ack = (seq = 1) => new Response(JSON.stringify(event(seq)), { status: 200 });
const page = (extra = {}) => ({ messages: [event(2), event(1)], latestSeq: 2, hasMore: false, nextBefore: 1, ...extra });

async function sealRaw(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode('pasa/v1/0'),
  }, key, encoder.encode(JSON.stringify(payload)));
  return JSON.stringify({ v: 1, zip: 0, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) });
}

function randomUnicodeText(byteLimit, includeEscapes = false) {
  // Seeded randomness makes full-limit failures reproducible.
  const alphabet = ['a', 'Z', '🙂', '漢', 'é', '𐐷', 'क', '∑', 'Ω', '中'];
  if (includeEscapes) alphabet.push('\n', '\t', '\\', '"', '\u0000', '\u0001');
  const pieces = [];
  let seed = 0x29a1b27;
  let bytes = 0;
  while (bytes < byteLimit) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const char = alphabet[(seed >>> 0) % alphabet.length];
    const size = encoder.encode(char).length;
    if (bytes + size > byteLimit) break;
    pieces.push(char); bytes += size;
  }
  return pieces.join('') + 'x'.repeat(byteLimit - bytes);
}

test('generates distinct canonical 256-bit URL-safe room secrets', async () => {
  const secrets = Array.from({ length: 20 }, newSecret);
  assert.equal(new Set(secrets).size, secrets.length);
  for (const secret of secrets) {
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(isRoomSecret(secret));
    assert.equal(fromBase64(secret).length, 32);
    assert.equal(toBase64(fromBase64(secret)), secret);
  }
  for (const value of ['', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '=', 'a'.repeat(42) + '!', null]) {
    assert.equal(isRoomSecret(value), false);
    await assert.rejects(createRoom(value));
  }
  const canonical = secrets[0];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lastIndex = alphabet.indexOf(canonical.at(-1));
  assert.equal(isRoomSecret(canonical.slice(0, -1) + alphabet[lastIndex + 1]), false, 'noncanonical unused bits are rejected');
});

test('derives stable secret-specific topics without exposing the key', async () => {
  const secret = newSecret();
  const first = await createRoom(secret);
  const second = await createRoom(secret);
  const other = await createRoom(newSecret());
  assert.equal(first.topic, second.topic);
  assert.notEqual(first.topic, other.topic);
  assert.match(first.topic, /^pasa_[a-f\d]{56}$/);
  assert.ok(first.topic.length <= 64);
  assert.equal(first.key.extractable, false);
  const original = message('Hola, áéíóú 🙂\nSegunda línea\thttps://example.org?q=niño\n');
  assert.deepEqual(await decryptMessage(second.key, await encryptMessage(first.key, original)), original);
});

test('encrypts short messages without plaintext leakage and uses fresh IVs', async () => {
  const { key } = await createRoom(newSecret());
  const original = message('Texto privado único con ñ y 🦊\nhttps://example.com');
  const a = await encryptMessage(key, original);
  const b = await encryptMessage(key, original);
  assert.equal(JSON.parse(a).zip, 0);
  assert.notEqual(a, b);
  assert.notEqual(JSON.parse(a).iv, JSON.parse(b).iv);
  assert.ok(!a.includes(original.text));
  assert.deepEqual(await decryptMessage(key, a), original);
});

test('compresses and round-trips long Unicode paragraphs', async () => {
  const { key } = await createRoom(newSecret());
  const original = message('Línea extensa de prueba: español, 日本語 y cohete 🚀.\n'.repeat(900));
  const envelope = await encryptMessage(key, original);
  assert.equal(JSON.parse(envelope).zip, 1);
  assert.ok(envelope.length < encoder.encode(original.text).length);
  assert.deepEqual(await decryptMessage(key, envelope), original);
});

test('round-trips exactly 128 KiB of random multibyte Unicode', async () => {
  const { key } = await createRoom(newSecret());
  const original = message(randomUnicodeText(MAX_TEXT_BYTES));
  assert.equal(encoder.encode(original.text).length, MAX_TEXT_BYTES);
  const envelope = await encryptMessage(key, original);
  assert.ok(encoder.encode(envelope).length <= MAX_ENVELOPE_BYTES);
  assert.deepEqual(await decryptMessage(key, envelope), original);
});

test('round-trips full-limit Unicode containing JSON-escaped text and control characters', async () => {
  const { key } = await createRoom(newSecret());
  const original = message(randomUnicodeText(MAX_TEXT_BYTES, true));
  assert.equal(encoder.encode(original.text).length, MAX_TEXT_BYTES);
  validateMessage(original);
  const envelope = await encryptMessage(key, original);
  assert.ok(encoder.encode(envelope).length <= MAX_ENVELOPE_BYTES);
  assert.deepEqual(await decryptMessage(key, envelope), original);
});

test('round-trips JSON expansion regressions for long backslashes and full-limit control characters', async () => {
  const { key } = await createRoom(newSecret());
  for (const text of ['\\'.repeat(100_000), '\u0001'.repeat(MAX_TEXT_BYTES)]) {
    const original = message(text);
    const envelope = await encryptMessage(key, original);
    assert.equal(JSON.parse(envelope).zip, 1);
    assert.deepEqual(await decryptMessage(key, envelope), original);
  }
});

test('preserves full-limit escaped text when CompressionStream is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');
  Object.defineProperty(globalThis, 'CompressionStream', { value: undefined, configurable: true });
  try {
    const { key } = await createRoom(newSecret());
    for (const text of ['\\'.repeat(100_000), '\u0001'.repeat(MAX_TEXT_BYTES), randomUnicodeText(MAX_TEXT_BYTES, true)]) {
      const original = message(text);
      const envelope = await encryptMessage(key, original);
      assert.equal(JSON.parse(envelope).zip, 0);
      assert.ok(encoder.encode(envelope).length <= MAX_ENVELOPE_BYTES);
      assert.deepEqual(await decryptMessage(key, envelope), original);
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'CompressionStream', descriptor);
    else delete globalThis.CompressionStream;
  }
});

test('authenticates the ciphertext, room key, and compression flag', async () => {
  const room = await createRoom(newSecret());
  const other = await createRoom(newSecret());
  const envelope = await encryptMessage(room.key, message('Mensaje autenticado'));
  await assert.rejects(decryptMessage(other.key, envelope));
  const box = JSON.parse(envelope);
  const tampered = { ...box, data: (box.data[0] === 'A' ? 'B' : 'A') + box.data.slice(1) };
  await assert.rejects(decryptMessage(room.key, JSON.stringify(tampered)));
  await assert.rejects(decryptMessage(room.key, JSON.stringify({ ...box, zip: 1 })));
  await assert.rejects(decryptMessage(room.key, JSON.stringify({ ...box, iv: 'A'.repeat(15) })));
  await assert.rejects(decryptMessage(room.key, 'x'.repeat(MAX_ENVELOPE_BYTES + 1)));
});

test('enforces UTF-8 text byte limits, meaningful content, identifiers and timestamps', async () => {
  const { key } = await createRoom(newSecret());
  assert.equal(encoder.encode('🙂'.repeat(MAX_TEXT_BYTES / 4)).length, MAX_TEXT_BYTES);
  validateMessage(message('🙂'.repeat(MAX_TEXT_BYTES / 4)));
  const invalid = [
    message('🙂'.repeat(MAX_TEXT_BYTES / 4) + 'a'), message(' '.repeat(10)),
    message('ok', { id: '../invalid' }), message('ok', { device: 'short' }),
    message('ok', { created: Date.now() + 6 * 60_000 }),
    message('ok', { created: -1 }), message('ok', { created: Number.NaN }),
    message('ok', { v: 2 }), message(42),
  ];
  for (const payload of invalid) {
    assert.throws(() => validateMessage(payload));
    await assert.rejects(encryptMessage(key, payload));
  }
  const future = message('Autenticado pero con fecha inválida', { created: Date.now() + 60 * 60_000 });
  await assert.rejects(decryptMessage(key, await sealRaw(key, future)), /Mensaje inválido/);
});

test('accepts old authenticated messages without a history expiration policy', async () => {
  const room = await createRoom(newSecret());
  const original = message('Historial persistente', { created: Date.now() - 365 * 24 * 3600_000 });
  assert.deepEqual(await decryptMessage(room.key, await encryptMessage(room.key, original)), original);
});

test('extracts only bounded authenticated-protocol event envelopes without external downloads', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: () => assert.fail('Envelope extraction must never fetch external files'), configurable: true });
  try {
    assert.equal(await envelopeFromEvent(event(1)), 'ciphertext');
    assert.equal(await envelopeFromEvent(event(2, 'a'.repeat(MAX_ENVELOPE_BYTES))), 'a'.repeat(MAX_ENVELOPE_BYTES));
    const invalid = [null, { event: 'open', latestSeq: 1 }, { event: 'message', message: 'old relay shape' },
      event(0), event(-1), event(1.5), { ...event(1), id: 'different' },
      { ...event(1), message: 12 }, event(1, 'a'.repeat(MAX_ENVELOPE_BYTES + 1)),
      { event: 'message', attachment: { url: 'https://untrusted.example/private' } },
    ];
    for (const value of invalid) assert.equal(await envelopeFromEvent(value), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
    else delete globalThis.fetch;
  }
});

test('rejects invalid room identifiers before initiating any transport request', async () => {
  const noFetch = () => assert.fail('Invalid room must not contact a backend');
  for (const invalid of ['', 'pasa_test', '../room', 'pasa_' + 'a'.repeat(55), 'pasa_' + 'A'.repeat(56), null]) {
    await assert.rejects(publishEnvelope(invalid, 'ciphertext', noFetch), /enlace/);
    await assert.rejects(loadHistory(invalid, {}, noFetch), /enlace/);
    let invalidConnection;
    try {
      assert.throws(() => { invalidConnection = subscribe(invalid, { onEvent() {}, onStatus() {} }, noFetch); }, /enlace/);
    } finally { invalidConnection?.close(); }
  }
});

test('publishes each ciphertext directly to the owned API without attachments or cookies', async () => {
  const calls = [];
  const payload = 'a'.repeat(20000);
  const result = await publishEnvelope(topic, payload, async (url, options) => {
    calls.push({ url, options });
    return ack(7);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result, event(7));
  assert.equal(calls[0].url, `${API_ORIGIN}/api/rooms/${topic}/messages`);
  const { options } = calls[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.body, payload);
  assert.deepEqual(options.headers, { 'Content-Type': 'text/plain' });
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  const noFetch = () => assert.fail('Oversized or invalid envelope must not be published');
  await assert.rejects(publishEnvelope(topic, 'a'.repeat(MAX_ENVELOPE_BYTES + 1), noFetch), /grande/);
  await assert.rejects(publishEnvelope(topic, {}, noFetch), /grande/);
});

test('validates publish acknowledgements and normalizes transport and JSON failures', async () => {
  const retryable = error => error instanceof RelayError && error.name === 'RelayError' && error.retryable === true;
  for (const invalid of [{ event: 'open' }, { ...event(1), id: 'wrong' }, event(0), { ...event(1), seq: '1' }]) {
    await assert.rejects(publishEnvelope(topic, 'ciphertext', async () => new Response(JSON.stringify(invalid))), retryable);
  }
  await assert.rejects(publishEnvelope(topic, 'ciphertext', async () => { throw new TypeError('network down'); }), retryable);
  await assert.rejects(publishEnvelope(topic, 'ciphertext', async () => new Response('<html>bad proxy</html>')), retryable);
  await assert.rejects(publishEnvelope(topic, 'ciphertext', async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('stream interrupted')); },
  }))), retryable);
  await assert.rejects(publishEnvelope(topic, 'ciphertext', async () => new Response(null)), retryable);
});

test('exposes useful backend status codes without introducing a daily app quota', async () => {
  for (const [status, retryable] of [[400, false], [404, false], [413, false], [429, true], [500, true], [503, true]]) {
    await assert.rejects(publishEnvelope(topic, 'ciphertext', async () => new Response('', { status })), error => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      if (status === 404) assert.match(error.message, /enlace privado completo/);
      if (status === 429) assert.ok(!/250|día|diario/.test(error.message));
      return true;
    });
  }
});

test('loads bounded history pages and preserves both pagination directions', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const after = new URL(url).searchParams.has('after');
    return new Response(JSON.stringify(after
      ? page({ messages: [event(3), event(4)], latestSeq: 8, nextAfter: 4, hasMore: true })
      : page({ nextBefore: 1, hasMore: true })));
  };
  assert.deepEqual((await loadHistory(topic, {}, fetcher)).messages.map(value => value.seq), [2, 1]);
  const older = await loadHistory(topic, { before: 20, limit: 12 }, fetcher);
  assert.equal(older.nextBefore, 1);
  const newer = await loadHistory(topic, { after: 2, limit: 50 }, fetcher);
  assert.deepEqual(newer.messages.map(value => value.seq), [3, 4]);
  assert.equal(newer.nextAfter, 4);
  assert.equal(newer.hasMore, true);
  assert.equal(calls[0].url.origin, new URL(API_ORIGIN).origin);
  assert.equal(calls[0].url.pathname, `/api/rooms/${topic}/messages`);
  assert.equal(calls[0].url.searchParams.get('limit'), '30');
  assert.equal(calls[1].url.searchParams.get('before'), '20');
  assert.equal(calls[1].url.searchParams.get('limit'), '12');
  assert.equal(calls[2].url.searchParams.get('after'), '2');
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
  }
  const limits = [];
  for (const limit of [999, -8, 0, 4.9, Number.NaN]) {
    await loadHistory(topic, { limit }, async url => {
      limits.push(new URL(url).searchParams.get('limit'));
      return new Response(JSON.stringify(page()));
    });
  }
  assert.deepEqual(limits, ['50', '1', '30', '4', '30']);
});

test('rejects invalid history cursors before fetching and invalid response structures afterwards', async () => {
  const noFetch = () => assert.fail('Invalid pagination must not initiate a fetch');
  for (const args of [{ before: 0 }, { before: -1 }, { before: 1.5 }, { before: '3' },
    { after: -1 }, { after: 2.5 }, { after: '3' }, { after: Infinity }, { before: 3, after: 1 }]) {
    await assert.rejects(loadHistory(topic, args, noFetch), /Cursor/);
  }
  assert.deepEqual((await loadHistory(topic, { after: 0 }, async () => new Response(JSON.stringify(page())))).messages, page().messages);
  const invalid = [
    null, {}, page({ messages: {} }), page({ messages: Array.from({ length: 51 }, () => event(1)) }),
    page({ messages: [event(0)] }), page({ messages: [{ ...event(1), id: 'mismatch' }] }),
    page({ hasMore: 'yes' }), page({ latestSeq: -1 }), page({ latestSeq: 2.5 }),
  ];
  for (const response of invalid) {
    await assert.rejects(loadHistory(topic, {}, async () => new Response(JSON.stringify(response))), error => error instanceof RelayError && error.retryable);
  }
});

test('bounds total streamed history response bytes even when a server reports a small content length', async () => {
  let cancelled = false;
  const oversized = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1).fill(32)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(loadHistory(topic, {}, async () => new Response(oversized, { headers: { 'Content-Length': '1' } })), error => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /demasiado grande/);
    return true;
  });
  assert.equal(cancelled, true);
});

test('uses an owned WebSocket, sync checkpoints, hibernation heartbeat and bounded reconnect lifecycle', () => {
  const originals = Object.fromEntries(['navigator', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const timers = new Map();
  let nextTimer = 1;
  for (const [name, value] of Object.entries({
    navigator: { onLine: true },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms, type: 'timeout' }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms, type: 'interval' }); return id; },
    clearInterval: id => timers.delete(id),
  })) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const sockets = [];
  const statuses = [];
  const events = [];
  const checkpoints = [];
  let connection;
  const makeSocket = url => {
    const socket = { url, readyState: 1, sent: [], send(text) { this.sent.push(text); }, close() { this.closed = true; this.readyState = 3; this.onclose?.(); } };
    sockets.push(socket);
    return socket;
  };
  try {
    connection = subscribe(topic, { onEvent: value => events.push(value), onStatus: value => statuses.push(value), onSync: value => checkpoints.push(value) }, makeSocket);
    assert.equal(sockets[0].url, `${API_ORIGIN.replace(/^http/, 'ws')}/api/rooms/${topic}/ws`);
    assert.deepEqual(statuses, ['connecting']);
    sockets[0].onopen();
    const heartbeat = [...timers.values()].find(value => value.type === 'interval');
    assert.equal(heartbeat.ms, 25000);
    heartbeat.fn();
    assert.deepEqual(sockets[0].sent, ['ping']);
    sockets[0].onmessage({ data: 'pong' });
    sockets[0].onmessage({ data: 'malformed JSON' });
    sockets[0].onmessage({ data: JSON.stringify({ event: 'open' }) });
    assert.deepEqual(checkpoints, []);
    sockets[0].onmessage({ data: JSON.stringify({ event: 'open', latestSeq: 80 }) });
    assert.deepEqual(checkpoints, [80]);
    assert.equal(statuses.at(-1), 'connected');
    sockets[0].onmessage({ data: JSON.stringify(event(81)) });
    sockets[0].onmessage({ data: JSON.stringify({ ...event(82), id: 'invalid' }) });
    assert.deepEqual(events.map(value => value.seq), [81]);
    const staleMessage = sockets[0].onmessage;
    const staleOpen = sockets[0].onopen;
    connection.reconnect();
    assert.equal(sockets[0].closed, true);
    assert.equal(sockets.length, 2);
    staleMessage({ data: JSON.stringify(event(83)) });
    staleOpen();
    assert.deepEqual(events.map(value => value.seq), [81]);
    assert.ok(![...timers.values()].some(value => value.type === 'interval'), 'old connection heartbeat must be cleared');
    sockets[1].onopen();
    sockets[1].onmessage({ data: JSON.stringify({ event: 'open', latestSeq: 100 }) });
    assert.deepEqual(checkpoints, [80, 100]);
    const watchdog = [...timers.entries()].find(([, value]) => value.type === 'timeout' && value.ms === 70000);
    timers.delete(watchdog[0]); watchdog[1].fn();
    assert.equal(sockets[1].closed, true);
    assert.equal(statuses.at(-1), 'reconnecting');
    const reconnect = [...timers.entries()].find(([, value]) => value.type === 'timeout');
    assert.ok(reconnect[1].ms >= 2000 && reconnect[1].ms <= 3500);
    timers.delete(reconnect[0]); reconnect[1].fn();
    assert.equal(sockets.length, 3);
    sockets[2].onopen();
    connection.close();
    assert.equal(sockets[2].closed, true);
    assert.equal(timers.size, 0, 'all timers must be cleaned up');
    connection.reconnect();
    assert.equal(sockets.length, 3, 'closed subscription cannot be reopened');
  } finally {
    connection?.close();
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
