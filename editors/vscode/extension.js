// [xihanzu-NR]
'use strict';

/**
 * HydraScript for VS Code.
 *
 * 0.1.0 shelled `hydra check --json -` on save and called itself a diagnostics
 * client. That is one fifth of what the project already ships: `hydra lsp`
 * answers hover, go-to-definition, rename across files, completion and
 * signature help, and it asks the COMPILER for diagnostics instead of
 * reimplementing them. So this version starts that server over stdio and maps
 * its replies onto the editor. The one-shot `check` is kept, but only as the
 * fallback for a workspace where the server cannot start — a squiggle from a
 * slower path is better than no squiggle at all.
 *
 * The commands are the other half of "developer experience": the project's own
 * CLI, and the file conventions (`src/pages`, `src/api`, `.server.hys`) as
 * scaffolds, without a terminal round trip.
 *
 * No npm dependencies: `Content-Length` framing is src/lsp-client.js (thirty
 * lines), so the .vsix installs on an air-gapped machine and never pulls a
 * second copy of a language-client stack into the extension host.
 */

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const { LspClient } = require('./src/lsp-client');
const {
  resolveCompiler,
  compilerInvocation,
  supportsLanguageServer,
  routeForPath,
  validateName,
  templateFor,
  cliCommandFor,
} = require('./src/cli');

const LANGS = ['hyx', 'hys'];
const SELECTOR = LANGS.map((language) => ({ language }));

/** VS Code's own numbering, spelled out so the mapping is checkable. */
const SEVERITY = {
  1: vscode.DiagnosticSeverity.Error,
  2: vscode.DiagnosticSeverity.Warning,
  3: vscode.DiagnosticSeverity.Information,
  4: vscode.DiagnosticSeverity.Hint,
};

/** LSP CompletionItemKind, mapped to the editor's. Everything unmapped is a
 *  plain item rather than an absent one. */
const COMPLETION_KIND = {
  2: vscode.CompletionItemKind.Method,
  3: vscode.CompletionItemKind.Function,
  4: vscode.CompletionItemKind.Constructor,
  5: vscode.CompletionItemKind.Field,
  6: vscode.CompletionItemKind.Variable,
  7: vscode.CompletionItemKind.Class,
  8: vscode.CompletionItemKind.Interface,
  9: vscode.CompletionItemKind.Module,
  10: vscode.CompletionItemKind.Property,
  13: vscode.CompletionItemKind.Enum,
  14: vscode.CompletionItemKind.Keyword,
  21: vscode.CompletionItemKind.Constant,
  22: vscode.CompletionItemKind.Struct,
};

const state = {
  context: null,
  channel: null,
  collection: null,
  status: null,
  terminal: null,
  client: null,
  ready: false,
  restarts: 0,
  version: '',
  pendingChanges: new Map(),
  disposing: false,
  compiler: null,
};

function config() {
  return vscode.workspace.getConfiguration('hydra');
}

function workspaceRoot() {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  return folder ? folder.uri.fsPath : undefined;
}

function log(line) {
  if (!state.channel) return;
  state.channel.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}

function isHydra(document) {
  return !!document && LANGS.includes(document.languageId);
}

function compiler() {
  const setting = config().get('compilerPath', '');
  return resolveCompiler({
    setting,
    extensionPath: state.context.extensionPath,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    exists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
  });
}

/** Quote a path for `terminal.sendText`, which takes a whole shell line. */
function quoted(value) {
  return /[\s"']/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value);
}

function compilerLine() {
  const { bin } = state.compiler || compiler();
  if (/\.(c|m)?js$/i.test(String(bin))) return `node ${quoted(bin)}`;
  return quoted(bin);
}

function setStatus(mode, detail = '') {
  if (!state.status) return;
  const version = state.version ? ` ${state.version}` : '';
  const icon = {
    running: '$(flame)',
    starting: '$(sync~spin)',
    stopped: '$(circle-slash)',
    failed: '$(warning)',
  }[mode];
  state.status.text = `${icon} Hydra${version}`;
  state.status.tooltip = new vscode.MarkdownString(
    [
      `**HydraScript${version}**`,
      '',
      `language server: ${mode}${detail ? ` — ${detail}` : ''}`,
      state.compiler ? `compiler: \`${state.compiler.bin}\` (${state.compiler.source})` : '',
      '',
      'click for the language server log',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  state.status.command = 'hydra.showLog';
  state.status.show();
}

// ------------------------------------------------------------------ the server

function toRange(range) {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function toPosition(position) {
  return { line: position.line, character: position.character };
}

function onDiagnostics(params) {
  let uri;
  try {
    uri = vscode.Uri.parse(params.uri);
  } catch {
    return;
  }
  const diagnostics = (params.diagnostics || []).map((d) => {
    const diagnostic = new vscode.Diagnostic(
      toRange(d.range),
      d.message || 'problem',
      SEVERITY[d.severity] ?? vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = d.source || 'hydra';
    if (d.code !== undefined && d.code !== null) diagnostic.code = d.code;
    return diagnostic;
  });
  if (diagnostics.length > 0) state.collection.set(uri, diagnostics);
  else state.collection.delete(uri);
}

function didOpen(document) {
  if (!state.ready || !isHydra(document)) return;
  state.client.notify('textDocument/didOpen', {
    textDocument: {
      uri: document.uri.toString(),
      languageId: document.languageId,
      version: document.version,
      text: document.getText(),
    },
  });
}

/**
 * `didChange` is debounced.
 *
 * The server re-runs `hydra check` for every change it receives, which is a
 * process per keystroke if the editor forwards each one. 250 ms is short enough
 * that a pause to think is diagnosed, and long enough that typing a line is one
 * compiler run instead of forty.
 */
function scheduleChange(document) {
  if (!state.ready || !isHydra(document)) return;
  const key = document.uri.toString();
  const previous = state.pendingChanges.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    state.pendingChanges.delete(key);
    if (state.ready) sendChange(document, key);
  }, 250);
  state.pendingChanges.set(key, timer);
}

function sendChange(document, key) {
  state.client.notify('textDocument/didChange', {
    textDocument: { uri: key, version: document.version },
    contentChanges: [{ text: document.getText() }],
  });
}

/** A save does not wait for the debounce: the file on disk is already what the
 *  developer means, and waiting makes the squiggles trail the save. */
function flushChange(document) {
  const key = document.uri.toString();
  const timer = state.pendingChanges.get(key);
  if (timer) {
    clearTimeout(timer);
    state.pendingChanges.delete(key);
  }
  if (state.ready && isHydra(document)) sendChange(document, key);
}

function stopServer() {
  const client = state.client;
  state.client = null;
  state.ready = false;
  for (const timer of state.pendingChanges.values()) clearTimeout(timer);
  state.pendingChanges.clear();
  if (client) client.dispose();
}

async function startServer({ restart = false } = {}) {
  stopServer();
  if (!config().get('languageServer.enable', true)) {
    setStatus('stopped', 'disabled by setting');
    log('language server disabled by hydra.languageServer.enable');
    return;
  }
  state.compiler = compiler();
  const { bin, source } = state.compiler;
  if (!supportsLanguageServer(bin)) {
    // A bare native binary has `check`, `fmt`, `types` — and no runner, so no
    // `lsp`. Falling back is the honest answer; spawning it would fail with
    // `cannot read lsp` and look like a broken extension.
    setStatus('stopped', `no language server in ${bin}`);
    log(`no language server in ${bin} (${source}); using \`check\` on save instead`);
    return;
  }
  const invocation = compilerInvocation(bin);
  const client = new LspClient({
    command: invocation.command,
    args: [...invocation.args, 'lsp'],
    cwd: workspaceRoot(),
    env: { ...process.env, ...invocation.env },
    onDiagnostics,
    onStderr: (text) => {
      const trimmed = String(text).trim();
      if (trimmed) log(trimmed);
    },
    onNotification: (method, params) => {
      if (method === 'window/logMessage' || method === 'window/showMessage') {
        log(`${method}: ${JSON.stringify(params)}`);
      }
    },
    onExit: (code, signal) => {
      if (state.disposing) return;
      log(`language server exited (${code ?? signal})`);
      state.ready = false;
      state.client = null;
      setStatus('failed', `exited (${code ?? signal})`);
      if (state.restarts < 3) {
        state.restarts += 1;
        const delay = [500, 1500, 4000][state.restarts - 1] || 4000;
        log(`restarting in ${delay}ms (attempt ${state.restarts} of 3)`);
        setTimeout(() => {
          if (!state.disposing) startServer({ restart: true });
        }, delay);
      } else {
        log('giving up on the language server; diagnostics fall back to `hydra check --json`');
      }
    },
  });
  client.trace = config().get('languageServer.trace', false);
  state.client = client;
  setStatus('starting', source);
  client.start();

  const folders = vscode.workspace.workspaceFolders || [];
  try {
    const result = await client.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'hydrascript-vscode' },
      rootUri: folders.length > 0 ? folders[0].uri.toString() : null,
      workspaceFolders: folders.map((f) => ({ uri: f.uri.toString(), name: f.name })),
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          synchronization: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          rename: { prepareSupport: true },
          completion: {
            contextSupport: false,
            completionItem: {
              snippetSupport: false,
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          signatureHelp: {
            signatureInformation: { documentationFormat: ['markdown', 'plaintext'] },
          },
        },
      },
    });
    state.version = result?.serverInfo?.version || state.version;
    state.ready = true;
    client.notify('initialized', {});
    if (!restart) state.restarts = 0;
    log(`language server ${state.version || '?'} ready (${source}: ${bin})`);
    setStatus('running');
    for (const document of vscode.workspace.textDocuments) didOpen(document);
  } catch (err) {
    log(`initialize failed: ${err && err.message ? err.message : err}`);
    setStatus('failed', 'initialize failed');
    client.dispose();
    state.client = null;
    state.ready = false;
  }
}

// ------------------------------------------------------------------ providers

/** Every provider is gated on the same condition: a live server, or nothing.
 *  Answering `null` is what lets the editor look elsewhere. */
function live() {
  return state.ready && state.client ? state.client : null;
}

/**
 * A request whose failure is not worth an error popup.
 *
 * The server refuses a few positions on purpose ("no identifier under the
 * cursor", "a package import cannot be renamed here"). A hover that cannot be
 * answered should leave the tooltip empty, not interrupt the developer; the
 * log keeps the reason. Rename is the exception and does NOT use this: a
 * refusal there is something the developer asked for and must see.
 */
async function safeRequest(method, params) {
  const client = live();
  if (!client) return null;
  try {
    return await client.request(method, params);
  } catch (err) {
    log(`${method}: ${err && err.message ? err.message : err}`);
    return null;
  }
}

function registerProviders(context) {
  const push = (disposable) => context.subscriptions.push(disposable);

  push(
    vscode.languages.registerHoverProvider(SELECTOR, {
      async provideHover(document, position) {
        if (!live()) return null;
        const reply = await safeRequest('textDocument/hover', {
          textDocument: { uri: document.uri.toString() },
          position: toPosition(position),
        });
        if (!reply || !reply.contents) return null;
        const contents = Array.isArray(reply.contents) ? reply.contents : [reply.contents];
        const markdown = contents
          .map((entry) => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object') {
              const value = entry.value ?? '';
              return entry.kind === 'markdown' ? value : `\`\`\`\n${value}\n\`\`\``;
            }
            return '';
          })
          .filter(Boolean);
        if (markdown.length === 0) return null;
        return new vscode.Hover(
          markdown.map((value) => new vscode.MarkdownString(value)),
          reply.range ? toRange(reply.range) : undefined,
        );
      },
    }),
  );

  push(
    vscode.languages.registerDefinitionProvider(SELECTOR, {
      async provideDefinition(document, position) {
        if (!live()) return null;
        const reply = await safeRequest('textDocument/definition', {
          textDocument: { uri: document.uri.toString() },
          position: toPosition(position),
        });
        if (!reply) return null;
        const locations = (Array.isArray(reply) ? reply : [reply]).map(
          (location) => new vscode.Location(vscode.Uri.parse(location.uri), toRange(location.range)),
        );
        return locations.length > 0 ? locations : null;
      },
    }),
  );

  push(
    vscode.languages.registerRenameProvider(SELECTOR, {
      async prepareRename(document, position) {
        if (!live()) return null;
        const reply = await safeRequest('textDocument/prepareRename', {
          textDocument: { uri: document.uri.toString() },
          position: toPosition(position),
        });
        if (!reply) return null;
        return { range: toRange(reply.range), placeholder: reply.placeholder };
      },
      async provideRenameEdits(document, position, newName) {
        const client = live();
        if (!client) throw new Error('the HydraScript language server is not running');
        const reply = await client.request('textDocument/rename', {
          textDocument: { uri: document.uri.toString() },
          position: toPosition(position),
          newName,
        });
        const edit = new vscode.WorkspaceEdit();
        for (const [uri, edits] of Object.entries(reply?.changes || {})) {
          for (const change of edits) {
            edit.replace(vscode.Uri.parse(uri), toRange(change.range), change.newText);
          }
        }
        return edit;
      },
    }),
  );

  push(
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        async provideCompletionItems(document, position) {
          if (!live()) return null;
          const reply = await safeRequest('textDocument/completion', {
            textDocument: { uri: document.uri.toString() },
            position: toPosition(position),
          });
          const items = Array.isArray(reply) ? reply : reply?.items || [];
          const mapped = items.map((item) => {
            const completion = new vscode.CompletionItem(
              item.label,
              COMPLETION_KIND[item.kind] ?? vscode.CompletionItemKind.Text,
            );
            if (item.detail) completion.detail = item.detail;
            if (item.insertText) completion.insertText = item.insertText;
            if (item.documentation) {
              const documentation = item.documentation;
              completion.documentation = new vscode.MarkdownString(
                typeof documentation === 'string' ? documentation : documentation.value,
              );
            }
            if (item.sortText) completion.sortText = item.sortText;
            if (item.filterText) completion.filterText = item.filterText;
            return completion;
          });
          return new vscode.CompletionList(mapped, reply?.isIncomplete ?? false);
        },
      },
      '.',
      ' ',
    ),
  );

  push(
    vscode.languages.registerSignatureHelpProvider(
      SELECTOR,
      {
        async provideSignatureHelp(document, position) {
          if (!live()) return null;
          const reply = await safeRequest('textDocument/signatureHelp', {
            textDocument: { uri: document.uri.toString() },
            position: toPosition(position),
          });
          if (!reply || !reply.signatures) return null;
          const help = new vscode.SignatureHelp();
          help.signatures = reply.signatures.map((signature) => {
            const information = new vscode.SignatureInformation(
              signature.label,
              signature.documentation,
            );
            information.parameters = (signature.parameters || []).map(
              (parameter) =>
                new vscode.ParameterInformation(
                  Array.isArray(parameter.label)
                    ? signature.label.slice(parameter.label[0], parameter.label[1])
                    : parameter.label,
                  parameter.documentation,
                ),
            );
            return information;
          });
          help.activeSignature = reply.activeSignature ?? 0;
          help.activeParameter = reply.activeParameter ?? 0;
          return help;
        },
      },
      '(',
      ',',
    ),
  );
}

// ----------------------------------------------------------- the fallback check

/**
 * `hydra check --json -` for a workspace whose language server will not start.
 *
 * Kept from 0.1.0 because it is the honest fallback, not because it is the
 * plan: it costs a process per save and reports only what the parser and the
 * semantic checker say.
 */
function checkDocument(document) {
  if (!isHydra(document) || state.ready) return;
  const { bin } = state.compiler || compiler();
  const invocation = compilerInvocation(bin);
  execFile(
    invocation.command,
    [...invocation.args, 'check', '--json', '-', '--stdin-name', document.fileName],
    { input: document.getText(), maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...invocation.env } },
    (err, stdout, stderr) => {
      // `check` exits non-zero when it finds an error, so `err` is expected and
      // is not itself a finding. Diagnostics come from stdout.
      const diagnostics = parseDiagnostics(
        stdout,
        vscode.Range,
        vscode.Diagnostic,
        vscode.DiagnosticSeverity,
      );
      if (diagnostics.length > 0) {
        state.collection.set(document.uri, diagnostics);
        return;
      }
      const ran = stdout && stdout.trim().length > 0;
      if (err && !ran && stderr && stderr.trim() && !/error\(s\) found/.test(stderr)) {
        const problem = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `hydra could not run: ${stderr.trim().split('\n')[0]}`,
          vscode.DiagnosticSeverity.Warning,
        );
        problem.source = 'hydra';
        state.collection.set(document.uri, [problem]);
      }
    },
  );
}

/**
 * Turn `hydra check --json` output into editor diagnostics.
 *
 * Pure and exported so it can be tested without VS Code, which is how the
 * original version shipped it too.
 */
function parseDiagnostics(jsonText, DocumentRange, Diagnostic, DiagnosticSeverity) {
  const out = [];
  for (const line of String(jsonText || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let finding;
    try {
      finding = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const lineIndex = Math.max(0, (finding.line ?? 1) - 1);
    const columnIndex = Math.max(0, (finding.col ?? 1) - 1);
    const severity =
      finding.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
    const diagnostic = new Diagnostic(
      new DocumentRange(lineIndex, columnIndex, lineIndex, columnIndex + 1),
      finding.message || 'problem',
      severity,
    );
    diagnostic.source = 'hydra';
    out.push(diagnostic);
  }
  return out;
}

// -------------------------------------------------------------------- commands

function hydraTerminal() {
  if (!state.terminal || state.terminal.exitStatus !== undefined) {
    state.terminal = vscode.window.createTerminal({ name: 'hydra', cwd: workspaceRoot() });
  }
  state.terminal.show(true);
  return state.terminal;
}

/** Run one of the project's commands in the integrated terminal, with the
 *  compiler this extension resolved rather than whatever `PATH` happens to
 *  offer — a workspace whose binary came from `cargo build` still works. */
function runCli(command, options = {}) {
  const line = cliCommandFor(command, options);
  if (!line) {
    vscode.window.showWarningMessage(`nothing to run for ${command}`);
    return;
  }
  hydraTerminal().sendText(line.replace(/^hydra\b/, compilerLine()));
}

async function createFromTemplate(kind, prompt, placeHolder) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('open the project folder first');
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt,
    placeHolder,
    validateInput: (value) => validateName(value),
  });
  if (name === undefined) return;
  const scaffold = templateFor(kind, name);
  const absolute = path.join(root, scaffold.relPath);
  if (fs.existsSync(absolute)) {
    vscode.window.showWarningMessage(`${scaffold.relPath} already exists`);
    return;
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, scaffold.content);
  const document = await vscode.workspace.openTextDocument(absolute);
  await vscode.window.showTextDocument(document);
  if (scaffold.route) {
    vscode.window.setStatusBarMessage(
      `HydraScript: ${scaffold.relPath} answers ${scaffold.route}`,
      5000,
    );
    log(`created ${scaffold.relPath} -> ${scaffold.route}`);
  }
}

async function formatDocument() {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || !isHydra(document)) {
    vscode.window.showWarningMessage('open a .hyx or .hys file first');
    return;
  }
  // `hydra fmt` rewrites the file on disk, so an unsaved buffer would be the
  // version that survives. Save first, then format.
  if (document.isDirty) await document.save();
  const { bin } = state.compiler || compiler();
  const invocation = compilerInvocation(bin);
  execFile(invocation.command, [...invocation.args, 'fmt', document.uri.fsPath], { env: { ...process.env, ...invocation.env } }, (err, stdout, stderr) => {
    if (err) {
      const reason = (stderr || err.message).trim().split('\n')[0];
      vscode.window.showErrorMessage(`hydra fmt failed: ${reason}`);
      return;
    }
    if (stdout && stdout.trim()) log(stdout.trim());
    vscode.window.setStatusBarMessage(
      `HydraScript: formatted ${path.basename(document.uri.fsPath)}`,
      3000,
    );
  });
}

async function explainRoute() {
  const url = await vscode.window.showInputBox({
    prompt: 'Which URL? `hydra explain` says why it rendered the way it did',
    placeHolder: '/about',
    value: '/',
  });
  if (!url) return;
  runCli('hydra.explain', { url });
}

function registerCommands(context) {
  const register = (id, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('hydra.restartServer', async () => {
    state.restarts = 0;
    await startServer({ restart: true });
  });
  register('hydra.showLog', () => state.channel.show(true));
  register('hydra.build', () => runCli('hydra.build'));
  register('hydra.dev', () => runCli('hydra.dev'));
  register('hydra.serve', () => runCli('hydra.serve'));
  register('hydra.preview', () => runCli('hydra.preview'));
  register('hydra.routes', () => runCli('hydra.routes'));
  register('hydra.doctor', () => runCli('hydra.doctor'));
  register('hydra.stats', () => runCli('hydra.stats'));
  register('hydra.list', () => runCli('hydra.list'));
  register('hydra.test', () => runCli('hydra.test'));
  register('hydra.explain', explainRoute);
  register('hydra.check', () => {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    runCli('hydra.check', { file });
  });
  register('hydra.format', formatDocument);
  register('hydra.newPage', () =>
    createFromTemplate('page', 'New page — its filename is its URL', 'about, or blog/[slug]'),
  );
  register('hydra.newComponent', () =>
    createFromTemplate('component', 'New component', 'Card, UserCard, …'),
  );
  register('hydra.newApiRoute', () =>
    createFromTemplate('api', 'New API route — src/api/<name>.hys', 'hello, or users/[id]'),
  );
  register('hydra.newLoader', () =>
    createFromTemplate('loader', 'Server half for which page?', 'about (for src/pages/about.hyx)'),
  );
  register('hydra.newMiddleware', () =>
    createFromTemplate('middleware', 'Create src/middleware.hys'),
  );
  register('hydra.openDocs', () =>
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/hanxthvy/hydrascript#editor-support')),
  );
}

function registerFileEvents(context) {
  const push = (disposable) => context.subscriptions.push(disposable);
  const noop = { dispose() {} };

  push(vscode.workspace.onDidOpenTextDocument((document) => didOpen(document)));
  push(vscode.workspace.onDidChangeTextDocument((event) => scheduleChange(event.document)));
  push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      flushChange(document);
      if (config().get('checkOnSave', true)) checkDocument(document);
    }),
  );
  push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const timer = state.pendingChanges.get(key);
      if (timer) clearTimeout(timer);
      state.pendingChanges.delete(key);
      state.collection.delete(document.uri);
      if (state.ready) state.client.notify('textDocument/didClose', { textDocument: { uri: key } });
    }),
  );
  push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('hydra.compilerPath') ||
        event.affectsConfiguration('hydra.languageServer')
      ) {
        state.restarts = 0;
        startServer({ restart: true });
      }
    }),
  );

  // A page created outside the editor (`git checkout`, a scaffold command)
  // still has a URL, and saying it in the log is how the file convention
  // becomes obvious instead of tribal knowledge.
  push(
    (vscode.workspace.onDidCreateFiles &&
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) {
          if (!/\.(hyx|hys)$/.test(uri.fsPath)) continue;
          const relative = path.relative(workspaceRoot() || '', uri.fsPath).replace(/\\/g, '/');
          if (relative.startsWith('src/pages/')) log(`route: ${relative} -> ${routeForPath(relative)}`);
          if (relative.startsWith('src/api/')) log(`api: ${relative} -> ${routeForPath(relative)}`);
        }
      })) ||
      noop,
  );
}

function detectVersion() {
  const { bin } = state.compiler || compiler();
  const invocation = compilerInvocation(bin);
  execFile(invocation.command, [...invocation.args, '--version'], { env: { ...process.env, ...invocation.env } }, (err, stdout) => {
    if (err || !stdout) return;
    const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout);
    if (!match) return;
    state.version = match[1];
    setStatus(state.ready ? 'running' : 'starting');
  });
}

// ------------------------------------------------------------------ lifecycle

async function activate(context) {
  state.context = context;
  state.disposing = false;
  state.channel = vscode.window.createOutputChannel('HydraScript');
  context.subscriptions.push(state.channel);
  state.collection = vscode.languages.createDiagnosticCollection('hydra');
  context.subscriptions.push(state.collection);
  state.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  context.subscriptions.push(state.status);
  state.compiler = compiler();

  registerProviders(context);
  registerCommands(context);
  registerFileEvents(context);
  detectVersion();
  setStatus('starting');

  await startServer();
  log(`activated; compiler ${state.compiler.bin} (${state.compiler.source})`);
}

function deactivate() {
  state.disposing = true;
  stopServer();
}

module.exports = { activate, deactivate, parseDiagnostics, routeForPath };
