// [xihanzu-NR]
//! Project scaffolding and diagnostics.
//!
//!   hydra init [dir] [--force]   scaffold a new HydraScript project
//!   hydra doctor                 check the local toolchain & project layout
//!   hydra stats [dir]            summarise a HydraScript codebase
//!
//! The compiler binary ships with zero dependencies, so every JSON payload here
//! is hand-rolled the same way `main.rs` hand-rolls its `{code, map}` output.

use std::fs;

/// Directories never descended into when walking a project tree.
const SKIP_DIRS: &[&str] = &["node_modules", "dist", ".git", "target"];

const INIT_USAGE: &str = "\
hydra init — scaffold a new HydraScript project

USAGE:
  hydra init [dir] [options]

ARGS:
  dir        target directory (default: current directory)

OPTIONS:
  --template=app|blank    app: routing + example pages. blank: one page.
  --styling=tailwind|postcss|plain
                          how src/index.css is processed (also: --css=)
  --layout=pages|single   file-based router, or one page (app only)
  --ssg=true|false        pre-render pages at build time
  --types=true|false      emit TypeScript declarations (.d.ts)
  --yes, -y               take the defaults, ask nothing
  --force                 overwrite an existing hydraconfig.json
  -h, --help              show this message

  With no flags and a terminal attached, init asks what to generate.
  Piped or in CI it takes the defaults, so scripts keep working unchanged.

CREATES:
  hydraconfig.json        project config (name, outputDir, port 5173, ssg)
  package.json            react + react-dom, toolchain as devDependencies
  tailwind.config.js      mirrors the tailwind key in hydraconfig.json
  index.html              SPA mount point (#root)
  README.md               layout and commands
  src/main.hyx            entry; mounts the app
  src/App.hyx             state, page switch, component wiring
  src/index.css           the three Tailwind directives
  src/components/         Header.hyx, Card.hyx, Button.hyx
  src/lib/stats.hys       pure helpers, imported by App.hyx
  src/pages/              index.hyx, about.hyx, _404.hyx
";

const DOCTOR_USAGE: &str = "\
hydra doctor — check the local toolchain and project layout

USAGE:
  hydra doctor

CHECKS:
  compiler version, node, bun (optional), npm,
  hydraconfig.json (walked up from cwd), package.json, source file counts,
  the shipped artifacts (bin/hydra, bin/hydra.node, packages/cli/runner.mjs)
  with size, mtime and content hash

EXIT:
  0  every check passed (warnings are allowed)
  1  at least one check failed
";

const STATS_USAGE: &str = "\
hydra stats — summarise a HydraScript codebase

USAGE:
  hydra stats [dir]

ARGS:
  dir        directory to scan (default: ./src, falling back to .)

REPORTS:
  file counts for .hyx / .hys, total and non-blank lines,
  component and def counts, import lines,
  the 10 largest files by line count
";

mod doctor;
mod init;
mod stats;
mod templates;
mod util;

pub use doctor::doctor;
pub use init::init;
pub use stats::stats;
