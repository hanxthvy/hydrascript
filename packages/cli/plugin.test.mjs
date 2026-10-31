// [xihanzu-NR]
// Tests for the bundler plugin and the runtime gate.
//
// Run: node --test packages/cli/plugin.test.mjs
//
// The gate tests tolerate a missing browser on purpose: this suite has to pass
// on a box with no Chrome, and "skipped" is a legitimate outcome that the code
// itself reports. A test that failed without a browser would make the suite
// depend on something the product does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  hydraEsbuildPlugin,
  hydraVitePlugin,
  rewriteDynamicImports,
  createHydraCompiler,
} from './esbuild-plugin.mjs';
import { serveDirectory } from './runner.mjs';
import { runRuntimeGate } from './runtime-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const selfRequire = createRequire(import.meta.url);

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function loadEsbuild() {
  try {
    const p = selfRequire.resolve('esbuild');
    return selfRequire(p);
  } catch {
    return null;
  }
}

test('the compiler reports which backend it found', () => {
  const c = createHydraCompiler();
  assert.ok(['native', 'cli', 'none'].includes(c.backend()));
  // This repo ships a prebuilt binary, so a "none" here means the paths broke.
  assert.notEqual(c.backend(), 'none', 'no compiler backend found in this checkout');
});

test('rewriteDynamicImports turns __import__ into a real import()', () => {
  assert.equal(
    rewriteDynamicImports('const p = __import__("./Page.hyx");'),
    'const p = import("./Page.hyx");',
  );
  // A computed specifier cannot be split by any bundler and is left alone.
  assert.equal(rewriteDynamicImports('__import__(name)'), '__import__(name)');
});

/**
 * esbuild is a dependency of this package, so it is normally present. When it is
 * not, skipping is fine on a laptop but NOT in CI: these three cases are the only
 * coverage of the bundler plugins, and a silent skip there is a green build that
 * verified nothing.
 */
function requireEsbuild(t) {
  const esbuild = loadEsbuild();
  if (!esbuild) {
    if (process.env.CI) {
      assert.fail('esbuild is not installed, and CI must not skip the plugin tests. Run `npm ci` in the repo root before this job.');
    }
    t.skip('esbuild not installed');
    return null;
  }
  return esbuild;
}

test('esbuild plugin compiles .hyx from a plain JS entry', async (t) => {
  const esbuild = requireEsbuild(t);
  if (!esbuild) return;

  const dir = tmpdir('hydra-plugin-');
  const originalCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(dir, 'App.hyx'),
      'component App():\n    div:\n        span: "from hyx"\n',
    );
    fs.writeFileSync(
      path.join(dir, 'entry.js'),
      'import { App } from "./App.hyx";\nexport default App;\n',
    );
    const result = await esbuild.build({
      entryPoints: [path.join(dir, 'entry.js')],
      bundle: true,
      write: false,
      format: 'esm',
      absWorkingDir: dir,
      plugins: [hydraEsbuildPlugin()],
    });
    const out = result.outputFiles[0].text;
    assert.match(out, /from hyx/);
    assert.match(out, /function App|App = /);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the vite plugin returns plain JS, because Vite parses by extension', async (t) => {
  const esbuild = requireEsbuild(t);
  if (!esbuild) return;

  const dir = tmpdir('hydra-vite-');
  try {
    const file = path.join(dir, 'App.hyx');
    const source = 'component App():\n    div:\n        span: "x"\n';
    fs.writeFileSync(file, source);

    const plugin = hydraVitePlugin();
    assert.equal(plugin.enforce, 'pre');
    const out = await plugin.transform(source, file);
    assert.ok(out, 'transform returned nothing for a .hyx file');
    assert.equal(out.error, undefined);
    // The whole point: no JSX survives, or Vite hands it to Rollup's parser and
    // it dies with PARSE_ERROR on the first `<`.
    assert.ok(!out.code.includes('<div'), `JSX leaked out:\n${out.code}`);
    assert.match(out.code, /jsx|createElement|React/, 'no JSX runtime call emitted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the vite plugin ignores files it does not own', async () => {
  const plugin = hydraVitePlugin();
  const out = await plugin.transform('const a = 1;', '/tmp/whatever.js');
  assert.equal(out, null);
});

test('the vite plugin surfaces a compile error instead of emitting broken code', async () => {
  const dir = tmpdir('hydra-vite-err-');
  try {
    const file = path.join(dir, 'Broken.hyx');
    const source = 'component Broken(:\n    div: "x"\n';
    fs.writeFileSync(file, source);

    // Real Vite provides `this.error`, which aborts the transform by throwing.
    // Both paths are asserted: inside a Vite context the error must surface as
    // a thrown/plugin error, and outside one it must come back as a result
    // rather than a TypeError from inside the plugin.
    const ctx = {
      error(msg) {
        throw new Error(msg);
      },
      info() {},
      warn() {},
    };
    await assert.rejects(
      async () => hydraVitePlugin().transform.call(ctx, source, file),
      (e) => e.message.length > 0,
    );

    const out = await hydraVitePlugin().transform(source, file);
    assert.ok(out.error, `expected an error, got: ${JSON.stringify(out)}`);
    assert.ok(out.error.message.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the vite plugin works with no plugin context at all', async (t) => {
  const esbuild = requireEsbuild(t);
  if (!esbuild) return;
  const dir = tmpdir('hydra-vite-noctx-');
  try {
    const file = path.join(dir, 'App.hyx');
    const source = 'component App():\n    div: "ok"\n';
    fs.writeFileSync(file, source);
    const out = await hydraVitePlugin().transform(source, file);
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.ok(out.code.includes('div') || out.code.includes('jsx'), out.code);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gate skips when there is no index.html', async () => {
  const dir = tmpdir('hydra-gate-');
  try {
    const r = await runRuntimeGate({ distDir: dir, serve: (d) => serveDirectory(d, 0, '127.0.0.1') });
    assert.ok(r.skipped, JSON.stringify(r));
    assert.equal(r.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gate reports a page that throws, and stays silent on a healthy page', async (t) => {
  const dir = tmpdir('hydra-gate2-');
  let healthy = null;
  let broken = null;
  try {
    const healthyDir = path.join(dir, 'ok');
    const brokenDir = path.join(dir, 'bad');
    fs.mkdirSync(healthyDir, { recursive: true });
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(
      path.join(healthyDir, 'index.html'),
      '<!doctype html><html><body><div id="root">hello</div></body></html>',
    );
    fs.writeFileSync(
      path.join(brokenDir, 'index.html'),
      '<!doctype html><html><body><div id="root"></div><script>throw new Error("boom from test");</script></body></html>',
    );

    healthy = await runRuntimeGate({
      distDir: healthyDir,
      serve: (d) => serveDirectory(d, 0, '127.0.0.1'),
    });
    broken = await runRuntimeGate({
      distDir: brokenDir,
      serve: (d) => serveDirectory(d, 0, '127.0.0.1'),
    });

    if (healthy.skipped) {
      // No browser on this machine: the gate says so instead of failing.
      return t.skip(`gate skipped: ${healthy.skipped}`);
    }
    assert.equal(healthy.ok, true, JSON.stringify(healthy));
    assert.equal(healthy.exceptions.length, 0, JSON.stringify(healthy));
    assert.equal(broken.ok, false, JSON.stringify(broken));
    assert.ok(
      broken.exceptions.some((e) => e.includes('boom from test')),
      JSON.stringify(broken.exceptions),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
