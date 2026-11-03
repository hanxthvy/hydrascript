#!/usr/bin/env node
// [xihanzu-NR]
//
// The launcher a user's `npx hydra` actually runs.
//
// It used to assume exactly one binary shape: an ELF x86-64 file linked against
// glibc 2.34. On macOS, on Alpine, on an ARM VPS and on any distro older than
// Ubuntu 22.04, `npm i hydrascript` installed successfully and then every
// command died with a loader error that mentioned neither the platform nor the
// fix. `optionalDependencies` is how every serious Node toolchain solves this,
// and this file is the half that picks the right one.
//
// Resolution order, and each step is a real case:
//
//   1. `HYDRA_BINARY` — an absolute path. What a monorepo or a debug build sets.
//   2. `@hydrascript/<platform>-<arch>[-musl]` — the per-platform package the
//      release workflow publishes, installed as an optional dependency. npm
//      skips the ones for other platforms, so exactly one is present.
//   3. `bin/hydra` beside this file — a source checkout, or a tarball built for
//      this machine by `npm run build:compiler`.
//
// If none is found the message names the platform, the target that would have
// matched, and the two ways out. A dead binary with no explanation is the
// failure this file exists to replace.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const cmd = args[0];

/** The platform triple this npm package would be published under. */
function targetTriple() {
  const platform = process.platform;
  const arch = process.arch;
  const libc = (() => {
    if (platform !== 'linux') return '';
    // `process.report` is the only libc probe Node exposes without a child
    // process. A missing report (an old Node, a stripped build) assumes gnu,
    // which is the common case and the one whose failure message is clearer.
    try {
      const report = process.report && process.report.getReport();
      const glibc = report && report.header && report.header.glibcVersionRuntime;
      return glibc ? '' : '-musl';
    } catch {
      return '';
    }
  })();
  return `${platform}-${arch}${libc}`;
}

/**
 * The native binary to run, as `{ path, source }`, or null.
 *
 * `source` is only used in the failure message, so a person can tell a
 * configured path from a package install from a checkout.
 */
function resolveBinary() {
  const override = process.env.HYDRA_BINARY;
  if (override) {
    return fs.existsSync(override) ? { path: override, source: 'HYDRA_BINARY' } : null;
  }

  const triple = targetTriple();
  const candidates = [
    `@hydrascript/${triple}`,
    // linux-x64-musl and linux-x64-gnu are different packages; a fallback to
    // the gnu build on a musl system only produces a confusing loader error, so
    // there is deliberately no cross-libc fallback.
  ];
  for (const name of candidates) {
    try {
      const pkgJson = require.resolve(`${name}/package.json`);
      const dir = path.dirname(pkgJson);
      const bin = path.join(dir, process.platform === 'win32' ? 'hydra.exe' : 'hydra');
      if (fs.existsSync(bin)) return { path: bin, source: name };
    } catch {
      /* not installed for this platform: that is the normal case for the others */
    }
  }

  const bundled = path.join(HERE, 'hydra');
  if (fs.existsSync(bundled)) return { path: bundled, source: 'bundled' };

  const exe = path.join(HERE, 'hydra.exe');
  if (fs.existsSync(exe)) return { path: exe, source: 'bundled' };

  return null;
}

function failNoBinary() {
  const triple = targetTriple();
  console.error(`[hydra] no native compiler for this machine (${triple}).`);
  console.error('');
  console.error(`  expected either @hydrascript/${triple} in node_modules,`);
  console.error(`  or a binary at ${path.join(HERE, 'hydra')}.`);
  console.error('');
  console.error('  fixes:');
  console.error(`    npm i @hydrascript/${triple}          # the prebuilt one`);
  console.error('    npm run build:compiler              # from a source checkout (needs Rust)');
  console.error('  or point HYDRA_BINARY at one you already have.');
  process.exit(1);
}

// `run` is here because the native binary hands the compiled source to node,
// which cannot resolve the `hydra` specifier; the runner bundles it first.
const isMetaCommand =
  cmd === 'dev' ||
  cmd === 'build' ||
  cmd === 'preview' ||
  // `serve` and `start` are the deployment commands. Without them here the
  // native CLI treated the word as a source file and answered
  // "cannot read serve: No such file or directory" — for a command the README
  // documented.
  cmd === 'serve' ||
  cmd === 'start' ||
  cmd === 'routes' ||
  cmd === 'run' ||
  cmd === 'test' ||
  cmd === 'lsp';

const binary = resolveBinary();

if (isMetaCommand) {
  const runnerPath = path.join(ROOT, 'packages/cli/runner.mjs');
  if (fs.existsSync(runnerPath)) {
    // The runner needs to know where the compiler is: `hydra.node` is loaded
    // from beside whatever binary won, and a per-platform package keeps its
    // addon next to its own `hydra`.
    if (binary) process.env.HYDRA_COMPILER_DIR = path.dirname(binary.path);
    const child = spawn(process.execPath, [runnerPath, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('exit', (code) => process.exit(code || 0));
  } else {
    console.error('[hydra] Runner script not found at', runnerPath);
    process.exit(1);
  }
} else {
  if (!binary) failNoBinary();
  const child = spawn(binary.path, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, HYDRA_BINARY_SOURCE: binary.source },
  });
  child.on('exit', (code) => process.exit(code || 0));
}
