// [xihanzu-NR]
/**
 * Cookies, sessions and the response-header bag.
 *
 * Three things here are worth a test rather than a demonstration:
 *
 *   1. The HMAC-SHA256 in `runtime/server.ts` is hand-written (no `node:crypto`
 *      import, so the runtime stays dependency-free and bundleable). A MAC that
 *      disagrees with the real one is the worst bug this file could have, so it
 *      is compared against `node:crypto` for several message lengths, including
 *      the block boundary at 64 bytes.
 *   2. A `.hys` file reads a session with `s.get("user")`, which the compiler
 *      rewrites to a dict read. The values therefore have to be OWN PROPERTIES
 *      of the object, not entries behind a closure — that was a real bug found
 *      by running it, and this is the regression test for it.
 *   3. A 5xx must not carry `Set-Cookie`. A failing handler that had already
 *      written a cookie would otherwise rewrite the visitor's session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The runtime is TypeScript, and importing it directly needs Node's type
 * stripping — which is experimental on 22 and default on 24+. esbuild is
 * already a dependency of this package, so bundling it is the version-proof
 * way to get a module the test can actually call.
 */
const runtime = await (async () => {
  const esbuild = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cookies-'));
  const outfile = path.join(dir, 'server.mjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'runtime', 'server.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
})();

const { cookies, session, sign, unsign, set_header } = runtime;
const { newHeaderBag, flushHeaderBag, noteHeader } = await import('./headers-out.mjs');

/** A response double: records what a real node response would have been told. */
function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
}

test('sign/unsign round-trips, and the MAC equals node:crypto HMAC-SHA256', async () => {
  const secret = 'a-test-secret-of-at-least-16';
  for (const message of ['', 'a', 'hello world', 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), JSON.stringify({ user: 'hanzu', n: 42 })]) {
    const signed = sign(message, secret);
    assert.equal(unsign(signed, secret), message, `round trip for ${JSON.stringify(message.slice(0, 12))}`);
    const mac = signed.slice(signed.lastIndexOf('.') + 1);
    const expected = crypto.createHmac('sha256', secret).update(message).digest('base64url');
    assert.equal(mac, expected, 'hand-written HMAC must agree with node:crypto');
  }
});

test('a tampered or foreign-signed value reads as null, never as data', () => {
  const secret = 'a-test-secret-of-at-least-16';
  const other = 'a-different-secret-16-plus';
  const signed = sign('{"user":"hanzu"}', secret);
  assert.equal(unsign(signed, other), null, 'signature from another secret');
  // Flip one character of the payload, keeping a well-formed shape.
  const [payload, mac] = signed.split('.');
  const flipped = (payload[0] === 'a' ? 'b' : 'a') + payload.slice(1);
  assert.equal(unsign(`${flipped}.${mac}`, secret), null, 'tampered payload');
  assert.equal(unsign('not-a-cookie', secret), null);
  assert.equal(unsign('a.b.c.d', secret), null);
});

test('cookies(event) reads the request and writes Set-Cookie with safe defaults', () => {
  const event = { headers: { cookie: 'sid=abc123; theme=dark' } };
  const jar = cookies(event);
  assert.equal(jar.get('sid'), 'abc123');
  assert.equal(jar.get('missing', 'fallback'), 'fallback');
  // The values are own properties, because that is what `.get(k)` compiles to.
  assert.equal(jar.sid, 'abc123');
  assert.ok(jar.has('theme'));

  jar.set('token', 'v', { maxAge: 60 });
  jar.delete('old');
  const setCookies = event._headers.filter(([n]) => n === 'Set-Cookie').map(([, v]) => v);
  assert.equal(setCookies.length, 2);
  assert.match(setCookies[0], /^token=v; Path=\/; Max-Age=60; SameSite=Lax; HttpOnly$/);
  assert.match(setCookies[1], /^old=; Path=\/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly$/);
});

test('session(): empty without a cookie, readable back with one', () => {
  const secret = 'session-secret-at-least-16';
  const first = { headers: {} };
  const s1 = session(first, secret);
  assert.equal(s1.get('user'), null);
  s1.set('user', 'hanzu');
  s1.set('role', 'admin');
  const sessionCookies = first._headers.filter(([n]) => n === 'Set-Cookie');
  // Two writes for one cookie name are ONE header (the second replaces the
  // first), so the value the browser ends up with is the last state.
  assert.equal(sessionCookies.length, 1, 'one Set-Cookie per cookie name');
  const value = sessionCookies[0][1].split(';')[0].slice('hydra_session='.length);

  const second = { headers: { cookie: `hydra_session=${value}` } };
  const s2 = session(second, secret);
  assert.equal(s2.get('user'), 'hanzu');
  // Own property, not a method call: this is what a `.hys` file does.
  assert.equal(s2.role, 'admin');

  s2.delete('user');
  const afterDelete = second._headers.filter(([n]) => n === 'Set-Cookie').pop()[1];
  const deletedValue = afterDelete.split(';')[0].slice('hydra_session='.length);
  const s3 = session({ headers: { cookie: `hydra_session=${deletedValue}` } }, secret);
  assert.equal(s3.get('user'), null, 'delete() removed the key from the written cookie');
  assert.equal(s3.get('role'), 'admin', 'and kept the rest');
});

test('session(): a tampered cookie is an empty session, not a throw', () => {
  const secret = 'session-secret-at-least-16';
  const event = { headers: { cookie: 'hydra_session=eyJ1c2VyIjoiaGFja2VyIn0.forged' } };
  const s = session(event, secret);
  assert.equal(s.get('user'), null);
  assert.deepEqual({ ...s.get() }, {});
});

test('session(): a secret shorter than 16 characters is refused at the call', () => {
  assert.throws(() => session({ headers: {} }, 'short'), /at least 16 characters/);
  assert.throws(() => session({ headers: {} }, { secret: '' }), /at least 16 characters/);
});

test('session(): clear() expires the cookie', () => {
  const secret = 'session-secret-at-least-16';
  const event = { headers: {} };
  const s = session(event, secret);
  s.set('user', 'hanzu');
  s.clear();
  const last = event._headers.filter(([n]) => n === 'Set-Cookie').pop()[1];
  assert.match(last, /^hydra_session=; /);
  assert.match(last, /Max-Age=0/);
});

test('the header bag keeps two Set-Cookie headers, which setHeader would collapse', () => {
  const bag = newHeaderBag();
  noteHeader(bag, 'Set-Cookie', 'a=1; Path=/');
  noteHeader(bag, 'Set-Cookie', 'b=2; Path=/');
  noteHeader(bag, 'X-One', '1');
  const res = fakeRes();
  flushHeaderBag(res, bag, 200);
  assert.deepEqual(res.headers['Set-Cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(res.headers['X-One'], '1');
});

test('a 5xx drops cookies but keeps the other headers', () => {
  const bag = newHeaderBag();
  noteHeader(bag, 'Set-Cookie', 'sid=halfwritten; Path=/');
  noteHeader(bag, 'X-Trace', 'abc');
  const res = fakeRes();
  flushHeaderBag(res, bag, 500);
  assert.equal(res.headers['Set-Cookie'], undefined);
  assert.equal(res.headers['X-Trace'], 'abc');
});

test('noteHeader refuses CR/LF, which node would throw on at writeHead', () => {
  const bag = newHeaderBag();
  assert.throws(() => noteHeader(bag, 'X-Bad', 'a\r\nInjected: 1'), /CR, LF or NUL/);
  assert.throws(() => noteHeader(bag, 'Bad Name', '1'), /not a valid header name/);
});

test('set_header(event, …) is the generic door, and lands in the same bag', () => {
  const event = {};
  set_header(event, 'X-Thing', 'yes');
  const res = fakeRes();
  flushHeaderBag(res, event._headers, 200);
  assert.equal(res.headers['X-Thing'], 'yes');
});
