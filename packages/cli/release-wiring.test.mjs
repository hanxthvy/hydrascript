// [xihanzu-NR]
/**
 * The root manifest must NAME the per-platform packages before it is published.
 *
 * Every release up to 0.12.1 shipped `optionalDependencies: {}` in the published
 * `hydrascript` package. `bin/hydra.js` resolves `@hydrascript/<triple>` from
 * that field, so an empty one means npm installs the package everywhere and the
 * first command dies on every machine that is not Linux x86-64 — with a message
 * that names neither the platform nor the fix. The field existed in the repo and
 * was never in the tarball.
 *
 * This is a static check of the RELEASE WORKFLOW, not of the code: the wiring is
 * what breaks, and it breaks in YAML.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
];

test('release.yml fills optionalDependencies before publishing the root', () => {
  const wf = read('.github/workflows/release.yml');
  const wireAt = wf.indexOf('optionalDependencies = Object.fromEntries');
  assert.ok(wireAt > -1, 'release.yml does not wire optionalDependencies at all');
  const publishAt = wf.indexOf('npm publish --provenance');
  assert.ok(publishAt > -1, 'release.yml does not publish');
  assert.ok(
    wireAt < publishAt,
    'the manifest is published before it is wired — that is the 0.12.1 bug',
  );
});

test('every platform the launcher can ask for is wired', () => {
  const wf = read('.github/workflows/release.yml');
  for (const p of PLATFORMS) {
    assert.ok(wf.includes(`"${p}"`), `release.yml does not wire @hydrascript/${p}`);
  }
  // And the launcher must ask for exactly those names, or the wiring is for
  // packages nothing looks up.
  const launcher = read('bin/hydra.js');
  assert.match(launcher, /@hydrascript\/\$\{triple\}/);
});

test('release refuses to publish when a wired package is missing', () => {
  const wf = read('.github/workflows/release.yml');
  // The guard: a platform package that is not on npm at this version must stop
  // the release, because the alternative is a manifest pointing at nothing.
  assert.match(wf, /absent\.length/, 'release.yml has no "platform package missing" guard');
  assert.match(wf, /Run the `binaries` workflow/, 'the guard does not say what to do about it');
});

test('binaries.yml does not wire the root manifest', () => {
  const wf = read('.github/workflows/binaries.yml');
  // Two workflows writing the same field is how they drift. The platform
  // workflow builds and publishes the platform packages; the root manifest is
  // release.yml's job.
  assert.ok(
    !wf.includes('optionalDependencies = Object.fromEntries'),
    'binaries.yml wires the root manifest too; only release.yml may',
  );
});
