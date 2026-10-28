import { createRoom, decryptMessage, encryptMessage, envelopeFromEvent, HISTORY_MS, isRoomSecret, MAX_TEXT_BYTES, newSecret, publishEnvelope, subscribe } from './protocol.js';
import { describeLink, extractLinks } from './links.js';

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
  if (!storageKey) return;
  const cutoff = Date.now() - HISTORY_MS;
  const sorted = [...records.values()].sort((a, b) => b.message.created - a.message.created);
  const items = [];
  let size = 0;
  for (const record of sorted) {
    if (record.message.created < cutoff && record.state !== 'pending' && record.state !== 'failed') {
      records.delete(record.message.id);
      continue;
    }
    size += record.envelope.length;
    if (items.length >= 100 || size > 3000000) continue;
    items.push({ envelope: record.envelope, state: record.state, retryable: record.retryable, retryAt: record.retryAt, attempts: record.attempts || 0 });
  }
  const saved = storage.set(storageKey, JSON.stringify({ v: 1, items, hiddenBefore, draft: draftEnvelope }));
  if (!saved && !retentionWarning) {
    retentionWarning = true;
    toast('El navegador no pudo guardar el historial local. La sincronización sigue disponible.', 6000);
  }
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
  time.textContent = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(message.created);
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
    retry.hidden = state !== 'failed' || record.expired;
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
  card.querySelector('.retry-message').hidden = record.state !== 'failed' || record.expired;
  const error = card.querySelector('.message-error');
  error.textContent = record.error || '';
  error.hidden = record.state !== 'failed' || !record.error;
  return card;
}

function render(freshId) {
  const cutoff = Math.max(hiddenBefore, Date.now() - HISTORY_MS);
  const visible = [...records.values()].filter(record => record.message.created > cutoff || ['pending', 'failed'].includes(record.state)).sort((a, b) => b.message.created - a.message.created);
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
  } catch { toast('No se pudo preparar el texto. Inténtalo de nuevo.'); }
  finally { preparing = false; refreshInput(); }
}

async function pump() {
  if (pumping || !ready || !navigator.onLine) return;
  pumping = true;
  try {
    const pending = [...records.values()].filter(record => record.state === 'pending').sort((a, b) => a.message.created - b.message.created);
    for (const record of pending) {
      if (record.state !== 'pending') continue;
      if (record.message.created < Date.now() - HISTORY_MS) {
        record.state = 'failed';
        record.expired = true;
        record.retryable = false;
        record.error = 'Este envío pendiente tiene más de 12 horas. Copia el texto y envíalo de nuevo.';
        persist();
        render();
        continue;
      }
      try {
        record.attempts++;
        const event = await publishEnvelope(room.topic, record.envelope);
        seenEvents.add(event.id);
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

async function receive(event, attempt = 0) {
  if (seenEvents.has(event.id) || inFlightEvents.has(event.id)) return;
  inFlightEvents.add(event.id);
  try {
    const envelope = await envelopeFromEvent(event);
    if (!envelope) return;
    const message = await decryptMessage(room.key, envelope);
    if (message.created < Date.now() - HISTORY_MS) return;
    seenEvents.add(event.id);
    if (seenEvents.size > 500) seenEvents.delete(seenEvents.values().next().value);
    const existing = records.get(message.id);
    if (existing) {
      if (existing.state === 'pending' || existing.state === 'failed') {
        existing.state = 'sent';
        existing.retryable = false;
        existing.error = '';
        persist();
        render();
      }
      return;
    }
    records.set(message.id, { message, envelope, state: message.device === device ? 'sent' : 'received', attempts: 0 });
    persist();
    render(message.id);
    if (document.hidden && message.device !== device) document.title = '• Nuevo texto | pasa';
  } catch (error) {
    // Invalid ciphertext is ignored. A failed attachment download can be retried.
    if (error.retryable && attempt < 2) setTimeout(() => receive(event, attempt + 1), 3000 * (attempt + 1));
    else if (error.name === 'RelayError' || error.message.includes('expiró')) toast(error.message, 6000);
  } finally { inFlightEvents.delete(event.id); }
}

function setConnection(state) {
  connectionState = state;
  $('connection-status').dataset.state = state;
  $('connection-status').title = 'Conexión al servicio de sincronización';
  const labels = { connecting: 'Conectando', connected: 'En línea', reconnecting: 'Reconectando', offline: 'Sin conexión', error: 'Sin conexión' };
  $('connection-label').textContent = labels[state];
  $('retry-connection').hidden = !['reconnecting', 'offline', 'error'].includes(state);
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
$('share-room').addEventListener('click', () => {
  $('room-link').value = location.href;
  $('room-dialog').showModal();
});
$('copy-room-link').addEventListener('click', () => copyText(location.href, 'Enlace copiado. Ábrelo en el otro PC.'));
$('room-link').addEventListener('click', () => $('room-link').select());
$('room-dialog').addEventListener('click', event => { if (event.target === $('room-dialog')) $('room-dialog').close(); });
$('retry-connection').addEventListener('click', () => transport?.reconnect());
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
window.addEventListener('pagehide', () => { persist(); transport?.close(); });
window.addEventListener('pageshow', event => {
  if (event.persisted && ready) transport = subscribe(room.topic, { onEvent: receive, onStatus: setConnection });
});

async function init() {
  refreshInput();
  if (!crypto.subtle) throw new Error('Abre la app con HTTPS para conectar tus equipos.');
  let secret = location.hash.slice(1).replace(/^r=/, '');
  if (secret && !isRoomSecret(secret)) throw new Error('Este enlace de conexión no es válido. Abre el enlace completo que copiaste.');
  if (!secret) {
    secret = storage.get('pasa.lastRoom.v1');
    if (!isRoomSecret(secret)) secret = newSecret();
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
    const items = Array.isArray(saved.items) ? saved.items.slice(0, 100) : [];
    await Promise.all(items.map(async item => {
      try {
        const message = await decryptMessage(room.key, item.envelope);
        const allowedStates = ['sent', 'received', 'pending', 'failed'];
        let state = allowedStates.includes(item.state) ? item.state : 'received';
        const expired = message.created < Date.now() - HISTORY_MS;
        if (expired && !['pending', 'failed'].includes(state)) return;
        if (expired) state = 'failed';
        records.set(message.id, { message, envelope: item.envelope, state, attempts: item.attempts || 0, retryable: !expired && Boolean(item.retryable), retryAt: Number(item.retryAt) || 0, expired,
          error: expired ? 'Este envío pendiente tiene más de 12 horas. Copia el texto y envíalo de nuevo.' : '' });
      } catch { /* Skip entries that fail authentication. */ }
    }));
    if (typeof saved.draft === 'string') {
      try {
        const draft = await decryptMessage(room.key, saved.draft);
        if (draft.created > Date.now() - HISTORY_MS && !input.value) { input.value = draft.text; draftEnvelope = saved.draft; }
      } catch { /* A draft from a different key is never shown. */ }
    }
  }
  ready = true;
  render();
  refreshInput();
  transport = subscribe(room.topic, { onEvent: receive, onStatus: setConnection });
  pump();
}

init().catch(error => {
  setConnection('error');
  setInputHint(error.message);
  toast(error.message, 12000);
});
