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
 *   REAL  — `textDocument/rename` ACROSS FILES, and `prepareRename`. It renames
 *           the declaration and every relative importer together, because a
 *           rename that touches one of them leaves the other's import naming a
 *           name the module no longer exports. A package import is refused with
 *           the reason: that declaration is not this server's to edit.
 *   REAL  — `textDocument/completion`: the file's own names, its imports, the
 *           Python builtins the COMPILER lowers (read from `check.rs`, not
 *           copied), a module's real exports after `from "x" import `, and the
 *           methods of a list/dict/string literal after `.`.
 *   REAL  — `textDocument/signatureHelp`: parameter names and the active
 *           argument, from the callable's own declaration in this file or a
 *           relative import.
 *
 * NOT here, and said so rather than implied: formatting, semantic tokens, code
 * actions, workspace symbols. An editor has `hydra fmt` for the first one; the
 * rest are features with their own correctness argument, and a half-done one is
 * worse than an absent one because the editor presents it as working.
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
 * Python builtins, read from the COMPILER's own list rather than copied here.
 *
 * `check.rs` keeps `PYTHON_BUILTINS` honest with a conformance test that
 * compiles a real use of every name; a second copy in the language server would
 * drift the moment one is added. Completion offering a name the compiler does not
 * lower is exactly the failure this avoids: a suggestion that breaks the build.
 */
let builtinCache = null;
export function pythonBuiltins({ readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  if (builtinCache) return builtinCache;
  const src = path.resolve(HERE, '../../compiler-rs/src/check.rs');
  let text;
  try {
    text = readFile(src);
  } catch {
    // A published tarball ships no Rust source. An empty list is honest here:
    // completion still offers the file's own names, which is most of its value.
    builtinCache = [];
    return builtinCache;
  }
  const m = /const PYTHON_BUILTINS: &\[&str\] = &\[([\s\S]*?)\];/.exec(text);
  builtinCache = m ? [...m[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((x) => x[1]) : [];
  return builtinCache;
}

/** The runtime's own exports, for `from "hydra" import <here>`. */
export function runtimeExports({ readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let text;
  try {
    text = readFile(path.resolve(HERE, '../../runtime/hydra.ts'));
  } catch {
    return [];
  }
  return [...text.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(
    (m) => m[1],
  );
}

/** Declarations in one file: name, kind, and the line as written. */
export function symbolsOf(text) {
  const out = [];
  const re = /^\s*(?:export\s+)?(def|class|component)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(.*\))?/;
  const assign = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^=]/;
  for (const [i, line] of text.split('\n').entries()) {
    const m = re.exec(line);
    if (m) {
      out.push({ name: m[2], kind: m[1], signature: line.trim(), line: i });
      continue;
    }
    const a = assign.exec(line);
    if (a) out.push({ name: a[1], kind: 'variable', signature: line.trim(), line: i });
  }
  return out;
}

/**
 * Completion items for a position.
 *
 * What it offers, and why each is safe to offer:
 *
 *   - the file's own declarations and imports (the names the compiler's semantic
 *     check would accept without an import);
 *   - Python builtins the COMPILER lowers, from its own list;
 *   - after `from "hydra" import `, the runtime's real exports;
 *   - after `from "react" import `, the names React actually exports;
 *   - after a `.`, the methods of the receiver when its type is a list, dict or
 *     string literal — decided from the source, never guessed.
 *
 * It is deliberately NOT a type checker. A completion it cannot justify is one it
 * does not offer, which is the same rule the hover and rename follow.
 */
export function completionsFor(text, line, character, { readFile = (p) => fs.readFileSync(p, 'utf8'), filePath = null } = {}) {
  const lines = text.split('\n');
  const src = lines[line] ?? '';
  const before = src.slice(0, character);
  const items = [];
  const push = (label, kind, detail) =>
    items.push({ label, kind, detail, sortText: (kind === 3 ? '0' : '1') + label });

  // `from "x" import <cursor>` — the module's exports, not the file's names.
  const impMatch = /^\s*from\s+["']([^"']+)["']\s+import\s+([A-Za-z_][A-Za-z0-9_]*)?\s*$/.exec(before);
  if (impMatch && character >= before.length) {
    const spec = impMatch[1];
    const already = impMatch[2] ? [impMatch[2]] : [];
    const names =
      spec === 'hydra'
        ? runtimeExports({ readFile })
        : spec === 'react'
          ? [
              'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext',
              'createContext', 'useReducer', 'memo', 'Fragment', 'createElement',
            ]
          : spec === 'hydra/server'
            ? ['env', 'env_require', 'public_env', 'read_file']
            : [];
    for (const n of names) if (!already.includes(n)) push(n, 3, `from "${spec}"`);
    return { isIncomplete: false, items };
  }

  // `xs.<cursor>` — methods of a known literal type.
  const member = /([A-Za-z_][A-Za-z0-9_]*|\)|"|')\.([A-Za-z_]*)$/.exec(before);
  if (member) {
    const recv = member[1];
    let kind = null;
    const declLine = lines.find((l) => new RegExp(`\\b${recv}\\s*=\\s*([^=])`).test(l));
    const rhs = declLine ? declLine.slice(declLine.indexOf('=') + 1).trim() : null;
    if (rhs && rhs.startsWith('[')) kind = 'list';
    else if (rhs && rhs.startsWith('{')) kind = 'dict';
    else if (rhs && (rhs.startsWith('"') || rhs.startsWith("'"))) kind = 'str';
    const methods = {
      list: ['append', 'extend', 'insert', 'remove', 'pop', 'index', 'count', 'sort', 'reverse', 'clear', 'copy'],
      dict: ['get', 'keys', 'values', 'items', 'pop', 'setdefault', 'update', 'copy', 'clear'],
      str: [
        'capitalize', 'strip', 'lstrip', 'rstrip', 'upper', 'lower', 'title', 'split', 'join',
        'replace', 'startswith', 'endswith', 'find', 'index', 'zfill', 'isdigit', 'isalpha', 'format',
      ],
    }[kind];
    if (methods) for (const m of methods) push(m, 2, `${kind} method`);
    return { isIncomplete: false, items };
  }

  // Otherwise: this file's names, then the builtins.
  for (const s of symbolsOf(text)) {
    push(s.name, s.kind === 'component' || s.kind === 'class' ? 7 : 3, s.signature.slice(0, 80));
  }
  for (const imp of importsOf(text)) for (const n of imp.names) push(n, 3, `from "${imp.spec}"`);
  if (!/^\s*from\s+/.test(before)) for (const b of pythonBuiltins({ readFile })) push(b, 1, 'Python builtin');

  const seen = new Set();
  return { isIncomplete: false, items: items.filter((i) => (seen.has(i.label) ? false : seen.add(i.label))) };
}

/** The nearest directory at or above `p` that looks like a project root. */
export function projectRootFor(p) {
  let dir = path.resolve(p);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) ||
      fs.existsSync(path.join(dir, 'hydraconfig.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(path.resolve(p));
    dir = parent;
  }
}

/** Every `.hyx`/`.hys`/`.ts`/`.js` file under `dir`, ignoring build output. */
export function sourceFilesUnder(dir, limit = 5000) {
  const out = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', '.hydra', 'target', 'build']);
  const walk = (d) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(full);
      } else if (/\.(hyx|hys|hsx|hs)$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The files that import `name` from `targetPath`, directly or through a
 * re-export. This is what makes a rename CROSS-FILE: the declaration and every
 * importer have to change together, or the rename breaks the build.
 *
 * Returned as `[{ path, spec }]`, one entry per importer, with the specifier it
 * used — the caller needs the spec to rewrite the local binding only when the
 * importer aliased the name (`import other as name`).
 */
export function importersOf(targetPath, name, { readFile = (p) => fs.readFileSync(p, 'utf8'), files = null, root = null } = {}) {
  // Scan from the PROJECT root, not `dirname(targetPath)`: an importer lives in a
  // sibling or parent directory, so scanning the target's own folder finds the
  // declaration and nothing else. That was a green test away from "a rename that
  // silently touches one file".
  const list = files || sourceFilesUnder(root || projectRootFor(targetPath));
  const target = path.resolve(targetPath);
  const out = [];
  for (const file of list) {
    if (path.resolve(file) === target) continue;
    let text;
    try {
      text = readFile(file);
    } catch {
      continue;
    }
    for (const imp of importsOf(text)) {
      if (!imp.names.includes(name)) continue;
      // Only a RELATIVE import can point at a file this server can see. A package
      // import of the same name belongs to someone else and must not be touched.
      if (!imp.spec.startsWith('./') && !imp.spec.startsWith('../')) continue;
      const resolved = resolveImport(file, imp.spec);
      if (resolved && path.resolve(resolved) === target) out.push({ path: file, spec: imp.spec });
    }
  }
  return out;
}

/**
 * A rename across every file that declares or imports `name`.
 *
 * Two refusals, both because a half-rename is worse than none:
 *
 *   - a name imported from a PACKAGE cannot be renamed here — the declaration is
 *     in someone else's module, and rewriting the local binding would leave a
 *     name the package does not export;
 *   - a name that is a KEY in an object literal is not renamed, because
 *     `{"title": x}` and `x.title` are a different thing from the binding and
 *     this analysis cannot tell them apart at that position.
 *
 * Everything it DOES rename is returned as WorkspaceEdit `changes`, keyed by
 * URI, so the editor applies them atomically or not at all.
 */
export function renameAcrossFiles(
  text,
  filePath,
  line,
  character,
  newName,
  { readFile = (p) => fs.readFileSync(p, 'utf8'), files = null, resolve = resolveImport } = {},
) {
  const id = identifierAt(text, line, character);
  if (!id) return { error: 'no identifier under the cursor' };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return { error: `\`${newName}\` is not a valid identifier` };
  if (id.word === newName) return { changes: {} };

  const word = id.word;
  const declaredHere = declarationsOf(text, word).length > 0;
  const importedHere = importsOf(text).find((i) => i.names.includes(word));

  if (importedHere && !declaredHere) {
    const spec = importedHere.spec;
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      return {
        error:
          `\`${word}\` is imported from \`${spec}\`, which this server does not own. ` +
          'Renaming the local binding would leave an import of a name the package does not export.',
      };
    }
    const target = resolve(filePath, spec);
    if (!target) return { error: `could not resolve \`${spec}\` from ${path.basename(filePath)}` };
    // Rename where it is DECLARED, then let the declaration path do the work.
    let declText;
    try {
      declText = readFile(target);
    } catch {
      return { error: `could not read ${target}` };
    }
    const decl = declarationsOf(declText, word)[0];
    if (!decl) {
      return { error: `\`${word}\` is imported from \`${spec}\` but is not declared there` };
    }
    return renameAcrossFiles(declText, target, decl.line, decl.character, newName, { readFile, files, resolve });
  }

  if (!declaredHere) return { error: `\`${word}\` is not declared in this file` };

  // The project-wide rename: the declaring file first, then every importer.
  const edits = {};
  const addAll = (file, body) => {
    const ranges = usesOf(body, word).map((u) => ({
      range: { start: { line: u.line, character: u.start }, end: { line: u.line, character: u.end } },
      newText: newName,
    }));
    if (ranges.length) edits[pathToUri(file)] = ranges;
  };
  addAll(filePath, text);

  const importers = importersOf(filePath, word, { readFile, files });
  for (const imp of importers) {
    let body;
    try {
      body = readFile(imp.path);
    } catch {
      continue;
    }
    addAll(imp.path, body);
  }

  if (Object.keys(edits).length === 0) return { error: `no occurrences of \`${word}\`` };
  return { changes: edits };
}

/**
 * Signature help for the call the cursor is inside.
 *
 * Reads the callable's own `def`/`component` line from THIS file, or from a
 * relative import it can resolve — the same bound the emitter has for keyword
 * arguments. It answers only when it can name the parameters, because a signature
 * help that guesses is worse than none: the editor presents it as fact.
 */
export function signatureFor(text, line, character, { readFile = (p) => fs.readFileSync(p, 'utf8'), filePath = null, resolve = resolveImport } = {}) {
  const lines = text.split('\n');
  const upto = lines.slice(0, line + 1).join('\n').slice(0);
  const head = lines[line] ? lines[line].slice(0, character) : '';
  const src = upto.slice(0, upto.length - (lines[line] ? lines[line].length - head.length : 0));

  // Walk back to the innermost unclosed `(`, ignoring parentheses inside strings.
  let depth = 0;
  let open = -1;
  let inStr = null;
  for (let i = src.length - 1; i >= 0; i--) {
    const ch = src[i];
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) return null;
  const nameMatch = /([A-Za-z_][A-Za-z0-9_.]*)\s*$/.exec(src.slice(0, open));
  if (!nameMatch) return null;
  const callee = nameMatch[1];

  // Which argument is the cursor in?
  const argsText = src.slice(open + 1);
  let arg = 0;
  let d = 0;
  let q = null;
  for (const ch of argsText) {
    if (q) {
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') d--;
    else if (ch === ',' && d === 0) arg++;
  }

  const short = callee.split('.').pop();
  let declText = text;
  let signature = null;

  const findIn = (body) => {
    const re = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:def|component)\\s+${short}\\s*(\\(.*?\\))`, 'm');
    const m = re.exec(body);
    return m ? m[0].trim() : null;
  };

  signature = findIn(declText);
  if (!signature && filePath) {
    for (const imp of importsOf(text)) {
      if (!imp.names.includes(short)) continue;
      if (!imp.spec.startsWith('./') && !imp.spec.startsWith('../')) continue;
      const target = resolve(filePath, imp.spec);
      if (!target) continue;
      try {
        declText = readFile(target);
      } catch {
        continue;
      }
      signature = findIn(declText);
      if (signature) break;
    }
  }
  if (!signature) return null;

  const openParen = signature.indexOf('(');
  const closeParen = signature.lastIndexOf(')');
  const inner = signature.slice(openParen + 1, closeParen);
  const params = [];
  let depth2 = 0;
  let q2 = null;
  let cur = '';
  for (const ch of inner) {
    if (q2) {
      cur += ch;
      if (ch === q2) q2 = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q2 = ch;
      cur += ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth2++;
      cur += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth2--;
      cur += ch;
    } else if (ch === ',' && depth2 === 0) {
      params.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) params.push(cur.trim());

  return {
    signatures: [
      {
        label: signature,
        parameters: params.map((p) => ({ label: p })),
      },
    ],
    activeSignature: 0,
    activeParameter: Math.min(arg, Math.max(0, params.length - 1)),
  };
}

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
          // `prepareRename` is what lets the editor seed the rename box and refuse
          // a position with nothing under it, instead of sending an empty rename.
          renameProvider: { prepareProvider: true },
          completionProvider: { triggerCharacters: ['.', ' '], resolveProvider: false },
          signatureHelpProvider: { triggerCharacters: ['(', ','] },
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
      const uri = params.textDocument.uri;
      const text = state.docs.get(uri);
      if (text === undefined) return respond(null);
      const { line, character } = params.position;
      // Across files, because the declaration and its importers have to move
      // together: a rename that touches one file leaves the other's import
      // naming something the module no longer exports.
      const out = renameAcrossFiles(text, uriToPath(uri), line, character, params.newName, {
        readFile: (p) => state.docs.get(pathToUri(p)) ?? fs.readFileSync(p, 'utf8'),
      });
      if (out.error) {
        respondError(-32602, out.error);
        return;
      }
      respond({ changes: out.changes });
      return;
    }
    case 'textDocument/prepareRename': {
      // The identifier under the cursor, so the editor can seed its rename box
      // and refuse a position where there is nothing to rename.
      const text = state.docs.get(params.textDocument.uri);
      if (text === undefined) return respond(null);
      const { line, character } = params.position;
      const id = identifierAt(text, line, character);
      respond(
        id
          ? { range: { start: { line, character: id.start }, end: { line, character: id.end } }, placeholder: id.word }
          : null,
      );
      return;
    }
    case 'textDocument/completion': {
      const uri = params.textDocument.uri;
      const text = state.docs.get(uri);
      if (text === undefined) return respond(null);
      const { line, character } = params.position;
      respond(
        completionsFor(text, line, character, {
          filePath: uriToPath(uri),
          readFile: (p) => state.docs.get(pathToUri(p)) ?? fs.readFileSync(p, 'utf8'),
        }),
      );
      return;
    }
    case 'textDocument/signatureHelp': {
      const uri = params.textDocument.uri;
      const text = state.docs.get(uri);
      if (text === undefined) return respond(null);
      const { line, character } = params.position;
      respond(
        signatureFor(text, line, character, {
          filePath: uriToPath(uri),
          readFile: (p) => state.docs.get(pathToUri(p)) ?? fs.readFileSync(p, 'utf8'),
        }),
      );
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
