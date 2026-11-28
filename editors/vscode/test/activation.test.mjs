// [xihanzu-NR]
/**
 * Activation, end to end, with a fake editor and the real compiler.
 *
 * This is the test that catches the failures an editor would otherwise show as
 * "the extension does nothing": a command declared in package.json but never
 * registered, a provider registered against the wrong selector, a diagnostic
 * that never reaches the collection, a status bar that never appears.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { REPO, tempDir, waitFor } from './helpers.mjs';
import { createMockVscode, mockDocument } from './vscode-mock.mjs';

const require = createRequire(import.meta.url);

const BAD = 'component Card(:\n';
const GOOD = ['component Card(title: str = "x"):', '    heading(title)', '', '', 'def heading(value):', '    return value', ''].join('\n');

function loadExtension(mock) {
  // `require('vscode')` is resolved inside extension.js, so the interception
  // has to happen at Module._load, before the module is first required.
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return mock;
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../extension.js')];
    return require('../extension.js');
  } finally {
    Module._load = original;
  }
}

async function activateWith(documents) {
  const mock = createMockVscode();
  const dir = tempDir('hydra-activation-');
  mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(REPO), name: 'hydra', index: 0 }];
  mock.workspace.textDocuments = documents(mock, dir);
  mock.config = {};
  const extension = loadExtension(mock);
  const registered = new Map();
  const context = {
    extensionPath: path.join(REPO, 'editors', 'vscode'),
    subscriptions: {
      push(disposable) {
        registered.set(registered.size, disposable);
      },
    },
  };
  await extension.activate(context);
  return { mock, extension, dir, context };
}

test('activation registers every command the manifest advertises', async () => {
  const { mock, extension } = await activateWith(() => []);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, 'editors', 'vscode', 'package.json'), 'utf8'),
  );
  const declared = manifest.contributes.commands.map((command) => command.command);
  const missing = declared.filter((id) => !mock.registeredCommands.has(id));
  assert.deepEqual(missing, [], `declared but never registered: ${missing.join(', ')}`);
  extension.deactivate();
});

test('activation registers a provider for every capability the server admits', async () => {
  const { mock, extension } = await activateWith(() => []);
  for (const kind of ['hover', 'definition', 'rename', 'completion', 'signature']) {
    assert.equal(mock.providers[kind].length, 1, `no ${kind} provider`);
    const selector = mock.providers[kind][0].selector;
    assert.deepEqual(
      selector.map((entry) => entry.language).sort(),
      ['hys', 'hyx'],
      `${kind} is not registered for both languages`,
    );
  }
  assert.deepEqual(mock.providers.completion[0].triggers, ['.', ' ']);
  assert.equal(mock.statusBar.length, 1);
  assert.match(mock.statusBar[0].text, /Hydra/);
  await extension.deactivate();
});

test('a file with a syntax error gets a real diagnostic from the compiler', async () => {
  const uriPath = path.join(tempDir('hydra-doc-'), 'Card.hyx');
  fs.writeFileSync(uriPath, BAD);
  const { mock, extension } = await activateWith((m) => {
    const uri = m.Uri.file(uriPath);
    const document = mockDocument(uri, 'hyx', BAD);
    return [document];
  });

  const collection = mock.collections.get('hydra');
  const diagnostics = await waitFor(() => {
    const found = collection.get(`file://${uriPath}`);
    return found && found.length > 0 ? found : null;
  });
  assert.ok(diagnostics, `no diagnostics published; log:\n${mock.output.join('\n')}`);
  assert.equal(diagnostics[0].severity, mock.DiagnosticSeverity.Error);
  assert.match(diagnostics[0].message, /expected|found/i);
  assert.equal(diagnostics[0].source, 'hydra');
  extension.deactivate();
});

test('asking for a diagnostic collection entry is not the only way to get one', async () => {
  // The log is where a broken server is explained; an empty log with no
  // squiggles is what "the extension does nothing" looks like.
  const { mock, extension } = await activateWith(() => []);
  const initialised = await waitFor(() =>
    mock.output.find((line) => line.includes('language server') && line.includes('ready')),
  );
  assert.ok(initialised, `the server never reported ready:\n${mock.output.join('\n')}`);
  extension.deactivate();
});

test('hover and completion travel through the editor API in the right shape', async () => {
  const uriPath = path.join(tempDir('hydra-doc-'), 'Card.hyx');
  fs.writeFileSync(uriPath, GOOD);
  const { mock, extension } = await activateWith((m) => {
    const uri = m.Uri.file(uriPath);
    return [mockDocument(uri, 'hyx', GOOD)];
  });
  await waitFor(() =>
    mock.output.find((line) => line.includes('language server') && line.includes('ready')),
  );

  const document = mock.workspace.textDocuments[0];
  const hover = await mock.providers.hover[0].provider.provideHover(document, {
    line: 1,
    character: 6,
  });
  assert.ok(hover, 'no hover');
  assert.ok(hover.contents.length > 0, 'hover with no contents');
  assert.match(hover.contents[0].value, /heading/);

  const definition = await mock.providers.definition[0].provider.provideDefinition(document, {
    line: 1,
    character: 6,
  });
  assert.ok(Array.isArray(definition) && definition.length === 1);
  assert.equal(definition[0].range.start.line, 4);

  const completion = await mock.providers.completion[0].provider.provideCompletionItems(document, {
    line: 2,
    character: 0,
  });
  assert.ok(completion, 'no completion list');
  assert.ok(
    completion.items.some((item) => item.label === 'heading'),
    'completion does not offer the file own names',
  );

  const signature = await mock.providers.signature[0].provider.provideSignatureHelp(document, {
    line: 1,
    character: 13,
  });
  assert.ok(signature && signature.signatures.length > 0, 'no signature help');
  assert.match(signature.signatures[0].label, /value/);
  extension.deactivate();
});

test('a workspace with no compiler still activates, and says so', async () => {
  const mock = createMockVscode();
  const extension = loadExtension(mock);
  const empty = tempDir('hydra-nocompiler-');
  mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(empty), name: 'empty', index: 0 }];
  mock.config = { compilerPath: path.join(empty, 'no-such-hydra') };
  const context = { extensionPath: path.join(empty, 'ext'), subscriptions: { push() {} } };
  await extension.activate(context);
  // Whatever happens, the editors must exist: a missing compiler is a log line,
  // not an exception that leaves the extension half-registered.
  assert.equal(mock.providers.hover.length, 1);
  assert.equal(mock.statusBar.length, 1);
  assert.match(mock.statusBar[0].text, /Hydra/);
  await extension.deactivate();
});
