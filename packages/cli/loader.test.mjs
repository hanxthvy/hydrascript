// [xihanzu-NR]
/**
 * Loader and action, end to end through a real build and a real server.
 *
 * Every case here failed at least once while this was written, and the failures
 * were invisible from the build log: a loader that ran but whose result never
 * reached the page, a page map that held functions where components belonged,
 * a route table that matched nothing because `segments` was missing from it.
 * The gate caught them all, which is why the gate is part of the assertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory, runBuild } from './runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-loader-'));
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 'ld', root: './src', outputDir: './dist' }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>l</title></head><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'main.hyx'),
    '# [xihanzu-NR]\nfrom hydra import mount\nfrom "./App.hyx" import App\nmount(App, document.getElementById("root"))\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'App.hyx'),
    '# [xihanzu-NR]\nfrom hydra import Router\ncomponent App():\n    Router()\n',
  );
  // A page with a server half, and one without: the pair is the point.
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'index.hyx'),
    '# [xihanzu-NR]\ncomponent Home(greeting: str = "no loader ran"):\n    div(cls="card"):\n        h1(cls="g"): greeting\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'index.server.hys'),
    '# [xihanzu-NR]\nfrom "hydra/server" import env\n\nexport async def loader(event):\n    return {"greeting": "from the loader", "where": env("HYDRA_LD_TEST", "unset")}\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'plain.hyx'),
    '# [xihanzu-NR]\ncomponent Plain():\n    div(cls="p"): "no server half"\n',
  );
  if (fs.existsSync(REACT)) fs.symlinkSync(REACT, path.join(dir, 'node_modules'));
  return dir;
}

test('a loader runs at build time and its result reaches the page', async () => {
  const dir = project();
  process.env.HYDRA_LD_TEST = 'from env';
  try {
    await runBuild(dir, { dev: false, mode: 'production' });
  } finally {
    delete process.env.HYDRA_LD_TEST;
  }

  const home = fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8');
  assert.match(home, /from the loader/, 'the loader result must be rendered, not just inlined');
  // ...and the client must be able to read the same values without re-fetching.
  assert.match(home, /"greeting":"from the loader"/);
  assert.match(home, /"where":"from env"/);

  // A page with no server half still renders, with its own defaults.
  const plain = fs.readFileSync(path.join(dir, 'dist', 'plain', 'index.html'), 'utf8');
  assert.match(plain, /no server half/);
  assert.doesNotMatch(plain, /from the loader/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a route table without `segments` would match nothing, so it has them', async () => {
  const dir = project();
  await runBuild(dir, { dev: false, mode: 'production' });
  const table = fs.readFileSync(path.join(dir, '.hydra', 'routes.generated.js'), 'utf8');
  assert.match(table, /"segments":/, 'the client table must carry the matcher input');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an action answers a POST, and a redirect is a real 303', async () => {
  const dir = project();
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'notes.hyx'),
    '# [xihanzu-NR]\ncomponent Notes():\n    div():\n        form(method="post", action="/notes"):\n            input(name="text")\n            button(type="submit"): "Add"\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'pages', 'notes.server.hys'),
    '# [xihanzu-NR]\nfrom "hydra/server" import redirect\n\nexport async def action(event):\n    text = event.request.body.get("text") if event.request.body else None\n    if not text:\n        return {"ok": False, "reason": "empty"}\n    return redirect("/notes?added=" + str(text))\n',
  );
  await runBuild(dir, { dev: false, mode: 'production' });

  const { server } = await serveDirectory(path.join(dir, 'dist'), 0, '127.0.0.1', {
    // The bundle the build produced; this is what `hydra preview` passes.
    actions: path.join(dir, '.hydra', 'actions.cjs'),
  });
  const port = server.address().port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'text=hello',
      redirect: 'manual',
    });
    assert.equal(ok.status, 303, 'a redirect must be a 303 so a refresh does not repost');
    assert.equal(ok.headers.get('location'), '/notes?added=hello');

    const refused = await fetch(`http://127.0.0.1:${port}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'text=',
    });
    assert.equal(refused.status, 200);
    assert.deepEqual(await refused.json(), { ok: false, reason: 'empty' });

    // A POST to a route whose page has no action is a 405, not a silent 200.
    const nowhere = await fetch(`http://127.0.0.1:${port}/plain`, { method: 'POST', body: 'x=1' });
    assert.equal(nowhere.status, 405);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a .server file with no page beside it fails the build, naming both', async () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'src', 'pages', 'orphan.server.hys'), '# [xihanzu-NR]\n');
  await assert.rejects(
    () => runBuild(dir, { dev: false, mode: 'production' }),
    (e) => {
      assert.match(e.message, /orphan\.server\.hys/);
      assert.match(e.message, /orphan\.hys/);
      return true;
    },
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
