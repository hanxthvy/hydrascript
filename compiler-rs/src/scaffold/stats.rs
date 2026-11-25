//! `hydra stats`: counting a project without building it.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use super::*;
use super::util::*;

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SourceCounts {
    pub(super) hyx: usize,
    pub(super) hys: usize,
}

impl SourceCounts {
    pub(super) fn total(&self) -> usize {
        self.hyx + self.hys
    }
}

/// Count `.hyx` and `.hys` files anywhere under `dir`.
pub(super) fn count_sources(dir: &Path) -> SourceCounts {
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
pub(super) struct SourceMetrics {
    pub(super) lines: usize,
    pub(super) non_blank: usize,
    pub(super) components: usize,
    pub(super) functions: usize,
    pub(super) imports: usize,
}

/// `true` for `component Foo(...)`, `export component Foo(...)`, `async component ...`.
pub(super) fn is_component_def(trimmed: &str) -> bool {
    trimmed == "component"
        || trimmed.starts_with("component ")
        || trimmed.starts_with("export component ")
        || trimmed.starts_with("async component ")
}

/// `true` for `def foo(...)`, `export def ...`, `async def ...`.
pub(super) fn is_function_def(trimmed: &str) -> bool {
    trimmed == "def"
        || trimmed.starts_with("def ")
        || trimmed.starts_with("export def ")
        || trimmed.starts_with("async def ")
}

/// `true` for both import forms the language has: `import "x"` and
/// `from "x" import y`.
pub(super) fn is_import(trimmed: &str) -> bool {
    trimmed.starts_with("import ") || trimmed.starts_with("from ")
}

/// Count the things `hydra stats` reports for a single source file.
pub(super) fn metrics_of(src: &str) -> SourceMetrics {
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
pub(super) struct RepoStats {
    pub(super) counts: SourceCounts,
    pub(super) metrics: SourceMetrics,
    /// `(path, line_count)` for every scanned source file.
    pub(super) files: Vec<(PathBuf, usize)>,
}

pub(super) fn scan(dir: &Path) -> RepoStats {
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

pub(super) const HYDRACONFIG_TEMPLATE: &str = r#"{
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
    "host": "127.0.0.1"
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
mod route_tests {
    use super::collect_routes;
    use std::fs;
    use std::path::Path;

    pub(super) fn tree(files: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hydra-routes-{}-{}",
            std::process::id(),
            files.len()
        ));
        let _ = fs::remove_dir_all(&dir);
        for f in files {
            let p = dir.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "component X():\n    p: \"x\"\n").unwrap();
        }
        dir.join("pages")
    }

    pub(super) fn patterns(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        collect_routes(dir, dir, &mut out);
        out.into_iter().map(|(p, _)| p).collect()
    }

    #[test]
    pub(super) fn the_url_rules_match_the_router() {
        let pages = tree(&[
            "pages/index.hyx",
            "pages/about.hyx",
            "pages/blog/index.hyx",
            "pages/blog/[slug].hyx",
            "pages/docs/[...rest].hyx",
            "pages/(marketing)/price.hyx",
            "pages/_partials/Hero.hyx",
            "pages/_404.hyx",
        ]);
        let mut got = patterns(&pages);
        got.sort();
        assert_eq!(
            got,
            vec![
                "/",
                "/about",
                "/blog",
                "/blog/[slug]",
                "/docs/[...rest]",
                "/price",
            ],
            "index, params, catch-all, groups and _private must resolve like the router"
        );
    }

    #[test]
    pub(super) fn a_param_beside_a_different_param_named_collision_is_visible() {
        // Both files match `/blog/<one segment>`. The shapes are the same, which is
        // what `route_report` keys on; this asserts the collection is right, since
        // the printing half is not worth testing through stdout.
        let pages = tree(&["pages/blog/[slug].hyx", "pages/blog/[id].hyx"]);
        let got = patterns(&pages);
        assert_eq!(got.len(), 2, "both files must be seen, not deduped");
        let shapes: Vec<String> = got
            .iter()
            .map(|p| {
                p.split('/')
                    .map(|s| if s.starts_with('[') { "[*]" } else { s })
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .collect();
        assert_eq!(shapes[0], shapes[1], "they resolve to one URL shape");
    }
}

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
    pub(super) fn walk_counts_files_across_nested_dirs() {
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
    pub(super) fn missing_directory_counts_zero_and_does_not_panic() {
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
    pub(super) fn empty_directory_counts_zero() {
        let tree = TempTree::new("empty");
        let counts = count_sources(&tree.root);
        assert_eq!(counts.total(), 0);
        assert!(collect_files(&tree.root).is_empty());
    }

    #[test]
    pub(super) fn metrics_count_components_defs_and_imports() {
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
    pub(super) fn metrics_ignore_blank_and_commented_definitions() {
        let src = "\n\n   \n# component Nope():\ncomponent Real():\n    div: \"x\"\n\n";
        let m = metrics_of(src);
        assert_eq!(m.components, 1);
        assert_eq!(m.functions, 0);
        assert_eq!(m.imports, 0);
        assert_eq!(m.lines, 7);
        assert_eq!(m.non_blank, 3);
    }

    #[test]
    pub(super) fn scan_aggregates_and_ranks_files_by_size() {
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
    pub(super) fn init_scaffolds_a_project_under_a_temp_dir() {
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
            "src/pages/index.hyx",
            "src/pages/about.hyx",
            "src/pages/_404.hyx",
        ] {
            assert!(target.join(rel).is_file(), "expected {} to exist", rel);
        }

        let config = fs::read_to_string(target.join("hydraconfig.json")).unwrap();
        assert!(config.contains("\"name\": \"demo-app\""));
        assert!(config.contains("\"port\": 5173"));
        // Loopback, and this one matters. The scaffold used to write 0.0.0.0,
        // which put every freshly generated project's dev server on all
        // interfaces (and, on a machine with a public IP, on the internet). The
        // runner defaults to 127.0.0.1; the scaffold must not undo that by
        // writing a config that overrides the default. Verified before changing:
        // this assertion failed on the old value, which is why it is pinned here.
        assert!(config.contains("\"host\": \"127.0.0.1\""));
        assert!(!config.contains("0.0.0.0"), "the dev server must not bind all interfaces by default");
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
    pub(super) fn init_writes_a_watermark_into_every_file() {
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
            ("src/pages/index.hyx", "# [xihanzu-NR]"),
            ("src/pages/_404.hyx", "# [xihanzu-NR]"),
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
    pub(super) fn every_scaffolded_source_compiles() {
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
        // The count is asserted so a template that stops being written is a test
        // failure and not a silently smaller scaffold: 8 .hyx/.hsx plus 3 .hys
        // (main's stats, and the about page's server half).
        assert_eq!(checked, 10, "expected 8 .hyx/.hsx + 3 .hys sources");
    }

    #[test]
    pub(super) fn init_refuses_to_overwrite_without_force() {
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
    pub(super) fn subcommand_help_exits_zero() {
        let help = vec!["--help".to_string()];
        assert_eq!(init(&help), ExitCode::SUCCESS);
        assert_eq!(doctor(&help), ExitCode::SUCCESS);
        assert_eq!(stats(&help), ExitCode::SUCCESS);
    }

    /// A blank project must not ship Tailwind's config, its dependencies, or a
    /// `tailwind` key — and its CSS must define the class names App.hyx uses.
    #[test]
    pub(super) fn init_blank_plain_ships_no_tailwind_anywhere() {
        let tree = TempTree::new("init-blank-plain");
        let target = tree.root.join("plainapp");
        let target_str = target.to_string_lossy().to_string();

        assert_eq!(
            init(&[
                target_str,
                "--template=blank".to_string(),
                "--styling=plain".to_string(),
            ]),
            ExitCode::SUCCESS
        );

        assert!(
            !target.join("tailwind.config.js").exists(),
            "a plain-CSS project must not get a Tailwind config"
        );
        assert!(
            !target.join("src/pages").exists(),
            "a blank project must not get a pages folder"
        );

        let config = fs::read_to_string(target.join("hydraconfig.json")).unwrap();
        assert!(!config.contains("tailwind"), "config still mentions tailwind: {}", config);
        assert!(config.contains("\"ssg\": true"));

        let pkg = fs::read_to_string(target.join("package.json")).unwrap();
        for banned in ["tailwindcss", "postcss", "autoprefixer"] {
            assert!(
                !pkg.contains(banned),
                "plain-CSS project must not depend on {}",
                banned
            );
        }

        // Class names in the page must exist in the stylesheet, or the project
        // looks broken on first run.
        let app = fs::read_to_string(target.join("src/App.hyx")).unwrap();
        let css = fs::read_to_string(target.join("src/index.css")).unwrap();
        for class in ["page", "title", "subtitle"] {
            assert!(app.contains(&format!("className=\"{}\"", class)), "App.hyx missing {}", class);
            assert!(css.contains(&format!(".{}", class)), "index.css missing .{}", class);
        }
    }

    /// PostCSS without Tailwind keeps the plugin array and drops Tailwind only.
    #[test]
    pub(super) fn init_postcss_keeps_postcss_and_drops_tailwind() {
        let tree = TempTree::new("init-postcss");
        let target = tree.root.join("pcss");
        let target_str = target.to_string_lossy().to_string();

        assert_eq!(
            init(&[target_str, "--styling=postcss".to_string()]),
            ExitCode::SUCCESS
        );

        let config = fs::read_to_string(target.join("hydraconfig.json")).unwrap();
        assert!(config.contains("\"styling\": [\"autoprefixer\"]"), "got {}", config);
        assert!(!config.contains("tailwind"));

        let pkg = fs::read_to_string(target.join("package.json")).unwrap();
        assert!(pkg.contains("postcss"));
        assert!(pkg.contains("autoprefixer"));
        assert!(!pkg.contains("tailwindcss"));
        assert!(!target.join("tailwind.config.js").exists());

        let css = fs::read_to_string(target.join("src/index.css")).unwrap();
        assert!(!css.contains("@tailwind"), "plain PostCSS must not use Tailwind directives");
    }

    /// `--ssg=false --types=false` must actually reach the config.
    #[test]
    pub(super) fn init_flags_reach_the_rendering_block() {
        let tree = TempTree::new("init-flags");
        let target = tree.root.join("flags");
        let target_str = target.to_string_lossy().to_string();

        assert_eq!(
            init(&[
                target_str,
                "--ssg=false".to_string(),
                "--types=false".to_string(),
            ]),
            ExitCode::SUCCESS
        );

        let config = fs::read_to_string(target.join("hydraconfig.json")).unwrap();
        assert!(!config.contains("\"ssg\": true"), "ssg should be off: {}", config);
        assert!(!config.contains("\"types\""), "types should be off: {}", config);
        // The result must still be valid JSON, or the runner cannot read it.
        assert!(
            crate::tools::Json::parse(&config).is_ok(),
            "generated hydraconfig.json is not valid JSON: {}",
            config
        );
    }

    /// An unknown value is an error, not a silently ignored typo: scaffolding
    /// Tailwind after someone asked for `--styling=twind` is the failure mode.
    #[test]
    pub(super) fn init_rejects_unknown_flag_values_and_writes_nothing() {
        let tree = TempTree::new("init-bad-flag");
        let target = tree.root.join("typo");
        let target_str = target.to_string_lossy().to_string();

        assert_eq!(
            init(&[target_str.clone(), "--styling=twind".to_string()]),
            ExitCode::from(2)
        );
        assert!(!target.exists(), "nothing should be written on a rejected flag");

        assert_eq!(
            init(&[target_str.clone(), "--nonsense=1".to_string()]),
            ExitCode::from(2)
        );
        assert_eq!(
            init(&[target_str, "--ssg".to_string()]),
            ExitCode::from(2)
        );
    }
}

#[cfg(test)]
mod html_tests {
    use super::{render_html, INDEX_HTML_TEMPLATE};

    #[test]
    pub(super) fn a_name_never_becomes_markup() {
        // `json_escape` is correct inside JSON and wrong inside HTML: it leaves
        // `<` alone. A directory named `<script>alert(1)</script>` produced a
        // scaffolded index.html that ran that script on open.
        let out = render_html(INDEX_HTML_TEMPLATE, "<script>alert(1)</script>");
        assert!(!out.contains("<script>alert(1)</script>"), "raw markup in {out}");
        assert!(out.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        // Quote in the attribute position too.
        let quoted = render_html(INDEX_HTML_TEMPLATE, "a\" onload=\"x");
        assert!(!quoted.contains("onload=\"x"));
    }
}
