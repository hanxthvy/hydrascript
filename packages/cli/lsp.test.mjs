// [xihanzu-NR]
/**
 * `hydra-lsp` — the protocol and the analysis, tested without an editor.
 *
 * Two layers, tested separately on purpose: `handleMessage` is pure enough to
 * drive directly (so a capability or a rename rule is a unit test), and `serve`
 * is exercised over a real pipe (so the `Content-Length` framing — the part an
 * editor fails on and a developer cannot debug — is covered too).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
const requireFs = () => {
  const req = createRequire(import.meta.url);
  return req('node:fs');
};
import path from 'node:path';
import {
  handleMessage,
  serve,
  newState,
  identifierAt,
  declarationsOf,
  usesOf,
  importsOf,
  resolveImport,
  hoverFor,
  definitionFor,
  renameFor,
} from './lsp.mjs';

/** A state plus a recorder for whatever the server sends. */
function session(opts = {}) {
  const sent = [];
  return {
    sent,
    state: newState(opts),
    io: { send: (m) => sent.push(m) },
  };
}

const SRC = [
  '# [xihanzu-NR]',
  'from "hydra/server" import env',
  '',
  'def greeting(name):',
  '    return "hi " + name',
  '',
  'class Card:',
  '    pass',
  '',
  'component Home():',
  '    div(): greeting("x")',
  '',
].join('\n');

test('initialize reports the capabilities the server really has', () => {
  const { sent, state, io } = session({ version: '9.9.9' });
  handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, state, io);
  const res = sent[0].result;
  assert.equal(res.serverInfo.name, 'hydra-lsp');
  assert.equal(res.serverInfo.version, '9.9.9');
  assert.equal(res.capabilities.hoverProvider, true);
  assert.equal(res.capabilities.definitionProvider, true);
  // Rename is now a WorkspaceEdit across files, so the provider is an object
  // carrying `prepareProvider` — the flag that lets the editor refuse a position
  // with nothing under it instead of sending an empty rename.
  assert.equal(res.capabilities.renameProvider.prepareProvider, true);
  assert.ok(res.capabilities.completionProvider, 'completion is implemented');
  assert.ok(res.capabilities.signatureHelpProvider, 'signature help is implemented');
  // Full sync: the client sends the whole document on change. Claiming
  // incremental without implementing it corrupts the buffer.
  assert.equal(res.capabilities.textDocumentSync, 1);
});

test('an unimplemented request answers method-not-found, not silence', () => {
  const { sent, state, io } = session();
  // A method the server genuinely does not implement. `completion` used to be
  // this example; it is implemented now, so the example had to move rather than
  // the assertion disappear — the behaviour under test is the honest refusal.
  handleMessage({ jsonrpc: '2.0', id: 7, method: 'textDocument/semanticTokens/full' }, state, io);
  assert.equal(sent[0].error.code, -32601);
  assert.equal(sent[0].id, 7);
});

test('shutdown and exit are recorded', () => {
  const { state, io } = session();
  handleMessage({ jsonrpc: '2.0', id: 2, method: 'shutdown' }, state, io);
  assert.equal(state.shuttingDown, true);
  handleMessage({ jsonrpc: '2.0', method: 'exit' }, state, io);
  assert.equal(state.exiting, true);
});

test('identifierAt finds the word under the cursor, and only identifiers', () => {
  const hit = identifierAt(SRC, 3, 7); // `def greeting(name):`
  assert.equal(hit.word, 'greeting');
  assert.equal(hit.start, 4);
  assert.equal(identifierAt('    return "hi " + name', 0, 3), null, 'a quote is not an identifier');
  assert.equal(identifierAt(SRC, 99, 0), null, 'past the end');
});

test('declarationsOf finds def, class, component and assignment', () => {
  const src = ['x = 1', 'def f():', '    pass', 'class C:', '    pass', 'component K():', '    pass'].join('\n');
  assert.deepEqual(declarationsOf(src, 'x').map((d) => d.line), [0]);
  assert.deepEqual(declarationsOf(src, 'f').map((d) => d.line), [1]);
  assert.deepEqual(declarationsOf(src, 'C').map((d) => d.line), [3]);
  assert.deepEqual(declarationsOf(src, 'K').map((d) => d.line), [5]);
  assert.deepEqual(declarationsOf(src, 'nope'), []);
});

test('usesOf is whole-word, so renaming data leaves metadata alone', () => {
  const src = 'data = 1\nmetadata = data + database';
  const hits = usesOf(src, 'data');
  assert.equal(hits.length, 2, `expected 2, got ${JSON.stringify(hits)}`);
  assert.deepEqual(hits[0], { line: 0, start: 0, end: 4 });
  assert.deepEqual(hits[1], { line: 1, start: 11, end: 15 });
});

test('importsOf reads the specifier and the names', () => {
  const imps = importsOf(SRC);
  assert.equal(imps.length, 1);
  assert.equal(imps[0].spec, 'hydra/server');
  assert.deepEqual(imps[0].names, ['env']);
});

test('hover explains a local declaration, an import, and an unbound name', () => {
  const local = hoverFor(SRC, 3, 7);
  assert.match(local.contents.value, /def greeting/);
  assert.match(local.contents.value, /line 4/);

  const imported = hoverFor(SRC, 1, 27); // `env` in the import line
  assert.match(imported.contents.value, /imported from/);

  const unknown = hoverFor(SRC, 3, 20); // `name`, a parameter
  assert.ok(unknown, 'a parameter still hovers');
});

test('definition jumps within the file, and refuses what it cannot find', () => {
  const here = definitionFor(SRC, '/tmp/a.hyx', 10, 11); // `greeting(...)` in Home
  assert.ok(here, 'greeting is declared above');
  assert.equal(here.range.start.line, 3);

  const missing = definitionFor(SRC, '/tmp/a.hyx', 3, 20);
  assert.equal(missing, null, 'a parameter has no declaration line to jump to');
});

test('definition follows a relative import to the other file', () => {
  const files = {
    '/proj/src/Helper.hyx': 'component Helper():\n    div(): "x"\n',
  };
  const src = 'from "./Helper.hyx" import Helper\n\ncomponent A():\n    Helper()\n';
  const hit = definitionFor(src, '/proj/src/A.hyx', 3, 5, {
    // Both the resolution and the read are injected: the test must not depend on
    // this machine's filesystem, and the real resolver is covered by its own
    // test below.
    resolve: (from, spec) => (spec === './Helper.hyx' ? '/proj/src/Helper.hyx' : null),
    readFile: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
  });
  assert.ok(hit, 'must resolve ./Helper.hyx');
  assert.match(hit.uri, /Helper\.hyx$/);
  assert.equal(hit.range.start.line, 0);
});

test('rename rewrites every whole-word use in the file', () => {
  const src = 'def helper():\n    pass\n\nx = helper()\n';
  const out = renameFor(src, 3, 5, 'assist');
  assert.equal(out.edits.length, 2);
  assert.equal(out.edits[0].range.start.line, 0);
  assert.equal(out.edits[1].range.start.line, 3);
  assert.equal(out.edits[0].newText, 'assist');
});

test('rename REFUSES a name that came from an import, with the reason', () => {
  // This is the difference between a rename and a corruption: the local binding
  // and the module's export are the same name, and this server does not edit
  // other files. A silent half-rename leaves the import naming nothing.
  const out = renameFor(SRC, 1, 27, 'config_value');
  assert.ok(out.error, 'must refuse');
  assert.match(out.error, /imported from/);
  assert.match(out.error, /alias/);
});

test('rename rejects an invalid identifier', () => {
  const out = renameFor(SRC, 3, 7, 'not a name');
  assert.match(out.error, /not a valid identifier/);
});

test('rename of a non-identifier position is refused, not guessed', () => {
  const out = renameFor('x = 1', 0, 2, 'y');
  assert.match(out.error, /no identifier/);
});

test('serve frames messages with Content-Length, and reports over a real pipe', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const frames = [];
  let buffer = Buffer.alloc(0);
  stdout.on('data', (c) => {
    buffer = Buffer.concat([buffer, c]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(buffer.slice(0, end).toString())[1]);
      const start = end + 4;
      if (buffer.length - start < len) return;
      frames.push(JSON.parse(buffer.slice(start, start + len).toString('utf8')));
      buffer = buffer.slice(start + len);
    }
  });

  const done = serve(stdin, stdout, { compiler: null });
  const send = (msg) => {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdin.write(body);
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///tmp/x.hyx', text: SRC } },
  });
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///tmp/x.hyx' }, position: { line: 3, character: 7 } },
  });
  send({ jsonrpc: '2.0', method: 'exit' });

  const code = await done;
  assert.equal(code, 0, 'exit must end the server');
  assert.equal(frames[0].result.serverInfo.name, 'hydra-lsp');
  // `didOpen` publishes diagnostics; with no compiler it is an empty list, which
  // is still a publication (the editor clears any stale squiggle).
  const diag = frames.find((f) => f.method === 'textDocument/publishDiagnostics');
  assert.ok(diag, `expected a diagnostics publication, got ${JSON.stringify(frames)}`);
  assert.ok(Array.isArray(diag.params.diagnostics));
  const hover = frames.find((f) => f.id === 2);
  assert.match(hover.result.contents.value, /greeting/);
});

test('a malformed frame does not take the server down', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const frames = [];
  let buffer = Buffer.alloc(0);
  stdout.on('data', (c) => {
    buffer = Buffer.concat([buffer, c]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(buffer.slice(0, end).toString())[1]);
      const start = end + 4;
      if (buffer.length - start < len) return;
      frames.push(JSON.parse(buffer.slice(start, start + len).toString('utf8')));
      buffer = buffer.slice(start + len);
    }
  });
  const done = serve(stdin, stdout, { compiler: null });
  const frame = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdin.write(body);
  };

  // A frame whose body is not JSON: the server must answer -32700 and keep
  // going. (A frame that DECLARES more bytes than it sends is a different case —
  // the server correctly waits for the rest, so it cannot be tested before the
  // frames that must still be processed.)
  const bad = Buffer.from('{not json', 'utf8');
  stdin.write(`Content-Length: ${bad.length}\r\n\r\n`);
  stdin.write(bad);
  frame({ jsonrpc: '2.0', id: 6, method: 'shutdown' });
  frame({ jsonrpc: '2.0', method: 'exit' });
  const code = await done;
  assert.equal(code, 0, 'a bad frame must not end the server');
  assert.ok(
    frames.some((f) => f.error && f.error.code === -32700),
    `expected a parse-error response, got ${JSON.stringify(frames)}`,
  );
});

test('resolveImport finds a real file, extensions and index included', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = requireFs();
  const dir = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'hydra-lsp-res-'));
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'lib', 'Thing.hyx'), '#\n');
  mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  writeFileSync(path.join(dir, 'pkg', 'index.hys'), '#\n');
  assert.equal(resolveImport(path.join(dir, 'A.hyx'), './lib/Thing.hyx'), path.join(dir, 'lib', 'Thing.hyx'));
  assert.equal(resolveImport(path.join(dir, 'A.hyx'), './lib/Thing'), path.join(dir, 'lib', 'Thing.hyx'));
  assert.equal(resolveImport(path.join(dir, 'A.hyx'), './pkg'), path.join(dir, 'pkg', 'index.hys'));
  assert.equal(resolveImport(path.join(dir, 'A.hyx'), './missing'), null);
  assert.equal(resolveImport(path.join(dir, 'A.hyx'), 'react'), null, 'a package is not a relative jump');
  rmSync(dir, { recursive: true, force: true });
});
