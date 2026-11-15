import { createRoom, decryptMessage, encryptMessage, isRoomSecret, loadHistory, loadArchives, MAX_TEXT_BYTES, publishEnvelope, publishArchiveEnvelope, subscribe } from './protocol.js?v=3.1.0';
import { createLinkCard, setPreviewContext } from './preview-cards.js?v=3.1.0';
import { ArchiveState, archiveKey } from './archive-state.js?v=3.1.0';
import { FileShelf } from './shared-files.js?v=3.1.0';
import { messageView } from './message-view.js?v=3.1.0';

const $ = id => document.getElementById(id);
const input = $('message-input');
const output = $('output-list');
const empty = $('empty-state');
const encoder = new TextEncoder();
const records = new Map();
const seenEvents = new Set();
const inFlightEvents = new Set();
const archives = new ArchiveState();
const archiveBusy = new Set();
let archiveReady = false;
let archiveSyncing = false;
let archiveCursor = 0;
let archivedView = false;
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
const fileShelf = new FileShelf({ device, icon, toast, onEvent: event => receive(event, { announce: false }) });

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
  const archiveItems = [];
  let archiveBytes = 0;
  for (const { seq, envelope } of archives.entries().reverse()) {
    if (archiveBytes + envelope.length > 512000) continue;
    archiveBytes += envelope.length;
    archiveItems.push({ seq, envelope });
  }
  const saved = storage.set(storageKey, JSON.stringify({ v: 1, items, archives: archiveItems, hiddenBefore, draft: draftEnvelope, migratedOwn }));
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
  return createLinkCard(url);
}

function displayRecord(record) {
  const { message, state } = record;
  if (!archivedView && message.created <= hiddenBefore && !['pending', 'failed'].includes(state)) {
    const restored = archives.entries().some(({ message: action }) => action.target.id === message.id && !action.archived && action.created > hiddenBefore);
    if (!restored) return null;
  }
  return messageView(message, archives, archivedView);
}

function archiveButton(record, url) {
  const target = { id: record.message.id, seq: record.seq, ...(url ? { url: new URL(url).href } : {}) };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-message archive-message';
  button.disabled = !archiveReady || !record.seq || archiveBusy.has(archiveKey(target));
  button.append(icon(archivedView ? 'restore' : 'archive'), document.createTextNode(archivedView ? 'Restaurar' : 'Archivar'));
  button.setAttribute('aria-label', `${archivedView ? 'Restaurar' : 'Archivar'} ${url ? `link ${url}` : 'mensaje'}`);
  button.title = 'El cambio se sincroniza con el otro equipo';
  button.addEventListener('click', () => setArchived(record, { ...target, seq: record.seq }, !archivedView));
  return button;
}

async function setArchived(record, target, archived) {
  const key = archiveKey(target);
  if (!archiveReady || archiveBusy.has(key)) return;
  archiveBusy.add(key);
  record.node = null;
  render();
  try {
    const message = { v: 1, kind: 'archive', id: crypto.randomUUID(), device, created: Date.now(), text: '', target, archived };
    const envelope = await encryptMessage(room.key, message);
    await receive(await publishArchiveEnvelope(room.topic, envelope), { announce: false });
    toast(archived ? 'Archivado. Puedes recuperarlo en Archivados.' : 'Restaurado en ambos equipos.');
  } catch (error) { toast(error.message || 'No se pudo guardar el cambio.', 6000); }
  finally { archiveBusy.delete(key); record.node = null; render(); }
}

function renderRecord(record, fresh) {
  const { message, state } = record;
  const display = displayRecord(record);
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
  if (display.text) {
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = display.text;
    body.append(text);
  }
  if (display.visibleLinks.length) {
    const cards = document.createElement('div');
    cards.className = 'link-cards';
    display.visibleLinks.forEach(url => {
      const item = document.createElement('div');
      item.className = 'link-item';
      item.append(linkCard(url), archiveButton(record, url));
      cards.append(item);
    });
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
  copy.addEventListener('click', () => copyText(display.copy, 'Texto copiado'));
  buttons.append(copy);
  if (!display.links.length) buttons.append(archiveButton(record));
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
  card.querySelectorAll('.archive-message').forEach(button => { button.disabled = !archiveReady || !record.seq || archiveBusy.size > 0; });
  const error = card.querySelector('.message-error');
  error.textContent = record.error || '';
  error.hidden = record.state !== 'failed' || !record.error;
  return card;
}

function render(freshId) {
  const visible = [...records.values()].filter(record => displayRecord(record)).sort((a, b) => b.message.created - a.message.created);
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
  $('clear-output').disabled = !visible.length || archivedView;
  empty.querySelector('h3').textContent = archivedView ? 'Tus links archivados, a mano' : 'Aquí aparece lo que compartes';
  empty.querySelector('p').textContent = archivedView ? 'Lo que archives aparece aquí. Pulsa Restaurar para devolverlo a tus links activos.' : 'Abre este mismo enlace en los dos PCs. Lo que envíes en uno, lo recibes en el otro.';
  empty.querySelector('.empty-shortcut').hidden = archivedView;
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
    if (message.kind === 'archive') {
      if (archives.apply(message, event.seq, envelope)) {
        const target = records.get(message.target.id);
        if (target) target.node = null;
        persist();
        render();
        if (archivedView && message.archived && !target && message.target.seq) {
          loadHistory(room.topic, { before: message.target.seq + 1, limit: 1 })
            .then(async page => { for (const item of page.messages) await receive(item, { announce: false }); })
            .catch(() => { $('archive-status').textContent = 'No se pudo cargar un link archivado.'; $('retry-archives').hidden = false; });
        }
      }
      return;
    }
    if (message.kind === 'file') fileShelf.accept(message);
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

async function syncArchives() {
  if (archiveSyncing) return;
  archiveSyncing = true;
  $('archive-status').textContent = 'Sincronizando archivados…';
  $('retry-archives').hidden = true;
  try {
    while (true) {
      const page = await loadArchives(room.topic, { after: archiveCursor, limit: 50 });
      for (const event of page.messages) await receive(event, { announce: false });
      if (page.nextAfter > archiveCursor) archiveCursor = page.nextAfter;
      else if (page.hasMore) throw new Error('No se pudo recuperar el archivo. Reintenta.');
      if (!page.hasMore) break;
    }
    // An archive may refer to an original beyond the latest history page.
    for (const { message } of archives.entries()) {
      if (!message.archived || !message.target.seq || records.has(message.target.id)) continue;
      const page = await loadHistory(room.topic, { before: message.target.seq + 1, limit: 1 });
      for (const event of page.messages) await receive(event, { announce: false });
    }
    archiveReady = true;
    $('archive-status').textContent = '';
  } catch (error) {
    $('archive-status').textContent = error.message || 'No se pudieron sincronizar los archivados.';
    $('retry-archives').hidden = false;
  } finally { archiveSyncing = false; render(); }
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
  transport = subscribe(room.topic, { onEvent: receive, onStatus: setConnection, onSync: latest => { catchUp(latest); syncArchives(); } });
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
    if (!['pending', 'failed'].includes(record.state) && record.message.kind !== 'file') records.delete(id);
  }
  seenEvents.clear();
  persist();
  render();
  toast('Historial limpiado en este PC');
});
$('retry-archives').addEventListener('click', syncArchives);
for (const [id, isArchive] of [['show-active', false], ['show-archived', true]]) {
  $(id).addEventListener('click', () => {
    archivedView = isArchive;
    $('show-active').setAttribute('aria-pressed', String(!isArchive));
    $('show-archived').setAttribute('aria-pressed', String(isArchive));
    for (const record of records.values()) record.node = null;
    output.scrollTop = 0;
    render();
    if (isArchive) syncArchives();
  });
}
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
  setPreviewContext(room.topic);
  storageKey = `pasa.history.v1.${room.topic}`;
  const raw = storage.get(storageKey);
  let saved;
  try { saved = JSON.parse(raw); } catch { /* An empty or damaged cache is safe to ignore. */ }
  if (saved?.v === 1) {
    hiddenBefore = Number.isFinite(saved.hiddenBefore) ? saved.hiddenBefore : 0;
    migratedOwn = saved.migratedOwn === true;
    if (Array.isArray(saved.archives)) {
      for (const item of saved.archives) {
        try {
          const message = await decryptMessage(room.key, item.envelope);
          if (message.kind === 'archive') archives.apply(message, item.seq, item.envelope);
        } catch { /* Authenticate cached archive states before applying. */ }
      }
    }
    const items = Array.isArray(saved.items) ? saved.items.slice(0, 100) : [];
    await Promise.all(items.map(async item => {
      try {
        const message = await decryptMessage(room.key, item.envelope);
        const allowedStates = ['sent', 'received', 'pending', 'failed'];
        const state = allowedStates.includes(item.state) ? item.state : 'received';
        const seq = Number.isSafeInteger(item.seq) && item.seq > 0 ? item.seq : 0;
        records.set(message.id, { message, envelope: item.envelope, state, seq, attempts: item.attempts || 0, retryable: Boolean(item.retryable), retryAt: Number(item.retryAt) || 0 });
        if (message.kind === 'file') fileShelf.accept(message);
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
  await syncArchives();
  fileShelf.connect(room);
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
