// [xihanzu-NR]
/**
 * Build-time checks that need the source, not the bundle.
 *
 * Three of them, and they share one reason to exist: this framework owns its
 * parser, so the facts below are knowable BEFORE anything is bundled, and every
 * one of them is a question a project asks too late otherwise.
 *
 *   - **Architecture rules** — "nothing in `src/pages` may import `src/db`".
 *     NestJS enforces module boundaries at runtime through its container;
 *     ESLint can enforce some of it, but it is blind to `.hys` and to what the
 *     compiler does with an import. This reads the import lines and the resolved
 *     paths, and fails the build with both file names.
 *   - **i18n extraction** — every `t("key")` in the source becomes a catalog
 *     entry, so a missing key is a build error instead of a raw key rendered to
 *     a visitor.
 *   - **Dead code** — a `.hyx` under `src/` that nothing imports and no route
 *     owns is a component nobody can reach.
 *
 * The import scan is LINE-BASED on purpose and the limit is stated rather than
 * hidden: in this language an import is one line at the top of a file
 * (`from "..." import x`), a `__import__("...")` is a string literal on one line,
 * and a computed specifier cannot be resolved by any tool. A false negative is
 * therefore possible for a computed import; a false positive is not.
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_RE = /\.(hyx|hys)$/;

/** Every source file under `src/`, excluding generated and dependency trees. */
export function sourceFiles(cwd) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_RE.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(cwd, 'src'));
  return out.sort();
}

/**
 * The import specifiers of one file, in order.
 *
 * `from "x" import y` and `import "x"` are both the language's own forms; a
 * dynamic `__import__("x")` is included because it is a real edge in the graph.
 */
export function importsOf(text) {
  const out = [];
  const re = /^\s*from\s+["']([^"']+)["']\s+import\b|^\s*import\s+["']([^"']+)["']|__import__\(\s*["']([^"']+)["']/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) out.push(spec);
  }
  return out;
}

/** Resolve a relative specifier to a file on disk, trying the source extensions. */
export function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.hyx`, `${base}.hys`, path.join(base, 'index.hyx'), path.join(base, 'index.hys')];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/**
 * `architecture.rules` from `hydraconfig.json`, applied.
 *
 * A rule is `"<layer> -> <layer>"` (allowed) or `"<layer> -/-> <layer>"`
 * (forbidden), and a layer is a directory in `architecture.layers`. Only
 * forbidden edges are errors; an ALLOWED list would need "everything else is
 * forbidden", which is a bigger promise than this makes.
 *
 * @returns {{violations: {from: string, to: string, rule: string}[], scanned: number}}
 */
export function checkArchitecture(cwd, config) {
  const arch = config && config.architecture;
  if (!arch || typeof arch !== 'object' || !arch.layers) return { violations: [], scanned: 0 };
  const layers = Object.entries(arch.layers)
    .map(([name, dir]) => ({ name, dir: path.resolve(cwd, String(dir)) }))
    .sort((a, b) => b.dir.length - a.dir.length); // deepest first, so nesting works
  const rules = Array.isArray(arch.rules) ? arch.rules.map(String) : [];
  const forbidden = [];
  for (const rule of rules) {
    const m = /^\s*(\w+)\s*-?\/?->\s*(\w+)\s*$/.exec(rule);
    if (!m) continue;
    if (rule.includes('-/->')) forbidden.push({ from: m[1], to: m[2] });
  }
  if (forbidden.length === 0) return { violations: [], scanned: 0 };

  const layerOf = (file) => {
    for (const l of layers) {
      if (file === l.dir || file.startsWith(l.dir + path.sep)) return l.name;
    }
    return null;
  };

  const files = sourceFiles(cwd);
  const violations = [];
  for (const file of files) {
    const from = layerOf(file);
    if (!from) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const spec of importsOf(text)) {
      const target = resolveImport(file, spec);
      if (!target) continue;
      const to = layerOf(target);
      if (!to) continue;
      const hit = forbidden.find((r) => r.from === from && r.to === to);
      if (!hit) continue;
      violations.push({
        from: path.relative(cwd, file),
        to: path.relative(cwd, target),
        rule: `${hit.from} -/-> ${hit.to}`,
      });
    }
  }
  return { violations, scanned: files.length };
}

/**
 * Every `t("key")` in the source, as a catalog.
 *
 * `t` is the one function name this recognises, and that is the contract: a
 * project that translates with something else is not using the built-in
 * extraction, and pretending to understand arbitrary helpers is how a catalog
 * quietly loses strings.
 */
export function extractI18n(cwd) {
  const keys = new Map();
  const files = sourceFiles(cwd);
  const re = /\bt\(\s*["']([^"']+)["']/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = m[1];
      if (!keys.has(key)) keys.set(key, new Set());
      keys.get(key).add(path.relative(cwd, file));
    }
  }
  return {
    keys: [...keys.keys()].sort(),
    usedIn: Object.fromEntries([...keys].map(([k, set]) => [k, [...set].sort()])),
    files: files.length,
  };
}

/**
 * `.hyx` files under `src/` that nothing imports and no route owns.
 *
 * Routes are excluded before the graph is built: a page file is reached by the
 * router, not by an import, and reporting every page as dead would make the
 * check useless in the first minute.
 */
export function findDeadComponents(cwd, routes = [], entries = []) {
  const files = sourceFiles(cwd);
  // An ENTRY is reached by the HTML (`<script src="assets/index-….js">`), not by
  // an import, and `_404`/`_error`/`_layout` are reached by the router by name.
  // Reporting either as dead would be the first false positive, and one false
  // positive is enough for the whole check to be switched off.
  const entryFiles = new Set(entries.map((e) => path.resolve(cwd, e)));
  const special = (f) => path.basename(f).startsWith('_');
  const routeFiles = new Set(
    routes.map((r) => path.resolve(cwd, 'src', 'pages', r.file || '')).filter(Boolean),
  );
  const imported = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const spec of importsOf(text)) {
      const target = resolveImport(file, spec);
      if (target) imported.add(target);
    }
  }
  return files
    .filter((f) => f.endsWith('.hyx'))
    .filter((f) => !imported.has(f) && !routeFiles.has(f) && !entryFiles.has(f) && !special(f))
    .map((f) => path.relative(cwd, f))
    .sort();
}

/**
 * `.d.ts` for the route table: the patterns, and the params each one implies.
 *
 * Typed routes are a small promise that pays for itself immediately: a
 * `navigate_to("/blog/…")` typo is a compile error instead of a 404 that only
 * appears when someone clicks. Generated during the build because the route table
 * is the build's own output — a second source of truth would be a second thing to
 * keep in step.
 *
 * Deliberately not a declaration for `hydra:routes` itself: that module is
 * internal, and typing it would invite projects to import it.
 */
export function routeTypes(routes = []) {
  const patterns = routes.map((r) => r.pattern);
  const paramLines = routes.map((r) => {
    const params = Array.isArray(r.params) ? r.params : [];
    const key = JSON.stringify(r.pattern);
    if (params.length === 0) return `  ${key}: {}`;
    const fields = params.map((p) => `    ${JSON.stringify(p)}: string | string[]`).join('\n');
    return `  ${key}: {\n${fields}\n  }`;
  });
  const union =
    patterns.length > 0 ? patterns.map((p) => `  | ${JSON.stringify(p)}`).join('\n') : '  never';
  const header = [
    '// GENERATED by hydra build — do not edit. Regenerate with: hydra build',
    '//',
    "// The routes this project has, as a union of literal strings, and the params",
    '// each one implies. A link that is not one of these is a compile error:',
    '//',
    "//   import type { RoutePattern } from '../.hydra/types/routes'",
    "//   const to: RoutePattern = '/about'",
    '',
    'export type RoutePattern =',
    union + ';',
    '',
    'export interface RouteParams {',
  ].join('\n');
  return `${header}\n${paramLines.join('\n')}\n}\n\n/** A link to one of this project's routes. */\nexport type LinkTo = RoutePattern;\n`;
}

/** Internal links in the built HTML that point at nothing. */
export function checkLinks(distDir, base = '/') {
  const broken = [];
  let checked = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) inspect(full);
    }
  };
  const exists = (href) => {
    const clean = href.split('#')[0].split('?')[0];
    if (!clean || clean === '/') return fs.existsSync(path.join(distDir, 'index.html'));
    const relative = clean.replace(base, '/').replace(/^\//, '');
    const direct = path.join(distDir, relative);
    return (
      fs.existsSync(direct) ||
      fs.existsSync(`${direct}.html`) ||
      fs.existsSync(path.join(direct, 'index.html'))
    );
  };
  const inspect = (file) => {
    const html = fs.readFileSync(file, 'utf8');
    const re = /\b(?:href|src)="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (!href.startsWith('/')) continue; // external, relative, data:, mailto:
      if (href.startsWith('//')) continue;
      if (/^\/(__hydra|_next)\b/.test(href)) continue;
      checked += 1;
      if (!exists(href)) {
        broken.push({ page: path.relative(distDir, file).split(path.sep).join('/'), href });
      }
    }
  };
  walk(distDir);
  return { broken, checked };
}
