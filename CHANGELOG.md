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
