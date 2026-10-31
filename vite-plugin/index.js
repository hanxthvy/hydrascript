// [xihanzu-NR]
/**
 * vite-plugin-hydrascript — compile HydraScript to React TSX.
 *
 * The compiler is a native Rust binary: one process spawn per file, cached.
 * Cold compile is ~1ms, so the spawn cost dominates — see `compilerPath` to
 * point at a prebuilt binary, and `--json` mode which returns code + map in
 * one round trip. When the prebuilt N-API addon (`bin/hydra.node`) is present
 * it is used in-process instead, which matters in `vite dev`, where a save
 * recompiles and a spawn per save is the whole cost.
 *
 * All four HydraScript extensions are handled. `.hyx` / `.hsx` compile to
 * React TSX (JSX stripped by esbuild before Vite sees it, because Vite decides
 * how to parse a module from its EXTENSION and `.hyx` is not a JS extension —
 * handing TSX back here reaches Rollup's parser and dies with PARSE_ERROR on
 * the first `<`). `.hys` / `.hs` compile to plain JS.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const selfRequire = createRequire(import.meta.url)

/** Extensions that compile to React TSX. */
const COMPONENT_EXT = /\.(hyx|hsx)$/
/** Extensions that compile to plain JavaScript. */
const SCRIPT_EXT = /\.(hys|hs)$/

/** Where the native binary lives. Checked in order. */
function findCompiler(explicit) {
  const candidates = [
    explicit,
    process.env.HYDRA_COMPILER,
    // The compiler binary is owned by the `hydrascript` package, not by this
    // plugin. A private copy here is a second copy that can silently lag behind
    // the compiler it is supposed to be running, so the order is: the repo's
    // build, then the package that owns it, then PATH. `HERE/bin/hydra` was the
    // first entry and is deliberately gone.
    path.join(HERE, '..', 'bin', 'hydra'),
    path.join(HERE, '..', 'compiler-rs', 'target', 'release', 'hydra'),
    path.join(HERE, '..', 'compiler-rs', 'target', 'debug', 'hydra'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    `[hydrascript] native compiler not found. Build it with:\n` +
      `  cd compiler-rs && cargo build --release\n` +
      `or set compilerPath / $HYDRA_COMPILER.`,
  )
}

/** The prebuilt in-process addon, if this checkout has one. */
function findAddon(explicit) {
  const candidates = [
    explicit,
    process.env.HYDRA_NATIVE,
    path.join(HERE, 'bin', 'hydra.node'),
    path.join(HERE, '..', 'bin', 'hydra.node'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (!existsSync(c)) continue
    try {
      return selfRequire(c)
    } catch {
      /* a stale addon falls back to the CLI */
    }
  }
  return null
}

/**
 * esbuild, resolved from this package. Optional at require time so requiring the
 * plugin never throws; `transform` reports the problem where context exists.
 */
let esbuildMod = null
let esbuildTried = false
function loadEsbuild() {
  if (!esbuildTried) {
    esbuildTried = true
    try {
      const p = selfRequire.resolve('esbuild')
      esbuildMod = selfRequire(p)
    } catch {
      esbuildMod = null
    }
  }
  return esbuildMod
}

/**
 * Turn `__import__("./X.hyx")` into a literal `import("./X.hyx")`.
 *
 * The compiler has no `import()` expression, but `__import__` is an ordinary
 * call it passes through, and Vite/Rollup only split on the syntax. Without
 * this, `React.lazy` and route-based splitting produce one inlined bundle.
 * The canonical copy is `packages/cli/esbuild-plugin.mjs`; it is duplicated
 * here so this package stays installable on its own.
 */
function rewriteDynamicImports(code) {
  return code.replace(
    /(^|[^\w$.])__import__\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g,
    (m, lead, quote, spec) => `${lead}import(${quote}${spec}${quote})`,
  )
}

export function hydrascript(opts = {}) {
  const addon = opts.useNative === false ? null : findAddon(opts.addonPath)
  const bin = addon ? null : findCompiler(opts.compilerPath)
  // Keyed by path AND source. A path-only key is fine for a one-shot build but
  // wrong for a dev server: Vite re-transforms a file whose contents changed,
  // and the stale entry would be handed back for the new text.
  const cache = new Map()

  function compile(file, source) {
    const hit = cache.get(file)
    if (hit !== undefined && hit.source === source) return hit.res
    let res
    if (addon) {
      res = addon.compile(source, file)
    } else {
      try {
        const out = execFileSync(bin, ['--json', '--stdin', file], {
          input: source,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        })
        res = JSON.parse(out)
      } catch (e) {
        // The binary exits 1 with a caret-annotated message on stderr.
        const msg = (e.stderr || e.message || '').toString().trim()
        res = { error: msg || `hydra: compile failed for ${file}` }
      }
    }
    cache.set(file, { source, res })
    return res
  }

  return {
    name: 'hydra',
    enforce: 'pre',

    configResolved(cfg) {
      if (opts.debug) {
        cfg.logger.info(`[hydra] compiler: ${addon ? 'native addon' : bin}`)
      }
    },

    async transform(source, id) {
      const file = id.split('?')[0]
      const isComponent = COMPONENT_EXT.test(file)
      if (!isComponent && !SCRIPT_EXT.test(file)) return null

      const res = compile(file, source)
      if (res.error) {
        // Surface the compiler's own caret-annotated message in the overlay.
        // `this.error` exists in a real Vite transform context; the fallback
        // keeps the plugin usable when called directly (tests, other tools),
        // where a TypeError from inside the plugin would hide the actual
        // compile error.
        if (typeof this?.error === 'function') {
          this.error(res.error)
          return null
        }
        return { code: '', map: null, error: { message: res.error } }
      }
      const code = rewriteDynamicImports(res.code)

      if (!isComponent) {
        if (opts.debug) {
          this.info(`[hydra] ${path.basename(file)} -> script`)
        }
        return { code, map: null }
      }

      // esbuild lowers the TSX to JS. It is used directly rather than Vite's
      // `transformWithEsbuild`, which infers the loader from the FILENAME: an
      // id ending in `.hyx` is not a JS extension, so the JSX would survive and
      // Vite's import analysis would fail with "content contains invalid JS
      // syntax". Passing the loader explicitly is what makes `.hyx` work.
      // esbuild is a dependency of hydrascript, so it is present wherever this
      // plugin is usable.
      const esbuild = loadEsbuild()
      if (!esbuild) {
        const msg =
          '[hydrascript] esbuild is required to lower the JSX that .hyx compiles to.'
        if (typeof this?.error === 'function') {
          this.error(msg)
          return null
        }
        return { code: '', map: null, error: { message: msg } }
      }
      const js = await esbuild.transform(code, {
        loader: 'tsx',
        jsx: 'automatic',
        sourcemap: true,
        sourcefile: file,
      })
      if (opts.debug) {
        this.info(`[hydra] ${path.basename(file)} -> ${code.split('\n').length} lines TSX`)
      }
      return { code: js.code, map: js.map ? JSON.parse(js.map) : null }
    },

    handleHotUpdate(ctx) {
      const file = ctx.file.split('?')[0]
      if (COMPONENT_EXT.test(file) || SCRIPT_EXT.test(file)) cache.delete(file)
    },
  }
}

export default hydrascript
