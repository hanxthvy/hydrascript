<!-- [xihanzu-NR] -->
# HydraScript 0.15.0 — Security & Robustness Audit

**Object:** `/root/project/hydra` @ `00c166d` (working tree), `package.json` 0.15.0.
**Date:** 2026-11-12.
**Method:** five parallel audits over disjoint layers (HTTP server, SSR/data/env,
Rust compiler, build & supply chain, production maturity). Every finding below was
either reproduced with a probe/curl/crafted input against a real build
(**CONFIRMED**) or derived from a complete code path read (**SUSPECTED**, stated as
such). Numbers such as `runner.mjs:3304` are line references in this tree.

**Nothing in the repository was modified by the audit.** Probe scripts and raw
per-area reports live in `/root/.hermes/cache/scratch/audit/` (`A-…md`, `B-…md`,
`C-…md`, `D-…md`, `E-…md`).

> Note on the working tree: `bin/hydra` and `bin/hydra.node` were already modified
> before the audit; the compiler auditor rebuilt `bin/hydra.node` to reproduce the
> N-API crash. Re-run `npm run build:compiler` before you next publish.

**Status (2026-11-12): every finding in §1–§4 is fixed in 0.15.1**, which carries no
public API change. The two suites are green — 291 unit + 137 integration Rust tests
and 255 Node tests in 33 files — and each regression test names the `SEC-*`/`L-*` id
it guards. The per-fix narrative is in [CHANGELOG.md](../CHANGELOG.md). Anything
listed in §5 as verified sound was left alone, and the one item deliberately not
implemented is L-12 (`multipart/form-data`): it is a feature, not a hardening, and
shipping it under a patch number would change what a body can be without a version
that says so.

---

## 0. Verdict

The compile layer is solid — no `unsafe` outside the N-API shim, zero third-party
crates, ~7,000 fuzz cases without a parser panic, deterministic output, real
UTF-8 discipline. The request layer is where the money is lost: **one request can
kill the process**, **one Suspense boundary can leak another user's loader data**,
and the SSR error page prints database credentials in production.

| Severity | Count | Headline |
|---|---|---|
| Critical | 2 | remote kill of the server; cross-request SSR data disclosure |
| High | 9 | secret leakage, symlink escape, compiler SEGV, code-execution via `.env`, unverified artifact execution, silent file destruction, CSP never applied, Θ(N²) compiler DoS, release from wrong commit |
| Medium | 19 | auth-gate downgrade, request forgery, resource exhaustion, build-time path escapes |
| Low | 20 | header hygiene, interop, cache and tooling correctness |

Independently, the maturity review puts it plainly: **shippable compiler, alpha
request layer, absent operational layer.** No cookies/sessions, no page middleware,
no caching/ISR/ETag, no access log, no config validation, no image/font pipeline.
See `docs/PRODUCTION-ROADMAP.md`.

---

## 1. Critical

### SEC-01 — A single request terminates the process (no error boundary on the request handler)

**Severity:** critical · **Area:** HTTP server · **CONFIRMED**

**Files:** `packages/cli/runner.mjs:3304` (handler), `:3413-3416` (action dispatch),
`:3222-3227` (write-then-serialize), `packages/cli/http.mjs:50-61` (`sendHttpIntent`),
`:123` (`sendError`), `packages/cli/api-routes.mjs:605-611`, `packages/cli/ssr.mjs:519-522`.

**Mechanism.** `http.createServer(async (req, res) => { … })` is an async function
with no outer `try/catch`, and there is no `process.on('uncaughtException')` /
`process.on('unhandledRejection')` anywhere in the package. Any throw after the first
`await` becomes an unhandled rejection, and Node's default (`--unhandled-rejections=throw`)
exits 1. Four independent triggers, all reachable from the network:

1. **Redirect with CRLF.** API middleware returns `{redirect: '/next\r\nSet-Cookie: pwn=1'}`.
   `sendHttpIntent` (`http.mjs:53`) hands it to `res.writeHead` *outside* the `try`
   in `handleApiRequest` (the `try` starts at `api-routes.mjs:645`). Node correctly
   throws `ERR_INVALID_CHAR` — no header injection — but the throw escapes the server
   callback.
2. **Action returning a circular object or a `BigInt`** (an ORM row with a
   back-reference, or a driver's `BigInt` count — exactly what "return the model"
   produces). `runner.mjs:3222` writes the 200 header, `:3223` runs
   `JSON.stringify(out)` which throws, the `catch` calls `sendError`, whose
   `writeHead` throws `ERR_HTTP_HEADERS_SENT` from inside the catch.
3. **Data endpoint with non-JSON loader data.** `ssr.mjs:519` sends headers, `:521`
   stringifies; same shape as (2).
4. **Stream/`readFileSync` errors** on static serving (`runner.mjs:3686, 3699, 3716`)
   — e.g. `EMFILE` under load, or a file replaced between `existsSync` and
   `createReadStream`.

**Evidence.**

```
GET /api/go  (middleware returns {redirect: '/next\r\nSet-Cookie: pwn=1'})
 -> ERR "socket hang up"   server alive: false  exit: 1
Error [ERR_INVALID_CHAR] at sendHttpIntent (http.mjs:53)
    at handleApiRequest (api-routes.mjs:608)
    at async Server.<anonymous> (runner.mjs:3391)
```

```
POST /  (action returns a self-referencing object) -> socket hang up
server alive: false  exitCode: 1
Error [ERR_HTTP_HEADERS_SENT] at sendError (http.mjs:123)
```

**Impact.** A supervisor restarts it; the next identical request kills it again.
The canonical login idiom `redirect('?next=' + query.next)` is enough. Not a 500 —
`exit 1`.

**Fix.** One wrapper at the boundary, not a `try` in each of eight branches:

```js
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[hydra] request failed:', err);
    if (res.headersSent) return res.destroy();
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
       .end('Internal Server Error');
  });
});
```

Also: serialize *before* committing headers (`const json = JSON.stringify(out)`
then `writeHead`), validate `Location` against `[\r\n]` → 400, attach
`s.on('error', () => res.destroy())` to every read stream, and log
`unhandledRejection` as a last resort.

---

### SEC-02 — Streaming SSR renders outside the request's async context: another user's loader data can appear in your HTML

**Severity:** critical · **Area:** SSR · **CONFIRMED** (structural replica + real `react-dom@19.3.0`; React is not installed in this repo, so a full `hydra build` was not possible)

**Files:** `packages/cli/ssr.mjs:420-423`, `packages/cli/router.mjs:958-983`,
`:1032-1034`, `runtime/hydra.ts:710-717`, `:719-726`, `:731-746`;
consumer `packages/cli/runner.mjs:3565-3583`.

**Mechanism.** The buffered path is correct: it renders *inside* `als.run`
(`ssr.mjs:319-323`). The streaming path wraps only the *element construction*:

```js
// ssr.mjs:420-423
const render = () => mod.renderSync(pattern, params, url, data);
const element = mod.withRequest
  ? React.createElement(() => mod.withRequest({ path: pattern, url, data }, render))
  : render();
```

`withRequest` is `als.run(seed, fn)`. The lambda returns a React element, so
`als.run` has already returned before React renders anything. Every hook below that
point (`use_path`, `use_params`, `use_loader`, `use_route_match`) calls
`currentSeed()`, which falls back to the **module-global** `ssr_seed` written by
`renderSync` (`router.mjs:964`). A `Suspense` boundary that resolves in a later task
therefore reads whatever global exists *then* — another request's `{pattern, url, data}`.

**Evidence.**

```
SINGLE: <h1>store=NULL global=/blog/one</h1>

A body: <!--$--><p>BOUNDARY seed=/account-B</p><!--/$-->
B body: <!--$--><p>BOUNDARY seed=/account-B</p><!--/$-->
LEAK (A shows B data)? true
```

**Impact.** Cross-tenant data disclosure on the primary SSR path, whenever a page
has a streaming boundary that does not resolve in the first flush and traffic is
concurrent. The runner prefers the streaming path for every navigation.

**Fix.** Wrap the *render*, not the element construction: create the
`renderToPipeableStream` inside `withRequest(seed, …)` so ALS propagates through the
async continuations. Remove the module-global fallback from any request-serving path
and clear the seed in a `finally`. Regression test must be concurrent — two streams,
one suspended — not the existing single-request `ssr-stream.test.mjs`.

---

## 2. High

### SEC-03 — SSR failures return the raw exception to the client in production

**Files:** `runner.mjs:3623-3653`; the policy it bypasses: `http.mjs:88-119`.
**CONFIRMED.**

`http.mjs` deliberately replaces 5xx detail with `"internal error"` + a correlation
ref in production. The SSR catch builds `detail = err.message + err.loaderStack` and
interpolates it into the HTML notice (`escapeHtml` only — escaping is the wrong
control; the leak is the *content*).

```
NODE_ENV=production  GET /dashboard -> 500
<div id="__hydra_ssr_error" …>connect ECONNREFUSED 10.0.0.5:5432
db=prod_users password=hunter2</div>
```

The same error through `/__hydra/data` correctly answered
`{"error":"internal error","code":"loader_threw","ref":"…"}`.

Compounding it: **`hydra serve` never sets `NODE_ENV=production`** (`runner.mjs:3853`
sets an env only for `runDev`), so the redaction policy is *off by default on the
documented production command*. Verified separately: `/api/boom` on `hydra serve`
returned `TOKEN_XYZ_9931 host=internal-db.local`; the same build under
`NODE_ENV=production` returned the masked body.

**Fix.** Export the existing predicate from `http.mjs` (`bolehBocorDetail`) and gate
`detail` on it; route the SSR notice through `errorBody()`. Set
`process.env.NODE_ENV ||= 'production'` in `runServe`, and emit a startup warning
when it is unset but HSTS is on.

---

### SEC-04 — Symlink escape from `dist/`: arbitrary file read on the public port

**Files:** `runner.mjs:3483-3488` (containment), `:3504` (dotfile check), `:3514`,
`:3716` (read). **CONFIRMED.**

Containment is `path.resolve(rootDir, '.' + urlPath)` + `startsWith(rootDir + sep)`.
That resolves `..` lexically but never resolves symlinks, and the read follows them.
`..` traversal is genuinely blocked; this is the remaining hole in the same guard.

```
dist/escape  -> /etc/passwd      GET /escape         200 "root:x:0:0:…"
dist/etcdir  -> /etc             GET /etcdir/passwd  200 "root:x:0:0:…"
```

Reachable whenever the artifact contains a symlink: `public/` copied verbatim,
`npm link`/monorepo layouts, an upload directory, a compromised dependency's
postinstall, or anyone with write access to the deploy artifact. Dotfile protection
does not help — the *link name* is checked and it is dot-free.

**Fix.** Compare real paths (`fs.realpathSync`) on both sides and serve from the
validated path; or `openSync(filePath, O_NOFOLLOW)` per segment. Catch `ENOENT` for
the 404 case.

---

### SEC-05 — Unbounded emitter recursion: 1.5 KB of source SEGFAULTs the host Node process

**Files:** `compiler-rs/src/emitter.rs:1281` (`Emitter::js`), `:1359`, `:1127`;
`compiler-rs/src/hx_target.rs:178`, `:254`; guard that misses it:
`parser.rs:23` (`MAX_DEPTH = 128`), applied only at `:1588`. **CONFIRMED.**

`MAX_DEPTH` counts recursive-descent nesting. Left-associative forms are parsed in
unbounded `while` loops — `postfix` (`parser.rs:1966`), `additive` (`:1791`),
`coalesce` (`:1621`), `or`/`and` (`:1641`/`:1661`) — each iteration wrapping the
previous node in a new `Box`. A 900-term chain produces a 900-deep left-leaning AST
while the depth counter never leaves 1. Emit then recurses once per node.

```
a = x.y.y.y … (900)      hydra --check  -> stack overflow, SIGABRT (rc -6)
release threshold: 868 ok / 873 crash — same for 1+1+… and f()()()
debug build: crashes at n=150

node -e 'h.compile(deep)'  -> Segmentation fault (exit 139) at n=1200
```

`Cargo.toml:29` sets `panic = "abort"`, and the cdylib is linked into Node — so the
crash takes down the editor, Vite dev server, or bundler that merely compiled an
untrusted file.

**Fix.** (a) Count *nodes*, not descent levels; cap chain length and return a
`CompileError`. (b) Make the `Attr`/`Call`/`Index` spine iterative, or compile on a
thread with an explicit large stack plus a node budget. (c) Additionally wrap the
N-API body in `catch_unwind` — which requires `panic = "unwind"` for the addon
profile, and cannot catch a stack overflow, so (a)/(b) are mandatory. Add these five
inputs as regression tests.

---

### SEC-06 — A repository's `.env` can redirect native compiler loading → code execution on `hydra build`

**Files:** `packages/cli/env.mjs:103`, `:134-141`; consumers
`runner.mjs:195-212` (`HYDRA_NATIVE`), `:224-232` (`HYDRA_COMPILER`),
`esbuild-plugin.mjs:59-60`. **CONFIRMED (mechanism); requires an untrusted checkout.**

`loadProjectEnv()` copies **every** key from `.env`, `.env.<mode>`, `.env.local`,
`.env.<mode>.local` into `process.env`, skipping only keys already in the real
environment. Nothing namespaces `HYDRA_*`. Downstream:

```js
const candidates = [process.env.HYDRA_NATIVE, path.join(compilerDir, 'hydra.node')];
for (const c of candidates) { if (fs.existsSync(c)) { try { return selfRequire(c); } … } }
```

So a repo shipping `.env` with `HYDRA_NATIVE=./x/hydra.node` plus that file gets the
native module `require`d — or `HYDRA_COMPILER=./x/hydra` gets it spawned with the
project's source on stdin — during `build`, `preview`, or `serve`. `HYDRA_COMPILER_DIR`
is protected (set in the parent by `bin/hydra.js:137`), the other two are not.

The same mechanism lets a shipped `.env` set `HYDRA_EXPOSE_ERRORS=1` and
`NODE_ENV=production` (`env.mjs:23-25` explicitly promises framework knobs are *not*
read from `.env`). That flips off 5xx redaction.

**Fix.** Drop `HYDRA_*` (and `NODE_ENV`, `PORT`) from `loadProjectEnv`, or allowlist
`PUBLIC_*` plus declared keys. Resolve the compiler location once, before `.env` is
read, and cache it. Document the build-time trust boundary in `SECURITY.md`.

---

### SEC-07 — The bootstrap publisher executes each artifact before verifying it

**Files:** `scripts/publish-platform-packages.mjs:390` → `:183` (`execFileSync(binPath, ['--version'])`);
verification only at `:402` (`verifyBinary`, defined `:216`). **CONFIRMED.**

`--dir` is "a directory of downloaded workflow artifacts"; the script runs whatever
executable file is at `<dir>/<target>/bin/hydra` — including a shell script with a
`#!` line, since `execFileSync` uses kernel exec — and only afterwards checks
container magic, arch, and size. The `catch` at `:190` swallows failure, so a
*successful* execution is silent.

**Impact.** A substituted or wrong artifact gets code execution as the publisher
(often root on a dev box, or a CI runner holding an OIDC publish identity) *before*
the checks the script advertises. The gate is inverted.

**Fix.** Call `verifyBinary()` first (pure reads), then `readBinaryVersion()`. Skip
the exec path entirely when `binaryArch()` disagrees with the host.

---

### SEC-08 — `hydra init` silently destroys existing project files

**File:** `compiler-rs/src/scaffold.rs:1312` (guard covers only `hydraconfig.json`),
write loop `:1456`. **CONFIRMED.**

```
$ cat package.json → {"name":"keep-me","dependencies":{"left-pad":"1.0.0"}}
$ echo 'MY README' > README.md ; echo 'a = 1' > src/main.hyx
$ hydra init . --yes --template=blank --layout=single --styling=plain
  created ./hydraconfig.json
  created ./package.json     ← left-pad gone
  created ./README.md        ← author's README gone
  created ./src/main.hyx     ← author's source gone
```

`--force` exists but is not required. Running `init` in an existing or half-set-up
project is a plausible mistake with unrecoverable loss.

**Fix.** Build the file list, filter to non-existent paths, refuse unless `--force`,
naming every collision (the same policy already used for `hydraconfig.json`).

---

### SEC-09 — `server.headers` (the documented CSP escape hatch) is applied only to static files

**Files:** `runner.mjs:3677-3680` is the only merge site; every other branch uses
`baseHeaders()` alone (`:2870-2884`). **CONFIRMED.**

With `"server": {"headers": {"Content-Security-Policy": "default-src 'self'", "X-Custom": "yes"}}`:
`GET /` carries both headers; `GET /blog/hello` (SSR), `GET /api/ping`, an action
POST, `/__hydra/data`, and a 404 carry neither. The README documents this key as the
way to set security headers.

**Impact.** Every project that believes it has a CSP does not have one on the
responses that render user data or answer APIs.

**Fix.** Hoist the `opts.headers` merge into `baseHeaders()` or into the single
`setHeader` loop at `:3310`, so all branches inherit it. Add a `{nonce}` substitution
so a CSP is expressible against the inline hydration JSON.

---

### SEC-10 — Quadratic time and memory on error-heavy input: 70 KB → 2.7 GB RSS

**Files:** `compiler-rs/src/parser.rs:83`, `lexer.rs:192, 231, 278, 310, 506`,
`lib.rs:77-125` (`parse_errors`), re-run by `main.rs:187` and `cli.rs:890`.
**CONFIRMED.**

`CompileError` owns `src: Vec<String>` — a full copy of every line. The recovering
lexer emits one diagnostic per bad line, so N bad lines in an N-line file is Θ(N²)
owned strings; `parse_errors` then does `retain` with `lex_lines.contains(…)` per
error (another O(n²)).

```
1000 lines   0.41 s   110 MB
2000 lines   1.30 s   432 MB
4000 lines   2.78 s  1756 MB
5000 lines   7.67 s  2679 MB   (70 KB input)
20000 lines   168 s  OOM-killed (rc -9), 280 KB input
```

**Impact.** Remote DoS for anything compiling untrusted input: the Vite plugin, an
editor LSP, CI linting a PR.

**Fix.** `Arc<[String]>` / `Arc<SourceFile>` shared by all diagnostics, formatted
lazily; a `HashSet` of lex-error lines built once; cap retained diagnostics (e.g.
100, then "…and N more"). Apply the same bound to the recursive JSON writer
(`tools.rs:1066`).

---

### SEC-11 — Release publishes the wrong commit, and a dry run still publishes

**Files:** `.github/workflows/release.yml:50-52`, `:78`, `:220-274`;
`binaries.yml:18-27`. **CONFIRMED (mechanism).**

- `workflow_run` on `binaries` with only a `conclusion != 'success'` gate. There is
  no `environment:` (no required reviewer) and no check of the triggering event.
  `inputs.dry_run` is **empty** for `workflow_run`, so `if: !inputs.dry_run` at
  `:269` is true — a `binaries` run dispatched with `dry_run: true` still publishes
  `hydrascript@latest`. The "dry run" step at `:276-278` is unreachable for that event.
- `checkout@v4` with no `ref:` (`:78`) materialises the **default branch HEAD** on a
  `workflow_run` event, while the platform packages came from tag `vY`. The version
  is read from that checkout. `--provenance` then attests "built from commit X on
  main", which is not the tagged object.

Also on this chain: bootstrap publishes carry **no** `--provenance` (`D-02`);
verification is magic bytes + `e_machine` only; the version gate is a substring
regex over the whole 1.4 MB binary (`:207-209`) and therefore coincidence-prone; OTP
is passed in `argv` to both `npm publish` *and* `npm view` (`:103-105`, `:260`,
`:304`) where `/proc/<pid>/cmdline` exposes it to any local user.

**Fix.** Gate the job on `github.event.workflow_run.event == 'push'` (tags only),
honour an explicit `dry_run` input for both events, add `environment: npm-release`
with required reviewers. Check out `github.event.workflow_run.head_sha` and assert
`git describe --tags --exact-match == v${version}` before publishing. Emit and verify
a `SHA256SUMS` manifest; add `--provenance` to the bootstrap path; pass OTP via
`NPM_CONFIG_OTP` in `child.env` and drop it from `npm view` entirely.

---

## 3. Medium

### SEC-12 — `/__hydra/data` ignores `httpIntent`: auth refusals become HTTP 200

`ssr.mjs:516-538`. **CONFIRMED.** `handleDataRequest` calls `renderer.load(target)`
and serializes `out.data` directly; `httpIntent` is not imported there, though the
render path honors it (`ssr.mjs:342-345`, `:406-407`) and `http.mjs:13-14` claims
this call site exists.

```
loader returns redirect('https://evil.example/x')
GET /__hydra/data?url=/p → 200 {"data":{"redirect":"https://evil.example/x"}}
loader returns fail(401, {secret:'private'})
GET /__hydra/data?url=/p → 200 {"data":{"status":401,"data":{"secret":"private"}}}
```

A loader used as an auth gate answers the client-navigation endpoint with 200 and the
refusal object as page props; the client treats 200 as `status:'ready'`. **Fix:** the
same three lines the render path already has, before serializing.

### SEC-13 — `/__hydra/data` drops the request object: header-based guards diverge

`ssr.mjs:529` (no `{request}`) vs `:312` and `runner.mjs:3550-3552`
(`requestFor(req, …)`). **CONFIRMED by reading.** The fabricated fallback
(`router.mjs:856-859`) has `headers: {}`. A loader reading `cookie`/`authorization`
sees the real value on first paint and an empty object on client navigation — so a
guard either denies wrongly or silently serves the public branch. **Fix:**
`renderer.load(target, { request: requestFor(req, target, '') })`.

### SEC-14 — `String.replace` replacement-string injection in head and hydration payload

`meta.mjs:251-254, 258-264, 271, 286-290, 303-308`; `ssr.mjs:65-75` (twin
`runner.mjs:731-732`). **CONFIRMED.** `escapeHtml` escapes `& < > "` but not `$`, and
every insertion is `html.replace(re, tag)` where `tag` embeds the value. `$&`, `` $` ``,
`$'` therefore splice document text into the tag.

```
applyMeta(shell, {title: "A$&B"})     → <title>A<title>Old</title>amp;B</title>
applyMeta(shell, {description:"D$`E"}) → <meta content="D<html><head>…E" />
GET /blog/$&$' …                       → __hydra_data__ JSON contains </body></html>
```

`injectData` needs only the query string (`?q=$'`) — no loader involvement — and the
result is an unparseable hydration payload (blank data-dependent page). `applyMeta` is
reachable from `generateMetadata`, i.e. from database content. **Fix:**
`html.replace(re, () => tag)` in both files. One character, kills the class.

### SEC-15 — `server.bodyLimit: "10mb"` silently removes the limit for actions

`actions.mjs:231-262` compares `size > limitBytes` with no coercion;
`runner.mjs:3414` passes `opts.bodyLimit` raw, while `api-routes.mjs:562` correctly
requires `Number.isInteger`.

```
1.5 MB POST, no config         -> 413 {"code":"body_too_large","limit":1048576}
1.5 MB POST, bodyLimit:"10mb"   -> 200   (no limit at all)
```

The whole body is buffered, then `Buffer.concat`'d and `.toString('utf8')`'d — ~3×
peak. **Fix.** Parse once at the top of `serveDirectory` into a number; throw a
`TypeError` inside `readBody` for non-numbers (loud beats silent).

### SEC-16 — API route params are never percent-decoded, and the two layers disagree

`runner.mjs:3391` passes the raw URL; `api-routes.mjs:555` slices at `?` and matches
without decoding; `runner.mjs:3363` decodes for its own routing and actions.

```
/api/users/%61dmin    -> params.id === "%61dmin"
/api/users/john%20doe -> params.id === "john%20doe"
/api/users/a%2Fb      -> params.id === "a%2Fb"
```

An authorization check written as `params.id === 'admin'` is bypassed by `/%61dmin`
whenever the handler normalizes. **Fix.** Decode once in the runner and pass the
already-computed `reqPath`; keep `rawUrl` only for the proxy. Document that `params`
are decoded exactly once.

### SEC-17 — CSRF check compares `Origin` to the attacker-controlled `Host`

`runner.mjs:3138-3152`. **CONFIRMED.**

```
POST Origin=http://evil.example                      -> 403
POST Origin=null                                     -> 403
POST Origin=http://evil.example  Host=evil.example   -> 200   ← DNS rebinding
```

The reasoning elsewhere in the function is careful (`Origin: null` refused,
unparseable refused, GET/HEAD/OPTIONS exempt). But a host comparison cannot
authenticate: a rebinding attacker makes both headers agree. **Fix.** Compare against
a deployment-declared allowlist (`server.allowedOrigins`, default the configured
host:port), reject when a cookie/session is present and `Sec-Fetch-Site` is
`cross-site`/`same-site`, or require a per-session token.

### SEC-18 — `trustProxy` exact-string matching never matches IPv4-mapped peers

`runner.mjs:3271-3298`. **CONFIRMED.**

```
bind=127.0.0.1 trustProxy="127.0.0.1"        -> 200,200 (honoured)
bind=::        trustProxy="127.0.0.1"        -> 200,429 (silently ignored)
bind=::        trustProxy="::ffff:127.0.0.1" -> 200,200
```

Fail-closed, so not a bypass — but behind a localhost proxy on a dual-stack bind, all
users collapse into one rate-limit bucket and then everyone gets 429. No CIDR support
either. **Fix.** Strip `::ffff:` before comparing, and support CIDR with
`net.BlockList`. Log once at startup if a configured proxy address never matches.

### SEC-19 — HMR WebSocket accepts any Origin, any path prefix, unlimited clients

`hmr.mjs:40-72`. **CONFIRMED.**

```
ws /__hydra/hmr   Origin: https://evil.example -> 101
ws /__hydra/hmrx                              -> 101
ws /__hydra/hmr?x=1                           -> 101
clients registered: 3 (all unauthenticated)
```

Any page the developer visits can subscribe and receive build error text (compiler
output naming absolute source paths and snippets). Dev-only, but the dev server is the
LAN-exposed one (`--host 0.0.0.0`). **Fix.** Exact path match, origin check against
`Host`, cap at ~32 clients.

### SEC-20 — No request/body timeouts and no connection cap

`runner.mjs:3304` sets none of `headersTimeout`/`requestTimeout`/`timeout`/
`maxConnections`; `readBody` has no deadline. A POST that sends one byte and stops
parks the request until Node's 300 s default. **Fix.** `headersTimeout = 15s`,
`requestTimeout = 30s`, `timeout = 30s`, `maxConnections = 1024`, plus a body
deadline — all overridable from `server.*`.

### SEC-21 — gzip computed synchronously per request on the event loop

`runner.mjs:3696-3713`: `fs.readFileSync` + `zlib.gzipSync`, uncached. Two hundred
concurrent gzip requests for one file serialise N full reads and N full compressions
while every other request waits. **Fix.** Async `zlib.gzip` plus a bounded
`Map<path+mtime, Buffer>`, or precompress at build time and serve `.gz`.

### SEC-22 — `hydra init` writes through symlinks (arbitrary overwrite)

`scaffold.rs:1456` uses `fs::write`, which follows symlinks and truncates.

```
echo "PRECIOUS SECRET" > victim.txt
cd proj && ln -s ../victim.txt package.json
hydra init . --yes …   -> ../victim.txt now starts with "{"
```

**Fix.** `OpenOptions::create_new` for non-`--force` writes; under `--force`,
`symlink_metadata` to refuse symlink destinations and require
`parent().canonicalize()` inside the target root.

### SEC-23 — `hydra watch`/`build` writes generated files outside `watch-out/`

`cli.rs:476-479`: `path.strip_prefix("src").unwrap_or(path)`, then
`Path::new("watch-out").join(abs)` — joining an absolute path **replaces the base**,
so the `.tsx` lands next to the source and clobbers any authored file. Confirmed with
`hydra watch ../target_dir/evil.hyx` → `../target_dir/evil.tsx` written. **Fix.**
Reject non-relative or `..`-containing results; fall back to the file name under
`watch-out/`.

### SEC-24 — `hydra clean` deletes whatever `outputDir` names, including `src/`

`tools.rs:673`, guard `:694`, deletion `:713-717`. Containment against escape is
correct (verified: `../victim`, absolute outside paths, and out-of-tree symlinks are
refused), but `{"outputDir":"./src"}` recursively deletes the source tree. **Fix.**
Reject targets that contain tracked source (`src`, `pages`, `components`, `.git`) and
require `--yes` when the resolved value is not `dist`/`build`/`out`.

### SEC-25 — Import specifiers read arbitrary files; `/dev/zero` hangs the compiler

`emitter.rs:911-937`, gated only by `is_package_specifier`; also `:807`.
`from "/dev/zero" import x` → still reading after 5 s (unbounded alloc in practice);
`from "../../../../etc/passwd" import x` reads out-of-tree (only "has export default"
and parameter names can influence output, so no exfiltration primitive). **Fix.**
`canonicalize()` + require the result inside the base dir; require
`metadata().is_file()` and `len() < 1 MiB`.

### SEC-26 — N-API boundary has no `catch_unwind`, aborts on panic, and accepts non-string args

`napi.rs:83-133`, `:66-73`, `Cargo.toml:29`. `panic = "abort"` inside a cdylib means
any panic (or the stack overflow of SEC-05) kills the host process; `h.compile(123, 456)`
returns a successful compile of `""` because the `napi_get_value_string_utf8` status is
ignored. **Fix.** `catch_unwind` + `{"error": …}`, a `[profile.addon]` with
`panic = "unwind"` used by `build:compiler`, and status checks that reject non-strings.

### SEC-27 — Recursive JSON config parser: 50 KB file aborts `hydra clean`/`analyze`

`tools.rs:1165` (`value`), `:1188`, `:1220`, reached from `:139`. Binary-searched
threshold: depth 21,671 ok, 22,054 crash. **Fix.** Track depth and return
`Err("nesting too deep")` past ~128, mirroring the parser's `MAX_DEPTH`.

### SEC-28 — `hydraconfig.json` is never validated, and the shipped schema is wrong

`runner.mjs:923-934` is a bare `JSON.parse` in a try/catch; a config with `porrt`,
`hostt`, `renderingg` and malformed `rendering` builds green at exit 0. Meanwhile
`schema.json` has `additionalProperties: false` but omits the `types` key that
`hydra init` itself writes (`scaffold.rs:883`), and rejects the `styling: {tailwind: true}`
object the scaffold emits. **Fix.** A dependency-free validator run at load, exit 2 on
failure, naming the key path; fix the schema/scaffold mismatch in the same change.

### SEC-29 — Compile cache entries are trusted as code

`compile-cache.mjs:146-177` returns `JSON.parse(file).code` straight to esbuild. The
key is a truncated `sha256(FORMAT, version, filename, extra, source)` and *does*
include the compiler-binary hash and dev/build mode, so collision is not the exposure —
**forgery** is: anyone who can pre-seed `.hydra/cache` for a known public source file
writes the exact entry and the build emits their code. Relevant to poisoned CI caches
and shared checkouts. **Fix.** Store `{source_sha256, res}` and verify on read with the
source you already have, or HMAC entries with a per-machine key.

### SEC-30 — `vite-plugin` resolves the compiler to `node_modules/bin/hydra`

`vite-plugin/index.js:44-46`: `path.join(HERE, '..', 'bin', 'hydra')` is a
`node_modules/`-shared path when installed standalone, then executed. Requires write
access to `node_modules` to exploit, so hygiene rather than escalation — but it is the
wrong root. **Fix.** `path.dirname(require.resolve('hydrascript/package.json'))`.

### SEC-31 — Proxy forwards hop-by-hop headers, client `X-Forwarded-*`, never aborts upstream

`runner.mjs:2962-2994`: `{...req.headers}` forwards `Connection`,
`Transfer-Encoding`, `Keep-Alive` and the client's own `X-Forwarded-For/-Proto/-Host`;
only `host` is rewritten; no `res.on('close', () => proxyReq.destroy())`. **Fix.**
Strip hop-by-hop and `proxy-*` on both directions, derive `x-forwarded-for` from the
socket, destroy the upstream request on client abort.

### SEC-32 — Non-GET verbs are served static content

`runner.mjs:3413`, `:3520-3667`. `TRACE`, `PUT`, `DELETE`, `OPTIONS` all answer 200
with `index.html`. No echo, so no XST, but scanners and monitors read success. **Fix.**
After action dispatch, `405 + Allow: GET, HEAD` for everything else.

### SEC-33 — Rate limiter fails open at 10 000 entries; `trustProxy: true` trusts every peer

`runner.mjs:3325-3345`, `:3273`. When the map is full and pruning is insufficient, a
new IP is marked `uncapped` and is not limited at all — a documented trade-off, but
combined with `trustProxy: true` any direct peer can rotate `X-Forwarded-For` to get a
fresh bucket each request *and* fill the map. **Fix.** LRU-evict the oldest entry
instead of serving uncapped; require `trustProxy` to be an address list/CIDR; expose a
store hook for multi-process.

### SEC-34 — OTP leaked through `argv`, and passed where it is not needed

`scripts/publish-platform-packages.mjs:103-105`, `:260`, `:304`. The file already
documents the `ps` exposure for `publish`; it also passes OTP to the read-only
`npm view`, widening the window to 14 invocations. **Fix.** `NPM_CONFIG_OTP` in the
child env; no OTP on `view`.

### SEC-35 — Remaining `.env` / compiler-authority issues

See SEC-06 for the code-execution path. Two smaller ones:
`hydra init` interpolates the directory name into generated HTML unescaped
(`scaffold.rs:717` → `:1386`) — stored XSS in a scaffolded page when the directory name
comes from an extracted archive; and `HYDRA_BINARY` pointing at a missing file returns
`null` and silently falls through to a *different* compiler (`bin/hydra.js:66-69`).
Both one-line fixes.

---

## 4. Low (grouped)

| ID | File | Issue |
|---|---|---|
| L-01 | `runner.mjs:3716` et al. | `createReadStream().pipe(res)` without an `'error'` handler; `readFileSync` throws inside the async handler (same fatal path as SEC-01) |
| L-02 | `runner.mjs:2865-2884`, `:2916` | No CSP by design; `.svg` served as `image/svg+xml` same-origin executes script as a top-level document — add `sandbox`/`attachment` for SVG |
| L-03 | `runner.mjs:3504-3512` | Dotfile rule has no `.well-known` exception → ACME HTTP-01 cannot validate |
| L-04 | `ssr.mjs:519-521` | Data endpoint sets no `Cache-Control`/`Vary`/`nosniff`; a shared cache can store one visitor's loader JSON |
| L-05 | `http.mjs:29-31`, `:52-54`; `runtime/server.ts:121-125` | `redirect()` accepts absolute/protocol-relative targets and any status; no 100–599 check in the redirect branch |
| L-06 | `router-core.js:86-99`; `router.mjs:103-112` | `[__proto__]` param silently dropped; `[...__proto__]` replaces the params object's prototype. Reject reserved names or use `Object.create(null)` |
| L-07 | `ssr.mjs:242-259` | `ensureFresh()` swaps bundle state under in-flight renders (dev-only mixed-version render) |
| L-08 | `ssr.mjs:443-471` | Stream head written before the shell is known good; no `handle.abort()` on client disconnect |
| L-09 | `runner.mjs:3568, 3598` vs `3596` | No ETag/Last-Modified/Range anywhere: HTML `no-cache` without a validator means unconditional 200s; no video/PDF seeking |
| L-10 | `runner.mjs:3686, 3699` | `Vary: Accept-Encoding` only on the compressed variant |
| L-11 | `runner.mjs:3105-3110` | Shutdown force-exits after 5 s with in-flight SSR cut; `/__hydra/healthz` stays 200 during drain |
| L-12 | `actions.mjs:301-303` | No `multipart/form-data` parser — uploads fall to hand-rolled parsers per project |
| L-13 | `error.rs:82-88` vs `lexer.rs:289, 331, 404` | Caret misaligned on non-ASCII lines (byte column treated as char column) |
| L-14 | `cli.rs:408-425` | `hydra check <dir>` follows directory symlinks; a `up -> ..` link reports the same file 41 times |
| L-15 | `ci.yml:15-29` | No `permissions:` block (release/binaries are correct: `contents: read`, `id-token: write`) |
| L-16 | `release.yml:98`, `binaries.yml:310`, `ci.yml:37` | `npm@^11.5.1` and `dtolnay/rust-toolchain@stable` unpinned inside the job holding `id-token: write`; pin exact versions/SHAs |
| L-17 | `package.json:74` | `optionalDependencies: {}` in the repo; only `release.yml` wires the seven platform packages. Guarded today by trusted publishing alone — assert it in `prepublishOnly` |
| L-18 | `scripts/publish-platform-packages.mjs:216-242` | Bootstrap verification is magic bytes + arch only; no checksum manifest, no `--provenance` (CI does both) |
| L-19 | `runner.mjs:3699` | `readFileSync` for gzip blocks the loop (see SEC-21) |
| L-20 | `scaffold.rs:717, 1386` | Project name into `<title>` unescaped (see SEC-35) |

---

## 5. Verified sound (do not re-open these)

Explicitly tested and found correct, so effort goes elsewhere:

**Static serving and headers.** `..` traversal in all encodings (`%2e%2e`, `..%2f`,
double-encoded) → 403; null bytes → 404, no crash; malformed `%` → 400; per-segment
dotfile blocking including the `path.basename` trap; no directory listing; no CORS
header anywhere (default-deny); base headers on every branch including 429 and errors;
cache-control split (`immutable` for hashed assets, `no-cache` for HTML, `no-store`
for SSR/data/health); compression length/Vary correctness on the compressed variant.

**Request handling.** API → proxy → actions → static ordering with correct fallthrough;
default 413 with `Connection: close`; XFF ignored unless `trustProxy` matches a direct
peer; rate-limit map bounded with prune-on-full; health endpoint exposes no config path;
`http.mjs` redaction design (the SSR path simply bypasses it, SEC-03).

**SSR and data.** Inline JSON escaping (`</script>`, `</SCRIPT >`, `<!--`, U+2028/9,
NUL all round-trip; nothing unparseable); `escapeHtml` plus allowlisted meta keys and
framework-built tag shapes; React output inserted by concatenation, never a replacement
string; no `dangerouslySetInnerHTML`/`innerHTML`/`eval` in `runtime/`; buffered SSR
concurrency; client trusting only payloads whose pattern and path match the URL;
route precedence (literal < param < catchall) with duplicate-URL build errors.

**Secrets.** `PUBLIC_*`-only client define — a non-public var in any client-reachable
module (including `.hys`) is a build error naming file + variable; no `process.env`
object define; `.env` parser has no interpolation, no shell expansion, correct comment
and `export` handling; `.env` precedence chain.

**Compiler.** ~7,000 fuzz cases (random token soup, byte mutations of all 28 examples,
truncation at ~150 offsets) with zero parser panics; recursion depth guard works for
genuinely nested forms at 128/3 000/20 000 levels; lexer UTF-8 boundary discipline
(emoji, CJK, combining marks, lone quotes, NUL, CRLF); **no `unsafe` outside `napi.rs`**
(5 sites, buffer sizing correct); **no shell invocation anywhere** — every `Command`
is argv-form, `hydra add/remove` filters leading `-`; `clean`'s canonicalize
containment; `fmt` idempotent and non-traversing; byte-identical deterministic output
across runs; zero third-party crates.

**Supply chain.** No `shell: true` in any production script; no
`preinstall`/`install`/`postinstall`/`prepare` hook in any package; no runtime binary
download; platform packages constrained by `os`/`cpu`/`libc` and resolved via
`require.resolve`, not PATH; lockfile 110/110 entries with `resolved` + `integrity`
from a single registry; `binaries.yml` not fork-triggerable and no PR/commit/branch
text interpolated into any `run:` block; release refuses on a failed binaries run and
on missing platform versions; compile-cache key includes the compiler binary hash and
dev/build mode, failures are never cached, writes are temp+rename, entries pruned at
2 000.

---

## 6. Fix order

1. **SEC-01, SEC-02** — stop the bleeding. One request must not kill the process; one
   render must not read another request's data. Both are small, surgical changes.
2. **SEC-03, SEC-09** — make production error output and security headers obey what
   the docs already promise. `serve` setting `NODE_ENV` is one line.
3. **SEC-05, SEC-27, SEC-10** — bound the compiler: node budget, JSON depth, shared
   source for diagnostics. These are the difference between "an editor can load a
   hostile file" and "an editor crashes".
4. **SEC-04, SEC-08, SEC-22-24** — filesystem honesty: realpath serving, no silent
   overwrite, no writes outside the output dir.
5. **SEC-06, SEC-07, SEC-11, SEC-34** — supply chain: scrub `HYDRA_*` from project
   `.env`, verify before exec, gate the release job, stop putting OTP in `argv`.
6. Everything in §3, then §4 opportunistically.

Findings here map onto the release plan in `docs/PRODUCTION-ROADMAP.md`: P0 is
SEC-01…03, 09 plus sessions and the error page; the rest slot into P1.
