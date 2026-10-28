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
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Directories never descended into when walking a project tree.
const SKIP_DIRS: &[&str] = &["node_modules", "dist", ".git", "target"];

const INIT_USAGE: &str = "\
hydra init — scaffold a new HydraScript project

USAGE:
  hydra init [dir] [--force]

ARGS:
  dir        target directory (default: current directory)

OPTIONS:
  --force    overwrite an existing hydraconfig.json
  -h, --help show this message

CREATES:
  hydraconfig.json   project config (name, port 5173, entries)
  package.json       scripts: dev / build / preview
  index.html         SPA mount point (#root)
  src/main.hyx       entry; mounts the app
  src/App.hyx        heading + counter button
  README.md          how to run
";

const DOCTOR_USAGE: &str = "\
hydra doctor — check the local toolchain and project layout

USAGE:
  hydra doctor

CHECKS:
  compiler version, node, bun (optional), npm,
  hydraconfig.json (walked up from cwd), package.json, source file counts

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

fn has_help(args: &[String]) -> bool {
    args.iter().any(|a| a == "--help" || a == "-h")
}

/// First positional (non-flag) argument, if any.
fn positional(args: &[String]) -> Option<&String> {
    args.iter().find(|a| !a.starts_with('-'))
}

/// Run `program args...` and return its trimmed stdout, or `None` if the
/// program is missing, exits non-zero, or prints nothing.
fn version_of(program: &str) -> Option<String> {
    let out = std::process::Command::new(program)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Minimal JSON string escaping — enough for names that come from directory names.
fn json_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            other => o.push(other),
        }
    }
    o
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

/// Recursively visit every regular file under `dir`, skipping `SKIP_DIRS`.
/// Missing or unreadable directories are silently ignored, so this never
/// panics on a bad path.
fn walk(dir: &Path, visit: &mut dyn FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `file_type()` does not follow symlinks, which also keeps symlink
        // cycles from turning into infinite recursion.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            let skip = path
                .file_name()
                .and_then(|n| n.to_str())
                .map_or(false, |n| SKIP_DIRS.contains(&n));
            if !skip {
                walk(&path, visit);
            }
        } else if kind.is_file() {
            visit(&path);
        }
    }
}

/// Every file under `dir`, sorted for deterministic output.
fn collect_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(dir, &mut |p| out.push(p.to_path_buf()));
    out.sort();
    out
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
struct SourceCounts {
    hyx: usize,
    hys: usize,
}

impl SourceCounts {
    fn total(&self) -> usize {
        self.hyx + self.hys
    }
}

/// Count `.hyx` and `.hys` files anywhere under `dir`.
fn count_sources(dir: &Path) -> SourceCounts {
    let mut counts = SourceCounts::default();
    for path in collect_files(dir) {
        match path.extension().and_then(|e| e.to_str()) {
            Some("hyx") => counts.hyx += 1,
            Some("hys") => counts.hys += 1,
            _ => {}
        }
    }
    counts
}

// ---------------------------------------------------------------------------
// Source metrics
// ---------------------------------------------------------------------------

/// Per-file metrics derived from one source file's text.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
struct SourceMetrics {
    lines: usize,
    non_blank: usize,
    components: usize,
    functions: usize,
    imports: usize,
}

/// `true` for `component Foo(...)`, `export component Foo(...)`, `async component ...`.
fn is_component_def(trimmed: &str) -> bool {
    trimmed == "component"
        || trimmed.starts_with("component ")
        || trimmed.starts_with("export component ")
        || trimmed.starts_with("async component ")
}

/// `true` for `def foo(...)`, `export def ...`, `async def ...`.
fn is_function_def(trimmed: &str) -> bool {
    trimmed == "def"
        || trimmed.starts_with("def ")
        || trimmed.starts_with("export def ")
        || trimmed.starts_with("async def ")
}

/// `true` for both import forms the language has: `import "x"` and
/// `from "x" import y`.
fn is_import(trimmed: &str) -> bool {
    trimmed.starts_with("import ") || trimmed.starts_with("from ")
}

/// Count the things `hydra stats` reports for a single source file.
fn metrics_of(src: &str) -> SourceMetrics {
    let mut m = SourceMetrics::default();
    for line in src.lines() {
        m.lines += 1;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        m.non_blank += 1;
        if is_component_def(trimmed) {
            m.components += 1;
        } else if is_function_def(trimmed) {
            m.functions += 1;
        } else if is_import(trimmed) {
            m.imports += 1;
        }
    }
    m
}

/// Aggregate metrics for a whole directory, plus per-file line counts.
#[derive(Default, Debug)]
struct RepoStats {
    counts: SourceCounts,
    metrics: SourceMetrics,
    /// `(path, line_count)` for every scanned source file.
    files: Vec<(PathBuf, usize)>,
}

fn scan(dir: &Path) -> RepoStats {
    let mut stats = RepoStats::default();
    for path in collect_files(dir) {
        let is_source = matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("hyx") | Some("hys")
        );
        if !is_source {
            continue;
        }
        match path.extension().and_then(|e| e.to_str()) {
            Some("hyx") => stats.counts.hyx += 1,
            Some("hys") => stats.counts.hys += 1,
            _ => {}
        }
        // A file we cannot read still counts as a file, just with no lines.
        let src = fs::read_to_string(&path).unwrap_or_default();
        let m = metrics_of(&src);
        stats.metrics.lines += m.lines;
        stats.metrics.non_blank += m.non_blank;
        stats.metrics.components += m.components;
        stats.metrics.functions += m.functions;
        stats.metrics.imports += m.imports;
        stats.files.push((path, m.lines));
    }
    stats
}

// ---------------------------------------------------------------------------
// `hydra init`
// ---------------------------------------------------------------------------

const HYDRACONFIG_TEMPLATE: &str = r#"{
  "$schema": "https://hydrascript.dev/schema.json",
  "name": "__NAME__",
  "version": "0.1.0",
  "root": "./src",
  "outputDir": "./dist",
  "entries": {
    "app": "./src/main.hyx"
  },
  "server": {
    "port": 5173,
    "host": "0.0.0.0"
  },
  "compiler": {
    "target": "react-18",
    "strict": true
  },
  "styling": {
    "tailwind": true
  }
}
"#;

const PACKAGE_JSON_TEMPLATE: &str = r#"{
  "name": "__NAME__",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "hydra dev",
    "build": "hydra build",
    "preview": "hydra preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "hydrascript": "^0.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.1"
  }
}
"#;

const INDEX_HTML_TEMPLATE: &str = r#"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.hyx"></script>
  </body>
</html>
"#;

const MAIN_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from "react-dom/client" import createRoot
from "./App.hyx" import App

root_element = document.getElementById("root")
createRoot(root_element).render(App())
"#;

const APP_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from hydra import state

component App():
    count, set_count = state(0)

    main(className="min-h-screen flex items-center justify-center bg-slate-50"):
        section(className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-8 text-center shadow-xl"):
            h1(className="text-3xl font-extrabold text-slate-900"): "HydraScript"
            p(className="text-sm text-slate-500"): "Edit src/App.hyx and save to reload."
            div(className="flex items-center justify-center gap-4"):
                button(
                    on_click=lambda: set_count(count - 1),
                    className="h-10 w-10 rounded-lg bg-slate-100 text-xl font-bold text-slate-700 hover:bg-slate-200",
                ): "-"
                span(className="w-12 text-3xl font-black tabular-nums text-indigo-600"): count
                button(
                    on_click=lambda: set_count(count + 1),
                    className="h-10 w-10 rounded-lg bg-indigo-600 text-xl font-bold text-white hover:bg-indigo-700",
                ): "+"
"#;

const README_TEMPLATE: &str = r#"# __NAME__

A HydraScript application — Pythonic syntax that compiles to React.

## Requirements

- Node.js 18+ (Bun also works and is used automatically when present)
- Nothing else: the `hydrascript` compiler is installed by `npm install`

## Getting started

```bash
npm install
npx hydra dev
```

The dev server prints a local URL (default port `5173`).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server with hot reload |
| `npm run build` | Build for production into `dist/` |
| `npm run preview` | Serve the production build locally |

## Layout

```
hydraconfig.json   project config (name, port, entries)
index.html         SPA mount point (#root)
src/main.hyx       entry — mounts App into #root
src/App.hyx        the app component
```

## Writing code

`.hyx` files are React components, `.hys` files are plain Node/ESM modules:

```python
# src/App.hyx
from hydra import state

component App():
    count, set_count = state(0)
    button(on_click=lambda: set_count(count + 1)): f"Clicked {count} times"
```

Check anything the compiler sees without emitting output:

```bash
npx hydra --check src/App.hyx
```
"#;

/// Render a template, substituting `__NAME__` with the (JSON-escaped) name.
fn render(template: &str, name: &str) -> String {
    template.replace("__NAME__", &json_escape(name))
}

/// Project name derived from the target directory's final path component.
fn project_name(root: &Path) -> String {
    root.file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && *n != "." && *n != "..")
        .map(|n| n.to_string())
        .unwrap_or_else(|| "hydra-app".to_string())
}

pub fn init(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", INIT_USAGE);
        return ExitCode::SUCCESS;
    }

    let force = args.iter().any(|a| a == "--force");
    let root = positional(args).map_or_else(|| PathBuf::from("."), PathBuf::from);

    if root.exists() && !root.is_dir() {
        eprintln!("hydra: {} exists and is not a directory", root.display());
        return ExitCode::from(1);
    }

    let config_path = root.join("hydraconfig.json");
    if config_path.exists() && !force {
        eprintln!("refusing to overwrite hydraconfig.json (use --force)");
        return ExitCode::from(1);
    }

    let name = project_name(&root);

    if let Err(e) = fs::create_dir_all(root.join("src")) {
        eprintln!("hydra: cannot create {}: {}", root.join("src").display(), e);
        return ExitCode::from(1);
    }

    let files: Vec<(PathBuf, String)> = vec![
        (
            root.join("hydraconfig.json"),
            render(HYDRACONFIG_TEMPLATE, &name),
        ),
        (
            root.join("package.json"),
            render(PACKAGE_JSON_TEMPLATE, &name),
        ),
        (root.join("index.html"), render(INDEX_HTML_TEMPLATE, &name)),
        (
            root.join("src").join("main.hyx"),
            MAIN_HYX_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("App.hyx"),
            APP_HYX_TEMPLATE.to_string(),
        ),
        (root.join("README.md"), render(README_TEMPLATE, &name)),
    ];

    let mut written: Vec<PathBuf> = Vec::with_capacity(files.len());
    for (path, content) in files {
        if let Err(e) = fs::write(&path, content) {
            eprintln!("hydra: cannot write {}: {}", path.display(), e);
            return ExitCode::from(1);
        }
        written.push(path);
    }

    println!("Scaffolded HydraScript project {:?}", name);
    for path in &written {
        println!("  created {}", path.display());
    }
    println!(
        "Next: cd {} && npm install && npx hydra dev",
        root.display()
    );

    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// `hydra doctor`
// ---------------------------------------------------------------------------

/// Walk up from `start` looking for `filename`. Returns the absolute-ish path.
fn find_up(start: &Path, filename: &str) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join(filename);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
}

pub fn doctor(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", DOCTOR_USAGE);
        return ExitCode::SUCCESS;
    }

    println!("hydra {} — health report", env!("CARGO_PKG_VERSION"));
    println!();

    let mut failed = 0usize;

    // The compiler itself is running, so the version is always available.
    println!("ok    compiler {}", env!("CARGO_PKG_VERSION"));

    match version_of("node") {
        Some(v) => println!("ok    node {}", v),
        None => {
            println!("fail  node not found (required to run dev / build / preview)");
            failed += 1;
        }
    }

    match version_of("bun") {
        Some(v) => println!("ok    bun {}", v),
        None => println!("warn  bun not found (optional)"),
    }

    match version_of("npm") {
        Some(v) => println!("ok    npm {}", v),
        None => println!("warn  npm not found (bun or npx can stand in)"),
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    match find_up(&cwd, "hydraconfig.json") {
        Some(path) => println!("ok    hydraconfig.json {}", path.display()),
        None => println!("warn  hydraconfig.json not found (run `hydra init`)"),
    }

    // "Project root" is the directory holding hydraconfig.json; without one we
    // fall back to cwd.
    let root = find_up(&cwd, "hydraconfig.json")
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| cwd.clone());

    match root.join("package.json").is_file() {
        true => println!("ok    package.json {}", root.join("package.json").display()),
        false => println!("warn  package.json not found in {}", root.display()),
    }

    let src = root.join("src");
    let counts = count_sources(&src);
    println!(
        "ok    sources {} .hyx, {} .hys under {}",
        counts.hyx,
        counts.hys,
        src.display()
    );

    println!();
    if failed > 0 {
        println!("{} check(s) failed", failed);
        ExitCode::from(1)
    } else {
        println!("all checks passed");
        ExitCode::SUCCESS
    }
}

// ---------------------------------------------------------------------------
// `hydra stats`
// ---------------------------------------------------------------------------

pub fn stats(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", STATS_USAGE);
        return ExitCode::SUCCESS;
    }

    // Default to ./src, falling back to . when there is no src directory.
    let dir = match positional(args) {
        Some(d) => PathBuf::from(d),
        None => {
            let src = PathBuf::from("src");
            if src.is_dir() {
                src
            } else {
                PathBuf::from(".")
            }
        }
    };

    let found = scan(&dir);

    println!("hydra stats — {}", dir.display());
    println!("files.hyx: {}", found.counts.hyx);
    println!("files.hys: {}", found.counts.hys);
    println!("files.source: {}", found.counts.total());
    println!("lines.total: {}", found.metrics.lines);
    println!("lines.non_blank: {}", found.metrics.non_blank);
    println!(
        "lines.blank: {}",
        found.metrics.lines.saturating_sub(found.metrics.non_blank)
    );
    println!("defs.component: {}", found.metrics.components);
    println!("defs.function: {}", found.metrics.functions);
    println!("imports: {}", found.metrics.imports);

    // Ten biggest files, biggest first; ties broken by path for stable output.
    let mut files = found.files;
    files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    println!("largest:");
    if files.is_empty() {
        println!("  (no .hyx or .hys files found)");
    } else {
        for (path, lines) in files.iter().take(10) {
            println!("  {} {}", lines, path.display());
        }
    }

    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A unique scratch directory under the system temp dir, removed on drop.
    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let root = std::env::temp_dir().join(format!(
                "hydra-scaffold-{}-{}-{}",
                tag,
                std::process::id(),
                nanos
            ));
            fs::create_dir_all(&root).expect("create temp tree");
            TempTree { root }
        }

        fn write(&self, rel: &str, content: &str) {
            let path = self.root.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            fs::write(&path, content).expect("write temp file");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn walk_counts_files_across_nested_dirs() {
        let tree = TempTree::new("walk");
        tree.write("src/main.hyx", "component Main():\n    div: \"x\"\n");
        tree.write("src/App.hyx", "component App():\n    div: \"y\"\n");
        tree.write("src/lib/util.hys", "def add(a, b):\n    return a + b\n");
        tree.write(
            "src/lib/deep/nested/extra.hyx",
            "component Extra():\n    span: \"z\"\n",
        );
        // Noise that must not be counted.
        tree.write("src/notes.txt", "not source\n");
        tree.write("src/lib/util.hys.map", "{}\n");
        tree.write(
            "node_modules/pkg/index.hyx",
            "component Vendored():\n    div: \"v\"\n",
        );
        tree.write("dist/bundle.hyx", "component Bundled():\n    div: \"b\"\n");
        tree.write(".git/hooks/sample.hys", "def hook():\n    return 1\n");
        tree.write(
            "target/debug/artifacts.hyx",
            "component Artifact():\n    div: \"a\"\n",
        );

        let counts = count_sources(&tree.root);
        assert_eq!(counts.hyx, 3, "only .hyx files outside skipped dirs");
        assert_eq!(counts.hys, 1, "only .hys files outside skipped dirs");
        assert_eq!(counts.total(), 4);

        // Walking from a nested directory sees only that subtree.
        let nested = count_sources(&tree.root.join("src/lib"));
        assert_eq!(nested.hyx, 1);
        assert_eq!(nested.hys, 1);
    }

    #[test]
    fn missing_directory_counts_zero_and_does_not_panic() {
        let missing = std::env::temp_dir().join("hydra-scaffold-definitely-missing-dir");
        let counts = count_sources(&missing);
        assert_eq!(counts, SourceCounts::default());

        let stats = scan(&missing);
        assert_eq!(stats.counts.total(), 0);
        assert_eq!(stats.metrics.lines, 0);
        assert_eq!(stats.metrics.components, 0);
        assert_eq!(stats.metrics.functions, 0);
        assert_eq!(stats.metrics.imports, 0);
        assert!(stats.files.is_empty());
    }

    #[test]
    fn empty_directory_counts_zero() {
        let tree = TempTree::new("empty");
        let counts = count_sources(&tree.root);
        assert_eq!(counts.total(), 0);
        assert!(collect_files(&tree.root).is_empty());
    }

    #[test]
    fn metrics_count_components_defs_and_imports() {
        let src = "\
# [xihanzu-NR]
from hydra import state
from \"./App.hyx\" import App
import \"./index.css\"

component Counter(initial: int = 0):
    count, set_count = state(initial)

    button(on_click=lambda: set_count(count + 1)):
        \"+\"

def add(a, b):
    return a + b

async def fetch_all(urls):
    return urls

export component Badge(label: str):
    span: label
";
        let m = metrics_of(src);
        assert_eq!(m.components, 2, "Counter + export component Badge");
        assert_eq!(m.functions, 2, "def add + async def fetch_all");
        assert_eq!(m.imports, 3, "from, from, import");
        assert_eq!(m.lines, 19);
        assert_eq!(m.non_blank, 14, "19 lines minus 5 blank separators");
    }

    #[test]
    fn metrics_ignore_blank_and_commented_definitions() {
        let src = "\n\n   \n# component Nope():\ncomponent Real():\n    div: \"x\"\n\n";
        let m = metrics_of(src);
        assert_eq!(m.components, 1);
        assert_eq!(m.functions, 0);
        assert_eq!(m.imports, 0);
        assert_eq!(m.lines, 7);
        assert_eq!(m.non_blank, 3);
    }

    #[test]
    fn scan_aggregates_and_ranks_files_by_size() {
        let tree = TempTree::new("scan");
        tree.write("src/main.hyx", "from \"./App.hyx\" import App\n\nApp()\n");
        tree.write(
            "src/App.hyx",
            "from hydra import state\n\ncomponent App():\n    n, set_n = state(0)\n    div: n\n",
        );
        tree.write("src/util.hys", "def add(a, b):\n    return a + b\n");

        let stats = scan(&tree.root);
        assert_eq!(stats.counts.hyx, 2);
        assert_eq!(stats.counts.hys, 1);
        assert_eq!(stats.metrics.components, 1);
        assert_eq!(stats.metrics.functions, 1);
        assert_eq!(stats.metrics.imports, 2);
        assert_eq!(stats.metrics.lines, 3 + 5 + 2);
        assert_eq!(
            stats.metrics.non_blank,
            2 + 4 + 2,
            "main.hyx and App.hyx each hold one blank line"
        );

        let mut ranked = stats.files.clone();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        assert_eq!(ranked[0].1, 5, "App.hyx is the largest");
        assert_eq!(ranked[0].0.file_name().unwrap(), "App.hyx");
        assert_eq!(ranked.len(), 3);
    }

    #[test]
    fn init_scaffolds_a_project_under_a_temp_dir() {
        let tree = TempTree::new("init");
        let target = tree.root.join("demo-app");
        let target_str = target.to_string_lossy().to_string();

        assert_eq!(init(&[target_str.clone()]), ExitCode::SUCCESS);

        for rel in [
            "hydraconfig.json",
            "package.json",
            "index.html",
            "src/main.hyx",
            "src/App.hyx",
            "README.md",
        ] {
            assert!(target.join(rel).is_file(), "expected {} to exist", rel);
        }

        let config = fs::read_to_string(target.join("hydraconfig.json")).unwrap();
        assert!(config.contains("\"name\": \"demo-app\""));
        assert!(config.contains("\"port\": 5173"));
        assert!(config.contains("\"app\": \"./src/main.hyx\""));

        let pkg = fs::read_to_string(target.join("package.json")).unwrap();
        assert!(pkg.contains("\"hydrascript\""));
        for script in ["\"dev\"", "\"build\"", "\"preview\""] {
            assert!(pkg.contains(script), "package.json missing {}", script);
        }
    }

    #[test]
    fn init_refuses_to_overwrite_without_force() {
        let tree = TempTree::new("init-refuse");
        let target = tree.root.join("existing");
        let target_str = target.to_string_lossy().to_string();

        fs::create_dir_all(target.join("src")).unwrap();
        fs::write(target.join("hydraconfig.json"), "{\"name\": \"keep-me\"}").unwrap();

        assert_eq!(init(&[target_str.clone()]), ExitCode::from(1));

        // The original config must be untouched.
        let config = fs::read_to_string(target.join("hydraconfig.json")).unwrap();
        assert_eq!(config, "{\"name\": \"keep-me\"}");
        assert!(!target.join("src/App.hyx").exists());

        // --force replaces it.
        assert_eq!(
            init(&[target_str.clone(), "--force".to_string()]),
            ExitCode::SUCCESS
        );
        let config = fs::read_to_string(target.join("hydraconfig.json")).unwrap();
        assert!(config.contains("\"name\": \"existing\""));
    }

    #[test]
    fn subcommand_help_exits_zero() {
        let help = vec!["--help".to_string()];
        assert_eq!(init(&help), ExitCode::SUCCESS);
        assert_eq!(doctor(&help), ExitCode::SUCCESS);
        assert_eq!(stats(&help), ExitCode::SUCCESS);
    }
}
