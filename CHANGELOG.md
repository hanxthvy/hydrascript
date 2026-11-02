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
