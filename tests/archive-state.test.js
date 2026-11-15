import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveState, archiveKey } from '../archive-state.js';

const id = 'shared-message-123456';
const otherId = 'other-message-1234567';
const first = 'https://example.com/first';
const second = 'https://example.com/second';
const action = (target, archived = true, extra = {}) => ({
  v: 1, kind: 'archive', id: crypto.randomUUID(), device: crypto.randomUUID(),
  text: '', created: Date.now(), target, archived, ...extra,
});

test('archives individual links independently of other links and messages', () => {
  const state = new ArchiveState();
  state.apply(action({ id, url: first }), 1, 'encrypted-first');
  assert.equal(state.isArchived(id, first), true);
  assert.equal(state.isArchived(id, second), false);
  assert.equal(state.isArchived(otherId, first), false);
  assert.equal(state.isMessageArchived(id), false);
  assert.equal(state.isArchived(id), false);
});

test('whole-message archive covers every link and restore preserves independent link state', () => {
  const state = new ArchiveState();
  state.apply(action({ id, url: first }), 1, 'encrypted-link');
  state.apply(action({ id }), 2, 'encrypted-message');
  assert.equal(state.isMessageArchived(id), true);
  assert.equal(state.isArchived(id), true);
  assert.equal(state.isArchived(id, first), true);
  assert.equal(state.isArchived(id, second), true);

  state.apply(action({ id }, false), 3, 'encrypted-restore-message');
  assert.equal(state.isMessageArchived(id), false);
  assert.equal(state.isArchived(id, first), true);
  assert.equal(state.isArchived(id, second), false);

  state.apply(action({ id, url: first }, false), 4, 'encrypted-restore-link');
  assert.equal(state.isArchived(id, first), false);
});

test('uses server sequence rather than client time or history arrival order', () => {
  const state = new ArchiveState();
  const old = action({ id }, true, { created: Date.now() + 1000 });
  const restored = action({ id }, false, { created: 1 });
  assert.equal(state.apply(restored, 20, 'restore'), true);
  assert.equal(state.apply(old, 3, 'old-archive'), false);
  assert.equal(state.isMessageArchived(id), false);
  assert.deepEqual(state.entries(), [{ message: restored, seq: 20, envelope: 'restore' }]);
});

test('replayed sequence cannot overwrite the saved action', () => {
  const state = new ArchiveState();
  const archived = action({ id });
  assert.equal(state.apply(archived, 8, 'archive'), true);
  assert.equal(state.apply(archived, 8, 'archive'), false);
  assert.equal(state.apply(action({ id }, false), 8, 'conflicting-replay'), false);
  assert.equal(state.isMessageArchived(id), true);
  assert.equal(state.entries().length, 1);
});

test('persisted latest target actions retain restores and reconstruct the same state', () => {
  const state = new ArchiveState();
  state.apply(action({ id }), 2, 'old-whole');
  state.apply(action({ id }, false), 9, 'restored-whole');
  state.apply(action({ id, url: first }), 4, 'first-link');
  state.apply(action({ id: otherId }), 6, 'other-message');
  state.apply(action({ id, url: second }), 7, 'second-link');
  state.apply(action({ id, url: second }, false), 12, 'restored-second');
  const entries = JSON.parse(JSON.stringify(state.entries()));
  assert.deepEqual(entries.map(record => record.seq), [4, 6, 9, 12]);

  const restored = new ArchiveState();
  for (const record of entries.reverse()) restored.apply(record.message, record.seq, record.envelope);
  restored.apply(action({ id }), 2, 'late-old-whole');
  restored.apply(action({ id, url: second }), 7, 'late-old-second');
  assert.equal(restored.isMessageArchived(id), false);
  assert.equal(restored.isArchived(id, first), true);
  assert.equal(restored.isArchived(id, second), false);
  assert.equal(restored.isMessageArchived(otherId), true);
});

test('target keys are unambiguous and distinguish whole messages from URLs', () => {
  assert.equal(archiveKey({ id }), archiveKey({ id, url: undefined }));
  assert.notEqual(archiveKey({ id }), archiveKey({ id, url: first }));
  assert.notEqual(archiveKey({ id, url: first }), archiveKey({ id, url: second }));
  assert.notEqual(archiveKey({ id, url: first }), archiveKey({ id: otherId, url: first }));
});

test('ignores non-archive events and invalid server sequence values', () => {
  const state = new ArchiveState();
  for (const seq of [-1, 1.2, Infinity, Number.NaN, '1']) {
    assert.equal(state.apply(action({ id }), seq, 'invalid'), false);
  }
  assert.equal(state.apply({ kind: 'file' }, 1, 'file'), false);
  assert.equal(state.apply(null, 1, 'nothing'), false);
  assert.deepEqual(state.entries(), []);
});
