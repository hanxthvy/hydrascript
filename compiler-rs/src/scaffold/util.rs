//! Small shared helpers: argument parsing, versions, JSON escaping, walking a tree.

use std::path::{Path, PathBuf};

use super::*;

pub(super) fn has_help(args: &[String]) -> bool {
    args.iter().any(|a| a == "--help" || a == "-h")
}

/// First positional (non-flag) argument, if any.
pub(super) fn positional(args: &[String]) -> Option<&String> {
    args.iter().find(|a| !a.starts_with('-'))
}

/// Run `program args...` and return its trimmed stdout, or `None` if the
/// program is missing, exits non-zero, or prints nothing.
pub(super) fn version_of(program: &str) -> Option<String> {
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
pub(super) fn json_escape(s: &str) -> String {
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
pub(super) fn walk(dir: &Path, visit: &mut dyn FnMut(&Path)) {
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
pub(super) fn collect_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(dir, &mut |p| out.push(p.to_path_buf()));
    out.sort();
    out
}

