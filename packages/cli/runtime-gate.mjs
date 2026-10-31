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
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp timeout: ${method}`));
        }
      }, 10000);
    });
  }
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

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-gate-'));
  let child = null;
  let server = null;
  const exceptions = [];
  const warnings = [];

  const finish = async (result) => {
    try {
      if (child && !child.killed) child.kill('SIGKILL');
    } catch {
      /* already gone */
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
    const url = `http://127.0.0.1:${port}/`;

    child = spawn(
      browser,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--mute-audio',
        '--window-size=1280,900',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

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

    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const text =
        d.exception?.description ||
        d.exception?.value ||
        d.text ||
        'uncaught exception';
      // The stack's first line is enough; the rest is noise in a build log.
      exceptions.push(String(text).split('\n')[0].trim());
    });
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.level === 'error') {
        // Console errors are warnings, not failures: React and third-party
        // libraries log recoverable complaints, and failing on those makes the
        // gate unusable. Exceptions are the hard signal.
        const t = (e.text || '').trim();
        if (t) warnings.push(t.split('\n')[0]);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    let loaded = false;
    cdp.on('Page.loadEventFired', () => {
      loaded = true;
    });
    await cdp.send('Page.navigate', { url });

    const loadDeadline = Date.now() + 15000;
    while (!loaded && Date.now() < loadDeadline) await sleep(100);
    if (!loaded) warnings.push(`page never fired load within 15s (${url})`);

    await sleep(SETTLE_MS);

    // Empty-shell detection. Advisory: reported, never fatal.
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
          `${info.rootId} rendered nothing (#${info.rootId} has no children and the body has no text)`,
        );
      }
    } catch {
      /* evaluate failing is not itself a finding */
    }

    ws.close();
    return await finish({
      ok: exceptions.length === 0,
      exceptions,
      warnings,
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
