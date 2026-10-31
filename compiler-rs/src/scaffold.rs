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
  src/pages/              Home.hyx, About.hyx
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
  "$schema": "https://raw.githubusercontent.com/hanxthvy/hydrascript/main/schema.json",
  "name": "__NAME__",
  "version": "0.1.0",
  "root": "./src",
  "outputDir": "./dist",
  "base": "/",
  "entries": {
    "app": "./src/main.hyx"
  },
  "server": {
    "port": 5173,
    "host": "0.0.0.0"
  },
  "compiler": {
    "target": "react-19",
    "strict": true
  },
  "rendering": {
    "ssg": true
  },
  "styling": {
    "tailwind": true
  }
}
"#;

/// Runtime dependencies are React and nothing else: the compiler and its
/// bundler are a devDependency, so a production install carries no toolchain.
/// The bundler deps are pinned to the versions the runner's APIs expect —
/// tailwind 3, because `postcss([tailwindcss(cfg)])` is the v3 plugin shape.
///
/// `pub(crate)` so the tools tests can assert this stays parseable and that a
/// round-trip through their JSON writer leaves it byte-identical.
pub(crate) const PACKAGE_JSON_TEMPLATE: &str = r#"{
  "name": "__NAME__",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "hydra dev",
    "build": "hydra build",
    "preview": "hydra preview",
    "check": "hydra check",
    "clean": "hydra clean"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "autoprefixer": "^10.4.20",
    "esbuild": "^0.25.0",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.16"
  }
}
"#;

/// The framework owns the Tailwind config for every project it builds: the
/// runner merges `content` from the project layout and reads theme and plugins
/// from `hydraconfig.json`'s `tailwind` key, so this file is for editors and
/// for anyone running the Tailwind CLI by hand.
const TAILWIND_CONFIG_TEMPLATE: &str = r#"// [xihanzu-NR]
/**
 * Tailwind is configured from hydraconfig.json's "tailwind" key at build time.
 * This file mirrors that config so editor tooling and a bare `npx tailwindcss`
 * produce the same classes; keep the two in step when you change the theme.
 */
export default {
  content: ['./index.html', './src/**/*.{hyx,hys,hsx,hs,tsx,ts,jsx,js,mjs,html}'],
  theme: { extend: {} },
  plugins: [],
};
"#;

const INDEX_HTML_TEMPLATE: &str = r#"<!-- [xihanzu-NR] -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="__NAME__ — a HydraScript app" />
    <title>__NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.hyx"></script>
  </body>
</html>
"#;

const MAIN_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from hydra import mount
from "./App.hyx" import App
import "./index.css"

root_element = document.getElementById("root")
mount(App, root_element)
"#;

const APP_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from hydra import state, use_path, navigate
from "./components/Header.hyx" import Header
from "./components/Card.hyx" import Card
from "./components/Button.hyx" import Button
from "./pages/Home.hyx" import Home
from "./pages/About.hyx" import About
from "./lib/stats.hys" import greeting

component App():
    path = use_path()
    clicks, set_clicks = state(0)
    samples, set_samples = state([2, 4, 6])

    div(className="min-h-screen bg-slate-50 text-slate-900"):
        Header(
            title="HydraScript",
            links=[{"path": "/", "label": "Home"}, {"path": "/about", "label": "About"}],
            current=path,
            on_nav=navigate,
        )
        main(className="mx-auto max-w-3xl space-y-6 p-6"):
            if path == "/about":
                About(version="0.1.0")
            else:
                Home(greeting=greeting("HydraScript"), samples=samples)
            Card(title="State + interop", subtitle="App owns the state; stats.hys does the maths"):
                div(className="flex items-center gap-3"):
                    Button(label="Add a sample", on_press=lambda: set_samples(samples + [clicks + 2]))
                    Button(label="Reset", variant="ghost", on_press=lambda: set_samples([2, 4, 6]))
                    span(className="text-sm text-slate-500"): f"clicks: {clicks}"
        footer(className="p-6 text-center text-xs text-slate-400"): greeting("HydraScript")
"#;

/// CSS needs the `/* */` watermark form. The `#` form used for the Pythonic
/// sources is not a CSS comment, and PostCSS rejects the file outright with
/// "Unknown word #" — which is how this was caught.
const INDEX_CSS_TEMPLATE: &str = r#"/* [xihanzu-NR] */
@tailwind base;
@tailwind components;
@tailwind utilities;
"#;

/// The nav row is its own component on purpose: an `if / else` that is the
/// *only* statement inside a `for` body emits an object literal where JS needs
/// an expression, so the branch moves into a component that returns early.
const HEADER_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
component NavLink(link = {}, current: str = "/", on_nav = None):
    if link["path"] == current:
        span(className="rounded-lg bg-indigo-50 px-3 py-1.5 text-sm font-semibold text-indigo-700"): link["label"]
    else:
        button(
            on_click=lambda: on_nav(link["path"]),
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900",
        ): link["label"]

component Header(title: str = "HydraScript", links = [], current: str = "/", on_nav = None):
    header(className="border-b border-slate-200 bg-white"):
        div(className="mx-auto flex max-w-3xl items-center justify-between gap-4 p-4"):
            span(className="text-lg font-black tracking-tight text-indigo-600"): title
            nav(className="flex items-center gap-1"):
                for link in links:
                    NavLink(key=link["path"], link=link, current=current, on_nav=on_nav)
"#;

const CARD_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
component Card(title: str = "Card", subtitle: str = ""):
    section(className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100"):
        h2(className="text-xl font-bold text-slate-900"): title
        if subtitle:
            p(className="mt-1 text-sm text-slate-500"): subtitle
        div(className="mt-4"):
            slot
"#;

/// The variant lookup is an if/elif chain on purpose: a Python-style
/// `styles.get(variant, fallback)` compiles to a literal `.get(...)` call, and
/// a JS object literal has no such method.
const BUTTON_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
component Button(label: str = "Button", variant: str = "primary", on_press = None):
    styles = "bg-indigo-600 text-white hover:bg-indigo-700"
    if variant == "ghost":
        styles = "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
    elif variant == "danger":
        styles = "bg-rose-600 text-white hover:bg-rose-700"

    button(
        on_click=on_press,
        className=f"rounded-lg px-4 py-2 text-sm font-semibold transition {styles}",
    ): label
"#;

const HOME_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from "../components/Card.hyx" import Card
from "../lib/stats.hys" import summarise

component Home(greeting: str = "Hello", samples = []):
    stats = summarise(samples)

    div(className="space-y-6"):
        Card(title=greeting, subtitle="Rendered from src/pages/Home.hyx"):
            div(className="grid grid-cols-3 gap-3 text-center"):
                div(className="rounded-xl bg-slate-50 p-3"):
                    p(className="text-xs uppercase tracking-wide text-slate-400"): "count"
                    p(className="text-xl font-bold text-slate-900"): stats["count"]
                div(className="rounded-xl bg-slate-50 p-3"):
                    p(className="text-xs uppercase tracking-wide text-slate-400"): "total"
                    p(className="text-xl font-bold text-slate-900"): stats["total"]
                div(className="rounded-xl bg-slate-50 p-3"):
                    p(className="text-xs uppercase tracking-wide text-slate-400"): "mean"
                    p(className="text-xl font-bold text-slate-900"): stats["mean"]
        Card(title="Samples", subtitle="One <li> per entry, from a for loop"):
            ul(className="space-y-1 text-sm text-slate-600"):
                # `key=` on the element returned by a `for` loop. Without it React
                # warns on the very first build, and a scaffold should not open
                # with a warning.
                for value in samples:
                    li(key=value): f"sample {value} squared is {value * value}"
"#;

const ABOUT_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from "../components/Card.hyx" import Card

component About(version: str = "0.1.0"):
    features = ["Pythonic syntax", "Two targets: .hyx and .hys", "SSG on by default"]

    div(className="space-y-6"):
        Card(title="About", subtitle=f"version {version}"):
            ul(className="list-disc space-y-1 pl-5 text-sm text-slate-600"):
                for index, feature in enumerate(features):
                    li(key=index): feature
"#;

/// Plain ESM with no React: App.hyx imports summarise() and greeting() from
/// here, which is what proves the two targets interoperate.
///
/// Every name another module needs carries `export`. A bare `def` emits a
/// plain `function`, and esbuild then reports the import as "always undefined".
const STATS_HYS_TEMPLATE: &str = r#"# [xihanzu-NR]
export def total(values):
    acc = 0
    for value in values:
        acc = acc + value
    return acc

export def mean(values):
    n = len(values)
    if n == 0:
        return 0
    return total(values) / n

export def summarise(values):
    return {"count": len(values), "total": total(values), "mean": mean(values)}

export def greeting(name):
    return f"Hello, {name}!"
"#;

const README_TEMPLATE: &str = r#"# __NAME__

A HydraScript app — Pythonic syntax that compiles to React. Built with
`hydra`; the generated output is plain React TSX and plain ESM.

## Getting started

```bash
npm install
npx hydra dev
```

The dev server prints a local URL (default <http://localhost:5173>).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server: builds once, serves `dist/`, rebuilds on change |
| `npm run build` | Production build into `dist/`, pre-rendered to HTML |
| `npm run preview` | Serve the production build |
| `npm run check` | Type-check-free parse check of every `.hyx` / `.hys` |
| `npm run clean` | Delete `dist/` (`-- --all` also clears `node_modules`) |
| `npx hydra add <pkg> --dev` | Install a dependency and record it in `package.json` |
| `npx hydra list` | Show declared vs installed dependencies |
| `npx hydra analyze` | Bundle size report from the last build |
| `npx hydra fmt` | Format sources |
| `npx hydra doctor` | Check the local toolchain |

## Layout

```
hydraconfig.json        project config: name, root, outputDir, server, rendering
index.html              SPA mount point (#root); the build inlines the pre-render
tailwind.config.js      mirrors the "tailwind" key in hydraconfig.json
src/main.hyx            entry — mounts App into #root
src/App.hyx             owns the state, picks the page, wires the components
src/components/         Header.hyx, Card.hyx, Button.hyx
src/lib/stats.hys       pure helpers, imported by App.hyx and the pages
src/pages/Home.hyx      default screen
src/pages/About.hyx     second screen, reached through the router
src/index.css           the three Tailwind directives
dist/                   build output (git-ignored), pre-rendered to HTML
```

Two file types, one language:

- **`.hyx`** — React components. `component Name(props):` returns a tree.
- **`.hys`** — plain ESM modules. `def name(args):` returns a value.

`src/App.hyx` importing from `src/lib/stats.hys` is the point: a component and
a plain module calling each other with no glue in between.

## Writing code

```python
# src/components/Button.hyx
component Button(label: str = "Button", on_press = None):
    button(on_click=on_press, className="rounded-lg px-4 py-2"): label
```

```python
# src/lib/stats.hys
def summarise(values):
    return {"count": len(values), "total": sum(values)}
```

Control flow reads like Python — `if / elif / else`, `for x in xs`, `lambda`,
f-strings — and conditional children become lazy JSX, so `if subtitle:` only
renders when there is a subtitle.

Notes worth knowing before you hit them:

- Variant lookups use `if / elif`, not `styles.get(...)`. A Python dict literal
  compiles to a JS object literal, which has no `.get` method.
- A component call cannot be the only statement in a component body — it would
  be emitted as a discarded expression. Wrap it in an element (`div:`), or give
  it siblings.
- An `if / else` cannot be the only statement inside a `for` body. Move the
  branch into a small component that returns early; `Header.hyx` does this with
  `NavLink`.
- A bare string as the first line of a component body is emitted as an
  expression statement, so keep prose in comments (`# ...`), not in docstrings.
- Anything in a `.hys` file that another module imports needs `export def`, not
  a bare `def`.

## Configuring

`hydraconfig.json` is read by the runner:

| Key | Meaning |
|---|---|
| `outputDir` | Where the build lands (default `dist`) |
| `server.port` / `server.host` | What `dev` and `preview` bind to |
| `base` | Public base path |
| `rendering.ssg` | Pre-render `App.hyx` into `dist/index.html` (default `true`) |
| `tailwind` | Merged into the Tailwind config: `theme`, `plugins`, extra `content` |

## Checking your work

```bash
npx hydra check          # parse every source, no output written
npx hydra check src/App.hyx
npx hydra build && npx hydra analyze
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

    for dir in ["src", "src/components", "src/lib", "src/pages"] {
        if let Err(e) = fs::create_dir_all(root.join(dir)) {
            eprintln!("hydra: cannot create {}: {}", root.join(dir).display(), e);
            return ExitCode::from(1);
        }
    }

    // Every entry starts with the watermark for its own language: `#` for the
    // Pythonic sources, `<!-- -->` for HTML, `//` for JS.
    let files: Vec<(PathBuf, String)> = vec![
        (
            root.join("hydraconfig.json"),
            render(HYDRACONFIG_TEMPLATE, &name),
        ),
        (
            root.join("package.json"),
            render(PACKAGE_JSON_TEMPLATE, &name),
        ),
        (root.join("tailwind.config.js"), TAILWIND_CONFIG_TEMPLATE.to_string()),
        (root.join("index.html"), render(INDEX_HTML_TEMPLATE, &name)),
        (root.join("README.md"), render(README_TEMPLATE, &name)),
        (
            root.join("src").join("main.hyx"),
            MAIN_HYX_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("App.hyx"),
            APP_HYX_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("index.css"),
            INDEX_CSS_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("components").join("Header.hyx"),
            HEADER_HYX_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("components").join("Card.hyx"),
            CARD_HYX_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("components").join("Button.hyx"),
            BUTTON_HYX_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("lib").join("stats.hys"),
            STATS_HYS_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("pages").join("Home.hyx"),
            HOME_HYX_TEMPLATE.to_string(),
        ),
        (
            root.join("src").join("pages").join("About.hyx"),
            ABOUT_HYX_TEMPLATE.to_string(),
        ),
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

    // The artifacts are the part that goes stale silently. `hydra.node` is what
    // the bundler calls in-process, so a build that copies the CLI binary but
    // not the addon keeps running the OLD compiler while every source test
    // passes. Printing size+mtime+hash means a stale copy is visible instead of
    // being rediscovered as "the fix did not work".
    println!();
    artifact_report(&mut failed);

    println!();
    if failed > 0 {
        println!("{} check(s) failed", failed);
        ExitCode::from(1)
    } else {
        println!("all checks passed");
        ExitCode::SUCCESS
    }
}

/// FNV-1a over the file bytes. This is a fingerprint for comparing one artifact
/// against another on the same machine, not a security hash, and it keeps the
/// compiler at zero dependencies.
fn fingerprint(path: &Path) -> Option<(u64, u64, u64)> {
    let bytes = fs::read(path).ok()?;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in &bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let mtime = fs::metadata(path)
        .ok()?
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())?;
    Some((hash, mtime, bytes.len() as u64))
}

/// Resolve a path relative to the running binary. The addon and the runner ship
/// beside it, so this works for a symlinked `/usr/local/bin/hydra` too.
fn beside_binary(rel: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(rel);
    candidate.is_file().then_some(candidate)
}

fn artifact_report(failed: &mut usize) {
    let artifacts = [
        ("bin/hydra", "hydra"),
        ("bin/hydra.node", "hydra.node"),
        ("packages/cli/runner.mjs", "runner.mjs"),
    ];

    let mut stamp: Option<(u64, &'static str)> = None;

    for (rel, label) in artifacts {
        let Some(path) = beside_binary(rel).or_else(|| {
            // A checkout keeps the runner two levels up from `target/release`.
            let exe = std::env::current_exe().ok()?;
            let mut dir = exe.parent()?.to_path_buf();
            for _ in 0..4 {
                dir = dir.parent()?.to_path_buf();
                let c = dir.join(rel);
                if c.is_file() {
                    return Some(c);
                }
            }
            None
        }) else {
            println!("fail  {} missing (expected beside the binary)", label);
            *failed += 1;
            continue;
        };

        match fingerprint(&path) {
            Some((hash, mtime, len)) => {
                println!(
                    "ok    {} {:>8} bytes  hash {:016x}  mtime {}  ({})",
                    label,
                    len,
                    hash,
                    mtime,
                    path.display()
                );
                // The addon is loaded in-process by the bundler; an older one is
                // the classic stale-artifact bug, so say it out loud.
                if rel == "bin/hydra.node" {
                    stamp = Some((mtime, label));
                } else if let Some((node_mtime, _)) = stamp {
                    if mtime > node_mtime {
                        println!(
                            "warn  {} was built after hydra.node - rebuild the addon \
                             (cargo build --release && cp target/release/libhydra.so bin/hydra.node)",
                            label
                        );
                    }
                    stamp = None;
                }
            }
            None => {
                println!("fail  {} unreadable at {}", label, path.display());
                *failed += 1;
            }
        }
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
            "tailwind.config.js",
            "index.html",
            "README.md",
            "src/main.hyx",
            "src/App.hyx",
            "src/index.css",
            "src/components/Header.hyx",
            "src/components/Card.hyx",
            "src/components/Button.hyx",
            "src/lib/stats.hys",
            "src/pages/Home.hyx",
            "src/pages/About.hyx",
        ] {
            assert!(target.join(rel).is_file(), "expected {} to exist", rel);
        }

        let config = fs::read_to_string(target.join("hydraconfig.json")).unwrap();
        assert!(config.contains("\"name\": \"demo-app\""));
        assert!(config.contains("\"port\": 5173"));
        assert!(config.contains("\"host\": \"0.0.0.0\""));
        assert!(config.contains("\"outputDir\": \"./dist\""));
        assert!(config.contains("\"base\": \"/\""));
        assert!(config.contains("\"ssg\": true"));
        assert!(config.contains("\"app\": \"./src/main.hyx\""));

        let pkg = fs::read_to_string(target.join("package.json")).unwrap();
        // `hydrascript` is NOT an npm dependency: the CLI is the toolchain that
        // generated this project. Declaring it made `npm install` fail with a
        // 404 for every fresh project.
        assert!(!pkg.contains("\"hydrascript\""));
        assert!(pkg.contains("hydra dev"));
        for script in ["\"dev\"", "\"build\"", "\"preview\""] {
            assert!(pkg.contains(script), "package.json missing {}", script);
        }

        // React is the only runtime dependency; the toolchain is a devDependency.
        let parsed = crate::tools::Json::parse(&pkg).expect("scaffolded package.json must parse");
        let deps = parsed
            .get("dependencies")
            .and_then(|d| d.as_obj())
            .expect("dependencies");
        assert_eq!(
            deps.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            vec!["react", "react-dom"],
            "the toolchain must not be a runtime dependency"
        );
        assert!(deps
            .iter()
            .all(|(_, v)| v.as_str().is_some_and(|s| s.starts_with("^19"))));

        let dev = parsed
            .get("devDependencies")
            .and_then(|d| d.as_obj())
            .expect("devDependencies");
        for expected in [
            "esbuild",
            "postcss",
            "tailwindcss",
            "autoprefixer",
            "@types/react",
            "@types/react-dom",
        ] {
            assert!(
                dev.iter().any(|(k, _)| k == expected),
                "devDependencies missing {}",
                expected
            );
        }
    }

    /// Every generated source must carry the watermark for its own language.
    #[test]
    fn init_writes_a_watermark_into_every_file() {
        let tree = TempTree::new("init-watermark");
        let target = tree.root.join("marked");
        let target_str = target.to_string_lossy().to_string();
        assert_eq!(init(&[target_str]), ExitCode::SUCCESS);

        for (rel, marker) in [
            ("src/main.hyx", "# [xihanzu-NR]"),
            ("src/App.hyx", "# [xihanzu-NR]"),
            ("src/index.css", "/* [xihanzu-NR] */"),
            ("src/lib/stats.hys", "# [xihanzu-NR]"),
            ("src/components/Button.hyx", "# [xihanzu-NR]"),
            ("src/pages/Home.hyx", "# [xihanzu-NR]"),
            ("tailwind.config.js", "// [xihanzu-NR]"),
            ("index.html", "<!-- [xihanzu-NR] -->"),
        ] {
            let text = fs::read_to_string(target.join(rel)).unwrap();
            assert!(
                text.starts_with(marker),
                "{} must start with {}",
                rel,
                marker
            );
        }
    }

    /// The scaffold ships as the reference for what the compiler accepts today,
    /// so every generated source has to compile.
    #[test]
    fn every_scaffolded_source_compiles() {
        let tree = TempTree::new("init-compiles");
        let target = tree.root.join("compiles");
        let target_str = target.to_string_lossy().to_string();
        assert_eq!(init(&[target_str]), ExitCode::SUCCESS);

        let mut checked = 0usize;
        for path in collect_files(&target) {
            let is_source = matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("hyx") | Some("hys")
            );
            if !is_source {
                continue;
            }
            let src = fs::read_to_string(&path).unwrap();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if let Err(e) = crate::compile(&src, &name) {
                panic!("{} does not compile:\n{}", path.display(), e.pretty());
            }
            checked += 1;
        }
        assert_eq!(checked, 8, "expected 6 .hyx + 2 .hys sources");
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
