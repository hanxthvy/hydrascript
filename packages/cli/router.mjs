// [xihanzu-NR]
/**
 * File-based routing for HydraScript.
 *
 * A page file becomes a route. `src/pages/about.hyx` is `/about`,
 * `src/pages/blog/[slug].hyx` is `/blog/:slug`. The mapping is computed here,
 * printed by `hydra routes`, and handed to the build as a generated module —
 * never inferred at runtime from directory listings, because a route table that
 * only exists inside a bundle cannot be inspected when it disagrees with the
 * filesystem.
 *
 * The conventions are deliberately the ones people already know from Next.js,
 * Nuxt and SvelteKit, borrowed exactly rather than invented:
 *
 *   index.hyx          -> /            (the folder's own page)
 *   about.hyx          -> /about
 *   blog/index.hyx     -> /blog
 *   blog/[slug].hyx    -> /blog/:slug  (one segment)
 *   docs/[...rest].hyx -> /docs/*      (one or more segments; also /docs/*)
 *   docs/[[...rest]].hyx -> /docs/*    (zero or more; also /docs)
 *   (marketing)/x.hyx  -> /x           (group: layout scope only, not in the URL)
 *   _partials/Hero.hyx -> not routable (a leading `_` on a segment means private)
 *   _layout.hyx        -> wraps every route in its folder and below
 *   _404.hyx           -> rendered when no route matches
 *   _error.hyx         -> error boundary for its folder
 *
 * The parameter NAME does not affect the URL — `[slug].hyx` and `[id].hyx` are
 * both `/blog/:x` — so a folder containing both is a contradiction, not a
 * precedence problem, and it is reported as an error naming both files. That is
 * the failure this module exists to make loud: silently picking one of them is
 * how a route stops answering for a reason nobody can see.
 *
 * There is no regex in the pattern language, no optional non-catch-all segment,
 * and no sorting rules the reader has to memorise. Specificity has exactly one
 * rule: a literal segment beats a one-segment param, which beats a catch-all.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The module specifier a project imports the generated route table from. */
export const ROUTES_MODULE = 'hydra:routes';

/** Where the generated table is written, relative to the project root. */
export const GENERATED_DIR = '.hydra';
export const GENERATED_FILE = 'routes.generated.js';

const LAYOUT_BASENAME = '_layout';
const NOT_FOUND_BASENAME = '_404';
const ERROR_BASENAME = '_error';

/**
 * A filename that only names a framework file, never a page.
 *
 * `_layout`, `_404` and `_error` are read as framework files at every level, so
 * a page may never be called that. Anything else starting with `_` is simply
 * private and not routable — which is the same rule Next.js uses for `_folder`.
 */
const FRAMEWORK_BASENAMES = new Set([LAYOUT_BASENAME, NOT_FOUND_BASENAME, ERROR_BASENAME]);

function isPrivateSegment(segment) {
  return segment.startsWith('_') || segment.startsWith('.');
}

/** `[slug]` -> `{ kind: 'param', name: 'slug' }`; anything else is a literal. */
function parseSegment(segment) {
  const optionalCatchAll = /^\[\[\.\.\.([A-Za-z_$][\w$]*)\]\]$/.exec(segment);
  if (optionalCatchAll) return { kind: 'catchall', name: optionalCatchAll[1], optional: true, raw: segment };

  const catchAll = /^\[\.\.\.([A-Za-z_$][\w$]*)\]$/.exec(segment);
  if (catchAll) return { kind: 'catchall', name: catchAll[1], optional: false, raw: segment };

  const param = /^\[([A-Za-z_$][\w$]*)\]$/.exec(segment);
  if (param) return { kind: 'param', name: param[1], raw: segment };

  // A malformed bracket is a mistake worth naming, not a literal folder called
  // `[slug` that quietly renders at a URL nobody intended.
  if (segment.includes('[') || segment.includes(']')) {
    return { kind: 'invalid', raw: segment };
  }

  return { kind: 'literal', value: segment, raw: segment };
}

/** One segment, spelled for the URL: `[slug]` -> `:slug`, `[...rest]` -> `*`. */
function segmentToPattern(part) {
  if (part.kind === 'literal') return part.value;
  if (part.kind === 'param') return ':' + part.name;
  if (part.kind === 'catchall') return part.optional ? '*?' : '*';
  return part.raw;
}

/** Specificity, best first. Compared segment by segment, left to right. */
const SEGMENT_RANK = { literal: 0, param: 1, catchall: 2 };

/**
 * Compare two routes so the most specific one wins.
 *
 * Segments are compared position by position, left to right; a literal beats a
 * param, which beats a catch-all. The tiebreak is the shorter pattern first,
 * then alphabetical, which only matters between routes that cannot both match
 * the same URL — the order is chosen to be readable, not to change resolution.
 */
function compareRoutes(a, b) {
  const shared = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < shared; i++) {
    const ra = SEGMENT_RANK[a.segments[i].kind] ?? 3;
    const rb = SEGMENT_RANK[b.segments[i].kind] ?? 3;
    if (ra !== rb) return ra - rb;
  }
  if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length;
  return a.pattern.localeCompare(b.pattern);
}

function walk(dir, base = dir, out = []) {
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
      walk(full, base, out);
    } else if (/\.(hyx|hsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan a pages directory into a route table.
 *
 * Returns `{ routes, layouts, notFound, errors, root }`. `routes` is sorted
 * most-specific-first, so `resolveRoute` can return the first match without any
 * further judgement. Nothing here throws: a project with a broken route should
 * be told which files disagree, not killed with a stack trace from the scanner.
 */
export function scanRoutes(pagesDir) {
  const root = path.resolve(pagesDir);
  const result = { root, routes: [], layouts: {}, notFound: [], errors: [], errors_diagnostics: [] };

  if (!fs.existsSync(root)) {
    // No pages directory is not an error: a project with a single mount point
    // and no routes is a legitimate HydraScript app.
    return result;
  }

  const files = walk(root);

  /** folder (relative, POSIX, '' for the root) -> { params: [...] } collisions. */
  const paramSlots = new Map();

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const noExt = rel.replace(/\.(hyx|hsx)$/, '');
    const dirSegments = noExt.split('/').slice(0, -1);
    const basename = noExt.split('/').pop();

    // Any private segment makes the whole file non-routable — except that the
    // framework files are recognised at the level they sit in.
    const parentPrivate = dirSegments.some(isPrivateSegment);

    if (FRAMEWORK_BASENAMES.has(basename)) {
      const folder = dirSegments.join('/');
      if (basename === LAYOUT_BASENAME) {
        result.layouts[folder] = rel;
      } else if (basename === NOT_FOUND_BASENAME) {
        result.notFound.push({ folder, file: rel });
      } else {
        result.errors.push({ folder, file: rel });
      }
      continue;
    }

    if (parentPrivate) continue;
    if (isPrivateSegment(basename)) continue;

    const parts = dirSegments.map((s) => ({ raw: s, kind: 'group', value: s }));
    // Route groups `(marketing)` scope layouts without appearing in the URL.
    parts.forEach((p, i) => {
      if (p.raw.startsWith('(') && p.raw.endsWith(')')) {
        parts[i] = { kind: 'group', value: null, raw: p.raw };
      }
    });

    const urlParts = [];
    for (const raw of dirSegments) {
      if (raw.startsWith('(') && raw.endsWith(')')) continue; // group: not in the URL
      const parsed = parseSegment(raw);
      if (parsed.kind === 'invalid') {
        result.errors_diagnostics.push(
          `${rel}: the folder segment "${raw}" is not a valid route segment. ` +
            `Use [name] for one segment, [...name] for one or more, [[...name]] for zero or more.`,
        );
        continue;
      }
      urlParts.push(parsed);
    }

    if (basename !== 'index') {
      const parsed = parseSegment(basename);
      if (parsed.kind === 'invalid') {
        result.errors_diagnostics.push(
          `${rel}: "${basename}" is not a valid route segment. ` +
            `Use [name] for one segment, [...name] for one or more, [[...name]] for zero or more.`,
        );
        continue;
      }
      urlParts.push(parsed);
    }

    // Two different param names in one folder position describe the same URLs,
    // so one of them can never be reached through the pattern it declares.
    for (let i = 0; i < urlParts.length; i++) {
      const p = urlParts[i];
      if (p.kind !== 'param' && p.kind !== 'catchall') continue;
      const slot = dirSegments.slice(0, i).join('/') + '#' + i;
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

    const pattern = '/' + urlParts.map(segmentToPattern).join('/');
    result.routes.push({
      pattern: pattern === '/' ? '/' : pattern.replace(/\/$/, ''),
      file: rel,
      // Only the params that a param/catch-all segment introduces.
      params: urlParts.filter((p) => p.kind === 'param' || p.kind === 'catchall').map((p) => p.name),
      segments: urlParts,
      hasParams: urlParts.some((p) => p.kind === 'param' || p.kind === 'catchall'),
      // The folder a `_layout`/`_error` applies from, with groups kept so two
      // groups sharing a URL can still carry different layouts.
      group: dirSegments.filter((s) => s.startsWith('(') && s.endsWith(')')).join('/'),
      dir: dirSegments.join('/'),
    });
  }

  result.routes.sort(compareRoutes);
  return result;
}

/**
 * Match a URL path against the route table.
 *
 * Returns `{ route, params }` or `null`. Matching is per segment, left to
 * right, with no backtracking: this pattern language has no alternation, so a
 * single pass is complete.
 */
export function matchRoute(urlPath, routes) {
  const clean = ('/' + String(urlPath ?? '/').replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
  const parts = clean === '/' ? [] : clean.slice(1).split('/');

  for (const route of routes) {
    const params = matchSegments(parts, route.segments);
    if (params) return { route, params };
  }
  return null;
}

function matchSegments(urlParts, patternParts) {
  const params = {};
  let i = 0;

  for (let p = 0; p < patternParts.length; p++) {
    const seg = patternParts[p];
    if (seg.kind === 'group') continue;

    if (seg.kind === 'catchall') {
      const rest = urlParts.slice(i);
      if (rest.length === 0 && !seg.optional) return null;
      params[seg.name] = rest.map(decodePart);
      return params;
    }

    if (i >= urlParts.length) return null;
    const value = decodePart(urlParts[i]);
    i += 1;

    if (seg.kind === 'param') {
      params[seg.name] = value;
    } else if (seg.value !== value) {
      return null;
    }
  }

  return i === urlParts.length ? params : null;
}

function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The source of the generated module.
 *
 * It is a plain ESM module with no imports, so a bundler can inline it and a
 * person can read it. `params` is empty for a static route, which is what the
 * SSG pass uses to decide whether a page can be pre-rendered without guessing.
 */
export function routesModuleSource(table, { base = '/' } = {}) {
  const payload = {
    base,
    routes: table.routes.map((r) => ({
      pattern: r.pattern,
      file: r.file,
      params: r.params,
    })),
    layouts: table.layouts,
    hasNotFound: table.notFound.length > 0,
  };
  return (
    '// [xihanzu-NR]\n' +
    '// GENERATED by `hydra build` — do not edit, do not commit.\n' +
    '// Source: the .hyx files under the pages directory. Edit those.\n' +
    'export const routes = ' +
    JSON.stringify(payload.routes, null, 2) +
    ';\n' +
    'export const layouts = ' +
    JSON.stringify(payload.layouts, null, 2) +
    ';\n' +
    'export const hasNotFound = ' +
    JSON.stringify(payload.hasNotFound) +
    ';\n' +
    'export const base = ' +
    JSON.stringify(payload.base) +
    ';\n' +
    'export default { routes, layouts, hasNotFound, base };\n'
  );
}

/** Write the generated module into the project. Returns its absolute path. */
export function writeRoutesModule(cwd, table, opts = {}) {
  const dir = path.join(cwd, GENERATED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, GENERATED_FILE);
  fs.writeFileSync(file, routesModuleSource(table, opts), 'utf8');
  return file;
}

/**
 * An esbuild plugin that answers `import ... from 'hydra:routes'`.
 *
 * The specifier is a virtual module rather than a file the user could import by
 * accident, for the same reason the runtime specifier is a contract: generated
 * output must not be reachable by a relative path that looks hand-written.
 */
export function routesEsbuildPlugin(table, { base = '/' } = {}) {
  return {
    name: 'hydra-routes',
    setup(build) {
      build.onResolve({ filter: /^hydra:routes$/ }, () => ({
        path: ROUTES_MODULE,
        namespace: 'hydra-routes',
      }));
      build.onLoad({ filter: /.*/, namespace: 'hydra-routes' }, () => ({
        contents: routesModuleSource(table, { base }),
        loader: 'js',
        resolveDir: table.root,
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
    lines.push(`${'ROUTE'.padEnd(width)}  FILE`);
    for (const r of table.routes) {
      const kind = r.hasParams ? '  (dynamic)' : '';
      lines.push(`${r.pattern.padEnd(width)}  src/${r.file}${kind}`);
    }
  }
  for (const [folder, file] of Object.entries(table.layouts)) {
    lines.push(`layout   ${folder || '.'}  <-  src/${file}`);
  }
  for (const nf of table.notFound) lines.push(`404      ${nf.folder || '.'}  <-  src/${nf.file}`);
  for (const er of table.errors) lines.push(`error    ${er.folder || '.'}  <-  src/${er.file}`);
  return lines.join('\n');
}

/** The same table as `routeTable`, for tooling. */
export function routesJson(table) {
  return {
    root: table.root,
    routes: table.routes.map((r) => ({
      pattern: r.pattern,
      file: r.file,
      params: r.params,
      dynamic: r.hasParams,
      layouts: layoutChainFor(r.dir, table),
    })),
    layouts: table.layouts,
    notFound: table.notFound,
    errors: table.errors,
  };
}

/**
 * Every `_layout` that wraps a folder, outermost first.
 *
 * Walking up from the folder is the whole algorithm; a layout in a parent
 * folder applies to its descendants, which is what nesting means everywhere
 * else.
 */
export function layoutChainFor(dir, table) {
  const chain = [];
  const parts = dir ? dir.split('/') : [];
  for (let i = 0; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join('/');
    if (table.layouts[folder]) chain.push(table.layouts[folder]);
  }
  return chain;
}
