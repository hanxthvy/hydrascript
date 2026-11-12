// [xihanzu-NR]
/**
 * API routes (`src/api/*.hys`) and middleware (`src/middleware.hys`).
 *
 * A `.hys` file in `src/api` is a URL: `hello.hys` answers `/api/hello`. It
 * exports one function per HTTP method and each is called as `handler(req)`
 * for GET and `handler(req, body)` for the rest. That is the whole convention —
 * no decorators, no router object, no manifest. The file IS the route, exactly
 * like `src/pages`, because a project that already learned one naming rule
 * should not have to learn a second.
 *
 * Why a separate folder instead of `src/pages/api`: a page module is a CLIENT
 * module. Its imports end up in the browser and it renders there. An API route
 * is the opposite of that, and putting both under one folder makes the
 * distinction a convention inside the folder rather than a fact of the layout.
 * `src/api` is scanned by this file alone and is never reachable from the
 * client entry.
 *
 * Like page server halves, the sources are bundled ahead of time into one
 * CommonJS module in `.hydra/`, because node cannot load a `.hys` and the dev
 * server must not carry a second compiler.
 *
 * Naming follows the page router exactly: a folder is a URL segment, `[id]` is
 * a parameter (`req.params.id`), `[...path]` is a catch-all, and `index` is the
 * folder's own URL. One naming language in a project, not two.
 *
 * `src/api/users/index.hys`     -> /api/users
 * `src/api/users/[id].hys`      -> /api/users/:id
 * `src/api/files/[...path].hys` -> /api/files/*
 *
 * Deliberately absent: per-method files (`get.hys` inside a folder). That one
 * IS a second naming rule with a second matcher, and the method is already
 * spelled as an export name (`export function get(req)`), so a second spelling
 * would buy nothing. Folders and parameters are supported — the scanner below
 * walks subdirectories and parses `[param]`; do not take this paragraph's word
 * for what the code does, read `walk()` and `parseApiSegment()`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { readBody, requestFor } from './actions.mjs';
import { httpIntent, sendHttpIntent, sendError } from './http.mjs';
import { routesEsbuildPlugin } from './router.mjs';

const require = createRequire(import.meta.url);

/** The HTTP methods a route may export. `OPTIONS` is answered by the server. */
export const API_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** The middleware file, relative to the project root. */
export const MIDDLEWARE_FILE = path.join('src', 'middleware.hys');

/** The bundled artifact both the server commands and a node deploy load. */
export const API_BUNDLE = path.join('.hydra', 'api.cjs');

/** `src/api` for a project, or null when it has none. */
export function apiDirectory(cwd) {
  const dir = path.join(cwd, 'src', 'api');
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Scan `src/api` into a route table.
 *
 * `index.hys` answers `/api` itself, so a project can have an API root without
 * a file named after nothing. Everything else is `/api/<basename>`.
 *
 * Nothing here throws: a project with an unusable file is told which file and
 * why, and the build decides what to do about it.
 */
export function scanApiRoutes(cwd) {
  const dir = apiDirectory(cwd);
  const result = { dir, routes: [], ignored: [], errors: [] };
  if (!dir) return result;

  /**
   * Walk `src/api`, one URL segment per folder.
   *
   * Folders used to be refused outright, and the refusal was printed: a
   * project that grew past six endpoints had a flat pile of `users-create.hys`
   * and `users-id.hys` files, or it hand-parsed the id out of `req.path`. The
   * rule is the one the page router already uses, so there is one naming
   * language in the project rather than two:
   *
   *   src/api/users/index.hys     -> /api/users
   *   src/api/users/[id].hys      -> /api/users/:id      (req.params.id)
   *   src/api/files/[...path].hys -> /api/files/*        (req.params.path)
   *
   * A leading `_` is private at any level, exactly as it is for pages.
   */
  const walk = (absDir, urlParts, relParts) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.join(...relParts, entry.name).split(path.sep).join('/');

      if (entry.isDirectory()) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) {
          result.ignored.push({
            file: `src/api/${rel}`,
            reason: 'a leading _ marks a private folder, which is not routable',
          });
          continue;
        }
        const seg = parseApiSegment(entry.name);
        if (!seg) {
          result.errors.push({
            file: `src/api/${rel}`,
            reason: `"${entry.name}" is not a usable URL segment: [param], [...rest] or a literal name`,
          });
          continue;
        }
        // A catch-all must be the LAST segment: anything below it could never
        // be reached, so it is a mistake worth naming rather than a folder that
        // silently loses its children.
        if (seg.kind === 'catchall' && urlParts.length > 0) {
          // no-op: length is the position in the URL, not inside the catch-all
        }
        walk(abs, [...urlParts, seg], [...relParts, entry.name]);
        continue;
      }

      if (!/\.(hys|hs)$/.test(entry.name)) continue;
      const base = entry.name.replace(/\.(hys|hs)$/, '');
      if (base.startsWith('_') || base.startsWith('.')) {
        result.ignored.push({
          file: `src/api/${rel}`,
          reason: 'a leading _ marks a private file, which is not a route',
        });
        continue;
      }

      const seg = parseApiSegment(base);
      if (!seg) {
        result.errors.push({
          file: `src/api/${rel}`,
          reason: `"${base}" is not a usable URL segment: [param], [...rest] or a literal name`,
        });
        continue;
      }

      // `index` contributes no segment: the folder's own URL is the route.
      const urlParts2 = seg.kind === 'index' ? urlParts : [...urlParts, seg];
      const pattern =
        urlParts2.length === 0
          ? '/api'
          : '/api/' + urlParts2.map(segmentToPattern).join('/');

      result.routes.push({
        pattern,
        file: `src/api/${rel}`,
        abs,
        params: urlParts2.filter((p) => p.kind !== 'literal').map((p) => p.name),
        segments: [{ kind: 'literal', value: 'api' }, ...urlParts2],
      });
    }
  };

  walk(dir, [], []);

  // Two files claiming one URL is a decision, not a race.
  //
  // Keyed by the URL SHAPE, not the printed pattern: `users/[id].hys` and
  // `users/[slug].hys` print `:id` and `:slug` — different strings, the same
  // URL — and keying on the string let both ship, with whichever sorted first
  // answering and the other unreachable. A param and a catch-all in the same
  // position are the same shape for the same reason.
  const shape = (r) =>
    (r.segments || [])
      .map((seg) => (seg.kind === 'literal' ? `=${seg.value}` : seg.kind === 'param' ? ':' : '*'))
      .join('/');
  const owners = new Map();
  for (const r of result.routes) {
    const key = shape(r);
    const prev = owners.get(key);
    if (prev) {
      result.errors.push({
        file: r.file,
        reason:
          `this file and ${prev.file} both answer ${r.pattern}: one URL position, ` +
          `two spellings (${prev.pattern} and ${r.pattern}). Give them the same ` +
          `parameter name, or move one.`,
      });
    } else {
      owners.set(key, r);
    }
  }

  // Stable order so the printed table and the build log do not shuffle between
  // runs: `readdirSync` order is the filesystem's, not the project's.
  result.routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
  return result;
}

/**
 * One folder or file name as an API URL segment.
 *
 * Returns `{ kind: 'index' }` for `index`, `{ kind: 'param', name }` for
 * `[id]`, `{ kind: 'catchall', name }` for `[...rest]`, `{ kind: 'literal',
 * value }` otherwise, and `null` when the name is malformed (a stray bracket,
 * an empty param name). A malformed name is reported rather than routed as a
 * literal: a URL nobody meant is worse than a build error.
 */
export function parseApiSegment(name) {
  if (name === 'index') return { kind: 'index' };
  const catchAll = /^\[\.\.\.([A-Za-z_$][\w$]*)\]$/.exec(name);
  if (catchAll) return { kind: 'catchall', name: catchAll[1] };
  const optionalCatchAll = /^\[\[\.\.\.([A-Za-z_$][\w$]*)\]\]$/.exec(name);
  if (optionalCatchAll) return { kind: 'catchall', name: optionalCatchAll[1], optional: true };
  const param = /^\[([A-Za-z_$][\w$]*)\]$/.exec(name);
  if (param) return { kind: 'param', name: param[1] };
  if (name.includes('[') || name.includes(']')) return null;
  if (name.trim() === '') return null;
  return { kind: 'literal', value: name };
}

/** A segment as it appears in a printed pattern: `[id]` -> `:id`. */
function segmentToPattern(seg) {
  if (seg.kind === 'literal') return seg.value;
  if (seg.kind === 'param') return ':' + seg.name;
  if (seg.kind === 'catchall') return seg.optional ? '*?' : '*';
  return '';
}

/** `src/middleware.hys`, or null. */
export function middlewarePath(cwd) {
  const file = path.join(cwd, MIDDLEWARE_FILE);
  return fs.existsSync(file) ? file : null;
}

/**
 * The bundle source for the API table and the middleware.
 *
 * Exported as data, not as behaviour: the server asks this module for a table
 * and dispatches. There is no second router here — matching is `matchRoute`
 * from `runtime/router-core.js`, the same one the browser uses.
 */
export function apiBundleSource(table, middlewareAbs) {
  const lines = [
    '// [xihanzu-NR]',
    '// GENERATED by `hydra build` — the API table for `hydra dev`, `preview` and',
    '// the node target. Edit the .hys files, not this one.',
    '',
  ];
  const ids = new Map();
  table.routes.forEach((r, i) => {
    const id = `__api_${i}`;
    ids.set(r.file, id);
    lines.push(`import * as ${id} from ${JSON.stringify(r.abs)};`);
  });
  let mwId = null;
  if (middlewareAbs) {
    mwId = '__middleware';
    lines.push(`import * as ${mwId} from ${JSON.stringify(middlewareAbs)};`);
  }
  lines.push('');
  lines.push(`export const methods = ${JSON.stringify(API_METHODS)};`);
  lines.push('');
  lines.push('export const routes = [');
  for (const r of table.routes) {
    const id = ids.get(r.file);
    const handlers = API_METHODS.map((m) => `${m}: ${id}.${m} || null`).join(', ');
    lines.push(
      `  { pattern: ${JSON.stringify(r.pattern)}, file: ${JSON.stringify(r.file)}, segments: ${JSON.stringify(r.segments)}, handlers: { ${handlers} } },`,
    );
  }
  lines.push('];');
  lines.push('');
  if (mwId) {
    lines.push(`export const middleware = ${mwId}.handle || null;`);
  } else {
    lines.push('export const middleware = null;');
  }
  lines.push('');
  lines.push('/** The route for a URL, or null. */');
  lines.push('export function match(url) {');
  lines.push('  for (const route of routes) {');
  lines.push('    const params = matchSegments(split(url), route.segments);');
  lines.push('    if (params) return { route, params };');
  lines.push('  }');
  lines.push('  return null;');
  lines.push('}');
  lines.push('function split(url) {');
  lines.push('  const clean = ("/" + String(url || "/").replace(/^\\/+/, "")).replace(/\\/+$/, "");');
  lines.push('  return clean === "/" ? [] : clean.slice(1).split("/");');
  lines.push('}');
  lines.push('function matchSegments(parts, pattern) {');
  lines.push('  const params = {};');
  lines.push('  let i = 0;');
  lines.push('  for (const seg of pattern) {');
  lines.push('    if (seg.kind === "catchall") {');
  lines.push('      const rest = parts.slice(i);');
  lines.push('      if (rest.length === 0 && !seg.optional) return null;');
  lines.push('      params[seg.name] = rest;');
  lines.push('      return params;');
  lines.push('    }');
  lines.push('    if (i >= parts.length) return null;');
  lines.push('    if (seg.kind === "param") params[seg.name] = parts[i];');
  lines.push('    else if (seg.value !== parts[i]) return null;');
  lines.push('    i += 1;');
  lines.push('  }');
  lines.push('  return i === parts.length ? params : null;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the API bundle entry, and say whether there was anything to write.
 *
 * `--target static` calls this only to know what it is dropping; the file is
 * still written because `dev` and `preview` build with the same code path and a
 * target-specific hole in `.hydra/` would make `preview` after a static build
 * answer 404 for routes the project has.
 */
export function writeApiBundle(cwd, table) {
  const middlewareAbs = middlewarePath(cwd);
  if (table.routes.length === 0 && !middlewareAbs) return null;
  const dir = path.join(cwd, '.hydra');
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, 'api.entry.mjs');
  const mwAbs = middlewareAbs ? middlewareAbs.split(path.sep).join('/') : null;
  fs.writeFileSync(entry, apiBundleSource(table, mwAbs), 'utf8');
  return entry;
}

/**
 * Bundle the API entry into a module node can load.
 *
 * Same esbuild options and the same plugins as `bundleActions`, because the
 * failure mode of two server bundles drifting apart is a project where an
 * `action` compiles and an API route does not.
 */
export async function bundleApi(esbuild, entry, { outfile, cwd, pkgRoot, hydraAlias, serverAlias, compilerPlugin }) {
  if (!entry) return null;
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: true,
    // CommonJS for the same reason as the action bundle: the server loads it
    // with `require`, which needs no loader and no cache-busting query.
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile,
    jsx: 'automatic',
    logLevel: 'silent',
    nodePaths: [path.join(cwd, 'node_modules'), path.join(pkgRoot, 'node_modules')],
    resolveExtensions: ['.hyx', '.hys', '.hsx', '.hs', '.mjs', '.js', '.jsx', '.ts', '.tsx', '.json'],
    plugins: [
      {
        name: 'hydra-runtime-specifiers',
        setup(build) {
          build.onResolve({ filter: /^hydra(\/[a-z]+)?$/ }, (args) => {
            if (args.path === 'hydra') return { path: hydraAlias };
            if (args.path === 'hydra/server') return { path: serverAlias };
            return null;
          });
        },
      },
      // A server bundle may read ANY variable — that is the point of the split
      // — so this plugin is created WITHOUT the client-only env guard.
      compilerPlugin(),
      routesEsbuildPlugin(
        { root: cwd, routes: [], layouts: {}, notFound: [], errors: [], errors_diagnostics: [], serverFiles: [] },
        { base: '/', cwd },
      ),
    ],
  });
  return outfile;
}

/**
 * Load the generated API bundle.
 *
 * The cache entry is dropped ONLY during development. `hydra dev` rewrites this
 * file on save, so a cache keyed by path would answer the previous build's
 * handlers for the rest of the session. In production the bundle is immutable,
 * and re-requiring it per request re-evaluated every module in it: module-level
 * state (a connection pool, a counter, a cache) was recreated on every request,
 * and the re-parse cost dominated the request. Measured on a 1.25 MB bundle:
 * 93 req/s with the cache dropped per request, 1.258 req/s without — a 13x
 * difference from one `delete` statement.
 *
 * `HYDRA_DEV` is set by `runDev` itself rather than by a user's environment, so
 * the dev behaviour cannot leak into a `preview` or a real deployment by
 * accident.
 */
export function loadApi(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    if (process.env.HYDRA_DEV === '1') {
      delete require.cache[require.resolve(file)];
    }
    return require(file);
  } catch (e) {
    console.error(`[hydra] could not load the API bundle: ${e.message}`);
    return null;
  }
}

/**
 * Route files that export none of the method names.
 *
 * A `def get(req)` without `export` compiles, bundles, and answers 405 to every
 * request — a build that succeeds and a feature that does not exist. The
 * compiled output is the only honest place to look, because `export` is what
 * the emitter writes and what the runtime reads.
 */
export function missingMethodExports(routes, compile) {
  const out = [];
  for (const r of routes) {
    let res;
    try {
      res = compile(r.abs);
    } catch {
      continue; // a compile error is reported by the bundle step, with its own message
    }
    if (!res || res.error) continue;
    const code = String(res.code || '');
    const has = API_METHODS.some((m) =>
      new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${m}\\b`).test(code) ||
      new RegExp(`\\bexport\\s*\\{[^}]*\\b${m}\\b`).test(code),
    );
    if (!has) out.push(r.file);
  }
  return out;
}

/** Where the API bundle is, if this project has one. Read from disk, not memory. */
export function readApiBundle(cwd) {
  const f = path.join(cwd, API_BUNDLE);
  return fs.existsSync(f) ? f : null;
}

/**
 * The record `runBuild` leaves in `.hydra/build.json`.
 *
 * `preview` is a separate process from the build, so the only honest way to
 * know whether the artifact on disk contains the server half is for the build
 * to have written it down. An absent record means "built before this existed",
 * and the answer for that is the old behaviour: static.
 */
export function readBuildRecord(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.hydra', 'build.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Turn a handler's return value into `{ status, body }`.
 *
 * Two shapes, both of which the language already produces:
 *
 *   `return {"ok": True}`          -> 200 with that object
 *   `return {"id": 1}, 201`        -> 201 with the object
 *
 * A TWO-element list whose second item is a valid status code is read as that
 * tuple. That rule is narrower than it was, and deliberately so: HydraScript
 * emits a list and a tuple as the same JavaScript array, so "any array is a
 * tuple" made `return [1, 2, 3]` answer `status: 2`. The length and the
 * `100..599` range are what separate a tuple from a list that happens to have
 * two items — not a guess about intent.
 *
 * `json(value, status=200)` from `hydra/server` is the unambiguous spelling;
 * this convention stays because it is what the language's own docs teach and
 * changing it would break every existing route for no gain.
 *
 * And `None` is 204: a handler that has nothing to say should not have to say
 * `{}`. An explicit `{"status": ..., "body": ...}` is also accepted, because an
 * action already returns that shape and one idea in two spellings is worse than
 * the two lines this costs.
 */
export function apiResult(out) {
  if (out === undefined || out === null) return { status: 204, body: null };
  if (isTuple(out)) {
    const [body, status] = out;
    return { status, body: body === undefined ? null : body };
  }
  if (typeof out === 'object' && ('status' in out || 'headers' in out) && 'body' in out) {
    return {
      status: Number.isInteger(out.status) ? out.status : 200,
      body: out.body === undefined ? null : out.body,
      headers: out.headers,
    };
  }
  return { status: 200, body: out };
}

/** A `[body, status]` pair, or a plain list. See `apiResult`. */
export function isTuple(value) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const status = value[1];
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

/** The JSON answer for an API route, or a plain body when the value is a string. */
function sendResult(res, { status, body, headers }, headOnly = false) {
  const head = { ...(headers || {}) };
  if (body === null || body === undefined) {
    res.writeHead(status, head);
    res.end();
    return;
  }
  if (typeof body === 'string') {
    if (!head['Content-Type']) head['Content-Type'] = 'text/plain; charset=utf-8';
    res.writeHead(status, head);
    // HEAD: the headers a GET would send, and no body. The handler still ran,
    // because its side effects (a cache fill) are not the caller's business.
    res.end(headOnly ? undefined : body);
    return;
  }
  if (!head['Content-Type']) head['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(status, head);
  res.end(headOnly ? undefined : JSON.stringify(body));
}

/**
 * Answer an API request, middleware included.
 *
 * Order, and it matters: middleware runs for EVERY request the API layer sees
 * (including a path that turns out to be no route), because "block /api/admin"
 * has to work whether or not `/api/admin` exists. A middleware reply stops the
 * request where it is.
 *
 * `@returns {Promise<boolean>} true when this answered the request`
 */
export async function handleApiRequest(req, res, url, bundlePath, options = {}) {
  // Ditolak SEBELUM body dibaca. Membaca body lebih dulu berarti penyerang
  // lintas situs tetap bisa menghabiskan CPU dan memori server walau
  // permintaannya akhirnya ditolak.
  if (options.refuseCrossOrigin) {
    sendError(
      res,
      403,
      'cross_origin_api',
      'cross-origin API request refused',
      {
        origin: options.origin,
        hint: 'API routes accept same-origin requests; a browser sent this from another site',
      },
    );
    return true;
  }

  const rawPath = url.split('?')[0];
  // Decode ONCE, here, and match on the decoded path.
  //
  // Params used to be taken straight from the raw URL, so `/api/users/%61dmin`
  // produced `params.id === "%61dmin"` while the runner's own routing decoded for
  // actions — two layers disagreeing about the same segment. An authorisation
  // check written as `params.id === 'admin'` was then bypassed by the encoding
  // whenever the handler normalised. `params` are decoded exactly once, and this
  // is where.
  let reqPath;
  try {
    reqPath = decodeURIComponent(rawPath);
  } catch {
    sendError(res, 400, 'bad_path', 'the request path is not valid percent-encoding');
    return true;
  }
  const mod = loadApi(bundlePath);
  if (!mod) {
    sendError(res, 500, 'api_bundle_missing', 'the API bundle is missing; run `hydra build` again');
    return true;
  }

  const limit = Number.isInteger(options.bodyLimit) ? options.bodyLimit : undefined;
  let rawBody = '';
  try {
    rawBody = await readBody(req, limit);
  } catch (e) {
    // A refused body is answered, not dropped. `Connection: close` because the
    // rest of the request was never read: keeping the socket alive would make
    // the leftover bytes look like the start of the NEXT request.
    sendError(
      res,
      413,
      'body_too_large',
      e.message,
      { limit: e.limit ?? null, hint: 'raise server.bodyLimit in hydraconfig.json, or send less' },
      { Connection: 'close' },
    );
    return true;
  }

  // ONE request object, handed to middleware and then to the handler. Mutation
  // by reference is how middleware "changes" a request: a copy would mean the
  // handler sees the original and the feature silently does nothing.
  const request = {
    ...requestFor(req, url, rawBody),
    path: reqPath,
  };

  const hit = mod.match(reqPath);

  // `req.params` for a nested route: `/api/users/[id]` answers with
  // `{"id": "42"}`, and a catch-all gives a list. Set BEFORE the middleware
  // runs, so middleware can authorise against the parameter it is guarding
  // rather than re-parsing the path itself.
  if (hit) request.params = hit.params || {};

  if (typeof mod.middleware === 'function') {
    let verdict;
    try {
      verdict = await mod.middleware(request);
    } catch (e) {
      sendError(res, 500, 'middleware_threw', `middleware threw: ${e && e.message ? e.message : e}`);
      return true;
    }
    if (verdict !== undefined && verdict !== null && verdict !== false) {
      // A middleware that redirects or refuses says so through the same two
      // helpers a handler uses, so it is read the same way.
      if (sendHttpIntent(res, httpIntent(verdict))) return true;
      sendResult(res, apiResult(verdict));
      return true;
    }
  }

  if (!hit) return false;

  // HEAD is GET without the body, per RFC 9110. The first version listed only
  // get/post/put/patch/delete, so `curl -I`, every load balancer health check
  // and every uptime monitor got 405 from an endpoint that plainly existed.
  const method = String(req.method || 'GET').toLowerCase();
  const effective = method === 'head' ? 'get' : method;
  const allowed = API_METHODS.filter((m) => typeof hit.route.handlers[m] === 'function');
  const allowHeader = allowed
    .flatMap((m) => (m === 'get' ? ['GET', 'HEAD'] : [m.toUpperCase()]))
    .join(', ');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: allowHeader });
    res.end();
    return true;
  }

  const fn = hit.route.handlers[effective];
  if (typeof fn !== 'function') {
    sendError(
      res,
      405,
      'method_not_allowed',
      `${req.method} is not handled by ${hit.route.file}`,
      { allow: allowHeader.split(', ') },
      { Allow: allowHeader },
    );
    return true;
  }

  try {
    const out = effective === 'get' ? await fn(request) : await fn(request, request.body);
    // A handler that redirects or refuses is an HTTP instruction, not a JSON
    // value. Reading it here is what makes `fail(401)` answer 401.
    const intent = httpIntent(out);
    if (intent) {
      sendHttpIntent(res, intent);
      return true;
    }
    sendResult(res, apiResult(out), method === 'head');
  } catch (e) {
    // A handler that throws is a bug in the handler, and the answer says which
    // file, because a bare 500 leaves the author reading server logs for a path.
    const message = e && e.message ? e.message : String(e);
    console.error(`[hydra] API ${req.method} ${hit.route.pattern} threw: ${message}`);
    sendError(res, 500, 'handler_threw', message, {
      route: hit.route.pattern,
      file: hit.route.file,
    });
  }
  return true;
}

/**
 * What a static build is throwing away, in the words of the person who has to
 * explain it later.
 *
 * Deliberately noisy. An API route that builds "successfully" and 404s in
 * production is the failure this text exists to prevent, and a one-line note at
 * the top of a build log is the kind of thing that scrolls past.
 */
export function droppedForStatic(cwd, table) {
  const middleware = middlewarePath(cwd);
  const lines = [];
  if (table.routes.length === 0 && !middleware) return lines;
  lines.push('');
  lines.push('  ============================================================');
  lines.push('  --target static: the server half is NOT in this build');
  lines.push('  ============================================================');
  for (const r of table.routes) {
    lines.push(`  dropped  ${r.pattern.padEnd(24)} ${r.file}`);
  }
  if (middleware) {
    lines.push(`  dropped  (middleware)             ${MIDDLEWARE_FILE.split(path.sep).join('/')}`);
  }
  for (const ig of table.ignored) lines.push(`  ignored  ${ig.file} — ${ig.reason}`);
  lines.push('');
  lines.push('  A static host has no server, so these cannot answer. Deploy with');
  lines.push('  `hydra build --target node` to keep them, or delete the files.');
  lines.push('');
  return lines;
}
