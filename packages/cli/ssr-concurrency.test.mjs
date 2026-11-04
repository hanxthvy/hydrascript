// [xihanzu-NR]
/**
 * SSR under concurrency, and a loader that throws.
 *
 * These are the two properties that cannot be checked by reading the code, and
 * the two that break in production rather than in a demo:
 *
 *   1. **The seed is module-global.** `loadFor` and `renderSync` are separate on
 *      purpose, with no `await` between them, so two requests cannot interleave
 *      between "store this page's data" and "read it". If someone ever adds an
 *      await in that window, the second request's page renders with the first's
 *      props — silently, with both pages looking plausible. A concurrent test is
 *      the only thing that catches that, and it must be driven by a loader that
 *      actually yields (a real async boundary), not a resolved promise.
 *
 *   2. **A loader that throws is a 500 with its message.** "No items" and "the
 *      request failed" look identical in a UI and mean different things.
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

/**
 * A project whose loader DELAYS for a different number of microtask turns
 * depending on the slug.
 *
 * The stagger is the point. Two identical loaders resolve in the same order they
 * were called, so a broken (serialised) implementation still passes. Here
 * `/blog/one` returns after one turn and `/blog/two` after eight, so a
 * renderer that let request two's data overwrite request one's would produce
 * `two` under `/blog/one` — which is exactly what this asserts against.
 */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-ssr-conc-'));
  const pages = path.join(dir, 'src', 'pages', 'blog');
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 'c', root: './src', outputDir: './dist' }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>c</title></head><body><div id="root"></div></body></html>',
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
      'component Post(slug: str = "?", title: str = "none", tag: str = "untagged"):',
      '    div(cls="post"):',
      '        h1(cls="t"): title',
      '        p(cls="s"): f"slug={slug}"',
      '        p(cls="g"): f"tag={tag}"',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pages, '[slug].server.hys'),
    [
      '# [xihanzu-NR]',
      '# A loader that yields a different number of times per slug. The awaits are',
      '# what make an interleaving possible; without them the bug this guards',
      '# against cannot be provoked.',
      'async def settle(turns):',
      '    for i in range(turns):',
      '        await Promise.resolve()',
      '',
      'export async def loader(event):',
      '    slug = event.params.get("slug") if hasattr(event.params, "get") else event.params["slug"]',
      '    turns = 1 if slug == "one" else 8',
      '    await settle(turns)',
      '    return {"slug": slug, "title": "Post " + str(slug), "tag": "tag-" + str(slug)}',
      '',
    ].join('\n'),
  );
  if (fs.existsSync(REACT)) fs.symlinkSync(REACT, path.join(dir, 'node_modules'));
  return dir;
}

test('concurrent SSR requests each get their OWN loader data', async () => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  assert.ok(renderer.available, renderer.reason);

  try {
    // Ten interleaved pairs, started together. The short loader finishes first
    // every time, so an implementation that shares state between renders fails
    // on the FIRST pair; repeating it rules out a lucky ordering.
    for (let round = 0; round < 10; round++) {
      const [one, two] = await Promise.all([
        renderer.renderPage(`/blog/one`),
        renderer.renderPage(`/blog/two`),
      ]);
      assert.match(one.document, /slug=one/, `round ${round}: /blog/one got another page's data`);
      assert.match(one.document, /tag=tag-one/, `round ${round}: wrong tag on /blog/one`);
      assert.doesNotMatch(one.document, /tag-two/, `round ${round}: /blog/one contains /blog/two's data`);
      assert.match(two.document, /slug=two/, `round ${round}: /blog/two got another page's data`);
      assert.match(two.document, /tag=tag-two/, `round ${round}: wrong tag on /blog/two`);
      assert.doesNotMatch(two.document, /tag-one/, `round ${round}: /blog/two contains /blog/one's data`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a burst of distinct URLs returns every page with its own data', async () => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  assert.ok(renderer.available, renderer.reason);
  try {
    const slugs = ['one', 'two', 'one', 'two', 'one', 'two', 'one', 'two'];
    const pages = await Promise.all(slugs.map((s) => renderer.renderPage(`/blog/${s}`)));
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      assert.match(
        pages[i].document,
        new RegExp(`tag=tag-${slug}`),
        `page ${i} (/blog/${slug}) carries the wrong data`,
      );
      const other = slug === 'one' ? 'two' : 'one';
      assert.doesNotMatch(
        pages[i].document,
        new RegExp(`tag=tag-${other}`),
        `page ${i} (/blog/${slug}) carries /blog/${other}'s data`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the data endpoint is safe under concurrency too', async () => {
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
    const wanted = [];
    for (let i = 0; i < 12; i++) wanted.push(i % 2 === 0 ? 'one' : 'two');
    const responses = await Promise.all(
      wanted.map((s) => fetch(`http://127.0.0.1:${port}/__hydra/data?url=/blog/${s}`).then((r) => r.json())),
    );
    for (let i = 0; i < wanted.length; i++) {
      assert.equal(responses[i].data.slug, wanted[i], `response ${i} carries the wrong slug`);
      assert.equal(responses[i].url, `/blog/${wanted[i]}`);
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a loader that throws is a 500 with a message, never empty data', async () => {
  const dir = project();
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', 'boom.hyx'),
    '# [xihanzu-NR]\ncomponent Boom():\n    div(): "boom"\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', 'boom.server.hys'),
    '# [xihanzu-NR]\nexport async def loader(event):\n    raise ValueError("the database is down")\n',
  );
  await runBuild(dir, { dev: false, mode: 'production' });
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  const { server } = await serveDirectory(path.join(dir, 'dist'), 0, '127.0.0.1', { ssr: renderer });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__hydra/data?url=/blog/boom`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /the database is down/, 'the loader message must reach the caller');
    assert.equal(body.data, undefined, 'a failure must not look like empty data');

    // A full page render of the same route must still reach the browser, where
    // React can show the route's error boundary. A 500 HTML response would be a
    // dead end with nothing on screen.
    const page = await fetch(`http://127.0.0.1:${port}/blog/boom`);
    assert.ok([200, 500].includes(page.status));
    const html = await page.text();
    assert.ok(html.includes('<div id="root"'), 'the shell must still be served');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A dynamic route must render ITS OWN page, not the home page.
 *
 * The bug this locks: `renderSync` passed the route PATTERN as the element's
 * `path`, so `Router` matched `/blog/:slug` against a route table whose routes
 * are `/` and `/blog/:slug` — and a parameterised string is not a URL, so no
 * route matched, the not-found branch ran, and the home page was rendered with
 * the correct loader data inlined beside it. Both the crawler and the first
 * paint got the wrong document, and the data tag made it look right.
 *
 * SSG could not catch it: a static route's pattern and url are the same string.
 */
test('a dynamic route renders its own page, not the home page', async () => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });
  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  assert.ok(renderer.available, renderer.reason);
  const out = await renderer.render('/blog/two', {});
  assert.ok(out, 'no render output');
  // The page renders `slug=<slug>` and `tag=<tag>`; the home page (if rendered)
  // has neither. The loader returns slug "two" with its own tag.
  assert.ok(out.html.includes('slug=two'), `the dynamic route did not render its own slug: ${out.html}`);
  assert.ok(out.html.includes('tag=tag-two'), 'the loader data did not reach the page');
});
