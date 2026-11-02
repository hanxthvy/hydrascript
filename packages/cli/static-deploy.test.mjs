// [xihanzu-NR]
/**
 * `use_loader` on a deploy where the data endpoint does not exist.
 *
 * A purely static deploy has no server, so `/__hydra/data` answers 404 (or the
 * host's HTML), and the three states a page must be able to tell apart are:
 * still loading, loaded-and-empty, and failed. "No items" and "the request
 * failed" look identical in a UI and mean different things, which is why
 * `status` exists at all rather than the hook returning `null` for both.
 *
 * Tested in a real browser against a server that deliberately does NOT mount the
 * endpoint — the same thing a static host does. A stubbed fetch would only prove
 * the stub works.
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

/**
 * A project whose page READS the loader status.
 *
 * The shape a real page uses: render the data when it arrives, the error when it
 * failed, and a skeleton while waiting. Attributes rather than text, so the
 * assertions can tell "the value" from "the word in a message".
 */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-static-'));
  const pages = path.join(dir, 'src', 'pages', 'blog');
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 's', root: './src', outputDir: './dist' }),
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
    path.join(pages, '[slug].hyx'),
    [
      '# [xihanzu-NR]',
      'component Post(slug: str = "?", title: str = "none", loading: bool = False, error: str = ""):',
      '    div(cls="post"):',
      '        h1(cls="t"): title',
      '        p(cls="s"): f"slug={slug}"',
      '        p(cls="l"): f"loading={loading}"',
      '        if error:',
      '            p(cls="e"): f"error={error}"',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pages, '[slug].server.hys'),
    '# [xihanzu-NR]\nexport async def loader(event):\n    slug = event.params.get("slug") if hasattr(event.params, "get") else event.params["slug"]\n    return {"slug": slug, "title": "Post " + str(slug)}\n',
  );
  if (fs.existsSync(REACT)) fs.symlinkSync(REACT, path.join(dir, 'node_modules'));
  return dir;
}

/** A Chrome, enough to load a page and read the DOM after it settles. */
async function withChrome(fn) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-static-chrome-'));
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
    await send('Runtime.enable');
    await send('Page.enable');
    const errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(String(m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
      }
    });
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

/** Read the three fields the page renders. */
const READ = `JSON.stringify({
  slug: (document.querySelector('.s')||{}).textContent || null,
  loading: (document.querySelector('.l')||{}).textContent || null,
  error: (document.querySelector('.e')||{}).textContent || null,
  text: (document.getElementById('root')||{}).textContent || '',
})`;

test('with no data endpoint, the page reports a FAILED fetch and still renders', async (t) => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  // Deliberately NO `ssr` option: the endpoint does not exist, which is exactly
  // what a static host does. The SPA fallback answers the fetch with index.html,
  // so the failure is a JSON parse error — a realistic static-host failure.
  const { server } = await serveDirectory(path.join(dir, 'dist'), 0, '127.0.0.1', {});
  const port = server.address().port;
  try {
    const result = await withChrome(async (page) => {
      if (page.skipped) return { skipped: page.skipped };
      // A client-side navigation to a route no server render ever saw. The
      // inlined payload is for `/blog/hello`, so this URL must fetch.
      await page.navigate(`http://127.0.0.1:${port}/blog/hello`);
      await new Promise((r) => setTimeout(r, 3000));
      const before = JSON.parse(await page.eval(READ));
      const errors = [...page.errors];
      await page.close();
      return { before, errors };
    });
    if (result.skipped) return t.skip(result.skipped);

    // The page rendered (its own defaults), did not crash, and said the fetch
    // failed rather than showing an empty list.
    assert.ok(result.before.text.length > 0, 'the page must still render');
    assert.match(result.before.error || '', /error=/, `expected an error state, got ${JSON.stringify(result.before)}`);
    assert.equal(result.before.loading, 'loading=false', 'it must settle out of loading');
    assert.deepEqual(result.errors, [], `no uncaught exception: ${result.errors.join(' | ')}`);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with the endpoint present, the same navigation loads the data', async (t) => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  const { server } = await serveDirectory(path.join(dir, 'dist'), 0, '127.0.0.1', { ssr: renderer });
  const port = server.address().port;
  try {
    const result = await withChrome(async (page) => {
      if (page.skipped) return { skipped: page.skipped };
      await page.navigate(`http://127.0.0.1:${port}/blog/hello`);
      await new Promise((r) => setTimeout(r, 3000));
      // Navigate CLIENT-SIDE to a URL no server render saw, so the data has to
      // come from the endpoint.
      const after = JSON.parse(
        await page.eval(`(async () => {
          history.pushState({}, '', '/blog/fresh');
          window.dispatchEvent(new PopStateEvent('popstate'));
          await new Promise(r => setTimeout(r, 2500));
          return ${READ};
        })()`),
      );
      const errors = [...page.errors];
      await page.close();
      return { after, errors };
    });
    if (result.skipped) return t.skip(result.skipped);
    assert.equal(result.after.slug, 'slug=fresh', 'the loader must run for the new URL');
    assert.equal(result.after.error, null, `no error when the endpoint is up: ${result.after.error}`);
    assert.deepEqual(result.errors, []);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
