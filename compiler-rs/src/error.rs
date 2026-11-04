// [xihanzu-NR]
//! Compile errors that point at the source, in the style Elm and Rust taught us:
//! a span, the offending line, a caret, and a hint that teaches.

use std::fmt;

#[derive(Debug, Clone)]
pub struct CompileError {
    pub msg: String,
    pub line: usize,
    pub col: usize,
    /// End of the offending region, when it is longer than one character.
    ///
    /// `None` means "the caret is one column", which is what every error before
    /// this had. A span makes the caret underline the whole token or expression:
    /// an editor draws a squiggle under `foo.bar(` rather than under its first
    /// character, and a person reading a terminal sees which part is wrong
    /// without counting columns.
    pub end_line: Option<usize>,
    pub end_col: Option<usize>,
    pub src: Vec<String>,
    pub hint: Option<String>,
}

impl CompileError {
    pub fn new(msg: impl Into<String>, line: usize, col: usize, src: Vec<String>) -> Self {
        Self {
            msg: msg.into(),
            line,
            col,
            end_line: None,
            end_col: None,
            src,
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Give this error a span. Cheap to call and chainable, so a call site that
    /// knows more about the region can say so without restructuring.
    pub fn with_span(mut self, end_line: usize, end_col: usize) -> Self {
        // A span that ends before it starts is a bug at the call site, and a
        // negative-length underline renders as a caret pointing past the line.
        // Drop it rather than draw something wrong.
        if end_line > self.line || (end_line == self.line && end_col > self.col) {
            self.end_line = Some(end_line);
            self.end_col = Some(end_col);
        }
        self
    }

    /// The length of the caret line for the FIRST line of the span.
    fn caret_len(&self) -> usize {
        match (self.end_line, self.end_col) {
            (Some(el), Some(ec)) if el == self.line => ec.saturating_sub(self.col).max(1),
            // A multi-line span underlines to the end of the first line; drawing
            // an underline that wraps would need a second line of carets, and
            // the message already names the region.
            (Some(el), _) if el > self.line => usize::MAX,
            _ => 1,
        }
    }

    /// Human-facing rendering with ANSI colour, ready for a terminal or a
    /// Vite error overlay (which strips the codes).
    pub fn pretty(&self) -> String {
        let mut o = vec![
            format!("\x1b[1;31merror\x1b[0m: {}", self.msg),
            format!("  --> line {}, col {}", self.line, self.col + 1),
        ];
        if self.line > 0 && self.line <= self.src.len() {
            let s = &self.src[self.line - 1];
            o.push("   |".to_string());
            o.push(format!("{:2} | {}", self.line, s));
            // The caret covers the span when there is one, and one column when
            // there is not. Clamped to the line so a span that overshoots (a
            // token at the end of a line, say) cannot paint past it.
            let len = self.caret_len().min(s.chars().count().saturating_sub(self.col).max(1));
            let carets = "^".repeat(len.max(1));
            o.push(format!(
                "   | {}\x1b[1;31m{}\x1b[0m",
                " ".repeat(self.col),
                carets
            ));
        }
        if let Some(h) = &self.hint {
            o.push(format!("   = \x1b[1;36mhint\x1b[0m: {}", h));
        }
        o.join("\n")
    }
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.pretty())
    }
}

impl std::error::Error for CompileError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pretty_renders_caret_and_source_line() {
        let src = vec![
            "component A():".to_string(),
            "    div:".to_string(),
            "        x = ~~~".to_string(),
        ];
        let err = CompileError::new("unexpected character '~'", 3, 12, src)
            .with_hint("check for stray operator");
        let rendered = err.pretty();
        assert!(rendered.contains("unexpected character '~'"));
        assert!(rendered.contains("line 3, col 13"));
        assert!(rendered.contains("3 |         x = ~~~"));
        assert!(rendered.contains("^"));
        assert!(rendered.contains("hint"));
        assert!(rendered.contains("check for stray operator"));
    }

    #[test]
    fn display_matches_pretty() {
        let err = CompileError::new("bad token", 1, 0, vec!["bogus".to_string()]);
        assert_eq!(format!("{}", err), err.pretty());
    }

    #[test]
    fn pretty_without_src_does_not_panic() {
        let err = CompileError::new("empty src", 5, 2, Vec::new());
        let rendered = err.pretty();
        assert!(rendered.contains("line 5, col 3"));
    }
}
