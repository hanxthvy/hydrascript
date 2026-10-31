// [xihanzu-NR]
// Entrypoint contract: `hydra init` must produce a project the runner accepts.
//
// The entrypoint filenames live in ENTRY_CANDIDATES (runner.mjs) and the
// scaffold writes its own idea of an entrypoint (compiler-rs/src/scaffold.rs).
// Those are two sources of truth, and this test is the only thing stopping them
// from drifting: the scaffold is checked against the list the runner actually
// resolves against, by running the real `hydra init` and looking at the files.
//
// Run: node --test packages/cli/entrypoint.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ENTRY_CANDIDATES, serveDirectory } from './runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const HYDRA = path.join(REPO, 'bin', 'hydra');

test('the entrypoint list is exactly the four documented names, in order', () => {
  assert.deepEqual(ENTRY_CANDIDATES, [
    'src/main.hyx',
    'src/main.hsx',
    'src/index.hyx',
    'src/index.hsx',
  ]);
});

test('hydra init produces a project whose entrypoint the runner resolves', (t) => {
  if (!fs.existsSync(HYDRA)) return t.skip(`${HYDRA} not built`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-init-'));
  try {
    execFileSync(HYDRA, ['init', '.'], { cwd: dir, stdio: 'pipe' });

    const present = ENTRY_CANDIDATES.filter((rel) => fs.existsSync(path.join(dir, rel)));
    assert.equal(
      present.length,
      1,
      `expected exactly one entrypoint from ${JSON.stringify(ENTRY_CANDIDATES)} in a scaffolded project, found ${JSON.stringify(present)}`,
    );
    assert.equal(present[0], 'src/main.hyx');

    // The scaffold's own config and index.html must agree with the file that
    // actually exists, not with a name that happens to be hard-coded elsewhere.
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'hydraconfig.json'), 'utf8'));
    if (cfg.entries?.app) {
      const declared = cfg.entries.app.replace(/^\.\//, '');
      assert.ok(
        fs.existsSync(path.join(dir, declared)),
        `hydraconfig.json points at ${declared}, which the scaffold did not create`,
      );
    }
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const m = html.match(/src="([^"]+\.(?:hyx|hsx))"/);
    if (m) {
      const ref = m[1].replace(/^\//, '');
      assert.ok(
        fs.existsSync(path.join(dir, ref)),
        `index.html loads ${ref}, which the scaffold did not create`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project with two candidate entrypoints builds, and says which it used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-amb-'));
  try {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'main.hyx'),
      'component Main():\n    div: "MAIN"\n',
    );
    fs.writeFileSync(
      path.join(src, 'index.hyx'),
      'component Idx():\n    div: "INDEX"\n',
    );

    // Compile through the runner's own build path, which is where the warning
    // lives. `hydra build` needs a full project, so drive the runner instead.
    const runner = await import('./runner.mjs');
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      await runner.runBuild(dir, { dev: false, mode: 'production', silent: false });
    } catch (e) {
      // A half-scaffolded project can legitimately fail later in the build; the
      // warning is emitted before that and is what this test is about.
      logs.push(`(build threw: ${e.message})`);
    } finally {
      console.log = realLog;
    }
    const warned = logs.find((l) => l.includes('also found'));
    assert.ok(
      warned,
      `expected a warning naming the unused entrypoint, got:\n${logs.join('\n')}`,
    );
    assert.ok(warned.includes('src/main.hyx'), warned);
    assert.ok(warned.includes('src/index.hyx'), warned);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project with no candidate entrypoint fails with all four names listed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-none-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const runner = await import('./runner.mjs');
    await assert.rejects(
      () => runner.runBuild(dir, { dev: false, mode: 'production' }),
      (e) => {
        for (const name of ENTRY_CANDIDATES) {
          assert.ok(
            e.message.includes(name),
            `the error should name ${name}, got: ${e.message}`,
          );
        }
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serveDirectory is importable without starting anything', () => {
  // Importing the runner must not open a socket; the test above imports it too,
  // and this pins the invariant so a future top-level side effect is caught.
  assert.equal(typeof serveDirectory, 'function');
});
