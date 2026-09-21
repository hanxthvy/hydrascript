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
pub mod parser;

pub use error::CompileError;

/// Which output language to emit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// `.hsx` -> React TSX (components, JSX trees, prop renaming).
    React,
    /// `.hx` -> plain JavaScript (functions, scripts, no component tree).
    Js,
}

/// Pick the target from a filename's extension. `.hx` is JS; everything else
/// (including `.hsx`) is React, which keeps the default forgiving.
pub fn target_for(filename: &str) -> Target {
    if filename.ends_with(".hx") {
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
