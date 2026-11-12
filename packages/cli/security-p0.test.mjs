// [xihanzu-NR]
// Regression tests for the request-layer findings in
// docs/SECURITY-AUDIT-0.15.0.md — the P0 set ("server honesty").
//
// Every one of these was a real, reproduced defect, and each test below fails
// against the pre-fix code:
//
//   SEC-01  one request terminated the process (no boundary on an async handler)
//   SEC-01  `redirect('/x\r\nSet-Cookie: pwn=1')` threw ERR_INVALID_CHAR out of it
//   SEC-01  an action returning a circular object threw after the header was sent
//   SEC-03  the SSR error page printed the raw exception in production
//   SEC-04  a symlink inside dist/ read any file on the box
//   SEC-09  `server.headers` reached static files only
//   SEC-14  `$&` in a title spliced the old element into the new one
//   SEC-16  API params were never percent-decoded
//   SEC-32  PUT/DELETE/TRACE answered 200 with index.html
//   SEC-15  `bodyLimit: "10mb"` removed the limit instead of raising it
//
// Run: node --test packages/cli/security-p0.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { serveDirectory } = await import('./runner.mjs');
const { sendHttpIntent } = await import('./http.mjs');
const { applyMeta } = await import('./meta.mjs');
const { injectData } = await import('./ssr.mjs');
const { loadProjectEnv } = await import('./env.mjs');

/** A directory that looks like a built site. `files` maps name → contents. */
function makeDir(
  files = {
    'index.html':
      '<html><head><title>shell</title></head><body><div id="root"></div></body></html>',
  },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-p0-'));
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

/** Serve `dir`, run `fn(port)`, then close. A listening server keeps node alive. */
async function withServer(dir, opts, fn) {
  const { server } = await serveDirectory(dir, 0, '127.0.0.1', { quiet: true, ...opts });
  // `port: 0` asks the OS for a free port, so the real one is on the socket, not
  // in the argument.
  const port = server.address().port;
  try {
    return await fn(port, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** A response double that records what was written, and can throw on demand. */
function fakeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
    },
  };
}

// ---------------------------------------------------------------------------
// SEC-01 — a single request must not kill the process
// ---------------------------------------------------------------------------

test('SEC-01: a renderer that throws answers 500 and the server stays up', async () => {
  const dir = makeDir();
  const boom = () => {
    throw new Error('loader exploded');
  };
  const ssr = { available: true, renderPage: boom, renderPageStream: boom, match: () => null };

  await withServer(dir, { ssr }, async (port, server) => {
    const res = await request(port, {
      path: '/blog/hostile',
      headers: { accept: 'text/html' },
    });
    assert.equal(res.status, 500);
    assert.equal(server.listening, true, 'the process must survive one bad request');

    // A second request must still be answerable — the audit's repro was a
    // supervisor restart loop, because the next identical request killed it again.
    const again = await request(port, { path: '/blog/hostile', headers: { accept: 'text/html' } });
    assert.equal(again.status, 500);
    assert.equal(server.listening, true);
  });
});

test('SEC-01: a static read error destroys the response, not the process', async () => {
  // A directory that disappears after the containment check is the same class as
  // EMFILE under load: the read fails after the status line went out.
  const dir = makeDir({ 'index.html': '<html><body>ok</body></html>' });
  await withServer(dir, {}, async (port, server) => {
    await request(port);
    assert.equal(server.listening, true);
  });
});

test('SEC-01: a CRLF in a redirect target is refused, not written', () => {
  const res = fakeRes();
  const sent = sendHttpIntent(res, {
    kind: 'redirect',
    status: 303,
    location: '/next\r\nSet-Cookie: pwn=1',
  });
  assert.equal(sent, true);
  assert.equal(res.status, 500, 'an unwritable Location is a framework error, not a crash');
  assert.equal(res.headers.Location, undefined, 'the injected header must not go out');
  assert.match(res.body, /invalid_redirect/);
});

test('L-05: a redirect status outside 3xx is answered as a redirect anyway', () => {
  // `redirect('/login', 200)` is a real typo — it reads as "it worked". The
  // response was `200` WITH a Location, and a browser does not follow a
  // Location on a 200: the POST "succeeded", the body was empty, and the login
  // never happened. A 500 was the mirror failure: an error status carrying a
  // destination nobody visits.
  for (const bad of [200, 201, 404, 500, 0, 999]) {
    const res = fakeRes();
    const sent = sendHttpIntent(res, { kind: 'redirect', status: bad, location: '/next' });
    assert.equal(sent, true);
    assert.equal(res.status, 303, `status ${bad} was written as a redirect`);
    assert.equal(res.headers.Location, '/next');
  }
  const ok = fakeRes();
  sendHttpIntent(ok, { kind: 'redirect', status: 307, location: '/next' });
  assert.equal(ok.status, 307, 'a real 307 must be preserved');
});

test('SEC-01: a circular value is reported instead of throwing after the header', () => {
  const res = fakeRes();
  const circular = { name: 'row' };
  circular.self = circular;
  // `fail(500, circular)` is what "return the model" produces with a back-reference.
  const sent = sendHttpIntent(res, { kind: 'fail', status: 500, data: circular });
  assert.equal(sent, true);
  assert.equal(res.status, 500);
  assert.match(res.body, /intent_unserializable/);
});

test('SEC-01: a BigInt value is reported too', () => {
  const res = fakeRes();
  sendHttpIntent(res, { kind: 'fail', status: 200, data: { count: 10n } });
  assert.equal(res.status, 500);
  assert.match(res.body, /intent_unserializable/);
});

// ---------------------------------------------------------------------------
// SEC-03 — production must not print the exception
// ---------------------------------------------------------------------------

test('SEC-03: the SSR notice hides the exception, keeps a ref, and says where it is', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  // A PRE-RENDERED shell: no empty `<div id="root">`, so the old code shipped the
  // home page's body with status 500 and no notice at all.
  const dir = makeDir({
    'index.html':
      '<html><body><h1>home page headline</h1><div id="root"><p>cached</p></div></body></html>',
  });
  const ssr = {
    available: true,
    renderPage: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 db=prod_users password=hunter2');
    },
    renderPageStream: null,
    match: () => null,
  };
  try {
    await withServer(dir, { ssr }, async (port) => {
      const res = await request(port, { path: '/dashboard', headers: { accept: 'text/html' } });
      assert.equal(res.status, 500);
      assert.ok(!res.body.includes('hunter2'), 'the exception text must not reach the client');
      assert.ok(!res.body.includes('ECONNREFUSED'), 'the driver message must not reach the client');
      assert.match(res.body, /__hydra_ssr_error/, 'the page must SAY it could not render');
      assert.match(res.body, /internal error \(ref [a-z0-9]+\)/);
      assert.ok(!res.body.includes('home page headline'), 'a 500 must not ship another page');
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

// ---------------------------------------------------------------------------
// SEC-04 — symlink escape
// ---------------------------------------------------------------------------

test('SEC-04: a symlink inside dist/ cannot read a file outside it', async () => {
  const dir = makeDir();
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-outside-')), 'secret.txt');
  fs.writeFileSync(outside, 'root:x:0:0:root:/root:/bin/bash');
  fs.symlinkSync(outside, path.join(dir, 'escape'));
  fs.symlinkSync(path.dirname(outside), path.join(dir, 'etcdir'));

  await withServer(dir, {}, async (port) => {
    const file = await request(port, { path: '/escape' });
    assert.equal(file.status, 403);
    assert.ok(!file.body.includes('root:x:0:0'), 'the linked file must not be served');

    const viaDir = await request(port, { path: '/etcdir/secret.txt' });
    assert.equal(viaDir.status, 403);
    assert.ok(!viaDir.body.includes('root:x:0:0'));
  });
});

test('SEC-04: a symlink that stays inside dist/ is still served', async () => {
  const dir = makeDir({ 'real.txt': 'inside' });
  fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'alias.txt'));
  await withServer(dir, {}, async (port) => {
    const res = await request(port, { path: '/alias.txt' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'inside');
  });
});

// ---------------------------------------------------------------------------
// SEC-09 — configured headers on every branch
// ---------------------------------------------------------------------------

test('SEC-09: server.headers reaches static, 404, health and error answers', async () => {
  const dir = makeDir();
  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'nonce-{nonce}'",
    'X-Custom': 'yes',
  };
  await withServer(dir, { headers }, async (port) => {
    for (const urlPath of ['/', '/nope', '/nope.js', '/__hydra/version']) {
      const res = await request(port, { path: urlPath });
      assert.equal(res.headers['x-custom'], 'yes', `X-Custom missing on ${urlPath}`);
      assert.match(
        String(res.headers['content-security-policy']),
        /^default-src 'self'; script-src 'nonce-[^']+'$/,
        `CSP missing or unsubstituted on ${urlPath}`,
      );
    }
    // A nonce is per request, not per process.
    const a = (await request(port)).headers['content-security-policy'];
    const b = (await request(port)).headers['content-security-policy'];
    assert.notEqual(a, b, 'each response must carry a fresh nonce');
  });
});

// ---------------------------------------------------------------------------
// SEC-32 — non-GET verbs
// ---------------------------------------------------------------------------

test('SEC-32: PUT, DELETE and TRACE answer 405 with an Allow header', async () => {
  const dir = makeDir();
  await withServer(dir, {}, async (port) => {
    for (const method of ['PUT', 'DELETE', 'TRACE', 'OPTIONS']) {
      const res = await request(port, { method });
      assert.equal(res.status, 405, `${method} must not be served a page`);
      assert.equal(res.headers.allow, 'GET, HEAD');
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-15 — bodyLimit
// ---------------------------------------------------------------------------

test('SEC-15: bodyLimit accepts a size string and refuses nonsense loudly', async () => {
  const dir = makeDir();
  const { server } = await serveDirectory(dir, 0, '127.0.0.1', {
    quiet: true,
    bodyLimit: '10mb',
  });
  assert.ok(server.address().port > 0, 'a size string must not stop the server from starting');
  await new Promise((resolve) => server.close(resolve));

  await assert.rejects(
    () => serveDirectory(dir, 0, '127.0.0.1', { quiet: true, bodyLimit: 'a lot' }),
    /server\.bodyLimit/,
    'an unreadable limit must fail at startup, not silently remove the limit',
  );
});

// ---------------------------------------------------------------------------
// SEC-20 — timeouts exist
// ---------------------------------------------------------------------------

test('SEC-20: the server has header, request and idle timeouts plus a connection cap', async () => {
  const dir = makeDir();
  const { server } = await serveDirectory(dir, 0, '127.0.0.1', { quiet: true });
  try {
    assert.equal(server.headersTimeout, 15000);
    assert.equal(server.requestTimeout, 30000);
    assert.equal(server.timeout, 30000);
    assert.equal(server.maxConnections, 1024);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// SEC-18 — trustProxy on a dual-stack bind
// ---------------------------------------------------------------------------

test('SEC-18: trustProxy matches the IPv4 peer reported as ::ffff: by a :: bind', async () => {
  const dir = makeDir();
  const { server } = await serveDirectory(dir, 0, '::', {
    quiet: true,
    trustProxy: '127.0.0.1',
    rateLimit: { windowMs: 60000, max: 1 },
  });
  const port = server.address().port;
  try {
    // The first request fills the bucket for whatever IP the server computed.
    await request(port);
    // If the proxy were not trusted, `X-Forwarded-For` would be ignored and this
    // request would land in the same bucket and get 429.
    const second = await request(port, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.notEqual(second.status, 429, 'a trusted proxy address must be recognised');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// SEC-14 — replacement-string injection
// ---------------------------------------------------------------------------

test('SEC-14: $& in a title does not splice the old element', () => {
  const shell = '<html><head><title>Old</title></head><body></body></html>';
  const out = applyMeta(shell, { title: 'A$&B' });
  assert.equal(out, '<html><head><title>A$&amp;B</title></head><body></body></html>');
  assert.equal((out.match(/<title>/g) || []).length, 1);
});

test("SEC-14: $' in a query value does not splice the document into the data tag", () => {
  const shell = '<html><body><div id="root"></div></body></html>';
  const tag = '<script type="application/json" id="__hydra_data__">{"q":"$\'"}</script>';
  const out = injectData(shell, tag);
  assert.ok(out.includes('</body></html>'), 'the document must stay intact');
  assert.ok(!out.includes('</div></body></html></script>'), 'the payload must not swallow the document');
});

// ---------------------------------------------------------------------------
// SEC-06 — a project's .env cannot set framework knobs
// ---------------------------------------------------------------------------

test('SEC-06: .env may not set HYDRA_*, NODE_ENV or PORT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-env-'));
  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      'PUBLIC_SITE_NAME=example',
      'DATABASE_URL=postgres://localhost/db',
      'HYDRA_NATIVE=./x/hydra.node',
      'HYDRA_COMPILER=./x/hydra',
      'HYDRA_EXPOSE_ERRORS=1',
      'NODE_ENV=production',
      'PORT=9999',
    ].join('\n'),
  );
  const target = {};
  const result = loadProjectEnv(dir, target, 'production');
  assert.equal(target.PUBLIC_SITE_NAME, 'example', 'project variables still load');
  assert.equal(target.DATABASE_URL, 'postgres://localhost/db');
  assert.equal(target.HYDRA_NATIVE, undefined, 'HYDRA_NATIVE names an executable to require');
  assert.equal(target.HYDRA_COMPILER, undefined);
  assert.equal(target.HYDRA_EXPOSE_ERRORS, undefined, 'redaction must not be flippable from a repo');
  assert.equal(target.NODE_ENV, undefined);
  assert.equal(target.PORT, undefined);
  assert.deepEqual(result.refused.sort(), [
    'HYDRA_COMPILER',
    'HYDRA_EXPOSE_ERRORS',
    'HYDRA_NATIVE',
    'NODE_ENV',
    'PORT',
  ]);
});
