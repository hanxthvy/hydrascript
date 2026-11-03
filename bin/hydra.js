#!/usr/bin/env node
// [xihanzu-NR]

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const cmd = args[0];

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

if (isMetaCommand) {
  const runnerPath = path.join(ROOT, 'packages/cli/runner.mjs');
  if (fs.existsSync(runnerPath)) {
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
  // For compiler/CLI commands (run, check, repl, init, watch, or standalone):
  const nativeBin = path.join(HERE, 'hydra');
  if (fs.existsSync(nativeBin)) {
    const child = spawn(nativeBin, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('exit', (code) => process.exit(code || 0));
  } else {
    console.error('[hydra] Native binary not found at', nativeBin);
    process.exit(1);
  }
}
