// [xihanzu-NR]
/**
 * The client against the real server.
 *
 * `hydra lsp` is the thing being talked to here — not a stub, not a recording.
 * If the protocol changes, this fails; if the framing is wrong, the first
 * `initialize` times out. That is the point: the extension's whole claim is
 * that it speaks to the compiler the project ships.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import { repoCompiler, tempDir, waitFor } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { LspClient } = require('../src/lsp-client.js');

const BAD = 'component Card(:\n';
const GOOD = [
  'component Card(title: str = "x"):',
  '    heading(title)',
  '',
  '',
  'def heading(value):',
  '    return value',
  '',
].join('\n');

async function withServer(fn) {
  const { invocation } = repoCompiler();
  const cwd = tempDir('hydra-lsp-');
  const diagnostics = new Map();
  const serverLog = [];
  const client = new LspClient({
    command: invocation.command,
    args: [...invocation.args, 'lsp'],
    cwd,
    env: { ...process.env, ...invocation.env },
    onDiagnostics: (params) => diagnostics.set(params.uri, params.diagnostics || []),
    onStderr: (text) => serverLog.push(text),
  });
  client.start();
  try {
    await fn({ client, cwd, diagnostics, serverLog });
  } finally {
    await client.dispose();
  }
}

function open(client, cwd, name, text) {
  const uri = `file://${path.join(cwd, name)}`;
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'hyx', version: 1, text },
  });
  return uri;
}

test('initialize answers with the capabilities the providers rely on', async () => {
  await withServer(async ({ client, cwd }) => {
    const result = await client.request('initialize', {
      processId: process.pid,
      rootUri: `file://${cwd}`,
      capabilities: {},
    });
    assert.equal(result.serverInfo.name, 'hydra-lsp');
    assert.equal(result.capabilities.hoverProvider, true);
    assert.equal(result.capabilities.definitionProvider, true);
    assert.deepEqual(result.capabilities.renameProvider, { prepareProvider: true });
    assert.deepEqual(result.capabilities.completionProvider.triggerCharacters, ['.', ' ']);
    assert.ok(result.capabilities.signatureHelpProvider);
  });
});

test('a syntax error comes back as a diagnostic with a position', async () => {
  await withServer(async ({ client, cwd, diagnostics }) => {
    await client.request('initialize', { processId: process.pid, rootUri: `file://${cwd}`, capabilities: {} });
    client.notify('initialized', {});
    const uri = open(client, cwd, 'Card.hyx', BAD);
    const published = await waitFor(() => diagnostics.get(uri));
    assert.ok(published, 'the server never published diagnostics');
    assert.ok(published.length > 0, 'a parse error produced no diagnostic');
    const first = published[0];
    assert.equal(first.severity, 1);
    assert.match(first.message, /expected|found/i);
    assert.ok(first.range.start.line >= 0);
  });
});

test('a clean file publishes an empty diagnostic list, not silence', async () => {
  await withServer(async ({ client, cwd, diagnostics }) => {
    await client.request('initialize', { processId: process.pid, rootUri: `file://${cwd}`, capabilities: {} });
    client.notify('initialized', {});
    const uri = open(client, cwd, 'Card.hyx', GOOD);
    const published = await waitFor(() => diagnostics.get(uri));
    assert.deepEqual(published, []);
  });
});

test('hover, definition, prepareRename and rename all answer', async () => {
  await withServer(async ({ client, cwd }) => {
    await client.request('initialize', { processId: process.pid, rootUri: `file://${cwd}`, capabilities: {} });
    client.notify('initialized', {});
    const uri = open(client, cwd, 'Card.hyx', GOOD);
    await waitFor(() => true);
    const document = { textDocument: { uri } };
    // `heading(title)` on line 1: the call starts at column 4.
    const position = { line: 1, character: 6 };

    const hover = await client.request('textDocument/hover', { ...document, position });
    assert.ok(hover && hover.contents, 'no hover contents');
    assert.match(String(hover.contents.value || hover.contents), /heading/);

    const definition = await client.request('textDocument/definition', { ...document, position });
    assert.ok(Array.isArray(definition) && definition.length === 1, 'no definition');
    assert.equal(definition[0].uri, uri);
    assert.equal(definition[0].range.start.line, 4);

    const prepared = await client.request('textDocument/prepareRename', { ...document, position });
    assert.equal(prepared.placeholder, 'heading');

    const rename = await client.request('textDocument/rename', {
      ...document,
      position,
      newName: 'title_text',
    });
    const edits = rename.changes[uri];
    assert.ok(edits.length >= 2, 'a rename must touch the call and the declaration');
    assert.ok(edits.every((edit) => edit.newText === 'title_text'));
  });
});

test('completion offers the file’s own names and the lowered builtins', async () => {
  await withServer(async ({ client, cwd }) => {
    await client.request('initialize', { processId: process.pid, rootUri: `file://${cwd}`, capabilities: {} });
    client.notify('initialized', {});
    const uri = open(client, cwd, 'Card.hyx', GOOD);
    await waitFor(() => true);
    const reply = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 2, character: 0 },
    });
    const items = Array.isArray(reply) ? reply : reply.items;
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes('heading'), `no local name in ${labels.join(', ')}`);
    assert.ok(labels.includes('len'), 'the compiler’s builtins are missing');
  });
});

test('signature help names the parameters of a local callable', async () => {
  await withServer(async ({ client, cwd }) => {
    await client.request('initialize', { processId: process.pid, rootUri: `file://${cwd}`, capabilities: {} });
    client.notify('initialized', {});
    const uri = open(client, cwd, 'Card.hyx', GOOD);
    await waitFor(() => true);
    const reply = await client.request('textDocument/signatureHelp', {
      textDocument: { uri },
      position: { line: 1, character: 13 },
    });
    assert.ok(reply && reply.signatures && reply.signatures.length > 0, 'no signature');
    assert.match(reply.signatures[0].label, /value/);
  });
});

test('a rename with nothing under the cursor is refused, with a reason', async () => {
  await withServer(async ({ client, cwd }) => {
    await client.request('initialize', { processId: process.pid, rootUri: `file://${cwd}`, capabilities: {} });
    client.notify('initialized', {});
    const uri = open(client, cwd, 'Card.hyx', GOOD);
    await waitFor(() => true);
    await assert.rejects(
      client.request('textDocument/rename', {
        textDocument: { uri },
        position: { line: 2, character: 0 },
        newName: 'x',
      }),
      /identifier/i,
    );
  });
});

test('the server stops when the client says so', async () => {
  const { invocation } = repoCompiler();
  const client = new LspClient({
    command: invocation.command,
    args: [...invocation.args, 'lsp'],
    cwd: tempDir('hydra-lsp-'),
    env: { ...process.env, ...invocation.env },
  });
  client.start();
  await client.request('initialize', { processId: process.pid, capabilities: {} });
  await client.dispose();
  assert.equal(client.exited, true, 'dispose must leave a stopped process behind');
});
