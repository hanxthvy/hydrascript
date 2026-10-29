#!/usr/bin/env node
// [xihanzu-NR]
/**
 * Reproducible measurements for the README.
 *
 * Every number the README quotes about this compiler comes from this script,
 * so a claim can be re-checked instead of taken on faith. Run it from the repo
 * root:
 *
 *     node benchmarks/measure.mjs
 *
 * What it does NOT measure is as important as what it does. There is no
 * comparison against `tsc` or Vite here, because a fair one would have to run
 * those tools on the same machine with the same inputs, and this script cannot
 * promise that. Numbers we cannot reproduce do not belong in the README.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'hydra');
const ADDON = path.join(ROOT, 'bin', 'hydra.node');

const SOURCE = `component Card(title: str, items: list, active: bool = False):
    div(cls="card", cls={"on": active}):
        h2: title
        for it in items:
            li(key=it):
                span: it
`;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function report(label, values, unit = 'ms') {
  const fmt = (v) => v.toFixed(3);
  console.log(
    `  ${label.padEnd(34)} median ${fmt(median(values))} ${unit}`.padEnd(70) +
      ` min ${fmt(Math.min(...values))}  max ${fmt(Math.max(...values))}  n=${values.length}`,
  );
}

// ------------------------------------------------------------------ CLI timing
// The CLI number is end-to-end wall clock: it includes spawning the process and
// reading the file, because that is what a user waits for. The addon number
// below is what a bundler sees, and the two are not comparable.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-bench-'));
const file = path.join(tmp, 'Card.hyx');
fs.writeFileSync(file, SOURCE);

console.log('\nCompile latency (median of 20 runs)');
const checkTimes = [];
const buildTimes = [];
for (let i = 0; i < 20; i++) {
  let t0 = process.hrtime.bigint();
  execFileSync(CLI, ['--check', file], { stdio: 'ignore' });
  checkTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);

  t0 = process.hrtime.bigint();
  execFileSync(CLI, [file], { stdio: 'ignore' });
  buildTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
report('hydra --check (process + parse)', checkTimes);
report('hydra <file> (process + emit)', buildTimes);

// ------------------------------------------------------------- in-process API
let addon = null;
try {
  // A `.node` addon is a CommonJS native module: `import()` rejects it with
  // "Unknown file extension", so it has to come in through createRequire.
  addon = createRequire(import.meta.url)(ADDON);
} catch (e) {
  console.log(`\n(addon not loaded: ${e.message})`);
}

if (addon && typeof addon.compile === 'function') {
  console.log('\nIn-process API (what a bundler sees, no process spawn)');
  for (let i = 0; i < 100; i++) addon.compile(SOURCE, 'Card.hyx'); // warm up
  const N = 2000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) addon.compile(SOURCE, 'Card.hyx');
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  ${'hydra.node compile'.padEnd(34)} median ${per.toFixed(4)} ms  (n=${N}, warm)`);
}

// ----------------------------------------------------------------- test counts
console.log('\nTest suite');
const cargoEnv = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const target = path.join(os.tmpdir(), 'hydra-bench-target');
const cargo = spawnSync('cargo', ['test', '--quiet'], {
  cwd: path.join(ROOT, 'compiler-rs'),
  env: { ...cargoEnv, CARGO_TARGET_DIR: target },
  encoding: 'utf8',
});
if (cargo.status === 0) {
  const all = `${cargo.stdout || ''}\n${cargo.stderr || ''}`;
  const passed = [...all.matchAll(/test result: ok\. (\d+) passed/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0);
  const total = passed.reduce((a, b) => a + b, 0);
  console.log(`  cargo test: ${total} passed across ${passed.length} binaries (${passed.join(' + ')})`);
} else {
  console.log(`  cargo test failed (status ${cargo.status}) — counts omitted rather than guessed`);
}

// ----------------------------------------------------------------- binary size
console.log('\nArtifacts');
for (const [label, p] of [
  ['bin/hydra (CLI, stripped)', CLI],
  ['bin/hydra.node (napi addon)', ADDON],
]) {
  if (fs.existsSync(p)) console.log(`  ${label.padEnd(34)} ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nNote: no comparison against tsc/Vite is published because it cannot be');
console.log('reproduced by anyone but the machine it was measured on.\n');
