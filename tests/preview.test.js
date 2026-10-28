import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  PreviewError, validatePublicURL, normalizePreviewURL, parseMetadata,
  fetchPublicResource, getPreview,
} from '../backend/preview.js';

const PRODUCT = 'https://www.amazon.com/dp/B00FB5TJQU';
const PAGE = 'https://example.com/articles/a-good-read';
const htmlResponse = (html, extra = {}) => new Response(html, {
  headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra.headers },
  ...extra,
});
const isPreviewError = status => error => error instanceof PreviewError && Number.isInteger(error.status) && (!status || error.status === status);

function network(handler, { address = '93.184.216.34', ipv6Address, dnsStatus = 0 } = {}) {
  const calls = [];
  const fetcher = async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, options });
    if (url.hostname === 'cloudflare-dns.com') {
      const type = url.searchParams.get('type');
      const answers = type === 'AAAA' || type === '28'
        ? (ipv6Address ? [{ name: url.searchParams.get('name'), type: 28, TTL: 60, data: ipv6Address }] : [])
        : [{ name: url.searchParams.get('name'), type: 1, TTL: 60, data: address }];
      return new Response(JSON.stringify({ Status: dnsStatus, Answer: answers }), { headers: { 'Content-Type': 'application/dns-json' } });
    }
    return handler(url, options);
  };
  return { fetcher, calls, originCalls: () => calls.filter(call => call.url.hostname !== 'cloudflare-dns.com') };
}

test('normalizes Amazon product variants while preserving non-Amazon query semantics', () => {
  for (const url of [
    `${PRODUCT}?tag=affiliate-20&ref=example#details`,
    'https://amazon.com/Useful-Product/gp/product/B00FB5TJQU/ref=something?th=1',
    'http://www.amazon.com/Useful-Product/dp/B00FB5TJQU/ref=something',
  ]) assert.equal(normalizePreviewURL(url), PRODUCT);
  assert.equal(normalizePreviewURL('https://www.amazon.co.uk/dp/B00FB5TJQU?tag=example'), 'https://www.amazon.co.uk/dp/B00FB5TJQU');
  assert.equal(normalizePreviewURL('https://amzn.to/abc123#fragment'), 'https://amzn.to/abc123');
  assert.equal(normalizePreviewURL('https://a.co/d/abc123'), 'https://a.co/d/abc123');
  assert.equal(normalizePreviewURL(`${PAGE}?page=2&language=es#section`), `${PAGE}?page=2&language=es`);
});

test('rejects credentials, reserved hosts, numeric and IPv6 literals, nonstandard ports and secret-bearing URLs', () => {
  for (const url of [
    'file:///etc/passwd', 'data:text/html,hello', 'javascript:alert(1)',
    'https://user:password@example.com/x', 'https://user@example.com/x',
    'https://localhost/x', 'https://a.localhost/x', 'https://metadata.google.internal/',
    'https://router.local/', 'https://intranet/', 'https://example.com:8443/x',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
    'https://10.0.0.1/', 'https://169.254.169.254/latest/meta-data',
    'https://[::1]/', 'https://[::ffff:7f00:1]/', 'https://93.184.216.34/',
    `${PAGE}?token=secret`, `${PAGE}?access_token=secret`, `${PAGE}?api_key=secret`,
    `${PAGE}?X-Amz-Signature=secret`, `${PAGE}?password=secret`, `${PAGE}?signature=secret`,
  ]) {
    assert.throws(() => validatePublicURL(url), isPreviewError(), url);
    assert.throws(() => normalizePreviewURL(url), isPreviewError(), url);
  }
  assert.equal(validatePublicURL(PAGE).hostname, 'example.com');
});

test('extracts Open Graph article metadata, decodes entities and resolves relative images', () => {
  const result = parseMetadata(`<!doctype html><html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="A useful &amp; thoughtful article">
    <meta property="og:description" content="First &quot;quoted&quot; detail &amp; a second detail.">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Example Journal">
    <meta property="og:image" content="/assets/cover.jpg">
    <link rel="canonical" href="/articles/canonical-read">
  </head></html>`, PAGE);
  assert.equal(result.title, 'A useful & thoughtful article');
  assert.equal(result.description, 'First "quoted" detail & a second detail.');
  assert.equal(result.kind, 'article');
  assert.equal(result.siteName, 'Example Journal');
  assert.equal(result.image, 'https://example.com/assets/cover.jpg');
  assert.equal(result.canonicalUrl, 'https://example.com/articles/canonical-read');
  assert.equal(result.price, null);
});

test('uses Twitter metadata when Open Graph fields are absent and falls back to document title', () => {
  const twitter = parseMetadata(`<meta name="twitter:title" content="A Twitter preview">
    <meta name="twitter:description" content="Preview details">
    <meta name="twitter:image" content="https://example.com/twitter-cover.webp">
    <meta name="description" content="Lower priority description">`, PAGE);
  assert.equal(twitter.title, 'A Twitter preview');
  assert.equal(twitter.description, 'Preview details');
  assert.equal(twitter.image, 'https://example.com/twitter-cover.webp');
  const plain = parseMetadata('<title> Plain &amp; simple </title><meta name="description" content="Plain details">', PAGE);
  assert.equal(plain.title, 'Plain & simple');
  assert.equal(plain.description, 'Plain details');
});

test('finds JSON-LD Product objects inside arrays and graphs with image and offer variants', () => {
  const result = parseMetadata(`<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', name: 'The shop' },
      { '@type': ['Thing', 'Product'], name: 'Useful product', description: 'Product details',
        image: [{ '@type': 'ImageObject', url: '/product-large.png' }],
        offers: [{ '@type': 'Offer', price: '39.99', priceCurrency: 'USD' }] },
    ],
  })}</script>`, 'https://example.com/shop/product');
  assert.equal(result.kind, 'product');
  assert.equal(result.title, 'Useful product');
  assert.equal(result.description, 'Product details');
  assert.equal(result.image, 'https://example.com/product-large.png');
  assert.match(result.price, /39\.99/);
  assert.match(result.price, /USD|\$/);
});

test('Amazon product title and primary image beat unrelated generic page content', () => {
  const result = parseMetadata(`<title>Amazon.com: Generic category</title>
    <meta property="og:image" content="https://example.com/unrelated-promotion.jpg">
    <span id="productTitle"> Useful product &amp; accessories </span>
    <img id="landingImage" src="https://m.media-amazon.com/images/I/small.jpg"
      data-old-hires="https://m.media-amazon.com/images/I/product-large.jpg"
      data-a-dynamic-image='{"https://m.media-amazon.com/images/I/medium.jpg":[500,500]}'>`, PRODUCT);
  assert.equal(result.kind, 'product');
  assert.equal(result.title, 'Useful product & accessories');
  assert.equal(result.siteName, 'Amazon');
  assert.equal(result.asin, 'B00FB5TJQU');
  assert.equal(result.image, 'https://m.media-amazon.com/images/I/product-large.jpg');
});

test('selects the largest primary Amazon dynamic image without inventing product details', () => {
  const result = parseMetadata(`<span id="productTitle">A real item</span>
    <img id="landingImage" src="https://m.media-amazon.com/images/I/tiny.jpg"
      data-a-dynamic-image='{"https://m.media-amazon.com/images/I/a.jpg":[300,500],"https://m.media-amazon.com/images/I/b.jpg":[1200,1000]}'>`, PRODUCT);
  assert.equal(result.image, 'https://m.media-amazon.com/images/I/b.jpg');
  assert.equal(result.price, null);
  const lookalike = parseMetadata('<title>Other shop</title>', 'https://amazon.com.example.com/dp/B00FB5TJQU');
  assert.notEqual(lookalike.siteName, 'Amazon');
  assert.ok(!lookalike.asin);
});

test('refuses unsafe metadata images and ignores malformed structured data safely', () => {
  for (const image of ['javascript:alert(1)', 'data:image/svg+xml,evil', 'http://127.0.0.1/image.png', 'https://user:secret@example.com/a.jpg']) {
    const result = parseMetadata(`<title>Safe title</title><meta property="og:image" content="${image}"><script type="application/ld+json">{bad</script>`, PAGE);
    assert.equal(result.title, 'Safe title');
    assert.equal(result.image, null);
  }
});

test('does not present a bot challenge as product metadata', () => {
  const result = parseMetadata('<title>Amazon Robot Check</title><h4>Enter the characters you see below</h4><form action="/errors/validateCaptcha"><img src="https://example.com/captcha.jpg"></form>', PRODUCT);
  assert.equal(result.unavailable, true);
  assert.equal(result.image, null);
  assert.equal(result.price, null);
  assert.doesNotMatch(result.title, /robot check|captcha/i);
});

test('fetches only verified public destinations with manual redirects and no caller credentials', async () => {
  const mock = network(async (url, options) => {
    assert.equal(options.redirect, 'manual');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Cookie'), null);
    assert.equal(headers.get('Authorization'), null);
    assert.match(headers.get('User-Agent'), /Pasa-LinkPreview/);
    return htmlResponse('<title>Public page</title>');
  });
  const resource = await fetchPublicResource(PAGE, { fetcher: mock.fetcher, accept: 'text/html', maxBytes: 1000 });
  assert.equal(resource.url, PAGE);
  assert.ok(resource.bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(resource.bytes), '<title>Public page</title>');
  assert.equal(mock.originCalls().length, 1);
  assert.ok(mock.calls.some(call => call.url.hostname === 'cloudflare-dns.com'));
});

test('validates redirects before fetching a new host and rejects private DNS answers', async () => {
  for (const target of ['https://169.254.169.254/latest/meta-data', 'https://localhost/secrets', 'https://example.com:8443/internal']) {
    const mock = network(async () => new Response(null, { status: 302, headers: { Location: target } }));
    await assert.rejects(fetchPublicResource(PAGE, { fetcher: mock.fetcher }), isPreviewError());
    assert.equal(mock.originCalls().length, 1, 'the unsafe redirect destination must never be fetched');
  }
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1']) {
    const mock = network(async () => { throw new Error('must not fetch origin'); }, { address });
    await assert.rejects(fetchPublicResource(PAGE, { fetcher: mock.fetcher }), isPreviewError());
    assert.equal(mock.originCalls().length, 0);
  }
  for (const ipv6Address of ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    const mock = network(async () => { throw new Error('must not fetch origin'); }, { ipv6Address });
    await assert.rejects(fetchPublicResource(PAGE, { fetcher: mock.fetcher }), isPreviewError());
    assert.equal(mock.originCalls().length, 0, 'a private AAAA answer cannot be ignored when A is public');
  }
});

test('follows bounded public short-link redirects and resolves relative Location values', async () => {
  const mock = network(async url => {
    if (url.hostname === 'amzn.to') return new Response(null, { status: 301, headers: { Location: 'https://www.amazon.com/redirect' } });
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { Location: '/dp/B00FB5TJQU' } });
    return htmlResponse('<span id="productTitle">Resolved product</span>');
  });
  const resource = await fetchPublicResource('https://amzn.to/demo', { fetcher: mock.fetcher });
  assert.equal(resource.url, PRODUCT);
  assert.equal(mock.originCalls().length, 3);
  const loop = network(async () => new Response(null, { status: 302, headers: { Location: '/again' } }));
  await assert.rejects(fetchPublicResource(PAGE, { fetcher: loop.fetcher }), isPreviewError());
  assert.ok(loop.originCalls().length <= 5);
});

test('bounds declared and actual streamed bodies and normalizes interrupted network responses', async () => {
  const declared = network(async () => htmlResponse('x', { headers: { 'Content-Type': 'text/html', 'Content-Length': '10000' } }));
  await assert.rejects(fetchPublicResource(PAGE, { fetcher: declared.fetcher, maxBytes: 10 }), isPreviewError());
  const streamed = network(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(100))); controller.close(); } }), { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(fetchPublicResource(PAGE, { fetcher: streamed.fetcher, maxBytes: 10 }), isPreviewError());
  const interrupted = network(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
  await assert.rejects(fetchPublicResource(PAGE, { fetcher: interrupted.fetcher }), isPreviewError());
});

test('returns useful product metadata and caches normalized public pages without room credentials', async () => {
  const entries = new Map();
  const writes = [];
  const cache = {
    async match(key) { const response = entries.get(String(key instanceof Request ? key.url : key)); return response?.clone(); },
    async put(key, response) { const url = String(key instanceof Request ? key.url : key); writes.push(url); entries.set(url, response.clone()); },
  };
  const mock = network(async () => htmlResponse('<span id="productTitle">Cached product</span><img id="landingImage" src="https://m.media-amazon.com/images/I/product.jpg">'));
  const first = await getPreview(`${PRODUCT}?tag=one`, { fetcher: mock.fetcher, cache });
  const second = await getPreview(`${PRODUCT}?tag=two`, { fetcher: mock.fetcher, cache });
  assert.equal(first.title, 'Cached product');
  assert.equal(second.title, 'Cached product');
  assert.equal(mock.originCalls().length, 1);
  assert.ok(writes.length >= 1);
  for (const url of writes) {
    assert.ok(!url.includes('tag='));
    assert.ok(!url.includes('pasa_'));
  }
});

test('blocked pages yield an honest fallback without counterfeit product images or prices', async () => {
  const mock = network(async () => htmlResponse('<title>Amazon Robot Check</title><form action="/errors/validateCaptcha">Enter the characters you see</form>', { status: 503 }));
  const result = await getPreview(PRODUCT, { fetcher: mock.fetcher, cache: null });
  assert.equal(result.unavailable, true);
  assert.equal(result.image, null);
  assert.equal(result.price, null);
  assert.doesNotMatch(result.title, /robot check|captcha/i);
});

test('native Worker parsing decodes entities once and tolerates void elements matched by price selectors', { timeout: 30000 }, async () => {
  const [{ build }, { Miniflare, convertV4MiniflareOptions }] = await Promise.all([import('esbuild'), import('miniflare')]);
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({
    stdin: {
      resolveDir: projectRoot,
      sourcefile: 'preview-native-test.js',
      contents: `import { getPreview } from './backend/preview.js';
        export default {
          async fetch(request) {
            const html = await request.text();
            const fetcher = async input => {
              const url = new URL(typeof input === 'string' ? input : input.url || input.href);
              if (url.hostname === 'cloudflare-dns.com') {
                const ipv6 = ['AAAA', '28'].includes(url.searchParams.get('type'));
                return Response.json({ Status: 0, Answer: ipv6 ? [] : [{ type: 1, data: '93.184.216.34' }] });
              }
              return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            };
            const preview = await getPreview('https://www.amazon.com/dp/B0FDH4G8TV', { fetcher, cache: null });
            return Response.json(preview);
          }
        };`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: '2026-10-27',
    script: bundle.outputFiles[0].text,
  }));
  try {
    const response = await mf.dispatchFetch('https://preview-native.test/', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><html><head><title>Store &amp; Product</title>
        <meta name="description" content="A &quot;real&quot; product &amp; useful details &#x1F600;">
        </head><body>
        <input id="price_inside_buybox" value="$19.99">
        <span id="productTitle">Title &amp; Item &#x1F600;</span>
        <img id="landingImage" data-old-hires="https://m.media-amazon.com/real.jpg">
        <div id="corePrice_feature_div"><span class="a-offscreen">$19.99</span></div>
        </body></html>`,
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.title, 'Title & Item 😀');
    assert.equal(preview.description, 'A "real" product & useful details 😀');
    assert.equal(preview.image, 'https://m.media-amazon.com/real.jpg');
    assert.equal(preview.price, '$19.99');
    assert.equal(preview.kind, 'product');
    assert.equal(preview.unavailable, undefined);
  } finally {
    await mf.dispose();
  }
});
