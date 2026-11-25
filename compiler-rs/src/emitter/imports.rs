//! Import resolution: which specifier a name came from, and its parameter list.



pub(super) fn import_shapes_as_default(spec: &str, base_dir: Option<&std::path::Path>) -> bool {
    let dir = match base_dir {
        Some(d) => d,
        None => return false,
    };
    if !(spec.starts_with("./") || spec.starts_with("../")) {
        return false;
    }
    let base = dir.join(spec);
    const EXTS: &[&str] = &["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".hyx", ".hys"];
    for ext in EXTS {
        let candidate = if ext.is_empty() {
            base.clone()
        } else {
            std::path::PathBuf::from(format!("{}{}", base.display(), ext))
        };
        let source = match std::fs::read_to_string(&candidate) {
            Ok(s) => s,
            Err(_) => continue,
        };

        // If the imported candidate is a HydraScript file (.hyx/.hys/.hsx/.hs),
        // components (`component Name():`) and functions (`export def`) are always
        // emitted as named exports (`export function Name()`). They should never be
        // shaped as default imports.
        let is_hydra_source = candidate.extension().is_some_and(|e| {
            e == "hyx" || e == "hys" || e == "hsx" || e == "hs"
        });
        if is_hydra_source {
            // HydraScript files always emit named exports for components and functions.
            continue;
        }

        // Strip single-line comments so a mention of "export default" inside a comment
        // does not fool the heuristic into generating a broken default import.
        let non_comment_lines: Vec<&str> = source
            .lines()
            .map(|l| l.trim_start())
            .filter(|l| !l.starts_with("//") && !l.starts_with("#") && !l.starts_with("/*") && !l.starts_with("*"))
            .collect();
        let cleaned = non_comment_lines.join("\n");

        let has_default = cleaned.contains("export default")
            || cleaned.contains("module.exports")
            || cleaned.contains("exports.default");
        if !has_default {
            continue;
        }
        // `export { X }` / `export const X` / `export function X` / `component X` mean the named
        // import already works, and a default import would then be wrong.
        let named_hints = [
            "export {",
            "export const ",
            "export function ",
            "export class ",
            "export let ",
            "export var ",
            "component ",
        ];
        if named_hints.iter().any(|h| cleaned.contains(h)) {
            continue;
        }
        return true;
    }
    false
}

/// The parameter names of `name` defined in another HydraScript file.
///
/// Reads the source and finds `def name(a, b=1)` / `export def name(...)`.
/// Defaults are not returned: they matter for a MISSING argument, and the
/// compiler only reorders what the caller passed.
/// Is this a bare package name (`react`, `@scope/pkg`) rather than a path?
///
/// The distinction decides whether the signature can be read from disk: a
/// package's entrypoint is resolved by the bundler, not by this compiler.
fn is_package_specifier(spec: &str) -> bool {
    let s = spec.trim();
    if s.starts_with("./") || s.starts_with("../") || s.starts_with('/') {
        return false;
    }
    if s.starts_with("@scope/") || s.starts_with('@') {
        // `@scope/name` or `@scope/name/sub` — a package either way.
        return !s.contains(".h");
    }
    // No leading dot and no EXTENSION: `react`, `date-fns`. A project file
    // always carries `.hys`/`.hyx`/`.hs`/`.hsx` or a slash.
    !s.contains('/') && !s.contains(".h")
}

/// The same signature reader, for the plain-JS target.
///
/// `hx_target` compiles `.hys` files and has its own emitter with its own
/// fields; rather than duplicate a line-oriented parser (and let the two
/// disagree about what a `def` header looks like), this exposes the one that
/// already exists.
pub fn imported_fn_params_for_hx(
    spec: &str,
    name: &str,
    base_dir: Option<&std::path::Path>,
) -> Option<Vec<String>> {
    imported_fn_params(spec, name, base_dir)
}

pub(super) fn imported_fn_params(spec: &str, name: &str, base_dir: Option<&std::path::Path>) -> Option<Vec<String>> {
    let dir = base_dir?;
    // Only a RELATIVE specifier can be read back: an npm package's signature
    // lives in `node_modules` behind whatever its entrypoint does, and reading
    // it here would be guessing. That bound was always correct.
    //
    // What was WRONG was the test for "relative": it required a leading `./` or
    // `../`, and the language's own idiom is `from "lib/stats.hys" import f`
    // (no dot), which the bundler resolves fine. So keyword arguments to a
    // function imported that way were a COMPILE ERROR while the same call with
    // the same file spelled `./lib/stats.hys` worked — two answers for one
    // import, decided by punctuation nobody documents.
    //
    // Anything that is not a bare package name is a project path. A package
    // name is one identifier, optionally scoped, with no slash after it.
    if spec.trim().is_empty() || is_package_specifier(spec) {
        return None;
    }
    let base = dir.join(spec);
    // Bound what a `from "..." import` may READ — and never block on it.
    //
    // Two holes here. A specifier that climbs out of the source tree
    // (`from "../../../../etc/passwd" import x`) was read whenever it happened to
    // parse, and a device or FIFO (`from "/dev/zero" import x`) never returned:
    // the compiler was still allocating after five seconds. Neither exfiltrates
    // content — only "has export default" and parameter names reach the output —
    // but a build that hangs on a hostile file is a build that hangs.
    let Ok(base_real) = std::fs::canonicalize(dir) else {
        return None;
    };
    for ext in ["", ".hys", ".hyx", ".hs", ".hsx"] {
        let candidate = if ext.is_empty() {
            base.clone()
        } else {
            std::path::PathBuf::from(format!("{}{}", base.display(), ext))
        };
        // Canonicalize FIRST: it resolves `..` and symlinks, and it fails for a
        // path that does not exist, which is the common case here.
        let Ok(real) = std::fs::canonicalize(&candidate) else {
            continue;
        };
        if !real.starts_with(&base_real) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&real) else {
            continue;
        };
        // A regular file, and a small one: `/dev/zero` is neither.
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&real) else {
            continue;
        };
        // Line-oriented scan: a `def` header is one line, and the compiler has
        // no cross-file parser. `def name(` at any indentation, optional
        // `export`, optional `async`.
        for line in source.lines() {
            let trimmed = line.trim_start();
            let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed);
            let trimmed = trimmed.strip_prefix("async ").unwrap_or(trimmed);
            let Some(rest) = trimmed.strip_prefix("def ") else {
                continue;
            };
            let Some(open) = rest.find('(') else { continue };
            if rest[..open].trim() != name {
                continue;
            }
            let Some(close) = rest.rfind(')') else { continue };
            let inner = &rest[open + 1..close];
            let mut params = Vec::new();
            for p in inner.split(',') {
                let p = p.trim();
                if p.is_empty() {
                    continue;
                }
                // `a: int = 1` -> `a`; `*args` -> `args`.
                let head = p.split([':', '=']).next().unwrap_or(p).trim();
                let head = head.trim_start_matches('*').trim();
                if !head.is_empty() {
                    params.push(head.to_string());
                }
            }
            return Some(params);
        }
    }
    None
}

/// The parameter names of a METHOD, looked up by its bare name.
///
/// Signatures are recorded as `Class.method`. The receiver's type is not always
/// known here (`x.greet(...)` where `x` came from a call), so the lookup asks a
/// weaker question: is there exactly ONE class in this file declaring `greet`?
/// If there is, that signature is the only candidate and using it is right. If
/// two classes declare it, the answer is genuinely ambiguous and the caller
/// falls back to the plain error rather than guessing which class `x` is.
pub(super) fn method_params(
    table: &std::collections::HashMap<String, Vec<String>>,
    method: &str,
) -> Option<Vec<String>> {
    let suffix = format!(".{}", method);
    let mut found: Option<&Vec<String>> = None;
    for (key, params) in table {
        if !key.ends_with(&suffix) {
            continue;
        }
        if found.is_some() {
            return None; // ambiguous: two classes declare this name
        }
        found = Some(params);
    }
    found.cloned()
}
