<!-- [xihanzu-NR] -->
# Benchmarks, and what they do not claim

Every number here comes from `node benchmarks/measure.mjs`, run on the machine
that built this repo (2 vCPU, Linux x86_64, Node v22). Run it yourself before
believing any of it.

| Claim | Measured value | How |
|---|---|---|
| `hydra --check` latency | ~1.8–2.1 ms median | 20 runs, process spawn included |
| `hydra <file>` latency | ~1.9–2.0 ms median | 20 runs, process spawn included |
| In-process compile (`hydra.node`) | ~0.063–0.067 ms median | 2000 warm iterations, no spawn |
| Test suite | 377 tests, all passing | `cargo test` (266 unit + 111 integration) |
| Node suite | 29 tests, all passing | `node --test packages/cli` |
| CLI binary | 1.2 MB (1,225,880 bytes) | `bin/hydra`, stripped |
| N-API addon | 901 KB (922,680 bytes) | `bin/hydra.node` |
| Runtime cost of the `hydra` import | ~200 bytes | Built an identical app with and without it |
| Token count, one component | 130 vs 188 (−30.9%) | `benchmarks/tokens.py`, `cl100k_base` |
| SSG output, small page | 3.6 KB HTML | `examples/blog` with `ssg: true` |
| Dev rebuild (`hydra dev` save) | 508–756 ms vs 1252 ms before | `benchmarks/build-ab.mjs --dev`, 3 edits each |
| Production build (portfolio) | ~2.3–2.6 s | Same script, 4 runs each, **runtime gate off** |

That last row has a footnote now. The production build runs a runtime gate at
the end — it loads the built page in headless Chrome and fails the build if the
page throws — and the gate costs about 2.5 s. So a full `hydra build` on that
project is ~5 s wall even though the build itself is the same 2.4 s it always
was. The gate is new work, not a regression. `HYDRA_NO_GATE=1 hydra build` skips
it, and `HYDRA_GATE_SETTLE_MS=0` trims the 0.9 s settle it waits before judging
the page.

## What this does not claim, and why

- No "Nx faster than `tsc`" figures. Comparing against another toolchain
  requires running that toolchain on the same machine with the same input; the
  old numbers here (1,610×, 24×, 3.3×) were neither reproducible nor
  apples-to-apples, so they are gone.
- No "zero extra kilobytes". The runtime is small (~200 bytes for a component
  that uses it) but not zero, and react + react-dom dominate any real bundle.
- **No claim that the production build got faster.** It did not: repeated A/B
  runs land inside each other's spread (~2.3–2.6 s). What got faster is the
  `hydra dev` rebuild loop, because that is the path that runs hundreds of
  times a day. The production path was already dominated by esbuild's own
  minify+bundle work, which no option here changes.
- No AI/LLM token-efficiency study. The old "12.6% fewer tokens across 5
  production components" had no script, no corpus, and no commit behind it. One
  component is measured instead, and the number is labelled as one component.
