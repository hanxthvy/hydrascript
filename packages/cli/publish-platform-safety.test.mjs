// [xihanzu-NR]
/**
 * The bootstrap publisher must be safe to run twice.
 *
 * A first publish that fails on package 4 of 7 leaves three on the registry and
 * four missing. Re-running it is the ONLY recovery — npm versions are immutable,
 * so there is nothing to undo — and the dangerous version of this script reports
 * those three as failures, which reads as "the bootstrap is broken" when it is
 * actually finished. These tests pin the behaviour: already-published is a skip,
 * never a re-publish, and the root package is never a target.
 *
 * The registry is stubbed. These must not touch npmjs.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SCRIPT = path.join(REPO, 'scripts', 'publish-platform-packages.mjs');

/** A fake registry: `npm view <name>@<version> version` answers from a file. */
function stubRegistry(state) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'npmstub-'));
  const npmPath = path.join(bin, 'npm');
  fs.writeFileSync(
    npmPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const state = ${JSON.stringify(state)};`,
      'const a = process.argv.slice(2);',
      'if (a[0] === "view") {',
      '  const spec = a[1];',
      '  const [name, version] = spec.includes("@", 1) ? [spec.slice(0, spec.lastIndexOf("@")), spec.slice(spec.lastIndexOf("@") + 1)] : [spec, null];',
      '  const have = state[name];',
      '  if (!have) { console.error("npm error code E404"); process.exit(1); }',
      '  if (version && have !== version) { console.error("npm error code E404"); process.exit(1); }',
      '  console.log(have);',
      '  process.exit(0);',
      '}',
      'if (a[0] === "publish") {',
      '  // Record the attempt so a test can assert nothing was re-published.',
      "  fs.appendFileSync(process.env.PUBLISH_LOG || '/dev/null', process.cwd() + '\\n');",
      '  process.exit(0);',
      '}',
      'process.exit(1);',
    ].join('\n'),
  );
  fs.chmodSync(npmPath, 0o755);
  return bin;
}

/** A minimal artifact tree for the targets named. */
function artifacts(targets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  for (const t of targets) {
    fs.mkdirSync(path.join(dir, t, 'bin'), { recursive: true });
    // The arch check reads the binary header, so each target needs a real binary
    // of ITS OWN arch. /tmp/plat holds one of each from a CI run; fall back to
    // the host binary only for targets whose arch cannot be faked.
    const real =
      t.startsWith('linux-arm64') || t.startsWith('darwin-arm64')
        ? path.join('/tmp/plat', t, 'bin', 'hydra')
        : path.join(REPO, 'bin', 'hydra');
    if (!fs.existsSync(real)) {
      // No cross-arch fixture on this machine: skip rather than publish-test a
      // wrong-arch binary, which the script correctly refuses.
      throw new Error(`fixture missing for ${t}: ${real}`);
    }
    fs.copyFileSync(real, path.join(dir, t, 'bin', 'hydra'));
    fs.chmodSync(path.join(dir, t, 'bin', 'hydra'), 0o755);
    // The addon is optional (musl has none), so give the fixtures one where the
    // real artifacts have it: a missing addon is a warning, and this test is
    // about publish decisions, not about warnings.
    const addon = path.join('/tmp/plat', t, 'bin', 'hydra.node');
    if (fs.existsSync(addon)) fs.copyFileSync(addon, path.join(dir, t, 'bin', 'hydra.node'));
  }
  return dir;
}

const run = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...env },
  });

test('a version already on the registry is SKIPPED, not re-published', () => {
  // linux-x64 is already at this version; linux-arm64 is not. A re-run must send
  // only the second.
  const dir = artifacts(['linux-x64', 'linux-arm64']);
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'log-')), 'publish.log');
  const stub = stubRegistry({ '@hydrascript/linux-x64': '0.13.1' });
  const res = run(['--dir', dir, '--only', 'linux-x64,linux-arm64'], {
    PATH: `${stub}:${process.env.PATH}`,
    PUBLISH_LOG: log,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /ALREADY 0\.13\.1\s+linux-x64/, res.stdout);
  assert.match(res.stdout, /SENT 0\.13\.1\s+linux-arm64/, res.stdout);
  const sent = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(sent.length, 1, 'exactly one publish attempt, for the missing package');
  assert.match(sent[0], /linux-arm64/);
});

test('the summary reports already-published and failed separately', () => {
  const dir = artifacts(['linux-x64', 'linux-arm64', 'linux-x64-musl']);
  const stub = stubRegistry({
    '@hydrascript/linux-x64': '0.13.1',
    '@hydrascript/linux-arm64': '0.13.1',
  });
  const res = run(['--dir', dir, '--only', 'linux-x64,linux-arm64'], {
    PATH: `${stub}:${process.env.PATH}`,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /already on registry: 2/);
  assert.match(res.stdout, /failed\s+: 0/);
});

test('a name taken by a DIFFERENT version fails instead of publishing', () => {
  // The name sold something already. Publishing a second artefact under it is a
  // decision, not a bootstrap, so the script stops and says what is there.
  const dir = artifacts(['linux-x64']);
  const stub = stubRegistry({ '@hydrascript/linux-x64': '9.9.9' });
  const res = run(['--dir', dir, '--only', 'linux-x64'], {
    PATH: `${stub}:${process.env.PATH}`,
  });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /name taken|exists at another version/);
});

test('the script never targets the root package', () => {
  // Read as data, not executed: the target list is what decides what can be
  // published, and the root name must not be reachable from it.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /const ROOT_PACKAGE = 'hydrascript'/);
  // The only place a package name is BUILT is from a target, and it is always
  // scoped — never the bare root name.
  assert.match(src, /const name = `@hydrascript\/\$\{target\}`/);
  assert.ok(!/const name = ROOT_PACKAGE/.test(src), 'the name must come from a target');
  const bare = [...src.matchAll(/name:\s*['"](hydrascript)['"]/g)];
  assert.equal(bare.length, 0, 'a bare root name appears as a package name');
  // And every name must start with the scope, so a target can never be the root.
  assert.match(src, /if \(name === ROOT_PACKAGE\)/);
});

test('--only with an unknown target fails instead of doing nothing', () => {
  const dir = artifacts(['linux-x64']);
  const res = run(['--dir', dir, '--audit', '--only', 'linux-amd64']);
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /unknown target/);
});
