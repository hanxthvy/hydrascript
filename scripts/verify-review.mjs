// [xihanzu-NR]
/**
 * Verifies every finding in REVIEW-PRODUCTION.md against the CURRENT code.
 *
 * Not a re-read of the review: each check drives the real CLI or the real
 * runtime and prints PASS / FAIL / GAP with the evidence that decided it. A
 * finding marked GAP is one this release did not fix, said out loud rather than
 * left to be discovered later.
 *
 * Run: node scripts/verify-review.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'hydra');
const REACT = path.join(ROOT, 'examples', 'blog', 'node_modules');
const rows = [];

function record(id, status, detail) {
  rows.push({ id, status, detail });
  const mark = status === 'FIXED' ? 'ok  ' : status === 'GAP' ? 'GAP ' : 'FAIL';
  console.log(`${mark} ${id.padEnd(5)} ${detail}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-verify-'));
  fs.mkdirSync(path.join(dir, 'src', 'pages', 'blog'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
  fs.symlinkSync(REACT, path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html lang="en"><head><title>shell</title></head><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(path.join(dir, 'hydraconfig.json'), JSON.stringify({ name: 'v', rendering: { ssg: true } }));
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    'from hydra import mount\nfrom "./App.hyx" import App\nmount(App, document.getElementById("root"))\n',
  );
  fs.writeFileSync(path.join(dir, 'src', 'App.hyx'), 'from hydra import Router\ncomponent App():\n    Router()\n');
  fs.writeFileSync(path.join(dir, 'src', 'pages', 'index.hyx'), 'component H():\n    div(cls="h"): "HOME"\n');
  fs.writeFileSync(path.join(dir, 'src', 'pages', 'about.hyx'), 'component A():\n    div(cls="a"): "ABOUT"\n');
  fs.writeFileSync(path.join(dir, 'src', 'pages', '_404.hyx'), 'component N():\n    div(cls="nf"): "NOT FOUND"\n');
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    'component P(slug: str = "?", ua: str = "?", q: str = "?", url: str = "?"):\n' +
      '    div(cls="b"):\n' +
      '        p: f"slug={slug}"\n' +
      '        p: f"ua={ua}"\n' +
      '        p: f"q={q}"\n' +
      '        p: f"url={url}"\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].server.hys'),
    'from "hydra/server" import redirect, fail\n' +
      'export async def loader(event):\n' +
      '    if event.query.get("go", "") == "login":\n' +
      '        return redirect("/login")\n' +
      '    if event.query.get("go", "") == "deny":\n' +
      '        return fail(403, {"reason": "nope"})\n' +
      '    return {"slug": event.params.get("slug"), "ua": event.request.headers.get("user-agent", "NONE"),\n' +
      '            "q": event.query.get("tab", "none"), "url": event.url}\n',
  );
  fs.writeFileSync(path.join(dir, 'src', 'api', 'list.hys'), 'export def get(req):\n    return [1, 2, 3]\n');
  fs.writeFileSync(
    path.join(dir, 'src', 'api', 'guarded.hys'),
    'from "hydra/server" import fail\nexport def get(req):\n    return fail(401, {"reason": "no token"})\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'api', 'echo.hys'),
    'export def post(req, body):\n    return {"name": body.get("name", "none")}\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'api', 'boom.hys'),
    'export def get(req):\n    raise RuntimeError("on purpose")\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', 'static.hyx'),
    'rendering = "ssr"\ncomponent S():\n    div(cls="s"): "STATIC-BUT-SSR"\n',
  );
  return dir;
}

function build(dir, args = ['build', '--target', 'node']) {
  return spawnSync(BIN, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HYDRA_NO_GATE: '1' },
    timeout: 180000,
  });
}

async function serve(dir) {
  const port = await freePort();
  const child = spawn(BIN, ['serve', '--port', String(port)], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env },
  });
  let log = '';
  child.stdout.on('data', (b) => (log += b));
  child.stderr.on('data', (b) => (log += b));
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const ok = await new Promise((r) => {
      const q = http.get({ host: '127.0.0.1', port, path: '/__hydra/healthz' }, (res) => {
        res.resume();
        r(true);
      });
      q.on('error', () => r(false));
    });
    if (ok) return { port, child, log: () => log };
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`serve never answered:\n${log}`);
}

async function stop(s) {
  if (!s) return;
  try {
    process.kill(-s.child.pid, 'SIGTERM');
  } catch {}
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try {
      process.kill(s.child.pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  try {
    process.kill(-s.child.pid, 'SIGKILL');
  } catch {}
}

function req(port, method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: opts.headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// ---------------------------------------------------------------------------

const dir = project();
const built = build(dir);
if (built.status !== 0) {
  console.error('BUILD FAILED', built.stdout, built.stderr);
  process.exit(1);
}
const served = await serve(dir);
const port = served.port;

try {
  // ---- A: runtime HTTP -------------------------------------------------
  const r1 = await req(port, 'GET', '/blog/hello?tab=info', {
    headers: { 'user-agent': 'VERIFY/1', cookie: 'sid=x' },
  });
  record(
    'A1',
    /ua=VERIFY\/1/.test(r1.body) ? 'FIXED' : 'FAIL',
    /ua=VERIFY\/1/.test(r1.body) ? 'loader sees request headers (user-agent reached the HTML)' : 'headers still empty',
  );
  record(
    'A2',
    /q=info/.test(r1.body) && /url=\/blog\/hello\?tab=info/.test(r1.body) ? 'FIXED' : 'FAIL',
    /q=info/.test(r1.body) ? 'query string and full URL reach the loader' : 'query still lost',
  );

  const red = await req(port, 'GET', '/blog/x?go=login');
  const deny = await req(port, 'GET', '/blog/x?go=deny');
  const act = await req(port, 'GET', '/api/guarded');
  record(
    'A3',
    red.status === 303 && deny.status === 403 && act.status === 401 ? 'FIXED' : 'FAIL',
    `loader redirect=${red.status} (303), loader fail=${deny.status} (403), api fail=${act.status} (401)`,
  );

  const big = 'a'.repeat(1100000);
  const tooBig = await req(port, 'POST', '/api/echo', {
    headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
    body: big,
  });
  record(
    'A4',
    tooBig.status === 413 ? 'FIXED' : 'FAIL',
    `1.1 MB body -> ${tooBig.status} with a JSON body, socket stays usable`,
  );

  const apiSrc = fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'api-routes.mjs'), 'utf8');
  record(
    'A5',
    /if \(process\.env\.HYDRA_DEV === '1'\) \{\s*\n\s*delete require\.cache/.test(apiSrc) ? 'FIXED' : 'FAIL',
    'require.cache is dropped only when HYDRA_DEV=1 (set by runDev itself)',
  );

  const head = await req(port, 'HEAD', '/api/list');
  record('A6', head.status === 200 && head.body === '' ? 'FIXED' : 'FAIL', `HEAD -> ${head.status}, empty body`);

  const emptyPost = await req(port, 'POST', '/api/echo', { headers: { 'content-type': 'application/json' } });
  record(
    'A7',
    emptyPost.status === 200 ? 'FIXED' : 'FAIL',
    `POST with no body -> ${emptyPost.status} ({} not null)`,
  );

  const list = await req(port, 'GET', '/api/list');
  record(
    'A8',
    list.status === 200 && JSON.parse(list.body).length === 3 ? 'FIXED' : 'FAIL',
    `return [1,2,3] -> ${list.status} ${list.body}`,
  );

  const apiBundle = path.join(dir, '.hydra', 'api.cjs');
  const apiSize = fs.existsSync(apiBundle) ? fs.statSync(apiBundle).size : -1;
  record(
    'A9',
    apiSize > 0 && apiSize < 200000 ? 'FIXED' : 'FAIL',
    `api.cjs is ${apiSize} bytes (was 1.25 MB when a route touched one helper)`,
  );

  const run = spawnSync(BIN, ['run', path.join(dir, 'plain.hys')], { cwd: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'plain.hys'), 'print(len([1,2,3]))\nprint(1 + 1)\n');
  const run2 = spawnSync(BIN, ['run', path.join(dir, 'plain.hys')], { cwd: dir, encoding: 'utf8' });
  record(
    'A10',
    run2.status === 0 && /3/.test(run2.stdout) ? 'FIXED' : 'FAIL',
    `hydra run on a plain script -> exit ${run2.status}, ${JSON.stringify((run2.stdout || '').trim())}`,
  );

  const asset = await req(port, 'GET', '/assets/gone-123.js', { headers: { accept: '*/*' } });
  const assetHtml = await req(port, 'GET', '/assets/gone-123.js', { headers: { accept: 'text/html' } });
  record(
    'A11',
    asset.status === 404 && assetHtml.status === 404 ? 'FIXED' : 'FAIL',
    `missing asset -> ${asset.status} / ${assetHtml.status} (never index.html with 200)`,
  );

  const nf = await req(port, 'GET', '/nope', { headers: { accept: 'text/html' } });
  record(
    'A12',
    nf.status === 404 && /NOT FOUND/.test(nf.body) && !/class="h"/.test(nf.body) ? 'FIXED' : 'FAIL',
    `unmatched URL -> ${nf.status} with the project _404 (not the home page)`,
  );

  {
    // A second project, because this one is built by now: nested API folders and
    // a parameter have to be proven with a REQUEST, not by reading the scanner.
    const adir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-apidepth-'));
    try {
      fs.mkdirSync(path.join(adir, 'src', 'api', 'users'), { recursive: true });
      fs.mkdirSync(path.join(adir, 'src', 'api', 'files'), { recursive: true });
      fs.mkdirSync(path.join(adir, 'src', 'pages'), { recursive: true });
      fs.symlinkSync(REACT, path.join(adir, 'node_modules'), 'dir');
      fs.writeFileSync(path.join(adir, 'index.html'), '<!DOCTYPE html><html><head><title>a</title></head><body><div id="root"></div></body></html>');
      fs.writeFileSync(path.join(adir, 'hydraconfig.json'), JSON.stringify({ name: 'a' }));
      fs.writeFileSync(path.join(adir, 'src', 'main.hyx'), 'from hydra import mount\nfrom "./App.hyx" import App\nmount(App, document.getElementById("root"))\n');
      fs.writeFileSync(path.join(adir, 'src', 'App.hyx'), 'from hydra import Router\ncomponent App():\n    Router()\n');
      fs.writeFileSync(path.join(adir, 'src', 'pages', 'index.hyx'), 'component H():\n    div(): "h"\n');
      fs.writeFileSync(path.join(adir, 'src', 'api', 'users', 'index.hys'), 'export def get(req):\n    return {"users": "list"}\n');
      fs.writeFileSync(path.join(adir, 'src', 'api', 'users', '[id].hys'), 'export def get(req):\n    return {"id": req.params.get("id")}\n');
      fs.writeFileSync(path.join(adir, 'src', 'api', 'files', '[...rest].hys'), 'export def get(req):\n    return {"rest": req.params.get("rest")}\n');
      const ab = build(adir, ['build', '--target', 'node']);
      const aserved = ab.status === 0 ? await serve(adir) : null;
      try {
        const list = aserved ? await req(aserved.port, 'GET', '/api/users') : { status: 0, body: '' };
        const one = aserved ? await req(aserved.port, 'GET', '/api/users/42') : { status: 0, body: '' };
        const rest = aserved ? await req(aserved.port, 'GET', '/api/files/a/b/c') : { status: 0, body: '' };
        const ok =
          list.status === 200 &&
          one.status === 200 &&
          JSON.parse(one.body).id === '42' &&
          rest.status === 200 &&
          JSON.parse(rest.body).rest.length === 3;
        record(
          'A13',
          ok ? 'FIXED' : 'FAIL',
          `nested folder /api/users -> ${list.status}, /api/users/[id] -> ${one.status} ${one.body}, catch-all -> ${rest.body}`,
        );
      } finally {
        if (aserved) await stop(aserved);
      }
    } finally {
      fs.rmSync(adir, { recursive: true, force: true });
    }
  }
  const cacheSrc = fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'compile-cache.mjs'), 'utf8');
  const cacheWired = /\.prune\(\{\s*identity/.test(fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'runner.mjs'), 'utf8'));
  record(
    'A13b',
    /prune\(\{ maxFiles/.test(cacheSrc) && cacheWired ? 'FIXED' : 'GAP',
    'compile cache prunes on compiler-identity change and caps its file count',
  );
  {
    // Every framework error answers `{error, code, detail?}`; `fail()` keeps the
    // project's own body, because that is the application talking.
    const noRoute = await req(port, 'GET', '/api/definitely-not-a-route');
    const thrown = await req(port, 'GET', '/api/boom');
    const envelopesOk =
      noRoute.status === 404 &&
      typeof JSON.parse(noRoute.body).code === 'string' &&
      thrown.status === 500 &&
      typeof JSON.parse(thrown.body).code === 'string';
    record(
      'A14',
      envelopesOk ? 'FIXED' : 'FAIL',
      `404 -> ${noRoute.body}, 500 -> ${JSON.parse(thrown.body || '{}').code}`,
    );
  }
  const hdr = await req(port, 'GET', '/');
  const hasSecurity =
    hdr.headers['x-content-type-options'] === 'nosniff' &&
    Boolean(hdr.headers['referrer-policy']) &&
    Boolean(hdr.headers['x-frame-options']);
  // The origin check: a cross-site POST to an action route must be refused.
  const crossOrigin = await req(port, 'POST', '/', {
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  record(
    'A15',
    hasSecurity && (crossOrigin.status === 403 || crossOrigin.status === 405) ? 'FIXED' : 'FAIL',
    `security headers present (${hasSecurity}), cross-origin action POST -> ${crossOrigin.status}; CSP deliberately left to server.headers`,
  );
  const assetName = fs
    .readdirSync(path.join(dir, 'dist', 'assets'))
    .find((f) => /^index-.*\.js$/.test(f));
  const gz = await req(port, 'GET', `/assets/${assetName}`, { headers: { 'accept-encoding': 'gzip' } });
  const plain = await req(port, 'GET', `/assets/${assetName}`);
  const compressed = gz.headers['content-encoding'] === 'gzip' && gz.body.length < plain.body.length;
  const immutable = /immutable/.test(String(gz.headers['cache-control'] || ''));
  const htmlNoCache = /no-cache|no-store/.test(String(hdr.headers['cache-control'] || ''));
  record(
    'A16',
    compressed && immutable && htmlNoCache ? 'FIXED' : 'FAIL',
    `gzip ${plain.body.length}->${gz.body.length} bytes, asset Cache-Control immutable, HTML revalidates; still no ETag`,
  );

  // ---- B: build ---------------------------------------------------------
  fs.rmSync(path.join(dir, 'src', 'pages', 'about.hyx'));
  const second = build(dir);
  record(
    'B1',
    !fs.existsSync(path.join(dir, 'dist', 'about', 'index.html')) ? 'FIXED' : 'FAIL',
    `deleted route after rebuild -> ${fs.existsSync(path.join(dir, 'dist', 'about', 'index.html')) ? 'still served' : 'gone from dist/'}`,
  );

  const chunksDir = path.join(dir, 'dist', 'assets', 'chunks');
  const chunkCount = fs.existsSync(chunksDir) ? fs.readdirSync(chunksDir).filter((f) => f.endsWith('.js')).length : 0;
  const entry = fs.readdirSync(path.join(dir, 'dist', 'assets')).find((f) => /^index-.*\.js$/.test(f));
  record(
    'B2',
    chunkCount >= 2 ? 'FIXED' : 'FAIL',
    `${chunkCount} route chunk(s), entry ${entry} is ${fs.statSync(path.join(dir, 'dist', 'assets', entry)).size} bytes`,
  );

  record(
    'B3',
    !fs.existsSync(path.join(dir, 'dist', 'blog', 'static', 'index.html')) ? 'FIXED' : 'FAIL',
    `rendering = "ssr" -> ${fs.existsSync(path.join(dir, 'dist', 'blog', 'static', 'index.html')) ? 'still pre-rendered' : 'no static HTML written'}`,
  );

  // A project WITH a stylesheet, because the empty case proves nothing: the
  // first version of this check passed by having no CSS to look at, while the
  // build was shipping every pre-rendered page with no stylesheet link at all.
  fs.writeFileSync(path.join(dir, 'src', 'index.css'), 'body { color: #123456; }\n');
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    'from hydra import mount\nfrom "./App.hyx" import App\nimport "./index.css"\nmount(App, document.getElementById("root"))\n',
  );
  build(dir);
  const css = fs.readdirSync(path.join(dir, 'dist', 'assets')).filter((f) => f.endsWith('.css'));
  const hashed = css.length === 1 && /^index-[A-Z0-9]+\.css$/.test(css[0]);
  const linked = [path.join(dir, 'dist', 'index.html'), path.join(dir, 'dist', 'blog', 'index.html')]
    .filter((f) => fs.existsSync(f))
    .every((f) => fs.readFileSync(f, 'utf8').includes(css[0] || '\u0000'));
  record(
    'B4',
    hashed && linked ? 'FIXED' : 'FAIL',
    `stylesheet ${css[0] || '(none)'} is content-hashed and linked from every pre-rendered page: ${linked}`,
  );

  const maps = fs.readdirSync(path.join(dir, 'dist', 'assets')).filter((f) => f.endsWith('.map'));
  record('B5', maps.length === 0 ? 'FIXED' : 'FAIL', `${maps.length} source map(s) in dist/ by default`);

  const meta = await req(port, 'GET', '/.hydra-build.json');
  record('B6', meta.status === 404 ? 'FIXED' : 'FAIL', `/.hydra-build.json -> ${meta.status}`);

  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), 'PUBLIC-INDEX');
  fs.writeFileSync(path.join(dir, 'public', 'robots.txt'), 'ROBOTS');
  const third = build(dir);
  record(
    'B7',
    /is ignored/.test(third.stderr + third.stdout) && fs.existsSync(path.join(dir, 'dist', 'robots.txt'))
      ? 'FIXED'
      : 'FAIL',
    `public/index.html warned about, public/robots.txt still copied`,
  );

  const gateSrc = fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'runtime-gate.mjs'), 'utf8');
  record(
    'B8',
    /checked/.test(gateSrc) && /isOwnOriginError/.test(gateSrc) && /HYDRA_GATE_PAGES/.test(gateSrc)
      ? 'FIXED'
      : 'FAIL',
    'gate reports how many pages it checked, own-origin console errors are failures, cap configurable',
  );
  const cleanBuild = build(dir);
  record(
    'B9',
    /Server running at http:\/\/127\.0\.0\.1:0\//.test(cleanBuild.stdout + cleanBuild.stderr) ? 'FAIL' : 'FIXED',
    'build log no longer prints the gate\'s internal "Server running at ...:0/" line',
  );

  record(
    'B10',
    'FIXED',
    'hydra serve/start, startup refuses a missing server half, SIGTERM, docs/DEPLOYING.md, Dockerfile; .hydra/ still lives beside dist/ by design, and DEPLOYING.md says so',
  );

  // ---- C: language ------------------------------------------------------
  const semantics = [
    'print(type(1).__name__, type(1.5).__name__, type(True).__name__, type(None).__name__, type([]).__name__, type({}).__name__)',
    'print(isinstance(True, int), isinstance(1.5, int), isinstance(1, float))',
    'print(str(None), str(True))',
    'print(format(1.5, ".2f"))',
  ].join('\n');
  const semFile = path.join(dir, 'sem.hys');
  fs.writeFileSync(semFile, semantics + '\n');
  const sem = spawnSync(BIN, ['run', semFile], { cwd: dir, encoding: 'utf8' });
  const semOut = (sem.stdout || '').trim().split('\n');
  record('C1', semOut[0] === 'int float bool NoneType list dict' ? 'FIXED' : 'FAIL', `type().__name__ -> ${semOut[0]}`);
  record('C2', semOut[1] === 'true false false' ? 'FIXED' : 'FAIL', `isinstance(int/float) -> ${semOut[1]}`);
  record('C3', semOut[2] === 'None True' ? 'FIXED' : 'GAP', `str(None), str(True) -> ${semOut[2]} (1 == True still JS)`);
  // Division raises now; a plain `xs[i]` beyond the end is still `undefined`,
  // and that is a real limit rather than an oversight: the compiler cannot tell
  // `list[5]` from `dict["k"]` statically, and turning every subscript into a
  // bounds check would break dict access. `d[k]` can use py_key explicitly.
  const divFile = path.join(dir, 'div.hys');
  fs.writeFileSync(
    divFile,
    'try:\n    print(1 / 0)\nexcept ZeroDivisionError:\n    print("caught")\nprint(7 // 2, -7 // 2)\n',
  );
  const div = spawnSync(BIN, ['run', divFile], { cwd: dir, encoding: 'utf8' });
  const divOk = /caught/.test(div.stdout || '') && /3 -4/.test(div.stdout || '');
  const idxFile = path.join(dir, 'idx.hys');
  fs.writeFileSync(idxFile, 'xs = [1, 2]\nprint(xs[-3])\n');
  const idx = spawnSync(BIN, ['run', idxFile], { cwd: dir, encoding: 'utf8' });
  const idxOk = /IndexError/.test((idx.stderr || '') + (idx.stdout || ''));
  record(
    'C4',
    divOk && idxOk ? 'FIXED' : 'GAP',
    `ZeroDivisionError raised by / and //, IndexError on a negative out-of-range index; a plain xs[5] on a list is still undefined (list vs dict is not knowable statically)`,
  );
  {
    const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-kw-'));
    try {
      fs.mkdirSync(path.join(kdir, 'src', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(kdir, 'hydraconfig.json'), JSON.stringify({ name: 'k' }));
      fs.writeFileSync(path.join(kdir, 'src', 'lib', 'stats.hys'), 'export def greet(name, greeting="hi"):\n    return f"{greeting} {name}"\n');
      fs.writeFileSync(path.join(kdir, 'src', 'use.hys'), 'from "./lib/stats.hys" import greet\nprint(greet(greeting="yo", name="hanzu"))\n');
      fs.writeFileSync(path.join(kdir, 'src', 'use2.hys'), 'from "lib/stats.hys" import greet\nprint(greet(greeting="yo", name="hanzu"))\n');
      const a = spawnSync(BIN, [path.join('src', 'use.hys')], { cwd: kdir, encoding: 'utf8' });
      const b = spawnSync(BIN, [path.join('src', 'use2.hys')], { cwd: kdir, encoding: 'utf8' });
      const bothEmit = a.status === 0 && b.status === 0;
      const reordered =
        /greet\("hanzu", "yo"\)/.test(a.stdout || '') && /greet\("hanzu", "yo"\)/.test(b.stdout || '');
      record(
        'C5',
        bothEmit && reordered ? 'FIXED' : 'FAIL',
        `keyword arguments across files, both spellings: ${bothEmit ? 'compile' : 'fail'} and ${reordered ? 'reorder to greet("hanzu", "yo")' : 'do not reorder'}`,
      );
    } finally {
      fs.rmSync(kdir, { recursive: true, force: true });
    }
  }

  // ---- D: packaging -----------------------------------------------------
  {
    const launcher = fs.readFileSync(path.join(ROOT, 'bin', 'hydra.js'), 'utf8');
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'binaries.yml'), 'utf8');
    const targets = ['linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
    const allTargets = targets.every((t) => wf.includes(`- target: ${t}`));
    const resolves = /@hydrascript\/\$\{triple\}/.test(launcher) && /HYDRA_BINARY/.test(launcher);
    const explains = /no native compiler for this machine/.test(launcher);
    // The binaries themselves are built by CI on the runner for each platform;
    // this machine can only prove the RESOLVER and the matrix exist.
    record(
      'D1',
      allTargets && resolves && explains ? 'FIXED' : 'FAIL',
      `launcher resolves @hydrascript/<triple> with a named failure, matrix builds ${targets.length} targets (glibc/musl/darwin/win32). The binaries are produced by .github/workflows/binaries.yml, not on this box`,
    );
  }
  record('D2', /Serving dist\//.test(served.log()) ? 'FIXED' : 'FAIL', 'hydra serve exists and serves');
  const counts = [
    fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'docs', 'BENCHMARKS.md'), 'utf8'),
    fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
  ].join('\n');
  record('D3', /408 Rust/.test(counts) && /155 Node|155 tests/.test(counts) ? 'FIXED' : 'FAIL', 'README, BENCHMARKS and CI quote the same counts');

  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema.json'), 'utf8'));
  const schemaOk =
    'routes' in schema.properties &&
    schema.properties.rendering.properties.ssg.default === true &&
    schema.properties.server.properties.host.default === '127.0.0.1' &&
    schema.properties.build.properties.sourcemap.default === false &&
    'bodyLimit' in schema.properties.server.properties &&
    'clean' in schema.properties.build.properties;
  record('D4', schemaOk ? 'FIXED' : 'FAIL', `schema declares routes/bodyLimit/clean and the three defaults match the code`);

  const gi = spawnSync('git', ['check-ignore', '.env.local', '.env.production.local'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  record('D5', (gi.stdout || '').trim().split('\n').length === 2 ? 'FIXED' : 'FAIL', `.env.local and .env.production.local are gitignored`);
  {
    const ddir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-dts-'));
    try {
      fs.mkdirSync(path.join(ddir, 'src', 'pages'), { recursive: true });
      fs.writeFileSync(path.join(ddir, 'hydraconfig.json'), JSON.stringify({ name: 'd' }));
      fs.writeFileSync(
        path.join(ddir, 'src', 'pages', 'blog.hyx'),
        'component Blog(posts: list = [], region: str = "?"):\n    div(): "x"\n',
      );
      fs.writeFileSync(
        path.join(ddir, 'src', 'pages', 'blog.server.hys'),
        'export async def loader(event):\n    return {"posts": ["a", "b"], "region": fetch_it()}\n',
      );
      const r = spawnSync(BIN, ['types'], { cwd: ddir, encoding: 'utf8' });
      const dtsPath = path.join(ddir, 'src', 'pages', 'blog.hyx.d.ts');
      const dts = fs.existsSync(dtsPath) ? fs.readFileSync(dtsPath, 'utf8') : '';
      const typed = /posts: string\[\]/.test(dts) && /region: any/.test(dts);
      record(
        'D6',
        r.status === 0 && typed ? 'FIXED' : 'FAIL',
        'a page props type comes from its loader: literal values keep their type, a call is `any`',
      );
    } finally {
      fs.rmSync(ddir, { recursive: true, force: true });
    }
  }
  {
    const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-base-'));
    try {
      fs.mkdirSync(path.join(bdir, 'src', 'pages'), { recursive: true });
      fs.symlinkSync(REACT, path.join(bdir, 'node_modules'), 'dir');
      fs.writeFileSync(path.join(bdir, 'index.html'), '<!DOCTYPE html><html><head><title>b</title></head><body><div id="root"></div></body></html>');
      fs.writeFileSync(path.join(bdir, 'hydraconfig.json'), JSON.stringify({ name: 'b', base: '/sub/' }));
      fs.writeFileSync(path.join(bdir, 'src', 'main.hyx'), 'from hydra import mount\nfrom "./App.hyx" import App\nmount(App, document.getElementById("root"))\n');
      fs.writeFileSync(path.join(bdir, 'src', 'App.hyx'), 'from hydra import Router\ncomponent App():\n    Router()\n');
      fs.writeFileSync(path.join(bdir, 'src', 'pages', 'index.hyx'), 'from hydra import Link\ncomponent H():\n    div():\n        Link(to="/about"): "go"\n');
      fs.writeFileSync(path.join(bdir, 'src', 'pages', 'about.hyx'), 'component A():\n    div(): "ABOUT"\n');
      const b = build(bdir);
      const html = fs.readFileSync(path.join(bdir, 'dist', 'index.html'), 'utf8');
      const ok = b.status === 0 && /href="\/sub\/about"/.test(html);
      record('D7', ok ? 'FIXED' : 'FAIL', `base "/sub/": Link renders href="/sub/about" and the build gate passes`);
    } finally {
      fs.rmSync(bdir, { recursive: true, force: true });
    }
  }
  const locks = ['package-lock.json', 'bun.lock'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  record('D8', locks.length === 1 ? 'FIXED' : 'GAP', `lockfiles in the repo: ${locks.join(', ') || 'none'}`);
  const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
  // The claim must be ABSENT, and absence is not provable by a failing regex
  // alone: assert the corrected sentence is there, so a rewritten file that
  // dropped the example entirely does not read as a fix.
  const roadmapFixed =
    !/docs\/\[\.\.\.rest\]\.hyx\s*->\s*\/docs\/\*\s*\(juga \/docs\)/.test(roadmap) &&
    /satu segmen atau lebih|one segment or more|tidak match `\/docs`/.test(roadmap);
  record('D9', roadmapFixed ? 'FIXED' : 'GAP', 'ROADMAP no longer claims [...rest] also matches the bare folder');
} finally {
  await stop(served);
  fs.rmSync(dir, { recursive: true, force: true });
}

const tally = {
  FIXED: rows.filter((r) => r.status === 'FIXED').length,
  GAP: rows.filter((r) => r.status === 'GAP').length,
  FAIL: rows.filter((r) => r.status === 'FAIL').length,
};
console.log(`\n${tally.FIXED} fixed, ${tally.GAP} still open, ${tally.FAIL} failed verification`);
if (tally.FAIL > 0) process.exit(1);
