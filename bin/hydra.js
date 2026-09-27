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

const isMetaCommand = cmd === 'dev' || cmd === 'build' || cmd === 'preview';

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
