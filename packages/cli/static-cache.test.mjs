// [xihanzu-NR]
// Conditional GET for a served directory.
//
// SEC-33. A static file carried `Cache-Control` but no validator, so a returning
// visitor had no way to say "I already have this": every reload re-transferred
// the shell, and a browser that did hold a copy could only re-download it. The
// 304 path has to repeat the validators and the caching policy, because a proxy
// that lost them on the 304 would start revalidating from scratch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { serveDirectory } = await import('./runner.mjs');

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cond-'));
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

async function withServer(dir, fn) {
  const { server } = await serveDirectory(dir, 0, '127.0.0.1', { quiet: true });
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a static file carries a validator, and revalidating it answers 304', async () => {
  const dir = makeDir({ 'app.css': 'body{color:red}' });
  await withServer(dir, async (port) => {
    const first = await request(port, '/app.css');
    assert.equal(first.status, 200);
    const etag = first.headers.etag;
    assert.ok(etag, 'no ETag on a static response');
    assert.ok(first.headers['last-modified'], 'no Last-Modified on a static response');

    const again = await request(port, '/app.css', { 'if-none-match': etag });
    assert.equal(again.status, 304, 'a matching If-None-Match must not resend the body');
    assert.equal(again.body, '');
    // A 304 that drops the policy restarts validation at the proxy.
    assert.equal(again.headers.etag, etag);
    assert.ok(again.headers['cache-control'], 'the 304 lost its Cache-Control');

    // `Last-Modified` is second-resolution; a browser echoes it verbatim, so the
    // comparison has to floor to the same second rather than compare milliseconds.
    const byDate = await request(port, '/app.css', {
      'if-modified-since': first.headers['last-modified'],
    });
    assert.equal(byDate.status, 304, 'If-Modified-Since was ignored');

    const stale = await request(port, '/app.css', { 'if-none-match': 'W/"deadbeef"' });
    assert.equal(stale.status, 200, 'a non-matching validator must send the file');
    assert.equal(stale.body, 'body{color:red}');
  });
});

test('the tag changes when the file does', async () => {
  const dir = makeDir({ 'app.js': 'console.log(1)' });
  await withServer(dir, async (port) => {
    const first = await request(port, '/app.js');
    // Same size, different contents, and a mtime moved past the second so the
    // validator is not just size+time collapsing back to the same value.
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(2)');
    const when = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'app.js'), when, when);
    const second = await request(port, '/app.js');
    assert.notEqual(second.headers.etag, first.headers.etag, 'a changed file kept its ETag');
  });
});

test('dev-injected HTML is not cached, and is never 304ed', async () => {
  const dir = makeDir({ 'index.html': '<html><body><div id="root"></div></body></html>' });
  const opts = {
    quiet: true,
    injectHtml: (html) => html.replace('</body>', '<script>/*live*/</script></body>'),
  };
  const { server } = await serveDirectory(dir, 0, '127.0.0.1', opts);
  const port = server.address().port;
  try {
    const first = await request(port, '/');
    assert.equal(first.status, 200);
    assert.ok(first.body.includes('/*live*/'));
    assert.equal(first.headers.etag, undefined, 'a per-request page must not be validated');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a draining server tells the balancer 503 before it closes', async () => {
  // SEC-36 / L-11. Shutdown used to keep answering `200 ok` until the process
  // exited, so a load balancer kept routing to a corpse for the last second of
  // every deploy, and the in-flight SSR cut at the 5s mark.
  const dir = makeDir({ 'index.html': '<html><body>hi</body></html>' });
  const served = await serveDirectory(dir, 0, '127.0.0.1', { quiet: true });
  const port = served.port;
  try {
    const before = await request(port, '/__hydra/healthz');
    assert.equal(before.status, 200);
    assert.equal(JSON.parse(before.body).status, 'ok');

    const drained = served.drain();
    // The socket is still open; only the ANSWER changed.
    const during = await request(port, '/__hydra/healthz');
    assert.equal(during.status, 503, 'a draining process must not claim to be ready');
    assert.equal(JSON.parse(during.body).status, 'draining');
    await drained;
  } finally {
    try {
      await new Promise((resolve) => served.server.close(resolve));
    } catch {
      /* already closed by drain() */
    }
  }
});

test('a byte range is answered 206, and a bad range 416 with the size', async () => {
  // L-09. Nothing in a served directory answered `Accept-Ranges`, so a browser
  // could not seek an mp4 at all: Safari refuses to play one served as a plain
  // 200, and Chrome re-downloads from zero on every scrub. The 416 branch
  // carries `Content-Range: bytes */size`, because a bare 416 gives the player
  // nothing to size its next request against.
  const body = 'x'.repeat(1000) + 'TAIL';
  const dir = makeDir({ 'clip.mp4': body });
  await withServer(dir, async (port) => {
    const whole = await request(port, '/clip.mp4');
    assert.equal(whole.status, 200);
    assert.equal(whole.headers['accept-ranges'], 'bytes');

    const head = await request(port, '/clip.mp4', { Range: 'bytes=0-9' });
    assert.equal(head.status, 206);
    assert.equal(head.body, body.slice(0, 10));
    assert.equal(head.headers['content-range'], `bytes 0-9/${body.length}`);
    assert.equal(head.headers['content-length'], '10');

    const tail = await request(port, '/clip.mp4', { Range: 'bytes=-4' });
    assert.equal(tail.status, 206, 'a suffix range is the LAST n bytes');
    assert.equal(tail.body, 'TAIL');

    const open = await request(port, '/clip.mp4', { Range: 'bytes=1000-' });
    assert.equal(open.status, 206);
    assert.equal(open.body, 'TAIL');

    const past = await request(port, '/clip.mp4', { Range: 'bytes=99999-' });
    assert.equal(past.status, 416);
    assert.equal(past.headers['content-range'], `bytes */${body.length}`);

    // A multipart range is not answered as one range, silently, which would
    // hand the client the first slice and no sign that the rest was dropped.
    const multi = await request(port, '/clip.mp4', { Range: 'bytes=0-1,4-5' });
    assert.equal(multi.status, 200, 'an unsupported range form falls back to the whole file');
  });
});
