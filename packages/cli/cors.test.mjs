// [xihanzu-NR]
/**
 * CORS from `server.cors`.
 *
 * The rule that matters, and the one a framework usually gets wrong: an origin
 * that is NOT in the list must get no `Access-Control-*` header at all. Echoing
 * back whatever `Origin` arrived turns an allowlist into a welcome mat, and it
 * looks correct in a browser test where the origin happens to be allowed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { corsHeaders } = await import('./http.mjs');

test('off means no headers at all', () => {
  assert.deepEqual(corsHeaders(undefined, 'https://a.example'), {});
  assert.deepEqual(corsHeaders(false, 'https://a.example'), {});
});

test('true sends a bare wildcard', () => {
  const headers = corsHeaders(true, 'https://anything.example');
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
  assert.ok(headers['Access-Control-Allow-Methods'].includes('POST'));
});

test('a string is one exact origin, echoed only when it matches', () => {
  const ok = corsHeaders('https://app.example.com', 'https://app.example.com');
  assert.equal(ok['Access-Control-Allow-Origin'], 'https://app.example.com');
  assert.equal(ok.Vary, 'Origin', 'an echoed origin must not be cached for another');

  const denied = corsHeaders('https://app.example.com', 'https://evil.example');
  assert.deepEqual(denied, {}, 'a disallowed origin gets nothing');
});

test('an allowlist with credentials echoes the origin and allows credentials', () => {
  const cfg = { origins: ['https://app.example.com', 'https://admin.example.com'], credentials: true, maxAge: 600 };
  const headers = corsHeaders(cfg, 'https://admin.example.com');
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://admin.example.com');
  assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
  assert.equal(headers['Access-Control-Max-Age'], '600');
  assert.equal(headers.Vary, 'Origin');
});

test('wildcard plus credentials cannot be a wildcard, so the origin is echoed', () => {
  const headers = corsHeaders({ origins: ['*'], credentials: true }, 'https://x.example');
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://x.example');
  assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
});

test('a request with no Origin is not a browser request and gets nothing', () => {
  assert.deepEqual(corsHeaders({ origins: ['*'], credentials: true }, undefined), {});
  assert.deepEqual(corsHeaders({ origins: ['https://a.example'] }, ''), {});
});

test('no wildcard matching inside an origin', () => {
  // `https://*.example.com` is not expressible in CORS; matching it would look
  // allowed in a test and be refused by the browser.
  assert.deepEqual(corsHeaders({ origins: ['https://*.example.com'] }, 'https://app.example.com'), {});
});

test('explicit methods and headers replace the defaults', () => {
  const headers = corsHeaders({ origins: ['*'], methods: ['GET'], headers: ['X-Thing'] }, 'https://a.example');
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET');
  assert.equal(headers['Access-Control-Allow-Headers'], 'X-Thing');
});
