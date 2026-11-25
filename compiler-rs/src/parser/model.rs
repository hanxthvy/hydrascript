//! The parser's state.

use crate::error::CompileError;
use crate::lexer::Token;

pub struct Parser {
    pub(super) toks: Vec<Token>,
    pub(super) i: usize,
    /// Source lines, SHARED with every error this parser produces.
    ///
    /// Was `Vec<String>` cloned at each site: one full copy of the file per
    /// diagnostic. `Arc<[String]>` makes those clones pointer bumps.
    pub(super) src: std::sync::Arc<[String]>,
    pub(super) depth: usize,
    /// Terms in the expression currently being parsed.
    ///
    /// `depth` counts RECURSIVE DESCENT, and the crash it was meant to prevent
    /// came from a different shape: a left-associative chain (`a.b.b.b…`,
    /// `1+1+1…`, `f()()()…`) is parsed in a `while` loop, so the counter never
    /// leaves 1 while the tree grows one node deeper per iteration. 900 terms
    /// produced a 900-deep spine, the emitter recursed once per node, and the
    /// host process died with SIGABRT (a stack overflow inside a `panic = "abort"`
    /// cdylib linked into Node takes the editor down with it).
    pub(super) chain: usize,
}

pub(crate) type PResult<T> = Result<T, CompileError>;

/// Maximum expression nesting the parser accepts. Chosen empirically: the
/// deepest recursive chain per nesting level means a higher limit reaches a
/// real stack overflow (SIGABRT) before the guard fires.
pub(crate) const MAX_DEPTH: usize = 128;

/// Maximum terms in one left-associative chain.
///
/// Deliberately counted per TERM rather than by descent level, because that is
/// where the stack cost is: 200 is far past anything a person writes, and far
/// below the ~870 where the release build overflowed its stack.
pub(crate) const MAX_CHAIN: usize = 200;
