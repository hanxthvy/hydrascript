// [xihanzu-NR]
/**
 * The emitter invents runtime names (`py_fixed`, `max_of`, `py_mod`, ...) and
 * writes `import { name } from 'hydra'` for them. When the runtime does not
 * export one, the build is GREEN and the failure is a `ReferenceError` or an
 * esbuild "No matching export" the author cannot connect to their own line —
 * which is exactly how `py_fixed`, `int` and `float` shipped broken.
 *
 * The check is mechanical, so it must not be a manual review: walk the Rust
 * source for every name it can record in `used_helpers`, and assert each one is
 * exported by `runtime/hydra.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// BOTH halves: `hydra.ts` re-exports `core.ts` with `export *`, and an
// `export *` carries no names, so scanning only hydra.ts reported every helper
// that moved to core as missing (35 of them) while the build was green.
const RUNTIME = [path.join(ROOT, 'runtime', 'hydra.ts'), path.join(ROOT, 'runtime', 'core.ts')];
const RUST = ['emitter.rs', 'hx_target.rs', 'fstr.rs'].map((f) =>
  path.join(ROOT, 'compiler-rs', 'src', f),
);

/** Every name the runtime exports. */
function runtimeExports() {
  const out = new Set();
  for (const file of RUNTIME) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(
      /export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      out.add(m[1]);
    }
  }
  return out;
}

/**
 * Every name the emitter can record as a used helper.
 *
 * Three shapes exist in the source and all three matter: a literal
 * `insert("name")`, an `insert(id.clone())` where the id came from
 * `python_base_class`, and the `for helper in ["py_fixed", "py_group"]` loop the
 * f-string translator needs because it invents its calls.
 */
function emittableHelpers() {
  const out = new Set();
  for (const file of RUST) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(
      /used_helpers[^;\n]*?\binsert\(\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|([a-z_][A-Za-z0-9_]*))/g,
    )) {
      if (m[1]) out.add(m[1]);
    }
    for (const m of src.matchAll(/for\s+\w+\s+in\s+\[([^\]]+)\]/g)) {
      for (const s of m[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) out.add(s[1]);
    }
  }
  return out;
}

test('every helper the emitter can emit is exported by the runtime', () => {
  const exported = runtimeExports();
  const emitted = emittableHelpers();

  assert.ok(emitted.size > 20, `the scan found only ${emitted.size} helpers — it is not reading the source`);

  const missing = [...emitted].filter((n) => !exported.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `runtime/hydra.ts does not export: ${missing.join(', ')} — the build would be green and the module would throw`,
  );
});
