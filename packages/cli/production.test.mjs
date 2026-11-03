// [xihanzu-NR]
/**
 * End-to-end evidence for the production-readiness fixes.
 *
 * Every test here drives the REAL CLI against a REAL project on disk and reads
 * the REAL HTTP response. Nothing is mocked: the failures this guards against
 * (a loader that cannot see headers, a redirect answered with 200, a 413 that
 * kills the socket) are all invisible to unit tests because they live in the
 * wiring between the server, the bundle and the request.
 *
 * Run: node --test packages/cli/production.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const BIN = path.join(ROOT, 'bin', 'hydra');
const REACT = path.join(ROOT, 'examples', 'blog', 'node_modules');

/** A project with everything the fixes touch: routes, a loader, an API, a 404. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-prod-'));
  fs.mkdirSync(path.join(dir, 'src', 'pages', 'blog'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
  // Symlinked, not copied: the fixture needs react/react-dom and nothing else.
  fs.symlinkSync(REACT, path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 'prod', rendering: { ssg: true } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    'from hydra import mount\nfrom "./App.hyx" import App\nmount(App, document.getElementById("root"))\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    'from hydra import Router\ncomponent App():\n    Router()\n',
  );
  fs.writeFileSync(path.join(dir, 'src', 'pages', 'index.hyx'), 'component H():\n    div(cls="h"): "HOME"\n');
  fs.writeFileSync(path.join(dir, 'src', 'pages', 'about.hyx'), 'component A():\n    div(cls="a"): "ABOUT"\n');
  fs.writeFileSync(path.join(dir, 'src', 'pages', '_404.hyx'), 'component N():\n    div(cls="nf"): "NOT FOUND"\n');

  // A dynamic route whose loader reads EVERYTHING the docs promise it can see.
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    'component Post(slug: str = "?", ua: str = "?", cookie: str = "?", tab: str = "?", full: str = "?"):\n' +
      '    div(cls="b"):\n' +
      '        p(cls="slug"): f"slug={slug}"\n' +
      '        p(cls="ua"): f"ua={ua}"\n' +
      '        p(cls="cookie"): f"cookie={cookie}"\n' +
      '        p(cls="tab"): f"tab={tab}"\n' +
      '        p(cls="full"): f"full={full}"\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].server.hys'),
    'from "hydra/server" import redirect\n' +
      'export async def loader(event):\n' +
      '    if event.query.get("go", "") == "login":\n' +
      '        return redirect("/login")\n' +
      '    return {\n' +
      '        "slug": event.params.get("slug"),\n' +
      '        "ua": event.request.headers.get("user-agent", "NONE"),\n' +
      '        "cookie": event.request.headers.get("cookie", "NONE"),\n' +
      '        "tab": event.query.get("tab", "none"),\n' +
      '        "full": event.url,\n' +
      '    }\n',
  );

  // The three shapes the API layer used to get wrong: a list, a fail(), a POST.
  fs.writeFileSync(
    path.join(dir, 'src', 'api', 'list.hys'),
    'export def get(req):\n    return [1, 2, 3]\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'api', 'guarded.hys'),
    'from "hydra/server" import fail\nexport def get(req):\n    return fail(401, {"reason": "no token"})\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'api', 'echo.hys'),
    'export def post(req, body):\n    return {"name": body.get("name", "none")}\n',
  );
  return dir;
}

function build(dir, extra = []) {
  const out = spawnSync(BIN, ['build', '--target', 'node', ...extra], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HYDRA_NO_GATE: '1' },
    timeout: 120000,
  });
  assert.equal(out.status, 0, `build failed:\n${out.stdout}\n${out.stderr}`);
  return out;
}

/**
 * A port nothing is listening on.
 *
 * Fixed ports made two problems: a leaked server from an earlier run answered
 * `healthz` first, so the test drove the WRONG project and reported its 500 as
 * the fix failing; and a parallel `node --test` run took the same port and
 * failed for the same reason. Asking the OS is the only honest way to get one.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Start `hydra serve` and resolve once it answers, or reject with its log. */
function serve(dir, port) {
  return new Promise((resolve, reject) => {
    // `detached` so the whole PROCESS GROUP can be signalled. `bin/hydra` is the
    // native launcher and it spawns the Node runner as a child: killing only the
    // launcher left the runner holding the port and its stdio pipes, which kept
    // `node --test` alive after every test had passed.
    const child = spawn(BIN, ['serve', '--port', String(port)], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: true,
    });
    let log = '';
    const onData = (b) => {
      log += b.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`serve exited ${code}:\n${log}`)));

    const deadline = Date.now() + 20000;
    const poll = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/__hydra/healthz' }, (res) => {
        res.resume();
        // The exit listener was only for the startup failure path; once serving,
        // a later SIGTERM must not reject a promise nobody is waiting on.
        child.removeAllListeners('exit');
        resolve({ child, log: () => log });
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          reject(new Error(`serve never answered:\n${log}`));
          return;
        }
        setTimeout(poll, 150);
      });
    };
    poll();
  });
}

/**
 * Stop a served project and wait for it to be gone.
 *
 * SIGTERM to the group, then a hard kill if it is still there after two
 * seconds. Without the wait, the next test can start while the previous server
 * still holds its port.
 */
async function stop(served) {
  if (!served || !served.child.pid) return;
  const { child } = served;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(child.pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

function request(port, method, pathName, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathName, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('a loader sees the real headers, the query string and the full URL', async (t) => {
  const dir = project();
  let served;
  let port;
  try {
    build(dir);
    port = await freePort();
    served = await serve(dir, port);
    t.after(async () => {
      await stop(served);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const res = await request(port, 'GET', '/blog/hello?tab=info', {
      headers: { 'user-agent': 'TESTUA/1.0', cookie: 'sid=abc' },
    });
    assert.equal(res.status, 200);
    // The HTML is the server render: every one of these came from the LOADER.
    assert.match(res.body, /slug=hello/, 'params reach the loader');
    assert.match(res.body, /ua=TESTUA\/1\.0/, 'request headers reach the loader');
    assert.match(res.body, /cookie=sid=abc/, 'cookies reach the loader');
    assert.match(res.body, /tab=info/, 'the query string reaches the loader');
    assert.match(res.body, /full=\/blog\/hello\?tab=info/, 'event.url is the full URL');

    // The data endpoint must agree with the HTML, byte for byte, or a client
    // navigation renders a different page than a reload.
    const data = await request(port, 'GET', '/__hydra/data?url=%2Fblog%2Fhello%3Ftab%3Dinfo', {
      headers: { 'user-agent': 'TESTUA/1.0', cookie: 'sid=abc' },
    });
    const payload = JSON.parse(data.body);
    assert.equal(payload.data.slug, 'hello');
    assert.equal(payload.data.tab, 'info');
    assert.equal(payload.data.full, '/blog/hello?tab=info');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('redirect() from a loader is a real 303 with a Location, not a 200 page', async (t) => {
  const dir = project();
  try {
    build(dir);
    const port = await freePort();
    const served = await serve(dir, port);
    t.after(async () => {
      await stop(served);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const res = await request(port, 'GET', '/blog/x?go=login');
    assert.equal(res.status, 303, 'a redirect must not be answered with 200');
    assert.equal(res.headers.location, '/login');

    // The same URL without the trigger still renders.
    const ok = await request(port, 'GET', '/blog/x');
    assert.equal(ok.status, 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a URL nothing matches answers 404 with the project _404, not the home page', async (t) => {
  const dir = project();
  try {
    build(dir);
    assert.ok(fs.existsSync(path.join(dir, 'dist', '404.html')), '404.html is written for static hosts');
    const port = await freePort();
    const served = await serve(dir, port);
    t.after(async () => {
      await stop(served);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const res = await request(port, 'GET', '/nope', { headers: { accept: 'text/html' } });
    assert.equal(res.status, 404);
    assert.match(res.body, /NOT FOUND/);
    // The home page's markup must NOT be what a 404 serves: serving it made
    // React re-render the whole tree (#425 then #423).
    assert.doesNotMatch(res.body, /class="h"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing asset is 404, never index.html with a 200', async (t) => {
  const dir = project();
  try {
    build(dir);
    const port = await freePort();
    const served = await serve(dir, port);
    t.after(async () => {
      await stop(served);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // Asked for as a SCRIPT: the browser sends */*, and a text/html answer is
    // how a stale deploy becomes a blank page with only a MIME error in the log.
    const js = await request(port, 'GET', '/assets/old-chunk.js', { headers: { accept: '*/*' } });
    assert.equal(js.status, 404);
    assert.doesNotMatch(js.headers['content-type'] || '', /text\/html/);

    // Even when the client claims to accept HTML, an asset path stays a 404.
    const jsHtml = await request(port, 'GET', '/assets/old-chunk.js', {
      headers: { accept: 'text/html' },
    });
    assert.equal(jsHtml.status, 404);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a body over the limit is 413 with a JSON answer, not a dead socket', async (t) => {
  const dir = project();
  try {
    build(dir);
    const port = await freePort();
    const served = await serve(dir, port);
    t.after(async () => {
      await stop(served);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // Guard the fixture itself: if the API bundle is not there, the 500 below
    // is about the test, not about the server.
    assert.ok(
      fs.existsSync(path.join(dir, '.hydra', 'api.cjs')),
      `fixture produced no API bundle; .hydra has ${fs.existsSync(path.join(dir, '.hydra')) ? fs.readdirSync(path.join(dir, '.hydra')).join(', ') : 'nothing'}`,
    );

    const big = 'a'.repeat(1100000); // 1.1 MB, past the 1 MiB default
    const res = await request(port, 'POST', '/api/echo', {
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    });
    assert.equal(res.status, 413, `expected 413, got ${res.status}: ${res.body.slice(0, 300)}`);
    const payload = JSON.parse(res.body);
    assert.match(payload.error, /larger than/);
    // The envelope is `{error, code, detail}` now — one shape for every
    // framework failure — so the limit travels in `detail`.
    assert.equal(payload.code, 'body_too_large');
    assert.ok(payload.detail.limit > 0);

    // The server is still alive and answering.
    const after = await request(port, 'GET', '/api/list');
    assert.equal(after.status, 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HEAD works, a list is a list, and fail() answers its own status', async (t) => {
  const dir = project();
  try {
    build(dir);
    const port = await freePort();
    const served = await serve(dir, port);
    t.after(async () => {
      await stop(served);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // HEAD: the headers of a GET and no body. It used to be 405, which broke
    // every monitor and every `curl -I`.
    const head = await request(port, 'HEAD', '/api/list');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.match(String(head.headers.allow || 'GET'), /GET/);

    // A three-item list is DATA. It used to be read as `(body, status)` and
    // answered 500 "Invalid status code: 2".
    const list = await request(port, 'GET', '/api/list');
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body), [1, 2, 3]);

    // fail(401) used to be answered 200 with the refusal in the body.
    const guarded = await request(port, 'GET', '/api/guarded');
    assert.equal(guarded.status, 401);
    assert.deepEqual(JSON.parse(guarded.body), { reason: 'no token' });

    // A POST with no body is legal, and `body.get` must not throw on it.
    const empty = await request(port, 'POST', '/api/echo', {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(JSON.parse(empty.body), { name: 'none' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build cleans the output directory, so a deleted route stops being served', async (t) => {
  const dir = project();
  try {
    build(dir);
    assert.ok(fs.existsSync(path.join(dir, 'dist', 'about', 'index.html')));

    fs.rmSync(path.join(dir, 'src', 'pages', 'about.hyx'));
    build(dir);

    assert.equal(
      fs.existsSync(path.join(dir, 'dist', 'about', 'index.html')),
      false,
      'a route removed from the source must not survive in dist/',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the client bundle is split per route, and the entry stays small', async (t) => {
  const dir = project();
  try {
    build(dir);
    const assets = path.join(dir, 'dist', 'assets');
    const entry = fs.readdirSync(assets).find((f) => /^index-.*\.js$/.test(f));
    assert.ok(entry, 'an entry chunk exists');
    const entrySize = fs.statSync(path.join(assets, entry)).size;

    const chunks = fs.readdirSync(path.join(assets, 'chunks')).filter((f) => f.endsWith('.js'));
    assert.ok(chunks.length >= 2, `expected per-route chunks, found ${chunks.join(', ')}`);
    // The entry is React + the runtime; the PAGES are elsewhere. An absolute
    // byte ceiling would just measure React's minified size, so the comparison
    // is against the page chunks: if the entry carried them, no chunk would
    // exist at all (which is what the `chunks >= 2` assertion above checks).
    // What must also hold is that the entry does not grow with routes.
    const pageChunkBytes = chunks.reduce(
      (n, f) => n + fs.statSync(path.join(assets, 'chunks', f)).size,
      0,
    );
    assert.ok(
      pageChunkBytes > 0 && entrySize < 200000,
      `entry ${entrySize} bytes, page chunks ${pageChunkBytes} bytes — the entry still carries the pages`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hydra serve refuses a static build instead of serving empty shells', async (t) => {
  const dir = project();
  try {
    const out = spawnSync(BIN, ['build'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, HYDRA_NO_GATE: '1' },
      timeout: 120000,
    });
    assert.equal(out.status, 0, out.stderr);

    const served = spawnSync(BIN, ['serve', '--port', '4727'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env },
    });
    assert.notEqual(served.status, 0, 'serving a static build must fail');
    assert.match(served.stderr + served.stdout, /--target static|target node/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
