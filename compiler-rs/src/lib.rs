// [xihanzu-NR]
//! HydraScript compiler library surface.
//!
//! The binary is a thin wrapper over this crate so tests (and any embedder)
//! can call the compiler in-process instead of shelling out to the binary.

pub mod ast;

/// Tables derived at build time from files that are the single source of truth.
pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/runtime_helpers.rs"));
}
pub mod check;
pub mod dts;
pub mod cli;
pub mod emitter;
pub mod error;
pub mod fmt;
pub mod fstr;
pub mod hx_target;
pub mod lexer;
// The Node-API binding is an ADDON, not part of the CLI.
//
// Its symbols are `extern "C"` imports that the host process resolves when Node
// loads the shared library. A Linux `cdylib` tolerates them being undefined; the
// macOS and Windows linkers do not, which is why `binaries.yml` built linux-x64
// and died on every darwin and win32 job with
// `Undefined symbols: _napi_create_function`.
//
// `hydra_node` names the addon build. Cargo has no "this is a cdylib target"
// cfg, so it is set explicitly (see the `[features]` note in Cargo.toml) and
// the platform workflow builds the addon with it. The CLI never calls into this
// module, so leaving it out of the binary is the correct shape, not a workaround.
#[cfg(feature = "node-addon")]
pub mod napi;
pub mod parser;
pub mod scaffold;
pub mod tools;
pub mod validate;

pub use check::Warning;
pub use error::CompileError;

/// Parse a source and run the semantic checks, without emitting.
///
/// Parsing twice (once here, once for the emit) is deliberate: it keeps
/// `compile_for` — which every target, the CLI, the napi binding and the tests
/// go through — untouched, so a warning can never change what the compiler
/// produces. Warnings are advisory by construction.
pub fn check_source(src: &str) -> Result<Vec<Warning>, CompileError> {
    let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
    let toks = lexer::lex(src)?;
    let module = parser::Parser::new(toks, lines).module()?;
    Ok(check::check(&module))
}

/// `compile`, plus the semantic warnings for the same source.
pub fn compile_checked(
    src: &str,
    filename: &str,
) -> Result<(String, String, Vec<Warning>), CompileError> {
    let (code, map) = compile(src, filename)?;
    let warnings = check_source(src)?;
    Ok((code, map, warnings))
}

/// Parse-only pass that reports EVERY syntax error in the file.
///
/// `compile` stops at the first one, which is right for a build and wrong for a
/// person: fixing ten typos one rebuild at a time is the single most complained
/// about property of a small compiler. This runs the recovering parser and
/// returns all of them, in source order.
///
/// It does not emit, and it does not type-check: a file with a syntax error has
/// no tree to check, so anything below that would be a second opinion about
/// code that does not exist yet.
pub fn parse_errors(src: &str) -> Vec<CompileError> {
    let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
    // Lex with recovery FIRST: a file with two unterminated strings used to
    // report one, and the second only appeared after fixing the first. Skipped
    // lines contribute no tokens, so the parser below sees fewer statements than
    // the file has — the lex errors say which lines, and both lists are returned
    // together so nothing is silently lost.
    let (toks, mut errors) = lexer::lex_collect(src);
    let had_lex_error = !errors.is_empty();
    let (_, parse_errs) = parser::Parser::new(toks, lines).module_recover();
    errors.extend(parse_errs);
    // Source order, so a reader fixing them top-down does one pass.
    errors.sort_by_key(|e| (e.line, e.col));

    // Drop the cascade.
    //
    // A line that could not be tokenised produces a SECOND error from the parser
    // — `unexpected Newline` where the missing token would have been. Reporting
    // both doubles the count, and the second one is never actionable: the line is
    // already named by the first. The rule: on a line that had a lexer error, a
    // parser error is a symptom, not a finding.
    // A HashSet, not a Vec: `lex_lines.contains(&line)` inside the `retain` below
    // turned this into O(n²) on a file with thousands of bad lines, which is the
    // same input that made the diagnostics expensive in the first place.
    let lex_lines: std::collections::HashSet<usize> = errors
        .iter()
        .filter(|e| {
            e.msg.contains("unterminated")
                || e.msg.starts_with("unexpected character")
                || e.msg.contains("indentation")
        })
        .map(|e| e.line)
        .collect();
    // `unexpected Dedent` / `unexpected Eof` are always the END of a failure the
    // parser has already reported: the expression it was waiting for ran out of
    // block. Keeping them doubles every truncated-line error with a second one
    // that points at an empty line.
    errors.retain(|e| {
        !(e.msg.starts_with("unexpected Dedent") || e.msg.starts_with("unexpected Eof"))
    });

    if had_lex_error && !lex_lines.is_empty() {
        errors.retain(|e| {
            let is_lex = e.msg.contains("unterminated")
                || e.msg.starts_with("unexpected character")
                || e.msg.contains("indentation");
            // Keep a parser error only on a line the lexer did NOT already fail
            // on — that one is a real second problem.
            is_lex || !lex_lines.contains(&e.line)
        });
    }

    // Cap what is RETAINED.
    //
    // Past a few hundred lines the list stops being advice and becomes output: no
    // one fixes 4 000 diagnostics, an editor renders the first screen, and the
    // cost of holding them all is what made a 70 KB file cost gigabytes. The
    // sentinel keeps the count visible so nothing is silently dropped.
    const MAX_REPORTED: usize = 100;
    if errors.len() > MAX_REPORTED {
        let dropped = errors.len() - MAX_REPORTED;
        errors.truncate(MAX_REPORTED);
        let line = errors.last().map_or(0, |e| e.line);
        errors.push(
            CompileError::new(
                format!("…and {} more error(s); fix these and run again", dropped),
                line,
                0,
                errors
                    .first()
                    .map(|e| e.src.clone())
                    .unwrap_or_else(|| std::sync::Arc::from(Vec::<String>::new())),
            )
            .with_hint("a file with this many errors is usually generated, not typed"),
        );
    }
    errors
}

/// Which output language to emit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// `.hyx` / `.hsx` -> React TSX (components, JSX trees, prop renaming).
    React,
    /// `.hys` / `.hs` / `.hx` -> plain JavaScript (functions, scripts, no component tree).
    Js,
}

/// Pick the target from a filename's extension.
/// `.hys`, `.hs`, and `.hx` compile to plain JS.
/// `.hyx` and `.hsx` compile to React TSX.
/// Everything else defaults to React for backwards compatibility.
pub fn target_for(filename: &str) -> Target {
    if filename.ends_with(".hys") || filename.ends_with(".hs") || filename.ends_with(".hx") {
        Target::Js
    } else {
        Target::React
    }
}

/// Compile HydraScript source to `(code, sourcemap_json)`.
///
/// The front end (lexer + parser) is shared; only the emitter differs by target.
/// `filename` is only used for the source map.
pub fn compile(src: &str, filename: &str) -> Result<(String, String), CompileError> {
    compile_for(src, filename, target_for(filename))
}

/// TypeScript declarations for a module, as the text of a `.d.ts` file.
///
/// Returns an empty string when the module exports nothing worth declaring, so a
/// caller can decide not to write a file at all rather than clobbering a
/// hand-written one. Like the checker, this re-parses: it does not borrow the
/// emitter's state, so it cannot change what is emitted.
pub fn compile_dts(src: &str, filename: &str) -> Result<String, CompileError> {
    let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
    let toks = lexer::lex(src)?;
    let module = parser::Parser::new(toks, lines).module()?;
    dts::emit(&module, filename)
}

/// Compile for an explicit target, ignoring the filename extension.
pub fn compile_for(
    src: &str,
    filename: &str,
    target: Target,
) -> Result<(String, String), CompileError> {
    let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
    let toks = lexer::lex(src)?;
    let module = parser::Parser::new(toks, lines).module()?;
    // Every emit is sanity-checked before it leaves the compiler. Checking here
    // rather than in the CLI means the Vite plugin, `run`, the REPL and the
    // napi binding all get the protection — the failure mode this guards
    // against (a build that reports success on unparseable output) was only
    // reachable through `hydra build` when the check lived in the CLI.
    let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
    match target {
        Target::React => {
            let mut em = emitter::Emitter::new();
            // Relative imports are resolved against the file's own directory so
            // the emitter can emit a default import for a component that only
            // default-exports. Without it, every such component failed the
            // build with `No matching export`. `filename` may be a bare name
            // (`-`) when compiling from stdin; then there is nothing to resolve
            // against and the named form is used, as before.
            let parent = std::path::Path::new(filename).parent();
            let dir = match parent {
                Some(d) if !d.as_os_str().is_empty() => Some(d.to_path_buf()),
                // A bare filename means "the file the CLI was pointed at in the
                // working directory", which is how `hydra App.hyx` arrives here.
                _ if filename != "-" && !filename.is_empty() => {
                    std::env::current_dir().ok()
                }
                _ => None,
            };
            if let Some(d) = dir {
                em = em.with_base_dir(d);
            }
            // The dev-time refresh boundary is compiled AWAY for a release build.
            // A production bundle should be a plain function per component; the
            // indirection exists only so a dev server can keep hook state across
            // an edit. `HYDRA_DEV=1` is what `hydra dev` sets.
            em.refresh_boundary = std::env::var("HYDRA_DEV").as_deref() == Ok("1");
            let code = em.run(&module)?;
            let map = em.sourcemap(filename, src);
            // TSX: element tags make bracket counting meaningless.
            validate::check_output(&code, &em.linemap, &lines, false)?;
            Ok((code, map))
        }
        Target::Js => {
            let mut em = hx_target::JsEmitter::new();
            // Same base directory rule as the React target: a relative
            // specifier is resolved against the file being compiled, which is
            // what lets a keyword argument be checked against the imported
            // function's real signature.
            let parent = std::path::Path::new(filename).parent();
            let hx_dir = match parent {
                Some(d) if !d.as_os_str().is_empty() => Some(d.to_path_buf()),
                _ if filename != "-" && !filename.is_empty() => std::env::current_dir().ok(),
                _ => None,
            };
            if let Some(d) = hx_dir {
                em = em.with_base_dir(d);
            }
            let code = em.run(&module)?;
            let map = em.sourcemap(filename, src);
            validate::check_output(&code, &em.linemap, &lines, true)?;
            Ok((code, map))
        }
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    /// Three separate problems on three lines must all be reported by one call.
    /// The alternative — one per run — is what made "fix, rebuild, fix, rebuild"
    /// the normal way to use this compiler.
    #[test]
    fn reports_every_broken_line_not_just_the_first() {
        let src = "a = \"unclosed\nb = 1\nc = \"also unclosed\n";
        let errs = parse_errors(src);
        let lines: Vec<usize> = errs.iter().map(|e| e.line).collect();
        assert!(lines.contains(&1), "line 1 not reported: {lines:?}");
        assert!(lines.contains(&3), "line 3 not reported: {lines:?}");
    }

    /// A truncated line produces ONE error, not a pair: the parser's follow-up
    /// (`unexpected Dedent`) is the end of the same failure and points at an
    /// empty line.
    #[test]
    fn a_truncated_line_does_not_double_report() {
        let src = "component A():\n    return 1 +\n";
        let errs = parse_errors(src);
        assert_eq!(errs.len(), 1, "expected one finding, got {:?}", errs.iter().map(|e| (&e.msg, e.line)).collect::<Vec<_>>());
        assert!(errs[0].msg.contains("Newline") || errs[0].msg.contains("expression"));
    }

    /// A lexer error is not duplicated by the parser error it causes on the SAME
    /// line; a parser error on a DIFFERENT line is a real second finding and is
    /// kept.
    #[test]
    fn a_lex_error_suppresses_only_its_own_line() {
        let src = "a = \"unclosed\nb = (1\n";
        let errs = parse_errors(src);
        let line1: Vec<_> = errs.iter().filter(|e| e.line == 1).collect();
        assert_eq!(line1.len(), 1, "line 1 reported {} times", line1.len());
        assert!(
            errs.iter().any(|e| e.line >= 2),
            "the second, unrelated problem was swallowed: {:?}",
            errs.iter().map(|e| (e.line, &e.msg)).collect::<Vec<_>>(),
        );
        let _ = src;
    }

    /// A caret covers the offending token, not one column of it.
    #[test]
    fn an_error_spans_its_token() {
        let e = CompileError::new("bad", 1, 4, vec!["    NotAToken here".into()]).with_span(1, 13);
        let pretty = e.pretty();
        let caret_line = pretty.lines().find(|l| l.contains('^')).expect("no caret line");
        let carets = caret_line.matches('^').count();
        assert_eq!(carets, 9, "expected a 9-character span, got {carets}: {caret_line}");
    }

    /// A span that ends before it starts is dropped rather than drawn wrong.
    #[test]
    fn a_backwards_span_is_not_drawn() {
        let e = CompileError::new("bad", 2, 8, vec!["".into(), "        x".into()]).with_span(2, 3);
        assert!(e.end_col.is_none(), "a backwards span was accepted");
    }
}

#[cfg(test)]
mod target_tests {
    use super::*;

    #[test]
    fn test_target_for_extensions() {
        assert_eq!(target_for("app.hyx"), Target::React);
        assert_eq!(target_for("app.hsx"), Target::React);
        assert_eq!(target_for("logic.hys"), Target::Js);
        assert_eq!(target_for("logic.hs"), Target::Js);
        assert_eq!(target_for("logic.hx"), Target::Js);
        assert_eq!(target_for("fallback.txt"), Target::React);
    }
}

#[cfg(test)]
mod diagnostic_cost_tests {
    use super::*;

    /// SEC-10: N bad lines must cost O(N), not O(N²).
    ///
    /// Each diagnostic used to own a full copy of every line, so a 5 000-line file
    /// with 5 000 bad lines held 25 million strings — 2.7 GB of RSS from 70 KB of
    /// input, and an OOM kill at 280 KB. This asserts the behaviour, not the
    /// allocation: bounded output, bounded time, and every message still sharing
    /// one source copy.
    #[test]
    fn an_error_heavy_file_is_capped_and_shares_its_source() {
        let src = (0..2000).map(|i| format!("\u{00a5} bad {i}")).collect::<Vec<_>>().join("\n");
        let errs = parse_errors(&src);
        // The cap, plus the sentinel that says how many were dropped.
        assert!(errs.len() <= 101, "{} diagnostics escaped the cap", errs.len());
        assert!(
            errs.last().unwrap().msg.contains("more error"),
            "no sentinel: {:?}",
            errs.last().map(|e| &e.msg)
        );
        // One allocation of source lines for the whole list.
        let first = errs.first().unwrap().src.as_ptr();
        assert!(
            errs.iter().all(|e| e.src.as_ptr() == first),
            "diagnostics copied the source instead of sharing it"
        );
    }

    /// The same input must not take seconds. A generous bound: the point is that
    /// it is linear, and a quadratic regression blows past this immediately.
    #[test]
    fn an_error_heavy_file_is_parsed_quickly() {
        let src = (0..4000).map(|i| format!("\u{00a5} bad {i}")).collect::<Vec<_>>().join("\n");
        let start = std::time::Instant::now();
        let errs = parse_errors(&src);
        let took = start.elapsed();
        assert!(!errs.is_empty());
        assert!(took.as_millis() < 500, "4000 bad lines took {took:?}");
    }
}
