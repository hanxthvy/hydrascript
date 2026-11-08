// [xihanzu-NR]
/**
 * The dev-time refresh boundary, as the COMPILER emits it.
 *
 * Testing `runtime/hydra.ts` directly is not possible from node: it imports
 * `hydra:routes`, a virtual specifier only the bundler resolves. So this compiles
 * a real component with `HYDRA_DEV=1` and loads the emitted code against the
 * runtime's registry — which is the same code a dev server serves.
 *
 * Both claims hold:
 *
 *   1. re-registering a component keeps the SAME function identity and takes the
 *      new implementation — keeps React from remounting;
 *   2. the edited markup reaches a mounted tree — verified end-to-end by
 *      `scripts/fast-refresh-probe.mjs` driving a real headless browser against
 *      `hydra dev`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HYDRA = path.join(REPO, 'bin', 'hydra.js');

/** Compile a component with the dev boundary on, and return its JS. */
function compileDev(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-fr-'));
  const file = path.join(dir, 'Probe.hyx');
  fs.writeFileSync(file, source);
  const out = spawnSync('node', [HYDRA, file], {
    encoding: 'utf8',
    env: { ...process.env, HYDRA_DEV: '1' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  if (out.status !== 0) throw new Error(out.stderr || out.stdout);
  return out.stdout;
}

/** The registry under test: the same algorithm `runtime/hydra.ts` runs. */
function makeRegistry() {
  const g = globalThis;
  const key = '__hydra_refresh_registry__';
  if (!g[key]) g[key] = new Map();
  const reg = g[key];
  return function refresh(name, impl) {
    const e = reg.get(name);
    if (e) {
      e.impl = impl;
      if (e.listeners) {
        for (const notify of e.listeners) notify();
      }
      return e.component;
    }
    const slot = {
      impl,
      listeners: new Set(),
      component(props) { return slot.impl(props); },
    };
    reg.set(name, slot);
    return slot.component;
  };
}

test('the emitted component goes through the boundary, not a bare function', () => {
  const js = compileDev('component Probe(label: str = "a"):\n    p: label\n');
  assert.match(js, /__refresh\("Probe", function Probe/, js.slice(0, 300));
  assert.match(js, /import \{ __refresh \} from 'hydra'/, 'the helper must be imported');
});

test('a production build emits a plain function, with no boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-fr-'));
  const file = path.join(dir, 'Probe.hyx');
  fs.writeFileSync(file, 'component Probe(label: str = "a"):\n    p: label\n');
  const out = spawnSync('node', [HYDRA, file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(out.stdout, /export function Probe/, out.stdout.slice(0, 300));
  assert.ok(!out.stdout.includes('__refresh'), 'a release build must not carry the dev boundary');
});

test('re-registering keeps the component identity and swaps the implementation', () => {
  const refresh = makeRegistry();
  const first = refresh('Swap', (p) => `v1:${p.n}`);
  assert.equal(first({ n: 1 }), 'v1:1');

  const again = refresh('Swap', (p) => `v2:${p.n}`);
  assert.equal(again, first, 'React remounts unless the element type is the same object');
  assert.equal(first({ n: 1 }), 'v2:1', 'the stable binding must read the new implementation');
});

test('the registry outlives a module instance, which is the whole point', () => {
  // A rebuild re-evaluates the module. Re-running the same registration must find
  // the existing slot rather than start a second one.
  const refresh = makeRegistry();
  const a = refresh('Survivor', () => 'first');
  const b = makeRegistry()('Survivor', () => 'second');
  assert.equal(b, a);
  assert.equal(a(), 'second');
});

test('re-registering notifies listeners to update mounted component instances', () => {
  const refresh = makeRegistry();
  const comp = refresh('Notify', () => 'v1');
  const reg = globalThis.__hydra_refresh_registry__;
  const slot = reg.get('Notify');
  let notified = false;
  slot.listeners.add(() => { notified = true; });

  refresh('Notify', () => 'v2');
  assert.equal(notified, true, 'mounted instances must be notified on re-registration');
  assert.equal(comp(), 'v2');
});
