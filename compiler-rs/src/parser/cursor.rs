//! The token cursor: what is next, and how to move past it.

use crate::error::CompileError;
use crate::lexer::{TokType, Token};

use super::*;

impl Parser {
    pub fn new(toks: Vec<Token>, src: impl Into<std::sync::Arc<[String]>>) -> Self {
        Self {
            toks,
            i: 0,
            src: src.into(),
            depth: 0,
            chain: 0,
        }
    }

    /// Count one term of a left-associative chain, and refuse the chain when it
    /// gets longer than a person could mean.
    ///
    /// Called from every `while` loop that wraps the previous node in a new one.
    /// The error is a `CompileError`, so a hostile file is a diagnostic — not a
    /// dead process.
    pub(super) fn chain_step(&mut self, line: usize, col: usize) -> PResult<()> {
        self.chain += 1;
        if self.chain > MAX_CHAIN {
            return Err(CompileError::new(
                format!("expression chain is too long ({MAX_CHAIN} terms)"),
                line,
                col,
                self.src.clone(),
            )
            .with_hint("split the chain into named intermediate values"));
        }
        Ok(())
    }

    pub(super) fn enter_depth(&mut self) -> PResult<()> {
        // The limit exists so deep nesting produces a readable error instead of
        // a stack overflow. It is set below the point where the deepest parse
        // chain (expr -> ternary -> ... -> atom) actually exhausts the stack:
        // an over-high limit corrupts into SIGABRT before it ever fires, which
        // is a crash, not a diagnostic.
        if self.depth >= MAX_DEPTH {
            return Err(self
                .err(format!("maximum recursion depth exceeded ({})", MAX_DEPTH))
                .with_hint("simplify deeply nested structure"));
        }
        self.depth += 1;
        Ok(())
    }

    pub(super) fn leave_depth(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    pub(super) fn cur(&self) -> &Token {
        &self.toks[self.i]
    }

    pub(super) fn peek(&self, n: usize) -> &Token {
        self.toks
            .get(self.i + n)
            .unwrap_or_else(|| self.toks.last().unwrap())
    }

    pub(super) fn at(&self, tys: &[TokType]) -> bool {
        tys.iter().any(|t| self.cur().ty == *t)
    }

    pub(super) fn eat(&mut self, ty: TokType) -> PResult<&Token> {
        if self.cur().ty != ty {
            let t = self.cur();
            return Err(self.err(format!(
                "expected {:?}, found {:?} ({:?})",
                ty, t.ty, t.value
            )));
        }
        let t = &self.toks[self.i];
        self.i += 1;
        Ok(t)
    }

    /// Consume an operator token with a specific value (for `=` in type alias).
    pub(super) fn eat_op(&mut self, op: &str) -> PResult<()> {
        if self.cur().ty == TokType::Op && self.cur().value == op {
            self.i += 1;
            Ok(())
        } else {
            Err(self.err(format!("expected `{}`, found `{}`", op, self.cur().value)))
        }
    }

    pub(super) fn err(&self, msg: String) -> CompileError {
        let t = self.cur();
        let mut e = CompileError::new(msg, t.line, t.col, self.src.clone());
        // Span the offending token itself, not just its first column. A token is
        // the region the reader has to look at: `ComponentName` underlines whole,
        // and an editor draws the squiggle over the same characters. The token's
        // value is the source text (for a keyword or identifier), so its length
        // is the span; punctuation is one character.
        if !t.value.is_empty() {
            let width = t.value.chars().count();
            e = e.with_span(t.line, t.col + width);
        }
        e
    }

    pub(super) fn skip_newlines(&mut self) {
        while self.cur().ty == TokType::Newline {
            self.i += 1;
        }
    }

    pub(super) fn ident(&mut self) -> PResult<String> {
        Ok(self.eat(TokType::Ident)?.value.clone())
    }

    pub(super) fn ident_or_kw(&mut self) -> PResult<String> {
        if matches!(self.cur().ty, TokType::Ident | TokType::Kw(_)) {
            let s = self.cur().value.clone();
            self.i += 1;
            Ok(s)
        } else {
            self.ident()
        }
    }

    /// Skip newlines/indent/dedent tokens that appear inside a bracket pair.
    ///
    /// Python makes newlines insignificant inside `()`, `[]` and `{}`. We do the
    /// same, which is what lets a long list or a multi-line element attribute
    /// list be written across lines. `depth` tracks how many INDENTs were seen
    /// so a matching DEDENT does not terminate the enclosing block early.
    pub(super) fn skip_bracket_newlines(&mut self, depth: &mut i32) {
        loop {
            match self.cur().ty {
                TokType::Newline => self.i += 1,
                TokType::Indent => {
                    *depth += 1;
                    self.i += 1;
                }
                TokType::Dedent => {
                    if *depth == 0 {
                        return;
                    }
                    *depth -= 1;
                    self.i += 1;
                }
                _ => return,
            }
        }
    }

    // ------------------------------------------------------------ statements

    /// Skip to the start of the next top-level statement.
    ///
    /// Stops at a newline that is followed by a token at indentation zero, so a
    /// broken expression inside an indented block resumes at the enclosing
    /// statement rather than at the next line of the same block — the latter
    /// cascades one typo into an error per line.
    pub(super) fn recover_to_next_statement(&mut self) {
        while self.cur().ty != TokType::Eof {
            if self.cur().ty == TokType::Newline {
                let mut j = self.i + 1;
                while j < self.toks.len() && self.toks[j].ty == TokType::Newline {
                    j += 1;
                }
                if j >= self.toks.len() || self.toks[j].ty == TokType::Eof {
                    self.i = j.min(self.toks.len().saturating_sub(1));
                    return;
                }
                // `Indent` at the start of a line means we are still inside a
                // block; `Dedent` or a plain token means we are not.
                if self.toks[j].ty != TokType::Indent {
                    self.i = j;
                    return;
                }
            }
            self.i += 1;
        }
    }

    /// A possibly dotted name: `Base`, `foo.Bar`.
    pub(super) fn ident_or_dotted(&mut self) -> PResult<String> {
        let mut name = self.ident_or_kw()?;
        while self.cur().ty == TokType::Dot {
            self.i += 1;
            name.push('.');
            name.push_str(&self.ident_or_kw()?);
        }
        Ok(name)
    }
}
