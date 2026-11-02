// [xihanzu-NR]
/**
 * VS Code language support for HydraScript (.hsx).
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
    path.join(context.extensionPath, 'bin', 'hydra'),
    ...(vscode.workspace.workspaceFolders ?? []).map((f) =>
      path.join(f.uri.fsPath, 'compiler-rs', 'target', 'release', 'hydra'),
    ),
    ...(vscode.workspace.workspaceFolders ?? []).map((f) =>
      path.join(f.uri.fsPath, 'node_modules', 'vite-plugin-hydrascript', 'bin', 'hydra'),
    ),
    'hydra',
  ]
  for (const c of candidates) {
    if (c === 'hydra' || fs.existsSync(c)) return c
  }
  return null
}

/**
 * Turn `hydra check --json -` output into VS Code diagnostics.
 *
 * Was: a regex over the COLOURED stderr, which could only ever report the first
 * problem and broke whenever the compiler's wording changed. `--json` exists for
 * exactly this, so the extension reads data instead of prose.
 *
 * Pure and exported so it can be tested without VS Code.
 */
function parseDiagnostics(jsonText, DocumentRange, Diagnostic, DiagnosticSeverity) {
  const out = []
  for (const line of String(jsonText || '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let d
    try {
      d = JSON.parse(t)
    } catch {
      continue
    }
    const lineIdx = Math.max(0, (d.line ?? 1) - 1)
    const colIdx = Math.max(0, (d.col ?? 1) - 1)
    const sev =
      d.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning
    const diag = new Diagnostic(
      new DocumentRange(lineIdx, colIdx, lineIdx, colIdx + 1),
      d.message || 'problem',
      sev,
    )
    diag.source = 'hydra'
    out.push(diag)
  }
  return out
}

/** Run `hydra check --json -` on a document and publish EVERY diagnostic. */
function diagnose(doc, bin, collection, vscode) {
  if (!['hyx', 'hys', 'hsx', 'hs'].includes(doc.languageId) || !bin) return
  execFile(
    bin,
    ['check', '--json', '-', '--stdin-name', doc.fileName],
    { input: doc.getText(), maxBuffer: 8 * 1024 * 1024 },
    (_err, stdout, stderr) => {
      collection.clear()
      // `check` exits non-zero for an error, so `_err` is expected and not
      // itself a finding. Diagnostics come from stdout; a failure to RUN the
      // compiler is reported as a warning at line 1 so it is visible rather
      // than silently absent.
      const diags = parseDiagnostics(
        stdout,
        vscode.Range,
        vscode.Diagnostic,
        vscode.DiagnosticSeverity,
      )
      if (diags.length > 0) {
        collection.set(doc.uri, diags)
        return
      }
      const ran = stdout && stdout.trim().length > 0
      if (!ran && stderr && stderr.trim() && !/error\(s\) found/.test(stderr)) {
        const d = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `hydra could not run: ${stderr.trim().split('\n')[0]}`,
          vscode.DiagnosticSeverity.Warning,
        )
        d.source = 'hydra'
        collection.set(doc.uri, [d])
      }
    },
  )
}

function activate(context) {
  const bin = findCompiler(context)
  const collection = vscode.languages.createDiagnosticCollection('hydra')
  context.subscriptions.push(collection)

  if (bin) {
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((d) => diagnose(d, bin, collection, vscode)),
      vscode.workspace.onDidSaveTextDocument((d) => diagnose(d, bin, collection, vscode)),
      vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    )
    for (const d of vscode.workspace.textDocuments) diagnose(d, bin, collection, vscode)
  }
}

function deactivate() {}

module.exports = { activate, deactivate, parseDiagnostics }
