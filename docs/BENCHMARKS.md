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
| Test suite | 408 Rust tests, all passing | `cargo test` (271 unit + 137 integration) |
| Node suite | 147 tests, all passing | `node --test packages/cli/*.test.mjs` |
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


## Route matching, and why it is a linear scan

`matchRoute` walks the generated table and returns the first hit. That is O(n) in
the number of routes, and a trie would be O(1). Here is what the scan actually
costs, measured with `node benchmarks/routes.mjs` on this box:

| Routes | Early hit | Late hit | No match |
|---|---|---|---|
| 50 | 2.1 us | 3.2 us | 2.2 us |
| 500 | 1.2 us | 18 us | 21 us |
| 2000 | 1.5 us | 41 us | 68 us |

The table is sorted most-specific-first, so a real URL matches its route early and
costs roughly a microsecond. The expensive columns are a URL that matches nothing
or matches only near the end, which is one navigation, not one render.

So there is no trie yet, and the reason is that no measurement asks for one:
68 us on a 2000-route site is under a frame, on the one navigation that hits it.
What would change the answer is a site with thousands of routes where most
navigations MISS, which is not a shape this has seen. When it is, the fix is a
literal-first index before the scan, and this table is what would justify it.

Generation is the other half, and it is per build rather than per navigation:
scan plus emit of 2000 routes is ~85 ms and produces a ~460 KB module, measured
with `node benchmarks/route-table.mjs`.
