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
