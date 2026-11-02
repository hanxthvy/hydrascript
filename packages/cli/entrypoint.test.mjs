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

test('a build refuses to ship a name no runtime provides', async () => {
  // The runtime gate renders the page, so it only sees code a render actually
  // runs. A call to a name nothing provides, on a branch the render does not
  // take, used to build successfully and carry that call into the shipped
  // bundle, where it throws when the user triggers that path. The build must
  // fail instead.
  //
  // The probe used to be `any([1])`, which is no longer an example of anything:
  // the runtime exports `any` now. The RULE is unchanged, so the probe moves to
  // a name that genuinely has no implementation.
  if (!fs.existsSync(HYDRA)) return t.skip(`${HYDRA} not built`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-checkgate-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'g', private: true, type: 'module' }));
    fs.writeFileSync(path.join(dir, 'hydraconfig.json'),
      JSON.stringify({ name: 'g', root: './src', outputDir: './dist' }));
    fs.writeFileSync(path.join(dir, 'src', 'App.hyx'),
      'component App(take):\n' +
      '    if take:\n' +
      '        v = frobnicate([1])\n' +
      '    else:\n' +
      '        v = 1\n' +
      '    div: f"v={v}"\n');
    fs.writeFileSync(path.join(dir, 'src', 'main.hyx'),
      'from "react-dom/client" import createRoot\n' +
      'from "./App.hyx" import App\n' +
      'root = document.getElementById("root")\n' +
      'createRoot(root).render(App(take=0))\n');

    const runner = await import('./runner.mjs');
    await assert.rejects(
      () => runner.runBuild(dir, { dev: false, mode: 'production' }),
      (e) => {
        assert.match(e.message, /semantic check failed/,
          `expected a semantic-check failure, got: ${e.message}`);
        assert.match(e.message, /frobnicate/,
          'the error should name the offending symbol');
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build still succeeds when the code is clean', async (t) => {
  // The counterpart: the check above must not block working code. A branch-local
  // assignment used after the branch is legal and hoisted by the emitter.
  if (!fs.existsSync(HYDRA)) return t.skip(`${HYDRA} not built`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-clean-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'c', private: true, type: 'module' }));
    fs.writeFileSync(path.join(dir, 'hydraconfig.json'),
      JSON.stringify({ name: 'c', root: './src', outputDir: './dist' }));
    fs.writeFileSync(path.join(dir, 'src', 'App.hyx'),
      'component App(take):\n' +
      '    if take:\n' +
      '        n = len([1, 2])\n' +
      '    else:\n' +
      '        n = 1\n' +
      '    div: f"n={n}"\n');
    fs.writeFileSync(path.join(dir, 'src', 'main.hyx'),
      'from "react-dom/client" import createRoot\n' +
      'from "./App.hyx" import App\n' +
      'root = document.getElementById("root")\n' +
      'createRoot(root).render(App(take=1))\n');

    const res = execFileSync(HYDRA, ['check', '--strict', path.join(dir, 'src')],
      { encoding: 'utf8' });
    assert.match(res, /clean/, `strict check should pass, got: ${res}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the runtime gate disables WebGL (a 10s stall otherwise)', async () => {
  // Regression guard, and the reason is worth stating: a page with a WebGL render
  // loop (ogl/three) starves the renderer's main thread on a GPU-less box when
  // WebGL is left on, so `Runtime.evaluate` misses its slot and dies on the CDP
  // timeout. Measured on the real portfolio: 10,001ms with WebGL, 3ms without.
  // The empty-shell check silently never ran. Asserted from the source, because
  // the failure is a missing flag and no behaviour test would catch a re-add.
  const { GATE_CHROME_FLAGS } = await import('./runtime-gate.mjs');
  assert.ok(
    GATE_CHROME_FLAGS.includes('--disable-webgl'),
    'runtime-gate must pass --disable-webgl or a WebGL page stalls the gate',
  );
  assert.ok(GATE_CHROME_FLAGS.includes('--disable-3d-apis'));
  assert.ok(GATE_CHROME_FLAGS.includes('--headless=new'));
});

test('serveDirectory is importable without starting anything', () => {
  // Importing the runner must not open a socket; the test above imports it too,
  // and this pins the invariant so a future top-level side effect is caught.
  assert.equal(typeof serveDirectory, 'function');
});
