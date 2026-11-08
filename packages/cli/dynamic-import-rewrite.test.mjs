// [xihanzu-NR]
/**
 * `rewriteDynamicImports` must only rewrite code, never text that looks like it.
 *
 * The previous implementation was a single regex over the whole file, which has
 * no idea what a string literal is. Rewriting inside a string does not fail the
 * build — the output stays valid JavaScript and means something different. That
 * is the worst kind of compiler bug: silent, and only visible at runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The function is not exported; slice it out of runner.mjs so the test exercises
// the real implementation rather than a copy that can drift.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'runner.mjs'), 'utf8');
const START = SRC.indexOf('function rewriteDynamicImports(code) {');
const END = SRC.indexOf('/**\n * Resolve the runtime specifiers exactly');
assert.ok(START > 0 && END > START, 'rewriteDynamicImports must exist in runner.mjs');
const rewrite = new Function(`${SRC.slice(START, END)}; return rewriteDynamicImports;`)();

test('a real call is rewritten', () => {
  assert.equal(rewrite('const p = __import__("./Page.hyx")'), 'const p = import("./Page.hyx")');
});

test('whitespace inside the call is tolerated', () => {
  assert.equal(rewrite('const p = __import__ (  "./Page.hyx"  )'), 'const p = import("./Page.hyx")');
});

test('a string literal that CONTAINS the call is left alone', () => {
  const code = 'const s = "__import__(\'./Page.hyx\')"';
  assert.equal(rewrite(code), code);
});

test('a template literal is left alone', () => {
  const code = 'const t = `__import__("./Page.hyx")`';
  assert.equal(rewrite(code), code);
});

test('a line comment is left alone', () => {
  const code = '// __import__("./Page.hyx")\nconst x = 1';
  assert.equal(rewrite(code), code);
});

test('a block comment is left alone', () => {
  const code = '/* __import__("./Page.hyx") */';
  assert.equal(rewrite(code), code);
});

test('a property named __import__ is not a call to rewrite', () => {
  const code = 'foo.__import__("./x")';
  assert.equal(rewrite(code), code);
});

test('an identifier ending in __import__ is not a call to rewrite', () => {
  const code = 'my__import__("./x")';
  assert.equal(rewrite(code), code);
});

test('a non-literal argument is left alone', () => {
  // Rewriting this would change behaviour: the replacement is not equivalent.
  const code = 'const p = __import__(nama)';
  assert.equal(rewrite(code), code);
});

test('an escaped quote does not end the string early', () => {
  const code = 'const s = "a\\"__import__(\'./x\')"; const y = 1';
  assert.equal(rewrite(code), code);
});

test('a call inside a template expression IS rewritten', () => {
  // `${ ... }` is code again, not template text. Missing this means the helper
  // silently stops working the moment someone puts a lazy import in a template.
  const out = rewrite('const t = `a${__import__("./x")}b`');
  assert.ok(out.includes('import("./x")'), out);
});
