// [xihanzu-NR]
/**
 * SSR for dynamic routes, and loaders that run again on a client navigation.
 *
 * These are the two things 0.8 promised, and both are only provable in a
 * browser: the server can render correct HTML and the client can still throw it
 * away (that is what a hydration mismatch IS), and a client navigation that
 * "works" can be showing the props it was mounted with rather than the ones the
 * new URL needs.
 *
 * Every assertion here is on RENDERED TEXT after the page has had time to
 * hydrate and fetch. Exit status and HTTP codes prove nothing about either.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild, serveDirectory } from './runner.mjs';
import { createRenderer, SERVER_BUNDLE } from './ssr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

/** A project with one static route and one dynamic route that has a loader. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-ssr-'));
  const pages = path.join(dir, 'src', 'pages', 'blog');
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 'ssr', root: './src', outputDir: './dist' }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>s</title></head><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    '# [xihanzu-NR]\nfrom hydra import mount\nfrom "./App.hyx" import App\nmount(App, document.getElementById("root"))\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    '# [xihanzu-NR]\nfrom hydra import Router\ncomponent App():\n    Router()\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'index.hyx'),
    '# [xihanzu-NR]\ncomponent Home():\n    div(cls="home"): "the home page"\n',
  );
  fs.writeFileSync(
    path.join(pages, '[slug].hyx'),
    '# [xihanzu-NR]\ncomponent Post(slug: str = "?", title: str = "none", loading: bool = False):\n    div(cls="post"):\n        h1(cls="t"): title\n        p(cls="s"): f"slug={slug}"\n        p(cls="l"): f"loading={loading}"\n',
  );
  fs.writeFileSync(
    path.join(pages, '[slug].server.hys'),
    '# [xihanzu-NR]\nexport async def loader(event):\n    slug = event.params.get("slug") if hasattr(event.params, "get") else event.params["slug"]\n    return {"slug": slug, "title": "Post: " + str(slug)}\n',
  );
  if (fs.existsSync(REACT)) fs.symlinkSync(REACT, path.join(dir, 'node_modules'));
  return dir;
}

/** A Chrome driving the DevTools protocol, enough for a load and an eval. */
async function withChrome(fn) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-ssr-chrome-'));
  const child = spawn(
    '/usr/bin/google-chrome',
    [
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--disable-gpu',
      '--disable-webgl',
      '--disable-3d-apis',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  );
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  };
  try {
    const pf = path.join(profile, 'DevToolsActivePort');
    let dp = null;
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(pf)) {
        const t = fs.readFileSync(pf, 'utf8').split('\n');
        if (/^\d+$/.test((t[0] || '').trim())) {
          dp = Number(t[0].trim());
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!dp) return { skipped: 'chrome did not open a debugging port' };
    const list = await new Promise((res, rej) =>
      http
        .get(`http://127.0.0.1:${dp}/json/list`, (r) => {
          let b = '';
          r.on('data', (c) => (b += c));
          r.on('end', () => res(JSON.parse(b)));
        })
        .on('error', rej),
    );
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const errors = [];
    const send = (m, p = {}) =>
      new Promise((res) => {
        const i = ++id;
        const h = (e) => {
          const x = JSON.parse(e.data);
          if (x.id === i) {
            ws.removeEventListener('message', h);
            res(x.result);
          }
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ id: i, method: m, params: p }));
      });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(
          String(m.params.exceptionDetails.exception?.description || '').split('\n')[0],
        );
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
    await send('Runtime.enable');
    await send('Page.enable');
    return await fn({
      navigate: (url) => send('Page.navigate', { url }),
      eval: async (expr) =>
        (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
          .result?.value,
      errors,
      close: () => ws.close(),
    });
  } finally {
    kill();
  }
}

test('a dynamic route is rendered server-side, per request, with its own data', async () => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });

  // The bundle the server commands render from must exist and be OUTSIDE dist:
  // a build artifact in dist/ would ship a server bundle to a static host.
  assert.ok(fs.existsSync(path.join(dir, SERVER_BUNDLE)), 'the server bundle must be written');
  assert.ok(
    !fs.readdirSync(path.join(dir, 'dist')).some((f) => f.endsWith('.cjs')),
    'no server bundle may be shipped in dist/',
  );

  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  assert.ok(renderer.available, renderer.reason);

  const one = await renderer.renderPage('/blog/hello');
  assert.match(one.document, /Post: hello/);
  assert.match(one.document, /slug=hello/);
  // `url` in the payload, not only `pattern`: two URLs share this pattern.
  assert.match(one.document, /"url":"\/blog\/hello"/);

  const two = await renderer.renderPage('/blog/world');
  assert.match(two.document, /Post: world/);
  assert.doesNotMatch(two.document, /Post: hello/, 'the second URL must not reuse the first data');

  // The div nesting must survive injection. A non-greedy replace stopped at the
  // first inner `</div>` and left the old markup's closers behind.
  const opens = (one.document.match(/<div\b/g) || []).length;
  const closes = (one.document.match(/<\/div>/g) || []).length;
  assert.equal(opens, closes, `unbalanced divs: ${opens} open, ${closes} close`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the data endpoint answers a loader, 404s an unknown route, and reports a throw', async () => {
  const dir = project();
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'boom.hyx'),
    '# [xihanzu-NR]\ncomponent Boom():\n    div(): "boom"\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'boom.server.hys'),
    '# [xihanzu-NR]\nexport async def loader(event):\n    raise ValueError("loader exploded")\n',
  );
  await runBuild(dir, { dev: false, mode: 'production' });
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  const { server } = await serveDirectory(path.join(dir, 'dist'), 0, '127.0.0.1', {
    ssr: renderer,
  });
  const port = server.address().port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/__hydra/data?url=/blog/x`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.pattern, '/blog/:slug');
    assert.equal(body.url, '/blog/x');
    assert.equal(body.data.title, 'Post: x');

    const missing = await fetch(`http://127.0.0.1:${port}/__hydra/data?url=/nope`);
    assert.equal(missing.status, 404);

    // A loader that throws is a 500 with the message, NOT an empty data object.
    // An empty list and a failed request look identical in a UI.
    const boom = await fetch(`http://127.0.0.1:${port}/__hydra/data?url=/boom`);
    assert.equal(boom.status, 500);
    assert.match((await boom.json()).error, /loader exploded/);

    const noUrl = await fetch(`http://127.0.0.1:${port}/__hydra/data`);
    assert.equal(noUrl.status, 400);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pre-rendered route hydrates clean, and a client navigation loads new data', async (t) => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  const { server } = await serveDirectory(path.join(dir, 'dist'), 0, '127.0.0.1', {
    ssr: renderer,
  });
  const port = server.address().port;
  try {
    const result = await withChrome(async (page) => {
      if (page.skipped) return { skipped: page.skipped };
      await page.navigate(`http://127.0.0.1:${port}/blog/hello`);
      await new Promise((r) => setTimeout(r, 4000));
      const hydrated = JSON.parse(
        await page.eval(
          `JSON.stringify({ title: (document.querySelector('.t')||{}).textContent, slug: (document.querySelector('.s')||{}).textContent })`,
        ),
      );
      // A client-side navigation to a URL no server render ever saw. The data
      // has to come from the endpoint; if the page keeps the props it mounted
      // with, this shows `hello` and the test fails.
      const navigated = JSON.parse(
        await page.eval(`(async () => {
          history.pushState({}, '', '/blog/fromclient');
          window.dispatchEvent(new PopStateEvent('popstate'));
          await new Promise(r => setTimeout(r, 2500));
          return JSON.stringify({ slug: (document.querySelector('.s')||{}).textContent, title: (document.querySelector('.t')||{}).textContent });
        })()`),
      );
      const errors = [...page.errors];
      await page.close();
      return { hydrated, navigated, errors };
    });

    if (result.skipped) return t.skip(result.skipped);
    assert.equal(result.hydrated.title, 'Post: hello');
    assert.equal(result.hydrated.slug, 'slug=hello');
    assert.equal(result.navigated.slug, 'slug=fromclient', 'the loader must run for the new URL');
    assert.equal(result.navigated.title, 'Post: fromclient');
    // A hydration mismatch is reported as a console error by React and as an
    // exception by the page; either means the server and client disagreed.
    assert.deepEqual(result.errors, [], `console errors: ${result.errors.join(' | ')}`);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
