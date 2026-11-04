// [xihanzu-NR]
/**
 * `hydra build <dir>` must build THAT directory.
 *
 * The bug this locks: the binary looked for `hydraconfig.json` starting from the
 * shell's cwd only. Given a path, it found nothing, fell through to the
 * single-file compiler, handed it the path as a FILE, compiled zero files, and
 * printed `OK: compiled 0 file(s)` with exit 0. A command that reports success
 * while doing nothing is the most expensive kind of failure, because the next
 * thing a person does is trust it.
 *
 * These drive the real binary, not the function, because the bug lived in the
 * dispatch between two commands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const BIN = path.join(REPO, 'bin', 'hydra');
const REACT = path.join(REPO, 'examples', 'blog', 'node_modules');

function scaffold() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-arg-'));
  fs.writeFileSync(
    path.join(dir, 'hydraconfig.json'),
    JSON.stringify({ name: 'arg', version: '0.0.1', root: './src', outputDir: './dist' }),
  );
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>a</title></head><body><div id="root"></div></body></html>',
  );
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
  fs.symlinkSync(REACT, path.join(dir, 'node_modules'), 'dir');
  return dir;
}

// The native binary, executed directly. `bin/hydra.js` is the npm launcher and
// the thing a user actually runs; this test drives the binary because the
// dispatch bug lived in it (it decided "no project here" before the runner was
// ever spawned).
const run = (args, cwd) =>
  spawnSync(BIN, args, { cwd, encoding: 'utf8', timeout: 120000 });

test('a path argument builds that project, not the cwd', () => {
  const dir = scaffold();
  // Run from a directory that is NOT a project. The old behaviour compiled the
  // path as a file and reported success.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-elsewhere-'));
  const res = run(['build', dir], elsewhere);
  assert.equal(res.status, 0, `build failed: ${res.stderr || res.stdout}`);
  assert.ok(fs.existsSync(path.join(dir, 'dist', 'index.html')), 'no output in the named project');
  assert.ok(!fs.existsSync(path.join(elsewhere, 'dist')), 'built into the wrong directory');
});

test('a directory that is not a project fails instead of reporting success', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-notproj-'));
  const res = run(['build', elsewhere], elsewhere);
  assert.notEqual(res.status, 0, 'a non-project directory must not exit 0');
  assert.match(res.stderr, /not a HydraScript project|no such directory/);
});

test('a path that does not exist fails and says so', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-missing-'));
  const res = run(['build', path.join(elsewhere, 'nope')], elsewhere);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no such directory/);
});
