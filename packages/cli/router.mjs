// [xihanzu-NR]
/**
 * File-based routing for HydraScript — the build-time half.
 *
 * A page file becomes a route. `src/pages/about.hyx` is `/about`,
 * `src/pages/blog/[slug].hyx` is `/blog/:slug`. The mapping is computed here,
 * printed by `hydra routes`, and emitted as the virtual module `hydra:routes` —
 * never inferred at runtime from a directory listing, because a route table
 * that only exists inside a bundle cannot be inspected when it disagrees with
 * the filesystem.
 *
 * Conventions are borrowed exactly rather than invented, because a new naming
 * scheme is a new thing to learn for no gain:
 *
 *   index.hyx            -> /            (the folder's own page)
 *   about.hyx            -> /about
 *   blog/index.hyx       -> /blog
 *   blog/[slug].hyx      -> /blog/:slug  (one segment)
 *   docs/[...rest].hyx   -> /docs/*      (one or more, no bare /docs)
 *   files/[[...rest]].hyx -> /files/*    (zero or more, so /files too)
 *   (marketing)/x.hyx    -> /x           (group: layout scope only)
 *   _partials/Hero.hyx   -> not routable (a leading `_` means private)
 *   _layout.hyx          -> wraps every route in its folder and below
 *   _404.hyx             -> rendered when no route matches
 *   _error.hyx           -> error boundary for its folder
 *
 * The parameter NAME does not affect the URL — `[slug].hyx` and `[id].hyx` are
 * both `/blog/:x` — so a folder containing both is a contradiction rather than
 * a precedence problem, and it is reported as an error naming both files. That
 * silent coin-flip is the failure this module exists to make loud. The same
 * goes for two files that resolve to the same URL: `about.hyx` and
 * `about/index.hyx` are both `/about`, and only one of them can win.
 *
 * Matching itself lives in `runtime/router-core.js` and is imported, not
 * reimplemented: the CLI and the browser must not be able to disagree about
 * which route answers a URL.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readMeta, shellMeta } from './meta.mjs';

import { matchRoute, compareRoutes, pathSegments, parseQuery } from '../../runtime/router-core.js';

export { matchRoute, compareRoutes, pathSegments, parseQuery };

/** The module specifier a project imports the generated route table from. */
export const ROUTES_MODULE = 'hydra:routes';

/** Where the generated table is written, relative to the project root. */
export const GENERATED_DIR = '.hydra';
export const GENERATED_FILE = 'routes.generated.js';
/** The pre-render entry, generated only when there are routes to pre-render. */
export const SSG_ENTRY_FILE = 'ssg-entry.js';

/**
 * A page's server half: `blog/[slug].server.hys` beside `blog/[slug].hyx`.
 *
 * Separate FILES rather than an `export def loader` inside the page, and that is
 * the whole design. A page module is a client module — it renders in the browser
 * and its imports end up in the client bundle — so a loader declared in it could
 * only be server-only by convention, enforced nowhere. A `.server.hys` file is
 * not reachable from the client at all: the client bundle has no import to it,
 * and `hydra/server` is refused there by name. The split makes the boundary a
 * fact about the module graph instead of a rule in a document.
 */
export const SERVER_SUFFIX = '.server';

/** `blog/[slug]` + `.server.hys` -> `blog/[slug].server.hys`. */
function serverFileFor(pageRel) {
  const dot = pageRel.lastIndexOf('.');
  if (dot === -1) return null;
  // A loader is `.hys` (plain JS, runs in node) or `.hyx` if the author had a
  // reason. Both are tried, in that order, because `.hys` is the convention the
  // docs use and the one that reads correctly at the top of the file.
  const stem = pageRel.slice(0, dot);
  return [`${stem}${SERVER_SUFFIX}.hys`, `${stem}${SERVER_SUFFIX}.hyx`];
}

const LAYOUT_BASENAME = '_layout';
const NOT_FOUND_BASENAME = '_404';
const ERROR_BASENAME = '_error';

/**
 * Filenames that only ever name a framework file, never a page.
 *
 * Anything else starting with `_` is simply private and not routable — the same
 * rule Next.js uses for `_folder`.
 */
const FRAMEWORK_BASENAMES = new Set([LAYOUT_BASENAME, NOT_FOUND_BASENAME, ERROR_BASENAME]);

function isPrivateSegment(segment) {
  return segment.startsWith('_') || segment.startsWith('.');
}

function isGroupSegment(segment) {
  return segment.startsWith('(') && segment.endsWith(')');
}

/** `[slug]` -> `{ kind: 'param', name: 'slug' }`; anything else is a literal. */
function parseSegment(segment) {
  const optionalCatchAll = /^\[\[\.\.\.([A-Za-z_$][\w$]*)\]\]$/.exec(segment);
  if (optionalCatchAll) {
    return { kind: 'catchall', name: optionalCatchAll[1], optional: true, raw: segment };
  }

  const catchAll = /^\[\.\.\.([A-Za-z_$][\w$]*)\]$/.exec(segment);
  if (catchAll) return { kind: 'catchall', name: catchAll[1], optional: false, raw: segment };

  const param = /^\[([A-Za-z_$][\w$]*)\]$/.exec(segment);
  if (param) return { kind: 'param', name: param[1], raw: segment };

  // A malformed bracket is a mistake worth naming, not a literal folder called
  // `[slug` that quietly answers at a URL nobody intended.
  if (segment.includes('[') || segment.includes(']')) return { kind: 'invalid', raw: segment };

  return { kind: 'literal', value: segment, raw: segment };
}

/** One segment, spelled for the URL: `[slug]` -> `:slug`, `[...rest]` -> `*`. */
function segmentToPattern(part) {
  if (part.kind === 'literal') return part.value;
  if (part.kind === 'param') return ':' + part.name;
  if (part.kind === 'catchall') return part.optional ? '*?' : '*';
  return part.raw;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, out);
    } else if (/\.(hyx|hsx|hys|hs)$/.test(entry.name)) {
      // `.hys` too: a page's server half is plain JavaScript by convention
      // (it runs in node, never in a browser), so the walk has to see it or the
      // pairing silently finds nothing.
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan a pages directory into a route table.
 *
 * Returns `{ root, routes, layouts, notFound, errors, errors_diagnostics }`.
 * `routes` is sorted most-specific-first so that `matchRoute` resolves in a
 * single pass with no scoring. Nothing here throws: a project with a broken
 * route should be told which files disagree, not killed from inside a scanner.
 */
export function scanRoutes(pagesDir) {
  const root = path.resolve(pagesDir);
  const result = {
    root,
    routes: [],
    layouts: {},
    notFound: [],
    errors: [],
    errors_diagnostics: [],
    /** Every `.server.hys` found, so an orphan can be named. */
    serverFiles: [],
  };

  // No pages directory is not an error: a project with a mount point and no
  // routes is a legitimate HydraScript app.
  if (!fs.existsSync(root)) return result;

  /** `folder#index` -> the param that already claimed that URL position. */
  const paramSlots = new Map();
  /** pattern -> the file that already claimed it. */
  const patternOwners = new Map();

  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const noExt = rel.replace(/\.(hyx|hsx|hys|hs)$/, '');
    const dirSegments = noExt.split('/').slice(0, -1);
    const basename = noExt.split('/').pop();
    const folder = dirSegments.join('/');

    if (FRAMEWORK_BASENAMES.has(basename)) {
      if (basename === LAYOUT_BASENAME) result.layouts[folder] = rel;
      else if (basename === NOT_FOUND_BASENAME) result.notFound.push({ folder, file: rel });
      else result.errors.push({ folder, file: rel });
      continue;
    }

    // A `.server.hys` is never a page; it is a page's server half, adopted by
    // the page it sits beside. Collected so an orphan can be named.
    if (noExt.endsWith(SERVER_SUFFIX)) {
      result.serverFiles.push(rel);
      continue;
    }
    // A `.hys`/`.hs` that is NOT a server half is a plain script, not a page.
    if (/\.(hys|hs)$/.test(rel)) continue;

    // A private segment anywhere above, or a private filename, makes the file
    // non-routable — and legitimately so, not an error.
    if (dirSegments.some(isPrivateSegment)) continue;
    if (isPrivateSegment(basename)) continue;

    const urlParts = [];
    for (const raw of dirSegments) {
      if (isGroupSegment(raw)) continue; // a group scopes layouts, not URLs
      const parsed = parseSegment(raw);
      if (parsed.kind === 'invalid') {
        result.errors_diagnostics.push(invalidSegmentMessage(rel, raw));
        continue;
      }
      urlParts.push(parsed);
    }

    if (basename !== 'index') {
      const parsed = parseSegment(basename);
      if (parsed.kind === 'invalid') {
        result.errors_diagnostics.push(invalidSegmentMessage(rel, basename));
        continue;
      }
      urlParts.push(parsed);
    }

    // Two different param names in one URL position describe the same URLs, so
    // one of them can never be reached through the pattern it declares.
    for (let i = 0; i < urlParts.length; i++) {
      const p = urlParts[i];
      if (p.kind !== 'param' && p.kind !== 'catchall') continue;
      const slot = urlParts.slice(0, i).map((x) => x.raw).join('/') + '#' + i;
      const seen = paramSlots.get(slot);
      if (seen && seen.name !== p.name) {
        result.errors_diagnostics.push(
          `${rel}: "${p.raw}" collides with "${seen.raw}" in ${seen.file}. ` +
            `Both describe the same URL position; give them the same parameter name ` +
            `or move one to another folder.`,
        );
        continue;
      }
      if (!seen) paramSlots.set(slot, { name: p.name, raw: p.raw, file: rel });
    }

    const rawPattern = '/' + urlParts.map(segmentToPattern).join('/');
    const pattern = rawPattern === '/' ? '/' : rawPattern.replace(/\/$/, '');

    // `about.hyx` and `about/index.hyx` both mean `/about`. Two files claiming
    // one route is a decision somebody has to make, not a race to resolve.
    const owner = patternOwners.get(pattern);
    if (owner) {
      result.errors_diagnostics.push(
        `${rel}: this file and ${owner} both resolve to ${pattern}. ` +
          `A folder's own page is \`index.hyx\`, so keep one of the two.`,
      );
      continue;
    }
    patternOwners.set(pattern, rel);

    // Per-route rendering mode, declared as a plain module-level assignment:
    //
    //   rendering = "csr"
    //
    // Read from the SOURCE at scan time rather than from an import at runtime,
    // because the decision changes what the BUILD does — a `csr` route is not
    // pre-rendered at all. Convention over keyword: it is a name, not syntax.
    //
    // The same read gets `meta`, for the same reason and one more: the compiler
    // emits a module-level assignment as `const meta = ...`, not as an export,
    // so importing the page module would not carry it even if we wanted to.
    let rendering = null;
    let meta = null;
    let text = null;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      /* unreadable is not fatal here; the compiler will say so */
    }
    if (text !== null) {
      const m = /^\s*rendering\s*=\s*["'](ssg|csr|ssr)["']/m.exec(text);
      if (m) rendering = m[1];
      const read = readMeta(text);
      if (read.error) result.errors_diagnostics.push(`${rel}: ${read.error}`);
      // `meta = {}` declares nothing, so it is treated as no meta at all rather
      // than as an empty entry in the generated table.
      else if (read.meta && Object.keys(read.meta).length > 0) meta = read.meta;
    }

    const serverCandidates = serverFileFor(rel) || [];
    const serverFile =
      serverCandidates.find((c) => fs.existsSync(path.join(root, c))) || null;

    result.routes.push({
      pattern,
      file: rel,
      // The page's server half, or null. Existence is decided HERE, at scan
      // time, so a `.server.hys` with no page beside it is reported below rather
      // than silently doing nothing.
      serverFile,
      /** `ssg` (pre-render), `csr` (client only), or null (decided by the project). */
      rendering,
      /** `{ title, description }`, or null when the page declares none. */
      meta,
      params: urlParts
        .filter((p) => p.kind === 'param' || p.kind === 'catchall')
        .map((p) => p.name),
      segments: urlParts,
      hasParams: urlParts.some((p) => p.kind === 'param' || p.kind === 'catchall'),
      dir: folder,
    });
  }

  // A rendering value that is neither of the two the build knows is a typo that
  // would otherwise silently fall back to the project default.
  for (const r of result.routes) {
    if (r.rendering && !['ssg', 'csr', 'ssr'].includes(r.rendering)) {
      result.errors_diagnostics.push(
        `${r.file}: rendering = "${r.rendering}" is not a mode this build knows. ` +
          `Use "ssg" (pre-render) or "csr" (client only).`,
      );
    }
  }

  // A `.server.hys` with no page beside it does nothing, and "does nothing" is
  // the failure mode this project refuses everywhere else. The pairing is by
  // filename, so a typo in either half is worth a sentence.
  const paired = new Set(result.routes.map((r) => r.serverFile).filter(Boolean));
  for (const f of result.serverFiles) {
    if (!paired.has(f)) {
      const page = f.replace(/\.server(\.[a-z]+)$/, '$1');
      result.errors_diagnostics.push(
        `${f}: this is a page's server half, but there is no ${page} beside it. ` +
          `A loader is adopted by the page with the same name; rename one of them.`,
      );
    }
  }

  result.routes.sort(compareRoutes);
  return result;
}

function invalidSegmentMessage(rel, segment) {
  return (
    `${rel}: "${segment}" is not a valid route segment. ` +
    `Use [name] for one segment, [...name] for one or more, ` +
    `[[...name]] for zero or more.`
  );
}

/**
 * Every layout that wraps `frameOf`, nearest first.
 *
 * Walking up from the folder is the whole algorithm; a layout in a parent
 * folder applies to its descendants, which is what nesting means everywhere
 * else. Nearest-first is the order the generated table stores, because that is
 * the order the runtime needs to look them up.
 *
 * `frameOf` is the folder path *including* route groups, since a group exists
 * precisely to give its routes a different layout.
 */
export function layoutChainFor(folder, table) {
  const chain = [];
  const parts = folder ? folder.split('/') : [];
  for (let i = parts.length; i >= 0; i--) {
    const key = parts.slice(0, i).join('/');
    if (table.layouts[key]) chain.push(table.layouts[key]);
  }
  return chain;
}

/** The nearest `_error` at or above `folder`, or null. */
export function errorFor(folder, table) {
  const parts = folder ? folder.split('/') : [];
  for (let i = parts.length; i >= 0; i--) {
    const key = parts.slice(0, i).join('/');
    const hit = table.errors.find((e) => e.folder === key);
    if (hit) return hit.file;
  }
  return null;
}

/** The nearest `_404` at or above `folder`, or null. */
export function notFoundFor(folder, table) {
  const parts = folder ? folder.split('/') : [];
  for (let i = parts.length; i >= 0; i--) {
    const key = parts.slice(0, i).join('/');
    const hit = table.notFound.find((n) => n.folder === key);
    if (hit) return hit.file;
  }
  return null;
}

function importerSpecifier(file) {
  // Path-safe, not URL-safe: this is a specifier esbuild resolves as a path, so
  // `[slug].hyx` must stay literally that. See `esbuildSafe` for why
  // percent-encoding the whole name looks right and breaks the build.
  return esbuildSafe('../src/pages/' + file.split('/').join('/'));
}

/**
 * The source of the generated module.
 *
 * A plain ESM module whose only imports are the page and layout files, so
 * esbuild sees each `import()` as a real chunk boundary and a person can read
 * the whole thing. The `pages` / `pageLayouts` / `pageErrors` maps are keyed by
 * route pattern, so the table cannot pair a page with another route's layout.
 *
 * `pagesDir` is only needed for the convenience of reading it back; the
 * specifiers are relative to the generated file, which lives at
 * `<root>/.hydra/`.
 *
 * `cwd` is here for one value: the shell's own `<title>` and description. A
 * navigation to a page that declares no `meta` has to put the shell's title
 * back, and the shell is a file in the project — the browser cannot read it
 * without a request the framework should not make.
 */
export function routesModuleSource(table, { base = '/', cwd = null } = {}) {
  // STATIC imports, not `() => import(...)`.
  //
  // The lazy form is the more obvious choice and it does not work: esbuild sees
  // a dynamic import of a path that also resolves statically, marks it an entry
  // point, and the route table ends up in a chunk nothing references — so the
  // client bundle contains no `Router` at all and the page renders nothing while
  // the build reports success. A static import is compiled in, which is what a
  // synchronous route table needs anyway.
  const files = new Set();
  for (const r of table.routes) {
    files.add(r.file);
    for (const f of layoutChainFor(r.dir, table)) files.add(f);
    const e = errorFor(r.dir, table);
    if (e) files.add(e);
  }
  const rootNotFound = notFoundFor('', table);
  if (rootNotFound) files.add(rootNotFound);

  const ref = new Map();
  const lines = [
    '// [xihanzu-NR]',
    '// GENERATED by `hydra build` / `hydra routes` — do not edit, do not commit.',
    '// Source: the .hyx files under the pages directory. Edit those.',
    '',
  ];
  for (const f of files) {
    const id = `__route_${identFor(f)}`;
    ref.set(f, id);
    lines.push(`import * as ${id} from ${JSON.stringify(importerSpecifier(f))};`);
  }
  lines.push('');
  lines.push('function pick(mod) {');
  lines.push('  if (!mod) return null;');
  lines.push('  if (typeof mod.default === "function") return mod.default;');
  lines.push('  for (const k of Object.keys(mod)) {');
  lines.push('    if (k !== "default" && typeof mod[k] === "function" && /^[A-Z]/.test(k)) return mod[k];');
  lines.push('  }');
  lines.push('  return null;');
  lines.push('}');
  lines.push('');
  // `serverFile` travels with the route so the build knows which pages have a
  // loader, without re-deriving the filename and getting it subtly wrong.
  // `segments` MUST be here. Matching is done against them, and they were the
  // one field this map omitted: `routes` was regenerated for `serverFile` and
  // lost the shape the matcher reads, so every route matched nothing. The
  // pre-rendered HTML looked perfect and the client rendered an empty tree —
  // React #418 on the client's own page.
  lines.push('export const routes = ' + JSON.stringify(
    table.routes.map((r) => ({
      pattern: r.pattern,
      file: r.file,
      params: r.params,
      segments: r.segments,
      serverFile: r.serverFile || null,
    })),
  ) + ';');
  lines.push('');
  // The page's `meta`, keyed by pattern, so a client navigation knows what the
  // new route's title is without a request. It travels in the table rather than
  // in the page module because the compiler emits `meta = {...}` as a local
  // `const`, not an export — see meta.mjs.
  //
  // This is also what a CSR route gets: it is never pre-rendered, so the table
  // is the only place its metadata can live.
  lines.push('export const pageMeta = ' + JSON.stringify(
    Object.fromEntries(table.routes.filter((r) => r.meta).map((r) => [r.pattern, r.meta])),
  ) + ';');
  lines.push('');
  // The shell's own values, for a page that declares no `meta` of its own: it
  // gets the project's title back after a navigation rather than the previous
  // page's. A shell with no `<title>` stays null, so the browser keeps whatever
  // it has rather than shipping an empty string.
  const shell = cwd ? shellMeta(cwd) : { title: null, description: null };
  lines.push('export const shellMeta = ' + JSON.stringify(shell) + ';');
  lines.push('');
  // COMPONENTS, not loaders. `() => Promise.resolve(mod)` was the earlier shape
  // and it survived here after the runtime moved on: the client then had a
  // function where a component belonged, React rendered the Promise it returned,
  // and every page threw #31 — after a pre-render that produced perfect HTML.
  lines.push('export const pages = {');
  for (const r of table.routes) {
    lines.push(`  ${JSON.stringify(r.pattern)}: pick(${ref.get(r.file)}),`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export const pageLayouts = {');
  for (const r of table.routes) {
    const list = layoutChainFor(r.dir, table).map((f) => `pick(${ref.get(f)})`).join(', ');
    lines.push(`  ${JSON.stringify(r.pattern)}: [${list}].filter(Boolean),`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export const pageErrors = {');
  for (const r of table.routes) {
    const e = errorFor(r.dir, table);
    lines.push(`  ${JSON.stringify(r.pattern)}: ${e ? `pick(${ref.get(e)})` : 'null'},`);
  }
  lines.push('};');
  lines.push('');
  lines.push(
    `export const notFound = ${rootNotFound ? `pick(${ref.get(rootNotFound)})` : 'null'};`,
  );
  lines.push(`export const hasNotFound = ${rootNotFound ? 'true' : 'false'};`);
  lines.push(`export const base = ${JSON.stringify(base)};`);
  lines.push('');
  lines.push(`export default { routes, pages, pageLayouts, pageErrors, pageMeta, shellMeta, notFound, hasNotFound, base };`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the pre-render entry. Returns its absolute path, or null when there is
 * nothing static to pre-render or no app entry to render.
 *
 * Refusing to write an entry with no static routes is deliberate: an empty entry
 * would build an SSR bundle that renders nothing, and the build would then report
 * "pre-rendered 0/0" as if it had done something.
 */
export function writeSsgEntry(cwd, table, { entry, base = '/' } = {}) {
  // NOT `staticRoutes.length === 0 -> null`.
  //
  // This generated entry is what defines `loadFor`/`renderSync`, and the SERVER
  // renders dynamic routes from it per request. Returning null for a project
  // whose routes are ALL dynamic meant the build silently fell back to
  // `src/App.hyx`, the server bundle had no `loadFor`/`renderSync` at all, and
  // `createRenderer` reported "the server bundle predates 0.8" — for a project
  // built with 0.8. A blog with `/blog/[slug]` and no static pages is not an
  // edge case; it is the shape the SSR path exists for.
  if (!table) return null;
  if (!entry) return null;
  const dir = path.join(cwd, GENERATED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SSG_ENTRY_FILE);
  fs.writeFileSync(file, ssgEntrySource(table, { cwd, entry, base }), 'utf8');
  return file;
}

/** Write the generated module into the project. Returns its absolute path. */
export function writeRoutesModule(cwd, table, opts = {}) {
  const dir = path.join(cwd, GENERATED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, GENERATED_FILE);
  fs.writeFileSync(file, routesModuleSource(table, { ...opts, cwd: opts.cwd || cwd }), 'utf8');
  return file;
}

/**
 * An esbuild plugin that answers `import(...) from 'hydra:routes'`.
 *
 * A virtual module rather than a file a project could import by accident, for
 * the same reason the runtime specifier is a contract: generated output must
 * not be reachable by a relative path that looks hand-written, or one project
 * file can shadow it and silently disagree with the folder layout.
 *
 * `resolveDir` is the generated module's own directory, so the relative
 * specifiers inside it resolve exactly as they would on disk.
 */
export function routesEsbuildPlugin(table, { base = '/', cwd } = {}) {
  const resolveDir = path.join(cwd || process.cwd(), GENERATED_DIR);
  return {
    name: 'hydra-routes',
    setup(build) {
      build.onResolve({ filter: /^hydra:routes$/ }, () => ({
        path: ROUTES_MODULE,
        namespace: 'hydra-routes',
      }));
      build.onLoad({ filter: /.*/, namespace: 'hydra-routes' }, () => ({
        contents: routesModuleSource(table, { base, cwd: cwd || process.cwd() }),
        loader: 'js',
        resolveDir,
      }));
    },
  };
}

/** `hydra routes` — a table, plus every problem found while scanning. */
export function routeTable(table) {
  const lines = [];
  if (table.routes.length === 0) {
    lines.push('no routes found');
    if (!fs.existsSync(table.root)) lines.push(`  (no pages directory at ${table.root})`);
  } else {
    const width = Math.max(...table.routes.map((r) => r.pattern.length), 7);
    lines.push(`${'ROUTE'.padEnd(width)}  KIND      FILE`);
    for (const r of table.routes) {
      const kind = r.hasParams ? 'dynamic' : 'static ';
      lines.push(`${r.pattern.padEnd(width)}  ${kind}  src/pages/${r.file}`);
    }
  }
  for (const [folder, file] of Object.entries(table.layouts)) {
    lines.push(`layout   ${folder || '.'}  <-  src/pages/${file}`);
  }
  for (const nf of table.notFound) lines.push(`404      ${nf.folder || '.'}  <-  src/pages/${nf.file}`);
  for (const er of table.errors) lines.push(`error    ${er.folder || '.'}  <-  src/pages/${er.file}`);
  return lines.join('\n');
}

/** The same information as `routeTable`, for tooling and CI. */
export function routesJson(table) {
  return {
    root: table.root,
    routes: table.routes.map((r) => ({
      pattern: r.pattern,
      file: r.file,
      params: r.params,
      dynamic: r.hasParams,
      serverFile: r.serverFile || null,
      meta: r.meta || null,
      layouts: layoutChainFor(r.dir, table),
      error: errorFor(r.dir, table),
    })),
    layouts: table.layouts,
    notFound: table.notFound,
    errors: table.errors,
  };
}

/* --------------------------------------------------------------- pre-render
 *
 * Pre-rendering renders THE APP, not the page. That distinction is the whole
 * reason this file exists in the shape it does.
 *
 * The first version rendered each page component directly. That produces HTML
 * with no app around it — no nav, no providers, none of the chrome the client
 * mounts — so the client's first frame disagreed with the server's and React
 * reported a hydration mismatch (#418). The runtime gate caught it in CI, which
 * is what the gate is for, but the design was wrong.
 *
 * So the entry imports the app's real entrypoint (`src/main.hyx`), seeds the
 * runtime with the route table and the URL being rendered, and renders the same
 * `App` the browser mounts. `Router()` then finds its page SYNCHRONOUSLY from
 * the seed, because `renderToString` runs no effects and the lazy import of
 * `hydra:routes` can never resolve inside it. One component tree, two runtimes,
 * identical output.
 */

/**
 * Make a filesystem path safe to put in a string literal a bundler resolves.
 *
 * Only the characters that would be read as URL syntax are escaped. Percent-
 * encoding the whole path is the tempting move and it is wrong: esbuild resolves
 * the specifier as a path, so `%5Bslug%5D.hyx` is looked up as that literal name
 * on disk and the real `[slug].hyx` is never found.
 */
function esbuildSafe(p) {
  return p.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/ /g, '%20');
}

/** Absolute, POSIX-spelled specifier for a project-relative file. */
function absoluteSpecifier(cwd, file) {
  const full = path.resolve(cwd, file).split(path.sep).join('/');
  return esbuildSafe(full.startsWith('/') ? full : '/' + full);
}

/** A stable, valid JS identifier suffix for a file path. */
function identFor(file) {
  let h = 0;
  for (let i = 0; i < file.length; i++) h = (h * 31 + file.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * The module `hydra build` bundles to pre-render routes.
 *
 * Exports `routes` so the runner and the bundle cannot disagree about which
 * patterns exist, and `renderFor(pattern)`, which returns a React element.
 * Every import is static and literal, which is what makes the element tree real
 * rather than a promise.
 */export function ssgEntrySource(table, { cwd, entry, base = '/' }) {
  const pagesMap = {};
  const layoutsMap = {};
  const errorsMap = {};
  for (const r of table.routes) {
    pagesMap[r.pattern] = r.file;
    layoutsMap[r.pattern] = layoutChainFor(r.dir, table);
    const e = errorFor(r.dir, table);
    if (e) errorsMap[r.pattern] = e;
  }
  const rootNotFound = notFoundFor('', table);

  // Every file that needs a namespace import. Includes the `.server` halves,
  // which this pass may touch and the client may not.
  const files = new Set(Object.values(pagesMap));
  for (const list of Object.values(layoutsMap)) for (const f of list) files.add(f);
  for (const f of Object.values(errorsMap)) files.add(f);
  if (rootNotFound) files.add(rootNotFound);

  const loaderByPattern = {};
  for (const r of table.routes) {
    if (r.serverFile) {
      files.add(r.serverFile);
      loaderByPattern[r.pattern] = r.serverFile;
    }
  }

  const ref = new Map();
  const ident = (f) => {
    if (ref.has(f)) return ref.get(f);
    const id = `__m_${identFor(f)}`;
    ref.set(f, id);
    return id;
  };

  const lines = [
    '// [xihanzu-NR]',
    '// GENERATED by `hydra build` — pre-render entry, never shipped.',
    "import { createElement } from 'react';",
    "import { __seed_for_ssr, __clear_ssr_seed } from 'hydra';",
    `import * as __app from ${JSON.stringify(absoluteSpecifier(cwd, entry))};`,
    '',
  ];
  for (const f of files) {
    lines.push(`import * as ${ident(f)} from ${JSON.stringify(absoluteSpecifier(table.root, f))};`);
  }

  lines.push('');
  lines.push('function pick(mod) {');
  lines.push('  if (!mod) return null;');
  lines.push('  if (typeof mod.default === "function") return mod.default;');
  lines.push('  for (const k of Object.keys(mod)) {');
  lines.push('    if (k !== "default" && typeof mod[k] === "function" && /^[A-Z]/.test(k)) return mod[k];');
  lines.push('  }');
  lines.push('  return null;');
  lines.push('}');
  lines.push('');
  // `segments` MUST travel with each route: matching is done against them, and
  // without them every URL fails to match — which is exactly how this was
  // found, as a pre-rendered page with an empty <main> and correct data beside
  // it. The client's table carries them; this one has to as well.
  lines.push('export const routes = ' + JSON.stringify(
    table.routes.map((r) => ({
      pattern: r.pattern,
      file: r.file,
      params: r.params,
      segments: r.segments,
      // Carried so a server render of a DYNAMIC route gets the page's own title.
      // The pre-render pass applies `meta` from the scanner's table instead;
      // this bundle only knows what is written here.
      meta: r.meta || null,
    })),
  ) + ';');
  lines.push('');
  lines.push('function __table() {');
  lines.push('  const pages = {};');
  for (const [pattern, file] of Object.entries(pagesMap)) {
    lines.push(`  pages[${JSON.stringify(pattern)}] = pick(${ident(file)});`);
  }
  lines.push('  const pageLayouts = {};');
  for (const [pattern, list] of Object.entries(layoutsMap)) {
    const inner = list.map((f) => `pick(${ident(f)})`).join(', ');
    lines.push(`  pageLayouts[${JSON.stringify(pattern)}] = [${inner}].filter(Boolean);`);
  }
  lines.push('  const pageErrors = {};');
  for (const pattern of Object.keys(pagesMap)) {
    const f = errorsMap[pattern];
    lines.push(`  pageErrors[${JSON.stringify(pattern)}] = ${f ? `pick(${ident(f)})` : 'null'};`);
  }
  lines.push(`  const notFound = ${rootNotFound ? `pick(${ident(rootNotFound)})` : 'null'};`);
  lines.push(`  return { routes, pages, pageLayouts, pageErrors, pageMeta: ${JSON.stringify(
    Object.fromEntries(table.routes.filter((r) => r.meta).map((r) => [r.pattern, r.meta])),
  )}, notFound, hasNotFound: ${
      rootNotFound ? 'true' : 'false'
    }, base: ${JSON.stringify(base)} };`);
  lines.push('}');
  lines.push('');
  lines.push('function __sourceFor(pattern) {');
  for (const [pattern, file] of Object.entries(loaderByPattern)) {
    lines.push(`  if (pattern === ${JSON.stringify(pattern)}) return ${JSON.stringify(file)};`);
  }
  lines.push('  return null;');
  lines.push('}');
  lines.push('');
  lines.push('function __serverFor(pattern) {');
  for (const [pattern, file] of Object.entries(loaderByPattern)) {
    lines.push(`  if (pattern === ${JSON.stringify(pattern)}) return ${ident(file)};`);
  }
  lines.push('  return null;');
  lines.push('}');
  lines.push('');
  lines.push('function __event(params, url, request) {');
  lines.push('  const search = new URLSearchParams(String(url || "").split("?")[1] || "");');
  lines.push('  const query = Object.fromEntries(search);');
  lines.push('  query.get = (k, fallback = null) => (search.has(k) ? search.get(k) : fallback);');
  lines.push('  query.has = (k) => search.has(k);');
  lines.push('  return {');
  lines.push('    params,');
  lines.push('    url,');
  lines.push('    query,');
  lines.push('    request: request || {');
  lines.push('      method: "GET", url, headers: {}, body: null,');
  lines.push('      json: async () => null, text: async () => "",');
  lines.push('    },');
  lines.push('  };');
  lines.push('}');
  lines.push('');
  lines.push('function __appComponent() {');
  lines.push('  const mod = __app;');
  lines.push('  if (typeof mod.default === "function") return mod.default;');
  lines.push('  if (typeof mod.App === "function") return mod.App;');
  lines.push('  for (const k of Object.keys(mod)) {');
  lines.push('    if (typeof mod[k] === "function" && /^[A-Z]/.test(k)) return mod[k];');
  lines.push('  }');
  lines.push('  return null;');
  lines.push('}');
  lines.push('');
  // LOADING and RENDERING are separate exports, and that is not tidiness.
  //
  // The seed is module-global (the runtime has one `ssr_seed`), so a server that
  // awaited a loader with the seed already set would have two concurrent
  // requests overwriting each other's data — the second request's page would
  // render with the first one's props. Splitting them makes the async part end
  // before any global state is touched:
  //
  //   data = await loadFor(...)          // may await a database
  //   element = renderSync(pattern, params, url, data)   // fully synchronous
  //
  // Nothing can interleave between `__seed_for_ssr` and the caller's
  // `renderToString`, because there is no await in between.
  lines.push('export async function loadFor(pattern, params = {}, url = pattern, request = null) {');
  lines.push('  const serverMod = __serverFor(pattern);');
  lines.push('  const loader = serverMod && typeof serverMod.loader === "function" ? serverMod.loader : null;');
  lines.push('  if (!loader) return null;');
  lines.push('  // ONE argument: an event object. Passing three silently handed every');
  lines.push('  // loader written to the documented shape the wrong first parameter.');
  lines.push('  try {');
  lines.push('    return await loader(__event(params, url, request));');
  lines.push('  } catch (err) {');
  lines.push('    // Name the SOURCE file. The stack of a thrown loader points into the');
  lines.push('    // built server bundle (`.hydra/server.cjs:7308`), which is not a file');
  lines.push('    // the author has ever opened and has no line numbers they can use.');
  lines.push('    // The mapping that matters — pattern to `.hys` path — is right here.');
  lines.push('    throw __loaderError(err, pattern, url);');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('function __loaderError(err, pattern, url) {');
  lines.push('  const file = __sourceFor(pattern);');
  lines.push('  const where = file ? file : pattern;');
  lines.push('  const message = err && err.message ? err.message : String(err);');
  lines.push('  const e = new Error(`loader for ${pattern} (${where}) threw: ${message}`);');
  lines.push('  e.cause = err;');
  lines.push('  // Keep the original stack as a property rather than appending it: a');
  lines.push('  // server log line should be readable, and the full trace is still there');
  lines.push('  // for anyone who wants it.');
  lines.push('  e.loaderStack = err && err.stack ? err.stack : null;');
  lines.push('  e.pattern = pattern;');
  lines.push('  e.url = url;');
  lines.push('  e.sourceFile = file;');
  lines.push('  return e;');
  lines.push('}');
  lines.push('');
  lines.push('export function renderSync(pattern, params = {}, url = pattern, data = null) {');
  lines.push('  const App = __appComponent();');
  lines.push('  if (!App) return null;');
  lines.push('  const table = __table();');
  lines.push('  // The seed carries the loader result: the page is rendered by `Router`');
  lines.push('  // inside the app and never receives props from here.');
  lines.push('  __seed_for_ssr({ table, path: pattern, data });');
  lines.push('  // Render the APP, not the page. Rendering the page produced HTML with');
  lines.push('  // none of the chrome, and hydrating the full app over it was React #418');
  lines.push('  // on every pre-rendered route. The app is what the browser mounts.');
  lines.push('  //');
  lines.push('  // The seed is NOT cleared here: `renderSync` only BUILDS the element, and');
  lines.push('  // React renders it afterwards when the caller calls `renderToString`.');
  lines.push('  // Clearing it in a `finally` before returning wiped it before the render');
  lines.push('  // ever read it, so every page came out as an empty shell with correct data');
  lines.push('  // inlined beside it. The caller clears it via `__clear_seed`.');
  lines.push('  return createElement(App, { params, path: pattern, url });');
  lines.push('}');
  lines.push('');
  lines.push('export async function renderFor(pattern, params = {}, url = pattern, request = null) {');
  lines.push('  try {');
  lines.push('    const data = await loadFor(pattern, params, url, request);');
  lines.push('    return { element: renderSync(pattern, params, url, data), data };');
  lines.push('  } catch (err) {');
  lines.push('    __clear_ssr_seed();');
  lines.push('    throw err;');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('export const __clear_seed = __clear_ssr_seed;');
  lines.push('');
  return lines.join('\n');
}
