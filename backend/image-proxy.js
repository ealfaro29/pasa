import { fetchPublicResource, validatePublicURL, PreviewError } from './preview.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_MS = 7 * 24 * 60 * 60 * 1000;
const RASTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

function encode(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new PreviewError(400, 'Imagen no válida');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

async function keyFrom(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new PreviewError(503, 'Las imágenes todavía no están disponibles');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signImage(imageURL, room, secret, now = Date.now()) {
  const url = validatePublicURL(imageURL);
  const payload = encode(encoder.encode(JSON.stringify({ u: url.href, r: room, e: now + TOKEN_MS })));
  const signature = await crypto.subtle.sign('HMAC', await keyFrom(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function verifyImage(token, room, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 10000) throw new PreviewError(400, 'Imagen no válida');
  const parts = token.split('.');
  if (parts.length !== 2) throw new PreviewError(400, 'Imagen no válida');
  try {
    const valid = await crypto.subtle.verify('HMAC', await keyFrom(secret), decode(parts[1]), encoder.encode(parts[0]));
    if (!valid) throw new Error();
    const data = JSON.parse(decoder.decode(decode(parts[0])));
    if (data.r !== room || !Number.isSafeInteger(data.e) || data.e <= now || data.e > now + TOKEN_MS + 60000) throw new Error();
    return validatePublicURL(data.u).href;
  } catch (error) {
    if (error instanceof PreviewError && error.status === 503) throw error;
    throw new PreviewError(403, 'La imagen ha caducado o no pertenece a este espacio');
  }
}

export async function loadPreviewImage(token, room, secret, { fetcher = fetch, cache = globalThis.caches?.default } = {}) {
  const url = await verifyImage(token, room, secret);
  const digest = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(url))));
  const cacheKey = new Request(`https://pasa-preview-cache.invalid/image/${digest}`);
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch { /* Cache eviction must never break a preview. */ }
  }
  const { response, bytes } = await fetchPublicResource(url, {
    fetcher, accept: 'image/avif,image/webp,image/*;q=0.8', maxBytes: 4 * 1024 * 1024, timeoutMs: 12000,
  });
  if (!response.ok) throw new PreviewError(502, 'La imagen no está disponible');
  const type = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (!RASTER_TYPES.has(type)) throw new PreviewError(415, 'Esta página no ofrece una imagen compatible');
  const image = new Response(bytes, { headers: {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
  if (cache) {
    try { await cache.put(cacheKey, image.clone()); } catch { /* A full cache is safe to ignore. */ }
  }
  return image;
}
