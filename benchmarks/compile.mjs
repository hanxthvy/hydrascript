// [xihanzu-NR]
/**
 * What the compile cache and the worker pool actually buy.
 *
 * Run: node benchmarks/compile.mjs [--files N]
 *
 * The point of measuring before optimizing, and of keeping the number: the
 * cache reuses every module on a second build (`8 reused, 0 compiled`), and the
 * WALL CLOCK of that build barely moves, because compilation is a small slice of
 * a build dominated by esbuild's bundling and Tailwind. Both facts are reported
 * here, so "the cache makes builds faster" can never quietly become the claim.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CompileCache, CompilePool, cacheKey, shouldPool } from '../packages/cli/compile-cache.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PKG = path.resolve(HERE, '..');

const wanted = (() => {
  const at = process.argv.indexOf('--files');
  const n = at === -1 ? 120 : Number(process.argv[at + 1]);
  return Number.isFinite(n) && n > 0 ? n : 120;
})();

/** A source big enough that compilation is not free, and varied per file. */
function sourceFor(i) {
  const lines = [
    '# [xihanzu-NR]',
    `# component number ${i}`,
    '',
    `component Widget${i}(title: str = "w${i}", items: list = []):`,
    '    div(cls="card"):',
    '        h2(cls="t"): title',
    '        ul():',
    '            for it in items:',
    '                li(): it',
    `        p(cls="n"): f"widget ${i} of {len(items)}"`,
    '',
  ];
  for (let k = 0; k < 12; k++) {
    lines.push(`        span(cls="s${k}"): f"cell ${k} {i}: {title}"`);
  }
  return lines.join('\n');
}

function addonPath() {
  for (const rel of ['bin/hydra.node', 'bin/hydra']) {
    const p = path.join(PKG, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function nativeCompiler() {
  const addon = addonPath();
  if (!addon) return null;
  try {
    const mod = require(addon);
    const probe = mod.compile('# \n', 'probe.hys');
    if (probe && probe.error) return null;
    return (source, filename) => mod.compile(source, filename);
  } catch {
    return null;
  }
}

const fmt = (ms) => `${ms.toFixed(0)}ms`;
const per = (ms, n) => `${(ms / n).toFixed(2)}ms/file`;

async function main() {
  const compile = await nativeCompiler();
  if (!compile) {
    console.log('no native compiler available; nothing to measure');
    return;
  }

  const files = [];
  for (let i = 0; i < wanted; i++) {
    files.push({ filename: `Widget${i}.hyx`, source: sourceFor(i) });
  }

  // --- serial, cold -------------------------------------------------------
  let t0 = Date.now();
  for (const f of files) compile(f.source, f.filename);
  const serial = Date.now() - t0;

  // --- serial, with the disk cache ---------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-bench-cache-'));
  const cache = new CompileCache(dir, { version: 'bench' });
  t0 = Date.now();
  for (const f of files) {
    const key = cache.keyFor(f.filename, f.source);
    if (!cache.get(key)) cache.set(key, compile(f.source, f.filename));
  }
  const cold = Date.now() - t0;
  t0 = Date.now();
  let hits = 0;
  for (const f of files) {
    const key = cache.keyFor(f.filename, f.source);
    if (cache.get(key)) hits += 1;
  }
  const warm = Date.now() - t0;

  // --- a pool, when it is worth one --------------------------------------
  const pool = new CompilePool(addonPath(), { size: Math.max(1, os.cpus().length - 1) }).start();
  let pooled = null;
  let pooledNote = '';
  if (pool.unsupported || pool.failed) {
    pooledNote = `pool unavailable: ${pool.failed || 'worker_threads not usable here'}`;
  } else {
    t0 = Date.now();
    const out = await pool.compileAll(files);
    pooled = Date.now() - t0;
    const failed = out.filter((r) => r && r.error).length;
    if (failed > 0) pooledNote = `${failed}/${files.length} compiles failed in the pool`;
    await pool.stop();
  }

  const cpus = os.cpus().length;
  console.log(`files:        ${wanted}`);
  console.log(`cpus:         ${cpus}`);
  console.log('');
  console.log(`serial cold:  ${fmt(serial)}  (${per(serial, wanted)})`);
  console.log(`cache cold:   ${fmt(cold)}  (${per(cold, wanted)})  — first run, cache writes`);
  console.log(`cache warm:   ${fmt(warm)}  (${per(warm, wanted)})  — ${hits}/${wanted} hits`);
  console.log(
    `cache saving: ${fmt(serial - warm)} over serial (${((1 - warm / serial) * 100).toFixed(0)}% of compile time)`,
  );
  if (pooled !== null) {
    console.log(`pool (${Math.max(1, cpus - 1)} workers):   ${fmt(pooled)}  (${per(pooled, wanted)})`);
    console.log(`pool saving:  ${fmt(serial - pooled)} over serial`);
  } else {
    console.log(`pool:         skipped — ${pooledNote}`);
  }
  console.log('');
  console.log(`shouldPool(${wanted}) = ${shouldPool(wanted)}`);
  console.log('');
  console.log('NOTE: this is COMPILATION only. In a real `hydra build` the compile');
  console.log('step is a small slice — esbuild bundling and Tailwind dominate — so a');
  console.log('build whose cache reuses every module gets most of a second back at');
  console.log('best, not most of the build. `hydra build` prints its own cache hits so');
  console.log('the two numbers cannot be confused.');

  fs.rmSync(dir, { recursive: true, force: true });
}

await main();
