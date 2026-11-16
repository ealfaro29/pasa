import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveState } from '../archive-state.js';
import { messageView } from '../message-view.js';

const message = text => ({ id: 'message-12345678', text });
function archived(id, url) {
  const state = new ArchiveState();
  state.apply({ kind: 'archive', target: { id, ...(url ? { url } : {}) }, archived: true }, 1, 'encrypted');
  return state;
}

test('archiving one link removes its raw spellings without hiding another link or prose', () => {
  const value = message('Mira https://EXAMPLE.com/a y https://example.com/a con https://example.com/b');
  const state = archived(value.id, 'https://example.com/a');
  const active = messageView(value, state, false);
  assert.deepEqual(active.visibleLinks, ['https://example.com/b']);
  assert.equal(active.text, 'Mira  y  con https://example.com/b');
  assert.ok(!active.copy.includes('/a'));
  const saved = messageView(value, state, true);
  assert.deepEqual(saved.visibleLinks, ['https://EXAMPLE.com/a']);
  assert.equal(saved.text, '');
});

test('link-only messages disappear from active view when every link is archived', () => {
  const value = message('www.example.com');
  const state = archived(value.id, 'https://www.example.com/');
  assert.equal(messageView(value, state, false), null);
  assert.deepEqual(messageView(value, state, true).visibleLinks, ['https://www.example.com']);
  const duplicate = message('https://example.com https://example.com/');
  assert.equal(messageView(duplicate, archived(duplicate.id, 'https://example.com/'), false), null);
});

test('whole text messages move between views and typed file/control events never render as text', () => {
  const value = message('Una idea');
  const state = archived(value.id);
  assert.equal(messageView(value, state, false), null);
  assert.equal(messageView(value, state, true).text, 'Una idea');
  for (const kind of ['file', 'file-delete', 'archive']) assert.equal(messageView({ ...value, kind }, state, true), null);
});

test('link-only messages copy visible links once and keep balanced URL punctuation', () => {
  const state = new ArchiveState();
  const value = message('https://example.com/a_(b)\nhttps://example.com/c');
  assert.equal(messageView(value, state, false).text, '');
  assert.equal(messageView(value, state, false).copy, value.text);
});
