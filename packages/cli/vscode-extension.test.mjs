// [xihanzu-NR]
/**
 * The VS Code extension's diagnostic parsing, without VS Code.
 *
 * The extension used to regex the compiler's COLOURED stderr output, which
 * reported at most the first problem and broke whenever the wording changed.
 * It reads `hydra check --json` now, and this asserts the conversion — the part
 * that silently produces nothing when it is wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);

/** Minimal stand-ins, so the module under test can be required outside VS Code. */
class Range {
  constructor(a, b, c, d) {
    Object.assign(this, { startLine: a, startCol: b, endLine: c, endCol: d });
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    Object.assign(this, { range, message, severity });
  }
}
const DiagnosticSeverity = { Error: 0, Warning: 1 };

/**
 * Load the extension with a fake `vscode`.
 *
 * The module requires `vscode` at load time, so the fake goes into the require
 * cache before it is loaded. That is the only way to test an extension file
 * without installing an editor.
 */
function loadExtension() {
  const Module = require('node:module');
  const origResolve = Module._resolveFilename;
  const fake = { Range, Diagnostic, DiagnosticSeverity, languages: {}, workspace: {} };
  try {
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'vscode') return 'vscode';
      return origResolve.call(this, request, ...rest);
    };
    require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: fake };
    return require(path.join(REPO, 'editors', 'vscode', 'extension.js'));
  } finally {
    Module._resolveFilename = origResolve;
  }
}

test('every JSON line becomes a diagnostic, with 1-based converted to 0-based', () => {
  const ext = loadExtension();
  const text = [
    '{"file":"src/a.hyx","line":3,"col":11,"severity":"warning","message":"`x` is used but never bound"}',
    '{"file":"src/a.hyx","line":7,"col":1,"severity":"error","message":"unexpected token"}',
    'not json at all',
    '',
  ].join('\n');
  const diags = ext.parseDiagnostics(text, Range, Diagnostic, DiagnosticSeverity);
  assert.equal(diags.length, 2, 'both diagnostics, and the junk line ignored');
  assert.equal(diags[0].range.startLine, 2, 'line 3 becomes index 2');
  assert.equal(diags[0].range.startCol, 10, 'col 11 becomes index 10');
  assert.equal(diags[0].severity, DiagnosticSeverity.Warning);
  assert.equal(diags[0].source, 'hydra');
  assert.match(diags[0].message, /never bound/);
  assert.equal(diags[1].severity, DiagnosticSeverity.Error);
  assert.equal(diags[1].range.startLine, 6);
});

test('empty or junk output yields no diagnostics rather than a crash', () => {
  const ext = loadExtension();
  assert.deepEqual(ext.parseDiagnostics('', Range, Diagnostic, DiagnosticSeverity), []);
  assert.deepEqual(ext.parseDiagnostics(null, Range, Diagnostic, DiagnosticSeverity), []);
  assert.deepEqual(
    ext.parseDiagnostics('clean: 1 file(s) checked', Range, Diagnostic, DiagnosticSeverity),
    [],
  );
  assert.deepEqual(
    ext.parseDiagnostics('{broken json', Range, Diagnostic, DiagnosticSeverity),
    [],
  );
});
