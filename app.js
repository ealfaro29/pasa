import { createRoom, decryptMessage, encryptMessage, isRoomSecret, loadHistory, MAX_TEXT_BYTES, publishEnvelope, subscribe } from './protocol.js?v=2.0.0';
import { describeLink, extractLinks } from './links.js?v=2.0.0';

const $ = id => document.getElementById(id);
const input = $('message-input');
const output = $('output-list');
const empty = $('empty-state');
const encoder = new TextEncoder();
const records = new Map();
const seenEvents = new Set();
const inFlightEvents = new Set();
let room;
let storageKey;
let transport;
let pumping = false;
let preparing = false;
let ready = false;
let hiddenBefore = 0;
let pasteTimer;
let toastTimer;
let draftTimer;
let retryTimer;
let draftEnvelope = null;
let inputVersion = 0;
let connectionState = 'connecting';
let retentionWarning = false;
let historyBefore = null;
let hasOlder = false;
let loadingOlder = false;
let syncedSeq = 0;
let syncTarget = 0;
let syncing = false;
let syncRetryTimer;
let syncFailures = 0;
let migratedOwn = false;
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
};
let device = storage.get('pasa.device.v1');
if (!/^[a-zA-Z0-9-]{16,64}$/.test(device || '')) {
  device = crypto.randomUUID();
  storage.set('pasa.device.v1', device);
}

function toast(message, duration = 4000) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}

function setInputHint(text = '') {
  const hint = $('input-hint');
  if (hint) { hint.textContent = text; hint.hidden = !text; }
}

function persist() {
  if (!storageKey) return false;
  // This is a bounded device cache; the complete history stays in our database.
  const sorted = [...records.values()].sort((a, b) => {
    const pending = record => ['pending', 'failed'].includes(record.state) ? 1 : 0;
    return pending(b) - pending(a) || b.message.created - a.message.created;
  });
  const items = [];
  let size = 0;
  for (const record of sorted) {
    const outbox = ['pending', 'failed'].includes(record.state);
    if (!outbox && (items.length >= 100 || size + record.envelope.length > 3000000)) continue;
    size += record.envelope.length;
    items.push({ envelope: record.envelope, state: record.state, seq: record.seq || 0, retryable: record.retryable, retryAt: record.retryAt, attempts: record.attempts || 0 });
  }
  const saved = storage.set(storageKey, JSON.stringify({ v: 1, items, hiddenBefore, draft: draftEnvelope, migratedOwn }));
  if (!saved && !retentionWarning) {
    retentionWarning = true;
    toast('El navegador no pudo guardar el historial local. La sincronización sigue disponible.', 6000);
  }
  return saved;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

function linkCard(url) {
  const info = describeLink(url);
  const card = document.createElement('a');
  card.className = 'link-card';
  const platform = info.platform.toLowerCase().replace(/^google /, '').replaceAll(' ', '-');
  card.dataset.platform = platform;
  card.href = info.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.title = info.url;
  card.setAttribute('aria-label', `${info.provider}: ${info.title}. Abrir en otra pestaña`);
  const mark = document.createElement('span');
  mark.className = 'link-card-icon';
  mark.setAttribute('aria-hidden', 'true');
  const marks = { youtube: '▶', github: 'GH', instagram: '◎', x: '𝕏', twitter: '𝕏', tiktok: '♪', notion: 'N', figma: 'F', docs: 'D', sheets: 'S', slides: 'P', drive: '△', canva: 'C', linkedin: 'in', spotify: '≋', wikipedia: 'W' };
  mark.textContent = marks[platform] || info.provider.slice(0, 1).toUpperCase();
  const content = document.createElement('span');
  content.className = 'link-card-content';
  for (const [name, text] of [['provider', info.provider], ['title', info.title], ['domain', info.domain]]) {
    const line = document.createElement('span');
    line.className = `link-card-${name}`;
    line.textContent = text;
    content.append(line);
  }
  const arrow = icon('arrow');
  arrow.classList.add('link-card-arrow');
  card.append(mark, content, arrow);
  return card;
}

function renderRecord(record, fresh) {
  const { message, state } = record;
  const own = message.device === device;
  const card = document.createElement('article');
  card.className = 'message-card' + (fresh ? ' message-new' : '') + (state === 'pending' ? ' message-pending' : '') + (state === 'failed' ? ' message-failed' : '');
  card.dataset.messageId = message.id;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const origin = document.createElement('span');
  origin.className = 'message-origin';
  origin.textContent = own ? 'Desde este PC' : 'Desde el otro PC';
  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = new Date(message.created).toISOString();
  const sameDay = new Date(message.created).toDateString() === new Date().toDateString();
  time.textContent = new Intl.DateTimeFormat('es', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(message.created);
  time.title = new Date(message.created).toLocaleString('es');
  meta.append(origin, time);
  const body = document.createElement('div');
  body.className = 'message-body';
  const links = extractLinks(message.text);
  const onlyLink = links.length === 1 && [links[0], links[0].replace(/^https:\/\//, '')].includes(message.text.trim());
  if (!onlyLink) {
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.text;
    body.append(text);
  }
  if (links.length) {
    const cards = document.createElement('div');
    cards.className = 'link-cards';
    links.forEach(url => cards.append(linkCard(url)));
    body.append(cards);
  }
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const status = document.createElement('span');
  status.className = 'message-status';
  status.textContent = state === 'pending' ? 'Pendiente de envío' : state === 'failed' ? 'No enviado' : own ? 'Enviado' : 'Recibido';
  actions.append(status);
  const buttons = document.createElement('span');
  buttons.className = 'message-buttons';
  {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry-message';
    retry.textContent = 'Reintentar';
    retry.hidden = state !== 'failed';
    retry.addEventListener('click', () => {
      if (record.retryAt > Date.now()) {
        toast('Espera un momento antes de volver a intentar el envío.');
        return;
      }
      record.state = 'pending';
      record.attempts = 0;
      render();
      persist();
      pump();
    });
    buttons.append(retry);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-message';
  copy.append(icon('copy'), document.createTextNode('Copiar'));
  copy.setAttribute('aria-label', 'Copiar el texto completo');
  copy.addEventListener('click', () => copyText(message.text, 'Texto copiado'));
  buttons.append(copy);
  actions.append(buttons);
  card.append(meta, body, actions);
  const error = document.createElement('p');
  error.className = 'message-error';
  error.textContent = record.error || '';
  error.hidden = state !== 'failed' || !record.error;
  card.append(error);
  return card;
}

function updateRecordNode(record, freshId) {
  if (!record.node) record.node = renderRecord(record, record.message.id === freshId);
  const card = record.node;
  card.classList.toggle('message-pending', record.state === 'pending');
  card.classList.toggle('message-failed', record.state === 'failed');
  const own = record.message.device === device;
  card.querySelector('.message-status').textContent = record.state === 'pending' ? 'Pendiente de envío' : record.state === 'failed' ? 'No enviado' : own ? 'Enviado' : 'Recibido';
  card.querySelector('.retry-message').hidden = record.state !== 'failed';
  const error = card.querySelector('.message-error');
  error.textContent = record.error || '';
  error.hidden = record.state !== 'failed' || !record.error;
  return card;
}

function render(freshId) {
  const visible = [...records.values()].filter(record => record.message.created > hiddenBefore || ['pending', 'failed'].includes(record.state)).sort((a, b) => b.message.created - a.message.created);
  const atTop = output.scrollTop < 30;
  const oldHeight = output.scrollHeight;
  const oldScroll = output.scrollTop;
  const desired = visible.map(record => updateRecordNode(record, freshId));
  const keep = new Set(desired);
  for (const child of [...output.children]) if (!keep.has(child)) child.remove();
  if (!visible.length) output.append(empty);
  else desired.forEach((node, index) => {
    if (output.children[index] !== node) output.insertBefore(node, output.children[index] || null);
  });
  $('output-count').textContent = visible.length;
  $('clear-output').disabled = !visible.length;
  refreshHistoryButton();
  if (atTop || !freshId) output.scrollTop = freshId ? 0 : oldScroll;
  else output.scrollTop = oldScroll + output.scrollHeight - oldHeight;
}

function refreshInput() {
  const bytes = encoder.encode(input.value).length;
  $('char-count').textContent = bytes > MAX_TEXT_BYTES ? 'Máximo 128 KB' : `${input.value.length.toLocaleString('es')} caracteres`;
  $('send-button').disabled = !ready || preparing || !input.value.trim() || bytes > MAX_TEXT_BYTES;
  input.setAttribute('aria-invalid', String(bytes > MAX_TEXT_BYTES));
  $('clear-input').disabled = !input.value;
}

async function saveDraft() {
  if (!ready) return;
  const version = inputVersion;
  const text = input.value;
  if (!text.trim() || encoder.encode(text).length > MAX_TEXT_BYTES) {
    draftEnvelope = null;
    persist();
    return;
  }
  const draft = await encryptMessage(room.key, { v: 1, id: crypto.randomUUID(), device, text, created: Date.now() });
  if (version !== inputVersion) return;
  draftEnvelope = draft;
  persist();
}

async function send() {
  clearTimeout(pasteTimer);
  if (!ready || preparing || !input.value.trim()) return;
  const text = input.value;
  if (encoder.encode(text).length > MAX_TEXT_BYTES) { setInputHint('El texto supera 128 KB. Divídelo en dos envíos.'); return; }
  if ([...records.values()].filter(record => ['pending', 'failed'].includes(record.state)).length >= 10) {
    toast('Tienes 10 envíos pendientes. Reintenta los anteriores primero.');
    return;
  }
  const version = inputVersion;
  const message = { v: 1, id: crypto.randomUUID(), device, text, created: Date.now() };
  preparing = true;
  $('send-button').disabled = true;
  try {
    const envelope = await encryptMessage(room.key, message);
    records.set(message.id, { message, envelope, state: 'pending', attempts: 0 });
    if (!persist()) {
      records.delete(message.id);
      throw new Error('No hay espacio local para conservar este envío pendiente. El texto sigue en Input.');
    }
    if (version === inputVersion) {
      input.value = '';
      inputVersion++;
      draftEnvelope = null;
      clearTimeout(draftTimer);
    }
    setInputHint();
    persist();
    render(message.id);
    refreshInput();
    pump();
  } catch (error) { toast(error.message || 'No se pudo preparar el texto. Inténtalo de nuevo.'); }
  finally { preparing = false; refreshInput(); }
}

async function pump() {
  if (pumping || !ready || !navigator.onLine) return;
  pumping = true;
  try {
    const pending = [...records.values()].filter(record => record.state === 'pending').sort((a, b) => a.message.created - b.message.created);
    for (const record of pending) {
      if (record.state !== 'pending') continue;
      try {
        record.attempts++;
        const event = await publishEnvelope(room.topic, record.envelope);
        seenEvents.add(event.id);
        record.seq = event.seq;
        record.state = 'sent';
        record.retryable = false;
        record.error = '';
      } catch (error) {
        // A stream echo can confirm delivery even if the publish response is lost.
        if (record.state !== 'sent') {
          record.state = 'failed';
          record.error = error.message;
          record.retryable = Boolean(error.retryable);
          record.retryAt = Date.now() + (error.retryAfter || Math.min(30000, 2000 * 2 ** record.attempts));
          toast(error.message, 6000);
        }
      }
      persist();
      render();
    }
  } finally {
    pumping = false;
    if ([...records.values()].some(record => record.state === 'pending')) pump();
    scheduleRetries();
  }
}

function scheduleRetries() {
  clearTimeout(retryTimer);
  const failed = [...records.values()].filter(record => record.state === 'failed' && record.retryable && record.attempts < 3);
  if (!failed.length || !navigator.onLine) return;
  const next = Math.min(...failed.map(record => record.retryAt || 0));
  retryTimer = setTimeout(() => {
    for (const record of failed) if (record.state === 'failed' && record.retryable && record.retryAt <= Date.now()) record.state = 'pending';
    render();
    pump();
  }, Math.max(1000, next - Date.now()));
}

async function receive(event, { announce = true } = {}) {
  if (seenEvents.has(event.id) || inFlightEvents.has(event.id)) return;
  inFlightEvents.add(event.id);
  try {
    const envelope = event.message;
    if (typeof envelope !== 'string') return;
    const message = await decryptMessage(room.key, envelope);
    seenEvents.add(event.id);
    if (seenEvents.size > 500) seenEvents.delete(seenEvents.values().next().value);
    const existing = records.get(message.id);
    if (existing) {
      existing.seq = event.seq;
      if (existing.state === 'pending' || existing.state === 'failed') {
        existing.state = 'sent';
        existing.retryable = false;
        existing.error = '';
        render();
      }
      persist();
      return;
    }
    records.set(message.id, { message, envelope, seq: event.seq, state: message.device === device ? 'sent' : 'received', attempts: 0 });
    persist();
    render(announce ? message.id : undefined);
    if (announce && document.hidden && message.device !== device) document.title = '• Nuevo texto | pasa';
  } catch {
    // The server cannot authenticate ciphertext. Only this browser has the key.
  } finally { inFlightEvents.delete(event.id); }
}

function refreshHistoryButton() {
  const button = $('load-older');
  button.hidden = !ready || (!hasOlder && !hiddenBefore);
  $('history-tools').hidden = button.hidden;
  button.disabled = loadingOlder;
  button.textContent = loadingOlder ? 'Cargando historial…' : hiddenBefore ? 'Ver historial guardado' : 'Cargar anteriores';
}

async function readLatestHistory({ seedCursor = false } = {}) {
  const page = await loadHistory(room.topic, { limit: 30 });
  for (const event of page.messages) await receive(event, { announce: false });
  historyBefore = page.nextBefore;
  hasOlder = Boolean(page.hasMore);
  if (seedCursor) syncedSeq = Math.max(syncedSeq, Number(page.latestSeq) || 0);
  refreshHistoryButton();
  return page;
}

async function catchUp(latestSeq) {
  syncTarget = Math.max(syncTarget, Number(latestSeq) || 0);
  if (syncing || !ready) return;
  syncing = true;
  clearTimeout(syncRetryTimer);
  try {
    // Live events never advance this cursor. Each gap is covered by HTTP pages,
    // even if a newer WebSocket event arrives while an older page is in flight.
    while (syncedSeq < syncTarget) {
      const page = await loadHistory(room.topic, { after: syncedSeq, limit: 30 });
      for (const event of page.messages) await receive(event, { announce: false });
      const next = Number(page.nextAfter) || Math.max(0, ...page.messages.map(event => Number(event.seq) || 0));
      if (next > syncedSeq) syncedSeq = next;
      else if (!page.hasMore) syncedSeq = Math.max(syncedSeq, Number(page.latestSeq) || syncTarget);
      else throw new Error('No se pudo avanzar en el historial. Reintenta la conexión.');
      syncTarget = Math.max(syncTarget, Number(page.latestSeq) || 0);
    }
    syncFailures = 0;
  } catch (error) {
    setConnection('reconnecting');
    toast(error.message || 'No se pudo recuperar el historial. Reintenta la conexión.');
    syncFailures++;
    if (navigator.onLine) {
      syncRetryTimer = setTimeout(() => transport?.reconnect(), Math.min(30000, 1000 * 2 ** Math.min(syncFailures, 5)));
    }
  } finally { syncing = false; }
}

function connect() {
  transport = subscribe(room.topic, { onEvent: receive, onStatus: setConnection, onSync: catchUp });
}

async function migrateCachedHistory() {
  if (migratedOwn) return;
  // Preserve messages already held by this browser without contacting the old
  // relay. The own backend deduplicates retries of these encrypted envelopes.
  const cached = [...records.values()].filter(record => !record.seq && ['sent', 'received'].includes(record.state));
  try {
    for (const record of cached) {
      const event = await publishEnvelope(room.topic, record.envelope);
      record.seq = event.seq;
      seenEvents.add(event.id);
    }
    migratedOwn = true;
  } catch {
    // Keep the encrypted cache and retry this import at the next successful open.
  }
  persist();
}

function setConnection(state) {
  connectionState = state;
  $('connection-status').dataset.state = state;
  $('connection-status').title = 'Conexión al servidor propio de Pasa';
  const labels = { connecting: 'Conectando', connected: 'En línea', reconnecting: 'Reconectando', offline: 'Sin conexión', error: 'Sin conexión' };
  $('connection-label').textContent = labels[state];
  $('retry-connection').hidden = !ready || !['reconnecting', 'offline', 'error'].includes(state);
  if (state === 'connected') { pump(); scheduleRetries(); }
}

async function copyText(text, feedback) {
  try {
    await navigator.clipboard.writeText(text);
    toast(feedback);
    return true;
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = text;
    temporary.className = 'sr-only';
    const host = $('room-dialog').open ? $('room-dialog') : document.body;
    host.append(temporary);
    temporary.select();
    const copied = document.execCommand('copy');
    temporary.remove();
    toast(copied ? feedback : 'Selecciona el texto y usa Copiar en tu navegador.');
    return copied;
  }
}

$('send-form').addEventListener('submit', event => { event.preventDefault(); send(); });
input.addEventListener('input', () => {
  inputVersion++;
  clearTimeout(pasteTimer);
  clearTimeout(draftTimer);
  setInputHint();
  refreshInput();
  draftTimer = setTimeout(saveDraft, 500);
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); }
});
input.addEventListener('paste', () => {
  // The native paste raises an input event first. Schedule after that event.
  setTimeout(() => {
    if ($('auto-send').checked) pasteTimer = setTimeout(send, 250);
  }, 0);
});
$('auto-send').checked = storage.get('pasa.autoSend.v1') !== 'false';
$('auto-send').addEventListener('change', () => {
  clearTimeout(pasteTimer);
  storage.set('pasa.autoSend.v1', String($('auto-send').checked));
});
$('paste-button').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { toast('El portapapeles está vacío.'); return; }
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    if ($('auto-send').checked) send();
  } catch { input.focus(); toast('Pega con Ctrl+V o ⌘V en el cuadro de texto.'); }
});
$('clear-input').addEventListener('click', () => {
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
});
$('clear-output').addEventListener('click', () => {
  hiddenBefore = Date.now();
  // Pending sends stay visible and are never cancelled by clearing local history.
  for (const [id, record] of records) {
    if (!['pending', 'failed'].includes(record.state)) records.delete(id);
  }
  persist();
  render();
  toast('Historial limpiado en este PC');
});
$('load-older').addEventListener('click', async () => {
  if (!ready || loadingOlder) return;
  const previousHiddenBefore = hiddenBefore;
  loadingOlder = true;
  refreshHistoryButton();
  try {
    if (hiddenBefore) {
      hiddenBefore = 0;
      // Cleared records may have been fetched once already. Allow the latest
      // snapshot to restore their visible nodes as well as the server cursor.
      seenEvents.clear();
      await readLatestHistory();
    } else {
      const page = await loadHistory(room.topic, { before: historyBefore, limit: 30 });
      for (const event of page.messages) await receive(event, { announce: false });
      historyBefore = page.nextBefore;
      hasOlder = Boolean(page.hasMore);
    }
    persist();
    render();
  } catch (error) {
    hiddenBefore = previousHiddenBefore;
    toast(error.message || 'No se pudo cargar el historial. Inténtalo de nuevo.');
  }
  finally { loadingOlder = false; refreshHistoryButton(); }
});
$('share-room').addEventListener('click', () => {
  if (!ready) { openJoin(); return; }
  $('room-link').value = location.href;
  $('room-dialog').showModal();
});
$('copy-room-link').addEventListener('click', () => copyText(location.href, 'Enlace copiado. Ábrelo en el otro PC.'));
$('room-link').addEventListener('click', () => $('room-link').select());
$('room-dialog').addEventListener('click', event => { if (event.target === $('room-dialog')) $('room-dialog').close(); });
$('retry-connection').addEventListener('click', () => {
  if (transport) transport.reconnect();
  else location.reload();
});
$('join-form').addEventListener('submit', event => {
  event.preventDefault();
  let secret = $('connection-link').value.trim();
  if (!isRoomSecret(secret)) {
    try {
      const link = new URL(secret);
      if (link.origin !== location.origin || link.pathname !== location.pathname || link.username || link.password) throw new Error();
      secret = link.hash.slice(1).replace(/^r=/, '');
    } catch { secret = ''; }
  }
  if (!isRoomSecret(secret)) {
    $('join-error').textContent = 'Pega el enlace de conexión completo que usas en el otro PC.';
    return;
  }
  history.replaceState(null, '', `${location.pathname}#${secret}`);
  location.reload();
});
window.addEventListener('online', () => { transport?.reconnect(); pump(); scheduleRetries(); });
window.addEventListener('offline', () => setConnection('offline'));
window.addEventListener('hashchange', () => location.reload());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    document.title = 'pasa — De un PC al otro';
    if (connectionState !== 'connected') transport?.reconnect();
    render();
  }
});
window.addEventListener('pagehide', () => { persist(); clearTimeout(syncRetryTimer); transport?.close(); });
window.addEventListener('pageshow', event => {
  if (event.persisted && ready) connect();
});

function openJoin(message = '') {
  $('join-error').textContent = message;
  if (!$('join-dialog').open) $('join-dialog').showModal();
}

async function init() {
  refreshInput();
  refreshHistoryButton();
  if (!crypto.subtle) throw new Error('Abre la app con HTTPS para conectar tus equipos.');
  let secret = location.hash.slice(1).replace(/^r=/, '');
  if (secret && !isRoomSecret(secret)) {
    setConnection('error');
    openJoin('Este enlace no está completo. Pega tu enlace de conexión.');
    return;
  }
  if (!secret) {
    secret = storage.get('pasa.lastRoom.v1');
    if (!isRoomSecret(secret)) {
      setConnection('error');
      openJoin();
      return;
    }
    history.replaceState(null, '', `${location.pathname}${location.search}#${secret}`);
  }
  storage.set('pasa.lastRoom.v1', secret);
  room = await createRoom(secret);
  storageKey = `pasa.history.v1.${room.topic}`;
  const raw = storage.get(storageKey);
  let saved;
  try { saved = JSON.parse(raw); } catch { /* An empty or damaged cache is safe to ignore. */ }
  if (saved?.v === 1) {
    hiddenBefore = Number.isFinite(saved.hiddenBefore) ? saved.hiddenBefore : 0;
    migratedOwn = saved.migratedOwn === true;
    const items = Array.isArray(saved.items) ? saved.items.slice(0, 100) : [];
    await Promise.all(items.map(async item => {
      try {
        const message = await decryptMessage(room.key, item.envelope);
        const allowedStates = ['sent', 'received', 'pending', 'failed'];
        const state = allowedStates.includes(item.state) ? item.state : 'received';
        const seq = Number.isSafeInteger(item.seq) && item.seq > 0 ? item.seq : 0;
        records.set(message.id, { message, envelope: item.envelope, state, seq, attempts: item.attempts || 0, retryable: Boolean(item.retryable), retryAt: Number(item.retryAt) || 0 });
      } catch { /* Skip entries that fail authentication. */ }
    }));
    if (typeof saved.draft === 'string') {
      try {
        const draft = await decryptMessage(room.key, saved.draft);
        if (!input.value) { input.value = draft.text; draftEnvelope = saved.draft; }
      } catch { /* A draft from a different key is never shown. */ }
    }
  }
  render();
  try {
    await readLatestHistory({ seedCursor: true });
  } catch (error) {
    if (error.status === 404 || error.statusCode === 404) {
      setConnection('error');
      openJoin('Abre el enlace privado completo de Pasa que usas en el otro PC.');
      return;
    }
    // An offline open still preserves the local draft and outbox. The socket's
    // first sync recovers all server history once connectivity returns.
    setInputHint('Sin conexión con el servidor. Tus envíos quedan pendientes hasta reconectar.');
  }
  ready = true;
  render();
  refreshInput();
  if (input.value.trim()) saveDraft().catch(() => {});
  connect();
  migrateCachedHistory();
  pump();
}

init().catch(error => {
  setConnection('error');
  setInputHint(error.message);
  toast(error.message, 12000);
});
