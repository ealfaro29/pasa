import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { PasaRoom, MAX_ENVELOPE_BYTES, MAX_PAGE_BYTES } from '../backend/worker.js';

const ROOM = 'pasa_' + 'a'.repeat(56);
const OTHER_ROOM = 'pasa_' + 'b'.repeat(56);
const ORIGIN = 'https://ealfaro29.github.io';
const envelope = (data = 'A'.repeat(64)) => JSON.stringify({ v: 1, zip: 0, iv: 'A'.repeat(16), data });

function context(db = new DatabaseSync(':memory:')) {
  const sent = [];
  let synced = 0;
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

test('health identifies the own backend without revealing room configuration', async () => {
  const env = { ROOM_IDS: ROOM };
  const response = await worker.fetch(new Request('https://pasa-api.example/health', { headers: { Origin: ORIGIN } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', version: 'pasa-own-v2' });
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
