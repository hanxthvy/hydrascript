// [xihanzu-NR]
/**
 * Save-to-reload: how long `hydra dev` takes from a file write to the browser
 * being told to reload.
 *
 * The README claimed "~10 seconds from save to reload" long after the parallel
 * build landed, and a stale number in the front door is the same class of error
 * as the three test counts that disagreed: it is a claim nobody re-measured.
 * This measures the number the sentence needs — the dev server's own rebuild
 * cycle, not a production build, which is a different and much slower thing.
 *
 * Method: start `hydra dev` on the project, wait for the first build, connect to
 * its websocket, write a byte to one page, and time the gap until a message
 * arrives. Three edits, median reported.
 *
 * Run: node benchmarks/dev-reload.mjs [project] [runs]
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'hydra.js');
const project = path.resolve(process.argv[2] || path.join(ROOT, 'examples', 'blog'));
const runs = Number(process.argv[3] || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function config() {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, 'hydraconfig.json'), 'utf8'));
  } catch {
    return {};
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Wait for the dev server's health endpoint, or throw. */
async function waitForServer(port, deadlineMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const ok = await new Promise((resolve) => {
      import('node:http').then(({ default: http }) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/__hydra/healthz' }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
      });
    });
    if (ok) return Date.now() - started;
    await sleep(100);
  }
  throw new Error('dev server never answered');
}

/** One websocket message from the dev server, with the time it arrived. */
function nextHmrMessage(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const key = Buffer.from(String(Math.random()).slice(2)).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /__hydra/hmr HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('no hmr message within ' + timeoutMs + 'ms'));
    }, timeoutMs);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.includes(Buffer.from('101 Switching Protocols'))) {
        // Any frame after the handshake is the reload signal.
        const text = buffer.toString('latin1');
        if (text.includes('\x81') || text.length > 200) {
          clearTimeout(timer);
          socket.destroy();
          resolve(Date.now());
        }
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('close', () => clearTimeout(timer));
  });
}

function pickPage(dir) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (e.name.endsWith('.hyx')) {
        return full;
      }
    }
    return null;
  };
  return walk(path.join(dir, 'src'));
}

const cfg = config();
const port = cfg.server?.port || 5173;
if (!(await portFree(port))) {
  console.error(`port ${port} is busy; stop whatever is on it and re-run`);
  process.exit(1);
}

console.log(`project: ${project}`);
console.log(`mode: dev   runs: ${runs}  (median save-to-reload)\n`);

const page = pickPage(project);
if (!page) {
  console.error('no .hyx page to edit');
  process.exit(1);
}
const original = fs.readFileSync(page, 'utf8');

const child = spawn(process.execPath, [CLI, 'dev', '--port', String(port)], {
  cwd: project,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let log = '';
child.stdout.on('data', (b) => (log += b));
child.stderr.on('data', (b) => (log += b));

const samples = [];
try {
  const boot = await waitForServer(port);
  console.log(`first build: ${boot} ms`);
  await sleep(400);

  for (let i = 0; i < runs; i++) {
    // A websocket opened BEFORE the write, so the measurement is the rebuild
    // plus the push, not the handshake.
    const waiting = nextHmrMessage(port);
    await sleep(120);
    const t0 = Date.now();
    fs.writeFileSync(page, `${original}\n# touch ${i}\n`);
    await waiting;
    const ms = Date.now() - t0;
    samples.push(ms);
    console.log(`  edit ${i + 1}: ${ms} ms`);
    await sleep(300);
  }
} finally {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  fs.writeFileSync(page, original);
}

samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
console.log(`\nsave-to-reload median: ${median} ms   runs [${samples.join(', ')}]`);
