// [xihanzu-NR]
/**
 * `hydra/server` — helpers that only make sense on a server.
 *
 * Importing this from a file that reaches the client bundle is a BUILD ERROR,
 * not a runtime surprise, because a bundler can see the import and a browser
 * cannot resolve `node:fs`. The refusal happens in two places and both matter:
 *
 *   - The compiler refuses it in a `.hyx` file, because a `.hyx` module is a
 *     component module and components render on the client.
 *   - The build refuses it in the client bundle, naming the file that imported
 *     it, so a `.hys` that pulls it in transitively is caught too.
 *
 * What belongs here is the short list a build actually needs: reading a file at
 * build time, and reading an environment variable that must never reach the
 * browser. Anything longer is a framework, and this is not one.
 *
 * The SSG pass resolves this module for real. The client pass does not resolve
 * it at all.
 */

export interface Env {
  /** Read a variable, or throw. A missing required variable is a config bug. */
  require(name: string): string
  /** Read a variable, `fallback` when it is absent or empty. */
  get(name: string, fallback?: string): string | undefined
  /** Every variable starting with `PUBLIC_`, which the client may also see. */
  public(): Record<string, string>
}

/**
 * `env("NAME")` — the server's environment, with `PUBLIC_` separated.
 *
 * The split is the point. `PUBLIC_*` is what the client is allowed to know, and
 * everything else stays here. A build that finds a non-public name referenced
 * from a client file fails, rather than shipping the value.
 */
export function env(name: string, fallback?: string): string | undefined {
  const v = typeof process !== 'undefined' && process.env ? process.env[name] : undefined
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    return undefined
  }
  return v
}

/** `env_require("NAME")` — `env`, but a missing value is an error, not `undefined`. */
export function env_require(name: string): string {
  const v = env(name)
  if (v === undefined) {
    throw new Error(
      `hydra/server: ${name} is not set. Add it to .env, or use env("${name}", default) ` +
        `if a default is genuinely fine.`,
    )
  }
  return v
}

/** `public_env()` — every `PUBLIC_` variable, which the client build may inline. */
export function public_env(): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof process === 'undefined' || !process.env) return out
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('PUBLIC_') && v !== undefined) out[k] = v
  }
  return out
}

/**
 * `read_text(path)` — a file's contents, for content that is read at BUILD time.
 *
 * Deliberately text only, and deliberately synchronous: this is called from a
 * loader during pre-rendering, where a promise buys nothing and a missing file
 * should stop the build with the path in the message.
 */
export function read_text(path: string): string {
  // Resolved lazily so the module can be TYPED and imported in a project that
  // never calls it; a static `import fs` would make every consumer pull node:fs.
  const req = (globalThis as any).require
  if (typeof req !== 'function') {
    throw new Error('hydra/server: read_text() is not available in this runtime')
  }
  const fs = req('node:fs')
  try {
    return fs.readFileSync(path, 'utf8')
  } catch (e: any) {
    throw new Error(`hydra/server: cannot read ${path} — ${e && e.message ? e.message : e}`)
  }
}

export default { env, env_require, public_env, read_text }

/* -------------------------------------------------------------- action flow
 *
 * An `action` handles a mutation: it runs on the server when the browser POSTs
 * the form, and returns either a redirect or data for the page.
 *
 * What this deliberately is NOT: it is not a client-side function. A `.server.hys`
 * is not in the client bundle, so `action` cannot be called from a component
 * handler — the component uses a `<form method="post">`, which is what makes the
 * flow work with JavaScript disabled and what makes the server the only place
 * the mutation can happen.
 */

export interface ActionResult {
  /** Where to send the browser next. */
  redirect?: string
  /** 303 by default: POST-then-GET, so a refresh does not repost. */
  status?: number
  /** Data to return instead of redirecting. */
  data?: any
}

/**
 * `redirect("/path")` — the return value an action uses to send the browser on.
 *
 * A plain object, not a thrown exception: a thrown redirect is the shape that
 * makes an action impossible to test, and this compiler has no exception-based
 * control flow to spare.
 */
export function redirect(path: string, status = 303): ActionResult {
  if (typeof path !== 'string' || path === '') {
    throw new Error('hydra/server: redirect() needs a path')
  }
  // A redirect status, checked where the value is MADE. The runtime already
  // refuses to write a non-3xx as a redirect, but that happens after the action
  // has run: the page sees a 303 to nowhere and there is no line to blame. `200`
  // here is the common typo (`redirect('/login', 200)` reads as "it worked"),
  // and answering it as a redirect at all is the wrong fix.
  if (![300, 301, 302, 303, 307, 308].includes(status)) {
    throw new Error(
      `hydra/server: redirect() status must be 301, 302, 303, 307 or 308, not ${status}`,
    )
  }
  // A reload loop is the usual cause of an empty or `/`-only target in a real
  // app, and the browser spins instead of the developer seeing why.
  if (/[\r\n\0]/.test(path)) {
    throw new Error('hydra/server: redirect() target contains CR/LF or NUL')
  }
  return { redirect: path, status }
}

/**
 * `fail(status, data)` — an action that refuses, with the data the page needs to
 * explain why. The page receives it as `action_data`.
 */
export function fail(status: number, data: any = null): { status: number; data: any } {
  return { status, data }
}
