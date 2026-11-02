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
use crate::check_source;

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

/// `hydra routes` reads the pages directory, which is project state rather than
/// compiler state, so it belongs to the runner even in a project without a
/// hydraconfig — the folder layout alone is enough to answer.
pub fn routes_cmd(args: &[String]) -> ExitCode {
    spawn_runner("routes", args)
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
        // `run` goes to the Node runner, not to this binary.
        //
        // This used to compile the script and pipe the JS to `node -`, which
        // cannot resolve the `hydra` specifier the compiler emits
        // (`import { raise_ } from 'hydra'`). The result was
        // `ERR_MODULE_NOT_FOUND: Cannot find package 'hydra'` for any script
        // that used a runtime helper, while the README documents doing exactly
        // that. The runner bundles the script with the same resolver the build
        // uses, so there is one resolver and not two.
        Some("run") => forward_to_runner(&args[1..]),
        Some("dev") => dev_cmd(&args[1..]),
        Some("build") => build_cmd(&args[1..]),
        Some("routes") => routes_cmd(&args[1..]),
        Some("preview") => preview_cmd(&args[1..]),
        Some("watch") => watch(&args[1..]),
        Some("check") => check(&args[1..]),
        Some("types") => types_cmd(&args[1..]),
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
                "try: hydra dev | build | preview | routes | run | watch | repl | check | types | init | --help"
            );
            ExitCode::from(2)
        }
        None => repl(),
    }
}

/// Hand a subcommand to `packages/cli/runner.mjs`, which owns the bundler.
///
/// `HYDRA_RUNNER` points at it; without that the binary looks beside itself,
/// which is how the npm package ships (bin/hydra + packages/cli/runner.mjs).
pub fn forward_to_runner(args: &[String]) -> ExitCode {
    let runner = std::env::var("HYDRA_RUNNER")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            let exe = std::env::current_exe().ok()?;
            let root = exe.parent()?.parent()?;
            let candidate = root.join("packages").join("cli").join("runner.mjs");
            candidate.exists().then_some(candidate)
        });
    let Some(runner) = runner else {
        eprintln!(
            "hydra: cannot find the Node runner (packages/cli/runner.mjs). \
             Set HYDRA_RUNNER to its path."
        );
        return ExitCode::from(1);
    };
    let status = std::process::Command::new("node")
        .arg(&runner)
        .arg("run")
        .args(args)
        .status();
    match status {
        Ok(s) => ExitCode::from(s.code().unwrap_or(1) as u8),
        Err(e) => {
            eprintln!("hydra: could not start node: {e}");
            ExitCode::from(1)
        }
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

    // `Path::parent` of a bare filename ("script.hys") is `Some("")`, not
    // `None`, and spawning a child with an empty `current_dir` fails with
    // ENOENT — which surfaced as "neither node nor bun runtime found" even
    // though node was installed. Normalise to "." so `hydra run script.hys`
    // works from the directory holding the file.
    let parent_dir: PathBuf = match file_arg.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let spawn_dir = parent_dir.clone();

    let use_bun = code.contains("bun:")
        || code.contains("Bun.")
        || std::env::var("HYDRA_RUNTIME").as_deref() == Ok("bun")
        || std::env::var("npm_config_user_agent").map_or(false, |s| s.contains("bun"));

    let spawn_bun = || {
        std::process::Command::new("bun")
            .current_dir(spawn_dir.clone())
            .arg("-")
            .args(script_args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()
    };

    let spawn_node = || {
        std::process::Command::new("node")
            .current_dir(spawn_dir.clone())
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
    // A DIRECTORY argument used to be read as a file: `hydra check examples/blog/src`
    // said "clean: 1 file(s) checked" because `fs::read_to_string` on a directory
    // fails and the loop just skipped it. Expanding directories here is what makes
    // "check the whole source" mean what it says.
    let mut files: Vec<PathBuf> = Vec::new();
    for a in args.iter().filter(|a| !a.starts_with('-')) {
        let p = PathBuf::from(a);
        if p.is_dir() {
            let mut found = Vec::new();
            for ext in &["hyx", "hys", "hsx", "hs", "hx"] {
                collect(&p, ext, &mut found);
            }
            found.sort();
            files.extend(found);
        } else {
            files.push(p);
        }
    }
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

/// Check ONE source text, printing what it finds in either shape.
///
/// Shared by the file loop and the stdin path so `hydra check -` cannot drift
/// from `hydra check file` — the same class of bug that made `hydra routes`
/// print something different from what the build used.
fn check_source_text(src: &str, name: &str, as_json: bool, strict: bool) -> ExitCode {
    let mut errors = 0usize;
    let warnings: Vec<crate::Warning> = match compile(src, name) {
        Ok(_) => match check_source(src) {
            Ok(ws) => ws,
            Err(e) => {
                if as_json {
                    println!("{}", diagnostic_json(&e, name, "error"));
                } else {
                    eprintln!("{}\n{}", name, e.pretty());
                }
                errors += 1;
                Vec::new()
            }
        },
        Err(e) => {
            if as_json {
                println!("{}", diagnostic_json(&e, name, "error"));
            } else {
                eprintln!("{}\n{}", name, e.pretty());
            }
            errors += 1;
            Vec::new()
        }
    };
    if as_json {
        for w in &warnings {
            println!("{}", warning_json(w, name));
        }
    } else {
        for w in &warnings {
            eprintln!("{}", w.render(name));
        }
    }
    if errors > 0 {
        if !as_json {
            eprintln!("\n{errors} error(s) found");
        }
        return ExitCode::from(1);
    }
    if strict && !warnings.is_empty() {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

/// One diagnostic as JSON.
///
/// Hand-built rather than via a JSON crate: the compiler has no serde
/// dependency and adding one for four fields is not worth a build-time and
/// dependency-surface cost. `escape_json` is a real escaper (quotes, backslash,
/// control characters), so a message containing a quote — an error about a
/// string literal, which is most of them — does not produce invalid JSON.
///
/// `line`/`col` are 1-based, as the compiler reports them. The language server
/// converts to LSP's 0-based positions, in one place.
fn diagnostic_json(e: &crate::CompileError, file: &str, severity: &str) -> String {
    format!(
        "{{\"file\":{},\"line\":{},\"col\":{},\"severity\":{},\"message\":{}}}",
        escape_json(file),
        e.line,
        e.col,
        escape_json(severity),
        escape_json(&e.msg)
    )
}

fn warning_json(w: &crate::Warning, file: &str) -> String {
    format!(
        "{{\"file\":{},\"line\":{},\"col\":{},\"severity\":\"warning\",\"message\":{}}}",
        escape_json(file),
        w.line,
        w.col,
        escape_json(&w.message)
    )
}

/// A JSON string literal, escapes included.
fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn check(args: &[String]) -> ExitCode {
    // `--json` — one JSON object per finding, on stdout.
    //
    // For the language server, which must publish the COMPILER's diagnostics and
    // not a second opinion: a server that disagrees with the build teaches a
    // developer to trust neither. Machine-readable output belongs on this
    // command rather than in a parser for the coloured human one.
    let as_json = args.iter().any(|a| a == "--json");
    // `hydra check -` reads the source from stdin, which is what an editor has
    // (an unsaved buffer) and a file path cannot express.
    let from_stdin = args.iter().any(|a| a == "-");
    if from_stdin {
        let mut src = String::new();
        if std::io::Read::read_to_string(&mut std::io::stdin(), &mut src).is_err() {
            eprintln!("hydra: could not read stdin");
            return ExitCode::from(1);
        }
        return check_source_text(&src, "<stdin>", as_json, false);
    }
    let files = targets(args);
    // `--strict` promotes the semantic warnings to a failure. The default stays
    // advisory: a build with a warning still produces the right bundle, and a
    // style finding should not red someone's CI.
    //
    // The build uses this. A name the compiler cannot bind (`any`, `getattr`,
    // `setattr`, `frozenset`) compiles to a call to something that does not
    // exist, and the runtime gate only notices if the render happens to run that
    // line — put it in an event handler and the crash ships. Since that warning
    // is the only warning the gate cannot be trusted to give, it has to be able
    // to stop a build.
    let strict = args.iter().any(|a| a == "--strict")
        || std::env::var("HYDRA_STRICT").is_ok_and(|v| v != "0");
    // `targets` already drops anything starting with `-`, so `--strict` is not
    // in this list.
    let paths: Vec<&PathBuf> = files.iter().collect();
    let mut errors = 0usize;
    let mut warnings = 0usize;
    for path in &paths {
        let Ok(src) = fs::read_to_string(path) else {
            continue;
        };
        let name = path
            .file_name()
            .map_or_else(|| "out.hyx".into(), |n| n.to_string_lossy().to_string());
        if let Err(e) = compile(&src, &name) {
            // Name the FILE. The compiler is handed one file at a time and its
            // spans are relative to that file, so `line 4, col 1` alone is not
            // actionable: a project with 200 pages printed a caret and no way to
            // find which one it belonged to. `check` already knew the path — it
            // was only used for warnings.
            eprintln!("\x1b[1;31m{}\x1b[0m", path.display());
            eprintln!("{}", e.pretty());
            errors += 1;
            continue;
        }
        // Semantic findings, on the same command: `hydra check` is the one
        // place a reader expects "is this file sane?" to be answered.
        match check_source(&src) {
            Ok(ws) => {
                for w in &ws {
                    eprintln!("{}", w.render(&path.to_string_lossy()));
                }
                warnings += ws.len();
            }
            Err(e) => {
                eprintln!("\x1b[1;31m{}\x1b[0m", path.display());
                eprintln!("{}", e.pretty());
                errors += 1;
            }
        }
    }
    if errors > 0 {
        eprintln!("\n{} error(s) found", errors);
        return ExitCode::from(1);
    }
    if warnings > 0 {
        if strict {
            eprintln!(
                "\n{} warning(s), and --strict is on: these are names no runtime \
                 provides, so the build would ship a crash",
                warnings
            );
            return ExitCode::from(1);
        }
        // Warnings never change the exit code: a build with warnings still
        // produces the right bundle, and CI should not red on a style finding.
        println!(
            "\x1b[32mclean\x1b[0m: {} file(s) checked, \x1b[33m{} warning(s)\x1b[0m",
            paths.len(),
            warnings
        );
    } else {
        println!("\x1b[32mclean\x1b[0m: {} file(s) checked", paths.len());
    }
    ExitCode::SUCCESS
}

/// `hydra types` — write TypeScript declarations next to the sources.
///
/// This is what makes a `.hyx` module visible to `tsc`. Without it TypeScript
/// reports `TS2307: Cannot find module './Widget.hyx' or its corresponding type
/// declarations`, and the only alternatives are an error or a `declare module
/// '*.hyx'` shim that turns every import into `any` and silently removes type
/// checking exactly where a TS user needs it.
///
/// The file is written as `<source>.d.ts` — that is, `Widget.hyx.d.ts`. That
/// exact name is what TypeScript looks for next to `Widget.hyx`; a sibling
/// `Widget.d.ts` would be ignored.
///
/// A module with no exports produces no file, so a hand-written declaration is
/// never overwritten with an empty one.
pub fn types_cmd(args: &[String]) -> ExitCode {
    let files = targets(args);
    if files.is_empty() {
        eprintln!("hydra types: no source files found");
        return ExitCode::from(1);
    }
    let mut written = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    for path in &files {
        let Ok(src) = fs::read_to_string(path) else {
            continue;
        };
        let name = path
            .file_name()
            .map_or_else(|| "out.hyx".into(), |n| n.to_string_lossy().to_string());
        match crate::compile_dts(&src, &name) {
            Ok(dts) if dts.is_empty() => skipped += 1,
            Ok(dts) => {
                let out = PathBuf::from(format!("{}.d.ts", path.to_string_lossy()));
                match fs::write(&out, dts) {
                    Ok(()) => written += 1,
                    Err(e) => {
                        eprintln!("hydra types: cannot write {}: {}", out.display(), e);
                        failed += 1;
                    }
                }
            }
            Err(e) => {
                eprintln!("{}", e.pretty());
                failed += 1;
            }
        }
    }
    if failed > 0 {
        eprintln!("\n{} file(s) failed to produce declarations", failed);
        return ExitCode::from(1);
    }
    println!(
        "\x1b[32mwrote\x1b[0m {} declaration(s), skipped {} (no exports)",
        written, skipped
    );
    ExitCode::SUCCESS
}
