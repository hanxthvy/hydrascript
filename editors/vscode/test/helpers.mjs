// [xihanzu-NR]
/**
 * Shared plumbing for the extension's tests.
 *
 * There is no VS Code in here on purpose: the compiler IS the language server,
 * so an integration test can spawn it directly and assert on the protocol. The
 * editor-side mapping is checked separately, against a mock, by
 * `activation.test.mjs`.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

/** `editors/vscode/test` -> the repository root. */
export const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

const { compilerInvocation } = require('../src/cli.js');

/**
 * How to run this checkout's CLI.
 *
 * `bin/hydra.js` first: it is the runner, and `lsp` lives there. The native
 * `bin/hydra` only answers the Rust-owned commands, which is exactly the
 * distinction that broke a first draft of the extension.
 */
export function repoCompiler() {
  const script = path.join(REPO, 'bin', 'hydra.js');
  if (!fs.existsSync(script)) {
    throw new Error(`no bin/hydra.js in ${REPO}; build the compiler first (\`npm run build:compiler\`)`);
  }
  return { bin: script, invocation: compilerInvocation(script) };
}

export function tempDir(prefix = 'hydra-ext-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run the CLI and return its merged output, without throwing on a non-zero
 *  exit: `check` exits 1 when it finds something, which is a result. */
export function runCli(args, options = {}) {
  const { invocation } = repoCompiler();
  const result = spawnSync(invocation.command, [...invocation.args, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || REPO,
    input: options.input,
    env: { ...process.env, ...invocation.env },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
