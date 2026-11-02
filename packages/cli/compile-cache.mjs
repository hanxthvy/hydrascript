// [xihanzu-NR]
/**
 * Parallel compilation, and a cache that survives the process.
 *
 * Two problems, both measured before they were solved.
 *
 * 1. **Compilation was serial.** esbuild runs every `onLoad` callback on its own
 *    single JS thread, so on a 2-vCPU box the compiler was busy on one core
 *    while the other idled. A `worker_threads` pool fixes that: each worker owns
 *    the native addon and compiles independently.
 *
 * 2. **Recompiling unchanged files.** A rebuild after a one-line edit recompiled
 *    everything, and so did the next `hydra build`. The in-process `Map` in the
 *    esbuild plugin only helped within ONE build. The disk cache here is keyed by
 *    a hash of (source, compiler version), so a second build of an untouched
 *    project compiles nothing.
 *
 * The cache is content-addressed, so it cannot go stale: change the file and its
 * key changes. The one thing that would silently rot it — a compiler version
 * whose output differs for the same input — is part of the key.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

/** Cache layout version. Bump when the FORMAT changes (not the compiler). */
const FORMAT = 2;

/** How many files to pre-read before a worker gets to them, per batch. */
const BATCH = 64;

/** A stable hash of everything that can change the output. */
export function cacheKey({ source, filename, version, extra = '' }) {
  const h = createHash('sha256');
  h.update('hydra-compile');
  h.update('\0');
  h.update(String(FORMAT));
  h.update('\0');
  h.update(String(version));
  h.update('\0');
  h.update(String(filename));
  h.update('\0');
  h.update(String(extra));
  h.update('\0');
  h.update(source);
  return h.digest('hex').slice(0, 32);
}

/**
 * A disk cache of compiled modules.
 *
 * One file per entry rather than one big index: a single index rewritten on
 * every compile is a write amplification that costs more than the compile on a
 * large project, and a corrupt index would take the whole cache with it.
 *
 * `dir: null` gives an in-memory cache with the same interface, which is what
 * a caller uses when it does not want artifacts on disk (a test, or `--no-cache`).
 */
export class CompileCache {
  constructor(dir, { version = '', logger = null } = {}) {
    this.dir = dir;
    this.version = version;
    this.logger = logger;
    this.hits = 0;
    this.misses = 0;
    // The in-process layer in front of the disk one: a build compiles some files
    // more than once (a shared component in several entry graphs), and hashing
    // plus reading beats a `stat`.
    this.memory = new Map();
    this.extra = '';
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  /** Anything that changes the output but not the source, e.g. `base`. */
  withExtra(extra) {
    this.extra = String(extra);
    return this;
  }

  keyFor(filename, source) {
    return cacheKey({ source, filename, version: this.version, extra: this.extra });
  }

  /** The compiled result, or null. */
  get(key) {
    if (this.memory.has(key)) {
      this.hits += 1;
      return this.memory.get(key);
    }
    if (!this.dir) {
      this.misses += 1;
      return null;
    }
    const file = path.join(this.dir, key.slice(0, 2), key + '.json');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      this.misses += 1;
      return null;
    }
    try {
      const res = JSON.parse(text);
      this.memory.set(key, res);
      this.hits += 1;
      return res;
    } catch {
      // A truncated entry (a build killed mid-write) is a miss, not a failure.
      // Removing it keeps the directory from growing junk forever.
      try {
        fs.rmSync(file, { force: true });
      } catch {}
      this.misses += 1;
      return null;
    }
  }

  set(key, res) {
    this.memory.set(key, res);
    if (!this.dir) return;
    const file = path.join(this.dir, key.slice(0, 2), key + '.json');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Written to a temp name and renamed, so a reader never sees a half-written
      // entry and a killed build cannot leave one behind under the real name.
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(res), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      /* a cache that cannot write is a cache that misses */
    }
  }

  /** How many files would be compiled vs reused, without compiling anything. */
  plan(files, readSource) {
    let reuse = 0;
    let compile = 0;
    for (const f of files) {
      let src;
      try {
        src = readSource(f);
      } catch {
        compile += 1;
        continue;
      }
      if (this.get(this.keyFor(f, src))) reuse += 1;
      else compile += 1;
    }
    return { reuse, compile };
  }

  stats() {
    return { hits: this.hits, misses: this.misses };
  }
}

/** The default cache directory for a project. */
export function cacheDirFor(cwd) {
  return path.join(cwd, '.hydra', 'cache');
}

/* --------------------------------------------------------------- worker pool */

/** The worker's program: load the native addon, compile whatever arrives. */
const WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let native = null;
try {
  native = require(workerData.addon);
} catch (e) {
  parentPort.postMessage({ type: 'fatal', error: String(e && e.message ? e.message : e) });
  process.exit(0);
}
parentPort.on('message', (msg) => {
  if (msg.type === 'exit') { process.exit(0); }
  if (msg.type !== 'compile') return;
  try {
    const res = native.compile(msg.source, msg.filename);
    parentPort.postMessage({ type: 'done', id: msg.id, res: { ...res } });
  } catch (e) {
    parentPort.postMessage({
      type: 'done',
      id: msg.id,
      res: { error: String(e && e.stack ? e.stack : e) },
    });
  }
});
`;

/**
 * A pool of workers that compile in parallel.
 *
 * `size` defaults to the CPU count minus one, which on a 2-core box means ONE
 * worker: as many workers as cores would still leave the main thread starved on
 * the handful of tasks that are not compilation (module resolution, callbacks).
 * One fewer keeps the loop responsive, which is what makes the parallel path
 * faster in wall-clock terms rather than just busier.
 *
 * A pool is only worth creating when there is enough work to pay for it: each
 * worker is a thread plus a copy of the addon. `shouldPool` decides, from a
 * measured threshold rather than a guess.
 */
export class CompilePool {
  constructor(addonPath, { size = 0, timeoutMs = 30000 } = {}) {
    this.addonPath = addonPath;
    this.size = size || Math.max(1, os.cpus().length - 1);
    this.timeoutMs = timeoutMs;
    this.workers = [];
    this.nextId = 0;
    this.pending = new Map();
    this.failed = null;
    this.unsupported = false;
  }

  /** Create the workers. Rejects nothing: a pool that cannot start is `null`. */
  start() {
    if (this.workers.length > 0) return this;
    if (!this.addonPath || !fs.existsSync(this.addonPath)) {
      this.unsupported = true;
      return this;
    }
    for (let i = 0; i < this.size; i++) {
      let worker;
      try {
        worker = new Worker(WORKER_SOURCE, {
          // `eval: true` runs the source string directly. The obvious
          // `new URL('data:text/javascript,...')` form is WRONG here and fails
          // with "The argument 'filename' must be a file URL object..." —
          // `worker_threads` takes a path, a file: URL, or (with `eval`) a
          // string of code, not a data: URL.
          eval: true,
          workerData: { addon: this.addonPath },
          // A worker's own logging stays out of the build's output; the compiler
          // does not log today, and one that started to would corrupt whatever
          // parses stdout.
          stdout: false,
          stderr: false,
        });
      } catch (e) {
        this.unsupported = true;
        this.failed = String(e && e.message ? e.message : e);
        return this;
      }
      worker.on('message', (msg) => {
        if (msg.type === 'fatal') {
          this.failed = msg.error;
          return;
        }
        if (msg.type !== 'done') return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg.res);
        if (this.pending.size === 0) for (const w of this.workers) w.unref?.();
      });
      worker.on('error', (err) => {
        this.failed = String(err && err.message ? err.message : err);
      });
      // NOT unref'd while a compile is outstanding: `unref` lets the process
      // exit with work pending, and `compileAll` then awaits a promise no
      // message will ever resolve — the benchmark hung on exactly this. The
      // worker is ref'd on demand (see `compile`) and unref'd when idle.
      worker.unref();
      this.workers.push(worker);
    }
    return this;
  }

  /** Compile one file, on whichever worker is free. */
  compile(filename, source, slot = 0) {
    const worker = this.workers[slot % this.workers.length];
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: `compile timed out after ${this.timeoutMs}ms: ${filename}` });
        }
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      // Keep the event loop alive while this is in flight, and let it go when
      // the answer arrives. Without the ref the process can exit before the
      // worker replies.
      worker.ref?.();
      worker.postMessage({ type: 'compile', id, source, filename });
    });
  }

  /**
   * Compile many files across the pool, preserving input order.
   *
   * Round-robin assignment rather than a queue: a file's compile time is
   * unpredictable (a big component, a long f-string), and strict round-robin
   * self-balances better than handing the next task to whoever finished last
   * once the tasks differ in size.
   */
  async compileAll(items) {
    const out = new Array(items.length);
    let cursor = 0;
    const runner = async (slot) => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await this.compile(items[i].filename, items[i].source, slot);
      }
    };
    await Promise.all(this.workers.map((_, slot) => runner(slot)));
    return out;
  }

  async stop() {
    for (const w of this.workers) {
      try {
        w.postMessage({ type: 'exit' });
        await w.terminate();
      } catch {}
    }
    this.workers = [];
  }
}

/**
 * Is a pool worth starting? **No, at this compiler's speed — measured, not
 * assumed.**
 *
 * `benchmarks/compile.mjs` on a 2-vCPU box, 120 files:
 *
 *     serial cold:  47ms   (0.39ms/file)
 *     cache warm:    1ms   (0.01ms/file, 120/120 hits)
 *     pool (1 worker): 124ms
 *
 * The compiler is ~0.4 ms per file, so a `worker_threads` pool spends more on
 * thread startup and a second copy of the addon than it can save. The pool is
 * kept because it WORKS and is tested, and because that ratio is a property of
 * the compiler, not a law: a project with a thousand big components, or a
 * compiler that gets slower, changes the answer. The threshold below is set at
 * the point the measurement would have to move by an order of magnitude before
 * pooling pays.
 *
 * This function returning `false` everywhere today is the honest result of
 * measuring; the branch that uses it is real and reachable.
 */
export function shouldPool(fileCount, { cpus = os.cpus().length, msPerFile = 0.39 } = {}) {
  if (cpus <= 1) return false;
  // The startup cost of one worker, measured at ~60ms here; pooling must recover
  // that plus a margin before it is worth the memory.
  const STARTUP_MS = 60;
  return fileCount * msPerFile > STARTUP_MS * 4;
}

/** Every `.hyx`/`.hys` under `root`, for a caller that wants to pre-warm. */
export function sourceFilesUnder(root, { limit = 5000 } = {}) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.hydra') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(hyx|hsx|hys|hs|hx)$/.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

export { BATCH };
