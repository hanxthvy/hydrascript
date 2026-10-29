// [xihanzu-NR]
//! Developer CLI: build, check, init.
//!
//! Subcommands on the same binary as the compiler, so the whole toolchain ships
//! as one 464KB executable with no Python anywhere in the loop.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use crate::compile;

fn find_hydraconfig() -> Option<PathBuf> {
    let mut current = std::env::current_dir().ok()?;
    loop {
        let candidate = current.join("hydraconfig.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !current.pop() {
            break;
        }
    }
    None
}

/// Locate `packages/cli/runner.mjs`, which ships alongside the binary.
///
/// This used to be an absolute path into the author's checkout, so a globally
/// installed `hydra` either failed or ran a stranger's copy of the runner.
/// Resolution is now: explicit env var, then relative to the running binary,
/// then the build-time source tree (which is what a `cargo run` needs).
fn find_runner() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("HYDRA_RUNNER") {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        // target/{debug,release}/hydra -> ../../../packages/cli/runner.mjs
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..4 {
            let Some(d) = dir else { break };
            candidates.push(d.join("packages/cli/runner.mjs"));
            candidates.push(d.join("bin/runner.mjs"));
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/cli/runner.mjs"));
    candidates.into_iter().find(|p| p.is_file())
}

fn spawn_runner(cmd: &str, args: &[String]) -> ExitCode {
    let Some(runner_path) = find_runner() else {
        eprintln!("hydra: cannot find packages/cli/runner.mjs");
        eprintln!("hint: set HYDRA_RUNNER=/path/to/packages/cli/runner.mjs");
        return ExitCode::from(1);
    };
    let mut command = std::process::Command::new("node");
    command
        .arg(&runner_path)
        .arg(cmd)
        .args(args)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());

    match command.spawn().and_then(|mut c| c.wait()) {
        Ok(status) => {
            if let Some(code) = status.code() {
                ExitCode::from(code as u8)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(e) => {
            eprintln!("hydra: execution error: {}", e);
            ExitCode::from(1)
        }
    }
}

pub fn dev_cmd(args: &[String]) -> ExitCode {
    let has_help = args.iter().any(|a| a == "--help" || a == "-h");
    if find_hydraconfig().is_some() || has_help {
        spawn_runner("dev", args)
    } else {
        watch(args)
    }
}

pub fn build_cmd(args: &[String]) -> ExitCode {
    let has_help = args.iter().any(|a| a == "--help" || a == "-h");
    if find_hydraconfig().is_some() || has_help {
        spawn_runner("build", args)
    } else {
        build(args)
    }
}

pub fn preview_cmd(args: &[String]) -> ExitCode {
    let has_help = args.iter().any(|a| a == "--help" || a == "-h");
    if find_hydraconfig().is_some() || has_help {
        spawn_runner("preview", args)
    } else {
        eprintln!("hydra: preview requires hydraconfig.json");
        ExitCode::from(1)
    }
}

pub fn run(args: &[String]) -> ExitCode {
    match args.first().map(|s| s.as_str()) {
        Some("run") => run_script(&args[1..]),
        Some("dev") => dev_cmd(&args[1..]),
        Some("build") => build_cmd(&args[1..]),
        Some("preview") => preview_cmd(&args[1..]),
        Some("watch") => watch(&args[1..]),
        Some("check") => check(&args[1..]),
        Some("init") => crate::scaffold::init(&args[1..]),
        Some("fmt") => crate::fmt::run(&args[1..]),
        Some("stats") => crate::scaffold::stats(&args[1..]),
        Some("doctor") => crate::scaffold::doctor(&args[1..]),
        Some("add") => crate::tools::add(&args[1..]),
        Some("remove") => crate::tools::remove(&args[1..]),
        Some("list") => crate::tools::list(&args[1..]),
        Some("clean") => crate::tools::clean(&args[1..]),
        Some("analyze") => crate::tools::analyze(&args[1..]),
        Some("repl") => repl(),
        Some(other) => {
            eprintln!("hydra: unknown command {:?}", other);
            eprintln!(
                "try: hydra dev | build | preview | run | watch | repl | check | init | --help"
            );
            ExitCode::from(2)
        }
        None => repl(),
    }
}

pub fn run_script(args: &[String]) -> ExitCode {
    let file_arg = match args.iter().find(|a| !a.starts_with('-')) {
        Some(f) => PathBuf::from(f),
        None => {
            eprintln!("hydra: run requires a script file (e.g. hydra run script.hys)");
            return ExitCode::from(2);
        }
    };
    let Ok(src) = fs::read_to_string(&file_arg) else {
        eprintln!("hydra: cannot read {}", file_arg.display());
        return ExitCode::from(1);
    };

    let filename = file_arg
        .file_name()
        .map_or_else(|| "script.hys".into(), |n| n.to_string_lossy().to_string());
    let (code, _map) = match compile(&src, &filename) {
        Ok(res) => res,
        Err(e) => {
            eprintln!("{}", e.pretty());
            return ExitCode::from(1);
        }
    };

    let file_str = file_arg.to_string_lossy();
    let file_idx = args.iter().position(|a| a == &file_str).unwrap_or(0);
    let script_args = &args[file_idx + 1..];

    let parent_dir = file_arg.parent().unwrap_or_else(|| Path::new("."));

    let use_bun = code.contains("bun:")
        || code.contains("Bun.")
        || std::env::var("HYDRA_RUNTIME").as_deref() == Ok("bun")
        || std::env::var("npm_config_user_agent").map_or(false, |s| s.contains("bun"));

    let spawn_bun = || {
        std::process::Command::new("bun")
            .current_dir(parent_dir)
            .arg("-")
            .args(script_args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()
    };

    let spawn_node = || {
        std::process::Command::new("node")
            .current_dir(parent_dir)
            .arg("--input-type=module")
            .arg("-")
            .args(script_args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()
    };

    let mut child = if use_bun {
        match spawn_bun() {
            Ok(c) => c,
            Err(_) => match spawn_node() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("hydra: neither bun nor node runtime found: {}", e);
                    return ExitCode::from(1);
                }
            },
        }
    } else {
        match spawn_node() {
            Ok(c) => c,
            Err(_) => match spawn_bun() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("hydra: neither node nor bun runtime found: {}", e);
                    return ExitCode::from(1);
                }
            },
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(code.as_bytes());
    }

    match child.wait() {
        Ok(status) => {
            if let Some(c) = status.code() {
                ExitCode::from(c as u8)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(e) => {
            eprintln!("hydra: execution error: {}", e);
            ExitCode::from(1)
        }
    }
}

/// Recursively collect every file under `dir` whose extension is `ext`.
fn collect(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name()
                .map_or(false, |n| n == "node_modules" || n == "dist" || n == ".git")
            {
                continue;
            }
            collect(&p, ext, out);
        } else if p.extension().map_or(false, |x| x == ext) {
            out.push(p);
        }
    }
}

fn targets(args: &[String]) -> Vec<PathBuf> {
    let files: Vec<PathBuf> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .collect();
    if !files.is_empty() {
        return files;
    }
    let mut found = Vec::new();
    for ext in &["hyx", "hys", "hsx", "hs", "hx"] {
        collect(Path::new("src"), ext, &mut found);
    }
    if found.is_empty() {
        for ext in &["hyx", "hys", "hsx", "hs", "hx"] {
            collect(Path::new("."), ext, &mut found);
        }
    }
    found.sort();
    found
}

/// Where a compiled file goes: `watch-out/` (or `dist-watch/` if the caller says
/// so), mirroring the source tree.
///
/// Both `build` and `watch` used to write next to the source — `src/App.hyx`
/// became `src/App.tsx`. In a project that keeps its sources under version
/// control that is destructive: generated files appear beside real ones, `git
/// add` picks them up, and a reader cannot tell which is authored. Nothing
/// imports these outputs (the bundler compiles in-process), so they are a
/// readable view and belong in one throwaway directory.
fn output_paths(path: &Path) -> (PathBuf, PathBuf) {
    let is_js = path
        .extension()
        .map_or(false, |x| x == "hys" || x == "hs" || x == "hx");
    let out_ext = if is_js { "mjs" } else { "tsx" };
    let rel = path.strip_prefix("src").unwrap_or(path);
    let base = Path::new("watch-out");
    let out_file = base.join(rel).with_extension(out_ext);
    let map_path = base.join(rel).with_extension(format!("{}.map", out_ext));
    (out_file, map_path)
}

fn build(args: &[String]) -> ExitCode {
    if args.iter().any(|a| a == "-w" || a == "--watch") {
        let stripped: Vec<String> = args
            .iter()
            .filter(|a| a.as_str() != "-w" && a.as_str() != "--watch")
            .cloned()
            .collect();
        return watch(&stripped);
    }
    let verbose = args.iter().any(|a| a == "-v" || a == "--verbose");
    let files = targets(args);
    if files.is_empty() {
        eprintln!("hydra: no .hyx, .hys, .hsx, .hs, or .hx files found");
        return ExitCode::from(1);
    }

    let t0 = Instant::now();
    let mut errors = 0usize;

    for path in &files {
        let Ok(src) = fs::read_to_string(path) else {
            eprintln!("hydra: cannot read {}", path.display());
            errors += 1;
            continue;
        };
        let name = path
            .file_name()
            .map_or_else(|| "out.hyx".into(), |n| n.to_string_lossy().to_string());
        match compile(&src, &name) {
            Ok((code, map)) => {
                let (out_file, map_path) = output_paths(path);
                if let Some(parent) = out_file.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let map_name = map_path
                    .file_name()
                    .map_or_else(|| "out.map".into(), |n| n.to_string_lossy().to_string());
                let with_ref = format!("{}\n//# sourceMappingURL={}\n", code, map_name);
                if let Err(e) = fs::write(&out_file, with_ref) {
                    eprintln!("hydra: cannot write {}: {}", out_file.display(), e);
                    errors += 1;
                    continue;
                }
                let _ = fs::write(&map_path, map);
                if verbose {
                    println!(
                        "  \x1b[32mcompiled\x1b[0m {} -> {}",
                        path.display(),
                        out_file.display()
                    );
                }
            }
            Err(e) => {
                eprintln!("{}", e.pretty());
                errors += 1;
            }
        }
    }

    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    if errors > 0 {
        eprintln!(
            "\n\x1b[1;31mbuild failed\x1b[0m: {} error(s) in {:.1}ms",
            errors, ms
        );
        return ExitCode::from(1);
    }
    println!(
        "\x1b[32mOK\x1b[0m: compiled {} file(s) in {:.1}ms",
        files.len(),
        ms
    );
    ExitCode::SUCCESS
}

pub fn watch(args: &[String]) -> ExitCode {
    use std::collections::HashMap;
    use std::thread::sleep;
    use std::time::{Duration, SystemTime};

    println!("\x1b[36m🐉 HydraScript\x1b[0m watching for changes (press Ctrl+C to exit)...");

    let mut mtimes: HashMap<PathBuf, SystemTime> = HashMap::new();

    let files = targets(args);
    for path in &files {
        if let Ok(meta) = fs::metadata(path) {
            if let Ok(m) = meta.modified() {
                mtimes.insert(path.clone(), m);
            }
        }
    }
    let _ = build(args);

    loop {
        sleep(Duration::from_millis(200));
        let current_files = targets(args);
        for path in &current_files {
            let Ok(meta) = fs::metadata(path) else {
                continue;
            };
            let Ok(m) = meta.modified() else { continue };
            let is_changed = match mtimes.get(path) {
                Some(&prev) => m > prev,
                None => true,
            };
            if is_changed {
                mtimes.insert(path.clone(), m);
                let t0 = Instant::now();
                if let Ok(src) = fs::read_to_string(path) {
                    let name = path
                        .file_name()
                        .map_or_else(|| "out.hyx".into(), |n| n.to_string_lossy().to_string());
                    match compile(&src, &name) {
                        Ok((code, map)) => {
                            let (out_file, map_path) = output_paths(path);
                            if let Some(parent) = out_file.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            let map_name = map_path.file_name().map_or_else(
                                || "out.map".into(),
                                |n| n.to_string_lossy().to_string(),
                            );
                            // The map sits beside the output inside watch-out/,
                            // so the bare filename is correct here.
                            let with_ref = format!("{}\n//# sourceMappingURL={}\n", code, map_name);
                            let _ = fs::write(&out_file, with_ref);
                            let _ = fs::write(&map_path, map);
                            let ms = t0.elapsed().as_secs_f64() * 1000.0;
                            println!(
                                "  \x1b[32mrecompiled\x1b[0m {} -> {} ({:.1}ms)",
                                path.display(),
                                out_file.display(),
                                ms
                            );
                        }
                        Err(e) => {
                            eprintln!("{}", e.pretty());
                        }
                    }
                }
            }
        }
    }
}

pub fn repl() -> ExitCode {
    use std::io::{self, BufRead, Write};

    println!("\x1b[36m🐉 HydraScript 0.1.0 REPL\x1b[0m");
    println!("Type HydraScript expressions or statements. Type 'exit' to quit.\n");

    let stdin = io::stdin();
    let mut handle = stdin.lock();

    loop {
        print!(">>> ");
        let _ = io::stdout().flush();
        let mut line = String::new();
        match handle.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed == "exit" || trimmed == "quit" || trimmed == "exit()" {
                    break;
                }

                // Statement first: if it compiles as-is, run it directly.
                // Otherwise wrap in print() to auto-display expression results.
                let as_stmt = format!("{}\n", trimmed);
                let to_compile = match compile(&as_stmt, "repl.hys") {
                    Ok(_) => {
                        // Check if it's a pure expression (not assignment/import/def/etc)
                        // by also trying print() — if both work, prefer print() for display
                        let as_expr = format!("print({})\n", trimmed);
                        match compile(&as_expr, "repl.hys") {
                            Ok(_) => {
                                // Both compile. Use print() only if stmt was ExprStmt
                                // (no `=` outside strings, no keywords at start)
                                let is_pure_expr = !trimmed.starts_with("import ")
                                    && !trimmed.starts_with("from ")
                                    && !trimmed.starts_with("def ")
                                    && !trimmed.starts_with("async ")
                                    && !trimmed.starts_with("for ")
                                    && !trimmed.starts_with("while ")
                                    && !trimmed.starts_with("if ")
                                    && !trimmed.starts_with("try")
                                    && !trimmed.starts_with("print(")
                                    && !trimmed.contains(" = ")
                                    && !trimmed.starts_with("export ");
                                if is_pure_expr {
                                    as_expr
                                } else {
                                    as_stmt
                                }
                            }
                            Err(_) => as_stmt,
                        }
                    }
                    Err(_) => {
                        // Not a valid statement — try as expression
                        format!("print({})\n", trimmed)
                    }
                };

                match compile(&to_compile, "repl.hys") {
                    Ok((code, _)) => {
                        let node_res = std::process::Command::new("node")
                            .arg("--input-type=module")
                            .arg("-e")
                            .arg(&code)
                            .output();
                        match node_res {
                            Ok(output) => {
                                if !output.stdout.is_empty() {
                                    print!("{}", String::from_utf8_lossy(&output.stdout));
                                }
                                if !output.stderr.is_empty() {
                                    eprint!("{}", String::from_utf8_lossy(&output.stderr));
                                }
                            }
                            Err(e) => {
                                eprintln!("node execution error: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("{}", e.pretty());
                    }
                }
            }
            Err(_) => break,
        }
    }

    ExitCode::SUCCESS
}

fn check(args: &[String]) -> ExitCode {
    let files = targets(args);
    let mut errors = 0usize;
    for path in &files {
        let Ok(src) = fs::read_to_string(path) else {
            continue;
        };
        let name = path
            .file_name()
            .map_or_else(|| "out.hyx".into(), |n| n.to_string_lossy().to_string());
        if let Err(e) = compile(&src, &name) {
            eprintln!("{}", e.pretty());
            errors += 1;
        }
    }
    if errors > 0 {
        eprintln!("\n{} error(s) found", errors);
        return ExitCode::from(1);
    }
    println!("\x1b[32mclean\x1b[0m: {} file(s) checked", files.len());
    ExitCode::SUCCESS
}
