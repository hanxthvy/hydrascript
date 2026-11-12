<!-- [xihanzu-NR] -->
# HydraScript — Production Roadmap (from 0.15 toward 1.0)

**Companion to** `docs/SECURITY-AUDIT-0.15.0.md`. That file is the defect list; this
one is the plan for "usable in something serious".

**Baseline:** 0.15.0, 418 Rust tests, 221 Node tests across 30 suites, all roadmap
targets marked shipped.

---

## 0. Verdict

> Shippable compiler. Alpha request layer. Absent operational layer.

If this were a car, the engine and gearbox are production quality and the brakes are a
promise in the manual.

**Production-grade today — defend, do not rewrite:**

- Native compiler and Python semantics. 418 tests, output self-validation before exit.
- Content-addressed compile cache (`sha256` over source, version, filename, compiler
  identity, dev/build); warm builds compile zero files.
- File router with real conflict detection (`[slug]`, `[...rest]`, groups,
  `_layout`/`_404`/`_error`, duplicate-URL build errors naming both files).
- Per-route SSG, static `404.html`, subpath `base`, per-route code splitting.
- `AsyncLocalStorage` request context on the buffered SSR path.
- Streaming SSR with honestly documented limits.
- Security baseline: `nosniff`, `Referrer-Policy`, `X-Frame-Options`,
  `Permissions-Policy` on every answer; `Origin` checks on actions and API mutations;
  per-segment dotfile block; bounded rate limiter with trusted-proxy handling.
- `PUBLIC_` secret split enforced over the compiled graph — a private var in a
  client-reachable module fails the build naming file + variable.
- Seven-target binary distribution, version-drift CI, tarball-in-CI install test,
  runtime gate in a real browser over CDP.

**Usable today for:** content sites, docs, marketing pages, static SSG,
read-only dashboards without auth.

**Not usable today for:** anything with a login, a database write, or an on-call
rotation.

---

## 1. What is missing, in one screen

| Capability | Hydra today | Consequence |
|---|---|---|
| Cookies / sessions / auth primitives | **absent** — `Set-Cookie` appears nowhere in `packages/` or `runtime/` | every project hand-rolls auth; the most error-prone code in any app |
| Page middleware | `/api` only (`runner.mjs:3386`); an action POST bypassed a 403 middleware in testing | no way to guard `/dashboard` at all |
| Request lifecycle hooks | none (`onRequest`, `onError` do not exist) | no logger, tracer, request id, error reporter |
| Config validation | none — unknown keys and wrong types silently ignored (`runner.mjs:923-934`) | `porrt`, `hostt`, `renderingg` build green; scaffold violates its own schema |
| Caching / ISR / revalidate | none; SSR is always `no-store` | every page hits the database on every request |
| ETag / 304 / Range | none | no revalidation, no seeking in video/PDF |
| Error boundaries server-side | client-only `_error.hyx`; SSR failure may return another page's HTML with status 500 | error pages are fiction |
| Error reporting | `console.error` and a random ref | no Sentry/hook, no mapped stack frames |
| Images / fonts | esbuild file loader only | no `srcset`, no lazy, no font preload/subset; Core Web Vitals suffer |
| Typed routes / `hydra` module types | props-only `.d.ts`, generated on demand; `import {state} from 'hydra'` fails `tsc` with TS2307 | TS projects break at the boundary the README advertises |
| Test harness | component + snapshot only, no DOM, no route/loader/action testing | you cannot test the thing that breaks |
| i18n / a11y / perf budget / codemods / docs site | none | adoption ceiling at 1.0 |
| Deployment | `static` + `node` only, single process, 5 s hard shutdown | no graceful drain; artifact requires the source tree |

Two documented claims are false in ways that matter and were reproduced with curl:

1. `server.headers` (the CSP escape hatch) is applied **only** to static files — SSR,
   API, actions, the data endpoint, and 404s miss it (SEC-09).
2. `hydra serve` does not set `NODE_ENV=production`, so 5xx masking is off on the
   documented production command (SEC-03).

---

## 2. Where Hydra is genuinely ahead

Worth protecting, and worth saying in the README with evidence:

- **Compiler diagnostics as a product.** `hydra check` warns on unbound names with a
  "did you mean", and `--strict` runs inside `hydra build`, so a name no runtime
  provides fails the build instead of shipping a `ReferenceError`.
- **Honest build-time gap reporting.** `--target static` names every dropped API route
  and every route it could not pre-render.
- **Deterministic, sub-millisecond in-process compile** with a content-addressed cache.
- **The runtime gate** — builds, then loads every produced page in a real browser and
  fails on an uncaught error. Stronger than most frameworks do by default.

These are the reasons to keep going. The gap is not the compiler.

---

## 3. Roadmap

Every item names the files to touch and the acceptance test that proves it done.
Sequencing: P0 is one release ("server honesty"), P1 is the next, P2 is adoption.

### P0 — before the word "production" appears anywhere

**P0-1 · Stop the process-killing request path.** *(SEC-01)*
`runner.mjs:3304` — wrap the handler in a `handle(req,res).catch(...)` boundary that
destroys the response when headers are sent; serialize before `writeHead` at
`:3222`, `:3223`, `ssr.mjs:519-521`; reject CRLF in `Location` at `http.mjs:53`;
attach `'error'` handlers to every read stream.
*Accept:* the four existing crash repros return 500/400 and the process stays alive;
a test asserts `server.listening === true` after each.

**P0-2 · Fix the streaming SSR data leak.** *(SEC-02)*
`ssr.mjs:420-423` — render inside `withRequest`, remove the module-global seed
fallback from request paths, clear the seed in `finally`.
*Accept:* a test with two concurrent streams where one suspends asserts request A's
body never contains B's URL or loader values.

**P0-3 · Production mode is the default for `serve`.** *(SEC-03)*
`runServe` (`runner.mjs:3036`) sets `NODE_ENV ||= 'production'`; `HYDRA_DEV=1` is the
documented override; the SSR notice routes through `errorBody()`.
*Accept:* `GET /api/boom` and an SSR loader throw return masked bodies containing a
ref and no substring of the thrown message.

**P0-4 · Apply configured headers everywhere, plus CSP nonce support.** *(SEC-09)*
Hoist the `opts.headers` merge into `baseHeaders()` or the single `setHeader` loop at
`:3310`; support `{nonce}` so a policy can be written against the inline hydration
JSON.
*Accept:* with one config, both headers appear on `/`, an SSR route, `/api/*`, an
action POST, `/__hydra/data`, and a 404 — six assertions.

**P0-5 · Validate `hydraconfig.json`.** *(SEC-28)*
New `packages/cli/config.mjs`, zero-dependency validator driven by `schema.json`
(types, enums, `additionalProperties`), called from `readConfig` and every command.
Malformed JSON exits 2 instead of building on defaults. Fix the schema/scaffold
mismatch (`types`, `styling.tailwind`).
*Accept:* `{"porrt":1}`, `{"server":{"port":"x"}}`, and a brace-broken file each exit 2
naming the key; the exact output of `hydra init --yes` validates against `schema.json`.

**P0-6 · Cookies and sessions as first-class primitives.**
`runtime/server.ts`: `cookies(event)` → `{get,set,delete}` and
`session(event,{secret,maxAge})` with HMAC signing and `HttpOnly; Secure; SameSite=Lax`
defaults; `requestFor` parses `cookie` into a map (`actions.mjs`); a response-header
collector threaded through `ssr.mjs` and flushed by the runner; `SESSION_SECRET`
required in production.
*Accept:* a loader's `cookies(event).set("sid","abc")` produces the right `Set-Cookie`;
a second request reads it back; a tampered session cookie yields `null`, not a throw;
a 5xx emits no `Set-Cookie`.

**P0-7 · A real SSR error page.**
The notice is currently injected only when the shell contains a literal
`<div id="root"></div>`; with a pre-rendered shell, `/blog/boom` returned the **home
page body** with status 500 and no notice.
*Accept:* a loader throw on a pre-rendered project returns 500 containing
`__hydra_ssr_error` or the `_error` page, and not the home page's headline.

**P0-8 · One portable `node` artifact contract.**
Require `.hydra/{server,api,actions}.cjs`, `build.json`, `dist/`, and `react`/
`react-dom` at runtime — nothing from `src/`. Add `scripts/serve-smoke.sh` that
copies exactly those into `mktemp -d` and serves them.
*Accept:* CI job `artifact: node` builds in the repo, rsyncs only those paths, serves,
and gets 200/303 on `/`, an SSR route, `/api/*`, and an action.

**P0-9 · Compiler robustness budget.** *(SEC-05, SEC-10, SEC-27)*
Node budget instead of an empirical `MAX_DEPTH`; shared `Arc<SourceFile>` for
diagnostics with capped error count; depth bound in the JSON parser; `catch_unwind`
plus a `panic = "unwind"` addon profile.
*Accept:* the five stack-overflow inputs and the 50 KB nested-config input return
`CompileError`; a 5 000-error file compiles in < 1 s and < 200 MB; a 60 s libFuzzer
target runs in CI (corpus = the 28 examples).

### P1 — before anyone runs this on call

**P1-1 · Middleware for every request.** Extend `src/middleware.hys` with
`{rewrite, redirect, headers, next}` before static resolution; keep API-only behaviour
behind a flag for one minor. *Accept:* `redirect("/login")` for `/dashboard` yields 303
on a page navigation; an `X-Test` header from middleware reaches the response.

**P1-2 · Observability seam.** `onRequest(event)` / `onError(event, err)` plus a
structured one-line access log (`method path status ms reqid`) and a
`X-Request-Id` echo. *Accept:* one JSON log line per request; a throwing loader calls
`onError` with route and status.

**P1-3 · Caching primitives.** `revalidate(event, seconds, tags?)`, a response cache
for `--target node`, `ETag`/304 on pre-rendered HTML honouring `If-None-Match`.
*Accept:* two GETs inside the window hit the loader once (counter assertion); 304 has
no body; `revalidate(...,0)` bypasses.

**P1-4 · Route-level test harness.** `hydra test --route /blog/x` running the real
loader + render in-process; optional DOM (`happy-dom`); `--filter`, `--watch`,
per-test timeout. *Accept:* a fixture asserts 303 for a redirecting loader and
`to_contain` for a happy path; `--filter` runs exactly one test.

**P1-5 · Typed route surface + `hydra` module declaration.** Generate `routes.d.ts`
and `.hydra/types/hydra.d.ts`, wire `tsconfig` paths in the scaffold, run `hydra types`
automatically in `build` and `dev`. *Accept:* `tsc --noEmit` passes on a scaffolded
project importing `state` from `hydra`; a wrong prop type fails.

**P1-6 · Images.** `Image(src,width,height,alt,sizes)` with AVIF/WebP + `srcset` via
optional `sharp`, intrinsic dimensions always emitted, lazy below the fold.
*Accept:* one PNG → ≥3 sizes, `srcset` + `loading` in the HTML.

**P1-7 · Fonts.** `fonts: [{family,weights,subsets}]` → self-hosted woff2,
`font-display: swap`, preload for above-the-fold faces, metric-adjusted fallback.
*Accept:* built HTML has one preload per face and no request to `fonts.googleapis.com`.

**P1-8 · Error reporting hook + hidden source maps.** `onError` payload with a frame
mapped back to `src/pages/x.hyx:LINE`. *Accept:* a forced throw reports the `.hyx`
frame, not `.hydra/server.cjs`.

**P1-9 · Hermetic tests and CI parity.** Pin Node 22 (`.nvmrc`), stop symlinking
`examples/*/node_modules`, add a `fixtures/` package with pinned react/react-dom/
tailwind v3. *Accept:* the full suite passes on a clean machine with one documented
setup command. (Today: 214 pass / 6 fail here, all environmental — Node 24, Tailwind 4,
no Chrome at the expected path.)

**P1-10 · Docs truth pass.** Reconcile the three contradictions — `GUIDE.md` still says
no Fast Refresh, no open-graph/canonical, no streaming SSR, all three shipped. Generate
the CLI/API reference from `schema.json` + `--help`, and build the docs site **with
HydraScript** (dogfood the SSG). *Accept:* a CI grep asserts the stale sentences are
gone and the docs site builds.

### P2 — adoption and long-term health

- **P2-1 · Codemod harness.** `hydra migrate <from> <to>`, textual transforms on `.hyx`,
  empty registry first so the contract exists before it is needed.
- **P2-2 · Performance budget in CI.** `hydra analyze --budget`, failing on entry size
  and chunk-count regressions with the delta printed.
- **P2-3 · i18n routing.** `[lang]` + `locales` config + `<html lang/dir>` + message
  catalogs. (`lang="en"` is hard-coded in the scaffold today.)
- **P2-4 · A11y gate.** `hydra check --a11y` via axe-core inside the existing runtime
  gate; fail on serious violations with the rule id.
- **P2-5 · Community infra.** Issue/PR templates, `dependabot.yml`, CODEOWNERS over
  `.github/workflows/`, one lint/format config (Biome), release notes from CHANGELOG.
- **P2-6 · Repo hygiene.** Stop tracking `bin/hydra` and `bin/hydra.node` (they show
  dirty after every build); delete the 0-byte `/hydra`; refresh or archive
  `REVIEW-PRODUCTION.md` (a 0.11.1 audit that now misleads); collapse the root and five
  example lockfiles into one workspace.

**Sequencing:** P0-1…P0-9 = 0.16 "server honesty". P1-1…P1-5 = 0.17. P1-6…P1-10 + P2 =
0.18 → 1.0. Do not start adapters, ISR, or i18n before P0 is green.

---

## 4. Three things to cut

**1. Refuse: multi-platform / edge / serverless adapters.** The server layer is a
hand-rolled `node:http` handler with no request abstraction. An adapter interface would
force that abstraction to be designed now, before sessions, caching, and lifecycle hooks
exist — freezing the wrong shape, the same mistake Next made with `pages/` middleware.
Cut it until the Node target has those primitives; then extract the interface from what
they actually need. Cost: users run a container. Cost of building it now: a permanent
second dialect of the framework's core semantics.

**2. Cut: the React/ReactDOM CJS singleton virtualization behind 0.15's Fast Refresh**
(`runner.mjs:504-548`). It patches `node_modules/react/**/*.js` through an esbuild
`onLoad` so multiple imports share one dispatcher. It works, but it is dev-only
complexity reaching into React internals, it breaks when React reshuffles its CJS
layout (React 19 already did), and it buys "a counter survives an edit". Replace with
Vite + `@vitejs/plugin-react` for anyone who needs real HMR, or plain full reload with
the existing error overlay — which is what `GUIDE.md` still documents anyway. That
deletes ~200 lines of the riskiest code in the runner and the largest source of
"works on React 18, breaks on 19" reports.

**3. Cut: `hydra add` / `hydra remove` / `hydra list` as package-manager wrappers, and
`hydra repl`.** `hydra add` re-implements `npm install`; `hydra list` is
`npm ls --depth=0` with more code; `hydra repl` for a language with **no interpreter**
is worse than absent. Both surfaces are permanent support burden for zero
differentiated value, and both sit on the question "does this tool respect the
ecosystem I already have?" — `npm i` and `node` are the answers. Deleting them shrinks
`hydra --help` and buys the budget for P1-2 (observability), which is what actually
determines whether anyone runs this in production.

---

## 5. Definition of "serious"

A project can be called serious on this framework when all of these are true without a
blog post explaining them:

1. `hydra build && hydra serve` behind a load balancer, with `NODE_ENV` correct by
   default and every configured security header on every response.
2. Login, session, logout written with framework primitives, not hand-rolled HMAC.
3. A failing loader produces an error page, not another page's HTML, and never a raw
   stack trace.
4. One bad request returns 500; it does not stop the process.
5. Two users loading at once cannot see each other's data, including inside a Suspense
   boundary.
6. Routes, loaders, and actions are testable in CI without a browser.
7. The operator can see a request log and hook an error reporter.
8. A page can say "cache for 60 s" and mean it.
