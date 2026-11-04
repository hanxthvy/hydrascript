// [xihanzu-NR]
/**
 * The Node-API import check must not lie in EITHER direction.
 *
 * The check exists because `napi_*` imports in the CLI binary broke every macOS
 * and Windows build with `Undefined symbols: _napi_create_function`. It has to
 * fail when the CLI really imports them, and it has to PASS when the binary
 * merely DEFINES them — which the addon legitimately does, and which the first
 * version of this check (`nm -D | grep -q ' napi_'`) called a violation because
 * it matched the name anywhere on the line.
 *
 * Both directions are tested here: the parser on fixtures (no compiler needed),
 * and the real binary when one is present, because a fixture cannot catch "the
 * script is fine but the workflow calls it wrong".
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
const SCRIPT = path.join(REPO, 'scripts', 'check-no-napi-imports.mjs');

const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60000 });

// The parser is imported rather than re-implemented: a test that restates the
// logic passes when the logic is wrong.
const { undefinedNapiSymbols } = await import(SCRIPT);

test('a binary that DEFINES napi symbols is not a violation', () => {
  // The addon exports `napi_register_module_v1` itself; that is the entire point
  // of an addon and must never fail this check.
  const nm = [
    '0000000000012340 T napi_register_module_v1',
    '0000000000012350 T napi_create_function',
    '0000000000012360 t napi_create_object',
    '                 U memcpy@GLIBC_2.14',
  ].join('\n');
  assert.deepEqual(undefinedNapiSymbols(nm), []);
});

test('an UNDEFINED napi symbol IS a violation', () => {
  const nm = [
    '                 U napi_create_function',
    '                 U napi_create_object',
    '0000000000012340 T napi_register_module_v1',
  ].join('\n');
  assert.deepEqual(undefinedNapiSymbols(nm), ['napi_create_function', 'napi_create_object']);
});

test('the macOS underscore spelling is detected too', () => {
  // darwin symbols carry a leading underscore, and that is the platform whose
  // linker refused the build — the check is worthless if it only matches the
  // Linux spelling.
  const nm = ['                 U _napi_create_function', '                 U _napi_get_cb_info'].join('\n');
  assert.deepEqual(undefinedNapiSymbols(nm), ['_napi_create_function', '_napi_get_cb_info']);
});

test('undefined symbols that are not napi are ignored', () => {
  const nm = ['                 U printf@GLIBC_2.2.5', '                 U malloc@GLIBC_2.2.5'].join('\n');
  assert.deepEqual(undefinedNapiSymbols(nm), []);
});

test('a defined symbol printed without an address is still read as defined', () => {
  // `nm` prints a blank address for undefined symbols, so splitting on
  // whitespace and reading field 2 is not reliable; the type is the first
  // single-character token. Getting this wrong turns a definition into a
  // violation.
  const nm = ['T napi_create_function', 'U napi_get_cb_info'].join('\n');
  assert.deepEqual(undefinedNapiSymbols(nm), ['napi_get_cb_info']);
});

test('the selftest the workflow can call passes on its own', () => {
  const res = run(['--selftest']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /all selftest cases passed/);
});

test('a missing binary exits 2, not 0', () => {
  // "Could not inspect" is not "clean". A check that passes when the tool is
  // absent is the check that misses the regression it exists for.
  const res = run([path.join(os.tmpdir(), 'definitely-not-a-binary-xyz')]);
  assert.equal(res.status, 2, `expected 2, got ${res.status}: ${res.stdout}${res.stderr}`);
});

test('the real CLI binary has no napi imports', { skip: !fs.existsSync(path.join(REPO, 'bin', 'hydra')) }, () => {
  const res = run([path.join(REPO, 'bin', 'hydra')]);
  assert.equal(res.status, 0, `the CLI binary imports napi symbols: ${res.stdout}${res.stderr}`);
});

test('the real addon DOES import napi, which proves the check is not vacuous', {
  skip: !fs.existsSync(path.join(REPO, 'bin', 'hydra.node')),
}, () => {
  // Without this, a check that always returns 0 would pass every test above.
  const res = run([path.join(REPO, 'bin', 'hydra.node')]);
  assert.equal(
    res.status,
    1,
    `the addon must be reported as importing napi (that is what an addon does): ${res.stdout}${res.stderr}`,
  );
  assert.match(res.stdout + res.stderr, /napi_create_function/);
});
