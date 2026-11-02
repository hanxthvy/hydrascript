// [xihanzu-NR]
/** Print the FULL stack of the first uncaught exception on a page. */
import { spawn } from 'node:child_process';

const url = process.argv[2] || 'http://127.0.0.1:4490/';
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=9360', '--user-data-dir=/tmp/cdp-st-' + process.pid, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch('http://127.0.0.1:9360/json')).json(); if (targets.some((t) => t.type === 'page')) break; } catch {}
  await sleep(200);
}
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Debugger.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(7000);

for (const ev of events) {
  if (ev.method === 'Runtime.exceptionThrown') {
    const d = ev.params.exceptionDetails;
    console.log('EXCEPTION:', d.text);
    console.log('  detail:', d.exception?.description?.slice(0, 800));
    for (const f of d.stackTrace?.callFrames || []) {
      console.log(`  at ${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`);
    }
  }
}
ws.close(); chrome.kill(); process.exit(0);
