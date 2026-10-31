// [xihanzu-NR]
// `hydra types` contract.
//
// The point of these tests is the FILENAME and the two honesty rules, because
// both fail silently:
//
//   - TypeScript looks for `<file>.hyx.d.ts` next to `<file>.hyx`. A sibling
//     `Widget.d.ts` is ignored, so writing the wrong name means the feature does
//     nothing and reports success.
//   - A module with no exports must not get an empty declaration written over a
//     hand-written one.
//
// The final test runs `tsc` when one is available on the machine, and skips (with
// a printed reason) when it is not, rather than passing vacuously: a declaration
// that TypeScript cannot read is worse than no declaration at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BIN = path.join(REPO, 'bin', 'hydra');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-types-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function runTypes(dir, args = []) {
  return spawnSync(BIN, ['types', ...args], { cwd: dir, encoding: 'utf8' });
}

test('writes <file>.hyx.d.ts, the name TypeScript actually looks for', () => {
  const dir = tmpProject({
    'src/Widget.hyx': 'component Widget(label: str):\n    span: label\n',
  });
  const r = runTypes(dir);
  assert.equal(r.status, 0, r.stderr);
  const expected = path.join(dir, 'src', 'Widget.hyx.d.ts');
  assert.ok(fs.existsSync(expected), `expected ${expected}, got ${fs.readdirSync(path.join(dir, 'src'))}`);
  // The sibling name is deliberately asserted absent: it would be ignored by tsc.
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'Widget.d.ts')));
});

test('a component with a default emits an optional member, not a required one', () => {
  const dir = tmpProject({
    'src/W.hyx': 'component W(size: int = 1, label: str):\n    span: label\n',
  });
  runTypes(dir);
  const dts = fs.readFileSync(path.join(dir, 'src', 'W.hyx.d.ts'), 'utf8');
  assert.match(dts, /size\?: number;/);
  assert.match(dts, /label: string;/);
});

test('python type names never leak into the declaration', () => {
  const dir = tmpProject({
    'src/T.hyx': 'component T(a: int, b: float, c: str, d: list, e: dict):\n    span: c\n',
  });
  runTypes(dir);
  const dts = fs.readFileSync(path.join(dir, 'src', 'T.hyx.d.ts'), 'utf8');
  for (const py of ['int', 'float', 'str ', 'list,', 'dict,']) {
    assert.ok(!dts.includes(`: ${py}`), `python type leaked: ${dts}`);
  }
  assert.match(dts, /a: number;/);
  assert.match(dts, /c: string;/);
});

test('a module with no exports gets no file, so a hand-written .d.ts survives', () => {
  const dir = tmpProject({
    // Sibling files make no claims, so the checker produces no declaration.
    'src/util.hys': 'x = 1\ny = x + 1\n',
  });
  const existing = path.join(dir, 'src', 'util.hys.d.ts');
  fs.writeFileSync(existing, 'export const hand: string;\n');
  const r = runTypes(dir, ['src/util.hys']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.readFileSync(existing, 'utf8'),
    'export const hand: string;\n',
    'a module with no exports clobbered a hand-written declaration'
  );
});

test('a generated Props interface and a user-declared one do not collide', () => {
  // Both would be named WidgetProps; two `export interface WidgetProps` in one
  // file is a duplicate identifier and the consumer's build fails.
  const dir = tmpProject({
    'src/Widget.hyx':
      'interface WidgetProps:\n    label: str\n\ncomponent Widget(label: str):\n    span: label\n',
  });
  const r = runTypes(dir);
  assert.equal(r.status, 0, r.stderr);
  const dts = fs.readFileSync(path.join(dir, 'src', 'Widget.hyx.d.ts'), 'utf8');
  const count = (dts.match(/interface WidgetProps/g) || []).length;
  assert.equal(count, 1, `declared twice:\n${dts}`);
});

test('a syntax error is reported and does not half-write a declaration', () => {
  const dir = tmpProject({ 'src/Bad.hyx': 'component (:\n    div\n' });
  const r = runTypes(dir, ['src/Bad.hyx']);
  assert.notEqual(r.status, 0, 'a broken source must not report success');
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'Bad.hyx.d.ts')));
});

// --- the one that actually matters ------------------------------------------

function findTsc() {
  const candidates = [
    path.join(REPO, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    '/root/rpl_web/node_modules/typescript/lib/tsc.js',
    '/root/projects/payment/node_modules/typescript/lib/tsc.js',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

test('tsc reads the declaration: a wrong prop is an error, a right one is not', (t) => {
  const tsc = findTsc();
  const node = process.execPath;
  if (!tsc) {
    // Skipping loudly. A vacuous pass here would hide a declaration that no
    // TypeScript can actually consume.
    t.skip(`no tsc on this machine (looked in a few known places); skipping the real check`);
    return;
  }
  const dir = tmpProject({
    'node_modules/react/package.json': '{"name":"react","version":"18.3.1"}',
    'node_modules/react/index.d.ts': 'export declare const x: any;\n',
    'node_modules/react/jsx-runtime.js': 'exports.jsx = () => {};\n',
    'node_modules/react/jsx-runtime.d.ts':
      'export declare function jsx(t: any, p: any, k?: any): any;\n' +
      'export declare function jsxs(t: any, p: any, k?: any): any;\n' +
      'export declare namespace JSX { interface IntrinsicElements { [k: string]: any } type Element = any }\n',
    'src/Widget.hyx': 'component Widget(label: str, size: int = 1):\n    span: label\n',
    'src/good.tsx':
      "import { Widget } from './Widget.hyx'\n" +
      'export const a = <Widget label="x" size={2} />\n',
    'src/bad.tsx':
      "import { Widget } from './Widget.hyx'\n" +
      'export const b = <Widget label="x" size="nope" />\n' +
      'export const c = <Widget lable="x" />\n',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }),
  });

  const gen = runTypes(dir);
  assert.equal(gen.status, 0, gen.stderr);

  const tscOn = (files) =>
    spawnSync(node, [tsc, '--noEmit', '--strict', '--jsx', 'react-jsx',
      '--moduleResolution', 'bundler', '--module', 'ESNext', '--target', 'ES2022',
      '--skipLibCheck', ...files], { cwd: dir, encoding: 'utf8' });

  const good = tscOn(['src/good.tsx']);
  const goodOut = good.stdout + good.stderr;
  assert.ok(
    !goodOut.includes('TS2307') && !goodOut.includes('TS2322'),
    `the correct consumer must not error, got:\n${goodOut}`
  );

  const bad = tscOn(['src/bad.tsx']);
  const badOut = bad.stdout + bad.stderr;
  assert.match(badOut, /TS2322/, `a wrong prop type must be caught, got:\n${badOut}`);
  assert.match(badOut, /lable/, `a typo'd prop must be caught, got:\n${badOut}`);
});
