// [xihanzu-NR]
//! Serpent compiler library surface.
//!
//! The binary is a thin wrapper over this crate so tests (and any embedder)
//! can call the compiler in-process instead of shelling out to the binary.

pub mod ast;
pub mod cli;
pub mod emitter;
pub mod error;
pub mod hx_target;
pub mod lexer;
pub mod napi;
pub mod parser;

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

/// Compile Serpent source to `(code, sourcemap_json)`.
///
/// The front end (lexer + parser) is shared; only the emitter differs by target.
/// `filename` is only used for the source map.
pub fn compile(src: &str, filename: &str) -> Result<(String, String), CompileError> {
    compile_for(src, filename, target_for(filename))
}

/// Compile for an explicit target, ignoring the filename extension.
pub fn compile_for(src: &str, filename: &str, target: Target) -> Result<(String, String), CompileError> {
    let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
    let toks = lexer::lex(src)?;
    let module = parser::Parser::new(toks, lines).module()?;
    match target {
        Target::React => {
            let mut em = emitter::Emitter::new();
            let code = em.run(&module)?;
            let map = em.sourcemap(filename, src);
            Ok((code, map))
        }
        Target::Js => {
            let mut em = hx_target::JsEmitter::new();
            let code = em.run(&module)?;
            let map = em.sourcemap(filename, src);
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
