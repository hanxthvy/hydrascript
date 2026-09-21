// [xihanzu-NR]
//! Compile errors that point at the source, in the style Elm and Rust taught us:
//! a span, the offending line, a caret, and a hint that teaches.

use std::fmt;

#[derive(Debug, Clone)]
pub struct CompileError {
    pub msg: String,
    pub line: usize,
    pub col: usize,
    pub src: Vec<String>,
    pub hint: Option<String>,
}

impl CompileError {
    pub fn new(msg: impl Into<String>, line: usize, col: usize, src: Vec<String>) -> Self {
        Self { msg: msg.into(), line, col, src, hint: None }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
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
            o.push(format!("   | {}\x1b[1;31m^\x1b[0m", " ".repeat(self.col)));
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
