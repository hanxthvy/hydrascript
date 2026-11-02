// [xihanzu-NR]
/** Load a built page and report whether its modules actually LOADED. */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist');
const PORT = 8127;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((q, s) => {
  let p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html');
  s.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(s);
});
await new Promise((r) => server.listen(PORT, r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=9334', '--user-data-dir=/tmp/cdp2-' + process.pid, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 40; i++) {
  try { targets = await (await fetch('http://127.0.0.1:9334/json')).json(); if (targets.length) break; } catch {}
  await sleep(200);
}
// Pick a real PAGE target. targets[0] can be a Chrome extension's background
    // page, which has no DOM and no scripts — measuring that reports "blank" for
    // every site and looks like a compiler bug.
    const pageTarget = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://')) || targets[0];
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(7000);

console.log('--- network');
for (const ev of events) {
  if (ev.method === 'Network.responseReceived') {
    const r = ev.params.response;
    console.log(r.status, r.url.replace(`http://127.0.0.1:${PORT}`, ''));
  }
  if (ev.method === 'Network.loadingFailed') console.log('FAILED', ev.params.errorText);
}
console.log('--- console/log');
for (const ev of events) {
  if (ev.method === 'Runtime.exceptionThrown') console.log('EXC:', ev.params.exceptionDetails.exception?.description?.split('\n')[0]);
  if (ev.method === 'Log.entryAdded') console.log('LOG:', ev.params.entry.level, ev.params.entry.text.slice(0, 200));
}
const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    root: (document.getElementById('root')||{}).innerHTML?.length ?? -1,
    scripts: [...document.scripts].map(s => s.src || 'inline'),
    react: typeof window.React,
  })`, returnByValue: true,
});
console.log('DOM:', probe.result?.value);
ws.close(); chrome.kill(); server.close(); process.exit(0);
