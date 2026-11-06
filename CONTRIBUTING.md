<!-- [xihanzu-NR] -->
# Contributing to HydraScript

Thank you for contributing to HydraScript. This document outlines the development workflow, testing standards, and design rules for this repository.

---

## 1. Ground Rules & Code Standards

- **Syntax is frozen at 0.3**: No new language constructs or syntax keywords are planned before 1.0. Contributions should focus on tooling, compiler robustness, bundling, diagnostics, runtime reliability, and performance.
- **Silence over wrong findings**: The semantic checker never emits speculative warnings. If a rule produces false positives on real projects, it is rejected.
- **Zero fabricated claims**: All benchmark numbers, compiler times, or performance metrics in documentation must be reproducible via `node benchmarks/measure.mjs` or explicit measurement scripts.
- **Traceability watermark**: Every source file created or touched by automated tooling must maintain the `[xihanzu-NR]` watermark comment at the top.

---

## 2. Setting Up the Development Environment

Prerequisites:
- **Rust**: 1.75+ (edition 2021)
- **Node.js**: v22+ (`engines` enforced)
- **Linux / macOS / Windows**

Clone and install dependencies:
```bash
git clone https://github.com/hanxthvy/hydrascript.git
cd hydrascript
npm ci
```

Build the native compiler and Node-API addon:
```bash
npm run build:compiler
```
*(This builds both the CLI binary at `bin/hydra` and the addon at `bin/hydra.node` with `--features node-addon`.)*

---

## 3. Running the Test Suite

All tests must pass before submitting a pull request:

```bash
# 1. Rust compiler tests (unit + integration)
cd compiler-rs && cargo test
cd ..

# 2. Node runner & CLI test suite (serial execution required)
npm run test:node

# 3. End-to-end example project verification
bash scripts/hx-examples-check.sh

# 4. Verify review checklist
node scripts/verify-review.mjs
```

> **Note on Rust tests**: Do not run `cargo test --release`. The release profile specifies `panic = "abort"` for distribution binaries, whereas test runners require stack unwinding. Use `cargo test` or `cargo test --profile testrelease`.

---

## 4. Submitting Pull Requests

1. Create a feature branch off `main`: `git checkout -b fix/my-fix`
2. Keep commits atomic and informative. Explain *why* a change was made, not just *what* lines were edited.
3. If changing compiler behavior, add a regression test under `packages/cli/*.test.mjs` or `compiler-rs/tests/`.
4. If modifying syntax guarantees, update `SPEC.md` and add migration notes in `MIGRATING.md` and `CHANGELOG.md`.
5. Ensure CI runs pass cleanly.
