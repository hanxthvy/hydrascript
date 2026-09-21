// [xihanzu-NR]
/**
 * vite-plugin-serpent — compile `.hsx` (Pythonic syntax) to React TSX.
 *
 * The compiler is a native Rust binary: one process spawn per file, cached.
 * Cold compile is ~2ms, so the spawn cost dominates — see `compilerPath` to
 * point at a prebuilt binary, and `--json` mode which returns code + map in
 * one round trip.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Where the native binary lives. Checked in order. */
function findCompiler(explicit) {
  const candidates = [
    explicit,
    process.env.SERPENT_COMPILER,
    path.join(HERE, 'bin', 'serpent'),
    path.join(HERE, '..', 'compiler-rs', 'target', 'release', 'serpent'),
    path.join(HERE, '..', 'compiler-rs', 'target', 'debug', 'serpent'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    `[serpent] native compiler not found. Build it with:\n` +
    `  cd compiler-rs && cargo build --release\n` +
    `or set compilerPath / $SERPENT_COMPILER.`,
  )
}

export function serpent(opts = {}) {
  const bin = findCompiler(opts.compilerPath)
  const cache = new Map()

  function compile(file, source) {
    const hit = cache.get(file)
    if (hit !== undefined) return hit
    let res
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
      res = { error: msg || `serpent: compile failed for ${file}` }
    }
    cache.set(file, res)
    return res
  }

  return {
    name: 'serpent',
    enforce: 'pre',

    configResolved(cfg) {
      if (opts.debug) cfg.logger.info(`[serpent] compiler: ${bin}`)
    },

    async transform(source, id) {
      if (!id.endsWith('.hsx')) return null
      const res = compile(id, source)
      if (res.error) {
        // Surface the compiler's own caret-annotated message in the Vite overlay.
        this.error(res.error)
        return null
      }
      // The compiler emits TSX. esbuild turns it into JS and composes our
      // source map so the browser still points at the .hsx file.
      const js = await transformWithEsbuild(res.code, id.replace(/\.hsx$/, '.tsx'), {
        loader: 'tsx',
        jsx: 'automatic',
        sourcemap: true,
        sourcefile: id,
      })
      if (opts.debug) {
        this.info(`[serpent] ${path.basename(id)} -> ${res.code.split('\n').length} lines TSX`)
      }
      return { code: js.code, map: js.map }
    },

    handleHotUpdate(ctx) {
      if (ctx.file.endsWith('.hsx')) cache.delete(ctx.file)
    },
  }
}

export default serpent
