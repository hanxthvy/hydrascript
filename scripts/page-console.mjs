// [xihanzu-NR]
/**
 * Load a built site in headless Chrome and print what the CONSOLE said.
 *
 * The build's own gate reports uncaught exceptions and empty shells; this is the
 * same information, printed, so a person can see WHY a page is blank instead of
 * trusting a one-line warning. Dev-only, no dependency: Chrome over CDP.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2];
const root = path.resolve(process.argv[3] || 'dist');
const PORT = 8123;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((q, s) => {
  let p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html');
  s.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(s);
});
await new Promise((r) => server.listen(PORT, r));

const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333',
  '--user-data-dir=/tmp/cdp-profile-' + process.pid, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 40; i++) {
  try {
    targets = await (await fetch('http://127.0.0.1:9333/json')).json();
    if (targets.length) break;
  } catch { /* not up yet */ }
  await sleep(200);
}
if (!targets) { console.log('chrome did not start'); process.exit(2); }

// Pick a real PAGE target. targets[0] can be a Chrome extension's background
    // page, which has no DOM and no scripts — measuring that reports "blank" for
    // every site and looks like a compiler bug.
    const pageTarget = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://')) || targets[0];
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: url || `http://127.0.0.1:${PORT}/` });
await sleep(6000);

for (const ev of events) {
  if (ev.method === 'Runtime.exceptionThrown') {
    const d = ev.params.exceptionDetails;
    console.log('EXCEPTION:', d.exception?.description || d.text);
  }
  if (ev.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(ev.params.type)) {
    console.log(ev.params.type.toUpperCase() + ':', ev.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (ev.method === 'Log.entryAdded' && ev.params.entry.level !== 'verbose') {
    console.log('LOG:', ev.params.entry.level, ev.params.entry.text);
  }
}

const probe = await send('Runtime.evaluate', {
  expression: `(() => { const r = document.getElementById('root') || document.body;
    return JSON.stringify({ children: r.children.length, text: (document.body.innerText||'').trim().slice(0,120), html: r.innerHTML.length }); })()`,
  returnByValue: true,
});
console.log('DOM:', probe.result?.value);

ws.close();
chrome.kill();
server.close();
process.exit(0);
