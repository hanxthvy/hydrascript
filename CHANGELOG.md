<!-- [xihanzu-NR] -->
# Changelog

Why this exists: seven releases went out in a day with nothing recording what was
in them or why the number moved. A version number is a promise about *what kind*
of change it carries, and without a log the promise is unreadable. Every release
gets an entry here.

Format: `## <version> — <date>`, newest first. State the kind of change
(`Fixed`, `Changed`, `Added`) and, when a build can now fail on code that used to
pass, say so plainly and link the way out in [MIGRATING.md](MIGRATING.md).

---

## 0.13.2 — unreleased

## Breaking changes

- **Tailwind is no longer installed or applied by the framework.** `tailwindcss`,
  `postcss` and `autoprefixer` moved out of `dependencies` into optional peers,
  and Tailwind only runs when the project asks for it. A project that relied on
  the framework's copy must now install the packages itself and set the
  `tailwind` key (or add a `tailwind.config.*`). See
  [Styling](README.md#styling) and [MIGRATING.md](MIGRATING.md).

## Added

- **A CSS pipeline the project chooses.** `src/index.css` runs through, in order
  of precedence: a `postcss.config.*` in the project; the plugins named in
  `"styling": [...]`; Tailwind + Autoprefixer when a `tailwind` key or a
  `tailwind.config.*` exists; otherwise plain PostCSS, with Autoprefixer only if
  it is installed. The build logs which one ran.

## Fixed

- **`tailwindcss` v3 was rejected as "not a function".** v3 exports the plugin
  factory directly with a BOOLEAN `.postcss` marker on it, while v4 moved the
  factory to `.postcss`. Reading `.postcss` unconditionally produced `true` and
  killed the build. The check is now on callability.
- **`styling` in `schema.json` said "NOT USED YET".** It is read now, as the
  plugin list it always claimed to be.
- **CSS packages resolved from the framework's `node_modules`.** `resolvePkg`
  falls back to the framework root, which is right for esbuild and wrong for a
  package the project is supposed to choose: a project without Tailwind would
  silently get the framework's copy. Those three resolve from the project only.

## 0.13.1 — 2026-11-04

## Fixed

- **The published package named no platform binary.** `release.yml` published
  the root manifest before `optionalDependencies` was filled, so every release up
  to 0.12.1 shipped `{}` — npm installed it everywhere and the first command died
  on any machine that was not Linux x86-64. `release.yml` now wires the field,
  verifies every wired package exists at that version on the registry, and
  refuses to publish when one does not. `binaries.yml` no longer writes the field
  at all: two workflows writing it is how they drifted.

## Added

- **Error recovery in the lexer and parser.** A file with three broken lines now
  reports three, in source order, in one run. The build still stops at the first
  error — a half-parsed module must not be emitted — but `hydra check` and the
  single-file path report everything.
- **Spans.** `CompileError` carries an end position, so a caret underlines the
  offending token instead of its first column. A span that ends before it starts
  is dropped rather than drawn wrong.
- The cascade is suppressed: a line that could not be tokenised does not also
  report the parser error it caused, and `unexpected Dedent`/`Eof` — always the
  end of a failure already reported — are removed.

## Changed

- Four new test files: `routing-split` (file-based routing and per-route
  splitting, which had no test at all), `ssr-stream` (chunked arrival, measured on
  the socket), `build-arg` (the `hydra build <dir>` dispatch), `release-wiring`
  (the manifest is wired before publish).

## 0.13.0 — 2026-11-04

Four things that were claimed and not true, and one bug that made a whole
category of pages render the wrong document.

## Fixed

- **A dynamic route rendered the HOME PAGE.** `renderSync` handed React the
  route PATTERN as the element's `path`, so `Router` matched `/blog/:slug`
  against a route table of URLs, found nothing, and fell through to `/`. The
  loader's data was inlined correctly beside it, so the document looked
  plausible and the data tag made it look right. SSG could not catch it because
  a static route's pattern and url are the same string. Every server-rendered
  parameterised page was affected.
- **`hydra build <dir>` reported success while doing nothing.** The binary looked
  for `hydraconfig.json` from the shell's cwd only; given a path it found
  nothing, fell through to the single-file compiler, compiled zero files, and
  printed `OK: compiled 0 file(s)` with exit 0. A path that names a project is
  now built; a path that names nothing fails with a message and a non-zero exit.

## Added

- **Request context.** The SSR seed moved from a module-global into
  `AsyncLocalStorage`, so two requests that await loaders concurrently cannot
  read each other's data. The global slot remains for the synchronous SSG pass
  and for a runtime without AsyncLocalStorage, and the server injects the real
  one at load time.
- **Streaming SSR.** `renderPageStream` pipes React's output as it is produced
  and writes the head before the body, so the browser has a document while the
  tree is still being built. The test asserts on socket chunks, not on content:
  a buffered implementation produces a correct document and passes every content
  assertion.
- **`generateStaticParams` / `static_params()`.** A dynamic route can declare its
  instances in its `.server.hys`, and the build prerenders one document per
  entry — the thing that makes SSG work for a URL with a parameter. `[]` means
  "render per request" and is honoured; no export means the route stays dynamic
  and the build says which one.
- **`generateMetadata` / `metadata(event)`.** A per-slug title, canonical and
  `og:`/`twitter:` tags, built from the same event the loader gets. The key list
  is a fixed allowlist and every value is escaped, so a title from a database
  cannot become markup. An unknown key is an error that names it.
- **Route splitting is now tested.** No example project used the file-based
  router, so nothing in CI ever built one. `routing-split.test.mjs` builds a
  four-page project and asserts on the output: one chunk per page, the entry
  bundle does not contain a page body.

## Changed

- `bin/hydra` and `bin/hydra.node` rebuilt at 0.13.0.
- The "streaming" claim now has a limit written down: the route loader is still
  awaited before the first byte, because `renderSync` needs a value. What streams
  is everything below a Suspense boundary, and the document is no longer built
  in memory before the first byte.

## 0.12.1 — 2026-11-04

A second pass over the same code, this time verifying the review's claims against
the source instead of trusting the review. Three of the changes below are bugs
the 0.12.0 review missed; two are its own findings that turned out to be wrong.

## Fixed

- **The macOS and Windows compiler could not be built at all.** `src/napi.rs`
  declares `extern "C"` imports of `napi_*` functions. Linux tolerates them
  undefined in a `cdylib` and the loader fills them in at `require()` time;
  the macOS and Windows linkers refuse to emit a binary with an undefined
  symbol, so every `darwin-*` and `win32-x64` job in `binaries.yml` died with
  `Undefined symbols: _napi_create_function`. The binding is now behind a
  `node-addon` feature, off by default, and the addon is a separate `cdylib`
  build. The CLI binary is checked for `napi_` imports on every platform so a
  regression fails the build that caused it.
- **`cargo test --release` could not compile.** The release profile sets
  `panic = "abort"` for the shipped binary and a test harness needs `unwind`.
  `cargo test --profile testrelease` is that run under a name that works; the
  shipped profile is unchanged.
- **Two of the security headers were only on file responses.** `nosniff` and
  friends were set inside the file-serving branch, so `/__hydra/version`,
  every API route, every action reply and every error page answered without
  them — the answers most likely to echo caller-supplied text. They are set
  once on the response now.
- **`/__hydra/version` was cacheable.** A monitor reading a cached `ok` learns
  nothing about a server that is down. It is `no-store` now.
- **`npm install -g npm` in `release.yml`.** The same step that failed every
  darwin job in `binaries.yml` with `EACCES: mkdir /usr/local/share/man/man5`.
  The version is checked there now, not installed.
- **`vite-plugin/package.json` said 0.9.0** while the package it ships next to
  was 0.12.0. CI checks the two agree.
- **The `0.9.0`-era comment in `api-routes.mjs` still claimed nested folders and
  route parameters were absent.** Both have been supported since 0.10.0 — the
  scanner walks subdirectories and parses `[param]`, and the test suite covers
  it. Two reviewers read the comment and reported the feature as missing, which
  is the cost of a comment that contradicts its own code.
- **README claimed 394 Rust tests and 115 Node tests.** The real counts are 408
  and 158.
- **`vite-plugin/index.js` claimed a ~1 ms cold compile.** Measured: 0.025 ms/file
  in-process, ~7 ms/file through a process spawn. The conclusion (the spawn is
  the cost) was right; the number was not.

## Added

- `Strict-Transport-Security`, opt-in via `HYDRA_HTTPS=1`. Off by default on
  purpose: HSTS on a localhost dev server pins `localhost` to https in the
  operator's own browser, which is not a server's decision to make.

## Changed

- `build:compiler` builds the addon with its feature instead of copying a
  library that no longer contains the binding.

## 0.12.0 — 2026-11-03

Everything in this release came from an audit that ran the framework the way a
user would: build a project, serve it, `curl` every endpoint, read the status
code. The findings are in `REVIEW-PRODUCTION.md` (gitignored); this file is what
changed because of them.

The version is a minor bump rather than a patch because four behaviours changed
in ways a project can notice, and each one is listed as a breaking change below.

## Breaking changes

- **`str(x)` is Python's spelling.** `str(None)` is `None`, `str(True)` is
  `True`. It used to emit `String(x)`, which answers `null` and `true`. A page
  that displayed a boolean will display `True` instead of `true`.
- **`type(x).__name__` returns a Python type name.** `dict`, `list`, `int`,
  `float`, `bool`, `str`, `NoneType`. It used to return the JavaScript class
  (`Object`, `Array`, `Number`) and threw on `None`.
- **`isinstance(x, int)` and `isinstance(x, float)` are different questions.**
  `True` is an `int`, `1.5` is not, and `1` is not a `float`.
- **Source maps are off by default.** `"build": { "sourcemap": true }` turns
  them on. A map carries the application's source in `sourcesContent`, and
  `dist/` is what gets uploaded.
- **`dist/` is emptied before a build.** `"build": { "clean": false }` opts out.
  A route deleted from the source now stops being served.

## Wrong answers, now correct

- **A loader can see the request.** `event.request.headers`, `event.request.url`
  and `event.url` (query included) reach the loader on a server render. They
  were an empty stub, so no page could be guarded by a cookie or a token.
- **The query string reaches the loader.** `?tab=info` used to arrive as nothing
  while `/__hydra/data` answered correctly: the same URL produced two pages
  depending on how it was reached.
- **`redirect()` and `fail()` are HTTP answers in all four paths.** A loader that
  redirected rendered a 200 with a blank page; `fail(401)` in an API route
  answered **200** with the refusal in the body. `packages/cli/http.mjs` now owns
  the reading, so a new consumer cannot invent a fifth interpretation.
- **`fail(401)` answers 401**, and a redirect answers 303 with `Location`.
- **A list is a list.** `return [1, 2, 3]` from an API handler answered
  `{"error":"Invalid status code: 2"}` because any array was read as
  `(body, status)`. Only a two-element array whose second item is a status code
  is a tuple now.
- **`HEAD` works.** It answered 405 on every endpoint, so every monitor and
  `curl -I` failed against an API that plainly existed.
- **A body over the limit is a 413.** It used to `req.destroy()` before writing
  the status, so the client saw "empty reply from server" and no status at all.
  `server.bodyLimit` is configurable.
- **A POST with no body is `{}`**, not `null`. `body.get("x")` threw on it.
- **A URL that matches nothing is a real 404**, with the project's `_404` as the
  body, and `404.html` is written for static hosts. It used to answer the HOME
  page with status 200 — which also made React throw #425 and then #423 and
  re-render the whole tree.
- **A missing asset is a 404**, not `index.html` with a 200 and a `text/html`
  content type that the browser refuses to execute as a module.
- **Dotfiles are not served.** `/.hydra-build.json` (the esbuild metafile: the
  whole module graph) answered 200.

## Added after the first pass, from verifying every finding

A second pass checked all 41 findings against the CODE and the running server
instead of against the commit message. Six were still open and are closed here;
five remain open on purpose and are named at the end of this entry.

- **Security headers and a cache policy** on every response: `nosniff`,
  `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`; hashed assets are
  `immutable`, HTML revalidates, a server-rendered page is `no-store`.
  `server.headers` adds a project's own (CSP belongs there: a wrong policy
  silently breaks fonts and analytics, which is worse than an absent one).
- **gzip** for text responses when the client asks: a 143 KB entry chunk goes out
  as 44 KB. Below 1 KB it is skipped, where the header costs more than it saves.
- **Cross-origin action POSTs are refused.** Nothing to steal today; the guard
  goes in now because the day a project adds session cookies, an action that
  accepts any origin is a CSRF hole the framework would have created.
- **`Link` and `navigate` are base-aware.** With `base: "/sub/"` the href was
  `/about`, which worked with JavaScript and 404'd without — the one case `Link`
  exists to keep working.
- **The runtime gate serves the project's `base`.** A project with `base` was
  failing the gate on asset 404s, which was the gate being right and its server
  being wrong.
- **`hydra build` no longer prints the gate's own "Server running at
  http://127.0.0.1:0/"** into the build log.
- **Pre-rendered pages carry the stylesheet.** The tag was injected into
  `dist/index.html` and then SSG wrote that file again from the source template,
  which cannot name a content hash: the first page had styles and every route
  after it did not.
- **`/` and `//` raise `ZeroDivisionError`.** They answered `Infinity`/`NaN`, and
  the `except ZeroDivisionError:` block an author wrote never ran.
- **The compile cache is pruned**: wiped when the compiler identity changes, and
  capped by file count. It grew forever, gitignored, invisible to `hydra clean`.
- **One lockfile.** `bun.lock` sat beside `package-lock.json` while every
  workflow ran `npm ci`.

## The five that were still open, now closed

- **Nested API folders, parameters and catch-alls.** A folder is a URL segment,
  with the same naming rules as the page router: `src/api/users/[id].hys`
  answers `/api/users/42` and fills `req.params.id`; `[...rest].hys` gives a
  list. Two files that answer one URL are a build error naming both — keyed on
  the URL SHAPE, because `[id]` and `[slug]` print different patterns for the
  same address.
- **One error envelope.** Every framework failure is `{error, code, detail?}`,
  in the API layer, the action path and the data endpoint. `fail(status, data)`
  stays unwrapped on purpose: that body is the application's answer, not the
  framework's complaint.
- **Keyword arguments across files**, in both spellings. The `.hys` emitter had
  no `import_specs` at all, so it could not read a signature it had just
  imported; and the "is this a relative specifier" test required a leading `./`,
  which the language's own `from "lib/stats.hys" import f` does not have.
- **Page props types come from the loader.** `hydra types` reads the loader's
  `return {...}` and emits `posts: string[]`, `region: any` — a literal keeps
  its type, a call is `any`, and a loader-supplied prop is not optional, because
  the loader always supplies it.
- **Per-platform binaries.** `bin/hydra.js` resolves `@hydrascript/<triple>`
  (glibc, musl, darwin, win32) from `optionalDependencies`, then the bundled
  binary, and names the triple and the fix when neither exists.
  `.github/workflows/binaries.yml` builds and publishes the seven targets, each
  proven to start on the runner that built it.

## Still open, and why

- **`xs[5]` past the end is still `undefined`.** Division raises, a negative
  out-of-range index raises, but a plain subscript cannot: the compiler does not
  know `list` from `dict` statically, and a bounds check on every subscript would
  break dict access.

## Performance

- **`delete require.cache` only happens in development.** In production it
  re-evaluated every module in the server bundle on every request: module-level
  state (a connection pool, a counter, a cache) was recreated each time. Measured
  on a 1.25 MB bundle: **93 req/s before, 1.626 req/s after**.
- **`import` from `hydra` in a server file no longer pulls React in.** The
  runtime was split into `runtime/core.ts` (no React) and `runtime/hydra.ts`
  (re-exports core, adds hooks and the router); the server bundles alias `hydra`
  to core. An API route using `dict_get` produced a **1.25 MB** bundle; it is now
  **2.7 KB**.
- **One chunk per route.** Every page used to be in the initial bundle: 61
  routes, one 166 KB file, zero chunks. The entry is now the runtime plus React,
  and each route is fetched on demand. `mount()` primes the active route's chunk
  before `hydrateRoot`, because hydrating before it arrives is #418 then #423.
- **The runtime gate checks pages in parallel and says how many it checked.**
  A 61-route build spent 27 of its 28 seconds in the gate, on 25 pages.
- **CSS is content-hashed** like the JS, so it can be cached for a year instead
  of being invalidated on every deploy.

## Added

- **`hydra serve` / `hydra start`.** Documented in the README and absent from the
  CLI, which treated the word as a source file. It refuses to start when the
  server half is missing rather than serving empty shells to crawlers, and it
  handles `SIGTERM`.
- **`docs/DEPLOYING.md`** and an `examples/blog/Dockerfile`: what the artifact
  contains, what it needs, and how to run it.
- **`hydra/core`** as a specifier for a server file that must stay React-free.
- **`rendering = "ssr"`** is honoured. It was accepted by the scanner and
  ignored by the build, so a route that asked to be dynamic shipped as static.
- **`routes`, `ssr`, `server.bodyLimit` and `build.clean`** are in `schema.json`,
  and three defaults that disagreed with the code are fixed (`ssg` is on, `host`
  is loopback, `sourcemap` is off). An editor validating a config the docs teach
  used to flag it as invalid.
- **`.env.<mode>`, `.env.local` and `.env.<mode>.local`** are read, in
  precedence order, and all of them are gitignored. `.env.local` was neither
  ignored nor read: a secret staged by `git add -A` that also did nothing.
- **`packages/cli/production.test.mjs`** — nine end-to-end tests that drive the
  real CLI against a real project and read the real HTTP response: headers and
  query reaching a loader, a 303 from a loader, a 404 that is a 404, a missing
  asset, a 413 that is answered, HEAD, a list, build cleaning, per-route chunks,
  and `serve` refusing a static build.

## Fixed

- `format(value, spec)` — Python's builtin — was a `ReferenceError`. The name was
  imported and resolved to `str.format`, the template expander.
- `hydra run` failed in any directory without React, for a script that does not
  use it.
- `public/index.html` was silently overwritten by the build; it is now reported.
- `hydra serve`'s absence from `bin/hydra.js`, the Rust CLI and `main.rs`'
  command list, each of which had to learn the word separately.
- The three test counts in README, BENCHMARKS and CI disagreed with each other
  and with the suite; all four now come from the same run (408 Rust, 155 Node).

## Notes

- The Fast Refresh second half (the edited markup swapping into the live tree)
  is still open, and the README still says so.
- No RSC, no islands, no streaming: unchanged, and still deliberate.

---

## 0.9.1 — 2026-11-02

**Python semantics for the operators and builtins whose JS spelling is close
enough to look right.** Every item below produced a GREEN build and a wrong
value, which is the worst failure shape this project has: nothing threw, so
nothing pointed at the source line.

### Fixed
- **`sorted(xs)` compared string forms.** `Array.prototype.sort()` with no
  comparator orders `[10, 9, 100]` as `[10, 100, 9]`. Now the runtime's `sorted`,
  which compares numbers numerically and everything else as text.
- **`x % y` took JavaScript's sign.** Python's result follows the DIVISOR, so
  `-7 % 3` is 2 and was -1 — a ring index or bucket calculation landed one cell
  off for negative input. Now `py_mod(a, b)`.
- **`xs[-1]` was `undefined`.** A negative literal index is Python's
  count-from-the-end; it is now `py_at(xs, -1)`. An index whose sign is not
  statically known keeps the plain form, because rewriting it would break every
  arithmetic index.
- **`round(x)` rounded halfway up.** Python rounds a tie to the EVEN digit:
  `round(2.5)` is 2, and was 3. `round_to`/`round_py` do it the way `py_fixed`
  already did for `f"{x:.2f}"`. `round(2.675, 2)` is 2.67 again.
- **`int("12px")` was 12.** `parseInt` truncates a partial parse where Python
  raises, so a corrupt number travelled. `int`/`float` are runtime constructors
  that raise `ValueError` for the same inputs.
- **`f"{x:.3f}"` crashed in a `.hys` file.** The f-string translator invents
  `py_fixed`/`py_group` and only the `.hyx` emitter recorded the import, so every
  formatted f-string in a plain-node file threw `ReferenceError: py_fixed is not
  defined`. Both emitters record it now, and
  `packages/cli/helper-contract.test.mjs` asserts that every name the emitter can
  emit is exported by the runtime — the class of bug `int` and `float` also
  belonged to.
- **`if xs:` used JavaScript truthiness.** An empty list and an empty dict are
  truthy in JS and falsy in Python, so the wrong branch was taken silently. Bare
  names in `if`/`elif`/`while` and in a tree `if` now go through `truthy()`.
  Tests are wrapped only when the test is a name: `if x == 1` and `if not x` are
  already correct and stay unwrapped.
- **`bool([])` was true.** `Boolean` is not `bool`; it is `truthy()` now.
- **`max(xs)` / `min(xs)` spread the argument.** Correct for an array, `NaN` for
  a Set, a string or `range(n)`. `max_of`/`min_of` iterate, and an empty
  sequence raises `ValueError` like Python.
- **`xs.pop()` returned `None` and left the list alone.** The compiler lowered
  every `.pop` to the dict helper, which read a key of `undefined`. One helper
  now dispatches on the receiver: last element for a list, value for a dict key.
- **`d.get(k)` returned `undefined`.** Python's fallback is `None`, and
  `is None` is the whole idiom.
- **`truthy()` reported an HTML element as falsy.** It keyed objects off
  `Object.keys().length`, and an element has no own enumerable keys — so
  `if el:` was false for every element the app looked up, and a branch was
  silently never taken. Found by building a real portfolio, where it blanked the
  page. Containers are judged by length/count, everything else by JS truthiness.
- **`"ab" * 3` was `NaN`.** A literal string or list on the left of `*` repeats
  through `py_repeat`. A variable keeps the numeric meaning: `price * qty` must
  not change.
- **`range(1, 10, 3)` threw `ReferenceError`.** The one-argument arm could never
  see the variadic form, and the `.hys` path had no arm at all.
- **A helper imported by hand was imported again.** `from "hydra" import sorted`
  plus a generated `import { sorted }` was a duplicate binding and a build error
  (`The symbol "sorted" has already been declared`). The generated import now
  drops names the author already imported.

### Fixed — build and tooling
- **The compile cache could serve a previous compiler's output.** Its docstring
  promised that "a compiler change is a miss by construction", but the key
  carried the package VERSION, which does not move when the Rust source is
  rebuilt. It now hashes the two binaries.
- **`npm test` ran 4 of the 16 test files.** The remaining twelve — router, ssr,
  ssr-concurrency, compile-cache, error-reporting, hmr, lsp, static-deploy,
  test-command, loader, vscode-extension — ran only when invoked by hand.
- **`scripts/hx-examples-check.sh` ignored `hydra test`.** An example whose own
  suite failed still reported PASS. The new `examples/runtime-semantics` exists
  to hold those assertions, and `hydra test` is now part of the check.

### Added
- **`examples/runtime-semantics`** — 11 `hydra test` assertions covering the
  semantics above, so they are enforced by the repo's own example check rather
  than by a one-off script.
- **`scripts/page-console.mjs` / `scripts/page-network.mjs`** for debugging a
  blank page over CDP: which module failed to load, and why. Both pick a real
  page target — attaching to a Chrome extension's background page reports
  "blank" for every site, which cost an hour of chasing a compiler bug that was
  not there.

## 0.10.0 — 2026-11-02

**Per-page `meta`: the title and description a page declares, in its static HTML
and after a client-side navigation.**

`meta` was already accepted by the compiler and already did nothing. A page could
declare `meta = {"title": "About — Hanz"}`, the build stayed green, and
`dist/about/index.html` still said `<title>app</title>`. This work is the feature
that name promised, and nothing beyond it.

### Added
- **`meta = {"title": ..., "description": ...}` in a page file**, written into
  that route's static HTML: the `<title>` and the description tag are REPLACED in
  place. A page without `meta` — and every route a project never gave one — keeps
  the shell's title, which is what a page that claims nothing should say.
- **The same values on a client navigation.** `Router()` applies the new route's
  title after `navigate()`, and restores the SHELL's title when the new route
  declares none. The values travel in the generated route table, so a navigation
  costs no request: the build already knew them.
- **`hydra dev` / `hydra preview`** apply the page's `meta` to the document they
  render per request, so a dynamic route served by a server is not the one place
  in the project with the app's title.

### Shape, deliberately
- **Two keys.** `title` and `description`. A third key is a build error that names
  it, not a value that reaches no page. There is no `use_head`, no open-graph, no
  per-route config file.
- **Read from the source, not by importing the page.** The compiler emits a
  module-level `meta` as a local `const`, so an import would not carry it — and a
  page is a client module, which the build has no business running in node.
- **`hydra routes --json` reports `meta` per route**, so the value is inspectable
  without opening the generated table.

### Not done, stated in the README
- Metadata derived from the URL (`/blog/hello` wanting "hello" in its title) is
  not static metadata. A dynamic route's shell keeps the app's title, and the
  client sets the page's after hydration.
- Open-graph, Twitter cards, canonical links and structured data are out of
  scope. Each is a separate claim about a page and would need its own statement
  of what makes it true.

---

## 0.11.1 — 2026-11-02

**The three LSP/Tooling items the roadmap listed as "not started", plus the
`doctor` route report.** One of them — Fast Refresh — is shipped in part, and the
partial half is named rather than implied.

### Added
- **`hydra-lsp`: cross-file rename.** `textDocument/rename` now returns a
  WorkspaceEdit covering the declaration AND every relative importer, because a
  rename that touches one of them leaves the other's import naming something the
  module no longer exports. `prepareRename` lets the editor refuse a position with
  nothing under it. A PACKAGE import is refused with the reason: that declaration
  is not this server's to edit. Found and fixed on the way: the importer scan
  started at `dirname(target)`, so it could only ever find the declaration.
- **`hydra-lsp`: completion.** The file's own names and imports, the Python
  builtins the COMPILER lowers (read out of `check.rs`, not copied — a second list
  would drift), a module's real exports after `from "x" import `, and the methods
  of a list/dict/string literal after a dot.
- **`hydra-lsp`: signature help.** Parameter names and the active argument, from
  the callable's own declaration in this file or a relative import.
- **`hydra doctor` reports routes, and a param collision is a FAILURE.** Two files
  claiming one URL — `[slug].hyx` beside `[id].hyx` — both compile, so which one
  answers depended on directory order. `doctor` now names both files and exits 1.

### Fixed
- **The HMR client could never connect.** It built
  `ws://host:port__hydra/hmr` — no slash before the path — so every save needed a
  manual refresh while the terminal said "Development mode active". It also went
  missing from SSR-rendered dev pages entirely, which is every page in a project
  that uses the router.
- **Dev SSR pre-rendering threw `Cannot read properties of undefined`.** The
  refresh boundary's registry key was a module-level `const` read from a call that
  runs while the module is still initialising, so the assignment became
  `globalThis[undefined] = ...`. The key is a literal inside its function now.
- **The worker pool did not receive `process.env`.** A switch set after the pool
  was created — `HYDRA_DEV` decides whether the dev boundary is emitted at all —
  was silently absent, so the feature did nothing while every test passed.
- **The compile cache key now carries the dev/build mode.** The same binary emits
  both shapes, so a production build's cached `export function Card` was served to
  `hydra dev`.
- **`hmr.test.mjs` picked a port with `5380 + random(100)`**, which collided with
  another dev server in the same run. The failure looked like the socket refusing
  a connection, i.e. a flaky test blaming the code under test. It asks the OS now.

### Fast Refresh: state preserved, markup not yet
The dev server sends `refresh` instead of `reload`, the compiler wraps each
component in a registry boundary (`__refresh`), and a mounted tree keeps its hook
state across an edit. **Measured**: a browser clicks a counter to 3, the component
is edited, the counter reads 3 with the page's window intact.

The second half is **not** done: the new markup does not reach the live tree, so
the counter keeps its state while the label stays stale. The README roadmap says
`open` for that row. Calling the whole thing Fast Refresh would be the kind of
green lie this project keeps removing.

## 0.11.0 — 2026-11-02

**The server side, as one package: `.env` with a real secret split, API routes,
middleware, and two build targets.** These shipped together because API routes
without the split are a trap rather than a feature — the first component that
reaches for `process.env.STRIPE_KEY` would have gotten `undefined` and shipped.

### Added
- **`.env`, with `PUBLIC_` as the only way into the browser.** A 25-line parser
  (`KEY=VALUE`, `#` comments, quotes, no interpolation, no dotenv dependency).
  `PUBLIC_*` is inlined into the client bundle as literal strings; everything
  else stays on the server and is read with `env()` from `hydra/server`. A real
  environment variable wins over the file, so a deploy's secrets are never
  overridden by a `.env` that shipped in the tarball.
- **A build that FAILS when a client file reads a non-`PUBLIC_` variable**, and
  names the variable, the file and the line:

  ```
  ✘ [ERROR] src/lib/api.hys:5:32: STRIPE_KEY is not available in the browser.
    Only names starting with PUBLIC_ are inlined into the client bundle...
  ```

  The check runs on the COMPILED output of every module in the client graph, so
  a `.hys` pulled in by a component is covered, and a comment that merely
  mentions a variable name is not. A computed key (`process.env[name]`) is
  refused too: it cannot be inlined, so it would be a silent `undefined`.
- **`src/api/*.hys` — one file, one URL, one exported function per HTTP method.**
  `export def get(req)` and `export def post(req, body)` answer `/api/<file>` in
  `hydra dev` and `hydra preview`. `(value, status)` sets the status, `None` is
  `204`, a method that is not exported is a `405` with `Allow`, and a missing
  URL is a JSON `404` rather than the SPA shell with a `200`.
- **`src/middleware.hys` — one exported `handle(req)`** that can reply, mutate
  the request, or return `None` to pass through. Scope is `/api` and below,
  stated in the docs rather than left to be discovered.
- **`hydra build --target node|static`.** Two targets, no adapters, no presets.
  `static` stays the default because that is what every earlier release
  produced. A static build prints every dropped API route and the middleware by
  name, because an endpoint that builds "successfully" and 404s in production is
  the failure that report exists to prevent.
- **`api-routes.test.mjs`** — nine tests, six of which drive a real build and a
  real `hydra dev` over a socket: GET and POST with an asserted JSON body,
  middleware blocking one path and passing another, a `405`, a JSON `404`, a
  build that fails naming the secret, and a `PUBLIC_` value that IS inlined
  while the secret appears nowhere in `dist/`.

### Changed
- **`process` no longer trips the strict semantic check when every mention in a
  file is a `process.env` read.** The checker has no concept of environment
  access, so it reported `process` as "used but never bound" — which would have
  made `.env` unusable and taught authors to disable the whole check. A bare
  `process.exit()` in a component still fails, because there is no `process`
  object in a browser.
- **`--target` rejects any third value at the command line**, before anything is
  bundled, rather than falling back to a default.

---

## 0.9.0 — 2026-11-02

**Tests for the features 0.8 shipped, and four silent-failure bugs they found.**
No new framework surface; the release is mostly the evidence that the previous
one works.

An analysis pass suggested tests for the LSP and for `hydra test`. Those already
existed (17 and 6 cases). What follows is what was actually missing, plus what
writing it turned up — which was more than the tests themselves.

### Fixed
- **A project whose routes are ALL dynamic shipped `dist/index.html` with no
  bundle tag.** With no static route to pre-render, the SSG step fell into a
  branch that rewrote `index.html` from the raw source template, discarding the
  `<script>` tag the client build had just written. The server rendered
  `/blog/[slug]` correctly while every CLIENT-side navigation rendered nothing —
  no JavaScript ever loaded. A blog with only `/blog/[slug]` is not an edge case;
  it is the shape the SSR path exists for.
- **`writeSsgEntry` returned null when a project had no static routes**, so the
  generated pre-render entry was never written, the build fell back to
  `src/App.hyx`, and the server bundle had no `loadFor`/`renderSync`. The server
  then refused every dynamic route with "the server bundle predates 0.8" — for a
  project built with 0.8.
- **A loader that threw reported a stack pointing into the built bundle**
  (`.hydra/server.cjs:7308`). The error now names the `.hys` file and the route
  pattern, in the response body AND in the terminal, because a bundle line number
  is not a file the author has ever opened.
- **An SSR failure produced a blank page with a 500 and no explanation.** The
  same notice is now rendered into the shell, so the page says what failed.
- **The VS Code extension regexed COLOURED stderr and could report only the
  first problem.** It reads `hydra check --json` now, so every finding becomes a
  squiggle, and `--stdin-name` keeps diagnostics pointing at a real path.
- **`escapeHtml` for the SSR notice**, so a loader error containing `<` or `&`
  cannot break the page it is being reported on.

### Added
- **Concurrency tests for SSR.** The runtime seed is module-global, so the rule
  is that nothing may `await` between `renderSync` writing it and
  `toString` reading it. The test drives two URLs whose loaders yield a DIFFERENT
  number of times, so an interleaving is provable rather than theoretical — and
  it was verified to FAIL when an await was deliberately added to that window.
- **Static-deploy tests**: with no data endpoint the page reports `error`, still
  renders, and does not crash; with the endpoint it loads the data.
- **Route-conflict tests** for a file and a folder index claiming one URL, route
  groups not changing the URL, and the nearest `_layout`/`_404` winning — the
  layout chain asserted INNERMOST FIRST, which is the order `wrapInLayouts`
  consumes and would nest every layout inside out if reversed.
- **Cache regression tests**: a warm cache must cause ZERO compiles (a spy, not a
  wall-clock threshold, which is flaky on a busy machine), and an error must never
  be cached — an invariant now enforced inside `CompileCache.set` rather than at
  every call site.
- **Snapshot DIFFS.** A failed snapshot printed both documents; it now marks the
  changed line with the unchanged ones for context, via an LCS line diff.
- **`hydra check --stdin-name <path>`**, so an editor's diagnostics name the file
  the developer has open.
- **README: "When something fails"** — what happens for a loader that throws, a
  component that throws, a page that renders nothing, and a hydration mismatch,
  each with the words the user actually sees.
- **README: the editor section** now describes `hydra lsp` and the extension as
  two DIFFERENT things, including that the extension does not start the server.

### Removed
- **`test-hmr.mjs` at the repo root** — an ad-hoc script that duplicated three
  checks already covered by `packages/cli/hmr.test.mjs` as real tests. Deleted
  rather than renamed: a second copy of a test is a second thing to keep in sync.
- **The claim that `hydra serve` exists.** README mentioned it; the command was
  never written, and `hydra preview --host` already covers the case it was
  describing.

---

## 0.8.0 — 2026-11-02

**The rest of the roadmap, in one release: SSR for dynamic routes, loaders that
re-run on a client navigation, `hydra test`, `hydra lsp`, and an incremental
compile cache.** Every row that said "not started" is now either shipped or
named as the honest remainder.

### Added
- **SSR for dynamic routes.** `dev`, `preview` and `serve` render a route with a
  parameter per REQUEST from the prebuilt server bundle, so `/blog/hello` is a
  real page for a crawler and for a reload. Loading and rendering are separate
  calls and nothing awaits between them, because the runtime's seed is
  module-global: an await there lets two requests overwrite each other's data.
- **`GET /__hydra/data?url=…`**, and loaders that re-run on a client-side
  navigation. The inlined payload now carries `url` as well as `pattern`, since
  two URLs can match one pattern. A loader that throws is a 500 with its
  message, not an empty object.
- **`hydra test`** — `*.test.hys` in tests/, src/ or the root, each bundled with
  the build's own resolver and run in its own process. `test`, `expect`,
  `render`, `snapshot` from `hydra/test`. A snapshot is written on first run and
  compared after; a change is a failure.
- **`hydra lsp`** — LSP 3.17 over stdio: diagnostics from the compiler's own
  check, hover, go-to-definition, rename within one file (and a REFUSAL, with
  the reason, for a name that is imported).
- **`hydra check --json` and `hydra check -`** (stdin), so a tool consumes
  diagnostics as data rather than parsing the coloured human output. Hand-built
  JSON with a real escaper; no new dependency.
- **An incremental compile cache**, content-addressed by
  (source, compiler version, filename), under `.hydra/cache/`. A second build of
  an untouched project compiles nothing and says `N reused, 0 compiled`.
- **A parallel compile pool** (`worker_threads`), tested and reachable, and OFF
  below a measured threshold: the compiler is 0.39 ms/file, so at 120 files the
  pool (124 ms) is slower than serial (47 ms). `benchmarks/compile.mjs` prints
  the numbers; `shouldPool` is that threshold and not a guess.

### Fixed
- **`class MyError(Exception)` emitted `extends Exception`**, a name nothing
  defines, so the module threw `ReferenceError: Exception is not defined` on
  load. The README documents this exact code. The runtime now provides the
  Python exception hierarchy as real classes (`KeyError` is a `LookupError` is
  an `Exception`, so `except LookupError:` catches it), and `TypeError` IS the
  JS built-in so `except TypeError:` also catches what the engine throws.
- **`raise ValueError("x")` compiled to `<ValueError>x</ValueError>`** — a React
  element, not a throw — while README documents `new ValueError("x")`.
- **`except KeyError:` emitted `instanceof KeyError` with no import**, a
  ReferenceError at the moment the handler was meant to catch something.
- **A user's class with a runtime exception's name produced two declarations**
  (`SyntaxError: Identifier 'ValueError' has already been declared`). Class
  names are now collected before anything is emitted, so the user's class wins.
- **`hydra run` could not resolve the `hydra` specifier at all.** The binary
  piped the compiled JS to `node -`, so any script importing a runtime helper
  died with `ERR_MODULE_NOT_FOUND: Cannot find package 'hydra'` — in a language
  whose README documents that import. `run` now bundles through the runner.
- **`same_path`**: a pre-rendered route at `/about/` concluded the inlined data
  was for a different URL and rendered without the loader's props, which the
  server HAD rendered with — React #425/#418 on every such route.

### Changed
- The roadmap's three remaining rows are now named as remainder (Fast Refresh,
  cross-file rename, completion), each with the reason it is not done.

---

## 0.7.2 — 2026-11-02

**The published binary refused to start on the machine it was being deployed
to.** 0.7.1's `hydra build` worked, which is why this got past a release: build
goes through the Node runner, and the runner never touches the native binary.

### Fixed
- **`bin/hydra` required glibc 2.39 and could not start on glibc 2.35.**
  `runs-on: ubuntu-latest` had moved to Ubuntu 24.04, so the released binary
  carried a `GLIBC_2.39` requirement and every non-build subcommand (`hydra run`,
  `hydra check`, `hydra init`) died with "weak version `GLIBC_2.39' not found".
  The release job is pinned to `ubuntu-22.04` (glibc 2.35), the oldest LTS
  runner, so the artifact runs on 22.04 and anything newer.
- **The release workflow now checks that**, and fails if the binary needs a
  newer glibc than the runner provides. `pack-install-check.sh` could not catch
  this: it builds a scaffolded app, and building does not exercise the binary.

---

## 0.7.1 — 2026-11-02

**The runtime gate stopped killing the build it was checking.** No change to
emitted code; this is a build-reliability release.

### Fixed
- **Every interrupted build leaked a Chrome process tree.** `child.kill()`
  signals the process the gate spawned, and a Chrome is a tree: browser, gpu,
  zygote, one renderer per tab. The renderers were reparented to init and kept
  running. Measured on this host: four orphaned gates held ~800 MB between them,
  and the next build was killed by `earlyoom` at 19% available memory with no
  message about the gate at all. Chrome is now spawned `detached` and the whole
  process group is killed, and a `process.on('exit')` handler covers the build
  being interrupted, which never reaches the `finally`.
- **The gate now looks at free memory before it opens a browser.** A browser
  needs ~150 MB; on a box already under pressure, starting one is what tips it
  over, and a build must not die because its checker wanted a browser. Below
  `HYDRA_GATE_MIN_MB` (default 350) the gate skips itself and says the number.
  `HYDRA_GATE_FORCE=1` overrides it.
- **Stale gate profiles are swept** instead of accumulating one directory per
  interrupted build.
- **`pagesDirectory` claimed `src/pages` existed when it did not.** Every project
  without the directory got "src/pages exists but the app does not render
  `Router()`" about a directory that was not there. It now returns the directory
  only if it exists.

### Note
The memory pressure on this machine turned out to be the real cause of the
SIGTERM-killed builds, not the compiler: the host's 2 GB swap was completely
full. A second 4 GB swap file is in `/etc/fstab`; the leak fix above is what
keeps the gate from contributing to it.

---

## 0.7.0 — 2026-11-02

**The meta-framework half of the roadmap, in one release: loaders, per-module
server/client enforcement, live reload, and SSG on by default.** Four of the
items that were "not started" in the 0.6.3 roadmap now ship. Two things a
developer had to write by hand — fetching data before render, and pushing an
edit to the browser — are the framework's job now.

### Added
- **`loader` and `action`, in a `.server.hys` beside the page.** A `loader` runs
  once per route at build time; its result renders into the HTML *and* is
  inlined as JSON so the client hydrates with the same values. An `action`
  answers a `POST` to the same URL and may return `redirect(path)`, which is a
  real `303` so a refresh does not repost.
- **`hydra/server` and `hydra/client`.** `env`, `read_text`, `write_text`,
  `redirect` on one side; `scroll_to`, `local_storage`, `clipboard` on the
  other; `hydra` stays universal. The compiler refuses `hydra/server` in a page
  and `hydra/client` in a `.server.hys`, and the error names the file and says
  which of the two fixes applies.
- **Live reload in `hydra dev`.** A websocket and an injected client, no
  dependency. A successful rebuild reloads the page; a *failed* one does not,
  it sends the compiler's message to the console and leaves the last working
  page in place. State is not preserved across a change — that is Fast Refresh,
  and it is not this.
- **SSG on by default for static routes.** A project with `src/pages` and a
  `Router()` pre-renders every static route with no configuration. Opt out per
  page with `rendering = "csr"`, or per project with `"rendering": { "ssg": false }`.
- **A `.server.hys` with no page beside it is a build error** naming both
  files, not a loader that never runs.

### Fixed
- **A component whose whole body is one element did not return it.**
  `component App():` / `Router()` emitted `Router();` and fell off the end,
  returning `undefined`: React rendered an empty app, no error anywhere, and a
  green build. The single most natural way to write a router root was the one
  shape that silently rendered nothing. Caught by the loader test, not by
  reading the code.
- **`routes` in the generated table had lost `segments`.** Matching reads them,
  and the field was dropped when the map was regenerated for `serverFile` — so
  every route matched nothing, the server rendered a full page and the client
  rendered an empty one: React #418 on a route that was pre-rendered.
- **Only the first pre-rendered route got a rendered page.** The SSG pass read
  the already-written `dist/index.html` as its template; that file's
  `<div id="root">` was no longer empty after the first render, so `inject`
  matched nothing for every route after it and those pages shipped an empty root
  with correct data beside it. Each route is built from the project's own
  `index.html` now.
- **A pre-rendered route threw React #418 on its own HTML.** A page is served at
  `/notes/` and `pathSegments` did not treat a trailing slash as the same route,
  so the client matched nothing where the server had matched the page.
- **The seed was cleared before the render used it**, so a loader's data reached
  the page as an empty object.

### Changed
- **`hydra build` prints what SSG did**, including the dynamic routes it left as
  a client shell and why.
- The runtime gate loads **every** HTML file a build produced, not only the root
  one, and treats a blank root on a route that has a component as a failure.

---

## 0.6.3 — 2026-11-02

**Every compiler error names its file now, and the docs stopped mixing two
different kinds of "not yet".** No behaviour change to emitted code.

### Fixed
- **`hydra check` and a failed build printed a caret with no filename.** The
  compiler is handed one file at a time and its spans are relative to that file,
  so `line 4, col 1` on a project with 200 pages was not actionable — the path
  was already known and used only for warnings. Both paths name the file now.
- **The CLI reference did not list `hydra routes`**, which had shipped two
  releases earlier and is documented above it in the same file.

### Changed
- **"Known limitations" is now two sections.** It mixed permanent design
  decisions with features that are simply not built yet, which made every future
  item look like a flaw. "Permanent limitations" holds the decisions and the
  reason for each; "Roadmap" holds what is coming, with target versions and an
  honest state, and names what is NOT planned (RSC, islands, streaming, deploy
  adapters) as a choice rather than a gap.

### Docs
- `MIGRATING.md` states plainly that no entry has needed a codemod yet, and why
  each one did not. There is no `hydra migrate`, and the file says so rather than
  leaving a rule that reads like a promise.

---

## 0.6.2 — 2026-11-02

**Keyword arguments stopped being a file-local feature.** The list said imported
functions must be called positionally because "the compiler cannot see their
signature". That was true of a package and was never checked for a project file,
which is the case people actually hit.

### Added
- **Keyword arguments for a function imported from a relative `.hys`/`.hyx`.**
  The emitter reads the `def` header from the file the specifier points at and
  reorders against it, exactly as it does for a local function. A misspelled
  keyword now names the parameters that exist: `greet() has no parameter named
  'nama'` ... `greet() takes: name, loud` — where before it was refused outright
  with no useful information.
- **Keyword arguments for a METHOD**, resolved when exactly ONE class in the file
  declares that name. `x.greet(loud=True)` and `super().greet(loud=True)` both
  work. When two classes declare the same method name only the receiver's type
  would decide, which this compiler does not track, so it refuses rather than
  guessing a signature that would be right half the time.

### Changed
- The two remaining refusals say which one they are. Before, a method call and a
  package call produced the same message about "functions defined in this file",
  which sent people looking in a place that was not the problem.
- The README's limitations header said 0.3.5 through four releases. It now names
  the version it was written against, which is the point of printing one.

Verified: cargo test 390 (269 + 121), node --test 48, and each case checked by
compiling it — the relative import reorders, the unknown keyword lists the real
parameters, the ambiguous method refuses, and a package import still refuses with
the narrowed reason.

---

## 0.6.1 — 2026-11-02

**`1500.5` with `.0f` now prints `1500`, not `1501`.** A patch, because the only
question is "does this match Python", and the answer used to be "not always".

### Fixed
- **Rounding a tie follows Python, not `toFixed`.** Python rounds a tie to the
  even digit — `format(1.5, ".0f")` is `2`, `format(0.5, ".0f")` is `0` — and it
  judges that tie against the value's exact binary expansion, so `format(1.005,
  ".2f")` is `1.00` (the double is slightly below the tie) while `format(0.135,
  ".2f")` is `0.14`. `toFixed` rounds every tie away from zero, which is a
  different answer on money and percentages. A `f` / `F` / `e` / `E` spec now
  goes through the runtime's `py_fixed`, which does the Python thing.
- **Grouping is applied after rounding, by the runtime.** `toLocaleString` did
  both at once and rounded half-away, so it disagreed with Python on the same
  values. `,` now goes through `py_group`, which groups the already-rounded
  digits.

Verified against Python itself rather than against a table I wrote: 21 value/spec
pairs and 12 grouped pairs, including the ties and the near-ties
(`0.125`→`0.12`, `0.135`→`0.14`, `2.675`→`2.67`, `1.005`→`1.00`, `9.995`→`9.99`,
`99.95`→`100.0`, `-0.5`→`-0`), all identical to `format()`.

### Fixed
- **A hint that sent you somewhere that fails the same way.** `class C(A, B)`
  said "extend one base and compose the rest, or use a .hys file", but the parse
  is shared and a `.hys` file was refused identically. The hint now names the two
  options that actually work.

### Notes
- The tie is detected after expanding the double to 100 fraction digits, which is
  past the ~767 a double can need; beyond `1e-100` the difference is under any
  precision an f-string can express. The bound is stated in the README.

---

## 0.6.0 — 2026-11-02

**File-based routing, and the limitations list got smaller.** Existing `.hyx` and
`.hys` files keep compiling. Two things that used to fail now work, so this is a
minor bump: nothing needs editing, but a project that had a workaround for either
can drop it.

### Added
- **File-based routing.** `src/pages/about.hyx` is `/about`, `blog/[slug].hyx` is
  `/blog/:slug`, `[...rest]` and `[[...rest]]` follow the conventions every
  meta-framework already uses. `_layout.hyx` nests, `_404.hyx` renders when
  nothing matches, `_error.hyx` is a per-folder error boundary, and a leading `_`
  makes a file or folder private. `hydra routes [--json]` prints the table.
- **Pre-rendering per route.** A build writes one HTML file per STATIC route
  (`dist/about/index.html`) instead of one `dist/index.html` for the whole site.
  Dynamic routes are named in the build log as left to the client, because a URL
  with a parameter has no single page to build.
- **The builtins that had no JS equivalent now have one.** `any`, `all`, `map`,
  `filter`, `getattr`, `hasattr`, `setattr`, `repr`. Their differences from Python
  are in the README rather than in the gaps between them: `any([])` is `False`,
  `all([])` is `True`, and `getattr(x, "y")` without a default raises
  `AttributeError` instead of returning `undefined`.

### Fixed
- **`super().method()` did not parse.** Only `super().__init__(...)` was
  recognised; every other parent method was `error: unexpected Dot`. The README
  recorded that as a limitation of KEYWORD arguments, which undersold it — no
  form worked, with or without keywords.
- **`map(fn, xs)` and `filter(fn, xs)` compiled to JSX elements.**
  `<map>{fn}{xs}</map>` dropped the receiver and never called anything. `map` and
  `filter` are real HTML tags, so the element rule won. Both still work as
  elements in a tree; the bare call form is now a call.
- **`divmod(a, b)` was emitted verbatim** and threw `ReferenceError`. A dead
  branch was the cause: a `match` arm dispatched on `args.len() >= 2` for names
  that are symmetric in arity, so the `== 1` arm below it was unreachable and
  `pow(2)` / `sum(xs, start)` / `round(x, n)` were dead code no test could reach.
- **`ord` and `chr` were implemented and unreachable**, for the same reason.
- **`type(x)` was not on the checker's list**, so it was reported as an unbound
  name while the emitter lowered it correctly.
- **The runtime gate checked one page per build.** With per-route HTML it now
  loads every `index.html` that was produced (bounded at 25, with the cap said out
  loud), so a route-specific crash cannot pass.

### Changed
- The runtime gate's messages and warnings name the page they came from.
- `hydra routes` joins the meta-framework commands; `bin/hydra.js` and the
  Rust CLI both dispatch it.

---

## 0.5.0 — 2026-11-01

**No language change.** Every `.hyx` that compiled on 0.4.0 compiles here, and none
needs editing. This release is seven emitter bugs fixed, each of which produced a
*build that reported success and code that threw at runtime* — the failure mode that
hurt most, because nothing in the toolchain said anything was wrong.

Found by converting all 218 react-bits components to Hydra and rendering every one.
Measured before: 65 of 218 rendered. This release moves it past 92.

### Fixed
- A constructor alias (`new Float32Array(n)`) was written *after* the line that used
  it, so the first use threw `Cannot access '<x>' before initialization`. Aliases are
  now declared once, after the imports, and a constructor bound *inside* a function is
  bound in that function's own scope instead.
- A `class` the emitter cannot write (there is no class syntax) was still aliased, so
  `__ctor_MorphEngine = MorphEngine` read an undeclared name at module evaluation and
  the whole bundle failed to load. One such class took down a 218-component page.
- `for a, b in items:` inside a tree emitted `.map(([a, b]) => ...)`, which JS reads as
  destructuring a pair out of a scalar; every non-array element threw. It now emits
  `.map((a, b) => ...)`.
- `tag`...`` — a tagged template — had no representation at all. It emitted the tag as
  a statement and the template as a separate one, so the value was never computed.
- Helpers registered by a loop/render callback were written *after* the `return` that
  used them — a `const`, hence unusable. They are now written above the body.
- A helper whose level belongs to a nested body was drained at file scope instead,
  which put its declaration below its own call site.
- `z.object({...})` compiled to the JSX element `<z.object>{...}</z.object>`. The
  receiver was dropped, so `SignupSchema` was a React element and `safeParse` was
  undefined at runtime. `object` is both a real HTML element and a very common member
  name; it now goes through `MEMBER_METHOD_NAMES`, the same list `map`, `filter` and
  `select` already use, so the bare form stays an element and the member form is a
  call. Found by `scripts/hx-examples-check.sh` in CI — no unit test covered it.

### Changed
- `vite-plugin/package.json` reported `0.1.0` while the root package reported `0.4.0`;
  both now move together. The version was already shipped, so the number was simply
  wrong.

## 0.4.0 — 2026-10-31

**This number moves because 0.3.4 was mis-numbered.** Nothing in 0.4.0 changes the
language; no `.hyx` file needs editing. But 0.3.4 made a build able to *fail* on
code that used to succeed, and that is a minor bump under semver, not a patch.
Skipping it would have left the registry with a release history that understates
what happened. So: 0.3.x is superseded here, and the entries below 0.4.0 record
what each of those numbers actually shipped.

### Added
- This file, shipped in the package (`files[]`) and linked from the README.
- `SPEC.md` and `MIGRATING.md` are in the README's table of contents. SPEC.md had
  no inbound link from anywhere; a reader who unpacked it had nothing telling
  them what it was for.

## 0.3.6 — 2026-10-31
### Fixed
- The README said "npm publishes nothing yet — installs come from the GitHub URL"
  forty lines below a section telling people to `npm install -D hydrascript`. The
  registry renders the README **from the tarball**, so correcting it on `main`
  did not change the npm page; that took a release.
- `any(xs)` / `all(xs)` were documented as auto-imported runtime helpers. The
  runtime does not export them and the emitter does not rewrite them, so they
  compiled to a bare call and died with `ReferenceError: any is not defined`.
  Replaced with `xs.some(lambda x: x > 2)`, and the missing builtins are now a
  listed limitation.
- `hydra init` wrote `"host": "0.0.0.0"` into every new project, overriding the
  dev server's loopback default. It writes `127.0.0.1` now, and the scaffold test
  pins that instead of pinning the old value.
- Stale figures: status line said 0.3.0, test counts said 308 (215 + 93), and the
  requirements said Node 18+ while `engines` requires >=22.

## 0.3.5 — 2026-10-31
### Fixed
- **Every build paid ~10 seconds for a check that never ran.** The runtime gate
  left WebGL enabled; on a machine with no GPU, `--disable-gpu` alone makes Chrome
  fall back to SwiftShader, and a page with a WebGL render loop starves the
  renderer until `Runtime.evaluate` dies on the 10 s CDP timeout. Measured on the
  same page: 10,001 ms with WebGL, 3 ms without. A bare `catch {}` swallowed the
  timeout, so the gate reported "passed" and the empty-shell check it guarded
  silently never executed.
- A second 10 s stall sat under the first: the CDP client's per-call timer was
  never cleared, and a pending timer keeps Node awake, so a gate that finished in
  2.5 s held the process to 12.6 s. `timer.unref()`.
- Both examples and the portfolio build in ~1/3 of the previous wall time, with
  byte-identical output.

## 0.3.4 — 2026-10-31
**Should have been 0.4.0.** Kept at 0.3.4 as published; corrected by 0.4.0.
### Changed
- **A build can refuse to build.** `hydra build` runs the semantic checker over
  `src/` and stops on a name no runtime provides (`any`, `all`, `map`, `filter`,
  `getattr`, `setattr`, `hasattr`, `repr`, `frozenset`, `dict`, `tuple`, `set`).
  Those always compiled to a call to something that does not exist; the failure
  used to reach the browser instead of the terminal. `HYDRA_NO_CHECK=1` builds
  anyway. See [MIGRATING.md](MIGRATING.md).
- `hydra check` gained `--strict`, and `hydra check <dir>` recurses the directory
  — it used to read a directory as a single file, fail to read it, and report it
  clean.
### Fixed
- `d.keys()` / `.values()` / `.items()` on a dict literal compiled to JS method
  calls on a plain object: `TypeError: d.keys is not a function` at runtime while
  `hydra check` stayed silent. They lower to Map- and object-safe runtime helpers
  now, and `d.items()` yields `[key, value]` pairs.
- `for i, v in enumerate(xs)` reported both names unbound (the parser stores an
  unpacking target as one string, `"[i, v]"`), and `slot` was reported as an
  unknown name although it is the compiler's own construct for `children`. Both
  broke every app `hydra init` produces — found by CI the moment the new build
  check was switched on.

## 0.3.3 — 2026-10-31
Security release, from an audit of the project.
### Changed
- The dev server binds `127.0.0.1` by default. It bound `0.0.0.0`, which put a
  developer's work on every interface. `--host` opts out, and the startup line
  names the interface actually reached.
- `/__hydra/version` no longer returns absolute project paths.
### Fixed
- Two vulnerable build-time transitive dependencies (`source-map-js`,
  `postcss-selector-parser`) bumped within their declared range; `npm audit` is
  clean.

## 0.3.2 — 2026-10-31
### Fixed
- **The CLI reported `0.3.0` while npm served `0.3.1`.** `bin/hydra --version`
  reads `CARGO_PKG_VERSION`, and only `package.json` had been bumped, so the two
  numbers could drift silently. Both are bumped together now, and CI fails on a
  mismatch.
- `scripts/pack-install-check.sh` asserted a hardcoded `"hydra 0.3.0"`; it reads
  the expected version from `package.json`.

## 0.3.1 — 2026-10-31
### Fixed
- `[n, set_n] = useState(0)` — the bracketed destructuring React's own docs teach
  — emitted without `const`, so it threw `ReferenceError: n is not defined` at
  runtime while the build reported success and the page rendered blank. It
  parses as a list, not a tuple, and only tuple/dict targets bound names.
- `release.yml` never installed the repo's dependencies, so 6 of 25 node tests
  failed on the first real release; `dts.test.mjs` wrote a `tsconfig.json`
  alongside explicit file arguments, which newer `tsc` rejects.

## 0.3.0 — 2026-10-31
First release on the npm registry, published via trusted publishing (OIDC) with
provenance attached, so no long-lived token is stored anywhere. A leftover token
found on disk during this work was removed and revoked.
### Added
- `hydra types`: TypeScript declarations generated from a component's own
  parameters, written as `<file>.hyx.d.ts`. `list` -> `Array<T>`,
  `dict` -> `Record<string, T>`; a shape it cannot represent is omitted rather
  than invented, because a declaration that lies is worse than none.
- The syntax is frozen: no new language features before 1.0.
