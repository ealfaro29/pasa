import { Parser } from 'htmlparser2';

const HTML_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const AMAZON_DOMAINS = new Set(['amazon.com', 'amazon.ca', 'amazon.com.mx', 'amazon.com.br', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.es', 'amazon.it', 'amazon.nl', 'amazon.se', 'amazon.pl', 'amazon.com.be', 'amazon.ie', 'amazon.com.tr', 'amazon.in', 'amazon.co.jp', 'amazon.com.au', 'amazon.sg', 'amazon.ae', 'amazon.sa', 'amazon.eg', 'amazon.co.za']);
const SECRET_KEY = /^(?:token|access[_-]?token|id[_-]?token|password|passwd|api[_-]?key|key|secret|signature|sig|x-amz-(?:signature|credential|security-token)|auth|authorization|code|session|sessionid)$/i;

export class PreviewError extends Error {
  constructor(status, message) { super(message); this.name = 'PreviewError'; this.status = status; }
}

export function validatePublicURL(input) {
  if (typeof input !== 'string' || input.length > 8192 || !input || input !== input.trim() || /[\u0000-\u0020\u007f\\]/u.test(input)) throw new PreviewError(400, 'Enlace no válido');
  let url;
  try { url = new URL(input); } catch { throw new PreviewError(400, 'Enlace no válido'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(input)) throw new PreviewError(400, 'Solo se admiten enlaces públicos');
  if (url.port) throw new PreviewError(400, 'Puerto no permitido');
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^\d+(?:\.\d+){0,3}$/.test(host) || host.endsWith('.') || host.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
      /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|test|invalid|example|onion)$/.test(host)) throw new PreviewError(400, 'El enlace debe ser público');
  for (const key of url.searchParams.keys()) if (SECRET_KEY.test(key)) throw new PreviewError(400, 'No se generan vistas previas de enlaces privados');
  url.protocol = 'https:';
  url.hash = '';
  return url;
}

function amazonDomain(host) {
  return [...AMAZON_DOMAINS].find(domain => host === domain || host.endsWith('.' + domain)) || null;
}

function asinFrom(url) {
  return /\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:[/?]|$)/i.exec(url.pathname)?.[1]?.toUpperCase() || null;
}

export function normalizePreviewURL(input) {
  const url = validatePublicURL(input);
  const domain = amazonDomain(url.hostname);
  const asin = domain && asinFrom(url);
  return asin ? 'https://www.' + domain + '/dp/' + asin : url.href;
}

function text(value, limit = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function safeRelatedURL(input, base) {
  if (typeof input !== 'string' || !input.trim()) return null;
  try { return validatePublicURL(new URL(input.trim(), base).href).href; } catch { return null; }
}

function fallback(url, unavailable = false) {
  const parsed = validatePublicURL(url);
  const domain = amazonDomain(parsed.hostname);
  const asin = domain && asinFrom(parsed);
  return { url: parsed.href, canonicalUrl: parsed.href, title: domain ? 'Producto en Amazon' : parsed.hostname.replace(/^www\./, ''), description: '', siteName: domain ? 'Amazon' : parsed.hostname.replace(/^www\./, ''), image: null, kind: domain && asin ? 'product' : 'website', price: null, ...(asin ? { asin } : {}), ...(unavailable ? { unavailable: true } : {}) };
}

function challengeHTML(html) {
  return /<title[^>]*>[\s\S]{0,200}?(?:robot check|captcha|access denied|just a moment|attention required|service unavailable|503 service)[\s\S]{0,200}?<\/title>/i.test(html) ||
    /id=["'](?:captchacharacters|challenge-form|cf-challenge-running)["']/i.test(html) ||
    /Sorry, we just need to make sure you(?:'|&#39;|&apos;)re not a robot|Type the characters you see in this image|Enter the characters you see below/i.test(html);
}

function largestDynamicImage(value, base) {
  try {
    const images = JSON.parse(value);
    return Object.entries(images).map(([url, size]) => ({ url: safeRelatedURL(url, base), area: Array.isArray(size) ? Number(size[0]) * Number(size[1]) : 0 }))
      .filter(entry => entry.url).sort((a, b) => b.area - a.area)[0]?.url || null;
  } catch { return null; }
}

function productNodes(value) {
  const nodes = [];
  function walk(node, depth = 0) {
    if (!node || depth > 10 || nodes.length > 200) return;
    if (Array.isArray(node)) { node.slice(0, 80).forEach(item => walk(item, depth + 1)); return; }
    if (typeof node !== 'object') return;
    nodes.push(node);
    if (node['@graph']) walk(node['@graph'], depth + 1);
    if (node.mainEntity) walk(node.mainEntity, depth + 1);
    if (node.itemListElement) walk(node.itemListElement, depth + 1);
    if (node.item) walk(node.item, depth + 1);
  }
  walk(value);
  return nodes;
}

function isType(node, name) {
  return [node?.['@type']].flat().some(type => typeof type === 'string' && type.split(/[\/#]/).at(-1).toLowerCase() === name.toLowerCase());
}

function schemaImage(value, base) {
  for (const image of [value].flat()) {
    const candidate = typeof image === 'string' ? image : image?.url || image?.contentUrl;
    const valid = safeRelatedURL(candidate, base);
    if (valid) return valid;
  }
  return null;
}

function money(amount, currency) {
  const value = text(String(amount ?? ''), 64);
  if (!value || !/^\d+(?:[.,]\d+)?$/.test(value)) return null;
  const code = /^[a-z]{3}$/i.test(currency || '') ? currency.toUpperCase() : '';
  if (!code) return value;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(Number(value.replace(',', '.'))); }
  catch { return code + ' ' + value; }
}

export function parseMetadata(html, pageUrl) {
  const page = validatePublicURL(pageUrl);
  const result = fallback(page.href);
  if (typeof html !== 'string' || challengeHTML(html)) return { ...result, unavailable: true };
  const meta = new Map();
  const captures = [];
  const texts = { title: '', h1: '', productTitle: '', price: '' };
  const scripts = [];
  let scriptBudget = 0;
  let depth = 0;
  let canonical = null;
  let primaryImage = null;
  let alternateImage = null;
  const priceContainers = [];
  const parser = new Parser({
    onopentag(name, attrs) {
      depth++;
      const id = (attrs.id || '').toLowerCase();
      const classes = (attrs.class || '').split(/\s+/);
      if (name === 'meta') {
        const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
        const value = attrs.content || '';
        if (key && value && !meta.has(key)) meta.set(key, value);
      }
      if (name === 'link') {
        if ((attrs.rel || '').split(/\s+/).includes('canonical')) canonical ||= safeRelatedURL(attrs.href, page.href);
        if ((attrs.rel || '').split(/\s+/).includes('image_src')) alternateImage ||= safeRelatedURL(attrs.href, page.href);
      }
      if (name === 'title' && !texts.title) captures.push({ kind: 'title', depth, value: '', max: 1000 });
      if (name === 'h1' && !texts.h1) captures.push({ kind: 'h1', depth, value: '', max: 1000 });
      if (id === 'producttitle') captures.push({ kind: 'productTitle', depth, value: '', max: 2000 });
      if (['corepricedisplay_desktop_feature_div', 'coreprice_feature_div', 'apex_desktop'].includes(id)) priceContainers.push(depth);
      if (['priceblock_ourprice', 'priceblock_dealprice', 'priceblock_saleprice', 'price_inside_buybox', 'pasa-preview-price'].includes(id) ||
          (classes.includes('a-offscreen') && priceContainers.length)) captures.push({ kind: 'price', depth, value: '', max: 100 });
      if (name === 'script' && (attrs.type || '').toLowerCase() === 'application/ld+json' && scripts.length < 12 && scriptBudget < 262144) captures.push({ kind: 'json', depth, value: '', max: Math.min(131072, 262144 - scriptBudget) });
      if (name === 'img' && ['landingimage', 'imgblkfront', 'ebooksimgblkfront', 'pasa-preview-product-image'].includes(id)) {
        primaryImage ||= safeRelatedURL(attrs['data-old-hires'], page.href) || largestDynamicImage(attrs['data-a-dynamic-image'], page.href) || safeRelatedURL(attrs.src, page.href);
      }
      if (name === 'input' && ['displayedPrice', 'priceValue'].includes(attrs.name || attrs.id)) {
        const value = text(attrs.value, 80);
        if (/(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|MXN|INR)\b)\s*[\d.,]+|[\d.,]+\s*(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|MXN|INR)\b)/i.test(value)) texts.price ||= value;
      }
    },
    ontext(value) {
      for (const capture of captures) if (capture.value.length < capture.max) capture.value += value.slice(0, capture.max - capture.value.length);
    },
    onclosetag() {
      for (let index = captures.length - 1; index >= 0; index--) {
        const capture = captures[index];
        if (capture.depth !== depth) continue;
        if (capture.kind === 'json') { scripts.push(capture.value); scriptBudget += capture.value.length; }
        else if (capture.kind === 'price') {
          const price = text(capture.value, 80);
          if (/(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|MXN|INR)\b)\s*[\d.,]+|[\d.,]+\s*(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|MXN|INR)\b)/i.test(price)) texts.price ||= price;
        } else texts[capture.kind] ||= text(capture.value, 1000);
        captures.splice(index, 1);
      }
      while (priceContainers.at(-1) === depth) priceContainers.pop();
      depth--;
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(html);
  const nodes = [];
  for (const script of scripts) { try { nodes.push(...productNodes(JSON.parse(script))); } catch {} }
  const product = nodes.find(node => isType(node, 'Product'));
  const article = nodes.find(node => ['Article', 'NewsArticle', 'BlogPosting'].some(type => isType(node, type)));
  const video = nodes.find(node => isType(node, 'VideoObject'));
  const structured = product || article || video;
  const domain = amazonDomain(page.hostname);
  result.canonicalUrl = canonical || safeRelatedURL(meta.get('og:url'), page.href) || page.href;
  result.title = text((domain && texts.productTitle) || structured?.name || structured?.headline || meta.get('og:title') || meta.get('twitter:title') || texts.title || texts.h1 || result.title, 320);
  result.description = text(structured?.description || meta.get('og:description') || meta.get('twitter:description') || meta.get('description'), 600);
  result.siteName = domain ? 'Amazon' : text(meta.get('og:site_name') || meta.get('application-name') || result.siteName, 80);
  result.image = (domain && primaryImage) || schemaImage(structured?.image || structured?.thumbnailUrl, page.href) ||
    safeRelatedURL(meta.get('og:image:secure_url') || meta.get('og:image') || meta.get('twitter:image') || meta.get('twitter:image:src'), page.href) || alternateImage || primaryImage || null;
  const type = (meta.get('og:type') || '').toLowerCase();
  result.kind = product || (domain && result.asin) || type.includes('product') ? 'product' : article || type === 'article' ? 'article' : video || type.startsWith('video') ? 'video' : 'website';
  const offers = [product?.offers].flat().find(value => value && typeof value === 'object');
  result.price = money(offers?.price ?? offers?.lowPrice ?? meta.get('product:price:amount'), offers?.priceCurrency || meta.get('product:price:currency')) || (domain ? texts.price || null : null);
  const author = structured?.author;
  const byline = Array.isArray(author) ? author.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).join(', ') : typeof author === 'string' ? author : author?.name;
  const authorText = text(byline || meta.get('author'), 160);
  if (authorText) result.author = authorText;
  return result;
}

function publicIPv4(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  if ([a, b, c, d].some(part => part > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

function publicIPv6(value) {
  const address = value.toLowerCase();
  return /^[23][0-9a-f]{0,3}:[0-9a-f:]+$/.test(address) && !/^2001:(?:db8|0|10|20):/.test(address) && !address.startsWith('2002:');
}

async function boundedBytes(response, maxBytes) {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > maxBytes) { await response.body?.cancel(); throw new PreviewError(413, 'La vista previa es demasiado grande'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) { await reader.cancel(); throw new PreviewError(413, 'La vista previa es demasiado grande'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function checkPublicDNS(host, fetcher, signal) {
  const lookups = await Promise.all(['A', 'AAAA'].map(async type => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', host); url.searchParams.set('type', type);
    const response = await fetcher(url.href, { redirect: 'manual', signal, credentials: 'omit', headers: { Accept: 'application/dns-json' } });
    if (!response.ok) throw new PreviewError(502, 'No se pudo verificar el enlace');
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536))); }
    catch (error) { if (error instanceof PreviewError) throw error; throw new PreviewError(502, 'No se pudo verificar el enlace'); }
    if (data.Status !== 0 || !Array.isArray(data.Answer || [])) throw new PreviewError(422, 'No se pudo resolver el enlace público');
    return (data.Answer || []).filter(answer => answer.type === 1 || answer.type === 28);
  }));
  const answers = lookups.flat();
  if (!answers.length || answers.length > 64 || answers.some(answer => typeof answer.data !== 'string' ||
    !(answer.type === 1 ? publicIPv4(answer.data) : publicIPv6(answer.data)))) throw new PreviewError(400, 'El enlace debe resolver a una dirección pública');
}

export async function fetchPublicResource(input, { fetcher = fetch, accept = 'text/html,application/xhtml+xml', maxBytes = HTML_BYTES, timeoutMs = 12000 } = {}) {
  let url = validatePublicURL(typeof input === 'string' ? input : input?.href);
  const signal = AbortSignal.timeout(Math.max(1, Math.min(30000, timeoutMs)));
  const checked = new Set();
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (!checked.has(url.hostname)) { await checkPublicDNS(url.hostname, fetcher, signal); checked.add(url.hostname); }
      const response = await fetcher(url.href, {
        method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
        headers: { 'User-Agent': 'Pasa-LinkPreview/3.0 (+https://github.com/ealfaro29/pasa)', Accept: accept },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects === 4) throw new PreviewError(422, 'El enlace tiene demasiadas redirecciones');
        const location = response.headers.get('Location');
        if (!location) throw new PreviewError(422, 'No se pudo resolver la redirección');
        url = validatePublicURL(new URL(location, url).href);
        continue;
      }
      return { url: url.href, response, bytes: await boundedBytes(response, maxBytes) };
    }
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError(signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502, 'No se pudo cargar la vista previa');
  }
  throw new PreviewError(422, 'No se pudo resolver el enlace');
}

function escapeHTML(value) { return String(value).replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

// Workers use their native parser for the large source document; only selected
// metadata reaches the JavaScript parser. Node tests use the same pure parser.
async function compactNativeMetadata(bytes) {
  if (typeof HTMLRewriter === 'undefined') return new TextDecoder().decode(bytes);
  const pieces = [];
  let total = 0;
  function add(value) { if (total + value.length <= 300000) { pieces.push(value); total += value.length; } }
  const attrs = (name, values) => '<' + name + ' ' + Object.entries(values).filter(([, value]) => value !== null).map(([key, value]) => key + '="' + escapeHTML(value) + '"').join(' ') + '>';
  const capture = (tag, attributes = {}) => {
    let content = '';
    return {
      element(element) {
        content = '';
        // Amazon occasionally reuses a selected ID on a void input element.
        // Such a node has no text or end tag and must not abort all metadata.
        if (['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(element.tagName)) return;
        element.onEndTag(() => add(attrs(tag, attributes) + escapeHTML(content) + '</' + tag + '>'));
      },
      text(chunk) { if (content.length < 3000) content += chunk.text.slice(0, 3000 - content.length); },
    };
  };
  let script = '';
  const rewriter = new HTMLRewriter()
    .on('meta', { element(element) { add(attrs('meta', Object.fromEntries(element.attributes))); } })
    .on('link[rel="canonical"]', { element(element) { add(attrs('link', { rel: 'canonical', href: element.getAttribute('href') })); } })
    .on('link[rel="image_src"]', { element(element) { add(attrs('link', { rel: 'image_src', href: element.getAttribute('href') })); } })
    .on('head > title', capture('title'))
    .on('h1', capture('h1'))
    .on('#productTitle', capture('span', { id: 'productTitle' }))
    .on('#landingImage', { element(element) { add(attrs('img', { id: 'landingImage', src: element.getAttribute('src'), 'data-old-hires': element.getAttribute('data-old-hires'), 'data-a-dynamic-image': element.getAttribute('data-a-dynamic-image') })); } })
    .on('#imgBlkFront', { element(element) { add(attrs('img', { id: 'imgBlkFront', src: element.getAttribute('src'), 'data-old-hires': element.getAttribute('data-old-hires'), 'data-a-dynamic-image': element.getAttribute('data-a-dynamic-image') })); } })
    .on('#ebooksImgBlkFront', { element(element) { add(attrs('img', { id: 'ebooksImgBlkFront', src: element.getAttribute('src'), 'data-old-hires': element.getAttribute('data-old-hires') })); } })
    .on('#imgTagWrapperId img', { element(element) { add(attrs('img', { id: 'pasa-preview-product-image', src: element.getAttribute('src'), 'data-old-hires': element.getAttribute('data-old-hires'), 'data-a-dynamic-image': element.getAttribute('data-a-dynamic-image') })); } })
    .on('#corePriceDisplay_desktop_feature_div .a-offscreen', capture('span', { id: 'pasa-preview-price' }))
    .on('#corePrice_feature_div .a-offscreen', capture('span', { id: 'pasa-preview-price' }))
    .on('#priceblock_ourprice', capture('span', { id: 'priceblock_ourprice' }))
    .on('#priceblock_dealprice', capture('span', { id: 'priceblock_dealprice' }))
    .on('#price_inside_buybox', capture('span', { id: 'price_inside_buybox' }))
    .on('script[type="application/ld+json"]', {
      element(element) { script = ''; element.onEndTag(() => add('<script type="application/ld+json">' + script.replaceAll('<', '\\u003c') + '</script>')); },
      text(chunk) { if (script.length < 131072) script += chunk.text.slice(0, 131072 - script.length); },
    })
    .on('#captchacharacters', { element() { add('<input id="captchacharacters">'); } })
    .on('#challenge-form', { element() { add('<form id="challenge-form"></form>'); } });
  const transformed = rewriter.transform(new Response(bytes, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  await transformed.body.pipeTo(new WritableStream({ write() {} }));
  return pieces.join('\n');
}

async function cacheKey(url) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(url)));
  return new Request('https://pasa-preview-cache.invalid/v3/' + [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''));
}

export async function getPreview(input, { fetcher = fetch, cache = globalThis.caches?.default } = {}) {
  const normalized = normalizePreviewURL(input);
  const key = await cacheKey(normalized);
  if (cache) {
    try {
      const response = await cache.match(key);
      if (response) {
        const saved = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536)));
        if (!saved.unavailable) return saved;
      }
    } catch { /* A missing cache never prevents preview generation. */ }
  }
  let preview;
  try {
    const resource = await fetchPublicResource(normalized, { fetcher });
    const type = (resource.response.headers.get('Content-Type') || '').toLowerCase();
    if (!resource.response.ok || !type.includes('html')) preview = { ...fallback(normalized, true), unavailableReason: !resource.response.ok ? 'http_status_' + resource.response.status : 'non_html' };
    else {
      const html = await compactNativeMetadata(resource.bytes);
      preview = { ...parseMetadata(html, resource.url), url: normalized };
    }
  } catch (error) {
    if (error instanceof PreviewError && error.status === 400) throw error;
    preview = { ...fallback(normalized, true), unavailableReason: error instanceof PreviewError ? 'network_status_' + error.status : 'metadata_parse' };
  }
  if (cache && !preview.unavailable) {
    try { await cache.put(key, new Response(JSON.stringify(preview), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + (preview.unavailable ? '300' : '28800') } })); }
    catch { /* Cache capacity does not prevent a successful preview. */ }
  }
  return preview;
}
