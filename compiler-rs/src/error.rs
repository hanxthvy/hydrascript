// [xihanzu-NR]
//! Compile errors that point at the source, in the style Elm and Rust taught us:
//! a span, the offending line, a caret, and a hint that teaches.

use std::fmt;
use std::sync::Arc;

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
    /// The source lines, SHARED.
    ///
    /// This was `Vec<String>`: one full copy of every line per diagnostic. The
    /// recovering lexer reports one error per bad line, so an N-line file with N
    /// bad lines owned N² strings — a 70 KB file reached 2.7 GB of RSS and a
    /// 280 KB one was OOM-killed, which makes anything compiling untrusted input
    /// (the Vite plugin, an editor LSP, CI linting a PR) a remote DoS.
    ///
    /// `Arc<[String]>` makes the copy O(1) and immutable, which is what a
    /// diagnostic needs: nothing edits source while reporting on it.
    pub src: Arc<[String]>,
    pub hint: Option<String>,
}

impl CompileError {
    pub fn new(
        msg: impl Into<String>,
        line: usize,
        col: usize,
        src: impl Into<Arc<[String]>>,
    ) -> Self {
        Self {
            msg: msg.into(),
            line,
            col,
            end_line: None,
            end_col: None,
            src: src.into(),
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
            // `col` is a BYTE offset (the lexer walks `&str` with byte indices),
            // but the caret is drawn under CHARACTERS. On a line holding any
            // multi-byte character — an emoji, CJK, an accented letter — the two
            // diverge and the caret lands left of the token it is pointing at,
            // which is worse than no caret: it accuses the wrong column. So the
            // byte column is converted to a char column first.
            let byte_col = self.col.min(s.len());
            let char_col = s
                .get(..byte_col)
                .map(|p| p.chars().count())
                .unwrap_or_else(|| s.chars().count());
            let len = self.caret_len().min(s.chars().count().saturating_sub(char_col).max(1));
            let carets = "^".repeat(len.max(1));
            o.push(format!(
                "   | {}\x1b[1;31m{}\x1b[0m",
                " ".repeat(char_col),
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
    fn caret_lands_on_the_right_character_after_multibyte_text() {
        // The lexer reports BYTE columns; the caret is drawn under CHARACTERS.
        // On a line with an emoji or CJK before the token the two diverge, and
        // the caret used to sit several columns left of the thing it named.
        let src = vec!["let x = 日本語 !!!".to_string()];
        // Byte offset of the first `!`: "let x = " is 8 bytes, 日本語 is 9, so 17.
        let err = CompileError::new("unexpected character '!'", 1, 17, src);
        let rendered = err.pretty();
        let caret_line = rendered
            .lines()
            .find(|l| l.contains('^'))
            .expect("a caret line");
        let plain = caret_line.replace("\x1b[1;31m", "").replace("\x1b[0m", "");
        // "   | " prefix, then one space per CHARACTER before the token. There
        // are 11 characters before it, not 17 bytes.
        let at = plain.find('^').expect("caret");
        assert_eq!(at, "   | ".len() + 11, "caret column: {plain:?}");
    }

    #[test]
    fn pretty_without_src_does_not_panic() {
        let err = CompileError::new("empty src", 5, 2, Vec::new());
        let rendered = err.pretty();
        assert!(rendered.contains("line 5, col 3"));
    }
}

#[cfg(test)]
mod sharing_tests {
    use super::*;

    #[test]
    fn diagnostics_share_one_source_copy() {
        // The quadratic blowup was N full copies of the file for N diagnostics.
        // Cloning a diagnostic must not copy the lines either.
        let lines: Vec<String> = (0..2000).map(|i| format!("line {i}")).collect();
        let big = lines.iter().map(|s| s.len()).sum::<usize>();
        let a = CompileError::new("one", 1, 0, lines.clone());
        let b = a.clone();
        assert_eq!(Arc::strong_count(&a.src), 2, "a clone must not copy the lines");
        // Same allocation, so no second copy of ~big bytes exists.
        assert!(std::ptr::eq(a.src.as_ptr(), b.src.as_ptr()));
        assert!(big > 0);
    }
}
