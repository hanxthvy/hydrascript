// [xihanzu-NR]
// `hydraconfig.json` validation and byte-size parsing (SEC-28, SEC-15).
//
// The behaviour this locks: a typo'd key or a wrong type used to build green on
// defaults, so the operator's first evidence of a mistake was a server on the
// wrong port — or none. `porrt`, `hostt` and `renderingg` all built at exit 0.
//
// Run: node --test packages/cli/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { validate, loadSchema, parseByteSize, readConfigFile } = await import('./config.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'runner.mjs');
const SCHEMA = loadSchema();

function errorsFor(config) {
  return validate(config, SCHEMA).map((e) => `${e.path}: ${e.message}`);
}

function tempProject(configText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-config-'));
  fs.writeFileSync(path.join(dir, 'hydraconfig.json'), configText);
  return dir;
}

test('an unknown key is refused with the intended one named', () => {
  // Suggestions are per level: `porrt` is one edit from `port` INSIDE `server`, and
  // the top level has no near neighbour — so the same typo gets a different, and in
  // both cases correct, sentence depending on where it is.
  assert.deepEqual(errorsFor({ server: { porrt: 5173, hostt: '0.0.0.0' } }), [
    'server.porrt: unknown key (did you mean "port"?)',
    'server.hostt: unknown key (did you mean "host"?)',
  ]);
  assert.deepEqual(errorsFor({ renderingg: {} }), [
    'renderingg: unknown key (did you mean "rendering"?)',
  ]);
  assert.deepEqual(errorsFor({ database: {} }), ['database: unknown key']);
});

test('a wrong type names the key and the type', () => {
  assert.deepEqual(errorsFor({ server: { port: 'x' } }), ['server.port: expected integer, got string']);
  assert.deepEqual(errorsFor({ rendering: { ssg: 'yes' } }), [
    'rendering.ssg: expected boolean, got string',
  ]);
});

test('a number is not an integer when the schema asks for one', () => {
  assert.deepEqual(errorsFor({ server: { port: 5173.5 } }), [
    'server.port: expected integer, got number',
  ]);
});

test('range and enum are enforced', () => {
  assert.match(errorsFor({ server: { port: 70000 } })[0], /must be <= 65535/);
  assert.match(errorsFor({ build: { target: 'edge' } })[0], /must be one of "node", "static"/);
});

test('the shapes `hydra init` writes all validate', () => {
  // The scaffold wrote `types`, `styling: {tailwind}` and `rendering.ssr`, and the
  // schema rejected all three — so the framework's own generated project failed
  // its own validation. This is that exact config.
  const scaffolded = {
    $schema: 'https://raw.githubusercontent.com/hanxthvy/hydrascript/main/schema.json',
    name: 'demo',
    version: '0.1.0',
    root: './src',
    outputDir: './dist',
    base: '/',
    entries: { app: './src/main.hyx' },
    server: { port: 5173, host: '127.0.0.1' },
    compiler: { target: 'react-19', strict: true },
    rendering: { ssg: true, ssr: true },
  };
  assert.deepEqual(errorsFor(scaffolded), []);
  assert.deepEqual(errorsFor({ ...scaffolded, styling: { tailwind: true } }), []);
  assert.deepEqual(errorsFor({ ...scaffolded, styling: ['autoprefixer'] }), []);
  assert.deepEqual(errorsFor({ ...scaffolded, types: { emit: true } }), []);
  assert.deepEqual(
    errorsFor({ ...scaffolded, rendering: { ssg: false, ssr: false, types: { emit: false } } }),
    ['rendering.types: unknown key'],
  );
});

test('every documented key at once is accepted', () => {
  const full = {
    name: 'x',
    version: '1.0.0',
    base: '/sub/',
    outputDir: './out',
    routes: { dir: './src/pages' },
    mode: 'production',
    tailwind: { theme: {} },
    server: {
      port: 8080,
      host: '0.0.0.0',
      proxy: { '/api': 'http://127.0.0.1:3000' },
      bodyLimit: 2097152,
      rateLimit: { windowMs: 60000, max: 120 },
      headers: { 'Content-Security-Policy': "default-src 'self'" },
      allowedOrigins: ['https://example.com'],
      trustProxy: '127.0.0.1',
    },
    compiler: { jsxInJs: true, target: 'react-19', strict: true },
    rendering: { ssg: true, ssr: true },
    build: { sourcemap: false, target: 'node', clean: true },
    root: './src',
    entries: { app: './src/main.hyx' },
    styling: ['autoprefixer'],
    ssr: true,
    types: { emit: true },
    tests: 'tests',
  };
  assert.deepEqual(errorsFor(full), []);
});

test('bodyLimit accepts bytes or a size string, and nothing else', () => {
  assert.deepEqual(errorsFor({ server: { bodyLimit: 1048576 } }), []);
  assert.deepEqual(errorsFor({ server: { bodyLimit: '10mb' } }), []);
  assert.match(errorsFor({ server: { bodyLimit: 'a lot' } })[0], /expected|format/);
  assert.equal(parseByteSize('10mb'), 10 * 1000 * 1000);
  assert.equal(parseByteSize('512kib'), 512 * 1024);
  assert.equal(parseByteSize(1048576), 1048576);
  assert.equal(parseByteSize('0'), null);
  assert.equal(parseByteSize(-1), null);
  assert.equal(parseByteSize(undefined), null);
});

test('a broken file reports line and column, not a byte offset', () => {
  const dir = tempProject('{\n  "name": "x",\n  "base": "/"\n  "port": 1\n}\n');
  const result = readConfigFile(dir);
  assert.ok(result.parseError, 'a malformed file must not be silently ignored');
  assert.match(result.parseError, /line 4, column 3/);
});

test('a missing file is legal, and a non-object is not', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-config-'));
  const missing = readConfigFile(empty);
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.errors, []);

  const arrayDir = tempProject('[]');
  const asArray = readConfigFile(arrayDir);
  assert.equal(asArray.errors.length, 1);
  assert.match(asArray.errors[0].message, /expected an object, got array/);
});

test('the CLI exits 2 on an invalid config instead of building on defaults', () => {
  for (const [text, expected] of [
    ['{"porrt": 1}', /porrt: unknown key/],
    ['{"server": {"port": "x"}}', /server\.port: expected integer/],
    ['{"name": "broken"', /is not valid JSON \(line/],
  ]) {
    const dir = tempProject(text);
    // readConfig() calls process.exit(2), so it has to run in a child: exiting
    // this process would end the test run.
    const out = spawnSync(process.execPath, [
      '-e',
      `import(${JSON.stringify(RUNNER)}).then((m) => { m.readConfig(${JSON.stringify(dir)}); console.log('NO_EXIT'); })`,
    ], { encoding: 'utf8' });
    assert.equal(out.status, 2, `expected exit 2 for ${text}, got ${out.status}: ${out.stderr}`);
    assert.match(out.stderr, expected);
    assert.ok(!out.stdout.includes('NO_EXIT'), 'the command must not continue on a bad config');
  }
});
