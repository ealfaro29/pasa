import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELAY, MAX_TEXT_BYTES, MAX_ENVELOPE_BYTES, INLINE_BYTES,
  toBase64, fromBase64, newSecret, isRoomSecret, createRoom,
  validateMessage, encryptMessage, decryptMessage, publishEnvelope,
  envelopeFromEvent, RelayError, subscribe,
} from '../protocol.js';

const encoder = new TextEncoder();
const message = (text, extra = {}) => ({
  v: 1, id: crypto.randomUUID(), device: crypto.randomUUID(),
  text, created: Date.now(), ...extra,
});
const ack = () => new Response(JSON.stringify({ event: 'message', id: 'relayMessage01' }), { status: 200 });
const attachmentEvent = (extra = {}) => ({
  event: 'message', message: 'You received a file',
  attachment: { name: 'pasa.enc', size: 20, expires: Math.floor(Date.now() / 1000) + 3600,
    url: `${RELAY}/file/message_01.txt`, ...extra },
});

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

test('returns only inline message events within the inline size boundary', async () => {
  const noFetch = () => assert.fail('Inline content must not trigger a fetch');
  assert.equal(await envelopeFromEvent({ event: 'open', message: 'ignored' }, noFetch), null);
  assert.equal(await envelopeFromEvent(null, noFetch), null);
  assert.equal(await envelopeFromEvent({ event: 'message', message: 'abc' }, noFetch), 'abc');
  assert.equal(await envelopeFromEvent({ event: 'message', message: 'a'.repeat(INLINE_BYTES) }, noFetch), 'a'.repeat(INLINE_BYTES));
  assert.equal(await envelopeFromEvent({ event: 'message', message: 'a'.repeat(INLINE_BYTES + 1) }, noFetch), null);
});

test('accepts bounded encrypted attachments from the relay with privacy-preserving fetch options', async () => {
  const envelope = '{"v":1,"iv":"test"}';
  let request;
  const result = await envelopeFromEvent(attachmentEvent({ size: envelope.length }), async (url, options) => {
    request = { url, options };
    return new Response(envelope, { headers: { 'Content-Length': String(envelope.length) } });
  });
  assert.equal(result, envelope);
  assert.equal(request.url, `${RELAY}/file/message_01.txt`);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.ok(request.options.signal instanceof AbortSignal);
});

test('rejects untrusted attachment URLs and impossible sizes before making a request', async () => {
  const noFetch = () => assert.fail('Untrusted metadata must never initiate a request');
  const invalid = [
    { url: 'http://ntfy.sh/file/message.txt' },
    { url: 'https://evil.example/file/message.txt' },
    { url: 'https://ntfy.sh.evil.example/file/message.txt' },
    { url: 'https://ntfy.sh:444/file/message.txt' },
    { url: 'https://user:secret@ntfy.sh/file/message.txt' },
    { url: 'https://ntfy.sh/file/message.txt?redirect=evil' },
    { url: 'https://ntfy.sh/v1/account' },
    { url: 'https://ntfy.sh/file/../account' },
    { url: 'https://ntfy.sh/file/message%2fother' },
    { name: 'different.txt' }, { size: 0 }, { size: -1 },
    { size: Number.NaN }, { size: Infinity }, { size: MAX_ENVELOPE_BYTES + 1 },
  ];
  for (const metadata of invalid) assert.equal(await envelopeFromEvent(attachmentEvent(metadata), noFetch), null);
});

test('reports attachment expiration without downloading stale ciphertext', async () => {
  const noFetch = () => assert.fail('Expired metadata must never initiate a request');
  await assert.rejects(envelopeFromEvent(attachmentEvent({ expires: Math.floor(Date.now() / 1000) - 1 }), noFetch), error => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.retryable, false);
    assert.match(error.message, /expiró/);
    return true;
  });
  await assert.rejects(envelopeFromEvent(attachmentEvent(), async () => new Response('', { status: 404 })), /expiró/);
});

test('bounds actual streamed attachment bytes even when the server understates its size', async () => {
  const oversized = new Uint8Array(MAX_ENVELOPE_BYTES + 1).fill(97);
  assert.equal(await envelopeFromEvent(attachmentEvent(), async () => new Response(oversized, { headers: { 'Content-Length': '1' } })), null);
  assert.equal(await envelopeFromEvent(attachmentEvent(), async () => new Response('small', { headers: { 'Content-Length': String(MAX_ENVELOPE_BYTES + 1) } })), null);
});

test('normalizes failed attachment fetches and interrupted streams as retryable RelayErrors', async () => {
  const retryableRelayError = error => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.name, 'RelayError');
    assert.equal(error.retryable, true);
    return true;
  };
  await assert.rejects(envelopeFromEvent(attachmentEvent(), async () => {
    throw new TypeError('Failed to fetch');
  }), retryableRelayError);
  await assert.rejects(envelopeFromEvent(attachmentEvent(), async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"partial":'));
      controller.error(new TypeError('Connection interrupted'));
    },
  }))), retryableRelayError);
});

test('publishes at the inline byte threshold and uses one attachment above it', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return ack(); };
  const inline = 'a'.repeat(INLINE_BYTES);
  await publishEnvelope('pasa_test', inline, fetcher);
  await publishEnvelope('pasa_test', inline + 'b', fetcher);
  await publishEnvelope('pasa_test', '🙂'.repeat(INLINE_BYTES / 4 + 1), fetcher);
  assert.equal(calls.length, 3, 'one relay publish per clipboard item');
  assert.equal(calls[0].url, `${RELAY}/pasa_test`);
  assert.equal(calls[0].options.body, inline);
  assert.equal(calls[0].options.headers.Filename, undefined);
  assert.equal(calls[1].options.headers.Filename, 'pasa.enc');
  assert.equal(calls[2].options.headers.Filename, 'pasa.enc', 'threshold uses UTF-8 bytes');
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('distinguishes rate limits, temporary failures, rejected content, and invalid acknowledgements', async () => {
  await assert.rejects(publishEnvelope('topic', 'text', async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } })), error => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.retryable, false);
    assert.equal(error.retryAfter, 120_000);
    return true;
  });
  for (const [status, retryable] of [[400, false], [503, true]]) {
    await assert.rejects(publishEnvelope('topic', 'text', async () => new Response('', { status })), error => error instanceof RelayError && error.retryable === retryable);
  }
  await assert.rejects(publishEnvelope('topic', 'text', async () => { throw new Error('network down'); }), error => error instanceof RelayError && error.retryable);
  await assert.rejects(publishEnvelope('topic', 'text', async () => new Response('{"event":"open"}')), error => error instanceof RelayError && error.retryable);
});

test('normalizes a malformed successful publish acknowledgement as a retryable RelayError', async () => {
  await assert.rejects(publishEnvelope('topic', 'text', async () => new Response('<html>temporary proxy error</html>', { status: 200 })), error => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.name, 'RelayError');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('reconnects with an overlap cursor and ignores malformed or stale socket events', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  const sockets = [];
  const statuses = [];
  const events = [];
  let connection;
  try {
    connection = subscribe('pasa_test', { onEvent: value => events.push(value), onStatus: value => statuses.push(value) }, url => {
      const socket = { url, close() { this.closed = true; this.onclose?.(); } };
      sockets.push(socket);
      return socket;
    });
    assert.match(sockets[0].url, /since=all$/);
    sockets[0].onmessage({ data: 'bad JSON' });
    sockets[0].onmessage({ data: JSON.stringify({ event: 'open' }) });
    const current = Math.floor(Date.now() / 1000);
    sockets[0].onmessage({ data: JSON.stringify({ event: 'message', time: current - 20, id: 'first' }) });
    sockets[0].onmessage({ data: JSON.stringify({ event: 'message', time: current - 30, id: 'out-of-order' }) });
    const staleHandler = sockets[0].onmessage;
    connection.reconnect();
    assert.equal(sockets[0].closed, true);
    assert.ok(sockets[1].url.endsWith(`since=${current - 25}`), 'out-of-order event must not move cursor backward');
    staleHandler({ data: JSON.stringify({ event: 'message', time: current, id: 'stale' }) });
    assert.equal(events.length, 2);
    assert.ok(statuses.includes('connected'));
    sockets[1].onmessage({ data: JSON.stringify({ event: 'message', time: current + 24 * 3600, id: 'future-relay' }) });
    connection.reconnect();
    assert.ok(Number(new URL(sockets[2].url).searchParams.get('since')) <= Math.floor(Date.now() / 1000), 'untrusted relay timestamp must not strand the cursor in the future');
    connection.close();
    assert.equal(sockets[2].closed, true);
    const count = sockets.length;
    connection.reconnect();
    assert.equal(sockets.length, count);
  } finally {
    connection?.close();
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});
