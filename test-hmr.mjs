
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const port = 5299;
const child = spawn('node', ['/root/projects/hydra/packages/cli/runner.mjs', 'dev', '--port', String(port)], {
  cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

// wait for the server line
for (let i = 0; i < 100; i++) {
  if (/Server running at/.test(out)) break;
  await new Promise((r) => setTimeout(r, 200));
}
console.log('dev server up:', /Server running at/.test(out));

// 1. is the HMR client in the served HTML?
const res = await fetch(`http://127.0.0.1:${port}/`);
const html = await res.text();
console.log('hmr client injected:', html.includes('__hydra/hmr'));

// 2. does the socket accept a connection and deliver a rebuild message?
const ws = new WebSocket(`ws://127.0.0.1:${port}/__hydra/hmr`);
const messages = [];
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('ws failed')), { once: true });
  setTimeout(() => reject(new Error('ws open timeout')), 5000);
});
ws.addEventListener('message', (ev) => messages.push(JSON.parse(ev.data)));

// touch a source file to trigger a rebuild
await new Promise((r) => setTimeout(r, 500));
fs.appendFileSync(path.join(dir, 'src/pages/index.hyx'), '\n# touch\n');

for (let i = 0; i < 80; i++) {
  if (messages.length > 0) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log('messages after edit:', JSON.stringify(messages));

// 3. a broken edit must send an error, not reload
out = '';
fs.writeFileSync(path.join(dir, 'src/pages/notes.hyx'), 'component Notes(\n');
messages.length = 0;
for (let i = 0; i < 80; i++) {
  if (messages.length > 0) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log('messages after broken edit:', JSON.stringify(messages).slice(0, 200));

child.kill('SIGKILL');
process.exit(0);
