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

test('the gate skips itself on a box without the memory for a browser', async () => {
  // The regression: on a 3.8 GB host with swap full, the gate launched Chrome,
  // earlyoom killed the build mid-gate, and `hydra build` reported "killed by
  // SIGTERM" with nothing about the gate — a build killed by its own checker.
  // So the gate must refuse to start, with the reason, before it spawns.
  const src = fs.readFileSync(path.join(HERE, 'runtime-gate.mjs'), 'utf8');
  assert.match(src, /MemAvailable/, 'the gate must read MemAvailable before spawning a browser');
  assert.match(src, /GATE_MIN_FREE_MIB/);
});

test('the gate kills the whole process tree, not only the browser parent', async () => {
  // A Chrome is a process tree. `child.kill()` takes down the parent and leaves
  // one renderer per tab reparented to init: measured, four interrupted builds
  // left ~800 MB of orphaned renderers and the fifth build died on SIGTERM.
  const src = fs.readFileSync(path.join(HERE, 'runtime-gate.mjs'), 'utf8');
  assert.match(src, /detached:\s*true/, 'Chrome must lead its own group to be killable');
  assert.match(src, /process\.kill\(-pid/, 'the group is killed by negative pid');
  assert.match(src, /process\.on\('exit'/, 'an interrupted build must still clean up');
});

test('serveDirectory is importable without starting anything', () => {
  // Importing the runner must not open a socket; the test above imports it too,
  // and this pins the invariant so a future top-level side effect is caught.
  assert.equal(typeof serveDirectory, 'function');
});

test('a scaffolded app builds, pre-renders every static route, and passes the gate', async (t) => {
  // The regression this exists for: an earlier router resolved pages through
  // `() => import('./pages/x.hyx')`, esbuild turned that into a chunk the entry
  // never referenced, `Router` vanished from the client bundle, and the build
  // still printed "Built successfully". Only the runtime gate noticed. So this
  // asserts the three things together — the build, the per-route HTML, and the
  // gate's own verdict — because any one of them alone would have passed.
  if (!fs.existsSync(HYDRA)) return t.skip(`${HYDRA} not built`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-router-'));
  const realLog = console.log;
  const logs = [];
  try {
    console.log = (...a) => logs.push(a.join(' '));
    const { execFileSync } = await import('node:child_process');
    execFileSync(HYDRA, ['init', '.'], { cwd: dir, stdio: 'pipe' });

    // The scaffold's own deps are the toolchain's business; react is needed.
    const reactSrc = path.join(REPO, 'examples', 'blog', 'node_modules');
    if (!fs.existsSync(reactSrc)) return t.skip('example node_modules not installed');
    fs.symlinkSync(reactSrc, path.join(dir, 'node_modules'));

    const runner = await import('./runner.mjs');
    await runner.runBuild(dir, { dev: false, mode: 'production' });
  } catch (e) {
    console.log = realLog;
    assert.fail(`build threw: ${e.message}\n${logs.join('\n')}`);
  } finally {
    console.log = realLog;
  }

  const said = logs.join('\n');
  assert.match(said, /pre-rendered 2\/2 static route/, said);
  assert.match(said, /runtime gate passed/, `the gate must have run and passed:\n${said}`);

  // One HTML file per static route, each with real content in #root.
  const outDir = path.join(dir, 'dist');
  for (const page of ['index.html', path.join('about', 'index.html')]) {
    const html = fs.readFileSync(path.join(outDir, page), 'utf8');
    const root = html.match(/<div id="root">([\s\S]*?)<\/div>/);
    assert.ok(root, `${page} has no #root`);
    assert.ok(root[1].trim().length > 100, `${page} pre-rendered an empty shell`);
  }

  // And the route table must be REACHABLE from the entry, walkimg the static
  // imports the way the browser does.
  //
  // This is the exact failure that motivated the test: the table used to be
  // emitted as a chunk nothing imported, so it was on disk, the build said
  // success, and the page rendered nothing. Reading only the entry file is not
  // enough — the table legitimately lives in a shared chunk — so the assertion
  // is about reachability, not about which file it landed in.
  const reachable = new Set();
  const walk = (file) => {
    const key = path.basename(file);
    if (reachable.has(key)) return;
    reachable.add(key);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s*["']([^"']+\.js)["']|import\s*\(\s*["']([^"']+\.js)["']/g)) {
      const spec = m[1] || m[2];
      const target = spec.startsWith('/')
        ? path.join(outDir, spec.slice(1))
        : path.resolve(path.dirname(file), spec);
      if (fs.existsSync(target)) walk(target);
    }
  };
  const entryFile = fs
    .readdirSync(path.join(outDir, 'assets'))
    .find((f) => f.startsWith('index-') && f.endsWith('.js'));
  walk(path.join(outDir, 'assets', entryFile));

  const resolveChunk = (f) => {
    for (const candidate of [path.join(outDir, 'assets', f), path.join(outDir, 'assets', 'chunks', f)]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  };
  const reachableText = [...reachable]
    .map((f) => resolveChunk(f))
    .filter(Boolean)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  assert.ok(
    /No route matched|is not a page/.test(reachableText),
    `the _404 page must be reachable from the entry; reached: ${[...reachable].join(', ')}`,
  );
  // The table is compiled IN now (a static import), so there may legitimately be
  // a single reachable file. What must be true is that the table's CONTENT is
  // reachable — that is the invariant, and it is what the old "at least one
  // chunk" check was approximating when the table lived in its own chunk.
  assert.ok(reachableText.includes('No route matched') || reachableText.includes('pages['),
    `the generated table must be reachable from the entry; reached: ${[...reachable].join(', ')}`);

  fs.rmSync(dir, { recursive: true, force: true });
});
