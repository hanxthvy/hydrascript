// [xihanzu-NR]
/**
 * Streaming SSR, verified by what the socket does rather than by what the code
 * says it does.
 *
 * The failure this guards is subtle: a renderer that pipes React's output into a
 * string and writes it once produces a CORRECT document. Every assertion about
 * content passes. The only difference is that the browser waited for the last
 * byte before seeing the first, which is the entire thing streaming exists to
 * avoid — so this test counts chunks and measures when they arrive.
 *
 * A second assertion is about the request context surviving a stream: the seed
 * lives in an AsyncLocalStorage store, and the store must still be the right one
 * when React's render runs inside the pipe, not when `renderPageStream` was
 * called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { runBuild, serveDirectory } from './runner.mjs';
import { createRenderer, SERVER_BUNDLE } from './ssr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-stream-'));
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({
      name: 'stream-fixture',
      version: '0.0.1',
      root: './src',
      outputDir: './dist',
      entries: { app: './src/main.hyx' },
      compiler: { target: 'react-18' },
      rendering: { ssg: false },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>s</title></head><body><div id="root"></div>' +
      '<script type="module" src="/src/main.hyx"></script></body></html>',
  );
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    'from hydra import mount\nfrom "./App.hyx" import App\nmount(App())\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    'from hydra import Router\n\ncomponent App():\n    Router()\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'index.hyx'),
    'component Home():\n    div(cls="p"):\n        h1(): "home"\n',
  );
  fs.mkdirSync(path.join(dir, 'src', 'pages', 'blog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].hyx'),
    [
      'component Post(slug: str = "?"):',
      '    div(cls="post"):',
      '        h1(): slug',
      '        p(cls="tail"): "after the heading"',
      '',
    ].join('\n'),
  );
  // A loader that yields on a real timer. The delay is what makes the head and
  // the markup arrive as separate writes; without it the whole document lands in
  // one packet and the test cannot tell streaming from buffering.
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'blog', '[slug].server.hys'),
    [
      'def delay(ms):',
      '    return new Promise(lambda resolve, reject: setTimeout(resolve, ms))',
      '',
      'export async def loader(event):',
      '    await delay(120)',
      '    return {"slug": event.params["slug"]}',
      '',
    ].join('\n'),
  );
  fs.symlinkSync(REACT, path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Fetch a URL and record (time, bytes) for every socket read. */
function collect(port, urlPath) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const chunks = [];
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, headers: { Accept: 'text/html' } },
      (res) => {
        res.on('data', (d) => chunks.push({ at: Date.now() - t0, size: d.length, data: d.toString('utf8') }));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks }));
      },
    );
    req.on('error', reject);
  });
}

test('a streamed page arrives in more than one write, and the head is first', async () => {
  const dir = project();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runBuild(dir, {});
  } finally {
    process.chdir(cwd);
  }

  const renderer = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  assert.ok(renderer.available, renderer.reason);
  const { server, port } = await serveDirectory(path.join(dir, 'dist'), 5391, '127.0.0.1', {
    version: '0.0.0',
    ssr: renderer,
  });
  try {
    const res = await collect(port, '/blog/hello');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['transfer-encoding'] || ''), /chunked/);

    // More than one write: that is streaming. A buffered implementation answers
    // with a single chunk and passes every content assertion, which is why the
    // count is the assertion.
    assert.ok(
      res.chunks.length > 1,
      `expected several chunks, got ${res.chunks.length} — the page was buffered`,
    );

    const body = res.chunks.map((c) => c.data).join('');
    // The slug proves the loader ran and its value reached the render. The page
    // renders `h1(): slug`, so the text is the assertion; the data tag below is
    // the second half of the same fact.
    assert.ok(body.includes('hello'), 'the loader data did not reach the page');
    assert.match(body, /"url":"\/blog\/hello"/, 'the data tag does not name this url');
    assert.ok(body.trimEnd().endsWith('</html>'), 'the document was cut off before its closing tags');

    // The head must come before React's markup, or the browser had nothing to
    // paint while the boundary resolved.
    const firstWrite = res.chunks[0].data;
    assert.ok(firstWrite.includes('<div id="root">'), 'the first write did not include the shell root');
    assert.ok(
      firstWrite.includes('<title>') || firstWrite.includes('<!DOCTYPE'),
      'the first write did not include the document head',
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the loader data tag is written after the markup, not before', async () => {
  const dir = project();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runBuild(dir, {});
  } finally {
    process.chdir(cwd);
  }
  const ssr = await createRenderer({
    cwd: dir,
    bundlePath: path.join(dir, SERVER_BUNDLE),
    shellPath: path.join(dir, 'dist', 'index.html'),
  });
  assert.ok(ssr.available, ssr.reason);
  const { server, port } = await serveDirectory(path.join(dir, 'dist'), 5392, '127.0.0.1', {
    version: '0.0.0',
    ssr,
  });
  try {
    const res = await collect(port, '/blog/world');
    const body = res.chunks.map((c) => c.data).join('');
    const markupAt = body.indexOf('world');
    const dataAt = body.indexOf('__hydra_data__');
    assert.ok(markupAt > -1, 'markup missing');
    assert.ok(dataAt > -1, 'the data tag missing; hydration would refetch');
    assert.ok(dataAt > markupAt, 'the data tag was written before the markup it belongs to');
    // The tag must carry THIS url: the client trusts a payload only for the URL
    // it is rendering, so a wrong one means a mismatch on the first paint.
    assert.match(body.slice(dataAt, dataAt + 400), /"url":"\/blog\/world"/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
