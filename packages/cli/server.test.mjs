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
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
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

test('/__hydra/version does not leak the project layout by default', async () => {
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
    // A health check needs "up", nothing else. The server binds every interface
    // unless told otherwise, so absolute paths here answered any host on the
    // network with a map of the developer's disk.
    assert.equal(info.status, 'ok');
    assert.ok(typeof info.uptime_s === 'number');
    assert.equal(info.root, undefined);
    assert.equal(info.config, undefined);
    assert.equal(info.version, undefined);
    assert.ok(!res.body.includes('/tmp'), 'response leaked an absolute path');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('/__hydra/version reports details only when explicitly asked', async () => {
  const dir = makeDir();
  const { server, port } = await serveDirectory(dir, 5322, '127.0.0.1', {
    version: '9.9.9-test',
    sha: 'deadbee',
    metadata: true,
  });
  try {
    const info = JSON.parse((await get(port, '/__hydra/version')).body);
    assert.equal(info.version, '9.9.9-test');
    assert.equal(info.sha, 'deadbee');
    assert.equal(info.port, port);
    assert.equal(info.host, '127.0.0.1');
    // Even opted in, the filesystem layout stays out.
    assert.equal(info.root, undefined);
    assert.equal(info.config, undefined);
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

test('every answer carries the conservative security headers', async () => {
  const dir = makeDir();
  const { server, port } = await serveDirectory(dir, 5351, '127.0.0.1', { version: '0.3.0' });
  try {
    for (const urlPath of ['/', '/__hydra/version']) {
      const res = await get(port, urlPath);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', `${urlPath} is sniffable`);
      assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN', `${urlPath} is framable`);
      // A policy that names a feature accurately; the empty allow-list is the
      // point, not an accident of formatting.
      assert.match(res.headers['permissions-policy'], /camera=\(\)/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HSTS is opt-in, and off on a plain-HTTP server', async () => {
  const dir = makeDir();
  const { server, port } = await serveDirectory(dir, 5352, '127.0.0.1', { version: '0.3.0' });
  try {
    // Off by default: pinning `localhost` to https in the operator's own browser
    // is not something a dev server gets to do on its behalf.
    const res = await get(port, '/');
    assert.equal(res.headers['strict-transport-security'], undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  process.env.HYDRA_HTTPS = '1';
  const dir2 = makeDir();
  const second = await serveDirectory(dir2, 5353, '127.0.0.1', { version: '0.3.0' });
  try {
    const res = await get(second.port, '/');
    assert.match(res.headers['strict-transport-security'] || '', /max-age=\d+/);
  } finally {
    delete process.env.HYDRA_HTTPS;
    await new Promise((resolve) => second.server.close(resolve));
  }
});

test('rate limiting blocks requests exceeding max with 429 and Retry-After', async () => {
  const dir = makeDir();
  const { server, port } = await serveDirectory(dir, 5354, '127.0.0.1', {
    version: '0.3.0',
    rateLimit: { windowMs: 10000, max: 3 },
  });
  try {
    const res1 = await get(port, '/');
    const res2 = await get(port, '/');
    const res3 = await get(port, '/');
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    assert.equal(res3.status, 200);

    const res4 = await get(port, '/');
    assert.equal(res4.status, 429);
    assert.equal(res4.body, 'Too Many Requests');
    assert.ok(Number(res4.headers['retry-after']) >= 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rate limiting separates buckets by client IP', async () => {
  const dir = makeDir();
  const { server, port } = await serveDirectory(dir, 5355, '127.0.0.1', {
    version: '0.3.0',
    rateLimit: { windowMs: 10000, max: 2 },
  });

  function getWithIp(urlPath, ip) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          headers: { 'X-Forwarded-For': ip },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
    });
  }

  try {
    // IP 1 uses all its quota
    assert.equal((await getWithIp('/', '10.0.0.1')).status, 200);
    assert.equal((await getWithIp('/', '10.0.0.1')).status, 200);
    assert.equal((await getWithIp('/', '10.0.0.1')).status, 429);

    // IP 2 still has full quota
    assert.equal((await getWithIp('/', '10.0.0.2')).status, 200);
    assert.equal((await getWithIp('/', '10.0.0.2')).status, 200);
    assert.equal((await getWithIp('/', '10.0.0.2')).status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
