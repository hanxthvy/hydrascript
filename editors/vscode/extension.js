// [xihanzu-NR]
/**
 * VS Code language support for Serpent (.hsx).
 *
 * Deliberately thin: a TextMate grammar for colour and a tiny LSP-shaped
 * diagnostics client that shells out to the native compiler. No language server
 * process, no node_modules in the extension — the compiler binary is the server.
 */
const vscode = require('vscode')
const { execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

/** Find the compiler binary: bundled first, then the workspace, then PATH. */
function findCompiler(context) {
  const candidates = [
    path.join(context.extensionPath, 'bin', 'serpent'),
    ...(vscode.workspace.workspaceFolders ?? []).map((f) =>
      path.join(f.uri.fsPath, 'compiler-rs', 'target', 'release', 'serpent'),
    ),
    ...(vscode.workspace.workspaceFolders ?? []).map((f) =>
      path.join(f.uri.fsPath, 'node_modules', 'vite-plugin-serpent', 'bin', 'serpent'),
    ),
    'serpent',
  ]
  for (const c of candidates) {
    if (c === 'serpent' || fs.existsSync(c)) return c
  }
  return null
}

/** Run `serpent --check` on a document and turn stderr into diagnostics. */
function diagnose(doc, bin, collection) {
  if (doc.languageId !== 'hsx' || !bin) return
  execFile(bin, ['--check', '--stdin', doc.fileName], { input: doc.getText() }, (err, _out, stderr) => {
    collection.clear()
    if (!err || !stderr) return
    // Compiler output:  error: <msg>\n  --> line N, col M\n ...
    const m = /error:\s*(.+)\n\s*-->\s*line\s+(\d+),\s*col\s+(\d+)/.exec(stderr)
    if (!m) return
    const line = Math.max(0, parseInt(m[2], 10) - 1)
    const col = Math.max(0, parseInt(m[3], 10) - 1)
    const hint = /hint:\s*(.+)/.exec(stderr)
    const diag = new vscode.Diagnostic(
      new vscode.Range(line, col, line, col + 1),
      hint ? `${m[1]}\n${hint[1]}` : m[1],
      vscode.DiagnosticSeverity.Error,
    )
    diag.source = 'serpent'
    collection.set(doc.uri, [diag])
  })
}

function activate(context) {
  const bin = findCompiler(context)
  const collection = vscode.languages.createDiagnosticCollection('serpent')
  context.subscriptions.push(collection)

  if (bin) {
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((d) => diagnose(d, bin, collection)),
      vscode.workspace.onDidSaveTextDocument((d) => diagnose(d, bin, collection)),
      vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    )
    for (const d of vscode.workspace.textDocuments) diagnose(d, bin, collection)
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
