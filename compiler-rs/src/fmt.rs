// [xihanzu-NR]
//! Deterministic source formatter for HydraScript (`.hyx` / `.hys`).
//!
//! This is deliberately *not* a pretty-printer: it never reindents by syntax,
//! never reflows, and never rewrites string bodies. It applies a small, fixed
//! set of whitespace normalisations that are safe to run on any source file:
//!
//!   1. line endings normalised to `\n`
//!   2. trailing whitespace stripped from every line
//!   3. leading TABs expanded to 4 spaces
//!   4. runs of 3+ blank lines collapsed to 2
//!   5. exactly one trailing newline
//!
//! The transform is idempotent: `format(format(x)) == format(x)`. (See tests.)

use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Directories never descended into when formatting a project tree.
const SKIP_DIRS: [&str; 4] = ["node_modules", "dist", ".git", "target"];

/// Default root used when no file arguments are given.
const DEFAULT_ROOT: &str = "src";

/// Entry point for `hydra fmt`.
pub fn run(args: &[String]) -> std::process::ExitCode {
    let mut check = false;
    let mut files: Vec<String> = Vec::new();

    // Tolerate a leading "fmt" token: `cli::run` in this crate is handed the
    // full argv (subcommand included), so accept either wiring.
    let args = match args.first() {
        Some(first) if first == "fmt" => &args[1..],
        _ => args,
    };

    for arg in args {
        match arg.as_str() {
            "--check" => check = true,
            "--help" | "-h" => {
                print!("{}", usage());
                return ExitCode::SUCCESS;
            }
            // A bare "-" is treated as a (nonexistent) path, not an option, so
            // the error message stays about files rather than flags.
            other if other.starts_with('-') && other != "-" => {
                eprintln!("hydra fmt: unknown option {}", other);
                eprint!("{}", usage());
                return ExitCode::from(2);
            }
            other => files.push(other.to_string()),
        }
    }

    let targets: Vec<PathBuf> = if files.is_empty() {
        let root = PathBuf::from(DEFAULT_ROOT);
        if !root.is_dir() {
            eprintln!("hydra fmt: no {} directory to format", DEFAULT_ROOT);
            return ExitCode::from(1);
        }
        let mut found = Vec::new();
        collect_sources(&root, &mut found);
        found
    } else {
        files.iter().map(PathBuf::from).collect()
    };

    let mut would_change: Vec<String> = Vec::new();
    let mut failed = false;

    for path in &targets {
        if !is_hydra_source(path) {
            eprintln!("hydra fmt: not a .hyx/.hys file: {}", path.display());
            failed = true;
            continue;
        }
        let src = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("hydra fmt: cannot read {}: {}", path.display(), e);
                failed = true;
                continue;
            }
        };
        let formatted = format_source(&src);
        if formatted == src {
            continue;
        }
        if check {
            would_change.push(path.display().to_string());
        } else if let Err(e) = std::fs::write(path, &formatted) {
            eprintln!("hydra fmt: cannot write {}: {}", path.display(), e);
            failed = true;
        }
    }

    if check {
        for path in &would_change {
            println!("would reformat: {}", path);
        }
        if !would_change.is_empty() || failed {
            return ExitCode::from(1);
        }
        println!("all files formatted correctly");
        return ExitCode::SUCCESS;
    }

    if failed {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

/// Canonical form of `src`. Total, infallible, and idempotent.
pub fn format_source(src: &str) -> String {
    let normalized = src.replace("\r\n", "\n").replace('\r', "\n");

    let mut lines: Vec<String> = Vec::new();
    let mut blank_run: usize = 0;

    for raw in normalized.split('\n') {
        // Trailing whitespace first: a whitespace-only line becomes empty and
        // is then counted as a blank line, which is what we want.
        let trimmed = raw.trim_end_matches([' ', '\t']);
        let line = expand_leading_tabs(trimmed);

        if line.is_empty() {
            blank_run += 1;
            if blank_run > 2 {
                continue;
            }
            lines.push(String::new());
        } else {
            blank_run = 0;
            lines.push(line);
        }
    }

    // Exactly one trailing newline: drop every trailing blank line, then add a
    // single '\n'. An all-whitespace input stays empty rather than growing a
    // lone newline.
    while lines.last().map_or(false, |l| l.is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        return String::new();
    }

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Expand the leading whitespace run's TABs to 4 spaces each. Tabs anywhere
/// else — including inside string literals — are left untouched.
fn expand_leading_tabs(line: &str) -> String {
    let rest = line.trim_start_matches([' ', '\t']);
    let prefix_len = line.len() - rest.len();
    let (prefix, rest) = line.split_at(prefix_len);

    if !prefix.contains('\t') {
        return line.to_string();
    }

    let mut out = String::with_capacity(line.len() + prefix.matches('\t').count() * 3);
    for ch in prefix.chars() {
        if ch == '\t' {
            out.push_str("    ");
        } else {
            out.push(ch);
        }
    }
    out.push_str(rest);
    out
}

fn is_hydra_source(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("hyx") | Some("hys")
    )
}

/// Depth-first, lexicographically ordered walk collecting `.hyx`/`.hys` files.
/// Symlinks are not followed, so a cyclic link cannot spin forever.
fn collect_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();

    for path in paths {
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if SKIP_DIRS.contains(&name) {
                continue;
            }
            collect_sources(&path, out);
        } else if meta.is_file() && is_hydra_source(&path) {
            out.push(path);
        }
    }
}

fn usage() -> String {
    "hydra fmt — deterministic formatter for .hyx / .hys source\n\
     \n\
     USAGE:\n\
     \x20 hydra fmt <file...>          rewrite files in place\n\
     \x20 hydra fmt                    format every .hyx/.hys under ./src\n\
     \x20 hydra fmt --check <file...>  list files that would change; exit 1 if any\n\
     \x20 hydra fmt --help             show this help\n\
     \n\
     Canonical form: LF endings, no trailing whitespace, leading tabs -> 4 spaces,\n\
     at most 2 consecutive blank lines, exactly one trailing newline.\n"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// `ExitCode` exposes no accessor, so compare its `Debug` rendering.
    fn same_code(a: ExitCode, b: ExitCode) -> bool {
        format!("{:?}", a) == format!("{:?}", b)
    }

    /// A fresh empty directory under `std::env::temp_dir()`. Tests never write
    /// anywhere else.
    fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!("hydra_fmt_{}_{}_{}", tag, std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn strips_trailing_whitespace() {
        assert_eq!(
            format_source("let a = 1  \nlet b = 2\t\nlet c = 3 \t \n"),
            "let a = 1\nlet b = 2\nlet c = 3\n"
        );
    }

    #[test]
    fn converts_leading_tabs_to_four_spaces() {
        assert_eq!(
            format_source("def f():\n\treturn 1\n"),
            "def f():\n    return 1\n"
        );
        assert_eq!(format_source("\t\tx\n"), "        x\n");
        // A tab after leading spaces still counts as leading whitespace.
        assert_eq!(format_source("  \ty\n"), "      y\n");
    }

    #[test]
    fn collapses_three_or_more_blank_lines() {
        assert_eq!(format_source("a\n\n\n\n\nb\n"), "a\n\n\nb\n");
        // Exactly two blank lines are already canonical.
        assert_eq!(format_source("a\n\n\nb\n"), "a\n\n\nb\n");
        // Whitespace-only lines count as blank lines.
        assert_eq!(format_source("a\n   \n\t\n \nb\n"), "a\n\n\nb\n");
    }

    #[test]
    fn ensures_exactly_one_trailing_newline() {
        assert_eq!(format_source("a"), "a\n");
        assert_eq!(format_source("a\n"), "a\n");
        assert_eq!(format_source("a\n\n\n\n"), "a\n");
        // All-whitespace input does not gain a lone newline.
        assert_eq!(format_source(""), "");
        assert_eq!(format_source("\n\n\n"), "");
    }

    #[test]
    fn normalizes_line_endings() {
        assert_eq!(format_source("a\r\nb\r\n"), "a\nb\n");
        assert_eq!(format_source("a\rb\r"), "a\nb\n");
    }

    #[test]
    fn leaves_string_bodies_and_comments_alone() {
        // Interior tab: not leading whitespace, so preserved verbatim.
        assert_eq!(format_source("let s = \"a\tb\"\n"), "let s = \"a\tb\"\n");
        // Comment text is untouched apart from trailing whitespace.
        assert_eq!(
            format_source("#  keep   inner   spacing\n"),
            "#  keep   inner   spacing\n"
        );
    }

    #[test]
    fn idempotent_on_messy_input() {
        let messy = "\r\n\tdef f():   \r\n\r\n\r\n\r\n\t\treturn \"x\"\t\r\n\r\n\r\n";
        let once = format_source(messy);
        let twice = format_source(&once);
        assert_eq!(once, twice, "formatting twice must equal formatting once");
    }

    #[test]
    fn idempotent_on_canonical_input() {
        let canonical = "component App:\n    return <div/>\n";
        assert_eq!(format_source(canonical), canonical);
        assert_eq!(format_source(&format_source(canonical)), canonical);
    }

    #[test]
    fn idempotent_across_edge_cases() {
        let cases = [
            "",
            "\n",
            "\n\n\n\n\n",
            "   ",
            "\t",
            "a",
            "a\r\n\r\n\r\n",
            "\n\na\n",
            "a\n\tb\n\t\tc\n\n\n\n\nd  \n",
            "let s = \"  \t  \"\n",
        ];
        for case in cases {
            let once = format_source(case);
            assert_eq!(
                format_source(&once),
                once,
                "not idempotent for input {:?}",
                case
            );
        }
    }

    #[test]
    fn collect_sources_respects_skip_dirs_and_extensions() {
        let dir = temp_dir("walk");
        let src = dir.join("src");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        std::fs::create_dir_all(src.join("node_modules")).unwrap();
        std::fs::create_dir_all(src.join("dist")).unwrap();
        std::fs::create_dir_all(src.join("target")).unwrap();
        std::fs::create_dir_all(src.join(".git")).unwrap();

        std::fs::write(src.join("a.hyx"), "a\n").unwrap();
        std::fs::write(src.join("b.hys"), "b\n").unwrap();
        std::fs::write(src.join("c.ts"), "c\n").unwrap();
        std::fs::write(src.join("nested").join("d.hyx"), "d\n").unwrap();
        std::fs::write(src.join("node_modules").join("e.hyx"), "e\n").unwrap();
        std::fs::write(src.join("dist").join("f.hyx"), "f\n").unwrap();
        std::fs::write(src.join("target").join("g.hyx"), "g\n").unwrap();
        std::fs::write(src.join(".git").join("h.hyx"), "h\n").unwrap();

        let mut found: Vec<PathBuf> = Vec::new();
        collect_sources(&src, &mut found);
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();

        assert_eq!(names, vec!["a.hyx", "b.hys", "d.hyx"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn accepts_optional_leading_fmt_token() {
        let dir = temp_dir("prefix");
        let file = dir.join("p.hyx");
        std::fs::write(&file, "a  \n").unwrap();
        let path = file.to_string_lossy().to_string();

        // Both `fmt --check <f>` and `--check <f>` wirings must behave alike.
        assert!(same_code(
            run(&["fmt".to_string(), "--check".to_string(), path.clone()]),
            ExitCode::from(1)
        ));
        assert!(same_code(
            run(&["--check".to_string(), path.clone()]),
            ExitCode::from(1)
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_check_write_check_end_to_end() {
        let dir = temp_dir("e2e");
        let file = dir.join("sample.hyx");
        let messy = "component App:\n\treturn <div/>   \n\n\n\n";
        std::fs::write(&file, messy).unwrap();
        let path = file.to_string_lossy().to_string();

        // 1. --check reports the file and exits non-zero, without writing.
        assert!(same_code(
            run(&["--check".to_string(), path.clone()]),
            ExitCode::from(1)
        ));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), messy);

        // 2. plain fmt rewrites it in place.
        assert!(same_code(run(&[path.clone()]), ExitCode::SUCCESS));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "component App:\n    return <div/>\n"
        );

        // 3. --check is now clean.
        assert!(same_code(
            run(&["--check".to_string(), path.clone()]),
            ExitCode::SUCCESS
        ));

        // 4. --help always succeeds.
        assert!(same_code(run(&["--help".to_string()]), ExitCode::SUCCESS));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
