// [xihanzu-NR]
//! Everyday project commands: add, remove, list, clean, analyze.
//!
//! The binary already covered "start the toolchain" (dev, build, preview) and
//! "inspect the language" (check, fmt, stats, doctor). These five are what a
//! developer reaches for in between: manage dependencies, throw away build
//! output, and see where the bytes went.
//!
//! Like the rest of the binary this module has no dependencies, so the two JSON
//! documents it reads — `package.json` and the esbuild metafile written by the
//! build — go through the small reader/serializer at the bottom of the file.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const ADD_USAGE: &str = "\
hydra add — install one or more dependencies

USAGE:
  hydra add <pkg> [pkg...] [--dev]

ARGS:
  pkg        package name(s), including any version range npm accepts

OPTIONS:
  -D, --dev  install into devDependencies
  -h, --help show this message

NOTES:
  The package manager is detected from the lockfile in the project root:
  bun.lockb / bun.lock -> bun, pnpm-lock.yaml -> pnpm, yarn.lock -> yarn,
  otherwise npm. A missing package.json is created, so a project scaffolded
  without a manifest can still take dependencies.
";

const REMOVE_USAGE: &str = "\
hydra remove — uninstall one or more dependencies

USAGE:
  hydra remove <pkg> [pkg...]

ARGS:
  pkg        package name(s)

OPTIONS:
  -h, --help show this message

NOTES:
  Uses the same detected package manager as `hydra add`, then drops the entries
  from both dependencies and devDependencies.
";

const LIST_USAGE: &str = "\
hydra list — show the project's direct dependencies

USAGE:
  hydra list

REPORTS:
  dependencies and devDependencies with the version installed under
  node_modules, any declared package that is not installed, and any package
  installed at the top level that nothing declares (nor pulls in transitively)
";

const CLEAN_USAGE: &str = "\
hydra clean — remove build output

USAGE:
  hydra clean [--all]

OPTIONS:
  --all      also remove node_modules and the common caches
             (.hydra, .esbuild, .vite, node_modules/.cache)
  -h, --help show this message
";

const ANALYZE_USAGE: &str = "\
hydra analyze — bundle size report from the last build

USAGE:
  hydra analyze [dir]

ARGS:
  dir        project directory (default: the nearest one with hydraconfig.json,
             else the current directory)

READS:
  <outputDir>/.hydra-build.json — the esbuild metafile written by `hydra build`

REPORTS:
  output bundles largest first, the biggest contributing input modules per
  bundle, totals, and any package name that appears in more than one input
  path (a sign of a duplicated dependency)
";

fn has_help(args: &[String]) -> bool {
    args.iter().any(|a| a == "--help" || a == "-h")
}

/// Every positional (non-flag) argument.
fn positionals(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect()
}

/// Walk up from `start` looking for `filename`.
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

/// The project directory: the nearest ancestor holding `hydraconfig.json`,
/// falling back to the current directory for projects not scaffolded by us.
fn project_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    find_up(&cwd, "hydraconfig.json")
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or(cwd)
}

/// The `outputDir` from `dir/hydraconfig.json`, defaulting to `dist`.
///
/// The config convention writes paths as `"./dist"`, which `Path::join` would
/// look for literally, so a leading `./` is dropped. Returned unresolved so
/// callers can report a short path relative to the project root.
fn output_dir_name(dir: &Path) -> String {
    if let Ok(text) = fs::read_to_string(dir.join("hydraconfig.json")) {
        if let Ok(config) = Json::parse(&text) {
            if let Some(name) = config.get("outputDir").and_then(|v| v.as_str()) {
                let name = name.strip_prefix("./").unwrap_or(name);
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    "dist".to_string()
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Manager {
    Bun,
    Pnpm,
    Yarn,
    Npm,
}

impl Manager {
    fn binary(self) -> &'static str {
        match self {
            Manager::Bun => "bun",
            Manager::Pnpm => "pnpm",
            Manager::Yarn => "yarn",
            Manager::Npm => "npm",
        }
    }

    /// Command that installs *and saves*, so the manager picks the version range
    /// rather than us guessing one from the registry.
    fn add_args(self, packages: &[String], dev: bool) -> Vec<String> {
        let mut args = vec![match self {
            // `npm add` is an alias for `install`, but the long form is what
            // every npm release documents.
            Manager::Npm => "install".to_string(),
            _ => "add".to_string(),
        }];
        args.extend(packages.iter().cloned());
        if dev {
            match self {
                Manager::Yarn | Manager::Bun => args.push("--dev".to_string()),
                Manager::Npm | Manager::Pnpm => args.push("--save-dev".to_string()),
            }
        }
        args
    }

    fn remove_args(self, packages: &[String]) -> Vec<String> {
        let mut args = vec![match self {
            Manager::Npm => "uninstall".to_string(),
            _ => "remove".to_string(),
        }];
        args.extend(packages.iter().cloned());
        args
    }
}

/// Order matters: a project can carry a stale lockfile from a previous manager,
/// so the lockfile we trust first is bun's (the fastest-moving of the four).
fn detect_manager(root: &Path) -> Manager {
    if root.join("bun.lockb").is_file() || root.join("bun.lock").is_file() {
        Manager::Bun
    } else if root.join("pnpm-lock.yaml").is_file() {
        Manager::Pnpm
    } else if root.join("yarn.lock").is_file() {
        Manager::Yarn
    } else {
        Manager::Npm
    }
}

/// Run a package manager in the project root, inheriting stdio so the user sees
/// the real progress output.
fn run_manager(root: &Path, bin: &str, args: &[String]) -> Result<(), String> {
    match Command::new(bin).args(args).current_dir(root).status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(match status.code() {
            Some(code) => format!("{} exited with status {}", bin, code),
            None => format!("{} was terminated by a signal", bin),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("{} was not found on PATH", bin))
        }
        Err(e) => Err(format!("cannot run {}: {}", bin, e)),
    }
}

// ---------------------------------------------------------------------------
// Manifest handling
// ---------------------------------------------------------------------------

const DEP_SECTIONS: [&str; 2] = ["dependencies", "devDependencies"];

fn load_manifest(path: &Path) -> Result<Json, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    Json::parse(&text).map_err(|e| format!("{} is not valid JSON: {}", path.display(), e))
}

/// A minimal manifest for a project that has none yet, so `hydra add` works
/// before the first `npm install`.
fn new_manifest(name: &str) -> Json {
    let mut manifest = Json::obj();
    manifest.set("name", Json::Str(name.to_string()));
    manifest.set("private", Json::Bool(true));
    manifest.set("version", Json::Str("0.1.0".to_string()));
    manifest.set("type", Json::Str("module".to_string()));
    manifest
}

/// Write the manifest back: two-space indent, dependency sections sorted, one
/// trailing newline. Everything else keeps the order it came in with, so an
/// unrelated key does not move.
fn save_manifest(path: &Path, manifest: &mut Json) -> Result<(), String> {
    for section in DEP_SECTIONS {
        if let Some(Json::Obj(entries)) = manifest.get_mut(section) {
            entries.sort_by(|a, b| a.0.cmp(&b.0));
        }
    }
    let mut out = String::new();
    manifest.write(0, &mut out);
    out.push('\n');
    fs::write(path, out).map_err(|e| format!("cannot write {}: {}", path.display(), e))
}

/// Version of `pkg` as installed under `node_modules`, if it is there.
fn installed_version(root: &Path, pkg: &str) -> Option<String> {
    let path = root.join("node_modules").join(pkg).join("package.json");
    let text = fs::read_to_string(path).ok()?;
    let parsed = Json::parse(&text).ok()?;
    parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Every package on disk at the top level of `node_modules` (scopes expanded),
/// mapped to its installed version.
fn installed_packages(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let modules = root.join("node_modules");
    let Ok(entries) = fs::read_dir(&modules) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // A scope is a directory named `@scope` whose children are the packages.
        if let Some(scope) = name.strip_prefix('@') {
            let Ok(inner) = fs::read_dir(entry.path()) else {
                continue;
            };
            for child in inner.flatten() {
                let child_name = format!("@{}/{}", scope, child.file_name().to_string_lossy());
                if let Some(v) = installed_version(root, &child_name) {
                    out.insert(child_name, v);
                }
            }
        } else if let Some(v) = installed_version(root, &name) {
            out.insert(name, v);
        }
    }
    out
}

/// Package names reachable from `roots` by following `dependencies`, used to
/// tell a leftover top-level package from a hoisted transitive one.
fn reachable_from(root: &Path, roots: &BTreeSet<String>) -> BTreeSet<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<String> = roots.iter().cloned().collect();
    while let Some(pkg) = queue.pop() {
        if !seen.insert(pkg.clone()) {
            continue;
        }
        let manifest = root.join("node_modules").join(&pkg).join("package.json");
        let Ok(text) = fs::read_to_string(manifest) else {
            continue;
        };
        let Ok(parsed) = Json::parse(&text) else {
            continue;
        };
        if let Some(Json::Obj(entries)) = parsed.get("dependencies") {
            for (name, _) in entries {
                if !seen.contains(name) {
                    queue.push(name.clone());
                }
            }
        }
    }
    seen
}

// ---------------------------------------------------------------------------
// `hydra add` / `hydra remove`
// ---------------------------------------------------------------------------

pub fn add(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", ADD_USAGE);
        return ExitCode::SUCCESS;
    }

    let dev = args.iter().any(|a| a == "--dev" || a == "-D");
    let packages = positionals(args);
    if packages.is_empty() {
        eprintln!("hydra: add requires at least one package name");
        eprint!("{}", ADD_USAGE);
        return ExitCode::from(2);
    }

    let root = project_root();
    let manager = detect_manager(&root);
    let manifest_path = root.join("package.json");

    println!(
        "hydra add — {} via {} in {}",
        packages.join(" "),
        manager.binary(),
        root.display()
    );

    // Run the manager first: it writes the version it actually resolved, and
    // lands the package on disk before we try to read a version back.
    let install_error = run_manager(&root, manager.binary(), &manager.add_args(&packages, dev)).err();

    let mut manifest = if manifest_path.is_file() {
        match load_manifest(&manifest_path) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("hydra: {}", e);
                return ExitCode::from(1);
            }
        }
    } else {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "hydra-app".to_string());
        println!("  creating {}", manifest_path.display());
        new_manifest(&name)
    };

    let (target, other) = if dev {
        ("devDependencies", "dependencies")
    } else {
        ("dependencies", "devDependencies")
    };

    for pkg in &packages {
        // Keep the manager's own range when we cannot read a version back,
        // rather than inventing one.
        let version = installed_version(&root, pkg)
            .map(|v| format!("^{}", v))
            .or_else(|| {
                manifest
                    .get(target)
                    .and_then(|s| s.get(pkg))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
        let Some(version) = version else {
            println!("  warn  {} installed but no version could be determined", pkg);
            continue;
        };
        manifest.ensure_obj(target).set(pkg, Json::Str(version.clone()));
        manifest.remove_from(other, pkg);
        println!("  {} {} -> {}", target, pkg, version);
    }

    if let Err(e) = save_manifest(&manifest_path, &mut manifest) {
        eprintln!("hydra: {}", e);
        return ExitCode::from(1);
    }

    match install_error {
        Some(e) => {
            eprintln!("hydra: {} (package.json was still updated)", e);
            ExitCode::from(1)
        }
        None => ExitCode::SUCCESS,
    }
}

pub fn remove(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", REMOVE_USAGE);
        return ExitCode::SUCCESS;
    }

    let packages = positionals(args);
    if packages.is_empty() {
        eprintln!("hydra: remove requires at least one package name");
        eprint!("{}", REMOVE_USAGE);
        return ExitCode::from(2);
    }

    let root = project_root();
    let manager = detect_manager(&root);
    let manifest_path = root.join("package.json");

    println!(
        "hydra remove — {} via {} in {}",
        packages.join(" "),
        manager.binary(),
        root.display()
    );

    let remove_error = run_manager(&root, manager.binary(), &manager.remove_args(&packages)).err();

    if manifest_path.is_file() {
        let mut manifest = match load_manifest(&manifest_path) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("hydra: {}", e);
                return ExitCode::from(1);
            }
        };
        for pkg in &packages {
            // Both sections: a package can move between them over a project's
            // life, and leaving a stale entry behind is the bug this prevents.
            for section in DEP_SECTIONS {
                if manifest.remove_from(section, pkg) {
                    println!("  {} -{}", section, pkg);
                }
            }
        }
        if let Err(e) = save_manifest(&manifest_path, &mut manifest) {
            eprintln!("hydra: {}", e);
            return ExitCode::from(1);
        }
    }

    match remove_error {
        Some(e) => {
            eprintln!("hydra: {}", e);
            ExitCode::from(1)
        }
        None => ExitCode::SUCCESS,
    }
}

// ---------------------------------------------------------------------------
// `hydra list`
// ---------------------------------------------------------------------------

pub fn list(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", LIST_USAGE);
        return ExitCode::SUCCESS;
    }

    let root = project_root();
    let manifest_path = root.join("package.json");
    println!("hydra list — {}", root.display());

    if !manifest_path.is_file() {
        eprintln!("hydra: no package.json in {}", root.display());
        return ExitCode::from(1);
    }
    let manifest = match load_manifest(&manifest_path) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("hydra: {}", e);
            return ExitCode::from(1);
        }
    };

    let installed = installed_packages(&root);
    let mut declared: BTreeSet<String> = BTreeSet::new();
    let mut missing = 0usize;

    for section in DEP_SECTIONS {
        let entries = match manifest.get(section) {
            Some(Json::Obj(entries)) => entries.clone(),
            _ => Vec::new(),
        };
        println!();
        println!("{} ({})", section, entries.len());
        if entries.is_empty() {
            println!("  (none)");
            continue;
        }

        let name_width = entries
            .iter()
            .map(|(n, _)| n.chars().count())
            .chain(std::iter::once("package".len()))
            .max()
            .unwrap_or(7);
        let range_width = entries
            .iter()
            .filter_map(|(_, v)| v.as_str().map(|s| s.chars().count()))
            .chain(std::iter::once("declared".len()))
            .max()
            .unwrap_or(8);

        println!(
            "  {:<name_width$}  {:<range_width$}  {:<12}  {}",
            "package",
            "declared",
            "installed",
            "status",
            name_width = name_width,
            range_width = range_width
        );
        for (name, range) in &entries {
            declared.insert(name.clone());
            let range = range.as_str().unwrap_or("?");
            match installed.get(name) {
                Some(version) => println!(
                    "  {:<name_width$}  {:<range_width$}  {:<12}  ok",
                    name,
                    range,
                    version,
                    name_width = name_width,
                    range_width = range_width
                ),
                None => {
                    missing += 1;
                    println!(
                        "  {:<name_width$}  {:<range_width$}  {:<12}  missing",
                        name,
                        range,
                        "-",
                        name_width = name_width,
                        range_width = range_width
                    );
                }
            }
        }
    }

    // Installed but undeclared: top-level packages that are neither declared nor
    // pulled in by something declared. A plain `installed - declared` would list
    // every hoisted transitive dependency, which is not a finding.
    let reachable = reachable_from(&root, &declared);
    let strays: Vec<(&String, &String)> = installed
        .iter()
        .filter(|(name, _)| !declared.contains(*name) && !reachable.contains(*name))
        .collect();

    println!();
    println!("undeclared at the top of node_modules ({})", strays.len());
    if strays.is_empty() {
        println!("  (none)");
    } else {
        let name_width = strays
            .iter()
            .map(|(n, _)| n.chars().count())
            .chain(std::iter::once("package".len()))
            .max()
            .unwrap_or(7);
        println!(
            "  {:<name_width$}  {}",
            "package",
            "installed",
            name_width = name_width
        );
        for (name, version) in &strays {
            println!(
                "  {:<name_width$}  {}",
                name,
                version,
                name_width = name_width
            );
        }
    }

    println!();
    println!(
        "{} declared, {} installed, {} missing, {} undeclared",
        declared.len(),
        declared.len() - missing,
        missing,
        strays.len()
    );
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// `hydra clean`
// ---------------------------------------------------------------------------

/// Disk usage of a path. Symlinks contribute nothing and are never followed, so
/// measuring a tree can neither escape it nor loop.
fn path_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries.flatten().map(|e| path_size(&e.path())).sum()
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.1} {}", value, UNITS[unit])
    }
}

pub fn clean(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", CLEAN_USAGE);
        return ExitCode::SUCCESS;
    }

    let all = args.iter().any(|a| a == "--all");
    let root = project_root();
    println!("hydra clean — {}", root.display());

    let mut targets: Vec<PathBuf> = vec![root.join(output_dir_name(&root))];
    if all {
        targets.push(root.join("node_modules"));
        for cache in [".hydra", ".esbuild", ".vite"] {
            targets.push(root.join(cache));
        }
        targets.push(root.join("node_modules").join(".cache"));
    }

    // The output directory comes from a config file the user can edit, so treat
    // it as untrusted: never delete the project itself or anything outside it.
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let mut freed = 0u64;
    let mut removed = 0usize;
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();

    for target in &targets {
        if !target.exists() {
            continue;
        }
        let canonical = target.canonicalize().unwrap_or_else(|_| target.clone());
        if canonical == canonical_root || !canonical.starts_with(&canonical_root) {
            eprintln!(
                "hydra: refusing to remove {} (outside the project root)",
                target.display()
            );
            continue;
        }
        if !seen.insert(canonical) {
            continue;
        }

        let size = path_size(target);
        let display = target
            .strip_prefix(&root)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| target.display().to_string());

        // A directory is removed recursively; a stray file (someone pointed
        // outputDir at a file) goes the same way.
        let result = if target.is_dir() {
            fs::remove_dir_all(target)
        } else {
            fs::remove_file(target)
        };
        match result {
            Ok(()) => {
                println!("  removed {} ({})", display, human_size(size));
                freed += size;
                removed += 1;
            }
            Err(e) => eprintln!("hydra: cannot remove {}: {}", display, e),
        }
    }

    if removed == 0 {
        println!("  nothing to remove");
    }
    println!("freed {} across {} path(s)", human_size(freed), removed);

    if !all {
        println!("hint: hydra clean --all also removes node_modules and caches");
    }
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// `hydra analyze`
// ---------------------------------------------------------------------------

/// The package a bundled path belongs to, or `None` for project files.
///
/// The *last* `node_modules/` segment is the one that counts: pnpm nests real
/// packages under `.pnpm/<name>@<version>/node_modules/<name>/...`.
fn package_of(input: &str) -> Option<String> {
    let marker = "node_modules/";
    let tail = input.rsplit(marker).next()?;
    if tail.len() == input.len() {
        return None;
    }
    let mut parts = tail.split('/');
    let first = parts.next()?;
    if first.starts_with('@') {
        let second = parts.next()?;
        Some(format!("{}/{}", first, second))
    } else {
        Some(first.to_string())
    }
}

pub fn analyze(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", ANALYZE_USAGE);
        return ExitCode::SUCCESS;
    }

    let base = positionals(args)
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(project_root);

    // The metafile lives inside outputDir, but `dist` is what every scaffold
    // uses, so a stale hydraconfig still finds a build that was just made.
    let configured = base.join(output_dir_name(&base)).join(".hydra-build.json");
    let fallback = base.join("dist").join(".hydra-build.json");
    let metafile = if configured.is_file() {
        configured
    } else if fallback.is_file() {
        fallback
    } else {
        eprintln!(
            "hydra: no build metafile at {}",
            configured.display()
        );
        eprintln!("run `hydra build` first — it writes the esbuild metafile this reads");
        return ExitCode::from(1);
    };

    let text = match fs::read_to_string(&metafile) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("hydra: cannot read {}: {}", metafile.display(), e);
            return ExitCode::from(1);
        }
    };
    let meta = match Json::parse(&text) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("hydra: {} is not valid JSON: {}", metafile.display(), e);
            return ExitCode::from(1);
        }
    };

    println!("hydra analyze — {}", metafile.display());

    // Outputs, biggest first; each carries its per-module contribution table.
    struct Bundle {
        name: String,
        bytes: u64,
        modules: Vec<(String, u64)>,
    }

    let mut bundles: Vec<Bundle> = Vec::new();
    let mut total_input_bytes: u64 = 0;
    if let Some(Json::Obj(outputs)) = meta.get("outputs") {
        for (name, out) in outputs {
            let bytes = out.get("bytes").and_then(|v| v.as_f64()).unwrap_or(0.0) as u64;
            let mut modules: Vec<(String, u64)> = Vec::new();
            if let Some(Json::Obj(inputs)) = out.get("inputs") {
                for (path, info) in inputs {
                    let share = info
                        .get("bytesInOutput")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0) as u64;
                    modules.push((path.clone(), share));
                }
            }
            modules.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            bundles.push(Bundle {
                name: name.clone(),
                bytes,
                modules,
            });
        }
    }
    bundles.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));

    if let Some(Json::Obj(inputs)) = meta.get("inputs") {
        total_input_bytes = inputs
            .iter()
            .map(|(_, v)| v.get("bytes").and_then(|b| b.as_f64()).unwrap_or(0.0) as u64)
            .sum();
    }

    println!();
    println!("output bundles (largest first)");
    if bundles.is_empty() {
        println!("  (the metafile lists no outputs)");
    } else {
        let width = bundles
            .iter()
            .map(|b| b.name.chars().count())
            .max()
            .unwrap_or(0);
        for bundle in &bundles {
            println!("  {:<12}  {:<width$}", bundle.bytes, bundle.name, width = width);
        }
    }

    println!();
    println!("contributing modules");
    if bundles.is_empty() {
        println!("  (none)");
    }
    for bundle in &bundles {
        let total: u64 = bundle.modules.iter().map(|(_, b)| b).sum();
        println!(
            "  {} — {} module(s), {} bytes",
            bundle.name,
            bundle.modules.len(),
            total
        );
        if bundle.modules.is_empty() {
            println!("    (no inputs recorded)");
            continue;
        }
        let width = bundle
            .modules
            .iter()
            .take(8)
            .map(|(p, _)| p.chars().count())
            .max()
            .unwrap_or(0);
        for (path, share) in bundle.modules.iter().take(8) {
            println!("    {:<12}  {:<width$}", share, path, width = width);
        }
        if bundle.modules.len() > 8 {
            println!("    ... {} more", bundle.modules.len() - 8);
        }
    }

    // Duplicates are counted from what actually went into the bundles; when the
    // metafile has no per-output inputs, fall back to the module graph.
    let mut occurrences: BTreeMap<String, (u64, BTreeSet<String>)> = BTreeMap::new();
    let from_bundles: Vec<(&String, u64)> = bundles
        .iter()
        .flat_map(|b| b.modules.iter().map(|(p, s)| (p, *s)))
        .collect();
    let pairs: Vec<(String, u64)> = if from_bundles.is_empty() {
        meta.get("inputs")
            .and_then(|v| v.as_obj())
            .map(|inputs| {
                inputs
                    .iter()
                    .map(|(p, info)| {
                        (
                            p.clone(),
                            info.get("bytes").and_then(|b| b.as_f64()).unwrap_or(0.0) as u64,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        from_bundles
            .into_iter()
            .map(|(p, s)| (p.clone(), s))
            .collect()
    };
    for (path, bytes) in pairs {
        let Some(pkg) = package_of(&path) else {
            continue;
        };
        let entry = occurrences.entry(pkg).or_insert((0, BTreeSet::new()));
        entry.0 += bytes;
        entry.1.insert(path);
    }
    let mut duplicates: Vec<(String, u64, BTreeSet<String>)> = occurrences
        .into_iter()
        .filter(|(_, (_, paths))| paths.len() > 1)
        .map(|(name, (bytes, paths))| (name, bytes, paths))
        .collect();
    duplicates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    println!();
    println!("duplicate dependencies (same package in more than one input path)");
    if duplicates.is_empty() {
        println!("  (none)");
    } else {
        for (name, bytes, paths) in &duplicates {
            println!("  {} — {} input path(s), {} bytes", name, paths.len(), bytes);
            for path in paths {
                println!("    {}", path);
            }
        }
    }

    let output_bytes: u64 = bundles.iter().map(|b| b.bytes).sum();
    println!();
    println!("totals");
    println!(
        "  outputs: {} bundle(s), {} bytes ({})",
        bundles.len(),
        output_bytes,
        human_size(output_bytes)
    );
    println!("  inputs: {} bytes across the module graph", total_input_bytes);
    println!("  duplicates: {}", duplicates.len());

    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// Minimal JSON
// ---------------------------------------------------------------------------

/// Just enough JSON to round-trip `package.json` and walk an esbuild metafile.
///
/// Numbers keep their source text: `"port": 5173` and `"version": 19` must come
/// back byte-identical, and a float formatter would quietly rewrite them.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Json {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub(crate) fn obj() -> Json {
        Json::Obj(Vec::new())
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        match self {
            Json::Obj(entries) => entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => n.parse().ok(),
            _ => None,
        }
    }

    pub(crate) fn as_obj(&self) -> Option<&Vec<(String, Json)>> {
        match self {
            Json::Obj(entries) => Some(entries),
            _ => None,
        }
    }

    /// Insert or replace a key, keeping the position of an existing one so an
    /// untouched key never moves in the file.
    fn set(&mut self, key: &str, value: Json) {
        if let Json::Obj(entries) = self {
            match entries.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => entries.push((key.to_string(), value)),
            }
        }
    }

    /// The object at `key`, created (and appended) when absent.
    fn ensure_obj(&mut self, key: &str) -> &mut Json {
        let missing = !matches!(self.get(key), Some(Json::Obj(_)));
        if missing {
            self.set(key, Json::obj());
        }
        self.get_mut(key).expect("just inserted")
    }

    fn remove_from(&mut self, key: &str, field: &str) -> bool {
        match self.get_mut(key) {
            Some(Json::Obj(entries)) => {
                let before = entries.len();
                entries.retain(|(k, _)| k != field);
                entries.len() != before
            }
            _ => false,
        }
    }

    pub(crate) fn parse(text: &str) -> Result<Json, String> {
        let chars: Vec<char> = text.chars().collect();
        let mut parser = JsonParser { chars, pos: 0 };
        parser.skip_ws();
        let value = parser.value()?;
        parser.skip_ws();
        if parser.pos != parser.chars.len() {
            return Err(format!("unexpected trailing input at offset {}", parser.pos));
        }
        Ok(value)
    }

    fn write(&self, indent: usize, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => out.push_str(n),
            Json::Str(s) => write_json_string(s, out),
            Json::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push_str("[\n");
                for (i, item) in items.iter().enumerate() {
                    out.push_str(&"  ".repeat(indent + 1));
                    item.write(indent + 1, out);
                    if i + 1 < items.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&"  ".repeat(indent));
                out.push(']');
            }
            Json::Obj(entries) => {
                if entries.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (i, (key, value)) in entries.iter().enumerate() {
                    out.push_str(&"  ".repeat(indent + 1));
                    write_json_string(key, out);
                    out.push_str(": ");
                    value.write(indent + 1, out);
                    if i + 1 < entries.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&"  ".repeat(indent));
                out.push('}');
            }
        }
    }
}

fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
}

struct JsonParser {
    chars: Vec<char>,
    pos: usize,
}

impl JsonParser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(' ') | Some('\t') | Some('\n') | Some('\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, expected: char) -> Result<(), String> {
        if self.peek() == Some(expected) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!(
                "expected {:?} at offset {}, found {:?}",
                expected,
                self.pos,
                self.peek()
            ))
        }
    }

    fn literal(&mut self, word: &str) -> Result<(), String> {
        for expected in word.chars() {
            self.expect(expected)?;
        }
        Ok(())
    }

    fn value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        match self.peek() {
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"') => Ok(Json::Str(self.string()?)),
            Some('t') => {
                self.literal("true")?;
                Ok(Json::Bool(true))
            }
            Some('f') => {
                self.literal("false")?;
                Ok(Json::Bool(false))
            }
            Some('n') => {
                self.literal("null")?;
                Ok(Json::Null)
            }
            Some(c) if c == '-' || c.is_ascii_digit() => self.number(),
            other => Err(format!("unexpected {:?} at offset {}", other, self.pos)),
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.expect('{')?;
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek() == Some('}') {
            self.pos += 1;
            return Ok(Json::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            self.expect(':')?;
            let value = self.value()?;
            entries.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(',') => self.pos += 1,
                Some('}') => {
                    self.pos += 1;
                    return Ok(Json::Obj(entries));
                }
                other => {
                    return Err(format!(
                        "expected ',' or '}}' at offset {}, found {:?}",
                        self.pos, other
                    ))
                }
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.expect('[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(']') {
            self.pos += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_ws();
            match self.peek() {
                Some(',') => self.pos += 1,
                Some(']') => {
                    self.pos += 1;
                    return Ok(Json::Arr(items));
                }
                other => {
                    return Err(format!(
                        "expected ',' or ']' at offset {}, found {:?}",
                        self.pos, other
                    ))
                }
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect('"')?;
        let mut out = String::new();
        loop {
            let c = self
                .peek()
                .ok_or_else(|| "unterminated string".to_string())?;
            self.pos += 1;
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let esc = self
                        .peek()
                        .ok_or_else(|| "unterminated escape".to_string())?;
                    self.pos += 1;
                    match esc {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let mut code = 0u32;
                            for _ in 0..4 {
                                let digit = self
                                    .peek()
                                    .and_then(|d| d.to_digit(16))
                                    .ok_or_else(|| "bad \\u escape".to_string())?;
                                self.pos += 1;
                                code = code * 16 + digit;
                            }
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        other => return Err(format!("bad escape \\{}", other)),
                    }
                }
                other => out.push(other),
            }
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')
        {
            self.pos += 1;
        }
        if self.pos == start {
            return Err(format!("expected a number at offset {}", start));
        }
        let raw: String = self.chars[start..self.pos].iter().collect();
        raw.parse::<f64>()
            .map_err(|_| format!("invalid number {:?} at offset {}", raw, start))?;
        Ok(Json::Num(raw))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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
                "hydra-tools-{}-{}-{}",
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

    /// An untouched manifest must come back byte-identical — that is the whole
    /// point of keeping numbers and key order verbatim.
    #[test]
    fn json_round_trips_the_scaffolded_package_json() {
        let text = crate::scaffold::PACKAGE_JSON_TEMPLATE.replace("__NAME__", "demo");
        let parsed = Json::parse(&text).expect("the template must be valid JSON");
        let mut out = String::new();
        parsed.write(0, &mut out);
        out.push('\n');
        assert_eq!(out, text, "an untouched manifest must not be reformatted");
    }

    #[test]
    fn json_round_trips_an_untouched_manifest() {
        let text = "{\n  \"name\": \"demo\",\n  \"private\": true,\n  \"port\": 5173,\n  \"deps\": {\n    \"a\": \"^1.0.0\"\n  },\n  \"list\": [\n    1,\n    2.5,\n    null\n  ]\n}\n";
        let parsed = Json::parse(text).expect("parse");
        let mut out = String::new();
        parsed.write(0, &mut out);
        out.push('\n');
        assert_eq!(out, text);
    }

    #[test]
    fn json_parse_rejects_trailing_garbage() {
        assert!(Json::parse("{\"a\": 1} tail").is_err());
        assert!(Json::parse("{\"a\": }").is_err());
        assert!(Json::parse("{\"a\": 1").is_err());
    }

    #[test]
    fn json_handles_escapes_and_empty_containers() {
        let parsed = Json::parse(r#"{"a": "x\ny\"z", "b": {}, "c": []}"#).expect("parse");
        assert_eq!(parsed.get("a").and_then(|v| v.as_str()), Some("x\ny\"z"));
        let mut out = String::new();
        parsed.write(0, &mut out);
        assert!(out.contains("\"b\": {}"));
        assert!(out.contains("\"c\": []"));
    }

    #[test]
    fn set_and_remove_keep_key_positions() {
        let mut value = Json::parse(r#"{"a": 1, "b": 2, "c": 3}"#).expect("parse");
        value.set("b", Json::Str("new".into()));
        value.set("d", Json::Str("end".into()));
        assert_eq!(
            value.as_obj().unwrap().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c", "d"],
            "replacing a key must not move it; a new key goes last"
        );
        assert!(
            !value.remove_from("nope", "a"),
            "removing from a missing section reports no change"
        );
    }

    #[test]
    fn detect_manager_follows_the_lockfile_precedence() {
        let tree = TempTree::new("manager");
        assert_eq!(detect_manager(&tree.root), Manager::Npm, "no lockfile");

        tree.write("yarn.lock", "");
        assert_eq!(detect_manager(&tree.root), Manager::Yarn);

        tree.write("pnpm-lock.yaml", "");
        assert_eq!(detect_manager(&tree.root), Manager::Pnpm);

        tree.write("bun.lockb", "");
        assert_eq!(detect_manager(&tree.root), Manager::Bun);
    }

    #[test]
    fn add_args_match_each_manager() {
        let pkgs = vec!["clsx".to_string()];
        assert_eq!(Manager::Npm.add_args(&pkgs, true), vec!["install", "clsx", "--save-dev"]);
        assert_eq!(Manager::Bun.add_args(&pkgs, true), vec!["add", "clsx", "--dev"]);
        assert_eq!(Manager::Yarn.add_args(&pkgs, false), vec!["add", "clsx"]);
        assert_eq!(Manager::Pnpm.remove_args(&pkgs), vec!["remove", "clsx"]);
        assert_eq!(Manager::Npm.remove_args(&pkgs), vec!["uninstall", "clsx"]);
    }

    #[test]
    fn manifest_is_created_then_sorted_on_save() {
        let tree = TempTree::new("manifest");
        let path = tree.root.join("package.json");
        let mut manifest = new_manifest("demo");
        manifest.ensure_obj("dependencies").set("z", Json::Str("^1.0.0".into()));
        manifest.ensure_obj("dependencies").set("a", Json::Str("^2.0.0".into()));
        save_manifest(&path, &mut manifest).expect("save");

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.ends_with("}\n"), "trailing newline");
        assert!(text.contains("    \"a\": \"^2.0.0\",\n    \"z\": \"^1.0.0\""), "sorted: {}", text);
        assert!(Json::parse(&text).is_ok(), "output must be valid JSON");
    }

    #[test]
    fn installed_packages_expands_scopes_and_reads_versions() {
        let tree = TempTree::new("installed");
        tree.write("node_modules/react/package.json", r#"{"name":"react","version":"19.0.0"}"#);
        tree.write("node_modules/@types/react/package.json", r#"{"version":"19.0.2"}"#);
        tree.write("node_modules/.bin/ignored", "");
        let found = installed_packages(&tree.root);
        assert_eq!(found.get("react").map(|s| s.as_str()), Some("19.0.0"));
        assert_eq!(found.get("@types/react").map(|s| s.as_str()), Some("19.0.2"));
        assert_eq!(found.len(), 2, "dot entries and unscoped junk are skipped");
    }

    #[test]
    fn reachable_follows_transitive_dependencies() {
        let tree = TempTree::new("reachable");
        tree.write(
            "node_modules/a/package.json",
            r#"{"version":"1.0.0","dependencies":{"b":"^1.0.0"}}"#,
        );
        tree.write("node_modules/b/package.json", r#"{"version":"1.0.0"}"#);
        tree.write("node_modules/leftover/package.json", r#"{"version":"1.0.0"}"#);

        let mut roots = BTreeSet::new();
        roots.insert("a".to_string());
        let reachable = reachable_from(&tree.root, &roots);
        assert!(reachable.contains("a") && reachable.contains("b"));
        assert!(!reachable.contains("leftover"));
    }

    #[test]
    fn package_of_uses_the_last_node_modules_segment() {
        assert_eq!(package_of("src/App.hyx"), None);
        assert_eq!(
            package_of("node_modules/react/index.js").as_deref(),
            Some("react")
        );
        assert_eq!(
            package_of(".pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/index.js").as_deref(),
            Some("@scope/pkg")
        );
        assert_eq!(package_of("node_modules/react/cjs/react.js").as_deref(), Some("react"));
    }

    #[test]
    fn path_size_and_human_size() {
        let tree = TempTree::new("size");
        tree.write("dist/a.txt", "0123456789");
        tree.write("dist/nested/b.txt", "01234");
        assert_eq!(path_size(&tree.root.join("dist")), 15);
        assert_eq!(path_size(&tree.root.join("missing")), 0);
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2.0 KB");
    }

    #[test]
    fn output_dir_name_reads_the_config_and_defaults_to_dist() {
        let tree = TempTree::new("outdir");
        assert_eq!(output_dir_name(&tree.root), "dist");
        tree.write("hydraconfig.json", r#"{"outputDir": "./build"}"#);
        assert_eq!(output_dir_name(&tree.root), "build");
        tree.write("hydraconfig.json", "not json");
        assert_eq!(output_dir_name(&tree.root), "dist", "a broken config falls back");
    }

    #[test]
    fn subcommand_help_exits_zero() {
        let help = vec!["--help".to_string()];
        assert_eq!(add(&help), ExitCode::SUCCESS);
        assert_eq!(remove(&help), ExitCode::SUCCESS);
        assert_eq!(list(&help), ExitCode::SUCCESS);
        assert_eq!(clean(&help), ExitCode::SUCCESS);
        assert_eq!(analyze(&help), ExitCode::SUCCESS);
    }

    #[test]
    fn add_and_remove_require_a_package_name() {
        assert_eq!(add(&[]), ExitCode::from(2));
        assert_eq!(remove(&[]), ExitCode::from(2));
    }

    #[test]
    fn analyze_without_a_metafile_fails_with_a_hint() {
        let tree = TempTree::new("analyze-missing");
        let arg = tree.root.to_string_lossy().to_string();
        assert_eq!(analyze(&[arg]), ExitCode::from(1));
    }

    #[test]
    fn analyze_reports_totals_from_a_synthetic_metafile() {
        let tree = TempTree::new("analyze");
        tree.write("hydraconfig.json", r#"{"outputDir": "dist"}"#);
        tree.write(
            "dist/.hydra-build.json",
            r#"{
              "inputs": {
                "src/main.hyx": {"bytes": 10},
                "src/App.hyx": {"bytes": 40},
                "node_modules/react/index.js": {"bytes": 20},
                "node_modules/react/cjs/react.js": {"bytes": 30}
              },
              "outputs": {
                "assets/index.js": {
                  "bytes": 100,
                  "inputs": {
                    "src/main.hyx": {"bytesInOutput": 10},
                    "node_modules/react/index.js": {"bytesInOutput": 20},
                    "node_modules/react/cjs/react.js": {"bytesInOutput": 30}
                  }
                }
              }
            }"#,
        );
        let arg = tree.root.to_string_lossy().to_string();
        assert_eq!(analyze(&[arg]), ExitCode::SUCCESS);
    }
}
