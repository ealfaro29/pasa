import { API_ORIGIN } from './config.js?v=3.0.0';
import { describeLink } from './links.js?v=3.0.0';

const CACHE_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
const inFlight = new Map();
const queue = [];
let topic = null;
let active = 0;

const marks = {
  amazon: 'a', youtube: '▶', github: 'GH', instagram: '◎', x: '𝕏',
  tiktok: '♪', notion: 'N', figma: 'F', docs: 'D', sheets: 'S',
  slides: 'P', drive: '△', canva: 'C', linkedin: 'in', spotify: '≋', wikipedia: 'W',
};

function plain(value, max = 240) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

/** Private documents and credentials are never submitted for a preview. */
export function canPreviewLink(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/u.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|onion|test|invalid|example)$/.test(host)) return false;
  if (['docs.google.com', 'drive.google.com'].includes(host) || /\/(?:edit|admin|login|signin|settings|oauth|reset-password)(?:\/|$)/i.test(url.pathname)) return false;
  for (const key of url.searchParams.keys()) {
    if (/^(?:access[_-]?token|token|password|passwd|secret|auth|authorization|api[_-]?key|key|signature|sig|session|sid|jwt|code|credential|x-amz-(?:credential|signature|security-token))$/i.test(key)) return false;
  }
  return true;
}

function publicPreviewURL(value) {
  const url = new URL(value);
  // A fragment can carry a document key. It is not needed to fetch page metadata.
  url.hash = '';
  return url.href;
}

export function setPreviewContext(roomTopic) {
  topic = /^pasa_[a-f0-9]{56}$/.test(roomTopic || '') ? roomTopic : null;
  pump();
}

function remember(url, value) {
  cache.set(url, { value, expires: Date.now() + (value ? CACHE_MS : NEGATIVE_CACHE_MS) });
  while (cache.size > 200) cache.delete(cache.keys().next().value);
}

async function fetchPreview(url, roomTopic) {
  try {
    const response = await fetch(`${API_ORIGIN}/api/rooms/${roomTopic}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('Content-Length'));
    if (declared > 32000) return null;
    const text = await response.text();
    if (text.length > 32000) return null;
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch { return null; }
}

function pump() {
  while (topic && active < 3 && queue.length) {
    const job = queue.shift();
    const roomTopic = topic;
    active++;
    fetchPreview(job.url, roomTopic).then(value => {
      remember(job.url, value);
      job.resolve(value);
    }).finally(() => {
      inFlight.delete(job.url);
      active--;
      pump();
    });
  }
}

function preview(value) {
  const url = publicPreviewURL(value);
  const saved = cache.get(url);
  if (saved && saved.expires > Date.now()) return Promise.resolve(saved.value);
  if (inFlight.has(url)) return inFlight.get(url);
  const promise = new Promise(resolve => queue.push({ url, resolve }));
  inFlight.set(url, promise);
  pump();
  return promise;
}

function span(className, text = '') {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function arrow() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('link-card-external');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7 17 17 7M7 7h10v10');
  svg.append(path);
  return svg;
}

function safeImage(value) {
  try {
    const url = new URL(value);
    return url.origin === new URL(API_ORIGIN).origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function kindLabel(kind) {
  return { product: 'Producto', article: 'Artículo', video: 'Video' }[kind] || 'Enlace';
}

/** Render immediately, then enrich the same node when the own backend replies. */
export function createLinkCard(url) {
  const info = describeLink(url);
  const platform = info.platform.toLowerCase().replace(/^google /, '').replaceAll(' ', '-');
  const initialKind = info.kind === 'product' ? 'product' : ['video', 'short'].includes(info.kind) ? 'video' : 'website';
  const card = document.createElement('a');
  card.className = 'link-card preview-card';
  card.dataset.platform = platform;
  card.dataset.kind = initialKind;
  card.href = info.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.title = info.url;
  const media = span('link-card-media');
  media.setAttribute('aria-hidden', 'true');
  const mark = span('link-card-brandmark', marks[platform] || info.provider.slice(0, 1).toUpperCase());
  const image = document.createElement('img');
  image.className = 'link-card-image';
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.hidden = true;
  media.append(mark, image);

  const content = span('link-card-content');
  const topline = span('link-card-topline');
  const provider = span('link-card-provider', info.provider);
  const type = span('link-card-type', kindLabel(initialKind));
  topline.append(provider, type);
  const title = span('link-card-title', info.title);
  const description = span('link-card-description');
  description.hidden = true;
  const price = span('link-card-price');
  price.hidden = true;
  const footer = span('link-card-footer');
  const domain = span('link-card-domain', info.domain);
  const cta = span('link-card-cta', initialKind === 'product' ? 'Ver producto' : 'Abrir');
  cta.append(arrow());
  footer.append(domain, cta);
  content.append(topline, title, description, price, footer);
  card.append(media, content);
  const accessibleTitle = () => card.setAttribute('aria-label', `${provider.textContent}: ${title.textContent}. Abrir en otra pestaña`);
  accessibleTitle();

  image.addEventListener('load', () => {
    image.hidden = false;
    mark.hidden = true;
    card.classList.add('has-image');
  });
  image.addEventListener('error', () => {
    image.hidden = true;
    image.removeAttribute('src');
    mark.hidden = false;
    card.classList.remove('has-image');
  });

  if (canPreviewLink(url)) {
    card.classList.add('is-loading');
    card.setAttribute('aria-busy', 'true');
    preview(url).then(data => {
      if (!data) return;
      const receivedTitle = plain(data.title, 260);
      if (receivedTitle && !/^(?:robot check|access denied|just a moment|captcha|verify (?:that )?you are human|sign in|acceso denegado)/i.test(receivedTitle)) {
        title.textContent = receivedTitle;
      }
      const site = plain(data.siteName, 60);
      if (site) provider.textContent = site;
      const kind = initialKind === 'product' ? 'product' : ['product', 'article', 'video', 'website'].includes(data.kind) ? data.kind : initialKind;
      card.dataset.kind = kind;
      type.textContent = kindLabel(kind);
      cta.firstChild.textContent = kind === 'product' ? 'Ver producto' : kind === 'article' ? 'Leer artículo' : 'Abrir';
      const detail = plain(data.description, 280);
      if (detail && detail !== title.textContent) { description.textContent = detail; description.hidden = false; }
      const amount = plain(data.price, 60);
      if (amount && kind === 'product') { price.textContent = amount; price.hidden = false; }
      const source = safeImage(data.image);
      if (source) { image.hidden = false; image.src = source; }
      accessibleTitle();
    }).finally(() => {
      card.classList.remove('is-loading');
      card.removeAttribute('aria-busy');
    });
  }
  return card;
}
