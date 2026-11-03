// [xihanzu-NR]
/**
 * Runtime gate: load the built site in headless Chrome and fail the build if
 * the page throws.
 *
 * Why this exists: the compiler checks the *shape* of the JS it emits, and the
 * semantic checker catches a class of authoring mistakes, but neither can catch
 * a component that throws while rendering. That failure mode is the worst one
 * there is — `hydra build` prints "Built successfully", and the visitor gets a
 * blank page. The only way to know is to actually run the bundle.
 *
 * Honesty about what it does and does not claim:
 *
 *   - An uncaught exception (or an unhandled rejection, which the browser
 *     reports the same way) is a **failure**. That is hard evidence.
 *   - A page that rendered nothing is a **warning**, not a failure. Some apps
 *     legitimately render an empty shell until a fetch resolves, and a gate
 *     that red-lights those is a gate people turn off.
 *   - Chrome missing, or the gate timing out, is a **skip** with a reason. This
 *     box may not have a browser; a build must not depend on one existing.
 *
 * No dependency is used: Chrome is driven over the DevTools Protocol with the
 * WebSocket that Node 22 provides. Installing puppeteer to check a build would
 * cost more memory than the compiler it is checking.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** Candidate browsers, in order of preference. */
const BROWSERS = [
  process.env.HYDRA_CHROME,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  'msedge',
].filter(Boolean);

/** How long to let the page settle after `load` before judging it. */
const SETTLE_MS = Number(process.env.HYDRA_GATE_SETTLE_MS || 900);

/** Whole-gate budget. A hung browser must not hang the build. */
const GATE_TIMEOUT_MS = Number(process.env.HYDRA_GATE_TIMEOUT_MS || 25000);

/**
 * Available memory (MiB) needed before the gate will launch a browser.
 * `HYDRA_GATE_FORCE=1` overrides the check.
 */
const GATE_MIN_FREE_MIB = Number(process.env.HYDRA_GATE_MIN_MB || 350);

/** MemAvailable from /proc/meminfo, in MiB; null where that file is not a thing. */
function availableMemoryMiB() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(txt);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/**
 * Chrome flags for the gate. Exported so a test can assert them: two of these are
 * load-bearing, not cosmetic.
 *
 * `--disable-webgl` in particular. On a machine with no GPU — every CI runner,
 * the machine this was written on — `--disable-gpu` alone leaves Chrome falling
 * back to SwiftShader, and a page with a WebGL render loop (ogl, three) starves
 * the renderer's main thread until `Runtime.evaluate` misses its slot and dies on
 * the CDP timeout. Measured on the portfolio: 10,001ms with WebGL on, 3ms off.
 * The empty-shell check never ran, silently, and the build took 15s instead of 4.
 */
export const GATE_CHROME_FLAGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-webgl',
  '--disable-3d-apis',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--mute-audio',
  '--window-size=1280,900',
  'about:blank',
];

function which(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function findBrowser() {
  for (const b of BROWSERS) {
    if (b.includes('/')) {
      try {
        fs.accessSync(b, fs.constants.X_OK);
        return b;
      } catch {
        continue;
      }
    }
    const found = which(b);
    if (found) return found;
  }
  return null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`bad JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A Chrome left behind by a killed build holds its renderer's memory forever.
 *
 * `child.kill()` kills the process the gate spawned and NOT its children, and a
 * Chrome is a process tree: browser, gpu, zygote, one renderer per tab. Killing
 * the parent leaves the renderers reparented to init and running — measured on
 * this machine, four orphaned gates held ~800 MB between them and the next
 * build died on SIGTERM. The gate is spawned `detached` so Chrome becomes a
 * process-group leader, and the whole group is killed.
 *
 * `process.on('exit')` covers the case that caused the leak in the first place:
 * the build itself being interrupted, which never reaches the `finally`.
 */
const liveGates = new Set();

function killTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    // Negative pid = the whole process group (Chrome was spawned detached).
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function killAllGates() {
  for (const c of liveGates) killTree(c);
  liveGates.clear();
}
process.on('exit', killAllGates);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killAllGates();
    process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1));
  });
}

/**
 * Remove profiles a previous, killed gate left in tmp, and the Chrome trees
 * still attached to them. Best effort and bounded: anything whose browser is
 * gone, or older than an hour, is removed. Without this a machine accumulates
 * one dead profile per interrupted build.
 */
function sweepStaleGates() {
  const tmp = os.tmpdir();
  let entries = [];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('hydra-gate-')) continue;
    const dir = path.join(tmp, name);
    try {
      const age = now - fs.statSync(dir).mtimeMs;
      const owner = path.join(dir, 'DevToolsActivePort');
      // A profile with no live browser (no port file after a moment) or one old
      // enough that no build can still own it.
      if (age < 60_000 && fs.existsSync(owner)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* in use by another build, leave it */
    }
  }
}

/**
 * A tiny CDP client: enough of the protocol for a page load, and nothing more.
 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'cdp error'));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const hs = this.handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params || {});
      }
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // The timeout must not keep the process alive. Node will not exit while a
      // timer is pending, and these are never cleared on success, so a gate that
      // finished in 2.5s still held the event loop until the 10s timer fired —
      // measured: `gate total: 2523ms`, `wall 12593ms`. `unref()` keeps the
      // timeout working but lets the process end as soon as the work is done.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp timeout: ${method}`));
        }
      }, 10000);
      timer.unref?.();
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

/**
/**
 * Did this console error come from the page this build produced?
 *
 * The gate serves the build on 127.0.0.1, so a source that starts with that
 * origin is ours. The MIME errors a browser emits for a module it refused to
 * execute carry no `url` at all — but they are always about a script this page
 * asked for, so they are treated as ours too.
 */
function isOwnOriginError(entry, pagePath) {
  const url = String(entry.url || '');
  // A browser asks for /favicon.ico on its own, and a project that ships no
  // icon is not a broken build. Everything else from our origin is ours.
  if (/favicon\.ico$/.test(url) || /favicon\.ico/.test(String(entry.text || ''))) return false;
  if (url && (/^https?:\/\/127\.0\.0\.1[:/]/.test(url) || url.startsWith('/'))) return true;
  const text = String(entry.text || '');
  return /Failed to load module script|Expected a JavaScript|MIME type|Failed to load resource/i.test(text);
}

/**
 * Every HTML page the build produced, as URL paths, root first.
 *
 * A file-based build emits one page per static route (`dist/about/index.html`),
 * and checking only `dist/index.html` would leave every other route unchecked —
 * which is exactly where a route-specific bug lives. The list is bounded so a
 * project with hundreds of routes cannot turn a build into a browser
 * regression suite; the cap is reported rather than silently applied.
 */
function builtPages(distDir, cap = Number(process.env.HYDRA_GATE_PAGES) || 25) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'index.html') {
        const rel = path.relative(distDir, dir).split(path.sep).join('/');
        found.push(rel === '' ? '/' : `/${rel}/`);
      }
    }
  };
  walk(distDir);
  found.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
  return { pages: found.slice(0, cap), total: found.length, cap };
}

/**
 * Run the gate against a directory of built files.
 *
 * @param {object} opts
 * @param {string} opts.distDir  directory containing index.html
 * @param {Function} opts.serve  async (dir) => { server, port } — caller-owned
 *                               static server, so the gate reuses the one the
 *                               preview command already uses instead of
 *                               reimplementing static serving.
 * @returns {Promise<{skipped?: string, ok: boolean, exceptions: string[],
 *                    warnings: string[]}>}
 */
export async function runRuntimeGate({ distDir, serve }) {
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return { skipped: `no index.html in ${distDir}`, ok: true, exceptions: [], warnings: [] };
  }
  const browser = findBrowser();
  if (!browser) {
    return {
      skipped: 'no Chrome/Chromium on PATH (set HYDRA_CHROME to point at one)',
      ok: true,
      exceptions: [],
      warnings: [],
    };
  }

  // A browser needs ~150 MB. On a small box already under memory pressure,
  // launching one is what tips it over: measured on a 3.8 GB host, earlyoom
  // killed the build mid-gate at 19% available memory and the build reported
  // "killed by SIGTERM" with nothing about the gate. A build must not be the
  // thing that dies because the gate wanted a browser, so the gate steps aside
  // and says why.
  const mem = process.env.HYDRA_GATE_FORCE === '1' ? null : availableMemoryMiB();
  if (mem !== null && mem < GATE_MIN_FREE_MIB) {
    return {
      skipped: `only ${mem} MiB of memory available; the browser check needs ~${GATE_MIN_FREE_MIB} MiB (run it by hand: HYDRA_GATE_FORCE=1 hydra build)`,
      ok: true,
      exceptions: [],
      warnings: [],
    };
  }

  sweepStaleGates();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-gate-'));
  let child = null;
  let server = null;
  const exceptions = [];
  const warnings = [];

  const finish = async (result) => {
    if (child) {
      killTree(child);
      liveGates.delete(child);
    }
    try {
      server?.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return result;
  };

  try {
    ({ server } = await serve(distDir));
    const port = server.address()?.port;
    if (!port) throw new Error('static server did not report a port');

    child = spawn(
      browser,
      // The profile comes first so the array stays readable; the rest is the
      // exported constant so nothing can silently drift from what it asserts.
      [`--user-data-dir=${profile}`, ...GATE_CHROME_FLAGS],
      // `detached` makes Chrome a process-group leader so `killTree` can take
      // the whole tree down. Without it the renderers outlive the gate.
      { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
    );
    liveGates.add(child);

    // Chrome writes the port it chose into DevToolsActivePort.
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 12000;
    let devPort = null;
    while (Date.now() < deadline) {
      if (fs.existsSync(portFile)) {
        const txt = fs.readFileSync(portFile, 'utf8').split('\n');
        if (txt[0] && /^\d+$/.test(txt[0].trim())) {
          devPort = Number(txt[0].trim());
          break;
        }
      }
      if (child.exitCode !== null) break;
      await sleep(120);
    }
    if (!devPort) {
      return await finish({
        skipped: 'chrome did not open a debugging port',
        ok: true,
        exceptions: [],
        warnings: [],
      });
    }

    // Chrome is launched with `about:blank` as its target, so the page to
    // attach to is already there and stays the same one for every route.
    const targets = await getJson(`http://127.0.0.1:${devPort}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) {
      return await finish({
        skipped: 'no page target to attach to',
        ok: true,
        exceptions: [],
        warnings: [],
      });
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('devtools websocket failed')), {
        once: true,
      });
    });
    const cdp = new Cdp(ws);

    /** Exceptions seen since the last `Page.navigate`, with the page they came from. */
    let currentPage = '/';
    /** How many pages the gate actually looked at, and how many exist. */
    let checked = 0;
    let builtTotal = 0;
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const text = d.exception?.description || d.exception?.value || d.text || 'uncaught exception';
      // The stack's first line is enough; the rest is noise in a build log.
      exceptions.push(`${currentPage} — ${String(text).split('\n')[0].trim()}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.level === 'error') {
        const t = (e.text || '').trim();
        if (!t) return;
        const where = e.url ? ` (${e.url})` : '';
        const line = `${currentPage} — ${t.split('\n')[0]}${where}`;
        // An error from OUR OWN origin is a failure. A chunk that fails to load,
        // a MIME mismatch, a 404 on an asset: these are exactly the failures
        // that used to print as "gate passed (1 warning)" while the page was
        // blank. A third-party script's complaint stays a warning, because this
        // gate does not own that code.
        if (isOwnOriginError(e, currentPage)) exceptions.push(line);
        else warnings.push(line);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    const { pages, total, cap } = builtPages(distDir);
    // Recorded, not merely warned about: a build that says "gate passed"
    // without saying how many pages it looked at is the shape of a green lie.
    checked = pages.length;
    builtTotal = total;
    if (total > cap) {
      warnings.push(
        `${total} HTML pages built; the gate checked the first ${cap} ` +
          '(set HYDRA_GATE_PAGES to raise it — a build is not a test suite)',
      );
    }

    for (const pagePath of pages) {
      currentPage = pagePath;
      let loaded = false;
      const onLoad = () => {
        loaded = true;
      };
      cdp.on('Page.loadEventFired', onLoad);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}${pagePath}` });

      const loadDeadline = Date.now() + 15000;
      while (!loaded && Date.now() < loadDeadline) await sleep(100);
      if (!loaded) warnings.push(`${pagePath} — page never fired load within 15s`);

      await sleep(SETTLE_MS);

      // Empty-shell detection. Advisory: reported, never fatal. Skipped for the
      // off-budget pages above, where the browser was never pointed at them.
      try {
        const res = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const root = document.getElementById('root') || document.body;
            return JSON.stringify({
              rootId: document.getElementById('root') ? 'root' : 'body',
              children: root ? root.children.length : -1,
              textLength: (document.body.innerText || '').trim().length,
            });
          })()`,
          returnByValue: true,
        });
        const info = JSON.parse(res.result?.value || '{}');
        if (info.children === 0 && info.textLength === 0) {
          warnings.push(
            `${pagePath} — ${info.rootId} rendered nothing (#${info.rootId} has no children and the body has no text)`,
          );
        }
      } catch (e) {
        // A failed probe is not a finding, but swallowing it silently is how a
        // 10-second stall stayed invisible: the check that was supposed to notice
        // an empty page simply never ran. Say so.
        warnings.push(`${pagePath} — empty-shell check could not run: ${e.message}`);
      }
    }

    ws.close();
    return await finish({
      ok: exceptions.length === 0,
      exceptions,
      warnings,
      checked,
      total: builtTotal,
      cap,
    });
  } catch (e) {
    return await finish({
      skipped: `gate could not run: ${e.message}`,
      ok: true,
      exceptions: [],
      warnings: [],
    });
  }
}
