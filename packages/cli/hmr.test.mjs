// [xihanzu-NR]
/**
 * Live reload, tested against a running dev server.
 *
 * Not a unit test of the frame encoder: the thing that has to work is the
 * round trip — HTML carries the client, the socket accepts, an edit produces a
 * message, and a BROKEN edit produces an error instead of a reload. Each of
 * those failed at least once while this was written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const HYDRA = path.join(REPO, 'bin', 'hydra');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-hmr-'));
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 'hmr', root: './src', outputDir: './dist' }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>h</title></head><body><div id="root"></div></body></html>',
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
    '# [xihanzu-NR]\ncomponent Home():\n    div(): "hello"\n',
  );
  if (fs.existsSync(REACT)) fs.symlinkSync(REACT, path.join(dir, 'node_modules'));
  return dir;
}

test('dev serves the live-reload client and pushes a rebuild message', async (t) => {
  if (!fs.existsSync(HYDRA)) return t.skip(`${HYDRA} not built`);
  const dir = project();
  const port = 5380 + Math.floor(Math.random() * 100);
  const child = spawn('node', [path.join(HERE, 'runner.mjs'), 'dev', '--port', String(port)], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));

  try {
    const up = Date.now();
    while (Date.now() - up < 30000) {
      if (/Server running at/.test(log)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(log, /Server running at/, `dev server never started:\n${log}`);

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.includes('__hydra/hmr'), 'the served HTML must carry the reload client');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/__hydra/hmr`);
    const messages = [];
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('the socket refused a connection')), { once: true });
      setTimeout(() => reject(new Error('socket open timed out')), 6000);
    });
    ws.addEventListener('message', (ev) => messages.push(JSON.parse(ev.data)));

    // A good edit: the page should be told to reload.
    await new Promise((r) => setTimeout(r, 400));
    fs.appendFileSync(path.join(dir, 'src/pages/index.hyx'), '\n# touched\n');
    for (let i = 0; i < 80 && messages.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(messages[0], { type: 'ok' }, `expected a reload, got ${JSON.stringify(messages)}`);

    // A broken edit: an error, NOT a reload. Reloading into a broken bundle takes
    // away the page the developer was reading.
    messages.length = 0;
    fs.writeFileSync(path.join(dir, 'src/pages/index.hyx'), 'component Broken(\n');
    for (let i = 0; i < 80 && messages.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(messages[0] && messages[0].type, 'error', `expected an error message, got ${JSON.stringify(messages)}`);
    assert.ok(messages[0].message && messages[0].message.length > 0, 'the error must say something');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
