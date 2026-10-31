<!-- [xihanzu-NR] -->
# Developing HydraScript

For people changing the compiler or the runner. Everything here is about the
build itself, not about writing `.hyx` files — see the top of the README for that.

## Profiling a build

    HYDRA_PROFILE=1 hydra build

Prints a per-phase breakdown to stderr. Kept in the shipped runner because
"where did the build time go" is the first question after any bundler change,
and a profiler that lives in a scratch script gets rewritten every time. On the
portfolio it reports roughly: client bundle 60%, bundled deps 20%, pre-render
20% (the pre-render's esbuild pass overlaps the client one, so it shows as
near-zero when the machine has a spare core).

Two project options exist because of what the profile showed:

- `"build": { "sourcemap": false }` — sourcemaps are the single most expensive
  option in the client build. On by default; off is a real saving for a project
  that debugs from the deployed source.
- `HYDRA_NO_SSG=1` — skip pre-rendering for one build. `hydra dev` already
  skips it, because a pre-rendered shell is for crawlers and nobody watching
  the dev loop is one.

## The runtime gate

`hydra build` ends by loading the built page in headless Chrome and failing the
build on an uncaught exception. Two environment variables matter when you are
working on it:

- `HYDRA_NO_GATE=1` — skip it. Use when you are editing the runner and the gate
  is just noise.
- `HYDRA_GATE_SETTLE_MS` — how long to let the page settle after `load` before
  judging it (default 900).

Chrome is driven over the DevTools Protocol with Node's built-in WebSocket, so
there is no puppeteer dependency. The flags live in `GATE_CHROME_FLAGS`
(`packages/cli/runtime-gate.mjs`) and are asserted by a test, because one of them
tells you a lot about how this gate can go wrong:

**`--disable-webgl` is load-bearing.** On a machine with no GPU — every CI
runner — `--disable-gpu` alone leaves Chrome falling back to SwiftShader, and a
page with a WebGL render loop starves the renderer's main thread until
`Runtime.evaluate` misses its slot and dies on the 10 s CDP timeout. Measured on
the same page: 10,001 ms with WebGL on, 3 ms with it off. The gate reported
"passed" the whole time, because a `catch {}` swallowed the timeout and the
empty-shell check it guarded silently never ran. If a build seems slow for no
reason, that is the shape of it.

## Rebuilding the shipped binaries

The npm package ships two artifacts and both must be refreshed together: the CLI
(`bin/hydra`) and the N-API addon (`bin/hydra.node`, built as `libhydra.so`).
`hydra <file>` uses the CLI; `hydra build` uses the addon. Copy one and not the
other and you get a build that disagrees with itself.

```bash
cd compiler-rs && cargo build --release
cp target/release/hydra ../bin/hydra
cp target/release/libhydra.so ../bin/hydra.node
```

`Cargo.lock` must be committed whenever the version changes; CI builds with
`--locked` and fails otherwise.

## Version, in exactly one place

`package.json` and `compiler-rs/Cargo.toml` must agree. `bin/hydra --version`
reads `CARGO_PKG_VERSION`, so bumping only `package.json` ships a binary that
reports the previous version — that happened once, in 0.3.1. CI runs a drift
check and fails on a mismatch.

A behaviour change that can stop someone's build needs an entry in
`MIGRATING.md`, with the path out of it. Say what breaks and how to un-break it.
