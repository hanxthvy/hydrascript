// [xihanzu-NR]
/**
 * HydraScript as a real bundler plugin.
 *
 * Until now `.hyx` support lived inside the runner's own build function: the
 * runner wrote `.tsx` files to disk and then bundled them. That works, and it
 * is not a plugin — you cannot hand it to Vite, you cannot use it in an
 * esbuild config of your own, and a bundler plugin is what makes both possible
 * (plus real HMR, which is what a dev server needs and the disk-writing
 * watcher could never give).
 *
 * Two entry points, one compiler:
 *
 *   hydraEsbuildPlugin()  — for esbuild (`plugins: [...]`).
 *   hydraVitePlugin()     — for Vite (`plugins: [...]`), via `transform`.
 *
 * Both compile in-process through the native addon when it is present and fall
 * back to the CLI binary otherwise, so a machine with a prebuilt binary but no
 * addon still works. The compiler is cached per (path, source) — keyed on the
 * source as well as the path, because an incremental rebuild re-runs the hook
 * for a file whose contents changed and a path-only key would hand back the
 * previous output.
 *
 * Known limits, stated rather than discovered later:
 *
 *   - `__import__("./Page.hyx")` with a string literal is rewritten to a real
 *     dynamic `import()` so a bundler can split on it. A computed specifier
 *     cannot be split by any tool and is left alone.
 *   - The rewrite is textual, done before the parser, so a specifier written
 *     inside a string or a comment would be rewritten too.
 *   - The Vite plugin compiles, it does not add React fast-refresh. Pair it
 *     with @vitejs/plugin-react for HMR.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const selfRequire = createRequire(import.meta.url);

/** Extensions compiled to React TSX. */
export const COMPONENT_EXT = /\.(hyx|hsx)$/;
/** Extensions compiled to plain JavaScript. */
export const SCRIPT_EXT = /\.(hys|hs)$/;

function defaultAddonPath() {
  return path.join(HERE, '../../bin/hydra.node');
}

function defaultCliPath() {
  return path.join(HERE, '../../bin/hydra');
}

function loadAddon(p) {
  if (!p) return null;
  if (!fs.existsSync(p)) return null;
  try {
    return selfRequire(p);
  } catch {
    return null;
  }
}

function cliCompile(bin, file, source) {
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

/**
 * Turn `__import__("./X.hyx")` into a literal `import("./X.hyx")`.
 *
 * The compiler has no `import()` expression, but `__import__` is an ordinary
 * call it passes through, and bundlers only split on the syntax. Rewriting the
 * call is what makes `React.lazy` and route-based code splitting emit real
 * chunks instead of one inlined bundle.
 */
export function rewriteDynamicImports(code) {
  return code.replace(
    /(^|[^\w$.])__import__\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g,
    (m, lead, quote, spec) => `${lead}import(${quote}${spec}${quote})`,
  );
}

/**
 * Build a compiler bound to a particular addon/CLI, with its own cache.
 *
 * @returns {{ compile: (file: string, source: string) => object,
 *             backend: () => 'native'|'cli'|'none' }}
 */
export function createHydraCompiler({ addonPath, cliPath } = {}) {
  const addon = loadAddon(addonPath ?? defaultAddonPath());
  const cli = cliPath ?? defaultCliPath();
  const cache = new Map();

  function compile(file, source) {
    const hit = cache.get(file);
    if (hit !== undefined && hit.source === source) return hit.res;

    let res;
    if (addon) {
      res = addon.compile(source, file);
    } else if (fs.existsSync(cli)) {
      res = cliCompile(cli, file, source);
    } else {
      res = { error: 'Hydra compiler (native addon or CLI binary) not found' };
    }
    cache.set(file, { source, res });
    return res;
  }

  return {
    compile,
    backend: () => (addon ? 'native' : fs.existsSync(cli) ? 'cli' : 'none'),
  };
}

/** Shared: turn a compile result into an esbuild/resolve-style outcome. */
function toEsbuildResult(res, file) {
  if (res.error) return { errors: [{ text: res.error }] };
  const loader = COMPONENT_EXT.test(file) ? 'tsx' : 'js';
  return {
    contents: rewriteDynamicImports(res.code),
    loader,
    resolveDir: path.dirname(file),
  };
}

/**
 * esbuild plugin.
 *
 * ```js
 * import { hydraEsbuildPlugin } from 'hydrascript/esbuild';
 * await esbuild.build({ entryPoints: ['src/main.hyx'], plugins: [hydraEsbuildPlugin()] });
 * ```
 */
export function hydraEsbuildPlugin(opts = {}) {
  const { compile } = createHydraCompiler(opts);
  return {
    name: 'hydra',
    setup(build) {
      build.onLoad({ filter: COMPONENT_EXT }, async (args) => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        return toEsbuildResult(compile(args.path, source), args.path);
      });
      build.onLoad({ filter: SCRIPT_EXT }, async (args) => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        return toEsbuildResult(compile(args.path, source), args.path);
      });
    },
  };
}

/**
 * Vite plugin.
 *
 * ```js
 * import react from '@vitejs/plugin-react';
 * import { hydraVitePlugin } from 'hydrascript/vite';
 * export default { plugins: [hydraVitePlugin(), react()] };
 * ```
 *
 * `enforce: 'pre'` matters: the compile must see the `.hyx` source before any
 * other plugin tries to interpret it. React fast refresh is not included here;
 * @vitejs/plugin-react provides it for the JSX that comes out.
 */
export function hydraVitePlugin(opts = {}) {
  const { compile } = createHydraCompiler(opts);
  // Vite decides how to parse a module from its EXTENSION, and `.hyx` is not in
  // its list of JS/JSX extensions. Returning TSX from `transform` therefore gets
  // handed straight to Rollup's parser, which fails on the first `<div>` with a
  // PARSE_ERROR. So the JSX has to be stripped here, and the module comes out as
  // plain JS — which is also how single-file-component plugins do it.
  let esbuildPromise = null;
  async function getEsbuild() {
    if (!esbuildPromise) {
      esbuildPromise = (async () => {
        try {
          const mod = await import(selfRequire.resolve('esbuild'));
          return mod.default ?? mod;
        } catch {
          return null;
        }
      })();
    }
    return esbuildPromise;
  }

  return {
    name: 'hydra',
    enforce: 'pre',
    async transform(code, id) {
      const file = id.split('?')[0];
      const isComponent = COMPONENT_EXT.test(file);
      if (!isComponent && !SCRIPT_EXT.test(file)) return null;
      const res = compile(file, code);
      if (res.error) {
        // Vite wants the error to carry the position so the overlay points at
        // the right line; `hydra` errors already read `file:line:col: ...`.
        return { code: '', map: null, error: { message: res.error } };
      }
      const compiled = rewriteDynamicImports(res.code);
      if (!isComponent) return { code: compiled, map: null };

      const esbuild = await getEsbuild();
      if (!esbuild) {
        // Without esbuild the JSX cannot be lowered, and returning it anyway
        // would produce a PARSE_ERROR that points at Vite instead of at the
        // real cause.
        return {
          code: '',
          map: null,
          error: {
            message:
              'hydra: esbuild is required to use .hyx with Vite (it lowers the JSX, which Vite does not do for a non-.tsx id). Install esbuild.',
          },
        };
      }
      const out = await esbuild.transform(compiled, {
        loader: 'tsx',
        jsx: 'automatic',
        // Keep line numbers stable so the overlay and stack traces stay useful.
        minify: false,
        sourcemap: false,
      });
      return { code: out.code, map: null };
    },
  };
}
