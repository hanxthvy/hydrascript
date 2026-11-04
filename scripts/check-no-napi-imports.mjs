#!/usr/bin/env node
// [xihanzu-NR]
/**
 * Fail if the CLI binary IMPORTS a Node-API symbol.
 *
 * Why this check exists: `src/napi.rs` declares `extern "C"` imports of
 * `napi_*`. Linux tolerates them undefined in a cdylib, macOS and Windows refuse
 * to link at all — which is why every darwin and win32 job died with
 * `Undefined symbols: _napi_create_function` before the binding moved behind a
 * `node-addon` feature. The CLI must never carry those imports again, and the
 * check has to fail the build that introduces them rather than a platform job
 * three weeks later.
 *
 * Why it is a script and not a `grep` in the workflow: the first version was
 *
 *     nm -D bin/hydra | grep -q ' napi_'
 *
 * which matches ANY line mentioning the name — including a DEFINED symbol, and
 * including the `napi_register_module_v1` the addon legitimately exports. A
 * binary could define every napi function itself and the check would call it a
 * violation, which is a false positive that blocks a release for no reason.
 *
 * The distinction that matters is the SYMBOL TYPE, not the name:
 *
 *   U  undefined — resolved by whoever loads us. This is the import, and on
 *      macOS/Windows it is the thing that cannot link. VIOLATION.
 *   T/t/W/w/D/B/R/V  defined in this binary. Legitimate, and for the addon's own
 *      `napi_register_module_v1` it is the entire point. NOT a violation.
 *
 * Usage:
 *   node scripts/check-no-napi-imports.mjs <binary> [--nm <path>]
 *   node scripts/check-no-napi-imports.mjs --selftest
 *
 * Exit codes: 0 clean, 1 violation found, 2 could not inspect the binary.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Parse `nm -D` output into the undefined symbols that look like Node-API.
 *
 * `nm -D` lines are `<address> <type> <name>`, except for undefined symbols
 * where the address is BLANK and the line is ` <type> <name>` — so splitting on
 * whitespace is not enough and the type is not always field 2. This reads the
 * type as "the first single-character token", which is stable across the
 * GNU/LLVM spellings, and treats a missing address correctly.
 */
export function undefinedNapiSymbols(nmOutput) {
  const out = [];
  for (const raw of String(nmOutput).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // A symbol name is the LAST token; `nm` never emits trailing columns.
    const parts = line.split(/\s+/);
    const name = parts[parts.length - 1];
    if (!/^_?napi_/.test(name)) continue;
    // The type is the single-character token before the name. With an address
    // present it is parts[1]; without one it is parts[0].
    const type = parts.length >= 3 ? parts[1] : parts[0];
    if (type === 'U') out.push(name);
  }
  return out.sort();
}

function nm(binary, nmPath) {
  // `-D` is the dynamic table, which is where an import appears. Fall back to a
  // plain `-u` (undefined only) when the platform's nm has no `-D`, so the check
  // still runs on an LLVM nm that spells it differently.
  const tries = [
    [nmPath, ['-D', binary]],
    [nmPath, ['-u', binary]],
  ];
  let lastErr = null;
  for (const [cmd, args] of tries) {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      lastErr = err;
    }
  }
  return { error: lastErr };
}

function check(binary, nmPath) {
  if (!fs.existsSync(binary)) {
    console.error(`check-no-napi-imports: no such binary: ${binary}`);
    return 2;
  }
  const res = nm(binary, nmPath);
  if (res && res.error) {
    // Could not inspect is NOT the same as clean. A check that passes because
    // the tool is missing is the check that misses the regression.
    console.error(
      `check-no-napi-imports: could not run nm on ${binary}: ${res.error.message.split('\n')[0]}`,
    );
    return 2;
  }
  const bad = undefinedNapiSymbols(res);
  if (bad.length) {
    console.error(`check-no-napi-imports: ${binary} imports Node-API symbols:`);
    for (const s of bad) console.error(`  U ${s}`);
    console.error('');
    console.error('  The CLI must not import these. They belong only in the addon');
    console.error('  (`bin/hydra.node`), which is built with `--features node-addon`');
    console.error('  as a cdylib. If the CLI is importing them, `napi.rs` leaked out');
    console.error('  of its `#[cfg(feature = "node-addon")]`.');
    return 1;
  }
  console.log(`check-no-napi-imports: ${binary} imports no Node-API symbols`);
  return 0;
}

/** Fixtures so the parser is tested on both outcomes without needing a compiler. */
const FIXTURES = {
  'defined-only': [
    '0000000000012340 T napi_register_module_v1',
    '0000000000012350 T napi_create_function',
    '0000000000012360 t napi_create_object',
    '                 U memcpy@GLIBC_2.14',
    '0000000000012370 T hydra_compile',
  ].join('\n'),
  'undefined-import': [
    '                 U napi_create_function',
    '                 U napi_create_object',
    '0000000000012340 T napi_register_module_v1',
  ].join('\n'),
  'undefined-underscored': [
    '                 U _napi_create_function',
    '                 U _napi_get_cb_info',
  ].join('\n'),
  'unrelated-undefined': [
    '                 U printf@GLIBC_2.2.5',
    '                 U malloc@GLIBC_2.2.5',
  ].join('\n'),
  'no-address-defined': [
    // Some LLVM nm builds print defined symbols without an address when the
    // binary is stripped a particular way; the type must still be read right.
    'T napi_create_function',
  ].join('\n'),
};

/** Only act when this file IS the program; importing it exports the parser. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (!invokedDirectly) {
  // imported as a library: `undefinedNapiSymbols` only
} else if (process.argv.includes('--selftest')) {
  const cases = [
    ['defined-only', 0],
    ['undefined-import', 2],
    ['undefined-underscored', 2],
    ['unrelated-undefined', 0],
    ['no-address-defined', 0],
  ];
  let failed = 0;
  for (const [name, want] of cases) {
    const got = undefinedNapiSymbols(FIXTURES[name]).length;
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${got} undefined napi symbol(s), expected ${want}`);
  }
  if (failed) {
    console.error(`\n${failed} selftest case(s) failed`);
    process.exit(1);
  }
  console.log('\nall selftest cases passed');
  process.exit(0);
} else {
  const args = process.argv.slice(2);
  const nmAt = args.indexOf('--nm');
  const nmPath = nmAt > -1 ? args[nmAt + 1] : 'nm';
  const binary = args.find((a, i) => !a.startsWith('--') && (nmAt === -1 || i !== nmAt + 1));

  if (!binary) {
    console.error('usage: check-no-napi-imports.mjs <binary> [--nm <path>] | --selftest');
    process.exit(2);
  }
  process.exit(check(binary, nmPath));
}
