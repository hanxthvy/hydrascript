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

/* ------------------------------------------------------------------ headers
 *
 * A loader, an action and an API handler all receive one `event` object, and
 * none of them owns the response. Setting a cookie used to be impossible from
 * any of the three: `Set-Cookie` appeared nowhere in this package, so every
 * project that needed a login hand-rolled a second HTTP layer beside the one
 * the framework already had.
 *
 * What these functions do is append to a list on the event. The runner flushes
 * that list onto the response right before `writeHead`, which is the only
 * moment it can be done safely — and the one place that can drop cookies for a
 * 5xx, because a failing request must not rewrite the visitor's session.
 */

/** The per-request header list, created on first use. */
function headerBag(event: any): any[] {
  if (!event || typeof event !== 'object') {
    throw new Error('hydra/server: expected the event argument (the one your loader/action receives)')
  }
  if (!Array.isArray(event._headers)) event._headers = []
  return event._headers
}

/** `set_header(event, "X-Thing", "1")` — any response header, from a handler. */
export function set_header(event: any, name: string, value: any): void {
  headerBag(event).push([String(name), String(value)])
}

function requestHeaders(event: any): any {
  if (!event || typeof event !== 'object') return {}
  if (event.headers && typeof event.headers === 'object') return event.headers
  if (event.request && event.request.headers) return event.request.headers
  return {}
}

function parseCookieHeader(header: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof header !== 'string' || header === '') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

export interface CookieOptions {
  /** Default `/`. A cookie without a path is sent only to the path that set it. */
  path?: string
  /** Seconds. 0 or a negative number expires it now. */
  maxAge?: number
  /** Epoch milliseconds, or a `Date`. */
  expires?: number | Date
  /** Default true — a cookie the page's own JavaScript can read is a stolen session. */
  httpOnly?: boolean
  /** Default false, so dev over plain HTTP works. Set it in production. */
  secure?: boolean
  /** Default `Lax`: sent on navigation, not on a cross-site POST. */
  sameSite?: 'Lax' | 'Strict' | 'None' | 'lax' | 'strict' | 'none'
  domain?: string
}

function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${opts.path || '/'}`)
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${Math.trunc(opts.maxAge)}`)
  if (opts.expires !== undefined) {
    const when = opts.expires instanceof Date ? opts.expires : new Date(Number(opts.expires))
    parts.push(`Expires=${when.toUTCString()}`)
  }
  const sameSite = (opts.sameSite || 'Lax').toLowerCase()
  parts.push(`SameSite=${sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax'}`)
  if (opts.httpOnly !== false) parts.push('HttpOnly')
  if (opts.secure === true) parts.push('Secure')
  return parts.join('; ')
}

export interface CookieJar {
  get(name: string, fallback?: string | null): string | null
  has(name: string): boolean
  all(): Record<string, string>
  set(name: string, value: string, options?: CookieOptions): void
  delete(name: string, options?: CookieOptions): void
}

/**
 * `cookies(event)` — read the request's cookies, write the response's.
 *
 * `set` writes the `Set-Cookie` header at the moment it is called; the value
 * reaches the browser with whatever response the handler ends up producing. A
 * handler that throws after calling `set` does not send the cookie, because the
 * runner drops cookies for a 5xx.
 */
export function cookies(event: any): CookieJar {
  const bag = headerBag(event)
  const found = parseCookieHeader(requestHeaders(event).cookie)
  // The jar's OWN properties are the cookie values. That is not cosmetic: the
  // compiler rewrites `.get(key, default)` into a dict read (`dict_get`), the
  // way Python's `dict.get` means, so a jar that kept its values behind a
  // closure answered `undefined` for every key a `.hys` file asked for. Making
  // the values properties is what makes `jar.get("sid")`, `jar["sid"]` and
  // `"sid" in jar` all mean the same thing — which is how the rest of the
  // language already behaves for dicts.
  const jar: any = {}
  for (const [name, value] of Object.entries(found)) {
    // A cookie called `set` must not replace the method that writes cookies.
    if (name === 'get' || name === 'has' || name === 'all' || name === 'set' || name === 'delete') continue
    jar[name] = value
  }
  // One `Set-Cookie` per cookie name. Two writes for the same name in one
  // response are not two cookies; a browser keeps one of them and which one is
  // not something a caller should have to know. `session().set(a)` followed by
  // `.set(b)` therefore replaces the header instead of stacking a second one
  // that may be applied first.
  const dropNamed = (name: string) => {
    const prefix = `${name}=`
    for (let i = bag.length - 1; i >= 0; i--) {
      const [headerName, headerValue] = bag[i]
      if (String(headerName).toLowerCase() !== 'set-cookie') continue
      if (String(headerValue).startsWith(prefix)) bag.splice(i, 1)
    }
  }
  jar.get = (name: string, fallback: string | null = null) => {
    if (Object.prototype.hasOwnProperty.call(found, name)) return found[name]
    return Object.prototype.hasOwnProperty.call(jar, name) ? jar[name] : fallback
  }
  jar.has = (name: string) => Object.prototype.hasOwnProperty.call(found, name)
  jar.all = () => ({ ...found })
  jar.set = (name: string, value: string, options: CookieOptions = {}) => {
    dropNamed(String(name))
    bag.push(['Set-Cookie', serializeCookie(String(name), String(value), options)])
    if (!(String(name) in { get: 1, has: 1, all: 1, set: 1, delete: 1 })) jar[String(name)] = String(value)
  }
  jar.delete = (name: string, options: CookieOptions = {}) => {
    dropNamed(String(name))
    bag.push([
      'Set-Cookie',
      serializeCookie(String(name), '', { ...options, maxAge: 0, expires: new Date(0) }),
    ])
    delete jar[String(name)]
  }
  return jar as CookieJar
}

/* --------------------------------------------------------------- sessions
 *
 * A session is a signed cookie, and nothing more. No store, no id, no server
 * memory: the data lives in the cookie and the signature is what makes it
 * unforgeable. That has consequences worth stating in the open:
 *
 *   - It is `HttpOnly`, so the page cannot read it.
 *   - It is NOT encrypted. Anything in it is base64 to whoever holds it, which
 *     is why the docs say "ids, roles, a username" and never "a password".
 *   - It does not grow: a cookie is 4 KB for the whole header.
 *   - It survives a restart and works across instances without a store.
 *
 * HMAC-SHA256 is implemented below rather than imported, because this module is
 * bundled for a Node target and also type-checked in projects where `node:crypto`
 * is not resolvable. It is compared against `node:crypto` in the test suite —
 * a home-made MAC that disagrees with the real one is the worst possible bug
 * here, so the agreement is measured, not assumed.
 */

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

function sha256(bytes: Uint8Array): Uint8Array {
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  const len = bytes.length
  const total = (((len + 9) / 64) | 0) * 64 + (((len + 9) % 64) ? 64 : 0)
  const buf = new Uint8Array(total)
  buf.set(bytes)
  buf[len] = 0x80
  const view = new DataView(buf.buffer)
  // 64-bit big-endian bit length. The high word is below 2^32 for any message
  // shorter than 512 MB, which is the only kind that can be signed here.
  view.setUint32(total - 8, Math.floor(len / 0x20000000), false)
  view.setUint32(total - 4, (len << 3) >>> 0, false)

  const W = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + SHA_K[i] + W[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e
      e = (d + t1) >>> 0
      d = c; c = b; b = a
      a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false)
  return out
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function hmacSha256(key: string, message: string): Uint8Array {
  let k = utf8(key)
  if (k.length > 64) k = sha256(k)
  const ipad = new Uint8Array(64)
  const opad = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] : 0
    ipad[i] = b ^ 0x36
    opad[i] = b ^ 0x5c
  }
  const msg = utf8(message)
  const inner = new Uint8Array(64 + msg.length)
  inner.set(ipad)
  inner.set(msg, 64)
  const innerHash = sha256(inner)
  const outer = new Uint8Array(96)
  outer.set(opad)
  outer.set(innerHash, 64)
  return sha256(outer)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function b64urlEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)]
    if (i + 1 < bytes.length) out += B64[((b1 & 0x0f) << 2) | (b2 >> 6)]
    if (i + 2 < bytes.length) out += B64[b2 & 0x3f]
  }
  return out
}

function b64urlDecode(text: string): Uint8Array | null {
  const clean = String(text).replace(/=+$/, '')
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) return null
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v === -1) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

/** `sign(value, secret)` — `value.signature`, both base64url. */
export function sign(value: string, secret: string): string {
  return `${b64urlEncode(utf8(value))}.${b64urlEncode(hmacSha256(secret, value))}`
}

/** `unsign(signed, secret)` — the value, or `null`. Never throws on a forgery. */
export function unsign(signed: string, secret: string): string | null {
  if (typeof signed !== 'string') return null
  const dot = signed.lastIndexOf('.')
  // `dot === 0` is a legal value: signing the empty string produces `.mac`,
  // and refusing to verify what this module itself produced is the kind of
  // asymmetry that shows up as "one request had no session".
  if (dot < 0) return null
  const payload = b64urlDecode(signed.slice(0, dot))
  const mac = b64urlDecode(signed.slice(dot + 1))
  if (!payload || !mac) return null
  const raw = new TextDecoder().decode(payload)
  const expected = hmacSha256(secret, raw)
  if (expected.length !== mac.length) return null
  // Length-independent comparison is not the point here (a network attacker
  // cannot see per-byte timing over an HTTP response), but an early return on
  // the first differing byte is a habit worth not having in a MAC check.
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ mac[i]
  return diff === 0 ? raw : null
}

export interface SessionOptions {
  /** Required. There is no default secret, and a guessable one is worse than none. */
  secret: string
  /** Cookie name. Default `hydra_session`. */
  name?: string
  /** Seconds. Default seven days. */
  maxAge?: number
  path?: string
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
}

export interface Session {
  /** Read one key, or the whole session when called with no argument. */
  get<T = any>(key?: string, fallback?: T): any
  set(key: string, value: any): void
  delete(key: string): void
  /** Forget everything and expire the cookie. */
  clear(): void
  /** Replace the data and write the cookie once. */
  update(data: Record<string, any>): void
}

const SESSION_METHODS = new Set(['get', 'set', 'delete', 'clear', 'update'])

/**
 * Copy the session's data onto the object the caller holds.
 *
 * Same reason as the cookie jar: `s.get("user")` is compiled to a dict read,
 * so the values have to be own properties of the session object. A key that
 * collides with a method name (`get`, `set`, …) stays reachable through
 * `s.get("get")` and never replaces the method.
 */
function syncInto(view: any, data: Record<string, any>): void {
  for (const k of Object.keys(view)) {
    if (!SESSION_METHODS.has(k)) delete view[k]
  }
  for (const [k, v] of Object.entries(data)) {
    if (!SESSION_METHODS.has(k)) view[k] = v
  }
}

function serializable(data: Record<string, any>, what: string): string {
  try {
    return JSON.stringify(data)
  } catch (e: any) {
    throw new Error(
      `hydra/server: the ${what} must be JSON-serializable — ${e && e.message ? e.message : e}`,
    )
  }
}

/**
 * `session(event, secret=...)` — a signed, `HttpOnly` cookie carrying a small
 * object, with `get` / `set` / `delete` / `clear`.
 *
 * Every mutation writes the cookie immediately, so a loader that grants a
 * session and an action that clears one do not need a second "commit" call that
 * everyone forgets. Signing is over the serialized payload, so a tampered value
 * reads as an empty session rather than a thrown error — an attacker gets the
 * public branch, not a 500.
 */
export function session(event: any, options: SessionOptions | string): Session {
  const opts: SessionOptions =
    typeof options === 'string' ? { secret: options } : options || ({} as SessionOptions)
  const secret = opts.secret
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error(
      'hydra/server: session() needs a secret of at least 16 characters — ' +
        'session(event, secret=env_require("SESSION_SECRET")), not a literal in the source',
    )
  }
  const name = opts.name || 'hydra_session'
  const jar = cookies(event)

  const raw = jar.get(name)
  let data: Record<string, any> = {}
  if (raw) {
    const verified = unsign(raw, secret)
    if (verified) {
      try {
        const parsed = JSON.parse(verified)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
      } catch {
        data = {}
      }
    }
  }

  const write = () => {
    const value = sign(serializable(data, 'session'), secret)
    jar.set(name, value, {
      maxAge: opts.maxAge === undefined ? 60 * 60 * 24 * 7 : opts.maxAge,
      path: opts.path,
      secure: opts.secure,
      sameSite: opts.sameSite,
    })
  }

  function sync() {
    syncInto(view, data)
  }

  const view: any = {
    get(key?: string, fallback: any = null) {
      if (key === undefined) return { ...data }
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback
    },
    set(key: string, value: any) {
      data[String(key)] = value
      // Serialize now, not at write time: a function or a circular object in a
      // session should fail at the line that put it there.
      serializable(data, `session value for ${JSON.stringify(String(key))}`)
      sync()
      write()
    },
    delete(key: string) {
      delete data[String(key)]
      sync()
      write()
    },
    clear() {
      data = {}
      sync()
      jar.delete(name, { path: opts.path })
    },
    update(next: Record<string, any>) {
      data = { ...(next || {}) }
      sync()
      write()
    },
  }
  syncInto(view, data)
  return view as Session
}

export default { env, env_require, public_env, read_text, cookies, session, set_header, sign, unsign }

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
