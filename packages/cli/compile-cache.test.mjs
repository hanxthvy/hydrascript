// [xihanzu-NR]
/**
 * The compile cache and the worker pool.
 *
 * The cache is the feature that ships; the pool is kept because it works and is
 * reachable on a large enough project, and because deleting working, tested code
 * is not what "the measurement says it does not pay today" licenses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CompileCache,
  CompilePool,
  cacheKey,
  cacheDirFor,
  shouldPool,
  sourceFilesUnder,
} from './compile-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const ADDON = path.join(REPO, 'bin', 'hydra.node');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cache-'));

test('the key changes with the source, the filename, the version and the extra', () => {
  const base = { source: 'a\n', filename: 'x.hyx', version: '1.0.0' };
  const k = cacheKey(base);
  assert.notEqual(k, cacheKey({ ...base, source: 'b\n' }), 'source');
  assert.notEqual(k, cacheKey({ ...base, filename: 'y.hyx' }), 'filename');
  assert.notEqual(k, cacheKey({ ...base, version: '1.0.1' }), 'compiler version');
  assert.notEqual(k, cacheKey({ ...base, extra: '/' }), 'extra (base path)');
  assert.equal(k, cacheKey(base), 'stable for the same input');
});

test('a store/get round trip, and a miss for a different key', () => {
  const dir = tmp();
  const cache = new CompileCache(dir, { version: '1' });
  const key = cache.keyFor('a.hyx', 'source text');
  assert.equal(cache.get(key), null, 'cold');
  cache.set(key, { code: 'ok', map: '{}' });
  assert.deepEqual(cache.get(cache.keyFor('a.hyx', 'source text')), { code: 'ok', map: '{}' });
  assert.equal(cache.get(cache.keyFor('a.hyx', 'other text')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cache survives a new instance, which is the whole point', () => {
  const dir = tmp();
  const a = new CompileCache(dir, { version: '1' });
  a.set(a.keyFor('a.hyx', 's'), { code: 'first' });
  const b = new CompileCache(dir, { version: '1' });
  assert.deepEqual(b.get(b.keyFor('a.hyx', 's')), { code: 'first' });
  // A different compiler version must NOT reuse it: same input, different
  // output is exactly the case a content-addressed cache cannot see by itself.
  const c = new CompileCache(dir, { version: '2' });
  assert.equal(c.get(c.keyFor('a.hyx', 's')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a truncated entry is a miss, not a crash', () => {
  const dir = tmp();
  const cache = new CompileCache(dir, { version: '1' });
  const key = cache.keyFor('a.hyx', 's');
  cache.set(key, { code: 'ok' });
  const file = path.join(dir, key.slice(0, 2), key + '.json');
  fs.writeFileSync(file, '{"code": "trunca');
  const fresh = new CompileCache(dir, { version: '1' });
  assert.equal(fresh.get(key), null);
  assert.ok(!fs.existsSync(file), 'the bad entry is removed, not left to fail again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an in-memory cache (dir null) still works', () => {
  const cache = new CompileCache(null, { version: '1' });
  const key = cache.keyFor('a.hyx', 's');
  assert.equal(cache.get(key), null);
  cache.set(key, { code: 'x' });
  assert.deepEqual(cache.get(key), { code: 'x' });
});

test('plan() counts reuse and compile without compiling', () => {
  const dir = tmp();
  const cache = new CompileCache(dir, { version: '1' });
  cache.set(cache.keyFor('a.hyx', 'A'), { code: 'A' });
  const sources = { 'a.hyx': 'A', 'b.hyx': 'B' };
  const plan = cache.plan(Object.keys(sources), (f) => sources[f]);
  assert.deepEqual(plan, { reuse: 1, compile: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sourceFilesUnder finds sources and skips generated trees', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hydra'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App.hyx'), '#\n');
  fs.writeFileSync(path.join(dir, 'src', 'components', 'Card.hyx'), '#\n');
  fs.writeFileSync(path.join(dir, 'src', 'logic.hys'), '#\n');
  fs.writeFileSync(path.join(dir, 'src', 'style.css'), 'a{}');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'Dep.hyx'), '#\n');
  fs.writeFileSync(path.join(dir, '.hydra', 'gen.hyx'), '#\n');
  const found = sourceFilesUnder(dir).map((f) => path.relative(dir, f)).sort();
  assert.deepEqual(found, ['src/App.hyx', 'src/components/Card.hyx', 'src/logic.hys']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shouldPool says no at this compiler speed, and would say yes at scale', () => {
  // Measured: 0.39ms/file, one worker's startup ~60ms. Pooling only pays when
  // the compile work dwarfs that startup.
  assert.equal(shouldPool(120, { cpus: 2 }), false);
  assert.equal(shouldPool(10, { cpus: 2 }), false);
  assert.equal(shouldPool(5000, { cpus: 2 }), true);
  assert.equal(shouldPool(5000, { cpus: 1 }), false, 'one core has nothing to pool');
});

test('the pool compiles across workers and returns results in order', async (t) => {
  if (!fs.existsSync(ADDON)) return t.skip(`${ADDON} not built`);
  const pool = new CompilePool(ADDON, { size: 2 }).start();
  if (pool.unsupported || pool.failed) return t.skip(`pool unavailable: ${pool.failed}`);
  try {
    const items = [
      { filename: 'a.hys', source: '# [xihanzu-NR]\nprint("a")\n' },
      { filename: 'b.hys', source: '# [xihanzu-NR]\nprint("b")\n' },
      { filename: 'c.hys', source: '# [xihanzu-NR]\nprint("c")\n' },
      { filename: 'd.hyx', source: '# [xihanzu-NR]\ncomponent D():\n    div(): "d"\n' },
    ];
    const out = await pool.compileAll(items);
    assert.equal(out.length, items.length);
    for (let i = 0; i < out.length; i++) {
      assert.ok(out[i], `result ${i} missing`);
      assert.equal(out[i].error, undefined, `result ${i} errored: ${out[i].error}`);
      // The ORDER is the caller's contract: a misplaced module would be wired
      // into the wrong chunk.
      const expected = i === 3 ? 'D' : String.fromCharCode(97 + i);
      assert.match(out[i].code, new RegExp(expected), `result ${i} is not ${expected}`);
    }
  } finally {
    await pool.stop();
  }
});

test('a syntax error in one file comes back as an error, not as a thrown pool', async (t) => {
  if (!fs.existsSync(ADDON)) return t.skip(`${ADDON} not built`);
  const pool = new CompilePool(ADDON, { size: 1 }).start();
  if (pool.unsupported || pool.failed) return t.skip(`pool unavailable: ${pool.failed}`);
  try {
    const out = await pool.compileAll([{ filename: 'bad.hyx', source: 'component(((\n' }]);
    assert.ok(out[0].error, `expected an error, got ${JSON.stringify(out[0]).slice(0, 120)}`);
  } finally {
    await pool.stop();
  }
});

test('cacheDirFor is under the project, gitignored by convention', () => {
  assert.equal(cacheDirFor('/proj'), path.join('/proj', '.hydra', 'cache'));
});

test('a warm cache causes ZERO compiles — the regression that matters in the BUILD', () => {
  // Deliberately not a wall-clock assertion.
  //
  // "the warm run must be under 5 ms" fails on a busy CI box and passes on a
  // fast one while the cache is broken-but-lucky. What must never regress is the
  // BEHAVIOUR: a second pass over unchanged sources must not call the compiler
  // at all. A spy proves that deterministically; the benchmark owns the timing.
  const dir = tmp();
  const cache = new CompileCache(dir, { version: '1' });
  let compiles = 0;
  const fakeCompiler = (source, filename) => {
    compiles += 1;
    return { code: `// ${filename}`, map: '{}' };
  };

  const files = [];
  for (let i = 0; i < 40; i++) files.push({ filename: `F${i}.hyx`, source: `src ${i}\n` });

  // A stand-in for the esbuild plugin's `compile`: memory map, then disk cache,
  // then the compiler. This is the exact order the real plugin uses.
  const memory = new Map();
  const compile = (file, source) => {
    const hit = memory.get(file);
    if (hit !== undefined && hit.source === source) return hit.res;
    const key = cache.keyFor(file, source);
    const cached = cache.get(key);
    if (cached) {
      memory.set(file, { source, res: cached });
      return cached;
    }
    const res = fakeCompiler(source, file);
    cache.set(key, res);
    memory.set(file, { source, res });
    return res;
  };

  for (const f of files) compile(f.filename, f.source);
  assert.equal(compiles, 40, 'the first pass compiles everything once');

  // A SECOND process would start with an empty memory map, so clear it: this is
  // what "the next hydra build" looks like.
  memory.clear();
  cache.memory.clear();
  compiles = 0;
  for (const f of files) compile(f.filename, f.source);
  assert.equal(compiles, 0, `a warm cache must not compile anything, compiled ${compiles}`);

  // And a single changed file compiles exactly once.
  memory.clear();
  cache.memory.clear();
  compiles = 0;
  const edited = { ...files[7], source: 'edited\n' };
  for (const f of files) compile(f.filename, f.source);
  compile(edited.filename, edited.source);
  assert.equal(compiles, 1, `only the edited file recompiles, compiled ${compiles}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an error is NOT cached, so a fixed file compiles immediately', () => {
  // Caching a failure would make a build fail forever on a file the developer
  // has already fixed in the same second.
  const dir = tmp();
  const cache = new CompileCache(dir, { version: '1' });
  const bad = cache.keyFor('x.hyx', 'broken');
  cache.set(bad, { error: 'syntax error' });
  assert.equal(cache.get(bad), null, 'the cache must refuse to store an error');

  // The same file, fixed, compiles and IS stored.
  const good = cache.keyFor('x.hyx', 'fixed');
  cache.set(good, { code: 'ok' });
  assert.deepEqual(cache.get(good), { code: 'ok' });

  // A fresh instance too: nothing was written to disk for the failure.
  const fresh = new CompileCache(dir, { version: '1' });
  assert.equal(fresh.get(bad), null);
  assert.deepEqual(fresh.get(good), { code: 'ok' });
  fs.rmSync(dir, { recursive: true, force: true });
});
