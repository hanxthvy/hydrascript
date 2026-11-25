//! Entry points: a whole module, or recovery after a broken one.

use crate::ast::{Kind, Node};
use crate::error::CompileError;
use crate::lexer::TokType;

use super::*;

impl Parser {
    pub fn module(&mut self) -> PResult<Node> {
        let mut body = Vec::new();
        self.skip_newlines();
        while self.cur().ty != TokType::Eof {
            body.push(self.stmt()?);
            self.skip_newlines();
        }
        Ok(Node::new(Kind::Module(body), 0, 0))
    }

    /// Parse the whole file, collecting EVERY error instead of stopping at the
    /// first.
    ///
    /// Why a second entry point rather than changing `module()`: every caller
    /// that needs a tree (the emitter, the checker, the tests) must not proceed
    /// on a half-parsed module, so they keep the fail-fast behaviour. A person
    /// editing a file and an LSP asking for diagnostics want the opposite — one
    /// run that lists ten mistakes rather than ten runs that list one each.
    ///
    /// Recovery is line-based: after an error, tokens are discarded up to the
    /// next newline at the module's own indentation, and parsing continues. That
    /// is the simplest rule that cannot loop, cannot invent a node, and matches
    /// how a person reads a file — statement by statement.
    pub fn module_recover(&mut self) -> (Option<Node>, Vec<CompileError>) {
        let mut body = Vec::new();
        let mut errors = Vec::new();
        self.skip_newlines();
        while self.cur().ty != TokType::Eof {
            let before = self.i;
            match self.stmt() {
                Ok(node) => body.push(node),
                Err(err) => {
                    errors.push(err);
                    // Guarantee progress. A parser that returns an error without
                    // consuming a token would spin forever here, and a hang in a
                    // build is worse than the error it was reporting.
                    if self.i == before {
                        self.i += 1;
                    }
                    self.recover_to_next_statement();
                }
            }
            self.skip_newlines();
        }
        let module = if errors.is_empty() {
            Some(Node::new(Kind::Module(body), 0, 0))
        } else {
            None
        };
        (module, errors)
    }
}
