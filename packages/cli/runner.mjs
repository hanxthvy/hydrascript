// [xihanzu-NR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const selfRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

import { writeActionBundle, bundleActions, loadActions, readBody, requestFor } from './actions.mjs';
import { attachSocketServer, injectHmrClient } from './hmr.mjs';

import {
  scanRoutes,
  writeRoutesModule,
  writeSsgEntry,
  routesEsbuildPlugin,
  routeTable,
  routesJson,
  matchRoute,
} from './router.mjs';

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


async function loadBundlerDeps(cwd) {
  const esbuildPath = resolvePkg('esbuild', cwd);
  const postcssPath = resolvePkg('postcss', cwd);
  const twPath = resolvePkg('tailwindcss', cwd);
  const apPath = resolvePkg('autoprefixer', cwd);

  const key = [esbuildPath, postcssPath, twPath, apPath].join('\u0000');
  const cached = bundlerDepsCache.get(key);
  if (cached) return cached;

  // Four independent dynamic imports, started together. Awaiting them one at a
  // time serialised module resolution and cost ~300 ms it did not have to.
  const [esbuild, postcssMod, twMod, apMod] = await Promise.all([
    import(esbuildPath),
    import(postcssPath),
    import(twPath),
    import(apPath),
  ]);
  const postcss = postcssMod.default || postcssMod;
  const tailwindcss = twMod.default || twMod;
  const autoprefixer = apMod.default || apMod;

  const deps = { esbuild, postcss, tailwindcss, autoprefixer };
  bundlerDepsCache.set(key, deps);
  return deps;
}

function findNativeAddon() {
  // No absolute paths: this file ships with the package, so anything anchored
  // to the author's home directory works on exactly one machine and silently
  // picks up a stranger's binary everywhere else.
  const candidates = [
    process.env.HYDRA_NATIVE,
    path.join(HERE, '../../bin/hydra.node'),
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

function createHydraEsbuildPlugin() {
  const native = findNativeAddon();
  // Keyed by path AND source. Keying on path alone was enough for a one-shot
  // build but not for an incremental rebuild: esbuild re-runs onLoad for a
  // file that changed, and a path-only cache would hand back the previous
  // compile for the new text. The comparison is what makes the cache safe to
  // keep across rebuilds.
  const cache = new Map();

  function compile(file, source) {
    const hit = cache.get(file);
    if (hit !== undefined && hit.source === source) return hit.res;

    let res;
    if (native) {
      res = native.compile(source, file);
    } else {
      res = cliFallbackCompile(file, source);
    }
    cache.set(file, { source, res });
    return res;
  }

  return {
    name: 'hydra-compiler-plugin',
    setup(build) {
      build.onLoad({ filter: /\.(hyx|hsx)$/ }, async (args) => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        const res = compile(args.path, source);
        if (res.error) {
          return { errors: [{ text: res.error }] };
        }
        return { contents: rewriteDynamicImports(res.code), loader: 'tsx', resolveDir: path.dirname(args.path) };
      });

      build.onLoad({ filter: /\.(hys|hs)$/ }, async (args) => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        const res = compile(args.path, source);
        if (res.error) {
          return { errors: [{ text: res.error }] };
        }
        return { contents: rewriteDynamicImports(res.code), loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
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
function injectLoaderData(html, pattern, data) {
  const payload = JSON.stringify({ pattern, data: data === undefined ? null : data })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const tag = `<script type="application/json" id="__hydra_data__">${payload}</script>`;
  if (html.includes('id="__hydra_data__"')) {
    return html.replace(/<script type="application\/json" id="__hydra_data__">[\s\S]*?<\/script>/, tag);
  }
  return html.includes('</body>') ? html.replace('</body>', `  ${tag}\n  </body>`) : html + `\n${tag}\n`;
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
  return {
    'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env.DEV': String(!isProd),
    'import.meta.env.PROD': String(isProd),
    'import.meta.env.SSR': String(ssr),
    'import.meta.env.BASE_URL': JSON.stringify(base),
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `src/index.css` through Tailwind + Autoprefixer, returned as text.
 *
 * The result is merged with the CSS esbuild extracted from the module graph
 * rather than written straight out, so the page still loads one stylesheet.
 */
async function compileTailwind(cwd, config, postcss, tailwindcss, autoprefixer) {
  const cssInPath = path.join(cwd, 'src/index.css');
  if (!fs.existsSync(cssInPath)) return null;

  const rawCss = fs.readFileSync(cssInPath, 'utf8');
  const userTailwind = config.tailwind || {};
  const twConfig = {
    ...userTailwind,
    content: Array.from(new Set([
      path.join(cwd, 'index.html'),
      path.join(cwd, 'src/**/*.{hyx,hys,hsx,hs,tsx,ts,jsx,js,mjs,html,css}'),
      ...(userTailwind.content || []),
    ])),
    theme: userTailwind.theme || { extend: {} },
    plugins: userTailwind.plugins || [],
  };

  const cssResult = await postcss([tailwindcss(twConfig), autoprefixer()]).process(rawCss, {
    from: cssInPath,
  });
  return cssResult.css;
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

  console.log(`[hydra] Building for ${mode} (Hydra native bundler)...`);

  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const assetsDir = path.join(outDir, 'assets');
  const base = normalizeBase(config.base);
  // URL prefix that corresponds to `assetsDir`. `publicPath` needs this rather
  // than `base`; see the esbuild options below.
  const assetsPublicPath = base + 'assets/';
  // Wipe the asset directory before writing into it.
  //
  // esbuild's `outdir` ACCUMULATES: it never removes output it did not write
  // this run. Content-hashed names make that look harmless, and for the entry
  // it is, because `index.html` is rewritten with the new hash every time. What
  // it broke is every DYNAMIC import: a chunk left over from a previous build
  // stays on disk and keeps its own frozen list of the chunk names that existed
  // then, so a route table resolved to a stale page chunk. That is a module
  // graph that disagrees with itself across builds, and the symptom is a
  // runtime error from code that is not in the source tree any more.
  fs.rmSync(assetsDir, { recursive: true, force: true });
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
  const serverAlias = pick('HYDRA_SERVER_PATH', path.join(runtimeDir, 'server.ts'));
  const clientAlias = pick('HYDRA_CLIENT_PATH', path.join(runtimeDir, 'client.ts'));

  // Now that esbuild is loaded, the action entry can become a runnable module.
  if (actionBundleEntry) {
    try {
      await bundleActions(esbuild, actionBundleEntry, {
        outfile: path.join(cwd, '.hydra', 'actions.cjs'),
        cwd,
        pkgRoot,
        hydraAlias,
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
        // Say what is wrong in the words that matter: not "warning", but the
        // reason a warning is fatal here.
        const detail = (res.stderr || res.stdout || '').trim();
        throw new Error(
          `[hydra] semantic check failed. These are names no runtime provides, so ` +
            `the bundle would throw in the browser instead of failing here ` +
            `(the runtime gate cannot see code a render never runs):\n${detail}\n` +
            `= fix the names above, or set HYDRA_NO_CHECK=1 to build anyway`,
        );
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
  const projectWantsSsg = config.rendering?.ssg !== false;
  const routesHaveSsg = routesTable
    ? routesTable.routes.some((r) => r.rendering !== 'csr')
    : false;
  const ssgWanted =
    projectWantsSsg && (routesHaveSsg || Boolean(routesTable)) && !opts.dev && process.env.HYDRA_NO_SSG !== '1';
  // Runtime gate: on by default for a production build, never during `dev`
  // (a browser per rebuild would make the loop unusable), and skippable.
  const gateWanted = !opts.dev && process.env.HYDRA_NO_GATE !== '1';
  const ssgEntry = ssgWanted
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
  const tailwindPromise = compileTailwind(cwd, config, postcss, tailwindcss, autoprefixer)
    .then((css) => ({ css }))
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
    // most expensive option in this call. Projects that deploy straight to a
    // server and debug from the deployed source can turn them off with
    // `"build": { "sourcemap": false }`; the default stays `true` because
    // silently dropping a debugger aid is worse than an opt-out.
    sourcemap: config.build?.sourcemap !== false,
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
      createHydraEsbuildPlugin(),
      // `hydra:routes` ALWAYS resolves, with an empty table when the project has
      // no pages directory. That is what lets the runtime import it statically:
      // a synchronous table is required for the client's first paint to match
      // the pre-rendered HTML, and a conditional module would mean a lazy path
      // that renders nothing once and then fills in — a hydration mismatch on
      // every page that was correctly pre-rendered.
      routesEsbuildPlugin(routesTable || EMPTY_ROUTES, { base, cwd }),
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
    try {
      if (!devEsbuildContext) {
        devEsbuildContext = await esbuild.context(clientBuildOptions);
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
  const tailwindOutcome = await tailwindPromise;
  // A Tailwind failure used to propagate and kill the build. It still does —
  // but only here, after the bundle is on disk, and with the same error.
  if (tailwindOutcome.err) throw tailwindOutcome.err;
  const tailwindCss = tailwindOutcome.css;
  phase('3. tailwind (overlapped)', _p);
  _p = phaseStart();
  if (tailwindCss !== null) cssParts.push(tailwindCss);

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

  const cssOutPath = path.join(assetsDir, 'index.css');
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

    if (wroteCss && !html.includes('assets/index.css')) {
      html = html.replace('</head>', `  <link rel="stylesheet" crossorigin href="${base}assets/index.css">\n  </head>`);
    }
    fs.writeFileSync(htmlOutPath, html, 'utf8');
  }

  // 7. Copy public/ directory
  const publicDir = path.join(cwd, 'public');
  if (fs.existsSync(publicDir)) {
    copyDirRecursive(publicDir, outDir);
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
          // Pre-render is a build step, not an artifact: never ship the bundle.
          try { fs.rmSync(ssgOut, { force: true }); } catch {}
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
        const preRenderable = routesTable
          ? routesTable.routes.filter((r) => !r.hasParams && r.rendering !== 'csr')
          : [];
        const csrRoutes = routesTable ? routesTable.routes.filter((r) => r.rendering === 'csr') : [];
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
        const withBundle = (html) => {
          if (!entryTag) return html;
          // The source template points at `src/main.hyx`; swap in the real bundle.
          const src = path.relative(cwd, entryPoint).split(path.sep).join('/');
          const re = new RegExp(
            `<script[^>]*src=["'][^"']*${escapeRegExp(src)}["'][^>]*>\\s*</script>`,
            'i',
          );
          if (re.test(html)) return html.replace(re, entryTag);
          return html.includes('</body>') ? html.replace('</body>', `  ${entryTag}\n  </body>`) : html + entryTag;
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

        let renderedCount = 0;
        if (sourceHtml && routesTable && staticRoutes.length > 0 && typeof ssgMod.renderFor === 'function') {
          for (const route of staticRoutes) {
            try {
              // Always `{ element, data }`. There is no fallback to the raw
              // return value: an earlier version fell back when `element` was
              // null, which handed React the wrapper object and produced
              // "Objects are not valid as a React child" instead of the reason.
              const out = await ssgMod.renderFor(route.pattern, {}, route.pattern);
              const element = out ? out.element : null;
              if (!element) {
                console.warn(`[hydra] SSG: ${route.pattern} (src/pages/${route.file}) exports no component; skipped`);
                continue;
              }
              const rendered = renderToString(element);
              // The seed outlives `renderFor` on purpose (see the generated
              // entry), so it is cleared here, once the render has read it.
              if (typeof ssgMod.__clear_seed === 'function') ssgMod.__clear_seed();
              // The loader's result travels with the HTML so the client's first
              // paint has the same data the server rendered from. Without it the
              // client fetches again and the two frames disagree — React says so
              // as a hydration mismatch, which is how this was found.
              const html = injectLoaderData(
                withBundle(inject(sourceHtml, rendered)),
                route.pattern,
                out && out.data,
              );
              fs.writeFileSync(htmlPathForPattern(route.pattern), html, 'utf8');
              renderedCount += 1;
            } catch (err) {
              // One page that throws must not cost the other pages their HTML.
              console.error(`[hydra] SSG: ${route.pattern} failed to pre-render: ${err.message || err}`);
            }
          }
          console.log(
            `[hydra] SSG: pre-rendered ${renderedCount}/${staticRoutes.length} static route(s) into ${path.relative(cwd, outDir)}/`,
          );
          if (csrRoutes.length > 0) {
            console.log(
              `[hydra] render: ${csrRoutes.length} route(s) marked csr and left to the client ` +
                `(${csrRoutes.map((r) => r.pattern).join(', ')})`,
            );
          }
          if (dynamicRoutes.length > 0) {
            console.log(
              `[hydra] SSG: ${dynamicRoutes.length} dynamic route(s) left as the client shell ` +
                `(${dynamicRoutes.map((r) => r.pattern).join(', ')}) — a URL with a parameter has no single page to build`,
            );
          }
        } else {
          const AppComponent =
            ssgMod.App || ssgMod.default || Object.values(ssgMod).find((v) => typeof v === 'function');
          if (!AppComponent) {
            throw new Error('Could not find exported App component in SSR bundle');
          }
          const renderedHtml = renderToString(React.createElement(AppComponent));
          if (sourceHtml) {
            fs.writeFileSync(htmlOutPath, inject(sourceHtml, renderedHtml), 'utf8');
            console.log(
              `[hydra] SSG: Pre-rendered HTML injected into ${path.relative(cwd, htmlOutPath)} (${renderedHtml.length} chars)`,
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

  const ms = Date.now() - t0;
  console.log(`[hydra] Built successfully in ${ms}ms -> ${path.relative(cwd, outDir)}/`);
  phaseReport(ms);

  // 6. Runtime gate. The build reporting success while the page throws is the
  //    failure this catches, and it is invisible everywhere else: the compiler
  //    validated what it emitted, this validates what actually runs.
  if (gateWanted) {
    const { runRuntimeGate } = await import('./runtime-gate.mjs');
    const gate = await runRuntimeGate({
      distDir: outDir,
      serve: (dir) => serveDirectory(dir, 0, '127.0.0.1'),
    });
    if (gate.skipped) {
      console.log(`[hydra] runtime gate skipped: ${gate.skipped}`);
    } else if (gate.ok) {
      const extra = gate.warnings.length
        ? ` (${gate.warnings.length} console warning(s))`
        : '';
      console.log(`[hydra] runtime gate passed: no uncaught exceptions${extra}`);
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

async function handleAction(req, res, reqPath, rawUrl, bundlePath) {
  let mod;
  try {
    mod = await loadActions(bundlePath);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `could not load actions: ${e.message}` }));
    return;
  }
  const hit = mod && mod.actionFor ? mod.actionFor(reqPath) : null;
  if (!hit) {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: `no action for ${req.method} ${reqPath}`,
        hint: 'a route accepts a mutation only if a .server.hys beside it exports `action`',
      }),
    );
    return;
  }

  let rawBody = '';
  try {
    rawBody = await readBody(req);
  } catch (e) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }

  try {
    const out = await hit.fn({
      params: hit.params,
      url: reqPath,
      request: requestFor(req, rawUrl, rawBody),
    });
    if (out && typeof out === 'object' && out.redirect) {
      res.writeHead(out.status || 303, { Location: out.redirect });
      res.end();
      return;
    }
    const status = out && typeof out === 'object' && out.status ? out.status : 200;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out === undefined ? null : out));
  } catch (e) {
    // An action that throws is a bug in the action, and the browser deserves to
    // know rather than receiving a 200 with an empty body.
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
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

  const server = http.createServer((req, res) => {
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
      handleAction(req, res, reqPath, rawUrl, opts.actions);
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
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(detail));
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

    let exists = fs.existsSync(filePath);
    if (exists && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      exists = fs.existsSync(filePath);
    }

    if (!exists) {
      // SPA fallback: react-router, TanStack Router and friends own every path
      // that is not a file, and a reload on /dashboard/settings has to reach
      // the app rather than a 404 page.
      const isNavigation = req.method === 'GET' || req.method === 'HEAD';
      if (!isNavigation || !fs.existsSync(indexPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      filePath = indexPath;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // An HTML file gets the dev-only transform, if the caller asked for one.
    // `hydra dev` uses it for the live-reload client; `preview` does not, because
    // a preview should be what production serves.
    if (opts.injectHtml && ext === '.html') {
      const html = opts.injectHtml(fs.readFileSync(filePath, 'utf8'));
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(html);
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
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
      console.log(`[hydra] Server running at ${reach}`);
      resolve({ server, port: actualPort });
    });

    server.listen(actualPort, host);
  });
}

export async function runPreview(cwd = process.cwd(), opts = {}) {
  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const port = opts.port || config.server?.port || 5173;
  const host = opts.host || config.server?.host || '127.0.0.1';
  const indexPath = path.join(outDir, 'index.html');

  if (!fs.existsSync(outDir) || !fs.existsSync(indexPath)) {
    console.log('[hydra] Output directory or index.html not found. Running build first...');
    await runBuild(cwd);
  }

  console.log('[hydra] Previewing production build:');
  await serveDirectory(outDir, port, host, {
    base: normalizeBase(config.base),
    proxy: config.server?.proxy,
    actions: readActionBundle(cwd),
    version: opts.version,
    sha: opts.sha,
    configPath: path.join(cwd, 'hydraconfig.json'),
  });
}

export async function runDev(cwd = process.cwd(), opts = {}) {
  // Libraries branch on this at bundle time — `process.env.NODE_ENV !==
  // 'production'` is what turns on React's dev warnings and every `act()`
  // guard — and `hydra dev` is the command that promises them.
  process.env.NODE_ENV = 'development';

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

  console.log('[hydra] Development mode active.');
  const served = await serveDirectory(outDir, port, host, {
    base: normalizeBase(config.base),
    proxy: config.server?.proxy,
    // Re-read on every dev build, because the bundle is regenerated per build.
    actions: readActionBundle(cwd),
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
    fs.watch(srcDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (building) return;
        building = true;
        try {
          await runBuild(cwd, { dev: true });
          if (hmr) hmr.broadcast(JSON.stringify({ type: 'ok' }));
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
    });
  }
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

const cwd = process.cwd();
const runOpts = { port: portOverride, host: hostOverride, version: VERSION, sha: gitSha() };

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
} else if (cmd === 'build') {
  runBuild(cwd).catch((err) => {
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
