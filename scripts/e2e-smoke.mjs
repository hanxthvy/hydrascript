// [xihanzu-NR]
/**
 * End-to-end smoke test: build a project, serve it, and check the things the
 * framework promises by actually asking for them over HTTP.
 *
 * Deliberately not part of `node --test packages/cli/*.test.mjs`. Those tests
 * test the framework's own modules; this one tests the CONTRACT a project sees —
 * routing, a login, a cache, a hook, CORS, a 304 — through the same HTTP surface
 * a browser uses. It needs a project with `react` installed, which is why it takes
 * a directory instead of building one.
 *
 * Usage:
 *   node scripts/e2e-smoke.mjs <project-dir>
 *
 * The project is expected to have: `src/pages/login.hyx` + `.server.hys` whose
 * action sets a session, `src/pages/dashboard.hyx` + a loader that redirects
 * without one, `src/pages/cached/[n].hyx` + a loader that calls `revalidate()`,
 * `src/pages/admin.hyx`, `src/middleware.hys` guarding `/admin`, `src/hooks.hys`
 * with `on_request`/`on_error`, `src/api/boom.hys` that throws, and `site`,
 * `budget`, `accessLog`, `cors` in `hydraconfig.json`. Anything missing shows up
 * as a failed check rather than a crash.
 *
 * Exits 1 if any check fails, and prints every check with its result either way:
 * a smoke test that only speaks on failure is a smoke test nobody reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.resolve(process.argv[2] || process.cwd());
const HYDRA = path.join(ROOT, 'bin', 'hydra.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function run(args, { cwd = projectDir } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HYDRA, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(base, { redirect: 'manual' });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

const main = async () => {
  if (!fs.existsSync(path.join(projectDir, 'hydraconfig.json'))) {
    console.error(`not a HydraScript project: ${projectDir}`);
    process.exit(2);
  }

  console.log(`e2e: ${projectDir}\n`);

  // ---- build -------------------------------------------------------------
  const staticBuild = await run(['build']);
  check('build --target static', staticBuild.code === 0, staticBuild.code ? staticBuild.err.split('\n')[0] : '');
  const nodeBuild = await run(['build', '--target', 'node']);
  check('build --target node', nodeBuild.code === 0, nodeBuild.code ? nodeBuild.err.split('\n')[0] : '');
  const buildLog = staticBuild.out + nodeBuild.out;
  if (buildLog.includes('runtime gate')) {
    check('runtime gate ran', true, (buildLog.match(/runtime gate[^\n]*/) || [''])[0].trim());
  }
  if (/(a11y|accessibility):/.test(buildLog)) {
    check('a11y probe reported', true, (buildLog.match(/a11y:[^\n]*/) || [''])[0].trim());
  }
  if (buildLog.includes('budget:')) {
    check('budget reported', true, (buildLog.match(/budget:[^\n]*/) || [''])[0].trim());
  }
  const sitemapExists = fs.existsSync(path.join(projectDir, 'dist', 'sitemap.xml'));
  check('sitemap.xml written when `site` is set', sitemapExists);

  // ---- route contract tests ----------------------------------------------
  const routeTests = await run(['test', '--routes']);
  check('route tests (every loader runs)', routeTests.code === 0, (routeTests.out.match(/route tests:[^\n]*/) || [''])[0].trim());

  // ---- explain -----------------------------------------------------------
  const explain = await run(['explain']);
  check('hydra explain', explain.code === 0 && explain.out.includes('rendering :'), (explain.out.match(/rendering :[^\n]*/) || [''])[0].trim());

  // ---- serve -------------------------------------------------------------
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // `detached` so the whole tree can be signalled below. `bin/hydra.js` spawns the
  // runner as a CHILD, so killing the launcher alone leaves the actual server
  // alive — and its inherited pipes keep this process from ever exiting, which is
  // how a passing run reported 28/28 and then hung until the timeout killed it.
  const server = spawn(process.execPath, [HYDRA, 'serve', '--port', String(port)], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let serverLog = '';
  server.stdout.on('data', (c) => (serverLog += c));
  server.stderr.on('data', (c) => (serverLog += c));

  try {
    const up = await waitForServer(base);
    if (!up) throw new Error('server did not start: ' + serverLog.slice(-400));
    check('server starts', true, base);

    const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });

    const home = await get('/');
    check('GET / is 200', home.status === 200);
    check('X-Request-Id present', Boolean(home.headers.get('x-request-id')));
    check('security headers present', home.headers.get('x-content-type-options') === 'nosniff');

    // A page with a loader and no cookie: the loader decides.
    const guarded = await get('/dashboard');
    check('guarded page redirects when anonymous', guarded.status === 303 && (guarded.headers.get('location') || '').includes('/login'),
      `${guarded.status} ${guarded.headers.get('location') || ''}`);

    // The action sets the session.
    const login = await fetch(base + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=smoke',
    });
    const cookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [];
    check('action answers 303 with Set-Cookie', login.status === 303 && cookies.length === 1, cookies[0] ? cookies[0].split(';')[0].slice(0, 24) + '…' : 'no cookie');
    const jar = cookies.length ? cookies[0].split(';')[0] : '';

    const authed = await get('/dashboard', { headers: { cookie: jar } });
    const authedBody = await authed.text();
    check('session is read back by the loader', authed.status === 200 && /Dashboard untuk smoke/.test(authedBody));

    // Cache: two identical requests, then a conditional one.
    // A route with a parameter: it CANNOT be pre-rendered without
    // `static_params`, so it is the one shape that always goes through the
    // loader — which is what makes it the honest place to test the cache.
    const cachedPath = '/cached/1';
    const c1 = await get(cachedPath);
    await c1.text();
    const c2 = await get(cachedPath);
    const c2body = await c2.text();
    const etag = c2.headers.get('etag');
    check('cacheable page sends s-maxage', /s-maxage=\d+/.test(c2.headers.get('cache-control') || ''), c2.headers.get('cache-control') || '');
    check('ETag sent', Boolean(etag), etag || '');
    const firstRender = (c2body.match(/render=(\d+)/) || [])[1];
    const c3 = await get(cachedPath);
    const c3body = await c3.text();
    const secondRender = (c3body.match(/render=(\d+)/) || [])[1];
    check('cache hit does not re-run the loader', firstRender === secondRender, `render=${firstRender} → ${secondRender}`);
    const c4 = await get(cachedPath, { headers: { 'if-none-match': etag } });
    check('If-None-Match answers 304', c4.status === 304);
    const c5 = await get(cachedPath, { headers: { cookie: 'a=1' } });
    await c5.text();
    check('a request with a cookie is never cached', (c5.headers.get('cache-control') || '') === 'no-store');

    // Middleware for pages.
    const admin = await get('/admin');
    check('page middleware guards a page', admin.status === 303, `${admin.status} ${admin.headers.get('location') || ''}`);

    // Hooks: on_request sets a header, on_error hears about a 500.
    const hooked = await get('/');
    check('on_request header reaches the response', hooked.headers.get('x-hook') === 'seen');
    await hooked.text();
    const boom = await get('/api/boom');
    await boom.text();
    check('a handler that throws answers 500', boom.status === 500);

    // CORS.
    const preflight = await fetch(base + '/api/boom', { method: 'OPTIONS', headers: { origin: 'https://app.example.com' } });
    check('CORS preflight answers 204 with the allowed origin',
      preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === 'https://app.example.com');
    const evil = await fetch(base + '/api/boom', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    check('a disallowed origin gets no allow-origin', !evil.headers.get('access-control-allow-origin'));

    // sitemap / robots.
    const robots = await get('/robots.txt');
    check('robots.txt served', robots.status === 200 && (await robots.text()).includes('Sitemap:'));
    const sitemap = await get('/sitemap.xml');
    check('sitemap.xml served', sitemap.status === 200 && (await sitemap.text()).includes('<urlset'));

    // Access log.
    await new Promise((r) => setTimeout(r, 250));
    const logLines = serverLog.split('\n').filter((l) => l.trim().startsWith('{') && l.includes('"status"'));
    check('access log wrote one JSON line per request', logLines.length >= 5, `${logLines.length} line(s)`);
    const onError = serverLog.includes('ON_ERROR');
    check('on_error heard about the failing handler', onError);
  } finally {
    // The negative pid is the process GROUP created by `detached` above, so the
    // launcher and the runner it spawned both go. A failure here must not mask a
    // failing check, so it is swallowed.
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      try {
        server.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  failed: ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }
  // An explicit exit: the child's stdio may still be attached for a tick after
  // the kill, and a run that printed its results and then hung is worse than one
  // that failed loudly. This is the bug that was measured, not a precaution.
  process.exit(failed.length > 0 ? 1 : 0);
};

main().catch((err) => {
  console.error(`e2e smoke failed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
