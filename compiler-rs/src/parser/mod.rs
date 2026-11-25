// [xihanzu-NR]
//! Recursive-descent parser.
//!
//! Precedence climbing, Python's own operator precedence, and the one rule that
//! makes the tree syntax work: a `:` after an expression opens a JSX block.
//!
//! Split by what the parser is doing, not by alphabet:
//!
//!   model.rs    the Parser struct, its depth/chain guards, and PResult
//!   cursor.rs   the token cursor: what is next, and how to move past it
//!   entry.rs    module(), and recovery after a broken module
//!   stmt.rs     statements: declarations, control flow, imports, classes
//!   expr.rs     expressions: precedence climbing from ternary down to atom
//!   tests.rs    the unit tests
//!
//! The impl blocks live in those modules; Rust allows that within one module
//! tree, so nothing here is a wrapper.

mod cursor;
mod entry;
mod expr;
mod model;
mod stmt;

#[cfg(test)]
mod tests;

pub use model::Parser;

// Shared by every module here: the result alias and the two guards.
pub(crate) use model::{PResult, MAX_CHAIN, MAX_DEPTH};
