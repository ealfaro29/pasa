import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { PasaRoom, MAX_ENVELOPE_BYTES, MAX_PAGE_BYTES, MAX_FILE_BYTES, MAX_LEGACY_FILE_BYTES, FILE_PART_BYTES } from '../backend/worker.js';

const ROOM = 'pasa_' + 'a'.repeat(56);
const OTHER_ROOM = 'pasa_' + 'b'.repeat(56);
const ORIGIN = 'https://ealfaro29.github.io';
const envelope = (data = 'A'.repeat(64)) => JSON.stringify({ v: 1, zip: 0, iv: 'A'.repeat(16), data });
const FILE_ID = '12345678-abcd-4abc-8def-1234567890ab';

function context(db = new DatabaseSync(':memory:')) {
  const sent = [];
  let synced = 0;
  let alarm = null;
  const sockets = [{ send(value) { assert.ok(synced > 0, 'broadcast must follow durable sync'); sent.push(JSON.parse(value)); }, close() {} }];
  const ctx = {
    storage: {
      sql: {
        exec(query, ...bindings) {
          const statement = db.prepare(query);
          const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
          let index = 0;
          return {
            [Symbol.iterator]() { return this; },
            next() { return index < rows.length ? { value: rows[index++], done: false } : { done: true }; },
            toArray() { const result = rows.slice(index); index = rows.length; return result; },
            one() { const result = this.toArray(); assert.equal(result.length, 1); return result[0]; },
          };
        },
      },
      transactionSync(callback) {
        db.exec('BEGIN');
        try { const result = callback(); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      async sync() { synced++; },
      async getAlarm() { return alarm; },
      async setAlarm(value) { alarm = value; },
      async deleteAlarm() { alarm = null; },
    },
    getWebSockets() { return sockets; },
    acceptWebSocket(socket) { sockets.push(socket); },
    setWebSocketAutoResponse() {},
  };
  return { ctx, db, sent, sockets };
}

function setup() {
  const mock = context();
  const env = { ROOM_IDS: ROOM };
  const room = new PasaRoom(mock.ctx, env);
  let routed = 0;
  env.ROOMS = { idFromName(name) { assert.equal(name, ROOM); return name; }, get() { routed++; return room; } };
  return { ...mock, env, room, routed: () => routed };
}

function request(path = 'messages', options = {}) {
  return new Request(`https://pasa-api.example/api/rooms/${ROOM}/${path}`, { ...options, headers: { Origin: ORIGIN, ...options.headers } });
}

function post(body = envelope(), options = {}) {
  return request('messages', { method: 'POST', body, ...options });
}

function upload(bytes = new Uint8Array(40), metadata = envelope(), id = FILE_ID) {
  const form = new FormData();
  form.set('envelope', metadata);
  form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), 'encrypted.bin');
  return request(`files/${id}`, { method: 'POST', body: form });
}

test('health identifies the own backend without revealing room configuration', async () => {
  const env = { ROOM_IDS: ROOM };
  const response = await worker.fetch(new Request('https://pasa-api.example/health', { headers: { Origin: ORIGIN } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', version: 'pasa-own-v3.3' });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('room allowlist fails closed before routing and cannot create arbitrary storage', async t => {
  const app = setup(); t.after(() => app.db.close());
  for (const room of [OTHER_ROOM, 'anything', ROOM.toUpperCase(), `${ROOM}%2Fmessages`]) {
    const response = await worker.fetch(new Request(`https://pasa-api.example/api/rooms/${room}/messages`), app.env);
    assert.equal(response.status, 404);
  }
  for (const ROOM_IDS of [undefined, '', `${ROOM},bad-value`]) {
    const response = await worker.fetch(request(), { ...app.env, ROOM_IDS });
    assert.equal(response.status, 404);
  }
  assert.equal(app.routed(), 0);
});

test('CORS permits only the exact app and local development origins', async t => {
  const app = setup(); t.after(() => app.db.close());
  for (const origin of [ORIGIN, 'http://localhost:4173', 'http://127.0.0.1:4173']) {
    const response = await worker.fetch(request('messages', { headers: { Origin: origin } }), app.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  }
  const before = app.routed();
  for (const Origin of ['https://evil.example', 'null', 'https://ealfaro29.github.io.evil.example', 'http://localhost:80']) {
    const response = await worker.fetch(post(envelope(), { headers: { Origin } }), app.env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(app.routed(), before);
});

test('preflight and unsupported methods are rejected before durable-object routing', async t => {
  const app = setup(); t.after(() => app.db.close());
  const response = await worker.fetch(request('messages', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } }), app.env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
  assert.equal(app.routed(), 0);
  for (const options of [
    { method: 'DELETE' },
    { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } },
    { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'Authorization' } },
  ]) assert.ok((await worker.fetch(request('messages', options), app.env)).status >= 400);
  assert.equal(app.routed(), 0);
});

test('preview routes enforce room access, bounded input and signed images before any page fetch', async t => {
  const app = setup(); t.after(() => app.db.close());
  const unknown = new Request(`https://pasa-api.example/api/rooms/${OTHER_ROOM}/preview`, {
    method: 'POST', body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal((await worker.fetch(unknown, app.env)).status, 404);
  assert.equal((await worker.fetch(request('preview'), app.env)).status, 405);
  assert.equal((await worker.fetch(request('image'), app.env)).status, 400);
  assert.equal((await worker.fetch(request('preview', { method: 'POST', body: 'x'.repeat(9000) }), app.env)).status, 413);
  for (const url of ['https://127.0.0.1/admin', 'https://localhost/', 'https://example.com/?token=private']) {
    const response = await worker.fetch(request('preview', { method: 'POST', body: JSON.stringify({ url }) }), app.env);
    assert.equal(response.status, 400);
  }
  assert.equal(app.routed(), 0, 'public metadata never enters the encrypted history store');
});

test('publish stores encrypted envelopes durably, broadcasts once and deduplicates retries', async t => {
  const app = setup(); t.after(() => app.db.close());
  const body = envelope();
  const first = await app.room.fetch(post(body));
  assert.equal(first.status, 200);
  const event = await first.json();
  assert.deepEqual(event, { event: 'message', id: '1', seq: 1, time: event.time, message: body });
  assert.equal(app.sent.length, 1);
  assert.deepEqual(app.sent[0], event);
  const duplicate = await app.room.fetch(post(body));
  assert.deepEqual(await duplicate.json(), event);
  assert.equal(app.sent.length, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('stored history survives Durable Object reconstruction without expiry', async t => {
  const app = setup(); t.after(() => app.db.close());
  const sent = await (await app.room.fetch(post())).json();
  app.db.prepare('UPDATE messages SET created = ?').run(Date.now() - 400 * 86400000);
  const restored = new PasaRoom(app.ctx, app.env);
  const response = await restored.fetch(request());
  const history = await response.json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].id, sent.id);
  assert.equal(history.messages[0].message, sent.message);
  assert.ok(history.messages[0].time < Date.now() / 1000 - 365 * 86400);
});

test('accepts more than 250 unique sends in one day and retains them weeks later', async t => {
  const app = setup(); t.after(() => app.db.close());
  let now = Date.UTC(2026, 9, 27, 12);
  const created = now;
  t.mock.method(Date, 'now', () => now);
  for (let index = 0; index < 260; index++) {
    const data = Buffer.from(String(index)).toString('base64url') + 'A'.repeat(64);
    const response = await app.room.fetch(post(envelope(data)));
    assert.equal(response.status, 200, `send ${index + 1} must be accepted`);
  }
  assert.equal(app.sent.length, 260);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 260);
  now += 90 * 86400000;
  const restored = new PasaRoom(app.ctx, app.env);
  const received = [];
  let after = 0;
  do {
    const page = await (await restored.fetch(request(`messages?after=${after}&limit=50`))).json();
    received.push(...page.messages);
    assert.equal(page.latestSeq, 260);
    assert.ok(page.messages.every(message => message.time === Math.floor(created / 1000)));
    after = page.nextAfter;
    if (!page.hasMore) break;
  } while (received.length <= 260);
  assert.deepEqual(received.map(message => message.seq), Array.from({ length: 260 }, (_, index) => index + 1));
});

test('history pages backward without gaps and gap catchup pages forward', async t => {
  const app = setup(); t.after(() => app.db.close());
  for (let index = 0; index < 7; index++) await app.room.fetch(post(envelope('A'.repeat(64 + index))));
  const latest = await (await app.room.fetch(request('messages?limit=3'))).json();
  assert.deepEqual(latest.messages.map(row => row.seq), [7, 6, 5]);
  assert.equal(latest.latestSeq, 7);
  assert.equal(latest.nextBefore, 5);
  assert.equal(latest.hasMore, true);
  const older = await (await app.room.fetch(request('messages?before=5&limit=3'))).json();
  assert.deepEqual(older.messages.map(row => row.seq), [4, 3, 2]);
  const oldest = await (await app.room.fetch(request('messages?before=2&limit=3'))).json();
  assert.deepEqual(oldest.messages.map(row => row.seq), [1]);
  assert.equal(oldest.nextBefore, null);
  assert.equal(oldest.hasMore, false);
  const after = await (await app.room.fetch(request('messages?after=2&limit=3'))).json();
  assert.deepEqual(after.messages.map(row => row.seq), [3, 4, 5]);
  assert.equal(after.nextAfter, 5);
  assert.equal(after.hasMore, true);
  const caughtUp = await (await app.room.fetch(request('messages?after=5'))).json();
  assert.deepEqual(caughtUp.messages.map(row => row.seq), [6, 7]);
  assert.equal(caughtUp.hasMore, false);
});

test('history cursor validation and maximum count prevent malformed database queries', async t => {
  const app = setup(); t.after(() => app.db.close());
  for (const query of ['before=-1', 'after=1.5', 'before=hello', 'before=1&after=0', 'limit=0', 'limit=Infinity', 'after=9007199254740992']) {
    const response = await app.room.fetch(request(`messages?${query}`));
    assert.equal(response.status, 400, query);
  }
  for (let index = 0; index < 55; index++) await app.room.fetch(post(envelope('A'.repeat(64 + index))));
  const history = await (await app.room.fetch(request('messages?limit=1000000'))).json();
  assert.equal(history.messages.length, 50);
  assert.equal(history.hasMore, true);
});

test('page packing bounds response bytes while preserving complete large envelopes', async t => {
  const app = setup(); t.after(() => app.db.close());
  const body = envelope('A'.repeat(MAX_ENVELOPE_BYTES - 100));
  for (const suffix of ['A', 'B', 'C']) await app.room.fetch(post(body.replace(/A"}$/, `${suffix}"}`)));
  const response = await app.room.fetch(request('messages?limit=50'));
  const text = await response.text();
  const page = JSON.parse(text);
  assert.equal(page.messages.length, 1);
  assert.ok(new TextEncoder().encode(text).length <= MAX_PAGE_BYTES);
  assert.equal(page.hasMore, true);
  const older = await (await app.room.fetch(request(`messages?before=${page.nextBefore}`))).json();
  assert.equal(older.messages.length, 1);
  assert.equal(older.messages[0].seq, page.messages[0].seq - 1);
});

test('invalid or oversized envelopes are refused without persisting or broadcasting', async t => {
  const app = setup(); t.after(() => app.db.close());
  for (const body of ['', 'plaintext', '{}', '[]', JSON.stringify({ v: 1, zip: 2, iv: 'A'.repeat(16), data: 'A'.repeat(64) }), envelope().replace('"data":', '"extra":1,"data":'), envelope().replace('A'.repeat(16), 'bad')]) {
    const response = await app.room.fetch(post(body));
    assert.equal(response.status, 400, body.slice(0, 50));
  }
  const early = await app.room.fetch(post(envelope(), { headers: { 'Content-Length': String(MAX_ENVELOPE_BYTES + 1) } }));
  assert.equal(early.status, 413);
  const wrongType = await app.room.fetch(post(envelope(), { headers: { 'Content-Type': 'text/html' } }));
  assert.equal(wrongType.status, 415);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(app.sent.length, 0);
});

test('streamed request size is bounded even without Content-Length', async t => {
  const app = setup(); t.after(() => app.db.close());
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(600000)); },
    cancel() { cancelled = true; },
  });
  const response = await app.room.fetch(post(stream, { duplex: 'half' }));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(app.sent.length, 0);
});

test('failed durable sync never broadcasts a commit or exposes storage errors', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.ctx.storage.sync = async () => { throw new Error('sensitive internal details'); };
  const response = await app.room.fetch(post());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Error temporal del servidor' });
  assert.equal(app.sent.length, 0);
});

test('WebSocket paths enforce origins and upgrade requirements before accepting sockets', async t => {
  const app = setup(); t.after(() => app.db.close());
  const denied = await app.room.fetch(request('ws', { headers: { Origin: 'https://evil.example', Upgrade: 'websocket' } }));
  assert.equal(denied.status, 403);
  const noUpgrade = await app.room.fetch(request('ws'));
  assert.equal(noUpgrade.status, 426);
  const posts = await worker.fetch(request('ws', { method: 'POST', body: envelope() }), app.env);
  assert.equal(posts.status, 405);
  assert.equal(app.routed(), 0);
});

test('WebSocket data channel only permits harmless pings and closes unsupported writes', t => {
  const app = setup(); t.after(() => app.db.close());
  const messages = [];
  const closes = [];
  const socket = { send(value) { messages.push(value); }, close(...args) { closes.push(args); } };
  app.room.webSocketMessage(socket, 'ping');
  assert.deepEqual(messages, ['pong']);
  app.room.webSocketMessage(socket, envelope());
  assert.equal(closes[0][0], 1008);
});

test('files store opaque bytes in bounded chunks, notify durably and survive reconstruction', async t => {
  const app = setup(); t.after(() => app.db.close());
  const bytes = Uint8Array.from({ length: 600000 }, (_, index) => index % 251);
  const metadata = envelope('B'.repeat(128));
  const response = await worker.fetch(upload(bytes, metadata), app.env);
  assert.equal(response.status, 200);
  const event = await response.json();
  assert.equal(event.message, metadata);
  assert.deepEqual(app.sent, [event]);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_chunks').get().n, 3);
  assert.ok(app.db.prepare('SELECT MAX(length(data)) AS n FROM file_chunks').get().n <= 256 * 1024);
  const restored = new PasaRoom(app.ctx, app.env);
  const download = await restored.fetch(request(`files/${FILE_ID}`));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(download.headers.get('Cache-Control'), 'no-store');
  assert.equal(download.headers.get('Content-Length'), String(bytes.length));
  assert.equal(download.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(download.headers.get('Content-Disposition'), 'attachment; filename="encrypted.bin"');
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert.equal((await (await restored.fetch(request())).json()).messages[0].message, metadata);
});

test('file upload retries are idempotent and conflicting data cannot replace a file', async t => {
  const app = setup(); t.after(() => app.db.close());
  const bytes = new Uint8Array(50).fill(7);
  const event = await (await app.room.fetch(upload(bytes))).json();
  assert.deepEqual(await (await app.room.fetch(upload(bytes))).json(), event);
  assert.equal(app.sent.length, 1);
  assert.equal((await app.room.fetch(upload(new Uint8Array(50).fill(8)))).status, 409);
  assert.equal((await app.room.fetch(upload(bytes, envelope('B'.repeat(64))))).status, 409);
  assert.equal((await app.room.fetch(upload(bytes, envelope(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))).status, 409);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
  assert.deepEqual(new Uint8Array(await (await app.room.fetch(request(`files/${FILE_ID}`))).arrayBuffer()), bytes);
});

test('file routes preserve room and origin access checks and reject malformed paths', async t => {
  const app = setup(); t.after(() => app.db.close());
  await worker.fetch(upload(), app.env);
  for (const path of [`files/not-a-uuid`, `files/${FILE_ID}/extra`, `messages/${FILE_ID}`, `archives/${FILE_ID}`]) {
    assert.equal((await worker.fetch(request(path), app.env)).status, 404);
  }
  const otherRoom = new Request(`https://pasa-api.example/api/rooms/${OTHER_ROOM}/files/${FILE_ID}`);
  assert.equal((await worker.fetch(otherRoom, app.env)).status, 404);
  assert.equal((await worker.fetch(request(`files/${FILE_ID}`, { headers: { Origin: 'https://evil.example' } }), app.env)).status, 403);
  assert.equal((await worker.fetch(request('files/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), app.env)).status, 404);
  assert.equal((await worker.fetch(request(`files/${FILE_ID}`, { method: 'DELETE' }), app.env)).status, 405);
  assert.equal((await worker.fetch(request('files', { method: 'POST', body: envelope() }), app.env)).status, 405);
});

test('file upload validates multipart structure, metadata, binary type and encryption overhead', async t => {
  const app = setup(); t.after(() => app.db.close());
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}`, { method: 'POST', body: 'plaintext' }))).status, 415);
  assert.equal((await app.room.fetch(upload(new Uint8Array(27)))).status, 400);
  assert.equal((await app.room.fetch(upload(new Uint8Array(28), 'not encrypted'))).status, 400);
  assert.equal((await app.room.fetch(upload(new Uint8Array(28), envelope('A'.repeat(16 * 1024))))).status, 413);
  const forms = [];
  const missing = new FormData(); missing.set('envelope', envelope()); forms.push([missing, 400]);
  const extra = new FormData(); extra.set('envelope', envelope()); extra.set('file', new Blob([new Uint8Array(28)], { type: 'application/octet-stream' })); extra.set('extra', 'no'); forms.push([extra, 400]);
  const duplicate = new FormData(); duplicate.append('envelope', envelope()); duplicate.append('envelope', envelope()); duplicate.set('file', new Blob([new Uint8Array(28)], { type: 'application/octet-stream' })); forms.push([duplicate, 400]);
  const wrongType = new FormData(); wrongType.set('envelope', envelope()); wrongType.set('file', new Blob([new Uint8Array(28)], { type: 'text/html' })); forms.push([wrongType, 415]);
  for (const [form, status] of forms) assert.equal((await app.room.fetch(request(`files/${FILE_ID}`, { method: 'POST', body: form }))).status, status);
  const malformed = request(`files/${FILE_ID}`, { method: 'POST', body: 'broken', headers: { 'Content-Type': 'multipart/form-data; boundary=x' } });
  assert.equal((await app.room.fetch(malformed)).status, 400);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.equal(app.sent.length, 0);
});

test('legacy file size bounds retain the exact 10MiB limit and cancel oversized streams', async t => {
  const app = setup(); t.after(() => app.db.close());
  assert.equal((await app.room.fetch(upload(new Uint8Array(MAX_LEGACY_FILE_BYTES + 28)))).status, 200);
  assert.equal((await app.room.fetch(upload(new Uint8Array(MAX_LEGACY_FILE_BYTES + 29), envelope('B'.repeat(64)), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))).status, 413);
  const declared = request(`files/${FILE_ID}`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(MAX_LEGACY_FILE_BYTES + 100000) } });
  assert.equal((await app.room.fetch(declared)).status, 413);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const streamed = request(`files/${FILE_ID}`, { method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'multipart/form-data; boundary=x' } });
  assert.equal((await app.room.fetch(streamed)).status, 413);
  assert.equal(cancelled, true);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
});

test('a failed chunk insert rolls back file manifest, bytes and history together', async t => {
  const app = setup(); t.after(() => app.db.close());
  const original = app.ctx.storage.sql.exec;
  app.ctx.storage.sql.exec = (query, ...args) => {
    if (query.startsWith('INSERT INTO file_chunks') && args[1] === 1) throw new Error('storage failure');
    return original(query, ...args);
  };
  const response = await app.room.fetch(upload(new Uint8Array(400000)));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Error temporal del servidor' });
  for (const table of ['messages', 'files', 'file_chunks']) assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(app.sent.length, 0);
});

test('failed file durability sync never broadcasts success', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.ctx.storage.sync = async () => { throw new Error('sensitive details'); };
  const response = await app.room.fetch(upload());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Error temporal del servidor' });
  assert.equal(app.sent.length, 0);
});

test('separate file and archive catalogs paginate through unrelated text history', async t => {
  const app = setup(); t.after(() => app.db.close());
  const fileEvents = [];
  const archiveEvents = [];
  for (let index = 0; index < 7; index++) {
    await app.room.fetch(post(envelope('T'.repeat(64 + index))));
    const id = `${String(index).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    fileEvents.push(await (await app.room.fetch(upload(new Uint8Array(28), envelope('F'.repeat(64 + index)), id))).json());
    archiveEvents.push(await (await app.room.fetch(request('archives', { method: 'POST', body: envelope('R'.repeat(64 + index)) }))).json());
  }
  for (const [route, events] of [['files', fileEvents], ['archives', archiveEvents]]) {
    const latest = await (await app.room.fetch(request(`${route}?limit=3`))).json();
    assert.deepEqual(latest.messages.map(row => row.seq), events.slice(-3).reverse().map(row => row.seq));
    assert.equal(latest.hasMore, true);
    const older = await (await app.room.fetch(request(`${route}?before=${latest.nextBefore}&limit=50`))).json();
    assert.deepEqual(older.messages.map(row => row.seq), events.slice(0, -3).reverse().map(row => row.seq));
    assert.equal(older.hasMore, false);
    const forward = await (await app.room.fetch(request(`${route}?after=${events[2].seq}&limit=50`))).json();
    assert.deepEqual(forward.messages.map(row => row.seq), events.slice(3).map(row => row.seq));
    assert.equal(forward.hasMore, false);
  }
  const before = app.sent.length;
  const archive = archiveEvents[0];
  assert.deepEqual(await (await app.room.fetch(request('archives', { method: 'POST', body: archive.message }))).json(), archive);
  assert.equal(app.sent.length, before);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM archive_messages').get().n, 7);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 21);
});

function fileBucket({ retain = true } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      assert.ok(value instanceof Uint8Array);
      assert.ok(value.byteLength <= FILE_PART_BYTES + 28);
      assert.match(options.sha256, /^[a-f0-9]{64}$/);
      const object = { size: value.byteLength, bytes: retain ? value.slice() : null };
      objects.set(key, object);
      return { key, size: object.size };
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { size: object.size, body: new Blob([object.bytes]).stream(), arrayBuffer() { assert.fail('backend downloads must stream object bodies'); } };
    },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    async list({ prefix, limit = 1000 }) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      return { objects: keys.slice(0, limit).map(key => ({ key })), truncated: false };
    },
  };
}

function startFile({ id = FILE_ID, parts = 1, bytes = 28, metadata = envelope() } = {}) {
  return request(`files/${id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope: metadata, parts, bytes }) });
}

function filePart(index, bytes, id = FILE_ID) {
  return request(`files/${id}/parts/${index}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
}

function completeFile(id = FILE_ID) {
  return request(`files/${id}/complete`, { method: 'POST' });
}

test('large files upload in 8MiB parts and appear only after atomic completion', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.env.FILES = fileBucket();
  const plaintextSize = 50 * 1024 * 1024 + 73;
  const count = Math.ceil(plaintextSize / FILE_PART_BYTES);
  const metadata = envelope('L'.repeat(64));
  const started = await app.room.fetch(startFile({ parts: count, bytes: plaintextSize + count * 28, metadata }));
  assert.deepEqual(await started.json(), { id: FILE_ID, uploaded: [] });
  const payloads = [];
  for (let index = 0; index < count; index++) {
    const size = Math.min(FILE_PART_BYTES, plaintextSize - index * FILE_PART_BYTES) + 28;
    const bytes = new Uint8Array(size).fill(index + 1);
    payloads.push(bytes);
    assert.deepEqual(await (await app.room.fetch(filePart(index, bytes))).json(), { id: FILE_ID, part: index });
  }
  assert.equal((await (await app.room.fetch(request('files'))).json()).messages.length, 0);
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}/parts/0`))).status, 404);
  assert.equal(app.sent.length, 0);
  const response = await app.room.fetch(completeFile());
  assert.equal(response.status, 200);
  const event = await response.json();
  assert.equal(event.message, metadata);
  assert.deepEqual(app.sent, [event]);
  assert.equal((await (await app.room.fetch(request('files'))).json()).messages[0].seq, event.seq);
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}`))).status, 409, 'old whole-file clients receive a refresh instruction');
  for (let index = 0; index < count; index++) {
    const response = await app.room.fetch(request(`files/${FILE_ID}/parts/${index}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Content-Length'), String(payloads[index].length));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payloads[index]);
  }
  const restored = new PasaRoom(app.ctx, app.env);
  assert.deepEqual(await (await restored.fetch(completeFile())).json(), event);
  assert.equal(app.sent.length, 1);
  const resumed = await (await restored.fetch(startFile({ parts: count, bytes: plaintextSize + count * 28, metadata }))).json();
  assert.deepEqual(resumed, { id: FILE_ID, uploaded: Array.from({ length: count }, (_, index) => index), event });
});

test('250MiB limit is supported without any individual request or stored SQL blob exceeding 8MiB', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.env.FILES = fileBucket({ retain: false });
  const count = Math.ceil(MAX_FILE_BYTES / FILE_PART_BYTES);
  assert.equal(count, 32);
  assert.equal((await app.room.fetch(startFile({ parts: count, bytes: MAX_FILE_BYTES + count * 28 }))).status, 200);
  const full = new Uint8Array(FILE_PART_BYTES + 28);
  for (let index = 0; index < count; index++) {
    const size = Math.min(FILE_PART_BYTES, MAX_FILE_BYTES - index * FILE_PART_BYTES) + 28;
    assert.equal((await app.room.fetch(filePart(index, full.subarray(0, size)))).status, 200);
  }
  assert.equal((await app.room.fetch(completeFile())).status, 200);
  assert.equal(app.env.FILES.objects.size, 32);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_chunks').get().n, 0);
  assert.equal(app.db.prepare('SELECT size FROM files').get().size, MAX_FILE_BYTES + count * 28);
});

test('chunk starts validate counts, total bytes, metadata and private storage availability', async t => {
  const app = setup(); t.after(() => app.db.close());
  assert.equal((await app.room.fetch(startFile())).status, 503);
  app.env.FILES = fileBucket();
  for (const options of [{ parts: 0 }, { parts: 33 }, { parts: 1.5 }, { bytes: 27 }, { parts: 2, bytes: 56 }, { parts: 32, bytes: MAX_FILE_BYTES + 32 * 28 + 1 }, { metadata: 'plaintext' }]) {
    assert.equal((await app.room.fetch(startFile(options))).status, 400);
  }
  assert.equal((await app.room.fetch(startFile({ metadata: envelope('A'.repeat(17000)) }))).status, 413);
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}/start`, { method: 'POST', body: '{}' }))).status, 415);
  assert.equal((await app.room.fetch(startFile())).status, 200);
  assert.equal((await app.room.fetch(startFile({ metadata: envelope('B'.repeat(64)) }))).status, 409);
  assert.equal((await app.room.fetch(upload())).status, 409, 'legacy path cannot replace an in-progress chunked file');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.equal(app.sent.length, 0);
});

test('empty files, incomplete uploads and idempotent part retries behave predictably', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.env.FILES = fileBucket();
  await app.room.fetch(startFile());
  assert.equal((await app.room.fetch(completeFile())).status, 409);
  const bytes = new Uint8Array(28).fill(17);
  assert.equal((await app.room.fetch(filePart(0, bytes))).status, 200);
  assert.equal((await app.room.fetch(filePart(0, bytes))).status, 200);
  assert.equal((await app.room.fetch(filePart(0, new Uint8Array(28).fill(18)))).status, 409);
  assert.equal((await app.room.fetch(filePart(1, bytes))).status, 400);
  assert.equal(app.env.FILES.objects.size, 1);
  assert.deepEqual(await (await app.room.fetch(startFile())).json(), { id: FILE_ID, uploaded: [0] });
  const event = await (await app.room.fetch(completeFile())).json();
  assert.equal((await app.room.fetch(filePart(0, bytes))).status, 200);
  assert.deepEqual(await (await app.room.fetch(completeFile())).json(), event);
  assert.equal(app.sent.length, 1);
});

test('invalid part sizes and overlong streams never reach R2 or SQL', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.env.FILES = fileBucket();
  await app.room.fetch(startFile());
  for (const bytes of [new Uint8Array(27), new Uint8Array(29)]) assert.equal((await app.room.fetch(filePart(0, bytes))).status, 400);
  assert.equal((await app.room.fetch(filePart(0, new Uint8Array(FILE_PART_BYTES + 29)))).status, 413);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const response = await app.room.fetch(request(`files/${FILE_ID}/parts/0`, { method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'application/octet-stream' } }));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(app.env.FILES.objects.size, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM uploaded_parts').get().n, 0);
});

test('concurrent conflicting retries cannot overwrite the winning encrypted part', async t => {
  const app = setup(); t.after(() => app.db.close());
  const bucket = fileBucket();
  app.env.FILES = bucket;
  await app.room.fetch(startFile());
  const originalPut = bucket.put.bind(bucket);
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  bucket.put = async (...args) => {
    const result = await originalPut(...args);
    if (++calls === 2) release();
    await gate;
    return result;
  };
  const payloads = [new Uint8Array(28).fill(1), new Uint8Array(28).fill(2)];
  const responses = await Promise.all(payloads.map(bytes => app.room.fetch(filePart(0, bytes))));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await app.room.fetch(completeFile())).status, 200);
  const response = await app.room.fetch(request(`files/${FILE_ID}/parts/0`));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payloads[responses.findIndex(response => response.status === 200)]);
  assert.equal(bucket.objects.size, 1);
});

test('object-storage failure leaves no published file or accepted part', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.env.FILES = fileBucket();
  await app.room.fetch(startFile());
  app.env.FILES.put = async () => { throw new Error('private storage internals'); };
  const response = await app.room.fetch(filePart(0, new Uint8Array(28)));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Error temporal del servidor' });
  assert.equal((await app.room.fetch(completeFile())).status, 409);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM uploaded_parts').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(app.sent.length, 0);
});

test('alarms purge abandoned prefixes and orphan objects while preserving active and completed files', async t => {
  const app = setup(); t.after(() => app.db.close());
  const bucket = fileBucket(); app.env.FILES = bucket;
  const day = 86400000;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const activeId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const completedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const activeStart = () => startFile({ id: activeId, metadata: envelope('B'.repeat(64)) });
  await app.room.fetch(startFile());
  await app.room.fetch(filePart(0, new Uint8Array(28)));
  await app.room.fetch(activeStart());
  await app.room.fetch(startFile({ id: completedId, metadata: envelope('C'.repeat(64)) }));
  await app.room.fetch(filePart(0, new Uint8Array(28), completedId));
  await app.room.fetch(completeFile(completedId));
  const abandonedPrefix = `${ROOM}/${FILE_ID}/`;
  bucket.objects.set(`${abandonedPrefix}orphan/not-recorded-in-sql`, { size: 28, bytes: new Uint8Array(28) });
  const checked = [];
  const originalList = bucket.list.bind(bucket);
  bucket.list = async options => { checked.push(options.prefix); return originalList(options); };
  assert.ok((await app.ctx.storage.getAlarm()) > now);
  now += 23 * 3600000;
  await app.room.fetch(activeStart());
  now += 2 * 3600000;
  await app.ctx.storage.deleteAlarm();
  await app.room.alarm();
  assert.ok(![...bucket.objects.keys()].some(key => key.startsWith(abandonedPrefix)));
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_uploads WHERE id = ?').get(FILE_ID).n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM upload_cleanup WHERE id = ?').get(FILE_ID).n, 1);
  assert.equal((await app.room.fetch(startFile())).status, 409);
  assert.equal((await app.room.fetch(completeFile())).status, 404);
  assert.deepEqual(await (await app.room.fetch(activeStart())).json(), { id: activeId, uploaded: [] });
  assert.equal((await app.room.fetch(request(`files/${completedId}/parts/0`))).status, 200);
  // One later pass catches a process dying after a late object write.
  bucket.objects.set(`${abandonedPrefix}late-orphan`, { size: 28, bytes: new Uint8Array(28) });
  now += day;
  await app.ctx.storage.deleteAlarm();
  await app.room.alarm();
  assert.ok(![...bucket.objects.keys()].some(key => key.startsWith(abandonedPrefix)));
  assert.equal(app.db.prepare('SELECT last_checked FROM upload_cleanup WHERE id = ?').get(FILE_ID).last_checked, -1);
  now += day;
  await app.ctx.storage.deleteAlarm();
  await app.room.alarm();
  assert.equal(checked.filter(prefix => prefix === abandonedPrefix).length, 2, 'finished tombstones incur no recurring R2 list calls');
  assert.equal(await app.ctx.storage.getAlarm(), null);
  assert.equal((await app.room.fetch(request(`files/${completedId}/parts/0`))).status, 200);
});

test('cleanup claims block completion and safely remove a late in-flight object write', async t => {
  const app = setup(); t.after(() => app.db.close());
  const bucket = fileBucket(); app.env.FILES = bucket;
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  await app.room.fetch(startFile());
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const originalPut = bucket.put.bind(bucket);
  bucket.put = async (...args) => { entered(); await gate; return originalPut(...args); };
  const pending = app.room.fetch(filePart(0, new Uint8Array(28)));
  await waiting;
  now += 25 * 3600000;
  await app.ctx.storage.deleteAlarm();
  await app.room.alarm();
  assert.equal((await app.room.fetch(completeFile())).status, 404);
  release();
  assert.equal((await pending).status, 404);
  assert.equal(bucket.objects.size, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('failed cleanup retains its claim and schedules a bounded retry', async t => {
  const app = setup(); t.after(() => app.db.close());
  const bucket = fileBucket(); app.env.FILES = bucket;
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  await app.room.fetch(startFile());
  await app.room.fetch(filePart(0, new Uint8Array(28)));
  now += 25 * 3600000;
  const originalList = bucket.list.bind(bucket);
  bucket.list = async () => { throw new Error('temporary object storage failure'); };
  await app.ctx.storage.deleteAlarm();
  await app.room.alarm();
  assert.equal((await app.room.fetch(startFile())).status, 409);
  assert.equal(await app.ctx.storage.getAlarm(), now + 60000);
  assert.equal(bucket.objects.size, 1);
  bucket.list = originalList;
  now += 60000;
  await app.ctx.storage.deleteAlarm();
  await app.room.alarm();
  assert.equal(bucket.objects.size, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_uploads').get().n, 0);
});

function deleteFile(id = FILE_ID, metadata = envelope('D'.repeat(64))) {
  return request(`files/${id}/delete`, { method: 'POST', body: metadata, headers: { 'Content-Type': 'text/plain' } });
}

async function committedChunkFile(app, id = FILE_ID, metadata = envelope(), bytes = new Uint8Array(28)) {
  assert.equal((await app.room.fetch(startFile({ id, metadata, bytes: bytes.length }))).status, 200);
  assert.equal((await app.room.fetch(filePart(0, bytes, id))).status, 200);
  const response = await app.room.fetch(completeFile(id));
  assert.equal(response.status, 200);
  return response.json();
}

test('deleting a legacy file atomically removes bytes and original metadata while retaining the deletion event', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.db.exec('PRAGMA foreign_keys = ON');
  const original = await (await app.room.fetch(upload(new Uint8Array(400000), envelope()))).json();
  // A stale category marker cannot prevent physical removal through a foreign key.
  app.db.prepare('INSERT INTO archive_messages (seq) VALUES (?)').run(original.seq);
  const text = await (await app.room.fetch(post(envelope('T'.repeat(64))))).json();
  const response = await app.room.fetch(deleteFile());
  assert.equal(response.status, 200);
  const deleted = await response.json();
  assert.equal(deleted.event, 'message');
  assert.equal(deleted.message, envelope('D'.repeat(64)));
  assert.ok(deleted.seq > text.seq);
  assert.deepEqual(app.sent.at(-1), deleted);
  for (const table of ['files', 'file_chunks', 'file_uploads', 'uploaded_parts', 'archive_messages']) assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE seq = ?').get(original.seq).n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2, 'unrelated text and encrypted deletion event remain');
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}`))).status, 410);
  assert.equal((await (await app.room.fetch(request('files'))).json()).messages.length, 0);
  const restored = new PasaRoom(app.ctx, app.env);
  assert.deepEqual(await (await restored.fetch(deleteFile(FILE_ID, envelope('E'.repeat(64))))).json(), deleted);
  assert.equal(app.sent.filter(event => event.seq === deleted.seq).length, 1);
  assert.deepEqual((await (await restored.fetch(request('file-deletions'))).json()).messages, [deleted]);
});

test('chunked deletion purges the exact R2 prefix and every orphan while preserving other shared files', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.db.exec('PRAGMA foreign_keys = ON');
  const bucket = fileBucket(); app.env.FILES = bucket;
  const original = await committedChunkFile(app);
  const otherId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const other = await committedChunkFile(app, otherId, envelope('B'.repeat(64)), new Uint8Array(28).fill(8));
  bucket.objects.set(`${ROOM}/${FILE_ID}/unindexed-orphan`, { size: 28, bytes: new Uint8Array(28) });
  const originalList = bucket.list.bind(bucket);
  bucket.list = async options => {
    assert.ok(app.sent.some(event => event.message === envelope('D'.repeat(64))), 'logical deletion is durably broadcast before physical R2 cleanup');
    assert.equal((await app.room.fetch(request(`files/${FILE_ID}/parts/0`))).status, 410);
    return originalList(options);
  };
  const deleted = await (await app.room.fetch(deleteFile())).json();
  assert.ok(!deleted.cleanupPending);
  assert.ok(![...bucket.objects.keys()].some(key => key.startsWith(`${ROOM}/${FILE_ID}/`)));
  assert.equal(bucket.objects.size, 1);
  assert.equal((await app.room.fetch(request(`files/${otherId}/parts/0`))).status, 200);
  assert.deepEqual((await (await app.room.fetch(request('files'))).json()).messages.map(event => event.seq), [other.seq]);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE seq = ?').get(original.seq).n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_uploads WHERE id = ?').get(FILE_ID).n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM uploaded_parts WHERE file_id = ?').get(FILE_ID).n, 0);
  assert.equal(app.db.prepare('SELECT cleanup_passes FROM file_deletions WHERE id = ?').get(FILE_ID).cleanup_passes, 1);
});

test('file tombstones prevent legacy, chunked, and cached-ciphertext resurrection', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.env.FILES = fileBucket();
  const original = envelope();
  await app.room.fetch(upload(new Uint8Array(28), original));
  assert.equal((await app.room.fetch(deleteFile())).status, 200);
  for (const req of [request(`files/${FILE_ID}`), request(`files/${FILE_ID}/parts/0`), startFile(), filePart(0, new Uint8Array(28)), completeFile(), upload(), post(original), request('archives', { method: 'POST', body: original })]) {
    assert.equal((await app.room.fetch(req)).status, 410);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  const unknown = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert.equal((await app.room.fetch(deleteFile(unknown, envelope('U'.repeat(64))))).status, 200);
  assert.equal((await app.room.fetch(startFile({ id: unknown, metadata: envelope('N'.repeat(64)) }))).status, 410, 'a deletion racing a future start still wins');
});

test('deletion refuses the original metadata envelope instead of deduplicating away its own event', async t => {
  const app = setup(); t.after(() => app.db.close());
  const original = await (await app.room.fetch(upload())).json();
  assert.equal((await app.room.fetch(deleteFile(FILE_ID, original.message))).status, 400);
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}`))).status, 200);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_deletions').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('temporary R2 deletion failure returns logical success and alarms finish cleanup without restoring access', async t => {
  const app = setup(); t.after(() => app.db.close());
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const bucket = fileBucket(); app.env.FILES = bucket;
  await committedChunkFile(app);
  const originalDelete = bucket.delete.bind(bucket);
  bucket.delete = async () => { throw new Error('temporary R2 failure'); };
  const response = await app.room.fetch(deleteFile());
  assert.equal(response.status, 200);
  const deleted = await response.json();
  assert.equal(deleted.cleanupPending, true);
  assert.equal(bucket.objects.size, 1);
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}/parts/0`))).status, 410);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
  assert.ok((await app.ctx.storage.getAlarm()) > now && (await app.ctx.storage.getAlarm()) <= now + 60000);
  bucket.delete = originalDelete;
  now += 60000;
  await app.ctx.storage.deleteAlarm();
  await app.room.alarm();
  assert.equal(bucket.objects.size, 0);
  assert.equal(app.db.prepare('SELECT cleanup_passes FROM file_deletions WHERE id = ?').get(FILE_ID).cleanup_passes, 1);
  // The delayed final pass catches an orphan from an already in-flight request.
  bucket.objects.set(`${ROOM}/${FILE_ID}/late-orphan`, { size: 28, bytes: new Uint8Array(28) });
  now += 86400000;
  await app.ctx.storage.deleteAlarm();
  await app.room.alarm();
  assert.equal(bucket.objects.size, 0);
  assert.equal(app.db.prepare('SELECT cleanup_due FROM file_deletions WHERE id = ?').get(FILE_ID).cleanup_due, -1);
  assert.equal(await app.ctx.storage.getAlarm(), null);
  const repeated = await (await app.room.fetch(deleteFile(FILE_ID, envelope('E'.repeat(64))))).json();
  assert.equal(repeated.seq, deleted.seq);
  assert.ok(!repeated.cleanupPending);
  assert.equal(app.sent.filter(event => event.seq === deleted.seq).length, 1);
});

test('deletion racing an in-flight chunk write blocks commit and removes the late object', async t => {
  const app = setup(); t.after(() => app.db.close());
  const bucket = fileBucket(); app.env.FILES = bucket;
  await app.room.fetch(startFile());
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const originalPut = bucket.put.bind(bucket);
  bucket.put = async (...args) => { entered(); await gate; return originalPut(...args); };
  const pending = app.room.fetch(filePart(0, new Uint8Array(28)));
  await waiting;
  const response = await app.room.fetch(deleteFile());
  assert.equal(response.status, 200);
  const deleted = await response.json();
  release();
  assert.equal((await pending).status, 410);
  assert.equal(bucket.objects.size, 0);
  assert.equal((await app.room.fetch(completeFile())).status, 410);
  assert.deepEqual(app.sent.map(event => event.seq), [deleted.seq]);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('deletion racing a pending download prevents the already-fetched R2 body from being returned', async t => {
  const app = setup(); t.after(() => app.db.close());
  const bucket = fileBucket(); app.env.FILES = bucket;
  await committedChunkFile(app);
  let release;
  let entered;
  let cancelled = false;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  bucket.get = async () => {
    entered(); await gate;
    return { size: 28, body: new ReadableStream({ cancel() { cancelled = true; } }) };
  };
  const pending = app.room.fetch(request(`files/${FILE_ID}/parts/0`));
  await waiting;
  assert.equal((await app.room.fetch(deleteFile())).status, 200);
  release();
  assert.equal((await pending).status, 410);
  assert.equal(cancelled, true);
});

test('deletion racing a durable completion does not rebroadcast removed original file metadata', async t => {
  const app = setup(); t.after(() => app.db.close());
  app.env.FILES = fileBucket();
  await app.room.fetch(startFile());
  await app.room.fetch(filePart(0, new Uint8Array(28)));
  let release;
  let entered;
  let blockNext = true;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const originalSync = app.ctx.storage.sync;
  app.ctx.storage.sync = async () => {
    await originalSync();
    if (blockNext) { blockNext = false; entered(); await gate; }
  };
  const completing = app.room.fetch(completeFile());
  await waiting;
  const deleted = await (await app.room.fetch(deleteFile())).json();
  release();
  assert.equal((await completing).status, 410);
  assert.deepEqual(app.sent.map(event => event.seq), [deleted.seq]);
  assert.equal((await (await app.room.fetch(request('files'))).json()).messages.length, 0);
});

test('file-deletion catalogs and general cursors retain progress across removed file-message sequence gaps', async t => {
  const app = setup(); t.after(() => app.db.close());
  const deleted = [];
  const texts = [];
  for (let index = 0; index < 7; index++) {
    const id = `${String(index).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    await app.room.fetch(upload(new Uint8Array(28), envelope('F'.repeat(64 + index)), id));
    texts.push(await (await app.room.fetch(post(envelope('T'.repeat(64 + index))))).json());
    deleted.push(await (await app.room.fetch(deleteFile(id, envelope('D'.repeat(64 + index))))).json());
  }
  const latest = await (await app.room.fetch(request('file-deletions?limit=3'))).json();
  assert.deepEqual(latest.messages.map(event => event.seq), deleted.slice(-3).reverse().map(event => event.seq));
  assert.equal(latest.hasMore, true);
  const older = await (await app.room.fetch(request(`file-deletions?before=${latest.nextBefore}&limit=50`))).json();
  assert.deepEqual(older.messages.map(event => event.seq), deleted.slice(0, -3).reverse().map(event => event.seq));
  const forward = await (await app.room.fetch(request(`file-deletions?after=${deleted[2].seq}&limit=50`))).json();
  assert.deepEqual(forward.messages.map(event => event.seq), deleted.slice(3).map(event => event.seq));
  const all = [];
  let after = 0;
  do {
    const page = await (await app.room.fetch(request(`messages?after=${after}&limit=3`))).json();
    all.push(...page.messages.map(event => event.seq));
    after = page.nextAfter;
    if (!page.hasMore) break;
  } while (all.length < 30);
  assert.deepEqual(all, texts.flatMap((event, index) => [event.seq, deleted[index].seq]));
  assert.equal(after, deleted.at(-1).seq);
});

test('deletion routes enforce existing room, origin, body, method and cursor bounds', async t => {
  const app = setup(); t.after(() => app.db.close());
  const denied = new Request(`https://pasa-api.example/api/rooms/${OTHER_ROOM}/files/${FILE_ID}/delete`, { method: 'POST', body: envelope() });
  assert.equal((await worker.fetch(denied, app.env)).status, 404);
  assert.equal((await worker.fetch(request(`files/${FILE_ID}/delete`, { method: 'POST', body: envelope(), headers: { Origin: 'https://evil.example' } }), app.env)).status, 403);
  assert.equal((await worker.fetch(request(`files/${FILE_ID}/delete`), app.env)).status, 405);
  assert.equal((await worker.fetch(request(`files/${FILE_ID}/delete`, { method: 'DELETE' }), app.env)).status, 405);
  assert.equal((await worker.fetch(request(`files/${FILE_ID}/delete`, { method: 'POST', body: 'plaintext' }), app.env)).status, 400);
  assert.equal((await worker.fetch(request(`files/${FILE_ID}/delete`, { method: 'POST', body: envelope(), headers: { 'Content-Type': 'text/html' } }), app.env)).status, 415);
  assert.equal((await worker.fetch(request('file-deletions', { method: 'POST', body: envelope() }), app.env)).status, 405);
  assert.equal((await worker.fetch(request('file-deletions?after=-1'), app.env)).status, 400);
  assert.equal((await worker.fetch(request(`file-deletions/${FILE_ID}`), app.env)).status, 404);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_deletions').get().n, 0);
});

test('a failed deletion transaction leaves the original file intact and exposes no deletion event', async t => {
  const app = setup(); t.after(() => app.db.close());
  await app.room.fetch(upload());
  const originalExec = app.ctx.storage.sql.exec;
  app.ctx.storage.sql.exec = (query, ...args) => {
    if (query.startsWith('DELETE FROM files')) throw new Error('storage failure');
    return originalExec(query, ...args);
  };
  const response = await app.room.fetch(deleteFile());
  assert.equal(response.status, 500);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_deletions').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}`))).status, 200);
  assert.equal(app.sent.length, 1);
});

test('a new deletion cannot reuse an already-seen text or archive sequence', async t => {
  const app = setup(); t.after(() => app.db.close());
  await app.room.fetch(upload());
  const oldText = envelope('T'.repeat(64));
  const oldArchive = envelope('R'.repeat(64));
  await app.room.fetch(post(oldText));
  await app.room.fetch(request('archives', { method: 'POST', body: oldArchive }));
  for (const oldEnvelope of [oldText, oldArchive]) assert.equal((await app.room.fetch(deleteFile(FILE_ID, oldEnvelope))).status, 409);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM file_deletions').get().n, 0);
  assert.equal((await app.room.fetch(request(`files/${FILE_ID}`))).status, 200);
  assert.equal((await app.room.fetch(deleteFile())).status, 200);
});
