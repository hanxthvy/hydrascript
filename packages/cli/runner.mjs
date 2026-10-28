// [xihanzu-NR]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const selfRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolvePkg(name, cwd) {
  const bases = [
    HERE,
    path.join(HERE, '../..'),
    '/root/projects/hydra',
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

async function loadBundlerDeps(cwd) {
  const esbuildPath = resolvePkg('esbuild', cwd);
  const postcssPath = resolvePkg('postcss', cwd);
  const twPath = resolvePkg('tailwindcss', cwd);
  const apPath = resolvePkg('autoprefixer', cwd);

  const esbuild = await import(esbuildPath);
  const postcssMod = await import(postcssPath);
  const postcss = postcssMod.default || postcssMod;
  const twMod = await import(twPath);
  const tailwindcss = twMod.default || twMod;
  const apMod = await import(apPath);
  const autoprefixer = apMod.default || apMod;

  return { esbuild, postcss, tailwindcss, autoprefixer };
}

function findNativeAddon() {
  // No absolute paths: this file ships with the package, so anything anchored
  // to the author's home directory works on exactly one machine and silently
  // picks up a stranger's binary everywhere else.
  const candidates = [
    process.env.HYDRA_NATIVE,
    path.join(HERE, '../../bin/hydra.node'),
    path.join(HERE, '../../bin/serpent.node'),
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

function cliFallbackCompile(file, source) {
  const candidates = [
    process.env.HYDRA_COMPILER,
    process.env.SERPENT_COMPILER,
    path.join(HERE, '../../bin/hydra'),
    path.join(HERE, '../../bin/serpent'),
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

function createHydraEsbuildPlugin() {
  const native = findNativeAddon();
  const cache = new Map();

  function compile(file, source) {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;

    let res;
    if (native) {
      res = native.compile(source, file);
    } else {
      res = cliFallbackCompile(file, source);
    }
    cache.set(file, res);
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
      path.join(cwd, 'src/**/*.{hyx,hys,hsx,hs,html,css}'),
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

export async function runBuild(cwd = process.cwd(), opts = {}) {
  const t0 = Date.now();

  const config = readConfig(cwd);
  // `mode` drives the environment shims, and nothing else. Explicit caller >
  // hydraconfig > the default for the command (dev / production).
  const mode = opts.mode || config.mode || (opts.dev ? 'development' : 'production');
  if (mode === 'development') process.env.NODE_ENV = 'development';

  console.log(`[hydra] Building for ${mode} (Hydra native bundler)...`);

  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const assetsDir = path.join(outDir, 'assets');
  const base = normalizeBase(config.base);
  fs.mkdirSync(assetsDir, { recursive: true });

  const { esbuild, postcss, tailwindcss, autoprefixer } = await loadBundlerDeps(cwd);

  // 1. Discover entrypoint
  const entryCandidates = [
    path.join(cwd, 'src/main.hyx'),
    path.join(cwd, 'src/main.hsx'),
    path.join(cwd, 'src/index.hyx'),
    path.join(cwd, 'src/index.hsx'),
  ];
  const entryPoint = entryCandidates.find((f) => fs.existsSync(f));
  if (!entryPoint) {
    throw new Error('[hydra] Entrypoint not found: expected src/main.hyx');
  }

  // 2. Discover the runtime alias
  //
  // The compiler emits `import { capitalize } from 'serpent'` for every helper
  // a source used but did not import. Nothing aliased that specifier, so any
  // project using a Python string method failed to bundle with a bare
  // "Could not resolve 'serpent'". Resolve it to the runtime that ships in
  // this package, and keep the legacy `hydra` specifier working.
  const pkgRoot = path.resolve(HERE, '../..');
  // The project's own runtime file (`src/hydra.hys`) and the compiler's helper
  // runtime are DIFFERENT things and must not share one alias.
  //
  // `serpent` is where the compiler emits imports for the Python-standard
  // helpers it uses (`len_of`, `contains`, `list_remove`, ...). Pointing that
  // at the project's runtime produced "No matching export in src/hydra.hys for
  // import len_of" — the project file is never going to have every helper the
  // compiler can emit, and it is the compiler's job to provide them.
  //
  // `hydra` is the application-facing runtime (`state`, `use_path`, `mount`).
  // When the project ships its own, that one wins: it may carry app-specific
  // helpers that the compiler runtime has never heard of.
  const compilerRuntime =
    [
      process.env.HYDRA_RUNTIME_PATH,
      path.join(pkgRoot, 'runtime', 'serpent.ts'),
      path.join(pkgRoot, 'runtime-js', 'serpent-js.js'),
    ].find((f) => f && fs.existsSync(f)) || path.join(pkgRoot, 'runtime', 'serpent.ts');
  const projectRuntime = [
    path.resolve(cwd, 'src/hydra.hys'),
    path.resolve(cwd, 'src/hydra.hs'),
  ].find((f) => fs.existsSync(f));
  const serpentAlias = compilerRuntime;
  const hydraAlias = projectRuntime || compilerRuntime;

  // 3. Bundle JavaScript via esbuild
  const clientResult = await esbuild.build({
    entryPoints: [entryPoint],
    // Metafile keys then come back relative to the project, which is what
    // `dist/.hydra-build.json` should contain and what the emitted entry name
    // is read from below.
    absWorkingDir: cwd,
    bundle: true,
    minify: true,
    sourcemap: true,
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
    publicPath: base,
    metafile: true,
    plugins: [createHydraEsbuildPlugin()],
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
      // Both specifiers point at the same runtime: `serpent` is what the
      // compiler emits today, `hydra` is what older sources import.
      serpent: serpentAlias,
      hydra: hydraAlias,
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
  });

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
  const entryOutKey = Object.keys(metafile.outputs).find(
    (k) => metafile.outputs[k].entryPoint && k.endsWith('.js'),
  );
  if (!entryOutKey) {
    throw new Error('[hydra] The client build produced no JavaScript entry chunk');
  }

  // 5. One stylesheet out: Tailwind, then every stylesheet the module graph
  // imported, merged into assets/index.css.
  //
  // Tailwind comes first because src/index.css is imported first by the entry
  // (its preflight has to sit under the library rules, exactly as it would if
  // the import order decided the order), and the libraries follow.
  const cssParts = [];
  const tailwindCss = await compileTailwind(cwd, config, postcss, tailwindcss, autoprefixer);
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
  if (config.rendering?.ssg !== false) {
    const ssgEntryCandidates = [
      path.join(cwd, 'src/App.hyx'),
      path.join(cwd, 'src/App.hsx'),
      path.join(cwd, 'src/App.jsx'),
      path.join(cwd, 'src/App.tsx'),
      path.join(cwd, 'src/App.js'),
      entryPoint,
    ];
    const ssgEntry = ssgEntryCandidates.find((f) => fs.existsSync(f));
    if (ssgEntry) {
      try {
        const reactPath = resolvePkg('react', cwd);
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
            createHydraEsbuildPlugin(),
            {
              name: 'hydra-ssg-external-react',
              setup(build) {
                // Kept external as BARE specifiers, never as `file://` URLs.
                // React must be a single instance shared with the renderer
                // below: hooks dispatch through the copy the component code
                // imported, so a second copy means a null dispatcher and an
                // "invalid hook call" at pre-render time. A `file://` URL was
                // also unusable — the SSR bundle is written to disk and
                // imported as a file, and a URL specifier there turns into
                // `require("file:///...")`, which Node rejects outright.
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
            // Same two specifiers as the browser build: missing `serpent` here
            // made the SSG pass fail after a successful client build.
            // tsconfig paths are included too, or a component importing `~lib/x`
            // would render on the client and throw during pre-render.
            ...tsconfigAliases(cwd),
            serpent: serpentAlias,
            hydra: hydraAlias,
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

        // Run SSR execution in a safe context
        setupSSRGlobals();

        const ssgCode = ssgResult.outputFiles[0].text;
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

        const reactDomServerPath = resolvePkg('react-dom/server', cwd);
        const { renderToString } = await import(pathToFileURL(reactDomServerPath).href);
        const reactMod = await import(pathToFileURL(reactPath).href);
        const React = reactMod.default || reactMod;

        const AppComponent = ssgMod.App || ssgMod.default || Object.values(ssgMod).find((v) => typeof v === 'function');
        if (!AppComponent) {
          throw new Error('Could not find exported App component in SSR bundle');
        }

        const renderedHtml = renderToString(React.createElement(AppComponent));

        if (fs.existsSync(htmlOutPath)) {
          let html = fs.readFileSync(htmlOutPath, 'utf8');
          html = html.replace(/<div\s+id=["']root["']\s*><\/div>/i, `<div id="root">${renderedHtml}</div>`);
          fs.writeFileSync(htmlOutPath, html, 'utf8');
          console.log(`[hydra] SSG: Pre-rendered HTML injected into dist/index.html (${renderedHtml.length} chars)`);
        }
      } catch (err) {
        console.error('[hydra] SSG Pre-rendering error:', err.message || err);
      }
    }
  }

  const ms = Date.now() - t0;
  console.log(`[hydra] Built successfully in ${ms}ms -> ${path.relative(cwd, outDir)}/`);
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

export async function serveDirectory(dir, port = 5173, host = '0.0.0.0', opts = {}) {
  const base = normalizeBase(opts.base || '/');
  const proxy = opts.proxy && typeof opts.proxy === 'object' ? opts.proxy : {};
  const indexPath = path.join(dir, 'index.html');
  const rootDir = path.resolve(dir);

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
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });

  server.listen(port, host, () => {
    console.log(`[hydra] Server running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  });
}

export async function runPreview(cwd = process.cwd()) {
  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const port = config.server?.port || 5173;
  const host = config.server?.host || '0.0.0.0';
  const indexPath = path.join(outDir, 'index.html');

  if (!fs.existsSync(outDir) || !fs.existsSync(indexPath)) {
    console.log('[hydra] Output directory or index.html not found. Running build first...');
    await runBuild(cwd);
  }

  console.log('[hydra] Previewing production build:');
  await serveDirectory(outDir, port, host, {
    base: normalizeBase(config.base),
    proxy: config.server?.proxy,
  });
}

export async function runDev(cwd = process.cwd()) {
  // Libraries branch on this at bundle time — `process.env.NODE_ENV !==
  // 'production'` is what turns on React's dev warnings and every `act()`
  // guard — and `hydra dev` is the command that promises them.
  process.env.NODE_ENV = 'development';

  // Build first then serve with auto rebuild
  await runBuild(cwd, { dev: true });
  const config = readConfig(cwd);
  const outDir = path.resolve(cwd, config.outputDir || 'dist');
  const port = config.server?.port || 5173;
  const host = config.server?.host || '0.0.0.0';

  console.log('[hydra] Development mode active.');
  await serveDirectory(outDir, port, host, {
    base: normalizeBase(config.base),
    proxy: config.server?.proxy,
  });

  // Watch src/ directory for changes
  const srcDir = path.join(cwd, 'src');
  if (fs.existsSync(srcDir)) {
    let building = false;
    fs.watch(srcDir, { recursive: true }, async () => {
      if (building) return;
      building = true;
      try {
        await runBuild(cwd, { dev: true });
      } catch (err) {
        console.error('[hydra] Build error:', err.message);
      } finally {
        building = false;
      }
    });
  }
}

// CLI entrypoint
const cmd = process.argv[2] || 'dev';
const cwd = process.cwd();

if (cmd === 'dev') {
  runDev(cwd).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === 'build') {
  runBuild(cwd).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === 'preview') {
  runPreview(cwd).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.error(`[hydra] Unknown command: ${cmd}`);
  process.exit(1);
}
