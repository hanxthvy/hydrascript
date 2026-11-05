// [xihanzu-NR]
/**
 * Authentication behaviour of the platform bootstrap.
 *
 * The first publish failed seven times with EOTP and never showed a prompt.
 * `npm publish` only asks for a code when `process.stdin.isTTY` is true, and the
 * script handed the child `/dev/null`, so npm threw instead of asking. These
 * tests pin the two things that must not regress:
 *
 *   1. the publish call inherits the real terminal (so npm can prompt), and
 *   2. a registry that cannot be queried is NEVER read as "not published" —
 *      that mistake writes a version twice or claims a name with the wrong
 *      build, and npm versions are immutable so there is nothing to undo.
 *
 * The registry is stubbed. These must not touch npmjs.com and must not publish.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeArtifacts } from './fixtures/fake-binary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SCRIPT = path.join(REPO, 'scripts', 'publish-platform-packages.mjs');
// The version under test is the repo's, not a literal: pinning it makes
// every bump fail these tests, and a real regression then hides among them.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

/**
 * A fake npm whose `view` answer is scripted per name, so "timeout", "401" and
 * "404" can each be produced deterministically.
 *
 * `behaviour` maps a package name to one of: 'absent' (E404), 'present:<ver>',
 * 'timeout' (sleeps past the client timeout), 'e401', 'eotp'.
 */
function stubNpm(behaviour) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmstub-'));
  const p = path.join(dir, 'npm');
  fs.writeFileSync(
    p,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const behaviour = ${JSON.stringify(behaviour)};`,
      'const a = process.argv.slice(2);',
      'const cmd = a[0];',
      // Record every invocation so a test can prove the OTP was forwarded and
      // that nothing was published twice. The OTP VALUE is recorded, never
      // printed, so the test can assert on it without leaking to the console.
      "const log = process.env.NPM_STUB_LOG;",
      "if (log) fs.appendFileSync(log, JSON.stringify({ cmd, argv: a }) + '\\n');",
      'if (cmd === "view") {',
      '  const spec = a[1];',
      '  const name = spec.startsWith("@") ? spec.slice(0, spec.lastIndexOf("@")) : spec.split("@")[0];',
      '  const b = behaviour[name] || "absent";',
      '  if (b === "timeout") { setTimeout(() => process.exit(0), 60000); return; }',
      '  if (b === "e401") { console.error("npm error code E401"); console.error("npm error 401 Unauthorized"); process.exit(1); }',
      '  if (b === "eotp") { console.error("npm error code EOTP"); console.error("npm error This operation requires a one-time password"); process.exit(1); }',
      '  if (b.startsWith("present:")) { console.log(b.slice(8)); process.exit(0); }',
      '  console.error("npm error code E404"); console.error("npm error 404 Not Found"); process.exit(1);',
      '}',
      'if (cmd === "publish") { process.exit(0); }',
      'process.exit(1);',
    ].join('\n'),
  );
  fs.chmodSync(p, 0o755);
  return dir;
}

// Fixtures, not /tmp/plat: a test that needs an artifact from one CI run on one
// machine fails on a clean checkout, which is exactly what CI is.
const artifacts = (targets) => makeArtifacts(targets);

function run(args, { stub, log } = {}) {
  const env = { ...process.env };
  if (stub) env.PATH = `${stub}:${env.PATH}`;
  if (log) env.NPM_STUB_LOG = log;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000, env });
}

const readLog = (p) =>
  fs.existsSync(p)
    ? fs
        .readFileSync(p, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

test('a registry that times out is NOT treated as "not published"', () => {
  const dir = artifacts(['linux-x64']);
  const stub = stubNpm({ '@hydrascript/linux-x64': 'timeout' });
  const res = run(['--dir', dir, '--only', 'linux-x64'], { stub });
  // Publishing blind on a timeout is how a version gets written twice.
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /cannot tell if it exists|not publishing blind/i);
});

test('an authentication failure is NOT treated as "not published"', () => {
  const dir = artifacts(['linux-x64']);
  const stub = stubNpm({ '@hydrascript/linux-x64': 'e401' });
  const res = run(['--dir', dir, '--only', 'linux-x64'], { stub });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /cannot tell if it exists|not publishing blind/i);
});

test('an EOTP from the registry query is NOT treated as "not published"', () => {
  const dir = artifacts(['linux-x64']);
  const stub = stubNpm({ '@hydrascript/linux-x64': 'eotp' });
  const res = run(['--dir', dir, '--only', 'linux-x64'], { stub });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /cannot tell if it exists|not publishing blind/i);
});

test('a real 404 still proceeds to publish', () => {
  const dir = artifacts(['linux-x64']);
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l-')), 'npm.log');
  const stub = stubNpm({});
  const res = run(['--dir', dir, '--only', 'linux-x64'], { stub, log });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const calls = readLog(log);
  assert.equal(calls.filter((c) => c.cmd === 'publish').length, 1, 'expected exactly one publish');
});

test('--otp is forwarded to both view and publish, and never printed', () => {
  const dir = artifacts(['linux-x64']);
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l-')), 'npm.log');
  const stub = stubNpm({});
  const OTP = '424242';
  const res = run(['--dir', dir, '--only', 'linux-x64', '--otp', OTP], { stub, log });
  assert.equal(res.status, 0, res.stdout + res.stderr);

  // The OTP VALUE must never appear in what the user sees. A mistyped code may be
  // a mistyped something-else, and stdout ends up in scrollback and CI logs.
  assert.ok(!res.stdout.includes(OTP), 'the OTP leaked to stdout');
  assert.ok(!res.stderr.includes(OTP), 'the OTP leaked to stderr');

  const calls = readLog(log);
  const view = calls.find((c) => c.cmd === 'view');
  const publish = calls.find((c) => c.cmd === 'publish');
  assert.ok(view, 'no npm view call');
  assert.ok(publish, 'no npm publish call');
  assert.ok(view.argv.some((a) => a.includes(OTP)), 'the OTP was not passed to npm view');
  assert.ok(publish.argv.some((a) => a.includes(OTP)), 'the OTP was not passed to npm publish');
});

test('an empty or malformed --otp is refused before any npm call', () => {
  const dir = artifacts(['linux-x64']);
  for (const bad of ['', '12ab', '12345', '1234567']) {
    const res = run(['--dir', dir, '--audit', '--only', 'linux-x64', '--otp', bad]);
    assert.equal(res.status, 2, `--otp ${JSON.stringify(bad)} should exit 2, got ${res.status}`);
    // And the message must not echo whatever the user typed.
    if (bad) assert.ok(!res.stderr.includes(bad), 'the rejected OTP value was echoed back');
  }
});

test('a partial retry publishes ONLY the missing packages', () => {
  // The scenario the first failed run left behind: none published. And the
  // scenario after a half-finished run: some published, the rest not.
  const dir = artifacts(['linux-x64', 'linux-arm64']);
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l-')), 'npm.log');
  const stub = stubNpm({ '@hydrascript/linux-x64': `present:${VERSION}` });
  const res = run(['--dir', dir, '--only', 'linux-x64,linux-arm64'], { stub, log });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, new RegExp(`ALREADY ${escapeRe(VERSION)}`));
  assert.match(res.stdout, new RegExp(`SENT ${escapeRe(VERSION)}\\s+linux-arm64`));
  const publishes = readLog(log).filter((c) => c.cmd === 'publish');
  assert.equal(publishes.length, 1, 'the already-published package must not be sent again');
});

test('the publish step is invoked so that npm can prompt: stdio inherit', () => {
  // A static check on the call site, because the behaviour cannot be observed
  // without a real TTY. `stdio: 'inherit'` is the ONLY configuration in which
  // npm's OTP prompt appears; pipes or 'ignore' make stdin non-TTY and npm
  // throws EOTP instead of asking.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /stdio: 'inherit'/);
  assert.ok(
    !/npm', \['publish'[^\]]*\], \{[\s\S]{0,120}stdio: \['ignore'/.test(src),
    'npm publish is back to a non-interactive stdio',
  );
});
