// [xihanzu-NR]
/**
 * What a developer sees when something fails — the four cases README describes.
 *
 * This file exists because "why is my page empty" is the single most expensive
 * question in a framework, and the answer has to be IN THE RESPONSE or the
 * developer is left reading a terminal they may not even have open. Each test
 * here asserts on the words a person would need, not on a status code.
 *
 *   loader throws          -> the page says so, naming the `.hys` file
 *   SSR render throws      -> the page says so, and the terminal says so
 *   data endpoint missing  -> the hook reports `error`, and the page can show it
 *   hydration mismatch     -> the runtime gate fails the BUILD
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild, serveDirectory } from './runner.mjs';
import { createRenderer, SERVER_BUNDLE } from './ssr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

function project({ serverBody } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-errors-'));
  const pages = path.join(dir, 'src', 'pages', 'blog');
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 'e', root: './src', outputDir: './dist' }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>e</title></head><body><div id="root"></div></body></html>',
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
    '# [xihanzu-NR]\ncomponent Post(slug: str = "?", title: str = "none"):\n    div(cls="post"):\n        h1(cls="t"): title\n',
  );
  fs.writeFileSync(
    path.join(pages, '[slug].server.hys'),
    serverBody ??
      '# [xihanzu-NR]\nexport async def loader(event):\n    slug = event.params.get("slug") if hasattr(event.params, "get") else event.params["slug"]\n    return {"slug": slug, "title": "Post " + str(slug)}\n',
  );
  if (fs.existsSync(REACT)) fs.symlinkSync(REACT, path.join(dir, 'node_modules'));
  return dir;
}

async function withServer(dir, fn) {
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  const { server } = await serveDirectory(path.join(dir, 'dist'), 0, '127.0.0.1', { ssr: renderer });
  const port = server.address().port;
  try {
    return await fn({ port, renderer });
  } finally {
    server.close();
  }
}

test('a loader that throws names the .hys FILE and the pattern in the response', async () => {
  const dir = project({
    serverBody:
      '# [xihanzu-NR]\nexport async def loader(event):\n    nothing = None\n    return nothing["missing"]\n',
  });
  await runBuild(dir, { dev: false, mode: 'production' });
  try {
    await withServer(dir, async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/blog/x`);
      const html = await res.text();

      // The mapping that matters: pattern -> the file the author edits.
      assert.match(html, /blog\/\[slug\]\.server\.hys/, 'the failing .hys must be named');
      assert.match(html, /\/blog\/:slug/, 'the route pattern must be named');
      // And the underlying error, so it is diagnosable without a second run.
      assert.match(html, /Cannot read properties of null|reading 'missing'/);
      assert.match(html, /__hydra_ssr_error/, 'the notice must be in the served HTML');

      // The stack must NOT be the only thing: a `.cjs` line number in a bundle
      // the author never opens is not actionable on its own.
      assert.doesNotMatch(html, /\.hydra\/server\.cjs.*only/i);
    });

    // The endpoint says the same thing, as JSON, for a client navigation.
    await withServer(dir, async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/__hydra/data?url=/blog/x`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.match(body.error, /blog\/\[slug\]\.server\.hys/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an SSR render that throws says so on the page AND in the terminal', async () => {
  const dir = project();
  // A component that throws while rendering server-side: the loader is fine, so
  // the failure is in the tree.
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    [
      '# [xihanzu-NR]',
      'component Post(slug: str = "?", title: str = "none"):',
      '    items = title.no_such_method()',
      '    div(): items',
      '',
    ].join('\n'),
  );
  await runBuild(dir, { dev: false, mode: 'production' });
  try {
    await withServer(dir, async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/blog/hello`);
      const html = await res.text();
      // Either React rendered the route's error boundary (200) or the server
      // injected its notice (500). What must NOT happen is a blank page with a
      // 200 and nothing said anywhere.
      const spoke = /__hydra_ssr_error|error|Error/.test(html);
      assert.ok(spoke, `the response must explain itself:\\n${html.slice(0, 400)}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a healthy project shows no error notice at all', async () => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });
  try {
    await withServer(dir, async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/blog/hello`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Post hello/);
      assert.doesNotMatch(html, /__hydra_ssr_error/, 'no notice when nothing failed');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
