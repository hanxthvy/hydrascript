// [xihanzu-NR]
/**
 * `hydra test` — run `*.test.hys` files with the project's own toolchain.
 *
 * Why this exists rather than "use vitest": the thing under test is `.hyx`,
 * which no JS test runner can import. Every alternative needs a transform
 * configured per project, and a test setup nobody can debug is a test setup
 * nobody runs. This bundles each test file with the SAME resolver, plugins and
 * compiler the build uses, so a test proves something about the real pipeline.
 *
 * Discovery: `*.test.hys` (and `.hyx`) under the test directory, `src/`, or the
 * project root, in that order — the first directory that exists wins. `hydra
 * test path/to/file.test.hys` runs one file.
 *
 * The run is a real process per file, not a shared module registry. A test file
 * that leaves a global behind, or a component that memoizes, then cannot affect
 * the next file; and a crash in one file does not take the run with it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Directories searched for test files, in order. */
const TEST_DIRS = ['tests', 'test', 'src', '.'];

/** Which extensions count as a test file. */
const TEST_EXTS = ['.test.hys', '.test.hyx'];

/** Recursively collect test files under `root`, bounded and sorted. */
export function findTestFiles(root, { limit = 2000 } = {}) {
  const found = [];
  const walk = (dir) => {
    if (found.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.hydra') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (TEST_EXTS.some((x) => e.name.endsWith(x))) found.push(full);
    }
  };
  walk(root);
  found.sort();
  return found;
}

/**
 * Where the tests live for this project.
 *
 * `tests/` first because that is the convention, then `test/`, then the source
 * tree, then the root. Returning the FIRST that has any test files means a
 * project can lay them out however it likes without configuration, and a project
 * with none gets `null` rather than a search that finds the wrong thing.
 */
export function testRoot(cwd, config = {}) {
  if (typeof config.tests === 'string') return path.resolve(cwd, config.tests);
  for (const rel of TEST_DIRS) {
    const dir = path.join(cwd, rel);
    if (!fs.existsSync(dir)) continue;
    if (findTestFiles(dir, { limit: 1 }).length > 0) return dir;
  }
  return null;
}

/** Snapshot storage: one JSON file, keyed by `file::name`. */
export function readSnapshots(cwd) {
  const file = path.join(cwd, '.hydra', 'snapshots.json');
  if (!fs.existsSync(file)) return { file, data: {} };
  try {
    return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    // A corrupt snapshot file must not look like an empty one: that would
    // silently rewrite every baseline on the next run and hide real changes.
    throw new Error(`.hydra/snapshots.json is not valid JSON: ${e.message}`);
  }
}

export function writeSnapshots(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Sorted keys: a snapshot diff should be about content, not insertion order.
  const sorted = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

/**
 * The shim prepended to a bundled test file.
 *
 * The runtime's `test`/`expect`/`render`/`snapshot` are imported by the test
 * file itself; this only supplies the store the runtime cannot reach (the
 * snapshot file) and the harness that reports results back to this process.
 */
export function testHarnessSource() {
  return `// [xihanzu-NR]
import { __set_file, __set_snapshot_store, __results, __settled } from 'hydra/test';
import fs from 'node:fs';
import nodePath from 'node:path';
const SNAP = process.env.HYDRA_TEST_SNAPSHOTS;
const STORE = process.env.HYDRA_TEST_STORE;
let snapshots = {};
try { snapshots = SNAP && fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, 'utf8')) : {}; } catch { snapshots = {}; }
let dirty = false;
__set_file(process.env.HYDRA_TEST_FILE || '');
__set_snapshot_store({
  read: (key) => (Object.prototype.hasOwnProperty.call(snapshots, key) ? snapshots[key] : null),
  write: (key, value) => { snapshots[key] = value; dirty = true; },
});
// Exported, NOT run here.
//
// Running it at import time is the bug that made every test report "did not
// run": the entry imports this harness BEFORE the test file, so the settle
// await was on a queue the test file had not pushed to, it resolved
// immediately, and the results block was printed with an empty list. The entry
// The entry calls finish() after importing the test file.
export const __finish = async () => {
  await __settled();
  if (dirty && STORE) {
    fs.mkdirSync(nodePath.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(snapshots, null, 2) + '\\n', 'utf8');
  }
  process.stdout.write('\\n__HYDRA_TEST_RESULTS__' + JSON.stringify(__results()) + '\\n');
};
`;
}

/**
 * Bundle one test file into runnable ESM.
 *
 * `write: true` to a temp path outside the project: a bundled test must never
 * end up in `dist/` or in the source tree, and a build artifact that a later
 * `hydra build` might pick up is exactly that mistake.
 */
export async function bundleTest(esbuild, file, { cwd, pkgRoot, plugins, outfile, externals = {} }) {
  // The harness is an ENTRY, not a `banner`.
  //
  // A banner is prepended to the OUTPUT, after bundling, so its own
  // `import ... from 'hydra/test'` never went through the resolver and node
  // could not find the package. An entry file that imports the harness and then
  // the test is seen by the bundler, which is the whole point of using one.
  const dir = path.dirname(outfile);
  const entry = path.join(dir, 'entry.mjs');
  const rel = (p) => JSON.stringify(p.split(path.sep).join('/'));
  // Order matters and is the fix for "did not run": the test file is imported
  // BEFORE the results are collected, so its `test(...)` calls are in the queue
  // the harness then waits on.
  fs.writeFileSync(
    entry,
    `// [xihanzu-NR]\n` +
      `import { __finish } from ${rel(path.join(dir, '__harness.mjs'))};\n` +
      `await import(${rel(file)});\n` +
      `__finish().then(() => process.exit(0)).catch((e) => {\n` +
      `  process.stderr.write(String(e && e.stack ? e.stack : e) + String.fromCharCode(10));\n` +
      `  process.exit(1);\n` +
      `});\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(dir, '__harness.mjs'), testHarnessSource(), 'utf8');

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile,
    jsx: 'automatic',
    logLevel: 'silent',
    sourcemap: false,
    resolveExtensions: ['.hys', '.hyx', '.hsx', '.hs', '.mjs', '.js', '.jsx', '.ts', '.tsx', '.json'],
    nodePaths: [path.join(cwd, 'node_modules'), path.join(pkgRoot, 'node_modules')],
    plugins: [
      ...plugins,
      {
        // React is CommonJS and pulls in node builtins. Bundled into an ESM
        // file it becomes `__require("stream")`, which throws
        // `Dynamic require of "stream" is not supported` — the same wall the
        // SSG pass hit, solved the same way: leave React external so node's own
        // loader resolves it, natively, and both the test and the component
        // share one React instance (hooks need that).
        name: 'hydra-test-external-react',
        setup(build) {
          // Everything under react/react-dom stays EXTERNAL, with the bare
          // specifier intact. The bundle is written into the project's own
          // `.hydra/` (see the runner), so node resolves these from the
          // project's node_modules — and React's CommonJS files, which reach
          // for node builtins, are never bundled into an ESM file where
          // `require` does not exist. Bundling any part of react-dom produced
          // `Dynamic require of "stream" is not supported`.
          build.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => {
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  return outfile;
}

/** Parse the results block a bundled test file prints. */
export function parseTestOutput(stdout) {
  const marker = '__HYDRA_TEST_RESULTS__';
  const at = stdout.lastIndexOf(marker);
  if (at === -1) return null;
  const raw = stdout.slice(at + marker.length).split('\n')[0];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Run one bundled test file in its own process. */
export function runBundle(outfile, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [outfile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

export { os };
