// [xihanzu-NR]
/**
 * The three LSP features that were listed as "not started": cross-file rename,
 * completion, signature help.
 *
 * Each test asserts what an EDITOR would see — the WorkspaceEdit it applies, the
 * items it shows — because that is the only claim worth making. A feature that
 * exists and returns nothing is indistinguishable from an absent one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  renameAcrossFiles,
  completionsFor,
  signatureFor,
  pythonBuiltins,
  runtimeExports,
  symbolsOf,
} from './lsp.mjs';

/** A throwaway tree, so a rename test edits real files it owns. */
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-lsp-'));
  // A project marker, because `importersOf` scans from the project root and a
  // bare temp dir has none. Every real project has one.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","private":true}');
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
const read = (p) => fs.readFileSync(p, 'utf8');

test('rename reaches the declaration AND every relative importer', () => {
  const dir = tree({
    'src/lib/stats.hys': '# [xihanzu-NR]\ndef summarise(xs):\n    return len(xs)\n',
    'src/a.hys': 'from "./lib/stats.hys" import summarise\n\nprint(summarise([1]))\n',
    'src/b.hys': 'from "./lib/stats.hys" import summarise\n\nprint(summarise([2]))\n',
  });
  const declPath = path.join(dir, 'src/lib/stats.hys');
  const text = read(declPath);
  const line = 1; // `def summarise(xs):`
  const col = text.split('\n')[line].indexOf('summarise');

  const out = renameAcrossFiles(text, declPath, line, col, 'total', { readFile: read });
  assert.equal(out.error, undefined, out.error);

  const uris = Object.keys(out.changes);
  assert.equal(uris.length, 3, `expected 3 files, got ${uris.length}`);
  // Declaration: `def` line and the call inside it are separate occurrences.
  const declEdits = out.changes[uris.find((u) => u.endsWith('stats.hys'))];
  assert.ok(declEdits.length >= 1);
  for (const u of uris) {
    for (const e of out.changes[u]) assert.equal(e.newText, 'total');
  }
});

test('renaming from an IMPORTER renames the declaration, not the local binding', () => {
  const dir = tree({
    'src/lib/stats.hys': '# [xihanzu-NR]\ndef summarise(xs):\n    return len(xs)\n',
    'src/a.hys': 'from "./lib/stats.hys" import summarise\n\nprint(summarise([1]))\n',
  });
  const aPath = path.join(dir, 'src/a.hys');
  const text = read(aPath);
  const col = text.split('\n')[2].indexOf('summarise');

  const out = renameAcrossFiles(text, aPath, 2, col, 'total', { readFile: read });
  assert.equal(out.error, undefined, out.error);
  const uris = Object.keys(out.changes);
  assert.equal(uris.length, 2, 'the declaration file and the importer both change');
});

test('a PACKAGE import is refused, with the reason', () => {
  const dir = tree({ 'src/a.hys': 'from "some-pkg" import helper\n\nprint(helper())\n' });
  const p = path.join(dir, 'src/a.hys');
  const out = renameAcrossFiles(read(p), p, 2, 6, 'other', { readFile: read });
  assert.match(out.error, /does not own|cannot/i);
});

test('completion offers the compiler\'s builtins, read from check.rs', () => {
  const builtins = pythonBuiltins({ readFile: read });
  assert.ok(builtins.length > 15, `only ${builtins.length} builtins parsed from check.rs`);
  for (const n of ['len', 'sorted', 'int', 'range']) assert.ok(builtins.includes(n), n);

  const out = completionsFor('component A():\n    x = le\n', 1, 12);
  assert.ok(out.items.some((i) => i.label === 'len'), 'len must be offered');
});

test('completion after `from "hydra" import ` offers the runtime exports', () => {
  const exports = runtimeExports({ readFile: read });
  assert.ok(exports.includes('state'), 'runtime exports must include state');
  const out = completionsFor('from "hydra" import \n', 0, 21);
  assert.ok(out.items.some((i) => i.label === 'state'));
  // And NOT the file's own declarations, which cannot be imported from hydra.
  assert.ok(!out.items.some((i) => i.label === 'component'));
});

test('completion after a dot offers that receiver\'s methods, and nothing else', () => {
  const listOut = completionsFor('xs = [1, 2]\nxs.\n', 1, 3);
  const listLabels = listOut.items.map((i) => i.label);
  assert.ok(listLabels.includes('append'), `got ${listLabels.join(',')}`);
  assert.ok(!listLabels.includes('keys'), 'a list has no dict method');

  const dictOut = completionsFor('d = {"a": 1}\nd.\n', 1, 2);
  assert.ok(dictOut.items.map((i) => i.label).includes('items'));
});

test('completion lists the file\'s own declarations', () => {
  const text = 'component Card(title):\n    div(): title\n\ndef summarise(xs):\n    return xs\n';
  const out = completionsFor(text, 3, 4);
  const labels = out.items.map((i) => i.label);
  assert.ok(labels.includes('Card'));
  assert.ok(labels.includes('summarise'));
});

test('signature help names the parameters and the active argument', () => {
  const text = 'def greet(name, greeting="hi"):\n    return greeting\n\nx = greet("a", \n';
  const out = signatureFor(text, 3, 'x = greet("a", '.length);
  assert.ok(out, 'expected a signature');
  const sig = out.signatures[0];
  assert.match(sig.label, /greet\(name, greeting/);
  assert.equal(sig.parameters.length, 2);
  assert.equal(out.activeParameter, 1, 'the cursor is in the second argument');
});

test('signature help resolves an imported callable', () => {
  const dir = tree({
    'src/lib/greet.hys': '# [xihanzu-NR]\ndef greet(name, punct):\n    return name\n',
    'src/a.hys': 'from "./lib/greet.hys" import greet\n\nx = greet("a", \n',
  });
  const p = path.join(dir, 'src/a.hys');
  const out = signatureFor(read(p), 2, 'x = greet("a", '.length, {
    filePath: p,
    readFile: read,
  });
  assert.ok(out, 'expected a signature from the imported module');
  assert.equal(out.signatures[0].parameters.length, 2);
});

test('signature help says nothing when it cannot name the parameters', () => {
  // A package call: no source to read, so no signature. Silence is the honest
  // answer — the editor shows nothing rather than a guess.
  const out = signatureFor('x = mystery(1, ', 0, 'x = mystery(1, '.length);
  assert.equal(out, null);
});

test('symbolsOf reads components, defs, classes and variables', () => {
  const syms = symbolsOf('component Card(x):\n    pass\n\ndef f():\n    pass\n\nlimit = 3\n');
  const names = syms.map((s) => s.name);
  assert.deepEqual(names.sort(), ['Card', 'f', 'limit']);
});
