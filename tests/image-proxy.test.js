import test from 'node:test';
import assert from 'node:assert/strict';
import { signImage, verifyImage, loadPreviewImage } from '../backend/image-proxy.js';

const room = 'pasa_' + 'a'.repeat(56);
const secret = 'test-only-signing-key-'.repeat(3);
const image = 'https://m.media-amazon.com/images/I/example.jpg';

test('signed product images are bound to an approved image, room and validity window', async () => {
  const now = Date.now();
  const token = await signImage(image, room, secret, now);
  assert.equal(await verifyImage(token, room, secret, now), image);
  await assert.rejects(verifyImage(token, room + 'x', secret, now), error => error.status === 403);
  await assert.rejects(verifyImage(token, room, 'another-test-secret-'.repeat(3), now), error => error.status === 403);
  const [payload, signature] = token.split('.');
  await assert.rejects(verifyImage(`${payload.slice(0, -1)}x.${signature}`, room, secret, now), error => error.status === 403);
  await assert.rejects(verifyImage(token, room, secret, now + 8 * 86400000), error => error.status === 403);
});

test('private destinations and unconfigured signing cannot produce fetchable image tokens', async () => {
  for (const url of ['https://127.0.0.1/image.png', 'https://localhost/image.png', 'file:///etc/passwd', 'https://user:password@example.com/x']) {
    await assert.rejects(signImage(url, room, secret));
  }
  await assert.rejects(signImage(image, room, ''), error => error.status === 503);
  let fetched = false;
  await assert.rejects(loadPreviewImage('invalid.signature', room, secret, { fetcher() { fetched = true; } }));
  assert.equal(fetched, false);
});

test('a valid cached raster is reused after token validation without fetching an external site', async () => {
  const token = await signImage(image, room, secret);
  let fetched = false;
  const response = await loadPreviewImage(token, room, secret, {
    fetcher() { fetched = true; },
    cache: { async match() { return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } }); } },
  });
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(fetched, false);
});
