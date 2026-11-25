//! `hydra doctor`: what it found, and what is wrong with it.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use super::*;
use super::init::*;
use super::stats::*;
use super::util::*;

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

    // Routes. The roadmap asks for this specifically, and the reason is the
    // collision case: `[slug].hyx` and `[id].hyx` in one folder both match the same
    // URL, so one of them wins SILENTLY. That is the failure a health report
    // exists to catch — the build cannot, because both files are valid.
    println!();
    route_report(&root, &mut failed);

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

/// Report the file-based routes, and FAIL on a table that cannot resolve.
///
/// A collision is two files claiming one URL pattern: a `[slug]` beside an `[id]`,
/// or a `page.hyx` beside `page/index.hyx`. Both compile, so the build stays green
/// and which one answers depends on directory order — the kind of bug that looks
/// like a caching problem for an afternoon.
pub(super) fn route_report(root: &Path, failed: &mut usize) {
    let pages = root.join("src").join("pages");
    if !pages.is_dir() {
        println!("warn  no src/pages — this project has no file-based routes");
        return;
    }

    // (pattern, file) for every route file, mirroring the runner's rules: `_name`
    // and `(group)` are not part of the URL, `[x]` is a parameter, `index` is the
    // folder itself.
    let mut routes: Vec<(String, String)> = Vec::new();
    collect_routes(&pages, &pages, &mut routes);

    let mut counts: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for (_, file) in &routes {
        let ext = file.rsplit('.').next().unwrap_or("");
        *counts.entry(if ext == "hyx" { "hyx" } else { "hys" }).or_insert(0) += 1;
    }

    // Group by the shape of the pattern, not its text: `/blog/[slug]` and
    // `/blog/[id]` are the SAME route.
    let mut by_shape: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for (pattern, file) in &routes {
        let shape = pattern
            .split('/')
            .map(|seg| if seg.starts_with('[') { "[*]" } else { seg })
            .collect::<Vec<_>>()
            .join("/");
        by_shape.entry(shape).or_default().push(file.clone());
    }

    let mut collisions = 0usize;
    for (shape, files) in &by_shape {
        if files.len() > 1 {
            collisions += 1;
            println!(
                "fail  route collision at {} — {}",
                if shape.is_empty() { "/" } else { shape },
                files.join(", ")
            );
            println!("      both files match one URL, so which one answers depends on");
            println!("      directory order. Rename one, or move it under a (group).");
        }
    }

    println!(
        "ok    routes {} ({} .hyx){}",
        routes.len(),
        counts.get("hyx").copied().unwrap_or(0),
        if collisions == 0 {
            ", no collisions".to_string()
        } else {
            format!(", {} COLLISION(S)", collisions)
        }
    );
    *failed += collisions;
}

/// Walk `dir`, pushing `(url pattern, relative file)` for every route file.
pub(super) fn collect_routes(base: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            // `_folder` is private to the router, `(group)` is not in the URL.
            if name.starts_with('_') || name.starts_with('.') {
                continue;
            }
            collect_routes(base, &path, out);
            continue;
        }
        // Strip the EXTENSION, not the first dot: `[...rest].hyx` is a file whose stem
        // is `[...rest]`, and splitting on '.' truncated it to `[`.
        let stem = name
            .strip_suffix(".hyx")
            .or_else(|| name.strip_suffix(".hys"))
            .unwrap_or("");
        if stem.is_empty() {
            continue;
        }
        // A page's server half is not a route of its own.
        if name.ends_with(".server.hys") || stem.starts_with('_') {
            continue;
        }
        let rel_dir = dir.strip_prefix(base).unwrap_or(Path::new(""));
        let mut segs: Vec<String> = rel_dir
            .components()
            .filter_map(|c| {
                let s = c.as_os_str().to_string_lossy().to_string();
                // A group `(marketing)` does not appear in the URL.
                if s.starts_with('(') && s.ends_with(')') { None } else { Some(s) }
            })
            .collect();
        if stem != "index" {
            segs.push(stem.to_string());
        }
        let pattern = format!("/{}", segs.join("/"));
        out.push((pattern, name));
    }
}

/// FNV-1a over the file bytes. This is a fingerprint for comparing one artifact
/// against another on the same machine, not a security hash, and it keeps the
/// compiler at zero dependencies.
pub(super) fn fingerprint(path: &Path) -> Option<(u64, u64, u64)> {
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
pub(super) fn beside_binary(rel: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(rel);
    candidate.is_file().then_some(candidate)
}

pub(super) fn artifact_report(failed: &mut usize) {
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
