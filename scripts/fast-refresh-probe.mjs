// [xihanzu-NR]
/**
 * Fast Refresh, measured rather than claimed.
 *
 * The claim is narrow and checkable: an EDIT to a component does not reset the
 * state of the mounted tree. So this drives a real browser against `hydra dev`:
 *
 *   1. load the page, click the counter to 3
 *   2. write a visible change into the component's source
 *   3. wait for the dev server to rebuild
 *   4. read the counter again — 3 means state survived, 0 means the page reloaded
 *
 * A pass here is the only evidence that the boundary works; the emitted JS alone
 * proves nothing, because the whole question is what React does at runtime.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.argv[2] || '/tmp/fr/app';
const PORT = Number(process.argv[3] || 4455);
const COMPONENT = path.join(APP, 'src/components/Counter.hyx');
const ORIGINAL = fs.readFileSync(COMPONENT, 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9350',
  '--user-data-dir=/tmp/cdp-fr-' + process.pid, 'about:blank',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 50; i++) {
  try {
    targets = await (await fetch('http://127.0.0.1:9350/json')).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch {}
  await sleep(200);
}
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
// Wait for the load event rather than a fixed sleep: the dev bundle is ~440 KB
// and a fixed wait measured the page mid-hydration, which reads as "blank".
const loaded = new Promise((resolve) => {
  const timer = setTimeout(resolve, 20000);
  const check = setInterval(() => {
    if (events.some((e) => e.method === 'Page.loadEventFired')) {
      clearInterval(check);
      clearTimeout(timer);
      resolve();
    }
  }, 100);
});
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await loaded;
await sleep(2500);

const initial = await evalJs(`document.body.innerText.replace(/\\s+/g,' ').slice(0,200)`);
console.log('initial page:', initial);

// Click "tambah" three times.
for (let i = 0; i < 3; i++) {
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('tambah'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(350);
}
const beforeEdit = await evalJs(`(document.body.innerText.match(/count (\\d+)/) || [])[1]`);
console.log('count before edit:', beforeEdit);
if (beforeEdit !== '3') {
  console.log('RESULT: FAIL — could not reach 3 before editing');
  fs.writeFileSync(COMPONENT, ORIGINAL);
  ws.close(); chrome.kill(); process.exit(1);
}

// Detect a full page reload: a reload replaces the window object, so a token
// planted on it disappears. Without this the probe cannot tell "state survived"
// from "the page reloaded so fast the counter looked reset".
await evalJs(`window.__probe_token = 'alive'`);

// A real edit: change the label text, which the compiler re-emits.
fs.writeFileSync(COMPONENT, ORIGINAL.replace('"tambah"', '"tambah (edited)"'));
// Wait for a rebuild that has SETTLED: the watcher debounces, then rebuilds, then
// writes. Reading too early measured the previous bundle and looked like a stale one.
let finalHash = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  const dir = path.join(APP, 'dist/assets');
  const js = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')) : [];
  if (js.length && js[0] !== finalHash) finalHash = js[0];
  if (finalHash && fs.readFileSync(path.join(dir, finalHash), 'utf8').includes('(edited)')) break;
}

const tokenAlive = await evalJs(`window.__probe_token === 'alive'`);
console.log('page kept its window (no full reload):', tokenAlive);
const afterEdit = await evalJs(`(document.body.innerText.match(/count (\\d+)/) || [])[1]`);
const label = await evalJs(`[...document.querySelectorAll('button')].map(b => b.textContent).join('|')`);
console.log('count after edit:', afterEdit);
console.log('button label after edit:', label);

const survived = afterEdit === '3';
const labelUpdated = String(label).includes('edited');
console.log(`\nRESULT: ${survived && labelUpdated ? 'PASS' : 'FAIL'} — state ${survived ? 'preserved' : 'RESET'}, label ${labelUpdated ? 'updated' : 'stale'}`);

fs.writeFileSync(COMPONENT, ORIGINAL);
ws.close();
chrome.kill();
process.exit(survived && labelUpdated ? 0 : 1);
