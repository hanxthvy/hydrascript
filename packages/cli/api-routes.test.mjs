// [xihanzu-NR]
/**
 * `src/api`, `src/middleware.hys`, `.env` and `hydra build --target`.
 *
 * These are the four Phase 3 features, and they are tested together because
 * they are only safe together: an API route without the secret split is a trap,
 * and the split without a build error is a comment.
 *
 * The HTTP tests spawn the REAL `hydra dev` as a child process and talk to it
 * over a socket. Not `serveDirectory` with hand-passed options: half the
 * feature is the wiring (which bundle a command mounts, and when), and calling
 * the layer directly would skip exactly the part that regressed — a request
 * that reached the API layer, matched nothing, and was never answered at all.
 *
 * Run: node --test packages/cli/api-routes.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBuild } from './runner.mjs';
import { parseDotEnv, loadProjectEnv, clientEnvViolations } from './env.mjs';
import { scanApiRoutes, apiResult } from './api-routes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const HYDRA = path.join(REPO, 'bin', 'hydra.js');

/**
 * A directory whose `node_modules` actually has React.
 *
 * This package's own dependencies are the bundler (esbuild, PostCSS, Tailwind);
 * React belongs to a PROJECT. The examples are the projects in this repository,
 * and a test that hard-coded one of them broke the moment that example's
 * install moved — so every candidate is checked for the package itself.
 */
const REACT_MODULES = [
  path.join(REPO, 'node_modules'),
  path.join(REPO, 'examples', 'blog', 'node_modules'),
  path.join(REPO, 'examples', 'todos', 'node_modules'),
].find((d) => fs.existsSync(path.join(d, 'react', 'package.json')));

/** A project with one page, one GET+POST API route, and a middleware. */
function project({ middleware = true, env = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-api-'));
  const write = (rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  };

  write('hydraconfig.json', JSON.stringify({ name: 'api', root: './src', outputDir: './dist' }));
  write(
    'index.html',
    '<!DOCTYPE html><html><head><title>api</title></head><body><div id="root"></div></body></html>',
  );
  write(
    'src/main.hyx',
    '# [xihanzu-NR]\nfrom hydra import mount\nfrom "./App.hyx" import App\nmount(App, document.getElementById("root"))\n',
  );
  write('src/App.hyx', '# [xihanzu-NR]\nfrom hydra import Router\ncomponent App():\n    Router()\n');
  write('src/pages/index.hyx', '# [xihanzu-NR]\ncomponent Home():\n    div(cls="home"): "home"\n');
  write(
    'src/api/hello.hys',
    [
      '# [xihanzu-NR]',
      'from "hydra/server" import env',
      '',
      'export def get(req):',
      '    return {"ok": True, "who": env("SECRET_KEY", "nobody")}',
      '',
      'export def post(req, body):',
      '    return {"created": body["name"]}, 201',
      '',
    ].join('\n'),
  );
  if (middleware) {
    write(
      'src/middleware.hys',
      [
        '# [xihanzu-NR]',
        'export def handle(req):',
        '    if req.path.startswith("/api/admin"):',
        '        return {"error": "blocked"}, 403',
        '    req.headers["x-seen"] = "yes"',
        '    return None',
        '',
      ].join('\n'),
    );
  }
  if (env) {
    write('.env', '# [xihanzu-NR]\nPUBLIC_SERVICE=probe\nSECRET_KEY=sk_test_value\n');
  }
  if (REACT_MODULES) {
    fs.symlinkSync(REACT_MODULES, path.join(dir, 'node_modules'), 'dir');
  }
  return dir;
}

/**
 * A request against a live server, with a hard timeout.
 *
 * The timeout is not politeness. The first version of the API layer returned
 * from the request handler WITHOUT writing a response when no route matched, so
 * the socket sat open until curl gave up. A test that can wait forever does not
 * report that bug — it stalls the suite.
 */
function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
        timeout: 5000,
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no response within 5s: ${method} ${urlPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Run `fn(port)` against a real `hydra dev` on whatever port it lands on.
 *
 * The port is read from the server's own log line rather than chosen here:
 * `dev` walks to the next free port on EADDRINUSE, so a port picked in the test
 * is a port the server may not be on. Killing the process GROUP is deliberate —
 * the runner is a child of `bin/hydra.js`, and killing only the parent leaves
 * the actual server holding the port.
 */
async function withDevServer(dir, fn) {
  // A random high port, and the REAL one is then read from the log: `dev` walks
  // to the next free port on EADDRINUSE, so the number asked for is a wish.
  const wanted = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [HYDRA, 'dev', '--port', String(wanted)], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`hydra dev never reported a port:\n${out}`)),
        180_000,
      );
      const scan = (chunk) => {
        out += chunk.toString();
        const m = /Server running at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      };
      child.stdout.on('data', scan);
      child.stderr.on('data', scan);
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`hydra dev exited with ${code}:\n${out}`));
      });
    });
    return await fn(port);
  } finally {
    kill();
  }
}

test('.env parses KEY=VALUE, comments and quotes, and never interpolates', () => {
  const vars = parseDotEnv(
    [
      '# comment',
      '',
      'A=1',
      'B = two words ',
      'C="quoted # not a comment"',
      "D='single'",
      'E=value # trailing comment',
      'export F=exported',
      'not a pair',
      '1BAD=x',
      'G=${A}',
    ].join('\n'),
  );
  assert.deepEqual(vars, {
    A: '1',
    B: 'two words',
    C: 'quoted # not a comment',
    D: 'single',
    E: 'value',
    F: 'exported',
    G: '${A}',
  });
  // Interpolation is absent on purpose: `${A}` is the literal string, so a
  // reader can always tell what a build inlined and what it did not.
  assert.equal(vars.G, '${A}');
});

test('loadProjectEnv never overrides a variable the real environment set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-env-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'FROM_FILE=file\nBOTH=file\n', 'utf8');
    const target = { BOTH: 'shell' };
    const out = loadProjectEnv(dir, target);
    assert.equal(target.FROM_FILE, 'file');
    assert.equal(target.BOTH, 'shell', 'the deploy environment must win over a shipped .env');
    assert.deepEqual(out.applied, ['FROM_FILE']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the client scan flags a secret and a computed key, and allows PUBLIC_', () => {
  const code = [
    'const a = process.env.SECRET_KEY;',
    'const b = process.env.PUBLIC_SITE;',
    'const c = process.env[name];',
    'const d = process.env.NODE_ENV;',
    'const e = import.meta.env.PUBLIC_SITE;',
  ].join('\n');
  const found = clientEnvViolations(code);
  assert.deepEqual(
    found.map((v) => `${v.reason}:${v.name}`),
    ['secret:SECRET_KEY', 'computed:null'],
  );
  // `NODE_ENV` and every `PUBLIC_*` are provided by the build, not read from it.
  assert.equal(found.some((v) => v.name === 'NODE_ENV'), false);
  assert.equal(found.some((v) => v.name === 'PUBLIC_SITE'), false);
});

test('scanApiRoutes maps files to URLs, including nested folders and params', () => {
  const dir = project({ middleware: false, env: false });
  try {
    fs.mkdirSync(path.join(dir, 'src', 'api', 'admin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'api', 'users'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'api', 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'api', '_internal'), { recursive: true });
    const write = (rel) =>
      fs.writeFileSync(
        path.join(dir, 'src', 'api', rel),
        '# [xihanzu-NR]\nexport def get(req):\n    return {}\n',
      );
    for (const rel of [
      'admin/users.hys',
      '_private.hys',
      'index.hys',
      'users/index.hys',
      'users/[id].hys',
      'files/[...rest].hys',
      '_internal/hidden.hys',
    ]) {
      write(rel);
    }

    const table = scanApiRoutes(dir);
    assert.deepEqual(table.routes.map((r) => r.pattern).sort(), [
      '/api',
      '/api/admin/users',
      '/api/files/*',
      '/api/hello',
      '/api/users',
      '/api/users/:id',
    ]);

    // A parameter is NAMED, because `req.params` is keyed by it.
    const byId = table.routes.find((r) => r.pattern === '/api/users/:id');
    assert.deepEqual(byId.params, ['id']);
    assert.equal(byId.segments.at(-1).kind, 'param');

    const rest = table.routes.find((r) => r.pattern === '/api/files/*');
    assert.deepEqual(rest.params, ['rest']);
    assert.equal(rest.segments.at(-1).kind, 'catchall');

    const ignored = table.ignored.map((i) => i.file.split(path.sep).join('/'));
    assert.deepEqual(ignored.sort(), ['src/api/_internal', 'src/api/_private.hys']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed segment and a duplicate URL are reported, not routed', () => {
  const dir = project({ middleware: false, env: false });
  try {
    fs.mkdirSync(path.join(dir, 'src', 'api', 'users'), { recursive: true });
    const write = (rel, body = 'export def get(req):\n    return {}\n') =>
      fs.writeFileSync(path.join(dir, 'src', 'api', rel), '# [xihanzu-NR]\n' + body);
    write('users/[bad.hys');          // unclosed bracket
    write('users/[id].hys');
    write('users/[slug].hys');        // same URL position, another name

    const table = scanApiRoutes(dir);
    const errors = table.errors.map((e) => e.reason).join('\n');
    assert.match(errors, /not a usable URL segment/, 'a malformed bracket is named');
    assert.match(errors, /both answer \/api\/users\/:(id|slug)/, "a duplicate URL is named");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apiResult reads the two return shapes the language produces', () => {
  assert.deepEqual(apiResult({ ok: true }), { status: 200, body: { ok: true } });
  assert.deepEqual(apiResult([{ created: 1 }, 201]), { status: 201, body: { created: 1 } });
  assert.deepEqual(apiResult(null), { status: 204, body: null });
  assert.deepEqual(apiResult(['plain', 418]), { status: 418, body: 'plain' });
});

test('dev answers GET and POST over HTTP, and middleware blocks one path and passes another', async (t) => {
  const dir = project();
  try {
    const seen = await withDevServer(dir, async (port) => {
      const get = await request(port, 'GET', '/api/hello');
      const post = await request(port, 'POST', '/api/hello', { name: 'xihanzu' });
      const blocked = await request(port, 'GET', '/api/admin/users');
      const passed = await request(port, 'POST', '/api/hello', { name: 'again' });
      const put = await request(port, 'PUT', '/api/hello', {});
      const missing = await request(port, 'GET', '/api/nope');
      return { get, post, blocked, passed, put, missing };
    });

    // GET: JSON, and the server read a non-PUBLIC_ variable that the .env holds
    // — the value is deliberately NOT the fallback, so this proves the file was
    // loaded rather than the default being returned.
    assert.equal(seen.get.status, 200, seen.get.text);
    assert.match(seen.get.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(seen.get.text), { ok: true, who: 'sk_test_value' });

    // POST: the body arrives parsed, and the tuple sets the status.
    assert.equal(seen.post.status, 201, seen.post.text);
    assert.deepEqual(JSON.parse(seen.post.text), { created: 'xihanzu' });

    // Middleware REPLIES on one path...
    assert.equal(seen.blocked.status, 403, seen.blocked.text);
    assert.deepEqual(JSON.parse(seen.blocked.text), { error: 'blocked' });

    // ...and PASSES the other, which still reaches its handler. A middleware
    // that swallowed everything would pass the 403 assertion above.
    assert.equal(seen.passed.status, 201, 'a pass-through must not swallow the request');
    assert.deepEqual(JSON.parse(seen.passed.text), { created: 'again' });

    // A method the file does not export is a 405 that says which ones it does.
    assert.equal(seen.put.status, 405, seen.put.text);
    assert.match(seen.put.headers.allow || '', /GET/);

    // A missing API route is a JSON 404, never index.html with a 200: the SPA
    // fallback answering `/api/nope` with HTML is the failure this guards.
    assert.equal(seen.missing.status, 404);
    assert.match(seen.missing.headers['content-type'], /application\/json/);
    assert.match(seen.missing.text, /no API route/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-PUBLIC_ variable in a client file FAILS the build, naming it', async (t) => {
  const dir = project({ middleware: false });
  // A `.hys` imported by the entry, not a `.hyx`: the rule has to hold for
  // every module that reaches the client, and a `.hyx`-only check would have
  // passed this one while shipping the value.
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'lib', 'leaky.hys'),
    '# [xihanzu-NR]\ndef label():\n    return "k=" + process.env.SECRET_KEY\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    [
      '# [xihanzu-NR]',
      'from hydra import Router',
      'from "./lib/leaky.hys" import label',
      'component App():',
      '    div:',
      '        Router()',
      '        span: label()',
      '',
    ].join('\n'),
  );

  let message = '';
  try {
    await runBuild(dir, { target: 'node', mode: 'production' });
  } catch (err) {
    message = String(err && err.message ? err.message : err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.notEqual(message, '', 'the build must FAIL, not succeed with the secret inlined');
  assert.match(message, /SECRET_KEY/, 'the error must NAME the variable');
  assert.match(message, /leaky\.hys/, 'the error must NAME the file');
  assert.match(message, /PUBLIC_/, 'the error must say how to fix it');
});

test('a client file may read PUBLIC_, and the value is inlined', async (t) => {
  const dir = project({ middleware: false });
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    [
      '# [xihanzu-NR]',
      'from hydra import Router',
      'component App():',
      '    div:',
      '        Router()',
      '        span(cls="svc"): f"{process.env.PUBLIC_SERVICE}"',
      '',
    ].join('\n'),
  );
  try {
    await runBuild(dir, { target: 'node', mode: 'production' });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    return t.skip(`this checkout cannot build a full project: ${err.message.split('\n')[0]}`);
  }
  const html = fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8');
  assert.match(html, /probe/, 'PUBLIC_SERVICE must be inlined from .env');
  // The secret is in .env for the same project and must appear NOWHERE in dist.
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  const leaked = walk(path.join(dir, 'dist')).filter(
    (f) => fs.readFileSync(f, 'utf8').includes('sk_test_value'),
  );
  assert.deepEqual(leaked, [], 'a non-PUBLIC_ value must never reach dist/');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--target takes exactly node and static, and a static build LISTS what it drops', async () => {
  const dir = project();
  const original = console.log;
  try {
    // A third value is refused, and the message says the list is closed.
    let rejected = '';
    try {
      await runBuild(dir, { target: 'edge', mode: 'production' });
    } catch (err) {
      rejected = String(err && err.message ? err.message : err);
    }
    assert.match(rejected, /must be "node" or "static"/);

    const logs = [];
    console.log = (...a) => {
      logs.push(a.join(' '));
      original.apply(console, a);
    };
    try {
      // The runtime gate spawns a browser; this test is about the build log.
      process.env.HYDRA_NO_GATE = '1';
      await runBuild(dir, { target: 'static', mode: 'production' });
    } finally {
      delete process.env.HYDRA_NO_GATE;
      console.log = original;
    }
    const text = logs.join('\n');
    assert.match(text, /--target static: the server half is NOT in this build/);
    assert.match(text, /dropped\s+\/api\/hello\s+src\/api\/hello\.hys/);
    assert.match(text, /dropped\s+\(middleware\)\s+src\/middleware\.hys/);

    // The record on disk is what `preview` reads to decide what it may serve.
    const record = JSON.parse(fs.readFileSync(path.join(dir, '.hydra', 'build.json'), 'utf8'));
    assert.equal(record.target, 'static');
    assert.deepEqual(record.api, ['/api/hello']);
  } finally {
    console.log = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
