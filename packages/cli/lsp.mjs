// [xihanzu-NR]
/**
 * `hydra-lsp` — a language server for HydraScript.
 *
 * What this is, precisely, because the project has a history of documents that
 * described this as if it existed and it did not:
 *
 *   REAL  — `initialize`, `shutdown`, `exit`, and the LSP framing
 *           (`Content-Length` headers over stdio), so an editor can actually
 *           start it and stop it.
 *   REAL  — `textDocument/publishDiagnostics` from the compiler's own parser and
 *           semantic checker. These are the compiler's messages, not a second
 *           implementation that can disagree with it.
 *   REAL  — `textDocument/hover`: the source line under the cursor and, for a
 *           name, where it is declared in the same file.
 *   REAL  — `textDocument/definition`: the declaration of an identifier in the
 *           same file, or a jump to a relative import's file.
 *   REAL  — `textDocument/rename`, limited to identifiers declared and used in
 *           ONE file. It refuses a rename it cannot do completely, which is the
 *           difference between a rename and a corruption.
 *
 * NOT here, and said so rather than implied: cross-file rename, completion,
 * signature help, formatting, semantic tokens, workspace symbols. Each is a
 * feature with its own correctness argument, and a half-done one is worse than
 * an absent one because the editor presents it as working.
 *
 * The analysis is regex-and-line based over the source text. That is honest for
 * a language whose syntax is line-oriented with indentation: an identifier is
 * `[A-Za-z_][A-Za-z0-9_]*`, a declaration is `def`/`class`/`component`/an
 * assignment at the start of a line. It is not a second parser; the compiler
 * owns that, and this asks IT for diagnostics.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The two LSP endpoints every client must have. */
export const PROTOCOL_VERSION = '3.17';

/**
 * Find the compiler binary.
 *
 * `HYDRA_COMPILER` wins, then the packaged binary beside this file. Returning
 * null is not an error: diagnostics are skipped and everything else still works,
 * because an editor that cannot check names is still better than one that
 * cannot open the file.
 */
export function findCompiler() {
  const env = process.env.HYDRA_COMPILER;
  if (env && fs.existsSync(env)) return env;
  for (const rel of ['../../bin/hydra', '../bin/hydra']) {
    const p = path.resolve(HERE, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * The compiler's own diagnostics for a source, via `hydra check --json`.
 *
 * Asking the compiler, not reimplementing it: a language server that disagrees
 * with the build is worse than no language server, because it teaches the
 * developer to distrust both.
 */
export function diagnosticsFor(uri, text, { compiler = findCompiler() } = {}) {
  if (!compiler) return [];
  const file = uriToPath(uri);
  let out;
  try {
    out = spawnSync(compiler, ['check', '--json', '-'], {
      input: text,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const raw = (out.stdout || '').trim();
  if (!raw) {
    // A parse error goes to stderr/plain stdout; without JSON there is nothing
    // structured to publish, and inventing a position would put a squiggle in
    // the wrong place.
    return [];
  }
  // The JSON may be one array or one object per line; accept both.
  const items = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) items.push(...parsed);
      else items.push(parsed);
    } catch {
      /* a non-JSON line is not a diagnostic */
    }
  }
  void file;
  return items.map((d) => {
    const line = Math.max(0, (d.line ?? 1) - 1);
    const col = Math.max(0, (d.col ?? 1) - 1);
    return {
      range: {
        start: { line, character: col },
        end: { line, character: col + Math.max(1, String(d.text || d.message || '').length) },
      },
      severity: d.severity === 'error' ? 1 : 2,
      source: 'hydra',
      message: String(d.message || d.text || 'problem'),
    };
  });
}

/* ------------------------------------------------------------------ text work
 *
 * Line-oriented analysis. Every function here is pure and takes the text, so it
 * can be tested without a language client.
 */

/** Is this character part of an identifier? */
export function isIdentChar(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

/** The identifier at a position, or null. */
export function identifierAt(text, line, character) {
  const lines = text.split('\n');
  const src = lines[line];
  if (src === undefined) return null;
  let start = character;
  let end = character;
  while (start > 0 && isIdentChar(src[start - 1])) start -= 1;
  while (end < src.length && isIdentChar(src[end])) end += 1;
  if (start === end) return null;
  const word = src.slice(start, end);
  if (!/^[A-Za-z_]/.test(word)) return null;
  return { word, start, end, line };
}

/** Declaration patterns, in the order they are tried. */
const DECLARATIONS = [
  /^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/,
  /^\s*(?:export\s+)?component\s+([A-Za-z_][A-Za-z0-9_]*)/,
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^=]/, // a simple assignment
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,.*=\s/, // `a, b = ...`
];

/**
 * Every declaration of `name` in this file: the line, and a one-line summary.
 *
 * The FIRST match is the definition a jump goes to. Several matches are kept
 * because a rename needs them all, and shadowing inside a function is normal in
 * this language.
 */
export function declarationsOf(text, name) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of DECLARATIONS) {
      const m = re.exec(lines[i]);
      if (m && m[1] === name) {
        out.push({
          line: i,
          character: lines[i].indexOf(name),
          signature: lines[i].trim(),
          indent: lines[i].length - lines[i].trimStart().length,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Every whole-word use of `name` in this file, declarations included.
 *
 * Whole-word, so renaming `data` does not touch `metadata`. This is the reason
 * the search is not a naive `indexOf`.
 */
export function usesOf(text, name) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let from = 0;
    for (;;) {
      const at = lines[i].indexOf(name, from);
      if (at === -1) break;
      const before = at === 0 ? '' : lines[i][at - 1];
      const after = lines[i][at + name.length] ?? '';
      if (!isIdentChar(before) && !isIdentChar(after)) {
        out.push({ line: i, start: at, end: at + name.length });
      }
      from = at + name.length;
    }
  }
  return out;
}

/** Imports in the file: `from "<spec>" import a, b`. */
export function importsOf(text) {
  const out = [];
  const lines = text.split('\n');
  const re = /^\s*(?:from\s+["']([^"']+)["']\s+import\s+(.+?)|import\s+["']([^"']+)["'])\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const spec = m[1] || m[3];
    const names = m[2]
      ? m[2]
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/).pop().trim())
          .filter(Boolean)
      : [];
    out.push({ line: i, spec, names });
  }
  return out;
}

/** Resolve a relative import specifier against the importing file's path. */
export function resolveImport(fromPath, spec) {
  if (!spec || !(spec.startsWith('./') || spec.startsWith('../'))) return null;
  const base = path.resolve(path.dirname(fromPath), spec);
  const EXTS = ['.hyx', '.hys', '.hsx', '.hs', '.hx', '.tsx', '.ts', '.jsx', '.js', '.mjs', ''];
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  for (const ext of EXTS) {
    const candidate = path.join(base, 'index' + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** What to show on hover. */
export function hoverFor(text, line, character) {
  const id = identifierAt(text, line, character);
  if (!id) {
    const src = text.split('\n')[line] || '';
    if (!src.trim()) return null;
    return { contents: { kind: 'markdown', value: '```hydrascript\n' + src.trim() + '\n```' } };
  }
  const decls = declarationsOf(text, id.word);
  const imported = importsOf(text).find((i) => i.names.includes(id.word));
  const parts = [];
  if (decls.length > 0) {
    parts.push('```hydrascript\n' + decls[0].signature + '\n```');
    parts.push(
      decls.length === 1
        ? 'declared on line ' + (decls[0].line + 1)
        : `declared ${decls.length} times; the first is line ${decls[0].line + 1}`,
    );
  } else if (imported) {
    parts.push('```hydrascript\n' + (text.split('\n')[imported.line] || '').trim() + '\n```');
    parts.push(`imported from \`${imported.spec}\``);
  } else {
    parts.push(`\`${id.word}\``);
    parts.push('no declaration and no import in this file — the build will say so as `unbound`');
  }
  return {
    contents: { kind: 'markdown', value: parts.join('\n\n') },
    range: {
      start: { line: id.line, character: id.start },
      end: { line: id.line, character: id.end },
    },
  };
}

/** Where a definition jump goes, or null. */
export function definitionFor(
  text,
  filePath,
  line,
  character,
  { readFile = (p) => fs.readFileSync(p, 'utf8'), resolve = resolveImport } = {},
) {
  const id = identifierAt(text, line, character);
  if (!id) return null;
  const here = declarationsOf(text, id.word);
  if (here.length > 0) {
    return {
      uri: pathToUri(filePath),
      range: {
        start: { line: here[0].line, character: here[0].character },
        end: { line: here[0].line, character: here[0].character + id.word.length },
      },
    };
  }
  const imported = importsOf(text).find((i) => i.names.includes(id.word));
  if (!imported) return null;
  const target = resolve(filePath, imported.spec);
  if (!target) return null;
  let other;
  try {
    other = readFile(target);
  } catch {
    return null;
  }
  const there = declarationsOf(other, id.word);
  if (there.length === 0) return null;
  return {
    uri: pathToUri(target),
    range: {
      start: { line: there[0].line, character: there[0].character },
      end: { line: there[0].line, character: there[0].character + id.word.length },
    },
  };
}

/**
 * The edits a rename would make, or a refusal.
 *
 * Refuses when the name is imported: renaming the local binding would leave the
 * import line naming something the module no longer exports, and this server
 * does not edit other files. Saying `null` and a reason is the whole design —
 * an editor that silently half-renames is how a refactor breaks a build.
 */
export function renameFor(text, line, character, newName) {
  const id = identifierAt(text, line, character);
  if (!id) return { error: 'no identifier under the cursor' };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
    return { error: `\`${newName}\` is not a valid identifier` };
  }
  if (id.word === newName) return { edits: [] };
  const imported = importsOf(text).find((i) => i.names.includes(id.word));
  if (imported) {
    return {
      error:
        `\`${id.word}\` is imported from \`${imported.spec}\`. ` +
        'Renaming the local name would leave the import broken and this server does not edit other files. ' +
        'Rename it where it is declared, or alias it: `from "' +
        imported.spec +
        '" import other as ' +
        newName +
        '`.',
    };
  }
  const uses = usesOf(text, id.word);
  if (uses.length === 0) return { error: `no occurrences of \`${id.word}\`` };
  return {
    edits: uses.map((u) => ({
      range: {
        start: { line: u.line, character: u.start },
        end: { line: u.line, character: u.end },
      },
      newText: newName,
    })),
  };
}

/* ------------------------------------------------------------------- protocol */

/** `file:///...` for a path, percent-encoded where it must be. */
export function pathToUri(p) {
  const abs = path.resolve(p).split(path.sep).join('/');
  return 'file://' + abs.split('/').map(encodeURIComponent).join('/');
}

/** The path behind a `file://` URI. */
export function uriToPath(uri) {
  const bare = String(uri).replace(/^file:\/\//, '');
  return decodeURIComponent(bare);
}

/**
 * Apply a JSON-RPC message to the server's state and produce the responses.
 *
 * Kept as a pure-ish function so the protocol can be tested without a pipe: the
 * framing is a separate concern from the behaviour, and mixing them is how a
 * server ends up only testable by hand through an editor.
 */
export function handleMessage(msg, state, io) {
  const { method, id, params } = msg || {};
  const respond = (result) => io.send({ jsonrpc: '2.0', id, result });
  const respondError = (code, message) => io.send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const rootUri = params?.rootUri || params?.workspaceFolders?.[0]?.uri;
      state.root = rootUri ? uriToPath(rootUri) : process.cwd();
      respond({
        capabilities: {
          textDocumentSync: 1, // full
          hoverProvider: true,
          definitionProvider: true,
          renameProvider: true,
        },
        serverInfo: { name: 'hydra-lsp', version: state.version || '0.0.0' },
      });
      return;
    }
    case 'initialized':
      return;
    case 'shutdown':
      state.shuttingDown = true;
      respond(null);
      return;
    case 'exit':
      state.exiting = true;
      return;
    case 'textDocument/didOpen': {
      const { uri, text } = params.textDocument;
      state.docs.set(uri, text);
      publishDiagnostics(uri, text, state, io);
      return;
    }
    case 'textDocument/didChange': {
      const uri = params.textDocument.uri;
      const change = params.contentChanges[params.contentChanges.length - 1];
      state.docs.set(uri, change.text);
      publishDiagnostics(uri, change.text, state, io);
      return;
    }
    case 'textDocument/didClose': {
      const uri = params.textDocument.uri;
      state.docs.delete(uri);
      io.send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri, diagnostics: [] },
      });
      return;
    }
    case 'textDocument/hover': {
      const text = state.docs.get(params.textDocument.uri);
      if (text === undefined) return respond(null);
      const { line, character } = params.position;
      respond(hoverFor(text, line, character));
      return;
    }
    case 'textDocument/definition': {
      const uri = params.textDocument.uri;
      const text = state.docs.get(uri);
      if (text === undefined) return respond(null);
      const { line, character } = params.position;
      const hit = definitionFor(text, uriToPath(uri), line, character, {
        readFile: (p) => fs.readFileSync(p, 'utf8'),
      });
      respond(hit ? [hit] : null);
      return;
    }
    case 'textDocument/rename': {
      const text = state.docs.get(params.textDocument.uri);
      if (text === undefined) return respond(null);
      const { line, character } = params.position;
      const out = renameFor(text, line, character, params.newName);
      if (out.error) {
        respondError(-32602, out.error);
        return;
      }
      respond({ changes: { [params.textDocument.uri]: out.edits } });
      return;
    }
    default:
      // A request we do not implement gets an explicit "method not found" rather
      // than silence, which an editor would wait on forever.
      if (id !== undefined) respondError(-32601, `method not found: ${method}`);
  }
}

/** Ask the compiler and publish what it says. */
function publishDiagnostics(uri, text, state, io) {
  const diagnostics = diagnosticsFor(uri, text, { compiler: state.compiler });
  io.send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics },
  });
}

/** The state a server run needs. */
export function newState({ compiler = findCompiler(), version = '' } = {}) {
  return { docs: new Map(), root: process.cwd(), compiler, version, shuttingDown: false, exiting: false };
}

/**
 * Run the server over a pair of streams.
 *
 * Framing, per the spec: `Content-Length: N\r\n\r\n` then exactly N bytes of
 * UTF-8 JSON. Reading by lines would break on a multi-byte character straddling
 * a chunk, which is a real bug and not a theoretical one.
 */
export async function serve(stdin, stdout, { compiler = findCompiler(), version = '' } = {}) {
  const state = newState({ compiler, version });
  const io = {
    send(message) {
      const body = Buffer.from(JSON.stringify(message), 'utf8');
      stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
      stdout.write(body);
    },
  };

  let buffer = Buffer.alloc(0);
  return await new Promise((resolve) => {
    stdin.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.slice(0, headerEnd).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          // Unparseable header: drop it and carry on rather than wedging.
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const len = Number(m[1]);
        const start = headerEnd + 4;
        if (buffer.length - start < len) return;
        const body = buffer.slice(start, start + len).toString('utf8');
        buffer = buffer.slice(start + len);
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          io.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          continue;
        }
        handleMessage(msg, state, io);
        if (state.exiting) {
          resolve(0);
          return;
        }
      }
    });
    stdin.on('end', () => resolve(0));
  });
}
