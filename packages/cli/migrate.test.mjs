// [xihanzu-NR]
/**
 * `hydra migrate` — the codemod registry and its command.
 *
 * The registry is empty on purpose, and this test is what keeps the CONTRACT
 * alive while it is: a version step compares `major.minor`, patch releases never
 * carry a codemod, and running the command with nothing registered says so and
 * exits 0 instead of looking broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { migrationsFor, describeMigrations, MIGRATIONS } = await import('./migrations.mjs');
const { runMigrate } = await import('./runner.mjs');

test('the registry is a list, and every entry has the documented shape', () => {
  assert.ok(Array.isArray(MIGRATIONS));
  for (const m of MIGRATIONS) {
    assert.equal(typeof m.from, 'string');
    assert.equal(typeof m.to, 'string');
    assert.equal(typeof m.describe, 'string');
    assert.ok(m.file instanceof RegExp, 'a codemod must say which files it touches');
    assert.equal(typeof m.apply, 'function');
  }
});

test('a version step compares major.minor, so a patch number is not a step', () => {
  assert.deepEqual(migrationsFor('0.15.3', '0.16.0'), []);
  assert.deepEqual(migrationsFor('0.15', '0.16'), []);
  // The comparison itself: two spellings of one step must select the same set.
  const a = migrationsFor('0.15.9', '0.16.1');
  const b = migrationsFor('0.15', '0.16');
  assert.deepEqual(a, b);
});

test('--list prints nothing when the registry is empty, and does not throw', () => {
  assert.deepEqual(describeMigrations(), []);
});

test('migrate with no versions is a usage error, not a silent no-op', async () => {
  const code = await runMigrate(process.cwd(), {});
  assert.equal(code, 2);
});

test('migrate with nothing registered exits 0 and touches no files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-migrate-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const file = path.join(dir, 'src', 'App.hyx');
  const source = 'component App():\n    div: "hi"\n';
  fs.writeFileSync(file, source, 'utf8');
  const code = await runMigrate(dir, { from: '0.15', to: '0.16' });
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), source, 'an empty registry must not rewrite anything');
});
