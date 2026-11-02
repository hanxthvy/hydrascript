// [xihanzu-NR]
/** Log every HMR message the browser receives, and what the client does with it. */
import { spawn } from 'node:child_process';

const url = process.argv[2] || 'http://127.0.0.1:4530/';
const APP = process.argv[3] || '/tmp/fr/app';
import fs from 'node:fs';
const path = await import('node:path');

const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=9370', '--user-data-dir=/tmp/cdp-hm-' + process.pid, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets = null;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch('http://127.0.0.1:9370/json')).json(); if (targets.some((t) => t.type === 'page')) break; } catch {}
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
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(5000);

// Patch WebSocket onmessage to report what arrives.
await evalJs(`(() => {
  window.__hmr_log = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = function(u, p) {
    const s = new OrigWS(u, p);
    s.addEventListener('message', (ev) => window.__hmr_log.push(String(ev.data).slice(0, 120)));
    return s;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  return 'patched';
})()`);

await evalJs(`window.__probe_token = 'alive'`);
const comp = path.join(APP, 'src/components/Counter.hyx');
const orig = fs.readFileSync(comp, 'utf8');
fs.writeFileSync(comp, orig.replace('"tambah"', '"tambah (edited2)"'));
await sleep(6000);

console.log('hmr messages:', JSON.stringify(await evalJs(`window.__hmr_log`)));
console.log('token alive:', await evalJs(`window.__probe_token === 'alive'`));
console.log('count:', await evalJs(`(document.body.innerText.match(/count (\\d+)/)||[])[1]`));
fs.writeFileSync(comp, orig);
ws.close(); chrome.kill(); process.exit(0);
