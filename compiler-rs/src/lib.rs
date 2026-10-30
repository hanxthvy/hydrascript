// [xihanzu-NR]
//! HydraScript compiler library surface.
//!
//! The binary is a thin wrapper over this crate so tests (and any embedder)
//! can call the compiler in-process instead of shelling out to the binary.

pub mod ast;
pub mod cli;
pub mod emitter;
pub mod error;
pub mod fmt;
pub mod hx_target;
pub mod lexer;
pub mod napi;
pub mod parser;
pub mod scaffold;
pub mod tools;
pub mod validate;

pub use error::CompileError;

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
            let code = em.run(&module)?;
            let map = em.sourcemap(filename, src);
            // TSX: element tags make bracket counting meaningless.
            validate::check_output(&code, &em.linemap, &lines, false)?;
            Ok((code, map))
        }
        Target::Js => {
            let mut em = hx_target::JsEmitter::new();
            let code = em.run(&module)?;
            let map = em.sourcemap(filename, src);
            validate::check_output(&code, &em.linemap, &lines, true)?;
            Ok((code, map))
        }
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
