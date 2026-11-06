// [xihanzu-NR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

const selfRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

import { writeActionBundle, bundleActions, loadActions, readBody, requestFor } from './actions.mjs';
import { httpIntent, sendHttpIntent, sendError } from './http.mjs';
import { loadProjectEnv, publicEnvValues, clientEnvViolations, describeClientEnvViolation } from './env.mjs';
import {
  API_BUNDLE,
  MIDDLEWARE_FILE,
  scanApiRoutes,
  writeApiBundle,
  bundleApi,
  readApiBundle,
  readBuildRecord,
  missingMethodExports,
  middlewarePath,
  handleApiRequest,
  droppedForStatic,
} from './api-routes.mjs';
import { attachSocketServer, injectHmrClient } from './hmr.mjs';
import { CompileCache, CompilePool, cacheDirFor, shouldPool, sourceFilesUnder } from './compile-cache.mjs';
import { handleDataRequest, createRenderer, SERVER_BUNDLE } from './ssr.mjs';
import {
  findTestFiles,
  testRoot,
  readSnapshots,
  writeSnapshots,
  bundleTest,
  parseTestOutput,
  runBundle,
} from './testing.mjs';

import {
  scanRoutes,
  writeRoutesModule,
  writeSsgEntry,
  routesEsbuildPlugin,
  routeTable,
  routesJson,
  matchRoute,
} from './router.mjs';
import { applyMeta, validateRichMeta } from './meta.mjs';

/**
 * The entrypoint filenames, in priority order. ONE list: the runner resolves
 * against it, the error message names every one of them, and a test in
 * `entrypoint.test.mjs` checks `hydra init` produces a project the runner
 * accepts, so the scaffold cannot drift away from this.
 */
export const ENTRY_CANDIDATES = [
  'src/main.hyx',
  'src/main.hsx',
  'src/index.hyx',
  'src/index.hsx',
];

function resolvePkg(name, cwd) {
  // HERE is the installed package, `../..` the repo root. The author's absolute
  // checkout path used to sit in this list as a third fallback, which meant a
  // dependency could resolve from a directory that has nothing to do with the
  // project being built — and it made every install on another machine depend on
  // a path that does not exist there.
  const bases = [
    HERE,
    path.join(HERE, '../..'),
    cwd,
  ];
  for (const base of bases) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      return req.resolve(name);
    } catch {}
  }
  try {
    return selfRequire.resolve(name);
  } catch {
    throw new Error(`Cannot resolve package '${name}'`);
  }
}

// One cache per resolved path. `hydra dev` rebuilds on every save, and these
// four packages are ~400-500 ms of the first build; re-importing them on each
// rebuild was pure repetition. Resolving is still done per call so a project
// whose node_modules changed is picked up.
const bundlerDepsCache = new Map();

// `hydra dev` keeps one esbuild context alive and calls rebuild() on each save.
// A fresh `esbuild.build` re-parses the entire module graph every time; a
// context keeps the graph and re-resolves only what changed. Cleared when a
// build throws, so a broken option cannot wedge the dev loop forever.
let devEsbuildContext = null;
// The `define` map that context was created with. A context freezes it, and
// `PUBLIC_*` values live in it, so a `.env` edit means the context is stale and
// must be rebuilt rather than reused.
let devEsbuildDefineKey = null;


/**
 * esbuild is required; everything else is the project's choice.
 *
 * esbuild is the bundler — there is no build without it, so a missing copy is a
 * real error. PostCSS, Tailwind and Autoprefixer are a CSS PIPELINE, and which
 * pipeline a project wants is not the framework's decision:
 *
 *   - no `src/index.css`                     -> plain CSS esbuild already handled
 *   - `postcss.config.*` present             -> that config decides, whatever it
 *                                               names (Tailwind, autoprefixer,
 *                                               sass, nesting, nothing)
 *   - `styling: ["unicorn", ...]` in config  -> those plugins, and only those
 *   - `tailwind` key, or a tailwind.config   -> Tailwind + autoprefixer only
 *   - none of the above, but index.css exists -> plain PostCSS: vendor prefixes
 *                                               via autoprefixer if installed,
 *                                               otherwise passthrough
 *
 * Missing optional packages are `null`, not a crash. A project using plain CSS
 * must not be forced to install Tailwind to get a build.
 */
async function loadBundlerDeps(cwd) {
  const esbuildPath = resolvePkg('esbuild', cwd);

  /**
   * A CSS dependency belongs to the PROJECT, so it is resolved from there only.
   *
   * `resolvePkg` deliberately falls back to the framework's own node_modules —
   * right for esbuild, which the framework ships, and wrong for these three: a
   * project that never installed Tailwind would silently get the framework's
   * copy, which is exactly the "the framework chose your CSS system" problem in
   * a different disguise. Resolving from `cwd` alone means "you asked for it and
   * installed it", or nothing.
   */
  const optional = (name) => {
    try {
      return createRequire(path.join(cwd, 'package.json')).resolve(name);
    } catch {
      return null;
    }
  };
  const postcssPath = optional('postcss');
  const twPath = optional('tailwindcss');
  const apPath = optional('autoprefixer');

  const key = [esbuildPath, postcssPath, twPath, apPath].join('\u0000');
  const cached = bundlerDepsCache.get(key);
  if (cached) return cached;

  // Independent dynamic imports, started together. Awaiting them one at a time
  // serialised module resolution and cost ~300 ms it did not have to.
  const load = async (p) => {
    if (!p) return null;
    const m = await import(p);
    return m.default || m;
  };
  const [esbuild, postcss, twMod, apMod] = await Promise.all([
    load(esbuildPath),
    load(postcssPath),
    load(twPath),
    load(apPath),
  ]);

  const deps = {
    esbuild,
    postcss,
    // `tailwindcss` v3 exports the plugin factory directly, with a BOOLEAN
    // `.postcss` marker on it (true = "this is a PostCSS plugin"). v4 moved the
    // factory to `.postcss`, which is a FUNCTION there. Taking `.postcss`
    // blindly hands back `true` on v3 and the build dies with
    // "deps.tailwindcss is not a function". So: prefer a callable `.postcss`,
    // else the module itself if it is callable.
    tailwindcss: twMod
      ? typeof twMod.postcss === 'function'
        ? twMod.postcss
        : typeof twMod === 'function'
          ? twMod
          : null
      : null,
    autoprefixer: apMod,
    paths: { postcss: postcssPath, tailwind: twPath, autoprefixer: apPath },
  };
  bundlerDepsCache.set(key, deps);
  return deps;
}

function findNativeAddon() {
  // No absolute paths: this file ships with the package, so anything anchored
  // to the author's home directory works on exactly one machine and silently
  // picks up a stranger's binary everywhere else.
  // `HYDRA_COMPILER_DIR` is set by `bin/hydra.js` when the binary came from a
  // per-platform package, which keeps its addon next to its own `hydra`.
  const compilerDir = process.env.HYDRA_COMPILER_DIR || path.join(HERE, '../../bin');
  const candidates = [
    process.env.HYDRA_NATIVE,
    path.join(compilerDir, 'hydra.node'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        return selfRequire(c);
      } catch {}
    }
  }
  return null;
}

/**
 * The CLI binary, when it is present beside the package.
 *
 * Mirrors `cliFallbackCompile`'s lookup on purpose: one place decides where the
 * compiler lives, so the build-time semantic check and the compile fallback
 * cannot end up using different binaries.
 */
function findCliBinary() {
  const candidates = [
    process.env.HYDRA_COMPILER,
    path.join(HERE, '../../bin/hydra'),
  ].filter(Boolean);
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/**
 * What the cache key must include to be honest.
 *
 * The disk cache's docstring promises "a compiler change is a miss by
 * construction", but the key carried the package VERSION — which does not move
 * when the Rust source is rebuilt at the same version. Rebuilding the compiler
 * and running `hydra build` then served the previous compiler's output for every
 * cached file, which is the one failure a compile cache must never have.
 *
 * Hashing the two binaries costs one read of ~2 MB once per process and makes
 * the promise true: a different compiler is a different key.
 */
let compilerIdentity = null;
/** Short content hash, for a filename that has to change when the bytes do. */
function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8).toUpperCase();
}
function compilerIdentityKey() {
  if (compilerIdentity !== null) return compilerIdentity;
  try {
    const h = createHash('sha256');
    const dir = process.env.HYDRA_COMPILER_DIR || path.join(HERE, '../../bin');
    for (const f of ['hydra', 'hydra.node']) {
      const p = path.join(dir, f);
      h.update(fs.existsSync(p) ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'missing');
      h.update('\0');
    }
    compilerIdentity = h.digest('hex').slice(0, 16);
  } catch {
    compilerIdentity = 'unknown';
  }
  return compilerIdentity;
}

function cliFallbackCompile(file, source) {
  const candidates = [
    process.env.HYDRA_COMPILER,
    path.join(HERE, '../../bin/hydra'),
  ].filter(Boolean);
  for (const bin of candidates) {
    if (fs.existsSync(bin)) {
      try {
        const out = execFileSync(bin, ['--json', '--stdin', file], {
          input: source,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        return JSON.parse(out);
      } catch (e) {
        const msg = (e.stderr || e.message || '').toString().trim();
        return { error: msg || `hydra: compile failed for ${file}` };
      }
    }
  }
  return { error: 'Hydra compiler (native or CLI) not found' };
}

/**
 * Turn `__import__("./X.hyx")` into a literal `import("./X.hyx")`.
 *
 * The compiler has no `import()` expression — a dynamic import is a syntax
 * error in a `.hyx` source — but `__import__` is an ordinary call it passes
 * through verbatim, and it is Python's own spelling for exactly this operation.
 * Bundlers, however, only split on the *syntax*: a call to a helper that
 * eventually calls `import()` is opaque to esbuild, which is why routing this
 * through the runtime's `require` shim produced a single bundle with the page
 * inlined rather than a chunk. Rewriting the call itself is what makes
 * React.lazy and route-based splitting emit real files.
 *
 * Only string-literal specifiers are rewritten, because those are the only ones
 * a bundler can act on — `__import__(some_variable)` cannot be split by any
 * tool and is left alone. The scan is textual, so a specifier written inside a
 * string literal or a comment would be rewritten too; that is a known limit of
 * doing this before the parser rather than in it.
 */
function rewriteDynamicImports(code) {
  return code.replace(
    /(^|[^\w$.])__import__\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g,
    (m, lead, quote, spec) => `${lead}import(${quote}${spec}${quote})`,
  );
}

/**
 * Resolve the runtime specifiers exactly, before anything else can.
 *
 * A plugin rather than an `alias` entry because esbuild's alias matches a PREFIX
 * per path segment: an alias for `hydra` answers `hydra/server` too, rewriting it
 * to `<hydra.ts>/server`. That produced
 * `Could not resolve "/…/runtime/hydra.ts/server"`, a confusing way to say "you
 * are not allowed to import that from here".
 *
 * `allow` names what THIS pass may resolve. A `hydra/*` that is not listed is
 * left alone on purpose, so the bundler reports it and the caller explains the
 * refusal in the project's own terms.
 */
/**
 * The table used when a project has no pages directory at all.
 *
 * Not a special case at the call sites: `hydra:routes` always resolving means
 * the runtime can import it statically, and a static import is what makes the
 * route table available on the client's FIRST render — the requirement for
 * hydration to agree with pre-rendered HTML.
 */
const EMPTY_ROUTES = {
  root: null,
  routes: [],
  layouts: {},
  notFound: [],
  errors: [],
  errors_diagnostics: [],
  serverFiles: [],
};

function runtimeSpecifierPlugin(allow) {
  return {
    name: 'hydra-runtime-specifiers',
    setup(build) {
      build.onResolve({ filter: /^hydra(\/[a-z]+)?$/ }, (args) => {
        const hit = allow[args.path];
        if (!hit) return null; // deliberately unresolved; the caller explains it
        return { path: hit };
      });
    },
  };
}

function createHydraEsbuildPlugin(options = {}) {
  const native = findNativeAddon();
  // Two layers, on purpose.
  //
  // This `Map` is keyed by path AND source: esbuild re-runs `onLoad` for a file
  // that changed during a rebuild, and a path-only cache would hand back the
  // previous compile for the new text.
  //
  // It only helps WITHIN one build, which is why `options.cache` (the on-disk
  // `CompileCache`) sits behind it: the next `hydra build` of an untouched
  // project reuses every module instead of recompiling all of them. The disk key
  // includes the compiler version, so a compiler change is a miss by
  // construction rather than a stale hit.
  const cache = new Map();
  const disk = options.cache || null;

  function compile(file, source) {
    const hit = cache.get(file);
    if (hit !== undefined && hit.source === source) return hit.res;

    if (disk) {
      const key = disk.keyFor(file, source);
      const found = disk.get(key);
      if (found) {
        cache.set(file, { source, res: found });
        return found;
      }
      const res = native ? native.compile(source, file) : cliFallbackCompile(file, source);
      // Only successes are stored: caching an error would make a build fail
      // forever on a file the developer has since fixed in the same second.
      if (!res.error) disk.set(key, res);
      cache.set(file, { source, res });
      return res;
    }

    const res = native ? native.compile(source, file) : cliFallbackCompile(file, source);
    cache.set(file, { source, res });
    return res;
  }

  const plugin = {
    name: 'hydra-compiler-plugin',
    setup(build) {
      // The COMPILED output is what gets checked, not the source: a comment or
      // a doc string that mentions `process.env.API_KEY` is not a read of one,
      // and failing on it would make the check something authors route around.
      //
      // The hook lives here rather than in a second `onLoad` because esbuild
      // runs only the FIRST plugin's `onLoad` for a path, so a separate guard
      // plugin would either shadow the compiler or have to compile again.
      //
      // `errors` is returned TOGETHER WITH the contents, never instead of them.
      // An `onLoad` that returns only errors leaves the module with no exports,
      // and esbuild then adds a second, misleading warning ("will always be
      // undefined because the file has no exports") on top of the real one.
      const guard = (file, res, source, loader) => {
        if (!options.onCompiled || res.error) return null;
        const problems = options.onCompiled(file, res.code);
        if (!problems || problems.length === 0) return null;
        const at = sourceLocation(source, problems[0].name);
        return {
          contents: rewriteDynamicImports(res.code),
          loader,
          resolveDir: path.dirname(file),
          errors: problems.map((p) => ({
            text: p.text,
            location: at ? { file, line: at.line, column: at.column, lineText: at.lineText } : { file },
          })),
        };
      };

      build.onLoad({ filter: /\.(hyx|hsx)$/ }, async (args) => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        const res = compile(args.path, source);
        if (res.error) {
          return { errors: [{ text: res.error }] };
        }
        const blocked = guard(args.path, res, source, 'tsx');
        if (blocked) return blocked;
        return { contents: rewriteDynamicImports(res.code), loader: 'tsx', resolveDir: path.dirname(args.path) };
      });

      build.onLoad({ filter: /\.(hys|hs)$/ }, async (args) => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        const res = compile(args.path, source);
        if (res.error) {
          return { errors: [{ text: res.error }] };
        }
        const blocked = guard(args.path, res, source, 'js');
        if (blocked) return blocked;
        return { contents: rewriteDynamicImports(res.code), loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
  // A NON-ENUMERABLE extra, so esbuild's plugin validation (which rejects
  // unknown keys) does not see it, while a build-time check can still ask
  // "what does this file emit?" without executing the module.
  Object.defineProperty(plugin, 'compile', { value: compile, enumerable: false });
  return plugin;
}

function copyDirRecursive(src, dest, opts = {}) {
  if (!fs.existsSync(src)) return;
  const skip = opts.skip || new Set();
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    if (skip.has(srcPath)) continue;
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, opts);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * The file that DEFINES the app component, as a project-relative path.
 *
 * Not the entrypoint: `src/main.hyx` mounts a component, it does not export one,
 * and a pre-render that renders the bootstrap renders nothing. `src/App.hyx` is
 * where every scaffold and every example puts the root component, and the entry
 * that found `main.hyx` is the fallback for a project that put it elsewhere.
 */
function appComponentPath(cwd, entryPoint) {
  const candidates = [
    'src/App.hyx',
    'src/App.hsx',
    'src/App.tsx',
    'src/App.jsx',
    'src/App.js',
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(cwd, c))) return c;
  }
  return path.relative(cwd, entryPoint).split(path.sep).join('/');
}

/**
 *
 * Read from the source rather than from the built bundle, because the decision
 * is needed BEFORE the bundle exists and because the answer is about intent, not
 * about what a minifier kept. A project that never mentions `Router` is not
 * using file-based routing, whatever is in its `src/pages`.
 *
 * Deliberately a text scan: a real answer would need the module graph, and the
 * cost of being wrong is asymmetric — a false negative pre-renders a single page
 * (the old, correct-for-that-project behaviour), while a false positive is the
 * hydration bug this prevents.
 */
/**
 * Turn a client-build failure into a sentence about the project.
 *
 * The one case worth rewriting is `hydra/server` reaching the client bundle.
 * esbuild reports it as `Could not resolve "node:fs"` inside a file the author
 * never wrote, which names the symptom and not the cause. The cause is always
 * one of two things, and both have a different fix, so both are named.
 */
/**
 * Put a route's loader result into the HTML as JSON, where the client can read it.
 *
 * `<script type="application/json" id="__hydra_data__">`. A script tag rather
 * than a data attribute because the payload can be any JSON the loader returned,
 * and an attribute would mean escaping it into a string that then has to be
 * parsed anyway. `</script>` inside the JSON is escaped so a loader returning
 * HTML cannot close the tag early.
 */
function injectLoaderData(html, pattern, data, url = pattern) {
  // `url`, not only `pattern`, and it is load-bearing.
  //
  // Two URLs can match the same pattern (`/blog/a` and `/blog/b` both hit
  // `/blog/[slug]`), so a payload keyed only by pattern cannot tell the client
  // whether the data it holds belongs to the URL it is looking at. During SSG
  // there is one URL per pattern and it never showed; the moment a server
  // renders per REQUEST it does, and the page would hydrate with another URL's
  // data.
  const payload = JSON.stringify({ pattern, url, data: data === undefined ? null : data })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const tag = `<script type="application/json" id="__hydra_data__">${payload}</script>`;
  if (html.includes('id="__hydra_data__"')) {
    return html.replace(/<script type="application\/json" id="__hydra_data__">[\s\S]*?<\/script>/, tag);
  }
  return html.includes('</body>') ? html.replace('</body>', `  ${tag}\n  </body>`) : html + `\n${tag}\n`;
}

/**
 * Drop `process` "never bound" warnings that are only environment reads.
 *
 * `process.env.NAME` is now the documented way for a client to read a
 * `PUBLIC_` variable and for a server file to read any variable, but the
 * semantic checker has no concept of environment access — it sees a bare name
 * and reports it as unbound, which is fatal under `--strict`. Left alone, that
 * makes `.env` unusable and teaches authors to set `HYDRA_NO_CHECK=1`, which
 * turns off every OTHER check as well.
 *
 * The filter is per-WARNING and reads the source at the reported position, so a
 * genuine `process.exit()` in a component keeps its warning: there is no
 * `process` object in a browser, and that line is a real crash waiting.
 */
function withoutEnvOnlyProcessWarnings(text, cwd = process.cwd()) {
  if (!text) return '';
  const kept = [];
  for (const line of text.split('\n')) {
    const m = /^(.+?):(\d+):(\d+): warning: `process` is used but never bound/.exec(line);
    if (m) {
      const file = path.isAbsolute(m[1]) ? m[1] : path.resolve(cwd, m[1]);
      let src = null;
      try {
        src = fs.readFileSync(file, 'utf8');
      } catch {
        src = null;
      }
      // Per FILE, not per reported line: the checker anchors a `.hyx` warning
      // at the enclosing `component`, so the reported position is often not
      // where `process` appears. What matters is whether EVERY use in this file
      // is an environment read — one bare `process.exit()` and the warning is
      // real, because there is no `process` object in a browser.
      if (src !== null) {
        const uses = [...src.matchAll(/\bprocess\b/g)];
        const allEnv = uses.length > 0 && uses.every((u) =>
          /^\s*(\.\s*env\b|\[\s*["']env["']\s*\])/.test(src.slice(u.index + 7)),
        );
        if (allEnv) continue;
      }
    }
    kept.push(line);
  }
  const out = kept.join('\n').trim();
  // A summary line that now describes zero findings is not a failure. The
  // first line of the block IS a summary ("2 warning(s), and --strict is on"),
  // so it has to go when the per-file lines above it were all filtered out.
  if (/^\d+ warning\(s\)/.test(out) || /^0 warning/.test(out)) {
    return out.split('\n').slice(1).join('\n').trim();
  }
  return out;
}

/**
 * The line a violation's variable is read on, in the SOURCE file.
 *
 * esbuild reports an error location against what `onLoad` returned, which is
 * compiled output — a `.hyx` that runs through the emitter is not the file the
 * author opens, so "line 12" would point at the wrong line. The source is
 * searched for the name instead. Not found (a computed access, or a name that
 * only exists after rewriting) means no location is reported at all, which is
 * still a build failure and still names the file and the variable.
 */
function sourceLocation(source, name) {
  if (!name) return null;
  const lines = String(source || '').split('\n');
  const hit = (text) =>
    text.includes(`process.env.${name}`) ||
    text.includes(`process.env["${name}"]`) ||
    text.includes(`import.meta.env.${name}`);
  // A line that mentions the name AND an env access first: the comment above a
  // read is not the read, and pointing at it makes the author look one line off.
  for (let i = 0; i < lines.length; i++) {
    if (hit(lines[i])) {
      return { line: i + 1, column: lines[i].indexOf(name), lineText: lines[i] };
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf(name);
    if (at !== -1) return { line: i + 1, column: at, lineText: lines[i] };
  }
  return null;
}

function explainClientBuildError(err, cwd) {
  const errors = err && Array.isArray(err.errors) ? err.errors : [];
  const text = errors
    .map((e) => `${e.text || ''} ${(e.location && e.location.file) || ''}`)
    .join('\n');

  if (/hydra\/server|node:fs|node:path|node:child_process/.test(text)) {
    const where = errors
      .map((e) => e.location && e.location.file)
      .filter(Boolean)
      .map((f) => path.relative(cwd, f))
      .filter((f) => !f.includes('node_modules'));
    const who = where.length > 0 ? `\n  imported from: ${[...new Set(where)].join(', ')}` : '';
    return (
      `[hydra] server-only code reached the client bundle.${who}\n` +
      `= \`hydra/server\` (and \`node:*\`) cannot run in a browser. Two fixes, depending on intent:\n` +
      `  1. the code IS build-time only — move it into a \`loader\`, which runs during pre-rendering\n` +
      `  2. the code IS browser code — import from \`hydra/client\` instead, and run it inside an effect`
    );
  }
  return err && err.message ? err.message : String(err);
}

function renderUsesRouter(cwd) {
  const srcDir = path.join(cwd, 'src');
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.hydra') continue;
        walk(path.join(dir, e.name));
      } else if (/\.(hyx|hsx|hys|hs|tsx|ts|jsx|js|mjs)$/.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  walk(srcDir);
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    // HydraScript writes `from hydra import Router`, and a hand-written TSX
    // file writes the JS form. Both are checked because `src/` can hold either,
    // and the FIRST version of this only knew the JS spelling — so it answered
    // "no router" for every HydraScript project, which is the one case that
    // matters.
    // HydraScript writes the specifier bare (`from hydra import ...`); the
    // quotes are optional so both spellings are accepted. Requiring the quotes
    // was the bug: it made this answer "no router" for every HydraScript
    // project, which is the only case that matters.
    const pyImportsRouter = /^[ \t]*from[ \t]+["']?hydra["']?[ \t]+import[ \t]+[^\n]*\bRouter\b/m.test(
      text,
    );
    const jsImportsRouter =
      /import\s*(?:\{[^}]*\bRouter\b[^}]*\}|[A-Za-z_$][\w$]*\s*,\s*\{[^}]*\bRouter\b[^}]*\})\s*from\s*["']hydra["']/.test(
        text,
      );
    const bareImportsRouter = /^\s*import\s+.*\bRouter\b.*from\s+["']hydra["']/m.test(text);
    if ((pyImportsRouter || jsImportsRouter || bareImportsRouter) && /\bRouter\s*\(/.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Where the page files live.
 *
 * `routes` in hydraconfig may be a directory, or `false` to turn file-based
 * routing off entirely for a project that wires its own. The default is
 * `src/pages`, which is where `hydra init` has always put pages.
 */
/**
 * The pages directory, or null when the project does not route by file.
 *
 * `null` also means "the directory is not there": the default path was returned
 * unconditionally, so every project without a `src/pages` was treated as one
 * that has it, and the build printed "src/pages exists but the app does not
 * render Router()" about a directory that did not exist. A message that is
 * confidently wrong about the project is worse than no message.
 */
function pagesDirectory(cwd, config) {
  const raw = config.routes;
  if (raw === false) return null;
  let dir;
  if (typeof raw === 'string' && raw.trim() !== '') dir = path.resolve(cwd, raw.trim());
  else if (raw && typeof raw === 'object' && typeof raw.dir === 'string') {
    dir = path.resolve(cwd, raw.dir);
  } else {
    dir = path.join(cwd, 'src', 'pages');
  }
  return fs.existsSync(dir) ? dir : null;
}

export function readConfig(cwd) {
  const configPath = path.join(cwd, 'hydraconfig.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error('[hydra] Error parsing hydraconfig.json:', e.message);
    }
  }
  return config;
}

/**
 * Best-effort local IPv4, only ever used to PRINT where a server is reachable.
 * When the bind is 0.0.0.0 the honest answer is "the machine's address", and
 * `localhost` is a lie the developer cannot act on.
 */
function localIPv4() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    }
  } catch {
    /* printing must never be the thing that breaks the server */
  }
  return null;
}

/**
 * Normalise `base` from hydraconfig into a prefix that can be concatenated.
 *
 * `"sub"`, `"/sub"` and `"/sub/"` all mean the same thing to a user, and all
 * three are wrong at the point of use here: every consumer below builds a URL
 * by concatenation, so the leading and trailing slashes have to be there. A
 * CDN base (`https://cdn.example.com/app/`) is legal and is kept verbatim —
 * it is a fine asset prefix but not a path a local server can strip.
 */
function normalizeBase(base) {
  if (typeof base !== 'string' || base.trim() === '') return '/';
  let b = base.trim();
  if (!b.endsWith('/')) b += '/';
  if (!b.startsWith('/') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(b) && !b.startsWith('//')) b = '/' + b;
  return b;
}

function isRemoteBase(base) {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(base);
}

// esbuild has no default loader, so `import logo from './logo.svg'` is a hard
// build error until one is named. `file` is what the import needs to be: a URL
// string, rewritten onto the base path by `publicPath` below.
const ASSET_LOADERS = {
  '.png': 'file',
  '.jpg': 'file',
  '.jpeg': 'file',
  '.gif': 'file',
  '.webp': 'file',
  '.avif': 'file',
  '.ico': 'file',
  '.svg': 'file',
  '.woff': 'file',
  '.woff2': 'file',
  '.ttf': 'file',
  '.otf': 'file',
  '.eot': 'file',
  '.mp3': 'file',
  '.mp4': 'file',
  '.webm': 'file',
  '.ogg': 'file',
  '.wav': 'file',
  '.pdf': 'file',
};

/**
 * `tsconfig.json` → esbuild `alias`, best effort.
 *
 * esbuild's alias map cannot express a wildcard: `"@/*": "./src/*"` matches
 * nothing, and a trailing `*` in the value is rejected outright. What it does
 * implement is prefix matching on path segments — key `"@app"` answers
 * `@app/util` with `<target>/util` — which is exactly what a trailing `/*`
 * pattern means, so the two are converted into each other here. Exact-name
 * patterns map straight across.
 */
function tsconfigAliases(cwd) {
  const tsconfigPath = path.join(cwd, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return {};

  let raw;
  try {
    raw = fs.readFileSync(tsconfigPath, 'utf8');
  } catch {
    return {};
  }
  // tsconfig is JSONC: block comments, whole-line `//` comments and trailing
  // commas are all legal, and JSON.parse rejects every one of them. Only
  // line-leading `//` is stripped so that a `https://` inside a value survives.
  raw = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return {};
  }

  const compilerOptions = cfg.compilerOptions || {};
  const paths = compilerOptions.paths;
  if (!paths || typeof paths !== 'object') return {};

  // Without a baseUrl, TS (4.x on) resolves targets relative to the tsconfig.
  const baseUrl = compilerOptions.baseUrl
    ? path.resolve(cwd, compilerOptions.baseUrl)
    : cwd;

  const alias = {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0 || typeof targets[0] !== 'string') continue;
    // A bare `*` claims every specifier there is, npm packages included.
    // esbuild's alias has no fall-through, so honouring it would make `react`
    // unresolvable — a worse outcome than ignoring the rule.
    if (pattern === '*') continue;

    let key = pattern;
    let target = path.resolve(baseUrl, targets[0]);
    if (key.endsWith('/*')) {
      key = key.slice(0, -2);
      target = target.replace(/[\\/]\*$/, '');
    }
    // A wildcard anywhere but the end has no esbuild equivalent.
    if (!key || key.includes('*')) continue;
    alias[key] = target;
  }
  return alias;
}

/**
 * The environment contract published packages read.
 *
 * These are member defines, not an object: esbuild rejects an object literal
 * as a define value, and `import.meta.env.VITE_*` is not expressible either.
 * The six names below are the documented ones, so a library branching on
 * `import.meta.env.DEV` or `process.env.NODE_ENV` gets a real value instead of
 * a ReferenceError or a silent `undefined`.
 */
function envDefines(mode, base, ssr = false) {
  const isProd = mode === 'production';
  const defines = {
    'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env.DEV': String(!isProd),
    'import.meta.env.PROD': String(isProd),
    'import.meta.env.SSR': String(ssr),
    'import.meta.env.BASE_URL': JSON.stringify(base),
  };
  // `PUBLIC_*` is the ONLY part of `.env` that becomes a value here.
  //
  // Inlined as literal member defines rather than as one `import.meta.env`
  // object, because esbuild refuses an object literal as a define value — and
  // because a literal is what makes an inlined secret visible in a diff of the
  // output. Everything else stays in `process.env` on the server, and a client
  // file that reads one fails the build (see `clientEnvViolations`).
  for (const [k, v] of Object.entries(publicEnvValues())) {
    defines[`process.env.${k}`] = JSON.stringify(v);
    defines[`import.meta.env.${k}`] = JSON.stringify(v);
  }
  return defines;
}

/** Escape text for interpolation into HTML. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which CSS pipeline this project asked for.
 *
 * The order is deliberate: an explicit PostCSS config is the project speaking,
 * and nothing should override it. The `tailwind` key is the next most explicit.
 * The fallback is plain PostCSS — a stylesheet still gets processed, but no
 * framework is assumed.
 *
 * Returning a name rather than a plugin list keeps the decision observable in
 * the build log, which is how a person finds out why their CSS came out wrong.
 */
function cssPipelineFor(cwd, config) {
  const postcssConfig = [
    'postcss.config.js',
    'postcss.config.mjs',
    'postcss.config.cjs',
    'postcss.config.ts',
    '.postcssrc',
    '.postcssrc.json',
    '.postcssrc.js',
    '.postcssrc.yml',
  ].find((f) => fs.existsSync(path.join(cwd, f)));
  if (postcssConfig) return { kind: 'postcss-config', source: postcssConfig };

  const styling = config.styling;
  if (styling && Array.isArray(styling) && styling.length > 0) {
    return { kind: 'styling-list', plugins: styling };
  }
  if (styling && typeof styling === 'object' && Array.isArray(styling.plugins) && styling.plugins.length > 0) {
    return { kind: 'styling-list', plugins: styling.plugins };
  }

  const tailwindConfig = ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'].find(
    (f) => fs.existsSync(path.join(cwd, f)),
  );
  if (config.tailwind || tailwindConfig) {
    return { kind: 'tailwind', source: tailwindConfig || 'hydraconfig.tailwind' };
  }
  return { kind: 'plain' };
}

/** Load a plugin named in `styling`, by package name or relative path. */
async function loadCssPlugin(cwd, name) {
  const spec = name.startsWith('.') || name.startsWith('/') ? path.resolve(cwd, name) : name;
  const resolved = spec.startsWith('/') ? spec : resolvePkg(spec, cwd);
  const m = await import(pathToFileURL(resolved).href);
  return m.default || m;
}

/**
 * `src/index.css` through the project's own CSS pipeline, returned as text.
 *
 * The result is merged with the CSS esbuild extracted from the module graph
 * rather than written straight out, so the page still loads one stylesheet.
 *
 * Why this is not "the Tailwind step" any more: Tailwind used to be applied
 * unconditionally, which meant every project was forced onto it and paid for
 * `tailwindcss`, `postcss` and `autoprefixer` whether they wanted them or not.
 * A framework choosing a project's CSS system is the kind of decision that looks
 * helpful and is really a tax. Now the project chooses:
 *
 *   postcss.config.*   -> the project's own config runs, plugins and all
 *   styling: [...]     -> exactly the plugins listed
 *   tailwind key       -> Tailwind + autoprefixer
 *   nothing            -> plain PostCSS (autoprefixer only if installed)
 */
async function compileCss(cwd, config, deps) {
  const cssInPath = path.join(cwd, 'src/index.css');
  if (!fs.existsSync(cssInPath)) return null;
  const rawCss = fs.readFileSync(cssInPath, 'utf8');
  const pipeline = cssPipelineFor(cwd, config);

  // No PostCSS installed: the stylesheet still has to ship. Hand it back as-is
  // and say so, because a silently unprocessed file looks identical to one whose
  // plugin did nothing.
  if (!deps.postcss) {
    if (pipeline.kind !== 'plain') {
      console.warn(
        `[hydra] styling: ${pipeline.kind} was requested but postcss is not installed in this project; ` +
          'src/index.css is copied unprocessed. Run: npm i -D postcss',
      );
    }
    return { css: rawCss, pipeline: { kind: 'none' } };
  }

  let plugins = [];
  if (pipeline.kind === 'postcss-config') {
    // `postcss-load-config` is not a dependency of this framework, so the file is
    // imported directly. PostCSS configs export either an object with `plugins`
    // or a function returning one; both are handled.
    const file = path.join(cwd, pipeline.source);
    let loaded;
    try {
      const m = await import(pathToFileURL(file).href);
      loaded = m.default || m;
      if (typeof loaded === 'function') loaded = await loaded({ cwd, env: process.env.NODE_ENV || 'production' });
    } catch (err) {
      throw new Error(
        `styling: could not read ${pipeline.source}: ${err.message}. ` +
          'PostCSS configs written for CommonJS need a .cjs extension when the project is type: module.',
      );
    }
    const named = (loaded && loaded.plugins) || [];
    if (Array.isArray(named)) {
      // An array is either plugin instances already, or names to load.
      for (const p of named) {
        plugins.push(typeof p === 'string' ? await loadCssPlugin(cwd, p) : p);
      }
    } else if (named && typeof named === 'object') {
      for (const [name, opts] of Object.entries(named)) {
        if (opts === false) continue;
        const fn = await loadCssPlugin(cwd, name);
        plugins.push(fn(opts === true ? undefined : opts));
      }
    }
  } else if (pipeline.kind === 'styling-list') {
    for (const name of pipeline.plugins) {
      const fn = await loadCssPlugin(cwd, name);
      plugins.push(fn());
    }
  } else if (pipeline.kind === 'tailwind') {
    if (!deps.tailwindcss) {
      throw new Error(
        'styling: the `tailwind` key or a tailwind.config was found but tailwindcss is not installed. ' +
          'Run: npm i -D tailwindcss, or remove the key to use plain CSS.',
      );
    }
    const userTailwind = config.tailwind || {};
    const twConfig = {
      ...userTailwind,
      content: Array.from(
        new Set([
          path.join(cwd, 'index.html'),
          path.join(cwd, 'src/**/*.{hyx,hys,hsx,hs,tsx,ts,jsx,js,mjs,html,css}'),
          ...(userTailwind.content || []),
        ]),
      ),
      theme: userTailwind.theme || { extend: {} },
      plugins: userTailwind.plugins || [],
    };
    plugins.push(deps.tailwindcss(twConfig));
    if (deps.autoprefixer) plugins.push(deps.autoprefixer());
  } else {
    // Plain: no framework. Autoprefixer only if the project installed it.
    if (deps.autoprefixer) plugins.push(deps.autoprefixer());
  }

  if (plugins.length === 0) return { css: rawCss, pipeline };

  const cssResult = await deps.postcss(plugins).process(rawCss, { from: cssInPath });
  return { css: cssResult.css, pipeline };
}

function setupSSRGlobals() {
  if (typeof global.window === 'undefined') {
    global.window = {
      innerWidth: 1200,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: (cb) => setTimeout(cb, 0),
      cancelAnimationFrame: (id) => clearTimeout(id),
      getComputedStyle: () => ({}),
      location: { href: 'http://localhost/', pathname: '/', search: '', hash: '' },
      history: { pushState() {}, replaceState() {} },
    };
  }
  if (typeof global.document === 'undefined') {
    global.document = {
      documentElement: { scrollHeight: 2000, scrollWidth: 1200, clientHeight: 800, clientWidth: 1200 },
      body: { scrollHeight: 2000, scrollWidth: 1200 },
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() {
        return {
          getContext() { return null; },
          setAttribute() {},
          getAttribute() { return null; },
          appendChild() {},
          removeChild() {},
          addEventListener() {},
          removeEventListener() {},
          style: {},
          children: [],
        };
      },
      addEventListener() {},
      removeEventListener() {},
    };
  }
  if (typeof global.navigator === 'undefined') {
    global.navigator = {
      userAgent: 'Mozilla/5.0 (Node.js SSG)',
      clipboard: {
        writeText: async () => {},
        readText: async () => '',
      },
    };
  }
  if (typeof global.ResizeObserver === 'undefined') {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof global.IntersectionObserver === 'undefined') {
    global.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

/**
 * Absolute path of an esbuild metafile output key.
 *
 * Keys come back relative to `absWorkingDir`, except when the output directory
 * sits outside it, in which case esbuild hands back a path with `..` in it.
 * `path.resolve` is correct for both.
 */
function outputPath(cwd, key) {
  return path.resolve(cwd, key);
}

/** Public URL for an emitted file, given the deployment base. */
function outputUrl(cwd, outDir, base, key) {
  const rel = path.relative(outDir, outputPath(cwd, key)).split(path.sep).join('/');
  return base + rel;
}

// Phase timing, opt-in: `HYDRA_PROFILE=1 hydra build`. Printed to stderr so it
// never mixes into build output that tools parse. Kept in the shipped runner
// because "where did the build time go" is the first question after any change
// to this file, and a profiler that only exists in a scratch script gets
// rewritten every time.
const PROFILING = process.env.HYDRA_PROFILE === '1';
const phaseTimes = [];
function phase(name, t0) {
  if (!PROFILING) return;
  phaseTimes.push([name, Number(process.hrtime.bigint() - t0) / 1e6]);
}
function phaseStart() {
  return PROFILING ? process.hrtime.bigint() : 0n;
}
function phaseReport(totalMs) {
  if (!PROFILING || phaseTimes.length === 0) return;
  const accounted = phaseTimes.reduce((a, [, ms]) => a + ms, 0);
  console.error('\n[hydra:profile] phase breakdown');
  for (const [name, ms] of phaseTimes) {
    const pct = ((ms / totalMs) * 100).toFixed(1);
    console.error(`  ${name.padEnd(26)} ${ms.toFixed(1).padStart(8)} ms  ${pct.padStart(5)}%`);
  }
  // The remainder is process start, config reading and module loading — real
  // time the user waits for, so it is reported rather than hidden.
  const rest = totalMs - accounted;
  console.error(`  ${'(other)'.padEnd(26)} ${rest.toFixed(1).padStart(8)} ms  ${((rest / totalMs) * 100).toFixed(1).padStart(5)}%`);
  console.error(`  ${'TOTAL'.padEnd(26)} ${totalMs.toFixed(1).padStart(8)} ms\n`);
}

/**
 * Build the SSR bundle for pre-rendering. Returns `{ code }`.
 *
 * Split out of `runBuild` so it can be started before the client bundle and
 * awaited at the pre-render step — the two builds read the same sources and
 * share nothing else, so running them in sequence was leaving ~340 ms of a
 * two-core machine idle.
 *
 * React stays external as bare specifiers. A second copy would mean a second
 * hook dispatcher and an "invalid hook call" at render time.
 */
async function buildSsgBundle(esbuild, cwd, pkgRoot, ssgEntry, runtimeAliases, config, mode, base, routesTable = null) {
  const jsxRuntimePath = resolvePkg('react/jsx-runtime', cwd);
  let jsxDevRuntimePath;
  try {
    jsxDevRuntimePath = resolvePkg('react/jsx-dev-runtime', cwd);
  } catch {}

  const ssgResult = await esbuild.build({
    entryPoints: [ssgEntry],
    bundle: true,
    write: false,
    // CommonJS, not ESM. React itself is CommonJS, and an ESM bundle
    // that keeps it external turns into `require("react")` inside a
    // module Node loaded as ESM — which throws "Dynamic require of
    // react is not supported". As CJS the require is native, and the
    // react instance is shared with the renderer through the same
    // require cache, so hooks see one dispatcher.
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: 'node18',
    plugins: [
      runtimeSpecifierPlugin({ hydra: runtimeAliases.hydra, 'hydra/server': runtimeAliases.server }),
      createHydraEsbuildPlugin(),
      routesEsbuildPlugin(routesTable || EMPTY_ROUTES, { base, cwd }),
      {
        name: 'hydra-ssg-external-react',
        setup(build) {
          build.onResolve({ filter: /^react(\/.*)?$/ }, (args) => {
            if (args.path === 'react' || args.path === 'react/jsx-runtime') {
              return { path: args.path, external: true };
            }
            if (args.path === 'react/jsx-dev-runtime' && jsxDevRuntimePath) {
              return { path: args.path, external: true };
            }
            try {
              resolvePkg(args.path, cwd);
              return { path: args.path, external: true };
            } catch {}
          });
        },
      },
    ],
    resolveExtensions: ['.hyx', '.hys', '.hsx', '.hs', '.mjs', '.js', '.jsx', '.ts', '.tsx', '.json'],
    nodePaths: [path.join(cwd, 'node_modules'), path.join(pkgRoot, 'node_modules')],
    alias: {
      // Same runtime specifiers as the browser build: missing them here made the
      // SSG pass fail after a successful client build.
      ...tsconfigAliases(cwd),
      // Same reasoning as the client build: `hydra`, `hydra/server` and
      // `hydra/client` are decided by `runtimeSpecifierPlugin`, because an alias
      // for `hydra` would swallow the other two before the plugin ran.
      // `hydra/client` is deliberately NOT in this pass's allow-list: a loader
      // that touches `window` must fail the build, not produce HTML that differs
      // from what the client renders.
      '@': path.resolve(cwd, 'src'),
    },
    loader: {
      // `write: false` with no output path can never run a `file` loader
      // ("Cannot use the file loader without an output path"), so assets
      // stay inline here. Only the HTML string matters in this pass.
      '.css': 'empty',
      '.png': 'text',
      '.jpg': 'text',
      '.jpeg': 'text',
      '.gif': 'text',
      '.svg': 'text',
      ...(config.compiler?.jsxInJs === false ? {} : { '.js': 'jsx' }),
    },
    // SSR is what this pass *is*, so a library that branches on
    // `import.meta.env.SSR` takes its server path instead of touching
    // `window`.
    define: envDefines(mode, base, true),
  });

  return { code: ssgResult.outputFiles[0].text };
}

export async function runBuild(cwd = process.cwd(), opts = {}) {
  const t0 = Date.now();
  // Dev rebuilds call this repeatedly, and module-level counters would carry
  // the previous build's phases into the next report — percentages over 100%
  // and a breakdown that describes no single build.
  if (PROFILING) phaseTimes.length = 0;

  const config = readConfig(cwd);
  // `mode` drives the environment shims, and nothing else. Explicit caller >
  // hydraconfig > the default for the command (dev / production).
  const mode = opts.mode || config.mode || (opts.dev ? 'development' : 'production');
  if (mode === 'development') process.env.NODE_ENV = 'development';
  // The compiler reads this to decide whether to emit the dev-time refresh
  // boundary. It is a separate switch from NODE_ENV on purpose: a `preview` of a
  // production build must NOT carry the boundary, and a dev server must.
  if (opts.dev) process.env.HYDRA_DEV = '1';
  else delete process.env.HYDRA_DEV;

  // 0a. `.env`, loaded BEFORE anything is compiled.
  //
  // Before, specifically, because the client bundle inlines `PUBLIC_*` at
  // define time: loading the file after the bundle is built would leave the
  // first build of a fresh checkout with empty values, and the second one
  // correct. `dev` reloads it on every rebuild too, so editing `.env` behaves
  // like editing a source file — the server reads a fresh process.env because
  // `hydra/server`'s `env()` reads it at call time, not at import time.
  const envLoad = loadProjectEnv(cwd);
  if (envLoad.applied.length > 0) {
    console.log(`[hydra] .env: ${envLoad.applied.length} variable(s) loaded`);
  }

  // 0b. The build target. Two, and the list is closed.
  //
  //   node   — the client bundle plus a runnable server (`hydra serve`): SSR,
  //            loaders, actions and every `src/api` route answer.
  //   static — HTML, JS and CSS only. The server half is NOT in the artifact,
  //            and the routes it would have served are printed as dropped.
  //
  // `static` is the default because that is what every previous release
  // produced; changing the default would silently turn a deployed API into a
  // 404 for everyone who upgrades without reading the changelog.
  const target = opts.target || (opts.dev ? 'node' : config.build?.target) || 'static';
  if (target !== 'node' && target !== 'static') {
    throw new Error(
      `[hydra] --target must be "node" or "static", got "${target}". ` +
        `There are deliberately only two: an adapter per host is a maintenance cost with no reader.`,
    );
  }

  console.log(`[hydra] Building for ${mode} (Hydra native bundler)...`);
  if (target === 'node') console.log('[hydra] target: node — server routes are included');

  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const assetsDir = path.join(outDir, 'assets');

  // Compilation cache. On by default; `HYDRA_NO_CACHE=1` (or
  // `"build": {"cache": false}`) turns it off, and `dev` never writes one —
  // a dev loop recompiles so few files that the write costs more than the hit.
  const cacheWanted =
    opts.dev !== true && process.env.HYDRA_NO_CACHE !== '1' && config.build?.cache !== false;
  // The cache key must carry EVERYTHING that changes the output. The dev-only
  // refresh boundary is one of those, and it is not part of the compiler binary:
  // the same binary emits both shapes. Without this, a production build's cached
  // `export function Card` was served to `hydra dev`, so Fast Refresh silently did
  // nothing while every test still passed.
  const compileIdentity = compilerIdentityKey();
  const compileCache = cacheWanted
    ? new CompileCache(cacheDirFor(cwd), { version: VERSION }).withExtra(
        compileIdentity + (opts.dev ? ':dev' : ':build'),
      )
    : null;
  if (compileCache) {
    // A new compiler makes every entry unusable, and a long-lived project adds
    // one forever otherwise. Reported only when it actually removed something,
    // so a normal build stays quiet.
    const pruned = compileCache.prune({ identity: compileIdentity });
    if (pruned.removed > 0 && process.env.HYDRA_PROFILE === '1') {
      console.log(`[hydra] compile cache: removed ${pruned.removed} entry(ies) — ${pruned.reason}`);
    }
  }

  const base = normalizeBase(config.base);
  // URL prefix that corresponds to `assetsDir`. `publicPath` needs this rather
  // than `base`; see the esbuild options below.
  const assetsPublicPath = base + 'assets/';

  // Wipe the OUTPUT directory before writing into it.
  //
  // esbuild's `outdir` ACCUMULATES: it never removes output it did not write
  // this run. Content-hashed names make that look harmless, and for the entry
  // it is, because `index.html` is rewritten with the new hash every time. What
  // it broke is everything else that is no longer produced: a page whose route
  // was deleted stayed on disk and kept being served, with whatever data was in
  // it, for the rest of the deployment's life. That is the failure mode that
  // leaks something after somebody thought they had removed it.
  //
  // `--no-clean` (or `build.clean: false`) exists for the one case where the
  // directory is shared with files this build does not own, and it is opt-in
  // because the safe default is that `dist/` is DERIVED, not a workspace.
  fs.mkdirSync(outDir, { recursive: true });
  if (opts.clean !== false && config.build?.clean !== false) {
    for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
      fs.rmSync(path.join(outDir, entry.name), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(assetsDir, { recursive: true });

  // 0. File-based routes.
  //
  // Scanned before anything is bundled, and written into `.hydra/` so the table
  // exists on disk where a person can read it. A mistake in the pages directory
  // is fatal here rather than a silently missing route later: two files that
  // disagree about a parameter name describe the same URL, and either one being
  // picked is wrong.
  /** Path to the generated action bundle ENTRY, before bundling. */
  let actionBundleEntry = null;
  const pagesDir = pagesDirectory(cwd, config);
  let routesTable = null;
  // A `src/pages` directory does not by itself mean the app ROUTES by file. A
  // project can keep page components there and pick between them by hand —
  // `hydra init` did exactly that — and pre-rendering such a project per route
  // produces HTML that disagrees with what the client renders at that URL. React
  // says so as a hydration mismatch (#418), which is why the runtime gate
  // catches it and why this check exists: the gate is the safety net, not the
  // plan.
  //
  // The signal is the only honest one available without running the app: does
  // the source render the runtime's `Router`? If it does not, file-based routing
  // is not in use, and the previous single-page behaviour is what is correct.
  if (pagesDir && !renderUsesRouter(cwd)) {
    console.log(
      '[hydra] src/pages exists but the app does not render `Router()`, so routes are not ' +
        'pre-rendered per page (render `Router()` from hydra to turn that on)',
    );
    routesTable = null;
  } else if (pagesDir) {
    routesTable = scanRoutes(pagesDir);
    if (routesTable.errors_diagnostics.length > 0) {
      throw new Error(
        `[hydra] route discovery failed:\n  ` +
          routesTable.errors_diagnostics.join('\n  ') +
          `\n= fix the files above, or set "routes": false in hydraconfig.json`,
      );
    }
    writeRoutesModule(cwd, routesTable, { base });
    // The action table, for the servers that may call it. Written only when a
    // route has a server half, so a project without mutations never pays for it.
    //
    // The entry is bundled here, at build time, because node cannot load a `.hys`
    // and the dev server must not carry a second compiler just to answer a POST.
    actionBundleEntry = writeActionBundle(cwd, routesTable);
    if (routesTable.routes.length > 0) {
      const dynamic = routesTable.routes.filter((r) => r.hasParams);
      console.log(
        `[hydra] ${routesTable.routes.length} route(s) from ${path.relative(cwd, pagesDir) || '.'}` +
          (dynamic.length > 0
            ? `, ${dynamic.length} dynamic (${dynamic.map((r) => r.pattern).join(', ')})`
            : ''),
      );
    }
  }

  let _p = phaseStart();
  const { esbuild, postcss, tailwindcss, autoprefixer } = await loadBundlerDeps(cwd);
  phase('1. load bundler deps', _p);

  // 0c. `src/api` and `src/middleware.hys`, bundled into `.hydra/api.cjs`.
  //
  // Scanned before the client bundle for the same reason the action table is:
  // node cannot load a `.hys`, and the dev server must not carry a second
  // compiler just to answer a POST. Written for BOTH targets even though a
  // static build will not serve them, because `hydra preview` after a static
  // build should still behave like the project, and because a scan that only
  // runs sometimes is a scan that drifts.
  //
  // A subdirectory or a private file in `src/api` is REPORTED, never silently
  // skipped: "my route 404s" with no message is the failure this repository
  // keeps paying for.
  const apiTable = scanApiRoutes(cwd);
  for (const ig of apiTable.ignored) {
    console.log(`[hydra] src/api: ignoring ${ig.file} — ${ig.reason}`);
  }
  if (apiTable.routes.length > 0 || fs.existsSync(path.join(cwd, MIDDLEWARE_FILE))) {
    console.log(
      `[hydra] api: ${apiTable.routes.length} route(s)` +
        (apiTable.routes.length > 0 ? ` (${apiTable.routes.map((r) => r.pattern).join(', ')})` : '') +
        (fs.existsSync(path.join(cwd, MIDDLEWARE_FILE)) ? ', middleware: src/middleware.hys' : ''),
    );
  }
  const apiEntry = writeApiBundle(cwd, apiTable);

  const pkgRoot = path.resolve(HERE, '../..');
  // The three runtime specifiers, resolved from one place so the client and the
  // SSG pass cannot disagree about which file each means.
  //
  //   hydra         — universal, safe anywhere
  //   hydra/server  — refused in the client bundle
  //   hydra/client  — refused in the pre-render pass
  //
  // `hydra/shared` is gone on purpose: it existed in the docs as "safe
  // everywhere, but distinctly not the runtime", and it was the same as `hydra`
  // with a second name to keep in sync.
  const runtimeDir = path.join(pkgRoot, 'runtime');
  const pick = (env, ...candidates) => {
    const hit = [process.env[env], ...candidates].find((f) => f && fs.existsSync(f));
    return hit || candidates[candidates.length - 1];
  };
  const hydraAlias = pick(
    'HYDRA_RUNTIME_PATH',
    path.join(runtimeDir, 'hydra.ts'),
    path.join(pkgRoot, 'runtime-js', 'hydra-js.js'),
  );
  // The SERVER half of the same specifier. A `.hys` that imports `len` or
  // `format` from `hydra` is a server module, and resolving it to `hydra.ts`
  // dragged React, ReactDOM and the scheduler into the API bundle: 2 KB became
  // 1.25 MB and answered 13x slower, for a helper with no UI in it.
  // `hydra/core` is React-free by construction, so this is the honest target.
  const coreAlias = pick(
    'HYDRA_CORE_PATH',
    path.join(runtimeDir, 'core.ts'),
    path.join(pkgRoot, 'runtime-js', 'core.js'),
  );
  const serverAlias = pick('HYDRA_SERVER_PATH', path.join(runtimeDir, 'server.ts'));
  const clientAlias = pick('HYDRA_CLIENT_PATH', path.join(runtimeDir, 'client.ts'));

  // Now that esbuild is loaded, the action entry can become a runnable module.
  if (actionBundleEntry) {
    try {
      await bundleActions(esbuild, actionBundleEntry, {
        outfile: path.join(cwd, '.hydra', 'actions.cjs'),
        cwd,
        pkgRoot,
        hydraAlias: coreAlias,
        serverAlias,
        compilerPlugin: createHydraEsbuildPlugin,
      });
    } catch (e) {
      // A broken loader/action must stop the build: a server that answers 500 to
      // every form because one `.hys` did not compile is worse than a build that
      // says which file.
      throw new Error(`[hydra] could not build the action table: ${e.message}`);
    }
  }

  // The API table, bundled the same way and for the same reason.
  //
  // A compile error in `src/api` stops the build here, before the client
  // bundle: an API route that silently did not compile would answer 404 for a
  // URL the author wrote, and the terminal would say the build succeeded.
  let apiBundlePath = null;
  if (apiEntry) {
    try {
      await bundleApi(esbuild, apiEntry, {
        outfile: path.join(cwd, API_BUNDLE),
        cwd,
        pkgRoot,
        hydraAlias: coreAlias,
        serverAlias,
        compilerPlugin: createHydraEsbuildPlugin,
      });
      apiBundlePath = path.join(cwd, API_BUNDLE);
      // A route file whose method functions were never EXPORTED would bundle
      // cleanly and then answer 405 to every request. That is a build that
      // succeeds and a feature that does not exist, so it is caught here while
      // the file name is still the thing on screen.
      //
      // Checked on the COMPILED source rather than by loading the bundle:
      // requiring it would execute whatever a module does at import time, and a
      // build step that connects to a database is not a build step.
      const compileOnly = createHydraEsbuildPlugin();
      const empty = missingMethodExports(apiTable.routes, (file) =>
        compileOnly.compile(file, fs.readFileSync(file, 'utf8')),
      );
      if (empty.length > 0) {
        throw new Error(
          `[hydra] ${empty.join(', ')} exports no HTTP method.\n` +
            `= src/api files must EXPORT one function per method:\n` +
            `    export def get(req):\n` +
            `        return {"ok": True}\n` +
            `  without \`export\` the function is local to the file and no request can reach it`,
        );
      }
      // The same silence for middleware: `def handle(req)` without `export`
      // compiles and then does nothing at all, which looks exactly like a
      // middleware whose conditions never match.
      const mw = middlewarePath(cwd);
      if (mw) {
        const res = compileOnly.compile(mw, fs.readFileSync(mw, 'utf8'));
        if (!res.error && !/\bexport\s+(?:async\s+)?(?:function\s+handle|const\s+handle)\b/.test(String(res.code))) {
          throw new Error(
            `[hydra] ${MIDDLEWARE_FILE} exports no \`handle\`.\n` +
              `= write \`export def handle(req):\` and return None to pass a request through`,
          );
        }
      }
    } catch (e) {
      throw new Error(`[hydra] could not build the API routes: ${e.message}`);
    }
  }

  // 1. Discover entrypoint
  //
  // Four names are accepted, in this order. If more than one exists the first
  // wins, and that used to happen in silence: a project with both `main.hyx`
  // and `index.hyx` built from `main.hyx` while `index.hyx` sat there looking
  // equally like the entrypoint. Say so instead — the wrong entrypoint
  // produces a site that builds fine and shows the wrong app.
  //
  // `ENTRY_CANDIDATES` is exported so the "not found" error, the docs and any
  // other consumer read ONE list. A second copy of these four names is how the
  // scaffold and the runner drift apart.
  const entryCandidates = ENTRY_CANDIDATES.map((f) => path.join(cwd, f));
  const entryPoint = entryCandidates.find((f) => fs.existsSync(f));
  if (!entryPoint) {
    throw new Error(`[hydra] Entrypoint not found. Create one of: ${ENTRY_CANDIDATES.join(', ')}`);
  }
  const otherEntries = entryCandidates
    .filter((f) => fs.existsSync(f) && f !== entryPoint)
    .map((f) => path.relative(cwd, f));
  if (otherEntries.length > 0) {
    // Honest ambiguity, not an error: the build is deterministic, the author's
    // intent may not be.
    console.log(
      `[hydra] warning: using ${path.relative(cwd, entryPoint)} as the entrypoint; ` +
        `also found ${otherEntries.join(', ')}. Delete the unused one to silence this.`,
    );
  }

  // 1b. Semantic check, ACROSS THE SOURCE — before anything is bundled.
  //
  // The runtime gate renders the page and fails on a throw, so it only sees the
  // code a render actually executes. A broken call inside an event handler, or
  // on a branch render does not take, was never executed: the build succeeded
  // and the crash shipped to the browser. Demonstrated with
  // `if take: n = len(d.keys())` — that emitted a JS method call that throws on
  // a plain object, and with `take=0` the build reported success.
  //
  // The checker knows about exactly this class (names no runtime provides), it
  // was simply never invoked during a build. Running it here is what closes the
  // hole, because the source is read even where a render never goes.
  //
  // Only warnings that mean "this will throw" fail the build; `hydra check`
  // without `--strict` stays advisory.
  if (process.env.HYDRA_NO_CHECK !== '1') {
    const srcDir = path.join(cwd, 'src');
    const bin = findCliBinary();
    if (bin && fs.existsSync(srcDir)) {
      const res = spawnSync(bin, ['check', '--strict', srcDir], { encoding: 'utf8' });
      if (res.status === 1) {
        const detail = withoutEnvOnlyProcessWarnings((res.stderr || res.stdout || '').trim(), cwd);
        if (detail !== '') {
          // Say what is wrong in the words that matter: not "warning", but the
          // reason a warning is fatal here.
          throw new Error(
            `[hydra] semantic check failed. These are names no runtime provides, so ` +
              `the bundle would throw in the browser instead of failing here ` +
              `(the runtime gate cannot see code a render never runs):\n${detail}\n` +
              `= fix the names above, or set HYDRA_NO_CHECK=1 to build anyway`,
          );
        }
      }
    }
  }

  // 1c. Warm the compile cache, in parallel, when the project is big enough for
  //     it to pay.
  //
  // esbuild runs every `onLoad` on one JS thread, so on a many-core box the
  // compiler is the serial part of a build. This compiles every source ONCE
  // across a worker pool and stores the results, so esbuild's own pass is a
  // cache hit per module.
  //
  // Guarded by `shouldPool`, which is a MEASUREMENT from
  // `benchmarks/compile.mjs`: at 0.39 ms/file a pool spends more on thread
  // startup than it saves, so this is a no-op on a normal project and the code
  // is still exercised on a large one. It also runs only on a cold cache —
  // nothing to warm otherwise.
  const _poolPhase = phaseStart();
  if (compileCache && process.env.HYDRA_NO_POOL !== '1') {
    const sources = sourceFilesUnder(path.join(cwd, 'src'));
    if (shouldPool(sources.length)) {
      const cold = sources.filter((f) => {
        try {
          return !compileCache.get(compileCache.keyFor(f, fs.readFileSync(f, 'utf8')));
        } catch {
          return false;
        }
      });
      if (cold.length > 0) {
        const addon = findNativeAddon();
        const pool = new CompilePool(addon).start();
        if (!pool.unsupported && !pool.failed) {
          _p = phaseStart();
          try {
            const items = cold.map((f) => ({ filename: f, source: fs.readFileSync(f, 'utf8') }));
            const results = await pool.compileAll(items);
            let stored = 0;
            for (let i = 0; i < items.length; i++) {
              const res = results[i];
              if (res && !res.error) {
                compileCache.set(compileCache.keyFor(items[i].filename, items[i].source), res);
                stored += 1;
              }
            }
            phase(`1c. compile pool (${stored})`, _poolPhase);
          } catch (err) {
            // A pool that fails must not fail the build: it is an optimization,
            // and the serial path below produces the same result.
            console.error(`[hydra] compile pool skipped: ${err.message}`);
          } finally {
            await pool.stop();
          }
        }
      }
    }
  }

  // 2. Discover the runtime
  //
  // `hydra` is the single runtime specifier. The compiler emits
  // `import { capitalize } from 'hydra'` for every helper a source used but did
  // not import, and application code imports its React helpers (`state`,
  // `use_path`, `mount`) from the same name. Both must resolve to the runtime
  // that ships with this package, which carries every helper the compiler can
  // emit.
  //
  // A project file must NOT shadow this specifier. `src/hydra.hys` is never
  // going to have every helper the compiler can emit (`len_of`, `contains`,
  // `list_remove`, ...), and pointing the specifier at it produced
  // "No matching export in src/hydra.hys for import len_of". Import a project
  // runtime by relative path instead.


  // 8. Pre-render (SSG) — started here, awaited at step 8 below.
  //
  // The SSR bundle is built from `src/App.hyx` and shares nothing with the
  // client bundle except the sources it reads, so it can be built while the
  // client bundle is being built. On the portfolio that is ~340 ms of the
  // build, previously spent waiting with nothing else happening.
  //
  // Started as a settled-shape promise: an early rejection with no handler
  // attached yet would surface as an unhandled rejection and take the process
  // down, and SSG failure is deliberately non-fatal (step 8 reports it).
  const ssgEntryCandidates = [
    // The generated pre-render entry comes first when file-based routing is on:
    // the runtime `Router` resolves pages in an effect, and `renderToString`
    // does not run effects, so rendering through it would pre-render an empty
    // shell. The generated entry imports the pages statically instead.
    ...(routesTable
      ? [
          writeSsgEntry(cwd, routesTable, { entry: appComponentPath(cwd, entryPoint), base }),
        ].filter(Boolean)
      : []),
    path.join(cwd, 'src/App.hyx'),
    path.join(cwd, 'src/App.hsx'),
    path.join(cwd, 'src/App.jsx'),
    path.join(cwd, 'src/App.tsx'),
    path.join(cwd, 'src/App.js'),
    entryPoint,
  ];
  // Pre-render exists for crawlers, not for the person looking at the page, and
  // `hydra dev` rebuilds on every save. Skipping it in dev is where the loop
  // gets noticeably shorter; `hydra build` still pre-renders.
  // A.2: the default flipped. Pre-rendering is ON for a project that routes by
  // file, because that is the case where it is right and where the reader would
  // expect it; it stays off for a project that does not (nothing to pre-render
  // per route) and for `dev`.
  //
  // The three ways to turn it off, in the order they win:
  //   `"rendering": { "ssg": false }`  — the project
  //   `rendering = "csr"` in a page    — that route only
  //   HYDRA_NO_SSG=1                   — this build
  //
  // SSG does NOT require file-based routing.
  //
  // This used to be `projectWantsSsg && (routesHaveSsg || Boolean(routesTable))`,
  // and with no `src/pages` there is no route table — so a one-page project got
  // no pre-render at all, while `"ssg": true` sat in its config promising one.
  // The build succeeded, the runtime gate passed, and `dist/index.html` shipped
  // `<div id="root"></div>`: a blank page for every crawler, with no message.
  //
  // A project without a route table still has exactly one page — its entry —
  // and that is the most common shape there is (a landing page, a portfolio).
  // The render path for it already existed further down (`if (!routesTable)`);
  // only the gate above stopped it from ever running.
  const projectWantsSsg = config.rendering?.ssg !== false;
  const routesHaveSsg = routesTable
    ? routesTable.routes.some((r) => r.rendering !== 'csr')
    : true; // no table means the entry itself is the single static page
  const ssgWanted =
    projectWantsSsg && routesHaveSsg && !opts.dev && process.env.HYDRA_NO_SSG !== '1';
  // Runtime gate: on by default for a production build, never during `dev`
  // (a browser per rebuild would make the loop unusable), and skippable.
  const gateWanted = !opts.dev && process.env.HYDRA_NO_GATE !== '1';
  // The SERVER BUNDLE is built whenever routing is on, even in `dev` and even
  // when pre-rendering is off, because `hydra dev` / `preview` / `serve` render
  // dynamic routes per REQUEST from it. Tying it to `ssgWanted` meant a project
  // with `"ssg": false` could not server-render a dynamic route at all — the
  // command that exists to render them had no bundle to render from.
  //
  // The PRE-RENDER pass below still uses `ssgWanted`; the two decisions are
  // separate on purpose. One is an artifact the server needs; the other is a
  // build step that writes static HTML.
  const serverBundleWanted = Boolean(routesTable);
  const ssgEntry =
    ssgWanted || serverBundleWanted
      ? ssgEntryCandidates.find((f) => fs.existsSync(f))
      : undefined;

  let ssgPromise = null;
  if (ssgEntry) {
    ssgPromise = buildSsgBundle(
      esbuild,
      cwd,
      pkgRoot,
      ssgEntry,
      { hydra: hydraAlias, server: serverAlias },
      config,
      mode,
      base,
      routesTable,
    )
      .then((result) => ({ result }))
      .catch((err) => ({ err }));
  }

  // 3. Bundle JavaScript via esbuild
  //
  // Tailwind starts here rather than after the bundle. It reads `src/` and
  // `index.html` on its own and never looks at esbuild's output, so the two
  // are independent — and on a Tailwind project the CSS pass was the single
  // longest phase after the bundle. Running them together hides it.
  //
  // Step 5 below still merges Tailwind's CSS with whatever esbuild collected;
  // only the waiting moved, not the order of the output.
  _p = phaseStart();
  // Named for what it does now: the project's CSS pipeline, whichever one it
  // chose. Started here and awaited in step 3 so it overlaps the client bundle.
  const cssPromise = compileCss(cwd, config, { postcss, tailwindcss, autoprefixer })
    .then((out) => ({ out }))
    .catch((err) => ({ err }));

  const clientBuildOptions = {
    entryPoints: [entryPoint],
    // Metafile keys then come back relative to the project, which is what
    // `dist/.hydra-build.json` should contain and what the emitted entry name
    // is read from below.
    absWorkingDir: cwd,
    bundle: true,
    minify: true,
    // Sourcemaps are ~900 ms of a production build on this box — the single
    // most expensive option in this call. OFF by default, like every other
    // bundler's production mode: a map carries every line of the application's
    // source in `sourcesContent`, and `dist/` is what gets uploaded. A project
    // that debugs from the deployed source can turn them on with
    // `"build": { "sourcemap": true }`; shipping the source by default is the
    // kind of "helpful" that has to be undone after an audit.
    sourcemap: config.build?.sourcemap === true,
    jsx: 'automatic',
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    // An `outfile` can only ever hold one chunk, so `import("./Page.hyx")` had
    // nowhere to split to and React.lazy had nothing to fetch. An `outdir` plus
    // `splitting` is what makes a dynamic import a real second file on disk.
    outdir: assetsDir,
    splitting: true,
    // Hashed names everywhere: one chunk changing must not invalidate the rest
    // in a browser cache. `entryNames` is read back out of the metafile when
    // index.html is generated - the name is not knowable in advance.
    entryNames: 'index-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    // For `format: 'esm'` esbuild would otherwise emit `.mjs`, which no
    // `<script type="module" src>` in the wild is written against.
    outExtension: { '.js': '.js' },
    // Absolute URLs for emitted assets and chunks, rooted at the deployment
    // base. Relative URLs break the moment a component is rendered from a
    // nested route like `/dashboard/settings`.
    //
    // The root is the URL of `assetsDir`, NOT of `base`: esbuild resolves a
    // chunk's URL against `publicPath`, and this call writes into
    // `<outDir>/assets`. With `publicPath: base` a chunk referenced from the
    // entry came out as `/chunks/x-<hash>.js` — one directory short of where it
    // was written (`assets/chunks/…`) — so the browser got a 404 on the entry's
    // first import and nothing mounted, while the build itself reported success.
    publicPath: assetsPublicPath,
    metafile: true,
    plugins: [
      runtimeSpecifierPlugin({ hydra: hydraAlias, 'hydra/client': clientAlias }),
      createHydraEsbuildPlugin({
        cache: compileCache,
        // The `PUBLIC_` split, enforced where it can actually be enforced: every
        // compiled module in the client graph. A `.hys` that a component imports
        // is caught too, which a `.hyx`-only rule would have missed — and that
        // is exactly the case a secret leaks through.
        onCompiled: (file, code) => {
          const rel = path.relative(cwd, file).split(path.sep).join('/');
          return clientEnvViolations(code).map((v) => ({
            name: v.name,
            text: describeClientEnvViolation(file, rel, v),
          }));
        },
      }),
      // `hydra:routes` ALWAYS resolves, with an empty table when the project has
      // no pages directory. That is what lets the runtime import it statically:
      // a synchronous table is required for the client's first paint to match
      // the pre-rendered HTML, and a conditional module would mean a lazy path
      // that renders nothing once and then fills in — a hydration mismatch on
      // every page that was correctly pre-rendered.
      // `split: true` for the CLIENT bundle: each page becomes its own chunk so
      // the initial download does not grow with the number of routes. The
      // server bundle keeps static imports, because it renders synchronously.
      routesEsbuildPlugin(routesTable || EMPTY_ROUTES, { base, cwd, split: true }),
    ],
    // The runtime file lives in this package, but it imports 'react' and
    // 'react-dom/client'. esbuild resolves those relative to the IMPORTING
    // file, so it looked inside the toolchain's own node_modules — where React
    // usually is not — and failed with a bare "Could not resolve
    // react-dom/client". nodePaths makes the project's own node_modules
    // available too, which is where the app's React actually lives.
    nodePaths: [
      path.join(cwd, 'node_modules'),
      path.join(pkgRoot, 'node_modules'),
    ],
    resolveExtensions: ['.hyx', '.hys', '.hsx', '.hs', '.mjs', '.js', '.jsx', '.ts', '.tsx', '.json'],
    // tsconfig `paths` first so a project that declares its own `@` mapping
    // wins, then the built-ins: the two runtime specifiers are the compiler's
    // contract and must never be shadowed.
    alias: {
      ...tsconfigAliases(cwd),
      '@': path.resolve(cwd, 'src'),
      // NO alias for `hydra` itself. esbuild applies `alias` BEFORE plugins and
      // matches a prefix per path segment, so an alias for `hydra` answers
      // `hydra/server` too and rewrites it to `<hydra.ts>/server` — it never
      // reaches `runtimeSpecifierPlugin`, which is the thing that must decide.
      // All three specifiers are the plugin's job now, exactly.
    },
    loader: {
      ...ASSET_LOADERS,
      // Published packages ship untranspiled JSX inside `.js` files often
      // enough that it cannot be treated as an error. The `jsx` loader only
      // looks for JSX, so a plain `.js` file still goes through untouched.
      // `compiler.jsxInJs: false` in hydraconfig turns it off.
      ...(config.compiler?.jsxInJs === false ? {} : { '.js': 'jsx' }),
      // There is deliberately no `.css` entry. A `.css: 'empty'` loader used to
      // be here, which silently deleted every stylesheet a library shipped
      // (`import "some-lib/style.css"` produced a build with no styles and no
      // warning). esbuild collects that CSS into a bundle now, and it is merged
      // into assets/index.css below.
    },
    define: envDefines(mode, base),
  };

  let clientResult;
  if (opts.dev) {
    // Incremental in dev: the context is created once and every later save is
    // a rebuild(), which reuses the parsed graph of every unchanged file.
    //
    // Reused only while it still describes THIS build. The context freezes its
    // `define` map at creation, and `PUBLIC_*` values are defines — so a `.env`
    // edit would rebuild every module against the old values and the page would
    // keep showing them, with the build reporting success. That is why the
    // defines are compared and the context dropped when they moved.
    const defineKey = JSON.stringify(clientBuildOptions.define);
    try {
      if (!devEsbuildContext || devEsbuildDefineKey !== defineKey) {
        if (devEsbuildContext) {
          try { await devEsbuildContext.dispose(); } catch {}
        }
        devEsbuildContext = await esbuild.context(clientBuildOptions);
        devEsbuildDefineKey = defineKey;
      }
      clientResult = await devEsbuildContext.rebuild();
    } catch (err) {
      // A context that failed to create (or failed mid-rebuild) is not
      // reusable; drop it so the next save starts clean instead of throwing
      // the same error for the rest of the session.
      if (devEsbuildContext) {
        try { await devEsbuildContext.dispose(); } catch {}
      }
      devEsbuildContext = null;
      devEsbuildDefineKey = null;
      throw new Error(explainClientBuildError(err, cwd));
    }
  } else {
    // A failure here is rewritten in the project's terms before it propagates,
    // because the raw one names the symptom (`Could not resolve "node:fs"`).
    clientResult = await esbuild.build(clientBuildOptions).catch((err) => {
      throw new Error(explainClientBuildError(err, cwd));
    });
  }

  phase('2. esbuild client bundle', _p);

  const metafile = clientResult.metafile;

  // 4. Build metadata for `hydra analyze`.
  //
  // Written only here, immediately after a build that returned, so a failed
  // client build can never leave behind a metafile describing output that is
  // not on disk. The contents are esbuild's metafile verbatim - {inputs,
  // outputs} and nothing else - because `hydra analyze` parses it as such.
  fs.writeFileSync(path.join(outDir, '.hydra-build.json'), JSON.stringify(metafile));

  // The one output that is an entry point: its name carries a hash, so
  // index.html can only be pointed at it after the fact.
  //
  // At most one output can BE the entry, but "first key that has an entryPoint"
  // is not the same test. With splitting on, esbuild also marks a dynamic import
  // that resolves to a static path (`import("./Item.hyx")` in a lazy loader) as an
  // entryPoint, and `Object.keys` is in key order — `assets/chunks/…` sorts before
  // `assets/index-…`. index.html then pointed at a random COMPONENT chunk instead
  // of the app, so the page loaded a module that renders nothing: measured, a
  // 235-chunk build whose entry script was `chunks/TextPressure-*.js`.
  //
  // The entry is the output whose path matches the configured `entryNames`
  // pattern; fall back to the shallowest key, which is the one directly under
  // `assets/`. If two of them still exist the build is ambiguous and says so
  // rather than picking silently.
  const chunkCandidates = Object.keys(metafile.outputs).filter(
    (k) => metafile.outputs[k].entryPoint && k.endsWith('.js'),
  );
  const entryOutKey = chunkCandidates.find((k) => k.includes(assetsDir + path.sep))
    ?? chunkCandidates
      .slice()
      .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))[0];
  if (!entryOutKey) {
    throw new Error('[hydra] The client build produced no JavaScript entry chunk');
  }
  if (chunkCandidates.length > 1) {
    const others = chunkCandidates.filter((k) => k !== entryOutKey);
    console.warn(
      `[hydra] ${chunkCandidates.length} entry chunks in the metafile; index.html uses ${path.basename(entryOutKey)} and leaves ${others.length} to dynamic import (e.g. ${path.basename(others[0])})`,
    );
  }

  // 5. One stylesheet out: Tailwind, then every stylesheet the module graph
  // imported, merged into assets/index.css.
  //
  // Tailwind comes first because src/index.css is imported first by the entry
  // (its preflight has to sit under the library rules, exactly as it would if
  // the import order decided the order), and the libraries follow.
  const cssParts = [];
  _p = phaseStart();
  const cssOutcome = await cssPromise;
  // A stylesheet that fails to process kills the build — but only here, after
  // the bundle is on disk, and with the same error it would have had earlier.
  if (cssOutcome.err) throw cssOutcome.err;
  const pipelineCss = cssOutcome.out ? cssOutcome.out.css : null;
  if (cssOutcome.out && cssOutcome.out.pipeline) {
    const p = cssOutcome.out.pipeline;
    const label =
      p.kind === 'tailwind'
        ? `tailwind (${p.source})`
        : p.kind === 'postcss-config'
          ? `postcss (${p.source})`
          : p.kind === 'styling-list'
            ? `plugins (${p.plugins.join(', ')})`
            : p.kind === 'plain'
              ? 'plain postcss'
              : 'copied unprocessed';
    console.log(`[hydra] styling: ${label}`);
  }
  phase('3. css pipeline (overlapped)', _p);
  _p = phaseStart();
  if (pipelineCss !== null) cssParts.push(pipelineCss);

  const cssKeys = Object.keys(metafile.outputs).filter((k) => k.endsWith('.css'));
  const entryCssKey = metafile.outputs[entryOutKey].cssBundle;
  const coveredInputs = new Set(
    Object.keys((entryCssKey && metafile.outputs[entryCssKey]?.inputs) || {}),
  );
  for (const key of cssKeys) {
    const contents = fs.readFileSync(outputPath(cwd, key), 'utf8');
    if (key === entryCssKey) {
      cssParts.push(contents);
      continue;
    }
    // esbuild hoists everything reachable into the entry's CSS bundle, but
    // "reachable" is its judgement, not ours. Anything a chunk carries that the
    // entry bundle does not is appended here rather than dropped on the floor -
    // a missing stylesheet is the failure mode this whole section exists to
    // prevent.
    const uncovered = Object.keys(metafile.outputs[key].inputs || {})
      .filter((input) => !coveredInputs.has(input));
    if (uncovered.length > 0) cssParts.push(contents);
  }

  // The stylesheet's filename carries the same content hash the JS entry does.
  //
  // Without it there were two cache strategies in one build: `index-ABC.js` can
  // be cached forever (its name changes when it changes), while `index.css` can
  // be cached for zero seconds, because its name never does. Every deploy then
  // invalidated the CSS for every visitor, and — the worse half — a CDN holding
  // the old `/assets/index.css` served it beside new HTML, so the layout was
  // the previous release's.
  const cssOutPath = path.join(assetsDir, `index-${shortHash(cssParts.join('\n'))}.css`);
  const wroteCss = cssParts.length > 0;
  if (wroteCss) {
    let css = cssParts.join('\n');
    if (mode === 'production') {
      // The JS is minified; leaving the CSS pretty would be half a production
      // build. esbuild's CSS parser is already loaded, so this costs nothing.
      css = (await esbuild.transform(css, { loader: 'css', minify: true })).code;
    }
    fs.writeFileSync(cssOutPath, css, 'utf8');
  }
  /** `/assets/index-<hash>.css`, resolved against `base`, or null. */
  const cssUrl = wroteCss
    ? assetsPublicPath + path.basename(cssOutPath)
    : null;
  // Every esbuild CSS bundle is now merged into the file above. Leaving them
  // would ship the same rules twice, and nothing references the copies: CSS
  // outputs are never imported by the JS. The sidecar maps go with them, or
  // dist keeps a sourcemap for a file that is not there.
  for (const key of cssKeys) {
    fs.rmSync(outputPath(cwd, key), { force: true });
    fs.rmSync(outputPath(cwd, key) + '.map', { force: true });
  }

  phase('4. css merge', _p);

  // 6. Generate dist/index.html
  const htmlInPath = path.join(cwd, 'index.html');
  const htmlOutPath = path.join(outDir, 'index.html');
  if (fs.existsSync(htmlInPath)) {
    let html = fs.readFileSync(htmlInPath, 'utf8');

    // Replace the source entry with the bundle esbuild actually wrote.
    const entryUrl = outputUrl(cwd, outDir, base, entryOutKey);
    const scriptTag = `<script type="module" crossorigin src="${entryUrl}"></script>`;
    const entrySrc = path.relative(cwd, entryPoint).split(path.sep).join('/');
    let replaced = false;
    for (const candidate of [entrySrc, './' + entrySrc, base + entrySrc]) {
      const re = new RegExp(
        `<script[^>]*src=["'][^"']*${escapeRegExp(candidate)}["'][^>]*>\\s*</script>`,
        'i',
      );
      if (re.test(html)) {
        html = html.replace(re, scriptTag);
        replaced = true;
        break;
      }
    }
    // No tag pointing at the entry (an inline bootstrap, a template that
    // forgot it): inject one rather than ship a page with no bundle.
    if (!replaced) {
      if (html.includes('</body>')) html = html.replace('</body>', `  ${scriptTag}\n  </body>`);
      else html += `\n${scriptTag}\n`;
    }

    if (cssUrl && !/assets\/index-[^"']*\.css/.test(html)) {
      html = html.replace('</head>', `  <link rel="stylesheet" crossorigin href="${cssUrl}">\n  </head>`);
    }
    fs.writeFileSync(htmlOutPath, html, 'utf8');
  }

  // 7. Copy public/ directory
  //
  // `public/index.html` would be copied here and then immediately overwritten
  // by the build's own `index.html` (step 6 already ran), and by every
  // pre-rendered route after that. That is not a merge, it is a silent
  // deletion of the author's file, so it is reported instead of performed.
  const publicDir = path.join(cwd, 'public');
  if (fs.existsSync(publicDir)) {
    const shadowed = ['index.html', '404.html'].filter((f) => fs.existsSync(path.join(publicDir, f)));
    for (const f of shadowed) {
      console.warn(
        `[hydra] public/${f} is ignored: the build generates that file. ` +
          `Edit the project's own \`${f}\` instead (or a page's route for 404).`,
      );
    }
    copyDirRecursive(publicDir, outDir, {
      skip: new Set(shadowed.map((f) => path.join(publicDir, f))),
    });
  }

  // 8. SSG Pre-rendering (default true for SEO)
  //
  // The bundle was already built in the background (see the ssgPromise set up
  // before the client bundle); this step only awaits it and renders. A failure
  // in the background build surfaces here, where it has always been reported.
  _p = phaseStart();
  if (ssgPromise) {
    {
      try {
        const reactPath = resolvePkg('react', cwd);

        let _s = phaseStart();
        const ssgOutcome = await ssgPromise;
        if (ssgOutcome.err) throw ssgOutcome.err;
        const ssgCode = ssgOutcome.result.code;

        phase('5a. ssg bundle (esbuild)', _s);
        _s = phaseStart();
        // Run SSR execution in a safe context
        setupSSRGlobals();

        // Written to disk inside the project and loaded with a require rooted
        // at that file, so every `require("react")` in the bundle resolves
        // against the project's own node_modules. Loading from a `data:` URL
        // or as ESM gives the module no require at all and the pre-render dies
        // with "Dynamic require of react is not supported" — after a client
        // build that had already succeeded.
        const ssgOut = path.join(outDir, '.hydra-ssg.cjs');
        fs.writeFileSync(ssgOut, ssgCode, 'utf8');
        let ssgMod;
        try {
          const requireFromOut = createRequire(pathToFileURL(ssgOut).href);
          ssgMod = requireFromOut(ssgOut);
        } finally {
          // Pre-render is a build step, not an artifact: never ship the bundle
          // in `dist/`. It IS kept in `.hydra/`, which is gitignored and is what
          // the dev/preview/serve commands render dynamic routes from. A server
          // needs it per request; a deploy to a CDN must not have it.
          try { fs.rmSync(ssgOut, { force: true }); } catch {}
        }
        // The server's copy, written next to the route table it belongs to.
        try {
          const serverDir = path.join(cwd, '.hydra');
          fs.mkdirSync(serverDir, { recursive: true });
          fs.writeFileSync(path.join(cwd, SERVER_BUNDLE), ssgCode, 'utf8');
        } catch (err) {
          console.error(`[hydra] could not write the server bundle: ${err.message}`);
        }

        phase('5b. ssg load bundle', _s);
        _s = phaseStart();
        const reactDomServerPath = resolvePkg('react-dom/server', cwd);
        const { renderToString } = await import(pathToFileURL(reactDomServerPath).href);
        const reactMod = await import(pathToFileURL(reactPath).href);
        const React = reactMod.default || reactMod;

        phase('5c. ssg import react', _s);
        _s = phaseStart();

        // One page of HTML per static route. A route with a parameter has no
        // single URL to render, so it is skipped and SAID OUT LOUD: a project
        // that ships a `/blog/:slug` and finds an empty shell in the served HTML
        // has to be able to read why, not infer it.
        /**
         * `/blog/:slug` + `{slug: "hello"}` -> `/blog/hello`. Null when a
         * parameter is unfilled, so a half-specified entry is reported rather
         * than silently written to a path with a literal `:slug` in it.
         */
        const fillPattern = (pattern, params) => {
          let ok = true;
          const url = pattern.replace(/:([A-Za-z_$][\w$]*)/g, (_, name) => {
            const v = params[name];
            if (v === undefined || v === null) {
              ok = false;
              return '';
            }
            return String(v);
          });
          // A catch-all consumes the rest of the path; `[...rest]` in a pattern
          // is spelled `*` by the router's own matcher.
          const withRest = params.rest !== undefined && url.includes('*');
          const final = withRest
            ? url.replace('*', [].concat(params.rest).join('/'))
            : url;
          if (final.includes('*')) ok = false;
          return ok ? final.replace(/\/{2,}/g, '/') : null;
        };

        const preRenderable = routesTable
          ? routesTable.routes.filter(
              (r) => !r.hasParams && r.rendering !== 'csr' && r.rendering !== 'ssr',
            )
          : [];
        const csrRoutes = routesTable ? routesTable.routes.filter((r) => r.rendering === 'csr') : [];
        // `rendering = "ssr"` means exactly one thing: do NOT write a file for
        // this route, render it per request instead. The scanner accepted the
        // value and the build ignored it, so a page that asked to be dynamic
        // shipped as static HTML — a promise the schema made and the build
        // broke silently.
        const ssrRoutes = routesTable ? routesTable.routes.filter((r) => r.rendering === 'ssr') : [];
        const staticRoutes = preRenderable;
        const dynamicRoutes = routesTable ? routesTable.routes.filter((r) => r.hasParams) : [];

        // The SOURCE template, not the emitted file.
        //
        // `dist/index.html` is written by the client build with the bundle tag
        // already in it, and using it here meant the first render replaced its
        // `<div id="root">` while every later route got a template whose root was
        // no longer empty — so `inject` matched nothing and those pages shipped
        // an EMPTY root with correct data inlined beside it. Re-reading the
        // project's own `index.html` is what makes every route start from the
        // same blank template.
        const sourceHtml = fs.existsSync(htmlInPath) ? fs.readFileSync(htmlInPath, 'utf8') : null;
        // The bundle tag the client build computed, so the pre-rendered pages
        // point at the same entry as `dist/index.html` does.
        const entryTag = (() => {
          if (!sourceHtml) return '';
          const m = /<script[^>]*src=["']([^"']*assets\/index-[^"']+)["'][^>]*><\/script>/i.exec(
            fs.existsSync(htmlOutPath) ? fs.readFileSync(htmlOutPath, 'utf8') : '',
          );
          return m ? m[0] : '';
        })();
        // The stylesheet tag the client build computed. Without it every
        // pre-rendered page shipped with NO stylesheet at all: the tag was
        // injected into `dist/index.html` by the client step, and SSG then wrote
        // that file again from the SOURCE template, which has no tag because the
        // source cannot know the content hash. The first page had styles, and
        // every route after it did not — which is the kind of bug that survives
        // a build because the markup is correct.
        const cssTag = (() => {
          if (!fs.existsSync(htmlOutPath)) return '';
          const built = fs.readFileSync(htmlOutPath, 'utf8');
          const m = /<link[^>]*href=["']([^"']*assets\/index-[^"']+\.css)["'][^>]*>/i.exec(built);
          return m ? m[0] : '';
        })();
        const withBundle = (html) => {
          if (!entryTag && !cssTag) return html;
          // The source template points at `src/main.hyx`; swap in the real bundle.
          const src = path.relative(cwd, entryPoint).split(path.sep).join('/');
          const re = new RegExp(
            `<script[^>]*src=["'][^"']*${escapeRegExp(src)}["'][^>]*>\\s*</script>`,
            'i',
          );
          let out = html;
          if (entryTag) {
            out = re.test(out)
              ? out.replace(re, entryTag)
              : out.includes('</body>')
                ? out.replace('</body>', `  ${entryTag}\n  </body>`)
                : out + entryTag;
          }
          // The stylesheet goes with it, for the same reason: the source
          // template cannot name a hashed file.
          if (cssTag && !/assets\/index-[^"']*\.css/.test(out)) {
            out = out.includes('</head>')
              ? out.replace('</head>', `  ${cssTag}\n  </head>`)
              : out;
          }
          return out;
        };
        const inject = (html, rendered) =>
          html.replace(/<div\s+id=["']root["']\s*>\s*<\/div>/i, `<div id="root">${rendered}</div>`);

        /** `/about` -> `dist/about/index.html`; `/` -> `dist/index.html`. */
        const htmlPathForPattern = (pattern) => {
          if (pattern === '/') return htmlOutPath;
          const slug = pattern.replace(/^\/+|\/+$/g, '');
          if (!slug) return htmlOutPath;
          const dir = path.join(outDir, ...slug.split('/'));
          fs.mkdirSync(dir, { recursive: true });
          return path.join(dir, 'index.html');
        };

        /**
         * Expand the static routes with the ones a page opted into.
         *
         * A route with a parameter has no single URL, so it used to be left to
         * the server — correct for a static deploy and useless for the thing SSG
         * is FOR: a crawler asking for `/blog/hello`. `staticParamsFor` asks the
         * page's own `.server.hys` for the instances it knows, and each one is
         * rendered like any other static route.
         *
         * `[]` means "none, render per request" and is honoured; `null` means the
         * page did not opt in and the route stays dynamic with a note. The
         * difference matters: a dashboard must not be prerendered, and a blog
         * must not be silently skipped.
         */
        const expandedRoutes = [];
        const dynamicWithoutParams = [];
        if (routesTable) {
          for (const route of preRenderable) expandedRoutes.push({ ...route, params: {} });
          if (typeof ssgMod.staticParamsFor === 'function') {
            for (const route of dynamicRoutes) {
            if (route.rendering === 'ssr' || route.rendering === 'csr') continue;
            let list;
            try {
              list = await ssgMod.staticParamsFor(route.pattern);
            } catch (err) {
              console.error(
                `[hydra] SSG: static_params() for ${route.pattern} failed: ${err.message || err}`,
              );
              continue;
            }
            if (list === null) {
              dynamicWithoutParams.push(route.pattern);
              continue;
            }
            for (const params of list) {
              if (!params || typeof params !== 'object') continue;
              const url = fillPattern(route.pattern, params);
              if (!url) {
                console.error(
                  `[hydra] SSG: static_params() for ${route.pattern} returned ${JSON.stringify(params)}, ` +
                    'which does not fill every parameter; skipped',
                );
                continue;
              }
              expandedRoutes.push({ ...route, params, url });
            }
          }
        }
      }

        let renderedCount = 0;
        if (sourceHtml && routesTable && expandedRoutes.length > 0 && typeof ssgMod.renderFor === 'function') {
          for (const route of expandedRoutes) {
            try {
              // Always `{ render, withRequest, data }`. There is no fallback to
              // the raw return value: an earlier version fell back when the
              // element was null, which handed React the wrapper object and
              // produced "Objects are not valid as a React child" instead of the
              // reason.
              //
              // The render itself runs INSIDE `withRequest`, which is what puts
              // the loader's data in this request's async context. Outside it,
              // `Router` sees no seed and renders the route as if it were the
              // browser's first paint — an empty shell with correct data beside
              // it.
              // A `generateStaticParams` entry renders its OWN url with its own
              // params; a plain static route is the pattern with an empty map.
              const renderUrl = route.url || route.pattern;
              const out = await ssgMod.renderFor(route.pattern, route.params || {}, renderUrl);
              if (!out || typeof out.withRequest !== 'function') {
                console.warn(`[hydra] SSG: ${route.pattern} (src/pages/${route.file}) exports no component; skipped`);
                continue;
              }
              const rendered = out.withRequest(() => {
                const element = out.render();
                return element ? renderToString(element) : null;
              });
              if (rendered === null) {
                console.warn(`[hydra] SSG: ${route.pattern} (src/pages/${route.file}) exports no component; skipped`);
                continue;
              }
              // The loader's result travels with the HTML so the client's first
              // paint has the same data the server rendered from. Without it the
              // client fetches again and the two frames disagree — React says so
              // as a hydration mismatch, which is how this was found.
              //
              // `meta` goes in AFTER that, on the whole document: the page's own
              // `<title>` replaces the shell's, so a crawler and a tab read the
              // route rather than the app. It is read from the scanner's table —
              // the same source the client's route table is generated from — so
              // the static HTML and a later client navigation cannot disagree.
              // A page that exports `metadata(event)` gets a title built from
              // its data. This is what makes a per-slug title possible at all:
              // the static `meta = {...}` dict is one dict for the whole route,
              // so `/blog/hello` and `/blog/world` could only ever share a
              // title. The merge order is deliberate — the dynamic result wins
              // over the static dict, because a function that ran with the
              // request knows more than a literal that did not.
              let routeMeta = route.meta;
              if (typeof ssgMod.metadataFor === 'function') {
                try {
                  const dynamicMeta = await ssgMod.metadataFor(
                    route.pattern,
                    route.params || {},
                    renderUrl,
                  );
                  if (dynamicMeta) {
                    routeMeta = { ...(routeMeta || {}), ...validateRichMeta(dynamicMeta, `metadata() for ${route.pattern}`) };
                  }
                } catch (err) {
                  // A metadata function that throws must not cost the page its
                  // HTML. Named, and the static dict still applies.
                  console.error(`[hydra] SSG: ${route.pattern}: ${err.message || err}`);
                }
              }
              const html = applyMeta(
                injectLoaderData(
                  withBundle(inject(sourceHtml, rendered)),
                  route.pattern,
                  out && out.data,
                ),
                routeMeta,
              );
              fs.writeFileSync(htmlPathForPattern(renderUrl), html, 'utf8');
              renderedCount += 1;
            } catch (err) {
              // One page that throws must not cost the other pages their HTML.
              console.error(`[hydra] SSG: ${route.pattern} failed to pre-render: ${err.message || err}`);
            }
          }
          console.log(
            `[hydra] SSG: pre-rendered ${renderedCount}/${expandedRoutes.length} static route(s) into ${path.relative(cwd, outDir)}/`,
          );
          if (dynamicWithoutParams.length > 0) {
            // Said out loud rather than inferred: a project that ships a
            // `/blog/:slug` and finds a shell in the HTML has to be able to read
            // WHY, and the fix (export static_params) named where they will look.
            console.log(
              `[hydra] SSG: left dynamic (no static_params export): ${dynamicWithoutParams.join(', ')}`,
            );
          }
          // A STATIC host has no router: Netlify, Cloudflare Pages, GitHub
          // Pages and nginx all look for `404.html` when nothing matches. The
          // project's `_404` existed but only ever reached the browser through
          // React, so a static deploy answered 404 with the host's own page
          // while the app's design sat unused in the bundle.
          if (typeof ssgMod.renderNotFound === 'function') {
            try {
              const element = ssgMod.renderNotFound('/__404');
              if (element) {
                const rendered = renderToString(element);
                if (typeof ssgMod.__clear_seed === 'function') ssgMod.__clear_seed();
                const html = applyMeta(withBundle(inject(sourceHtml, rendered)), {
                  title: 'Not found',
                });
                fs.writeFileSync(path.join(outDir, '404.html'), html, 'utf8');
                console.log(`[hydra] SSG: wrote 404.html for static hosts`);
              }
            } catch (err) {
              console.error(`[hydra] SSG: could not render the 404 page: ${err.message || err}`);
            }
          }
          if (csrRoutes.length > 0) {
            console.log(
              `[hydra] render: ${csrRoutes.length} route(s) marked csr and left to the client ` +
                `(${csrRoutes.map((r) => r.pattern).join(', ')})`,
            );
          }
          if (ssrRoutes.length > 0) {
            console.log(
              `[hydra] render: ${ssrRoutes.length} route(s) marked ssr, rendered per request ` +
                `(${ssrRoutes.map((r) => r.pattern).join(', ')})`,
            );
          }
          if (dynamicRoutes.length > 0) {
            console.log(
              `[hydra] SSG: ${dynamicRoutes.length} dynamic route(s) left as the client shell ` +
                `(${dynamicRoutes.map((r) => r.pattern).join(', ')}) — a URL with a parameter has no single page to build`,
            );
          }
        } else {
          // No STATIC route to pre-render — but that is not the same as "nothing
          // to do here".
          //
          // This branch used to write `dist/index.html` from the raw source
          // template, which threw away the bundle `<script>` tag the client
          // build had just injected. A project with only dynamic routes
          // (`/blog/[slug]` and no index page) shipped an index.html with no
          // bundle reference at all: the SSR route rendered server-side while
          // every client-side navigation rendered NOTHING, because no JavaScript
          // ever loaded. The runtime gate never saw it either — it looks at the
          // HTML a request returns, and the shell IS blank, which is correct for
          // a route that has no page.
          //
          // So: when there is no static page, `dist/index.html` is left exactly
          // as the client build wrote it. That file is the shell the server
          // injects into and the file the client hydrates from.
          if (!routesTable) {
            const AppComponent =
              ssgMod.App ||
              ssgMod.default ||
              Object.values(ssgMod).find((v) => typeof v === 'function');
            if (!AppComponent) {
              throw new Error('Could not find exported App component in SSR bundle');
            }
            const renderedHtml = renderToString(React.createElement(AppComponent));
            if (sourceHtml) {
              fs.writeFileSync(htmlOutPath, withBundle(inject(sourceHtml, renderedHtml)), 'utf8');
              console.log(
                `[hydra] SSG: Pre-rendered HTML injected into ${path.relative(cwd, htmlOutPath)} (${renderedHtml.length} chars)`,
              );
            }
          } else {
            console.log(
              `[hydra] SSG: no static route to pre-render (${dynamicRoutes.length} dynamic); ` +
                `dist/index.html is the client shell`,
            );
          }
        }

        phase('5d. renderToString', _s);
        // Sub-phases above replace the coarser '5. ssg render' entry: the
        // parent span covers exactly them plus the HTML injection, and
        // reporting both made the table add up to more than the build.
        for (let i = phaseTimes.length - 1; i >= 0; i--) {
          if (phaseTimes[i][0] === '5. ssg render') { phaseTimes.splice(i, 1); break; }
        }
      } catch (err) {
        console.error('[hydra] SSG Pre-rendering error:', err.message || err);
      }
    }
  }

  phase('5. ssg render', _p);

  // The build's own record of what it is. `preview` reads this to decide
  // whether the API routes it can see in the project are actually in the
  // artifact: a preview that mounts handlers a static build dropped would show
  // a working app that 404s the moment it is deployed.
  try {
    fs.writeFileSync(
      path.join(cwd, '.hydra', 'build.json'),
      JSON.stringify(
        {
          target,
          mode,
          api: apiTable.routes.map((r) => r.pattern),
          // The routes that have NO static HTML, so `serve` can name what breaks
          // when the server half is missing instead of answering "SSR off" and
          // handing every crawler an empty shell.
          dynamic: routesTable
            ? routesTable.routes
                .filter((r) => r.hasParams || r.rendering === 'ssr')
                .map((r) => r.pattern)
            : [],
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (err) {
    console.error(`[hydra] could not write .hydra/build.json: ${err.message}`);
  }

  // The static target drops the whole server half, and says so with the names
  // of the routes rather than a one-line note. An endpoint that builds
  // "successfully" and 404s in production is the failure this text prevents.
  if (target === 'static') {
    const dropped = droppedForStatic(cwd, apiTable);
    if (dropped.length > 0) console.log(dropped.join('\n'));
  } else if (apiTable.routes.length > 0) {
    console.log(
      `[hydra] api: ${apiTable.routes.length} route(s) in this build — \`hydra preview\` serves them`,
    );
  }

  const ms = Date.now() - t0;
  console.log(`[hydra] Built successfully in ${ms}ms -> ${path.relative(cwd, outDir)}/`);
  if (compileCache) {
    const s = compileCache.stats();
    // Said out loud, because "why is this build fast now" and "why is it slow
    // again" both deserve an answer in the log rather than a guess.
    if (s.hits > 0) console.log(`[hydra] compile cache: ${s.hits} reused, ${s.misses} compiled`);
  }
  phaseReport(ms);

  // 6. Runtime gate. The build reporting success while the page throws is the
  //    failure this catches, and it is invisible everywhere else: the compiler
  //    validated what it emitted, this validates what actually runs.
  if (gateWanted) {
    const { runRuntimeGate } = await import('./runtime-gate.mjs');
    const gate = await runRuntimeGate({
      distDir: outDir,
      // `quiet`: the gate starts its own server on port 0, and the startup line
      // ("Server running at http://127.0.0.1:0/") was printed into the BUILD
      // log. To anyone reading a build it says a server exists and that its port
      // is zero, which is nonsense in both halves; the gate's own result line is
      // the only thing that belongs there.
      // `base` matters here: a project with `base: "/sub/"` writes
      // `/sub/assets/...` into its HTML, and a gate serving it at `/` answers
      // 404 for every asset. The first build with a base failed the gate for
      // exactly that reason — which is the gate doing its job, once the server
      // it uses agrees with the server the project will actually run on.
      serve: (dir) => serveDirectory(dir, 0, '127.0.0.1', { quiet: true, base }),
    });
    if (gate.skipped) {
      console.log(`[hydra] runtime gate skipped: ${gate.skipped}`);
    } else if (gate.ok) {
      const extra = gate.warnings.length
        ? ` (${gate.warnings.length} console warning(s))`
        : '';
      // How many pages were actually checked. Without this number "gate passed"
      // reads as "every page works", and on a 61-route build it meant 25.
      const scope =
        typeof gate.checked === 'number'
          ? ` [${gate.checked}/${gate.total ?? gate.checked} page(s)]`
          : '';
      console.log(`[hydra] runtime gate passed: no uncaught exceptions${scope}${extra}`);
      for (const w of gate.warnings.slice(0, 5)) {
        console.log(`  warning: ${w}`);
      }
    } else {
      console.error(
        `[hydra] runtime gate FAILED: the page threw ${gate.exceptions.length} exception(s)`,
      );
      for (const e of gate.exceptions) console.error(`  ${e}`);
      for (const w of gate.warnings.slice(0, 5)) console.error(`  warning: ${w}`);
      console.error(
        '  = help: the bundle builds but does not run. To ship anyway: HYDRA_NO_GATE=1 hydra build',
      );
      process.exitCode = 1;
      throw new Error('[hydra] runtime gate failed');
    }
  }
}

/**
 * Response headers every answer carries.
 *
 * A framework that ships a server and sends none of these is telling the
 * operator to remember them at the proxy, which works until the proxy is
 * somebody else's. They are conservative and content-agnostic: nothing here can
 * break an app, and each one closes a hole that a browser will happily exploit
 * on a page that renders user content.
 *
 * CSP is deliberately NOT set here. A real policy depends on what the project
 * loads, and a wrong one silently breaks fonts, images or analytics — the exact
 * class of "the framework broke my site" that is worse than an absent header.
 * It belongs in `server.headers` when a project wants it, which is supported.
 */
function baseHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // `strict-origin-when-cross-origin` still sends the origin over http://, and
    // HSTS is what stops the first request from taking that trip at all. Only for
    // a server that is actually answering TLS: sending it on plain HTTP is
    // ignored by browsers at best, and on a localhost dev server it would pin
    // `localhost` to https in the operator's own browser, which is a support
    // ticket nobody can debug from the server side.
    ...(process.env.HYDRA_HTTPS === '1' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

/**
 * Cache policy for a built file.
 *
 * The distinction that matters: an asset whose name contains a content hash can
 * be cached for a year, because a change produces a new name. HTML cannot — it
 * is the thing that points at the new name, so a cached HTML document pins a
 * visitor to the previous release. `no-cache` is not "do not store"; it is
 * "revalidate before use", which is what an HTML document needs and what the
 * built-in server previously did not say at all.
 */
function cacheHeaders(ext, hasHash) {
  if (hasHash && /^\.(js|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg)$/.test(ext)) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  if (ext === '.html') return { 'Cache-Control': 'no-cache' };
  return { 'Cache-Control': 'public, max-age=3600' };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Match a `server.proxy` key against a request path the way Vite does: a key
 * matches if it is the whole path or a path-segment prefix of it. `"/api"`
 * therefore covers `/api/users` but not `/apifoo`.
 */
function matchProxy(proxy, reqPath) {
  for (const key of Object.keys(proxy)) {
    if (typeof proxy[key] !== 'string') continue;
    const k = key.endsWith('/') ? key.slice(0, -1) : key;
    if (k === '' || reqPath === k || reqPath.startsWith(k + '/')) return proxy[key];
  }
  return null;
}

/**
 * Forward one request to `target` and stream the answer back.
 *
 * node:http only, and piped in both directions: an upload is never buffered in
 * memory and a slow backend does not need a timeout invented here. The mounted
 * prefix is preserved (`/api/users` reaches the backend as `/api/users`), which
 * is what the app asked for.
 */
function proxyRequest(req, res, target, rawPath, rawUrl) {
  let url;
  try {
    url = new URL(target);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`[hydra] invalid proxy target: ${target}`);
    return;
  }

  const mod = url.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  // A different origin: keeping the original Host would make name-based vhosts
  // and TLS SNI answer for the wrong site.
  headers.host = url.host;

  const mount = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';

  const proxyReq = mod.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: mount + rawUrl,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    // The backend being down is a 502, not a crashed dev server.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`[hydra] proxy error for ${rawPath}: ${err.message}`);
  });
  req.on('error', () => proxyReq.destroy());
  req.pipe(proxyReq);
}

/**
 * Serve a mutation: find the route's `action`, run it, and answer with what it
 * returned.
 *
 * `redirect` becomes a real 303 with a `Location`, so a browser follows it and a
 * refresh does not repost. Data becomes JSON, which is what a client-side
 * `use_action` reads.
 */
/**
 * Where the generated action bundle is, if this project has one.
 *
 * Read from disk rather than carried in memory, because `hydra preview` is a
 * separate process from the build that produced it.
 */
function readActionBundle(cwd) {
  const f = path.join(cwd, '.hydra', 'actions.cjs');
  return fs.existsSync(f) ? f : null;
}

/**
 * `hydra serve` / `hydra start` — serve a built project.
 *
 * This used to be documented in the README and simply did not exist: `hydra
 * serve` answered "cannot read serve: No such file or directory", because the
 * native CLI treated the word as a file to compile. `preview` came first and is
 * still here; `serve` is the name a deployment unit reaches for, and the two
 * differ only in what they imply (preview may rebuild, serve must not).
 *
 * What it needs, and says so when it is missing:
 *
 *   dist/        the client build and every pre-rendered page
 *   .hydra/      server.cjs, api.cjs, actions.cjs — the server half
 *   node_modules with react/react-dom, because the server bundle requires them
 *
 * A missing server bundle is fatal HERE rather than a silent "SSR off": a
 * deployment that answers every dynamic URL with an empty shell looks like a
 * working site until a crawler reads it, and that is the one failure a startup
 * check can prevent for free.
 */
export async function runServe(cwd = process.cwd(), opts = {}) {
  loadProjectEnv(cwd);
  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const port = opts.port || config.server?.port || 5173;
  const host = opts.host || config.server?.host || '127.0.0.1';
  const indexPath = path.join(outDir, 'index.html');

  if (!fs.existsSync(outDir) || !fs.existsSync(indexPath)) {
    throw new Error(
      `[hydra] serve: no build at ${path.relative(cwd, outDir)}/. Run \`hydra build --target node\` first.`,
    );
  }

  const buildTarget = readBuildRecord(cwd).target || 'static';
  const hasServerHalf =
    fs.existsSync(path.join(cwd, SERVER_BUNDLE)) || fs.existsSync(path.join(cwd, API_BUNDLE));

  if (buildTarget !== 'node') {
    throw new Error(
      '[hydra] serve: this build is `--target static`, so it has no server half. ' +
        'Rebuild with `hydra build --target node`, or deploy `dist/` to a static host.',
    );
  }

  const renderer = await createRenderer({
    cwd,
    bundlePath: path.join(cwd, SERVER_BUNDLE),
    shellPath: indexPath,
  });
  if (!renderer.available) {
    // A dynamic route with no renderer is an empty shell and a 200 to every
    // crawler. Refusing to start is the honest answer.
    const routes = (() => {
      try {
        const table = JSON.parse(fs.readFileSync(path.join(cwd, '.hydra', 'build.json'), 'utf8'));
        return Array.isArray(table.dynamic) ? table.dynamic : [];
      } catch {
        return [];
      }
    })();
    throw new Error(
      `[hydra] serve: the server half could not be loaded (${renderer.reason}). ` +
        (routes.length > 0
          ? `These dynamic routes would answer with an empty shell: ${routes.join(', ')}.`
          : 'Run `hydra build --target node` in the project that owns this dist/.'),
    );
  }
  if (!hasServerHalf) {
    throw new Error('[hydra] serve: no .hydra/ server bundle beside the build.');
  }

  console.log(`[hydra] Serving ${path.relative(cwd, outDir) || 'dist'}/ (target ${buildTarget})`);
  const served = await serveDirectory(outDir, port, host, {
    base: normalizeBase(config.base),
    proxy: config.server?.proxy,
    actions: readActionBundle(cwd),
    ssr: renderer,
    api: readApiBundle(cwd),
    bodyLimit: config.server?.bodyLimit,
    rateLimit: config.server?.rateLimit,
    headers: config.server?.headers,
    version: opts.version,
    sha: opts.sha,
    configPath: path.join(cwd, 'hydraconfig.json'),
    portFallback: false,
  });

  const shutdown = (signal) => {
    console.log(`[hydra] ${signal}, closing server`);
    served.server.close(() => process.exit(0));
    // A hung keep-alive socket must not make a deploy wait forever.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return served;
}

async function handleAction(req, res, reqPath, rawUrl, bundlePath, opts = {}) {
  // Cross-site POSTs are refused before anything runs.
  //
  // Today an action has no cookie to steal, so this closes nothing yet — and
  // that is exactly why it goes in NOW: the moment a project adds session
  // cookies, an action that accepts a POST from any origin is a CSRF hole, and
  // the framework would be the thing that made it possible. A browser always
  // sends `Origin` on a cross-origin POST; a same-origin form posts one too on
  // modern browsers. A request with NO Origin header is a non-browser client
  // (curl, a test, a server-to-server call) and is allowed, because a form post
  // from a browser is the only case this defends against.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    const host = req.headers.host || '';
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (!originHost || originHost !== host) {
      sendError(
        res,
        403,
        'cross_origin_action',
        'cross-origin action refused',
        { origin, hint: 'actions accept same-origin requests; a browser sent this from another site' },
        baseHeaders(),
      );
      return;
    }
  }

  let mod;
  try {
    mod = await loadActions(bundlePath);
  } catch (e) {
    sendError(res, 500, 'actions_unavailable', `could not load actions: ${e.message}`);
    return;
  }
  const hit = mod && mod.actionFor ? mod.actionFor(reqPath) : null;
  if (!hit) {
    sendError(res, 405, 'no_action', `no action for ${req.method} ${reqPath}`, {
      hint: 'a route accepts a mutation only if a .server.hys beside it exports `action`',
    });
    return;
  }

  let rawBody = '';
  try {
    rawBody = await readBody(req, opts.bodyLimit);
  } catch (e) {
    // The same answered refusal the API layer gives. `req.destroy()` used to run
    // before this line, so the client saw an empty reply and no status at all.
    sendError(
      res,
      413,
      'body_too_large',
      e.message,
      { limit: e.limit ?? null, hint: 'raise server.bodyLimit in hydraconfig.json, or send less' },
      { Connection: 'close' },
    );
    return;
  }

  try {
    const out = await hit.fn({
      params: hit.params,
      url: reqPath,
      request: requestFor(req, rawUrl, rawBody),
    });
    // The same two helpers every other path reads, so an action and an API
    // route cannot disagree about what `redirect()` means.
    if (sendHttpIntent(res, httpIntent(out))) return;
    const status = out && typeof out === 'object' && out.status ? out.status : 200;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out === undefined ? null : out));
  } catch (e) {
    // An action that throws is a bug in the action, and the browser deserves to
    // know rather than receiving a 200 with an empty body.
    sendError(res, 500, 'action_threw', e && e.message ? e.message : String(e));
  }
}

export async function serveDirectory(dir, port = 5173, host = '127.0.0.1', opts = {}) {
  const base = normalizeBase(opts.base || '/');
  const proxy = opts.proxy && typeof opts.proxy === 'object' ? opts.proxy : {};
  const indexPath = path.join(dir, 'index.html');
  const rootDir = path.resolve(dir);
  // `hydra preview` serves a frozen artifact: a busy port means the build is
  // still correct but there is nothing to serve it on. Silently staying up
  // holding no port is what let a process manager restart the whole thing
  // forever, so the caller decides — preview exits, dev walks to the next port.
  const allowPortFallback = opts.portFallback === true;
  const portTries = allowPortFallback ? 10 : 1;
  const startedAt = Date.now();
  let actualPort = port;

  // Per-IP rate limiting:
  // Enabled via `server.rateLimit: true` or `server.rateLimit: { windowMs, max }`.
  const rateLimitCfg = (() => {
    const raw = opts.rateLimit;
    if (!raw) return null;
    if (raw === true) return { windowMs: 60000, max: 120 };
    if (typeof raw === 'object') {
      const windowMs = Number.isInteger(raw.windowMs) && raw.windowMs >= 1000 ? raw.windowMs : 60000;
      const max = Number.isInteger(raw.max) && raw.max >= 1 ? raw.max : 120;
      return { windowMs, max };
    }
    return null;
  })();

  const rateLimitState = rateLimitCfg ? new Map() : null;

  const server = http.createServer(async (req, res) => {
    // Set once, here, rather than at each of the eight `writeHead` sites below.
    // Only the file-serving path used to carry these, so every error, API,
    // action and data answer shipped without them — and those are the answers
    // most likely to echo something a caller supplied. `writeHead` merges with
    // what is already set, so a path that wants a different value still can.
    for (const [name, value] of Object.entries(baseHeaders())) res.setHeader(name, value);

    if (rateLimitCfg && rateLimitState) {
      const clientIp =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        '127.0.0.1';
      const now = Date.now();
      let record = rateLimitState.get(clientIp);
      if (!record || now >= record.resetAt) {
        record = { count: 0, resetAt: now + rateLimitCfg.windowMs };
        rateLimitState.set(clientIp, record);
      }
      record.count += 1;
      if (record.count > rateLimitCfg.max) {
        const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
        res.writeHead(429, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': String(retryAfter),
        });
        res.end('Too Many Requests');
        return;
      }
    }

    const rawUrl = req.url || '/';
    const queryAt = rawUrl.indexOf('?');
    const rawPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);

    let reqPath;
    try {
      reqPath = decodeURIComponent(rawPath);
    } catch {
      // A malformed percent-escape is a bad request, not a crash.
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    // The API layer first: `src/api` is part of the project, and the SPA
    // fallback below would otherwise answer `/api/hello` with index.html and a
    // 200 — a JSON endpoint that answers HTML is worse than one that is
    // missing, because the client's `.json()` fails with a parse error that
    // says nothing about the real problem.
    //
    // It is checked BEFORE the proxy because the proxy exists for a backend
    // this build does not own, and a project that wrote `src/api/hello.hys`
    // has said it owns `/api/hello`. Overlap between the two is reported at
    // startup by the caller rather than resolved silently here.
    //
    // Scope, stated plainly: middleware runs for requests that reach the API
    // layer, which is `/api` and below. It does not run for a static file, and
    // that is not an omission — a static host has no middleware, so pretending
    // otherwise would make dev and production disagree about `/about`.
    if (opts.api && (reqPath === '/api' || reqPath.startsWith('/api/'))) {
      // The return value is load-bearing: `false` means middleware passed and
      // no handler matched, and the 404 below still has to be written. Calling
      // this and returning unconditionally left the request hanging with no
      // response at all — a timeout, which reads as "the server is down".
      const answered = await handleApiRequest(req, res, rawUrl, opts.api, {
        bodyLimit: opts.bodyLimit,
      });
      if (answered) return;
    }

    // Proxy first. `/api/...` is a route the app expects a backend to answer,
    // and the SPA fallback below would otherwise hand it index.html with a 200.
    const target = matchProxy(proxy, reqPath);
    if (target) {
      proxyRequest(req, res, target, reqPath, rawUrl);
      return;
    }

    // A form POST to a route with an `action`. Answered before the static
    // handler, because the alternative is serving index.html to a POST, which
    // "succeeds" and does nothing.
    if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') && opts.actions) {
      handleAction(req, res, reqPath, rawUrl, opts.actions, { bodyLimit: opts.bodyLimit });
      return;
    }

    // Every process on a box has one of these, and "something is on 5173"
    // otherwise has no answer. Cheap enough to answer on every request, and
    // something a supervisor can health-check without guessing from the port.
    //
    // OFF by default, and it never carries absolute paths. The server binds
    // 0.0.0.0 unless configured otherwise, so this answered ANY host on the
    // network with the absolute path of the project directory and its config
    // file — a map of the developer's disk, on an unauthenticated port. A
    // health check only needs to know the process is up; the project layout is
    // for the person sitting at the machine, who can read it off the terminal.
    if (reqPath === '/__hydra/version' || reqPath === '/__hydra/healthz') {
      const base = {
        name: 'hydra',
        status: 'ok',
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
      };
      const detail =
        opts.metadata === true
          ? { ...base, version: opts.version || null, sha: opts.sha || null, port: actualPort, host }
          : base;
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        // A health check is read by a monitor, and a cached "ok" answers for a
        // server that is down.
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(detail));
      return;
    }

    // The data endpoint a client-side navigation uses. Answered before static
    // resolution because it is a virtual path, not a file, and the SPA fallback
    // would otherwise hand it index.html with a 200 — a JSON endpoint that
    // answers HTML is worse than one that is missing.
    if (reqPath === '/__hydra/data' && opts.ssr) {
      handleDataRequest(req, res, opts.ssr, rawUrl).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
      });
      return;
    }

    // A route the API layer does not have is a 404, not index.html. The layer
    // above only answers when a handler matched, so `/api/nope` would otherwise
    // fall through to the SPA shell and return HTML with a 200 to a client that
    // asked for JSON.
    if (opts.api && (reqPath === '/api' || reqPath.startsWith('/api/'))) {
      sendError(res, 404, 'api_route_not_found', `no API route for ${req.method} ${reqPath}`, {
        hint:
          'src/api/**/*.hys exports one function per HTTP method (get, post, put, patch, delete); ' +
          'a folder is a URL segment and [id] is a parameter',
      });
      return;
    }

    // The base is part of the public URL, not of the directory layout: with
    // `base: "/sub/"` a request for `/sub/assets/x.js` is `assets/x.js` here.
    let urlPath = reqPath;
    if (!isRemoteBase(base) && base !== '/' && urlPath.startsWith(base)) {
      urlPath = urlPath.slice(base.length - 1);
    }

    // `path.resolve` on the joined path, plus a containment check, so `..` in a
    // URL cannot walk out of the directory being served.
    let filePath = path.resolve(rootDir, '.' + (urlPath.startsWith('/') ? urlPath : '/' + urlPath));
    if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    // Any dotfile is private: `.hydra-build.json` is the esbuild metafile, which
    // lists every module in the graph, its size and its dependencies. It is in
    // `dist/` because `hydra analyze` reads it there, and it must not be on the
    // public internet — a build artifact that describes the build is free
    // reconnaissance, and it is never something a visitor asked for.
    const publicName = path.basename(reqPath);
    if (publicName.startsWith('.')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    let exists = fs.existsSync(filePath);
    if (exists && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      exists = fs.existsSync(filePath);
    }

    if (!exists) {
      const isNavigation = req.method === 'GET' || req.method === 'HEAD';
      // A request that asked for a FILE (`/assets/app.js`, `/logo.png`) is not
      // a navigation, and answering it with index.html and a 200 is how a stale
      // deploy turns into a blank page: the browser refuses to execute HTML as
      // a module with a MIME error that names nothing useful, and an <img>
      // silently renders broken with no 404 anywhere in the logs.
      const wantsHtml = /text\/html|\*\/\*/.test(String(req.headers.accept || ''));
      const hasExtension = path.extname(reqPath) !== '';
      // Decided BEFORE the SSR block, because a missing asset must not be
      // rendered as a page even when the client sent `Accept: text/html`.
      // `*.html` stays eligible: a host may serve one by name.
      if (hasExtension && path.extname(reqPath).toLowerCase() !== '.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Not Found: ${reqPath}`);
        return;
      }

      // A route the static build could not write: `/blog/[slug]` has no single
      // URL, so there is no file for `/blog/hello`. Rendering it here is what
      // makes a reload and a crawler see the page instead of the shell.
      //
      // Before the SPA fallback, because the shell is the WORSE answer: it is
      // correct-looking HTML that only becomes content after JavaScript runs,
      // and a crawler does not run JavaScript.
      if (isNavigation && opts.ssr && opts.ssr.available) {
        try {
          // The FULL url, query included: a loader that reads `?tab=info` and
          // the client that reads the same must be given the same string, or
          // the server renders one value and hydration uses another.
          const out = await opts.ssr.renderPage(rawUrl, {
            request: requestFor(req, rawUrl, ''),
          });
          if (out && out.intent) {
            // A loader redirected or refused. That is an HTTP answer, not a
            // page: sending the page instead produced a 200 with a blank body.
            sendHttpIntent(res, out.intent);
            return;
          }
          // Streaming first: the shell goes out as soon as it is ready and the
          // rest follows, so a slow loader does not hold a blank document. It
          // falls back to the buffered page when the renderer cannot stream
          // (no renderToPipeableStream, or a shell with no root element), and
          // `renderPage` is then the answer — never both, because two flushes
          // would append one document to another.
          const streamed = opts.ssr.renderPageStream
            ? await opts.ssr.renderPageStream(rawUrl, {
                request: requestFor(req, rawUrl, ''),
              })
            : null;
          if (streamed && streamed.intent) {
            sendHttpIntent(res, streamed.intent);
            return;
          }
          if (streamed && streamed.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              ...baseHeaders(),
              'Cache-Control': 'no-store',
              // Chunked, explicitly: a Content-Length would promise a size this
              // response does not know until the last boundary resolves.
              'Transfer-Encoding': 'chunked',
            });
            streamed.stream.pipe(res);
            streamed.stream.on('error', (err) => {
              console.error(`[hydra] SSR stream failed for ${reqPath}: ${err.message || err}`);
              res.destroy(err);
            });
            return;
          }
          const out2 = streamed ? null : await opts.ssr.renderPage(rawUrl, {
            request: requestFor(req, rawUrl, ''),
          });
          if (out2 && out2.intent) {
            sendHttpIntent(res, out2.intent);
            return;
          }
          if (out2) {
            const body = opts.injectHtml ? opts.injectHtml(out2.document) : out2.document;
            // Rendered per request, so it must never be cached: the same URL can
            // answer differently for two visitors.
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              ...baseHeaders(),
              'Cache-Control': 'no-store',
            });
            res.end(body);
            return;
          }
          // Matched nothing. The project's own `_404` is the right body, and
          // 404 is the right status — for the HTML the browser hydrates, so
          // the client sees the same thing the server rendered.
          const notFound = await opts.ssr.renderNotFound(rawUrl);
          if (notFound) {
            const body = opts.injectHtml ? opts.injectHtml(notFound.document) : notFound.document;
            res.writeHead(404, {
              'Content-Type': 'text/html; charset=utf-8',
              ...baseHeaders(),
              'Cache-Control': 'no-store',
            });
            res.end(body);
            return;
          }
        } catch (err) {
          // A page that throws while rendering server-side still reaches the
          // browser, where React can show the route's error boundary — but the
          // shell it gets must SAY that, because a bare shell is a blank page
          // with no explanation anywhere the developer is looking. "Why is my
          // page empty" is the question this answers.
          const message = err && err.message ? err.message : String(err);
          const detail = err && err.loaderStack ? `${message}\n\n${err.loaderStack}` : message;
          console.error(`[hydra] SSR failed for ${reqPath}: ${message}`);
          try {
            const shell = fs.readFileSync(indexPath, 'utf8');
            const shown = opts.injectHtml
              ? opts.injectHtml(shell)
              : shell;
            const notice =
              `<div id="__hydra_ssr_error" style="font:14px/1.5 ui-monospace,monospace;` +
              `padding:16px;margin:16px;border:1px solid #cf2d56;border-radius:8px;` +
              `background:#fff5f7;color:#3a1a22;white-space:pre-wrap">` +
              `hydra: the server could not render ${escapeHtml(reqPath)}\n\n${escapeHtml(detail)}` +
              `</div>`;
            const withNotice = shown.includes('<div id="root"></div>')
              ? shown.replace('<div id="root"></div>', `<div id="root">${notice}</div>`)
              : shown;
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(withNotice);
            return;
          } catch (shellErr) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`hydra: SSR failed for ${reqPath}\n\n${detail}`);
            return;
          }
        }
      }

      // SPA fallback: react-router, TanStack Router and friends own every path
      // that is not a file, and a reload on /dashboard/settings has to reach
      // the app rather than a 404 page. Guarded by `wantsHtml` so an XHR that
      // happens to have no extension is never handed a page.
      if (!isNavigation || !wantsHtml || !fs.existsSync(indexPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      filePath = indexPath;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Headers for a built FILE. HTML is the one thing that must revalidate: it
    // names the hashed assets, so a cached document pins a visitor to the
    // previous release. A hashed asset is immutable by construction.
    const hasHash = /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(path.basename(filePath));
    const fileHeaders = {
      ...baseHeaders(),
      ...cacheHeaders(ext, hasHash),
      ...(opts.headers && typeof opts.headers === 'object' ? opts.headers : {}),
    };

    // An HTML file gets the dev-only transform, if the caller asked for one.
    // `hydra dev` uses it for the live-reload client; `preview` does not, because
    // a preview should be what production serves.
    if (opts.injectHtml && ext === '.html') {
      const html = opts.injectHtml(fs.readFileSync(filePath, 'utf8'));
      res.writeHead(200, { 'Content-Type': contentType, ...fileHeaders });
      res.end(html);
      return;
    }

    // Text assets are compressed when the client asked for it. Measured on a
    // real build: 508.900 bytes of JSON became 3.200 gzipped, and a page's JS
    // pays the same tax on a slow link. `no-transform` is not set, so a proxy is
    // free to do it better.
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const compressible = /^text\/|javascript|json|svg/.test(contentType) && !ext.match(/^\.(png|jpe?g|gif|webp|avif|woff2?|mp4|webm)$/);
    if (acceptsGzip && compressible) {
      const raw = fs.readFileSync(filePath);
      // Below ~1 KB the header costs more than the saving; above it, gzip wins.
      if (raw.length > 1024) {
        const gz = zlib.gzipSync(raw, { level: 6 });
        res.writeHead(200, {
          'Content-Type': contentType,
          ...fileHeaders,
          'Content-Encoding': 'gzip',
          Vary: 'Accept-Encoding',
          'Content-Length': gz.length,
        });
        res.end(gz);
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': contentType, ...fileHeaders });
    fs.createReadStream(filePath).pipe(res);
  });

  // Without a handler this raises an unhandled 'error' event, which kills the
  // whole process — taking the file watcher with it, so `hydra dev` died with
  // a stack trace and no rebuilds the moment the port was busy. An empty port
  // is a normal thing to hit (another dev server, a stray preview).
  //
  // The listener now settles a promise instead of only printing, so a caller
  // can tell "serving on 5174" from "gave up". Callers that need a server to
  // exist (a supervisor) reject; `dev` walks the next nine ports and only
  // complains when they are all gone.
  return new Promise((resolve, reject) => {
    let tries = 0;

    if (rateLimitState) {
      const pruneTimer = setInterval(() => {
        const now = Date.now();
        for (const [ip, record] of rateLimitState) {
          if (now >= record.resetAt) rateLimitState.delete(ip);
        }
      }, Math.max(5000, rateLimitCfg.windowMs)).unref();
      server.on('close', () => clearInterval(pruneTimer));
    }

    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && tries + 1 < portTries) {
        tries += 1;
        actualPort = port + tries;
        console.error(
          `[hydra] Port ${actualPort - 1} is already in use, trying ${actualPort}.`,
        );
        server.listen(actualPort, host);
        return;
      }
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[hydra] Port ${port} is already in use. Stop the other process, or set ` +
          `"server": { "port": <other> } in hydraconfig.json.`,
        );
      } else {
        console.error(`[hydra] Server error: ${err.message}`);
      }
      // A server that is not listening is not a served site: exit non-zero so a
      // process manager sees a real failure instead of restarting a corpse.
      reject(new Error(err.code === 'EADDRINUSE' ? 'EADDRINUSE' : err.message));
    };

    server.on('error', onError);
    server.on('listening', () => {
      server.removeListener('error', onError);
      server.on('error', (err) => {
        console.error(`[hydra] Server error: ${err.message}`);
      });
      // Say WHICH interface. Printing `localhost` for a 0.0.0.0 bind is how a
      // server stayed reachable from the network with nobody aware of it.
      const reach =
        host === '0.0.0.0' || host === '::'
          ? `http://${localIPv4() ?? 'localhost'}:${actualPort}/  (reachable from your network)`
          : `http://${host}:${actualPort}/`;
      if (!opts.quiet) console.log(`[hydra] Server running at ${reach}`);
      resolve({ server, port: actualPort });
    });

    server.listen(actualPort, host);
  });
}

export async function runPreview(cwd = process.cwd(), opts = {}) {
  // `.env` again, because `preview` is a separate process from the build that
  // produced the artifact and `env()` reads `process.env` at call time.
  loadProjectEnv(cwd);
  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const port = opts.port || config.server?.port || 5173;
  const host = opts.host || config.server?.host || '127.0.0.1';
  const indexPath = path.join(outDir, 'index.html');

  if (!fs.existsSync(outDir) || !fs.existsSync(indexPath)) {
    console.log('[hydra] Output directory or index.html not found. Running build first...');
    // Rebuild with the target this project used last time, so `preview` after
    // deleting `dist/` does not silently downgrade a node project to static and
    // then report its own API routes as missing.
    await runBuild(cwd, { target: opts.target || readBuildRecord(cwd).target });
  }

  // The server bundle renders the routes the static build could not write.
  // `preview` is meant to be what production serves, so it renders them here
  // for the same reason the real server would.
  const renderer = await createRenderer({
    cwd,
    bundlePath: path.join(cwd, SERVER_BUNDLE),
    shellPath: indexPath,
  });
  if (!renderer.available && config.rendering?.ssr !== false) {
    // Not fatal: a project with no dynamic routes has nothing to render, and
    // saying so on every preview would be noise. Say it once, plainly.
    console.log(`[hydra] SSR off: ${renderer.reason}`);
  }

  console.log('[hydra] Previewing production build:');
  // The API routes are mounted only when the artifact was built for the node
  // target. Mounting them from a static build would show a working app here and
  // a 404 after deploy — the exact gap `--target static` prints a warning
  // about, and it would be dishonest to paper over it in preview.
  const buildTarget = readBuildRecord(cwd).target || 'static';
  const apiForPreview = buildTarget === 'node' ? readApiBundle(cwd) : null;
  if (buildTarget !== 'node' && (scanApiRoutes(cwd).routes.length > 0 || fs.existsSync(path.join(cwd, MIDDLEWARE_FILE)))) {
    console.log(
      '[hydra] preview: this build is `--target static`, so src/api is not served. ' +
        'Rebuild with `hydra build --target node` to preview the API.',
    );
  }
  await serveDirectory(outDir, port, host, {
    base: normalizeBase(config.base),
    proxy: config.server?.proxy,
    actions: readActionBundle(cwd),
    ssr: renderer.available ? renderer : null,
    api: apiForPreview,
    bodyLimit: config.server?.bodyLimit,
    rateLimit: config.server?.rateLimit,
    version: opts.version,
    sha: opts.sha,
    configPath: path.join(cwd, 'hydraconfig.json'),
  });
}

export async function runDev(cwd = process.cwd(), opts = {}) {
  // Two flags, and they mean different things.
  //
  // `NODE_ENV` is what LIBRARIES branch on at bundle time — React turns its dev
  // warnings and `act()` guards on with it — and `hydra dev` promises those.
  // `HYDRA_DEV` is what THIS toolchain branches on: it decides whether the
  // generated API/action bundles are re-required per request. They used to be
  // one variable's worth of behaviour spread over two places, so production
  // re-parsed its server bundle on every request (93 req/s instead of 1.258).
  process.env.NODE_ENV = 'development';
  process.env.HYDRA_DEV = '1';

  // Build first then serve with auto rebuild
  await runBuild(cwd, { dev: true });
  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const port = opts.port || config.server?.port || 5173;
  // Loopback by default. `hydra dev` is a local development command and it was
  // binding every interface, so on any machine without a host firewall — a
  // laptop on cafe wifi — the project directory was served to the whole network,
  // with the metadata endpoint answering the absolute path to anyone who asked.
  // Reachability is a deliberate choice: `--host 0.0.0.0`, or `server.host` in
  // hydraconfig.json, and the startup line says which one is in effect.
  const host = opts.host || config.server?.host || '127.0.0.1';

  const renderer = await createRenderer({
    cwd,
    bundlePath: path.join(cwd, SERVER_BUNDLE),
    shellPath: path.join(outDir, 'index.html'),
  });

  console.log('[hydra] Development mode active.');
  const served = await serveDirectory(outDir, port, host, {
    base: normalizeBase(config.base),
    proxy: config.server?.proxy,
    // Re-read on every dev build, because the bundle is regenerated per build.
    actions: readActionBundle(cwd),
    // `dev` is always the node target: a dev server that dropped `src/api`
    // would make the feature impossible to develop. The static target exists
    // for the artifact, not for the loop.
    api: readApiBundle(cwd),
    ssr: renderer.available ? renderer : null,
    bodyLimit: config.server?.bodyLimit,
    rateLimit: config.server?.rateLimit,
    // The dev server injects the HMR client into every HTML response, because
    // the build wrote the file and the page has to reach the browser with it.
    injectHtml: (html) => injectHmrClient(html),
    // A dev server is meant to be reachable; a taken port is normal and the
    // right answer is the next one, not a dead terminal.
    portFallback: true,
    version: opts.version,
    sha: opts.sha,
    configPath: path.join(cwd, 'hydraconfig.json'),
  });

  // Live reload. The rebuild already happened on every save; this is the part
  // that tells the browser, and the overlay for the case where it did not.
  const hmr = served && served.server ? attachSocketServer(served.server) : null;

  // Watch src/ directory for changes
  const srcDir = path.join(cwd, 'src');
  if (fs.existsSync(srcDir)) {
    let building = false;
    // A save fires several watch events; the last one is the one that matters,
    // so the rebuild is debounced rather than run per event.
    let timer = null;
    const rebuild = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (building) return;
        building = true;
        try {
          await runBuild(cwd, { dev: true });
          // A successful dev rebuild asks the client to REFRESH (swap the
          // component implementations in place), not to reload. A full reload
          // resets every component's state, which is the whole difference between
          // live reload and Fast Refresh. `ok` remains the message for a plain
          // reload, used when the client cannot refresh (no registry, a bundle
          // that failed to re-import).
          if (hmr) hmr.broadcast(JSON.stringify({ type: 'refresh' }));
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          console.error('[hydra] Build error:', message);
          // The last good build stays. Reloading into a broken bundle would take
          // away the working page the developer was looking at.
          if (hmr) hmr.broadcast(JSON.stringify({ type: 'error', message }));
        } finally {
          building = false;
        }
      }, 60);
    };
    fs.watch(srcDir, { recursive: true }, rebuild);

    // `.env` is watched too, and separately, because it lives at the project
    // root: editing it is editing what the client bundle inlines and what the
    // server reads, and a change that only takes effect after a restart is a
    // change nobody believes happened. `watchFile` polls the inode, which is
    // what makes it survive the replace-on-save an editor does — `fs.watch` on
    // a file stops firing the first time that happens.
    const envFile = path.join(cwd, '.env');
    if (fs.existsSync(envFile)) {
      fs.watchFile(envFile, { interval: 300 }, (cur, prev) => {
        if (cur.mtimeMs === prev.mtimeMs) return;
        console.log('[hydra] .env changed — rebuilding');
        rebuild();
      });
    }
  }
}

/**
 * `hydra run script.hys` — execute a script.
 *
 * The binary used to hand the compiled source straight to `node -`, which
 * cannot resolve the `hydra` specifier: the compiler emits
 * `import { raise_ } from 'hydra'` and node has no idea what that is. So a
 * script that used any runtime helper died with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'hydra'` — while the README
 * documents importing from `hydra`.
 *
 * Bundling it here fixes that the same way the build does, with the same
 * plugins: one resolver, not a second one that can drift.
 */
export async function runScript(cwd, file, scriptArgs = []) {
  const abs = path.resolve(cwd, file);
  if (!fs.existsSync(abs)) {
    console.error(`[hydra] cannot read ${file}`);
    return 1;
  }
  const config = readConfig(cwd);
  const pkgRoot = path.resolve(HERE, '../..');
  const { esbuild } = await loadBundlerDeps(cwd);

  const pkgNodeModules = path.join(pkgRoot, 'node_modules');
  const outfile = path.join(os.tmpdir(), `hydra-run-${process.pid}-${Date.now()}.mjs`);
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      write: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile,
      jsx: 'automatic',
      logLevel: 'silent',
      resolveExtensions: ['.hys', '.hyx', '.hsx', '.hs', '.mjs', '.js', '.jsx', '.ts', '.tsx', '.json'],
      nodePaths: [path.join(cwd, 'node_modules'), pkgNodeModules],
      plugins: [
        runtimeSpecifierPlugin({
          hydra: path.join(pkgRoot, 'runtime', 'hydra.ts'),
          'hydra/server': path.join(pkgRoot, 'runtime', 'server.ts'),
          'hydra/client': path.join(pkgRoot, 'runtime', 'client.ts'),
        }),
        createHydraEsbuildPlugin(),
        routesEsbuildPlugin(scanRoutesSafe(cwd, config), { base: '/', cwd }),
      ],
    });
  } catch (err) {
    if (!err || !err.errors) throw err;
    for (const e of err.errors) {
      const where = e.location ? `${e.location.file}:${e.location.line}:${e.location.column}: ` : '';
      console.error(`${where}${e.text}`);
    }
    return 1;
  }

  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [outfile, ...scriptArgs], {
      cwd,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      try {
        fs.rmSync(outfile, { force: true });
      } catch {}
      resolve(code || 0);
    });
  });
}

/** The route table, or an empty one — never a throw from a script runner. */
function scanRoutesSafe(cwd, config) {
  try {
    const dir = pagesDirectory(cwd, config);
    if (!dir) return EMPTY_ROUTES;
    return scanRoutes(dir);
  } catch {
    return EMPTY_ROUTES;
  }
}

/**
 * `hydra test [path]` — run the project's component tests.
 *
 * Bundles each `*.test.hys` with the same resolver, plugins and compiler the
 * build uses, runs it in its own node process, and reports what the file
 * printed. Exit code 1 if any test failed, so CI needs no parsing.
 */
export async function runTests(cwd = process.cwd(), opts = {}) {
  const config = readConfig(cwd);
  const pkgRoot = path.resolve(HERE, '../..');

  let files;
  if (opts.pattern) {
    const abs = path.resolve(cwd, opts.pattern);
    files = fs.existsSync(abs) && fs.statSync(abs).isFile() ? [abs] : findTestFiles(abs);
    if (files.length === 0) {
      console.error(`[hydra] no test files under ${opts.pattern}`);
      return 1;
    }
  } else {
    const root = testRoot(cwd, config);
    if (!root) {
      console.error(
        '[hydra] no test files found. Put them in tests/, next to the code, or at the root, named `*.test.hys`.',
      );
      return 1;
    }
    files = findTestFiles(root);
  }

  const { esbuild } = await loadBundlerDeps(cwd);
  const routesTable = (() => {
    try {
      const dir = pagesDirectory(cwd, config);
      return dir ? scanRoutes(dir) : EMPTY_ROUTES;
    } catch {
      return EMPTY_ROUTES;
    }
  })();

  const plugins = [
    runtimeSpecifierPlugin({
      hydra: path.join(pkgRoot, 'runtime', 'hydra.ts'),
      'hydra/server': path.join(pkgRoot, 'runtime', 'server.ts'),
      'hydra/client': path.join(pkgRoot, 'runtime', 'client.ts'),
      'hydra/test': path.join(pkgRoot, 'runtime', 'test.ts'),
    }),
    createHydraEsbuildPlugin(),
    // ONE instance of the test runtime, whichever module asks for it.
    //
    // Both the harness and the test file import `hydra/test`. Bundled
    // separately that is two module instances with two `results` arrays and two
    // `pending` queues — the harness would wait on a queue the test file never
    // pushed to, and every test reported "did not run". The runtime is the
    // shared state of a test run, so it has to be shared.
    {
      name: 'hydra-test-single-runtime',
      setup(build) {
        build.onResolve({ filter: /^hydra\/test$/ }, () => ({
          path: path.join(pkgRoot, 'runtime', 'test.ts'),
        }));
      },
    },
    routesEsbuildPlugin(routesTable, { base: normalizeBase(config.base), cwd }),
  ];

  const { file: snapFile, data: snapshots } = readSnapshots(cwd);
  // INSIDE the project, not in os.tmpdir().
  //
  // The bundle keeps react/react-dom external so node resolves them natively
  // (bundling React's CommonJS into ESM breaks on `require("stream")`). A bare
  // specifier resolves relative to the FILE, so a bundle in /tmp finds no
  // `react` — it has to sit under the project whose node_modules has it.
  // `.hydra/` is gitignored and already holds generated artifacts.
  const tmpDir = path.join(cwd, '.hydra', 'tests');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const outfile = path.join(tmpDir, 'bundle.mjs');
  // The snapshot file is written by the CHILD process, so it needs a path it can
  // reach; the parent re-reads it afterwards.
  const snapWork = path.join(tmpDir, 'snapshots.json');
  fs.writeFileSync(snapWork, JSON.stringify(snapshots, null, 2), 'utf8');

  let passed = 0;
  let failed = 0;
  const failures = [];

  try {
    for (const file of files) {
      const rel = path.relative(cwd, file);
      try {
        await bundleTest(esbuild, file, {
          cwd,
          pkgRoot,
          plugins,
          outfile,
        });
      } catch (err) {
        failed += 1;
        const detail =
          err && err.errors
            ? err.errors
                .map((e) => `${e.location ? `${path.relative(cwd, e.location.file)}: ` : ''}${e.text}`)
                .join('\n')
            : err.message || String(err);
        console.error(`FAIL ${rel}\n  = the test file does not compile:\n${indent(detail, '  ')}`);
        failures.push(rel);
        continue;
      }

      const out = await runBundle(outfile, {
        HYDRA_TEST_FILE: rel,
        HYDRA_TEST_SNAPSHOTS: snapWork,
        HYDRA_TEST_STORE: snapWork,
      });
      if (process.env.HYDRA_TEST_DEBUG) {
        console.error(`[dbg] ${rel}: code=${out.code}\nSTDOUT=${out.stdout.slice(-800)}\nSTDERR=${out.stderr.slice(0, 400)}`);
      }
      const results = parseTestOutput(out.stdout);

      if (!results) {
        // No results block means the file threw before reporting. Its stderr is
        // the whole story and must not be swallowed.
        failed += 1;
        console.error(`FAIL ${rel} — the file exited ${out.code} without reporting tests`);
        const detail = (out.stderr || out.stdout || '').trim();
        if (detail) console.error(indent(detail, '  '));
        failures.push(rel);
        continue;
      }

      for (const r of results) {
        if (r.ok) {
          passed += 1;
          console.log(`ok   ${rel} › ${r.name} (${r.ms}ms)`);
        } else {
          failed += 1;
          failures.push(rel);
          console.log(`FAIL ${rel} › ${r.name}`);
          console.log(indent(String(r.error || '').split('\n').slice(0, 12).join('\n'), '  '));
        }
      }
      if (out.stderr && out.stderr.trim() && results.every((r) => r.ok)) {
        // A test can pass and still log. Say so without failing the run.
        console.log(indent(out.stderr.trim().split('\n').slice(0, 6).join('\n'), '  '));
      }
    }
  } finally {
    // Read the snapshots the child processes wrote BEFORE removing the directory
    // they live in. Reading after the `rmSync` meant an empty diff and a
    // snapshot that was never saved — the kind of bug a green run hides
    // indefinitely.
    try {
      if (fs.existsSync(snapWork)) {
        const after = JSON.parse(fs.readFileSync(snapWork, 'utf8'));
        if (JSON.stringify(after) !== JSON.stringify(snapshots)) {
          writeSnapshots(snapFile, after);
          const changed = Object.keys(after).filter((k) => snapshots[k] !== after[k]).length;
          console.log(`[hydra] ${changed} snapshot(s) written to ${path.relative(cwd, snapFile)}`);
        }
      }
    } catch (e) {
      console.error(`[hydra] could not save snapshots: ${e.message}`);
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(
    `[hydra] ${passed} passed, ${failed} failed (${files.length} file${files.length === 1 ? '' : 's'})`,
  );
  return failed === 0 ? 0 : 1;
}

/** Indent every line of `text` by `pad`. */
function indent(text, pad) {
  return String(text)
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

/**
 * `hydra lsp` — run the language server on stdio.
 *
 * `hydra-lsp` is the same thing under the name the editor configs use; both
 * spellings dispatch here.
 */
export async function runLsp(cwd = process.cwd()) {
  const { serve } = await import('./lsp.mjs');
  const config = readConfig(cwd);
  void config;
  return await serve(process.stdin, process.stdout, { version: VERSION });
}

// CLI entrypoint
const argv = process.argv.slice(2);
const cmd = argv[0] || 'dev';

// `--port` is the escape hatch for a taken port: editing hydraconfig.json to
// try a second port is a poor answer when you just want a server now. The value
// is also accepted as `--port=NNNN`.
let portOverride;
const portIdx = argv.findIndex((a) => a === '--port' || a.startsWith('--port='));
if (portIdx !== -1) {
  const raw = argv[portIdx].includes('=') ? argv[portIdx].split('=')[1] : argv[portIdx + 1];
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[hydra] --port needs a number between 1 and 65535, got ${raw ?? '(nothing)'}`);
    process.exit(1);
  }
  portOverride = n;
}

// Same shape for `--host`, so the default below can actually be overridden from
// the command line when the dev server is meant to be reachable from a phone or
// a container. `--host 0.0.0.0` restores the old behaviour, explicitly.
let hostOverride;
const hostIdx = argv.findIndex((a) => a === '--host' || a.startsWith('--host='));
if (hostIdx !== -1) {
  hostOverride = argv[hostIdx].includes('=') ? argv[hostIdx].split('=')[1] : argv[hostIdx + 1];
}

// `--target` for `build`. Two values, validated here so the error names the
// command line rather than surfacing as a confusing path inside the build.
let targetOverride;
const targetIdx = argv.findIndex((a) => a === '--target' || a.startsWith('--target='));
if (targetIdx !== -1) {
  const raw = argv[targetIdx].includes('=') ? argv[targetIdx].split('=')[1] : argv[targetIdx + 1];
  if (raw !== 'node' && raw !== 'static') {
    console.error(
      `[hydra] --target must be "node" or "static", got ${raw === undefined ? '(nothing)' : `"${raw}"`}. ` +
        `There are deliberately only two.`,
    );
    process.exit(1);
  }
  targetOverride = raw;
}

// Which compiler is actually talking. A supervisor or a person debugging a
// stray server needs this, and it is the one fact that goes missing when a
// checkout is stale.
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
})();

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.join(HERE, '..', '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * The project directory, as a POSITIONAL argument.
 *
 * `hydra build examples/blog` used to ignore the word `examples/blog` entirely
 * and build `process.cwd()`. In a directory with no project that meant the
 * native compiler was handed the path as a FILE, compiled nothing, and printed
 * `OK: compiled 0 file(s)` with exit 0 — a command that reports success while
 * doing nothing is worse than one that fails, because nobody looks at it twice.
 *
 * The commands that take a directory are the ones whose whole job is a project.
 * `dev`, `preview` and `serve` stay on cwd: they own a port and a session, and
 * a positional path there was never documented.
 */
const positionalDir = (() => {
  const takesDir = new Set(['build', 'routes', 'analyze', 'stats', 'doctor', 'init', 'clean']);
  if (!takesDir.has(cmd)) return null;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a || a.startsWith('-')) continue;
    // Skip a value that belongs to a flag we know takes one.
    if (rest[i - 1] === '--port' || rest[i - 1] === '--host' || rest[i - 1] === '--target') continue;
    return a;
  }
  return null;
})();

const cwd = positionalDir ? path.resolve(process.cwd(), positionalDir) : process.cwd();

if (positionalDir && !fs.existsSync(cwd)) {
  console.error(`[hydra] ${cmd}: no such directory: ${positionalDir}`);
  process.exit(1);
}
if (positionalDir && !fs.existsSync(path.join(cwd, 'hydraconfig.json'))) {
  // A missing config is legal (defaults apply), but a directory that holds no
  // project at all is almost always a typo, and building it silently is how the
  // old behaviour wasted a person's afternoon.
  const hasSource = fs.existsSync(path.join(cwd, 'src'));
  if (!hasSource) {
    console.error(`[hydra] ${cmd}: ${positionalDir} has no hydraconfig.json and no src/ — not a project`);
    process.exit(1);
  }
}

const runOpts = { port: portOverride, host: hostOverride, version: VERSION, sha: gitSha(), target: targetOverride };

// Only act when this file IS the program. Importing the runner used to start a
// dev server as a side effect, which made the server behaviour untestable.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (!invokedDirectly) {
  // imported as a library: exports only
} else if (cmd === 'dev') {
  runDev(cwd, runOpts).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cmd === 'run') {
  const file = argv.slice(1).find((a) => !a.startsWith('-'));
  if (!file) {
    console.error('[hydra] run requires a script file (e.g. hydra run script.hys)');
    process.exit(2);
  }
  const at = argv.indexOf(file);
  const rest = argv.slice(at + 1);
  runScript(cwd, file, rest)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    });
} else if (cmd === 'test') {
  const pattern = argv.slice(1).find((a) => !a.startsWith('-'));
  runTests(cwd, { pattern })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    });
} else if (cmd === 'lsp' || cmd === 'hydra-lsp' || cmd === 'language-server') {
  runLsp(cwd)
    .then((code) => process.exit(code || 0))
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    });
} else if (cmd === 'build') {
  runBuild(cwd, { target: targetOverride }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === 'routes') {
  // The table, printed. Reading it out of the bundle is not an option: the
  // whole point is to answer "what does this project's folder layout mean"
  // before and independently of a build.
  const config = readConfig(cwd);
  const wantJson = argv.includes('--json');
  const dir = pagesDirectory(cwd, config);
  if (!dir) {
    if (wantJson) console.log(JSON.stringify({ root: null, routes: [] }, null, 2));
    else console.log('file-based routing is disabled ("routes": false in hydraconfig.json)');
    process.exit(0);
  }
  const table = scanRoutes(dir);
  if (wantJson) {
    console.log(JSON.stringify(routesJson(table), null, 2));
  } else {
    console.log(routeTable(table));
  }
  if (table.errors_diagnostics.length > 0) {
    console.error('\n' + table.errors_diagnostics.map((d) => `error: ${d}`).join('\n'));
    process.exit(1);
  }
} else if (cmd === 'serve' || cmd === 'start') {
  // `serve` is the deployment name; `start` is the one npm scripts reach for.
  // Both were documented in the README and neither existed in the CLI, which
  // treated the word as a file to compile and answered
  // "cannot read serve: No such file or directory".
  runServe(cwd, runOpts).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cmd === 'preview') {
  // A preview that cannot bind is a failed preview, exit 1. Staying alive
  // while serving nothing is what turned a busy port into 12,485 restarts
  // under a process manager.
  runPreview(cwd, runOpts).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  console.error(`[hydra] Unknown command: ${cmd}`);
  process.exit(1);
}
