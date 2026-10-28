import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, describeLink, shortenUrl } from '../links.js';

test('extracts multiline links in order, normalizes www, and deduplicates canonical URLs', () => {
  assert.deepEqual(extractLinks('Mira https://Example.com\nwww.github.com/ealfaro29/pasa\nhttps://example.com/'), [
    'https://Example.com', 'https://www.github.com/ealfaro29/pasa',
  ]);
});

test('handles Spanish punctuation and preserves balanced URL parentheses', () => {
  assert.deepEqual(extractLinks('¡Mira (https://es.wikipedia.org/wiki/Algoritmo_(matemáticas)). ¿Y https://ejemplo.com/hola? [https://a.test/a[b]] «https://b.test/!»'), [
    'https://es.wikipedia.org/wiki/Algoritmo_(matemáticas)', 'https://ejemplo.com/hola', 'https://a.test/a[b]', 'https://b.test/',
  ]);
});

test('supports Markdown and safe HTML attribute text without interpreting markup', () => {
  assert.deepEqual(extractLinks('[documento](https://docs.google.com/document/d/abc/edit) <a href="https://example.org">link</a>'), [
    'https://docs.google.com/document/d/abc/edit', 'https://example.org',
  ]);
});

test('rejects credentials, deceptive userinfo, unsafe schemes, embedded schemes and backslashes', () => {
  const text = 'javascript:alert(1) data:text/plain,https://hidden.test javascript:https://hidden2.test ' +
    'https://user:secret@example.com https://@example.org https://user%40x@example.net ' +
    'ftp://example.com www.example.com\\@evil.test https://good.test https://good.test/?q=https://nested.test';
  assert.deepEqual(extractLinks(text), ['https://good.test', 'https://good.test/?q=https://nested.test']);
});

test('retains meaningful anchors, query parameters, IPv6, and Unicode paths', () => {
  assert.deepEqual(extractLinks('https://[::1]:8080/a https://example.com/guía?q=uno&x=2#parte'), [
    'https://[::1]:8080/a', 'https://example.com/guía?q=uno&x=2#parte',
  ]);
});

test('limits output to twelve unique links and tolerates non-string inputs', () => {
  assert.equal(extractLinks(Array.from({ length: 20 }, (_, i) => `https://a.test/${i}`).join('\n')).length, 12);
  assert.deepEqual(extractLinks(null), []);
  assert.deepEqual(extractLinks({ toString: () => 'https://a.test' }), []);
});

test('handles a long pasted punctuation suffix without quadratic rescanning', () => {
  assert.deepEqual(extractLinks(`https://example.com/path${')'.repeat(100_000)}`), ['https://example.com/path']);
});

test('describes YouTube videos, shorts and channels without replacing hrefs', () => {
  for (const [url, kind] of [
    ['https://youtu.be/abc', 'video'], ['https://www.youtube.com/watch?v=abc', 'video'],
    ['https://youtube.com/shorts/abc', 'short'], ['https://youtube.com/@chatgptricks', 'channel'],
    ['https://youtube.com/channel/UC123', 'channel'],
  ]) {
    const result = describeLink(url);
    assert.equal(result.platform, 'YouTube');
    assert.equal(result.kind, kind);
    assert.equal(result.url, url);
  }
});

test('recognizes GitHub repository, issue and pull request context', () => {
  assert.equal(describeLink('https://github.com/ealfaro29/pasa').title, 'ealfaro29/pasa');
  assert.equal(describeLink('https://github.com/ealfaro29/pasa/issues/42').title, 'Issue #42 · ealfaro29/pasa');
  assert.equal(describeLink('https://github.com/ealfaro29/pasa/pull/7').kind, 'pull');
});

test('recognizes Amazon regional products and short links while keeping the original URL', () => {
  for (const url of [
    'https://www.amazon.com/dp/B0D2SW14ZN?tag=example-20',
    'https://amazon.com.mx/gp/product/B012345678',
    'https://amazon.co.uk/gp/aw/d/B012345678',
    'https://amazon.co.jp/dp/B012345678',
    'https://amazon.com.au/dp/B012345678',
    'https://www.amazon.es/dp/B012345678',
    'https://amzn.to/abc123',
    'https://a.co/d/abc123',
  ]) {
    const result = describeLink(url);
    assert.equal(result.platform, 'Amazon');
    assert.equal(result.kind, 'product');
    assert.equal(result.url, url);
    assert.equal(result.title, 'Producto de Amazon');
  }
  assert.equal(describeLink('https://www.amazon.com/Logitech-MX-Master-Wireless-Mouse/dp/B012345678').title, 'Logitech MX Master Wireless Mouse');
  for (const url of ['https://amazon.com.evil.test/dp/B012345678', 'https://notamazon.com/dp/B012345678', 'https://example.com/?url=https://amazon.com/dp/B012345678']) {
    assert.equal(describeLink(url).platform, 'Web');
  }
});

test('recognizes social publication and profile paths', () => {
  for (const [url, platform, kind] of [
    ['https://x.com/alfa/status/123', 'X', 'post'], ['https://twitter.com/alfa', 'X', 'profile'],
    ['https://instagram.com/p/abc/', 'Instagram', 'post'], ['https://instagram.com/reel/abc/', 'Instagram', 'reel'],
    ['https://instagram.com/chatgptricks/', 'Instagram', 'profile'], ['https://www.tiktok.com/@alfa/video/123', 'TikTok', 'video'],
    ['https://www.linkedin.com/in/ana-lopez/', 'LinkedIn', 'profile'], ['https://linkedin.com/posts/ana-activity-123', 'LinkedIn', 'post'],
  ]) {
    const result = describeLink(url);
    assert.equal(result.platform, platform);
    assert.equal(result.kind, kind);
  }
});

test('recognizes Google productivity tools and design/document providers', () => {
  for (const [url, platform, kind] of [
    ['https://docs.google.com/document/d/id/edit', 'Google Docs', 'document'],
    ['https://docs.google.com/spreadsheets/d/id/edit', 'Google Sheets', 'spreadsheet'],
    ['https://docs.google.com/presentation/d/id/edit', 'Google Slides', 'presentation'],
    ['https://drive.google.com/file/d/id/view', 'Google Drive', 'file'],
    ['https://canva.com/design/id/edit', 'Canva', 'design'],
    ['https://figma.com/design/id/Mi-diseño', 'Figma', 'design'],
    ['https://notion.so/Mi-nota-0123456789abcdef0123456789abcdef', 'Notion', 'document'],
    ['https://workspace.notion.site/0123456789abcdef0123456789abcdef', 'Notion', 'document'],
  ]) {
    const result = describeLink(url);
    assert.equal(result.platform, platform);
    assert.equal(result.kind, kind);
    assert.match(result.color, /^#[0-9a-f]{6}$/i);
    assert.ok(result.provider);
  }
  assert.equal(describeLink('https://notion.so/Mi-nota-0123456789abcdef0123456789abcdef').title, 'Mi nota');
  assert.equal(describeLink('https://figma.com/design/id/Mi-diseño').title, 'Mi diseño');
});

test('provides Spotify, Wikipedia and meaningful generic titles', () => {
  assert.equal(describeLink('https://open.spotify.com/track/id').title, 'Canción de Spotify');
  assert.equal(describeLink('https://open.spotify.com/intl-es/album/id').title, 'Álbum de Spotify');
  assert.equal(describeLink('https://es.wikipedia.org/wiki/Inteligencia_artificial').title, 'Inteligencia artificial');
  assert.equal(describeLink('https://example.com/blog/como-compartir-texto.html').title, 'Como compartir texto');
  assert.equal(describeLink('https://example.com/?utm_source=x').title, 'example.com');
  assert.equal(describeLink('https://example.com/0123456789abcdef0123456789abcdef').title, 'example.com');
  assert.equal(describeLink('https://example.com/%E0%A4%A').title, '%E0%A4%A');
});

test('does not mistake lookalike hostnames or query strings for providers', () => {
  for (const url of ['https://youtube.com.evil.test/watch', 'https://notgithub.com/owner/repo', 'https://example.com/?url=https://instagram.com/p/test']) {
    assert.equal(describeLink(url).platform, 'Web');
  }
});

test('invalid or unsafe hrefs never escape as navigable links', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'ftp://example.com', '//example.com', 'https://user:pass@example.com', 'https://example.com\\@evil.com', 'https://example.com\n', null, {}]) {
    assert.equal(describeLink(url).url, '');
    assert.equal(shortenUrl(url), '');
  }
});

test('shortens display strings only, with deterministic bounded lengths', () => {
  assert.equal(shortenUrl('https://www.example.com/path'), 'example.com/path');
  assert.equal(shortenUrl('https://example.com/very/long/path', 12), 'example.com…');
  assert.equal(shortenUrl('https://example.com', 1), '…');
  assert.equal(shortenUrl('https://example.com', 0), '…');
});
