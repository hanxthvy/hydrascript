#!/usr/bin/env node
// [xihanzu-NR]
/**
 * A/B build benchmark. Measures the same project under different build
 * options, several runs each, and reports the median.
 *
 *     node benchmarks/build-ab.mjs /var/www/hanz [runs]
 *
 * Why this exists: build-time "optimisations" are easy to believe and hard to
 * see. On a 2 vCPU box, overlapping two CPU-bound stages does not help — the
 * work just moves between phases and the total barely moves. That is only
 * visible with repeated runs and a median, which is what this does. Any
 * performance claim in the README should come from here.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'hydra');
const RUNNER = path.join(ROOT, 'packages', 'cli', 'runner.mjs');

const project = path.resolve(process.argv[2] || path.join(ROOT, 'examples', 'ecosystem'));
const runs = Number(process.argv[3] || 3);

if (!fs.existsSync(path.join(project, 'src'))) {
  console.error(`not a hydra project: ${project}`);
  process.exit(1);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function buildOnce(env) {
  fs.rmSync(path.join(project, 'dist'), { recursive: true, force: true });
  const t0 = Date.now();
  const r = spawnSync(CLI, ['build'], {
    cwd: project,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 600000,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0 && /Built successfully/.test(r.stdout || '');
  return { ms, ok };
}

/**
 * Dev rebuild: start `hydra dev`, wait for the first build, then touch one
 * source file per run and time how long until the next `Built successfully`.
 * This is the loop a person actually sits in, and it is the one an esbuild
 * context changes, so it gets measured separately from `build`.
 */
async function benchDev(runner, edits, label) {
  const { spawn } = await import('node:child_process');
  // `detached` makes the child a process-group leader. The Rust binary spawns
  // `node runner.mjs` underneath it, so killing the binary alone leaves the
  // node process holding the port and the next variant dies on EADDRINUSE.
  const child = spawn(CLI, ['dev'], {
    cwd: project,
    env: { ...process.env, HYDRA_RUNNER: runner },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  // Count the banner in the stream rather than in a log file: a shell redirect
  // plus a detached process group was a reliable way to lose the output (and
  // the child) instead of measuring it.
  let built = 0;
  const watch = (buf) => {
    built += (String(buf).match(/Built successfully/g) || []).length;
  };
  child.stdout.on('data', watch);
  child.stderr.on('data', watch);

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && built < 1) await sleep(500);
  if (built < 1) {
    killTree(child);
    throw new Error(`dev server never produced a build for ${label}`);
  }
  await sleep(1000);

  // A rendered component, so a stale compile shows up in the bundle rather
  // than being tree-shaken away and looking like a cache that works.
  const candidates = [
    'src/App.hyx',
    'src/main.hyx',
    path.join('src', 'components', 'Projects.hyx'),
  ];
  const target = candidates.map((f) => path.join(project, f)).find((f) => fs.existsSync(f));
  const original = fs.readFileSync(target, 'utf8');

  const times = [];
  for (let i = 0; i < edits; i++) {
    const before = built;
    // `#`, not `//`: these are .hyx files, and a `//` line is a syntax error
    // there — the build would fail and the benchmark would sit waiting for a
    // build that never comes, then report no rebuilds at all.
    fs.writeFileSync(target, original + `\n# ab-${i}\n`);
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      await sleep(250);
      if (built > before) break;
    }
    const ms = Date.now() - t0;
    if (built > before) times.push(ms);
  }
  fs.writeFileSync(target, original);
  await sleep(500);

  killTree(child);
  await sleep(500);
  return times;
}

// Async sleep, not `Atomics.wait`. Blocking the event loop here meant the
// stdout 'data' handlers never ran, so the build counter stayed at zero and
// the benchmark reported "dev server never produced a build" — while the
// server was in fact building the whole time.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kill a detached child and everything it spawned. */
function killTree(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, 1500).unref?.();
}

/** Wait until the dev server's port is actually free, checking the socket. */
async function waitForPortFree(timeoutMs = 20000) {
  const port = readPort();
  if (!port) return;
  const { createServer } = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(port, '0.0.0.0');
    });
    if (free) return;
    await sleep(500);
  }
}

function readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(project, 'hydraconfig.json'), 'utf8'));
    return cfg.server?.port || 5173;
  } catch {
    return 5173;
  }
}

const mode = process.argv.includes('--dev') ? 'dev' : 'build';
const variants =
  mode === 'dev'
    ? [
        ['optimized', RUNNER],
        ['baseline', process.env.HYDRA_BASELINE_RUNNER || ''],
      ]
    : [
        ['baseline', {}],
        ['HYDRA_NO_SSG', { HYDRA_NO_SSG: '1' }],
      ];

console.log(`project: ${project}`);
console.log(`mode: ${mode}   runs per variant: ${runs}  (median reported)\n`);

if (mode === 'dev') {
  if (!process.env.HYDRA_BASELINE_RUNNER) {
    console.error(
      'Set HYDRA_BASELINE_RUNNER to the older runner.mjs (a previous git revision),\n' +
        'and keep it INSIDE packages/cli/ — the runner resolves its own binaries\n' +
        'and runtime relative to its location, so a copy in /tmp cannot run:\n' +
        '  git show HEAD:packages/cli/runner.mjs > packages/cli/_baseline-runner.mjs',
    );
    process.exit(1);
  }
  for (const [label, runner] of variants) {
    // The previous variant's server may still be closing its socket. Without
    // this the next one dies with EADDRINUSE, produces no builds, and the
    // benchmark reports "no rebuilds" for a runner that was never started.
    await waitForPortFree();
    const times = await benchDev(runner, runs, label);
    const med = times.length ? median(times) : NaN;
    console.log(
      `  ${label.padEnd(18)} median ${String(Math.round(med)).padStart(6)} ms` +
        `   rebuilds [${times.join(', ')}]`,
    );
  }
  console.log('\nEach rebuild is one saved file, timed until "Built successfully".\n');
  process.exit(0);
}

const results = {};
for (const [label, env] of variants) {
  const times = [];
  let failures = 0;
  for (let i = 0; i < runs; i++) {
    const { ms, ok } = buildOnce({ HYDRA_RUNNER: RUNNER, ...env });
    if (!ok) failures++;
    else times.push(ms);
  }
  results[label] = times;
  const med = times.length ? median(times) : NaN;
  console.log(
    `  ${label.padEnd(18)} median ${String(Math.round(med)).padStart(6)} ms` +
      `   runs [${times.map((t) => Math.round(t)).join(', ')}]` +
      (failures ? `   FAILURES ${failures}` : ''),
  );
}

console.log('\nA variant only counts as faster if the medians differ by more than');
console.log('the spread of the runs. Report the spread, not just the median.\n');
