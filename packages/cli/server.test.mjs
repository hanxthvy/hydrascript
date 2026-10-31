// [xihanzu-NR]
// Regression tests for the dev/preview server behaviour in packages/cli/runner.mjs.
//
// These cover the fault that cost 12,485 pm2 restarts: `preview` bound a busy
// port, printed a message, stayed alive and served nothing, and the process
// manager restarted it forever. Two invariants matter and both are checked
// against a real server, not a mock:
//
//   1. preview must FAIL (reject) when its port is taken - a preview that cannot
//      serve is a failed preview, so a supervisor sees a real failure rather
//      than a corpse it keeps restarting.
//   2. dev must MOVE to the next port and keep serving - a taken port is normal
//      during development and the right answer is 5174, not a dead terminal.
//
// Run: node --test packages/cli/server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { serveDirectory } = await import('./runner.mjs');

/** Occupy a port for the duration of `fn`, then release it. */
async function withSquatter(port, fn) {
  const squatter = http.createServer(() => {});
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  try {
    return await fn();
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
}

/** Ask a served port what it is. */
function get(port, urlPath = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-serve-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><title>t</title></html>');
  return dir;
}

test('preview rejects when the port is taken (no silent corpse)', async () => {
  const dir = makeDir();
  await withSquatter(5301, async () => {
    await assert.rejects(
      () => serveDirectory(dir, 5301, '127.0.0.1', { version: '0.3.0' }),
      /EADDRINUSE/,
      'a preview that cannot bind must reject, not resolve',
    );
  });
});

test('dev walks to the next free port and serves there', async () => {
  const dir = makeDir();
  await withSquatter(5311, async () => {
    const { server, port } = await serveDirectory(dir, 5311, '127.0.0.1', {
      portFallback: true,
      version: '0.3.0',
    });
    try {
      assert.equal(port, 5312, 'the first busy port means try the next one');
      const res = await get(port);
      assert.equal(res.status, 200);
      assert.match(res.body, /<title>t<\/title>/);
    } finally {
      // A listening server keeps the event loop alive and `node --test` would
      // never exit: close every server a test opens.
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('/__hydra/version reports what is actually running', async () => {
  const dir = makeDir();
  const { server, port } = await serveDirectory(dir, 5321, '127.0.0.1', {
    version: '9.9.9-test',
    sha: 'deadbee',
    configPath: '/tmp/x/hydraconfig.json',
  });
  try {
    const res = await get(port, '/__hydra/version');
    assert.equal(res.status, 200);
    const info = JSON.parse(res.body);
    assert.equal(info.version, '9.9.9-test');
    assert.equal(info.sha, 'deadbee');
    assert.equal(info.port, port);
    assert.equal(info.host, '127.0.0.1');
    assert.equal(info.config, '/tmp/x/hydraconfig.json');
    assert.ok(typeof info.uptime_s === 'number');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a port fallback that runs out still rejects instead of hanging', async () => {
  const dir = makeDir();
  // Occupy 5331 so the walk starts one step late and exhausts its ten tries.
  const blockers = [];
  try {
    for (let p = 5331; p <= 5341; p += 1) {
      const s = http.createServer(() => {});
      await new Promise((resolve) => s.listen(p, '127.0.0.1', resolve));
      blockers.push(s);
    }
    await assert.rejects(
      () => serveDirectory(dir, 5331, '127.0.0.1', { portFallback: true, version: '0.3.0' }),
      /EADDRINUSE/,
    );
  } finally {
    for (const s of blockers) await new Promise((resolve) => s.close(resolve));
  }
});
