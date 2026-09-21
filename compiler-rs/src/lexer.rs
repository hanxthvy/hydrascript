// [xihanzu-NR]
//! Tokenizer for the Serpent language.
//!
//! Two jobs the AST-level tools cannot do: significant indentation, and
//! knowing where a token started so errors can point at it.

use crate::error::CompileError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokType {
    Ident,
    Number,
    String,
    FString,
    Kw(&'static str),
    Op,
    Arrow,
    Colon,
    Comma,
    Dot,
    LParen,
    RParen,
    LBrack,
    RBrack,
    LBrace,
    RBrace,
    Newline,
    Indent,
    Dedent,
    Eof,
}

#[derive(Debug, Clone)]
pub struct Token {
    pub ty: TokType,
    pub value: String,
    pub line: usize,
    pub col: usize,
}

pub const KEYWORDS: &[&str] = &[
    "component", "if", "elif", "else", "for", "in", "def", "return", "import", "from", "as",
    "and", "or", "not", "True", "False", "None", "lambda",
    // Statement keywords used by the .hx (plain JS) target. Kept in the shared
    // lexer because a keyword is a lexical concept, not a target one — the
    // parser decides whether a construct is legal for the target.
    // while, break, continue, pass, try, except, finally, raise,
    // async, await, export, with, match, case.
    "while", "break", "continue", "pass", "try", "except", "finally", "raise",
    "async", "await", "export", "with", "match", "case",
];

fn keyword(s: &str) -> Option<&'static str> {
    KEYWORDS.iter().find(|k| **k == s).copied()
}

fn is_ident_start(c: char) -> bool {
    // Python identifiers are unicode: `café = 1` is legal, and JS agrees, so
    // there is nothing to translate — pass the letter through.
    c.is_alphabetic() || c == '_'
}

fn is_ident_cont(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Read a quoted string starting at `i` (which must point at the quote or `f`).
/// Returns the end index (exclusive) of the raw slice including quotes, or
/// `None` when the quote is never closed.
fn scan_string(bytes: &[u8], mut i: usize) -> Option<usize> {
    if bytes[i] == b'f' {
        i += 1;
    }
    let quote = bytes[i];
    i += 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            c if c == quote => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

pub fn lex(src: &str) -> Result<Vec<Token>, CompileError> {
    let lines: Vec<&str> = src.split('\n').collect();
    let mut out: Vec<Token> = Vec::new();
    let mut stack: Vec<usize> = vec![0];

    for (idx, raw) in lines.iter().enumerate() {
        let line_no = idx + 1;
        // CRLF sources: the `\r` is line-ending punctuation, not source text.
        // Without this a file saved on Windows dies on `unexpected character '\r'`.
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let leading_ws_len = raw.len() - raw.trim_start_matches(|c: char| c == ' ' || c == '\t').len();
        let leading_ws = &raw[..leading_ws_len];
        if let Some(tab_pos) = leading_ws.find('\t') {
            return Err(CompileError::new(
                "tab indentation is not allowed",
                line_no,
                tab_pos,
                lines.iter().map(|s| s.to_string()).collect(),
            )
            .with_hint("use spaces for indentation"));
        }

        let indent = raw.len() - raw.trim_start_matches(' ').len();
        let top = *stack.last().unwrap();
        if indent > top {
            stack.push(indent);
            out.push(Token { ty: TokType::Indent, value: indent.to_string(), line: line_no, col: 0 });
        } else {
            while indent < *stack.last().unwrap() {
                stack.pop();
                out.push(Token { ty: TokType::Dedent, value: indent.to_string(), line: line_no, col: 0 });
            }
            if indent != *stack.last().unwrap() {
                return Err(CompileError::new(
                    format!(
                        "inconsistent indentation: expected {} spaces, got {}",
                        stack.last().unwrap(),
                        indent
                    ),
                    line_no,
                    0,
                    lines.iter().map(|s| s.to_string()).collect(),
                )
                .with_hint("keep one indent width across the file"));
            }
        }

        let bytes = raw.as_bytes();
        let mut pos = indent;
        while pos < bytes.len() {
            let c = bytes[pos];
            // whitespace
            if c == b' ' || c == b'\t' {
                pos += 1;
                continue;
            }
            // comment
            if c == b'#' {
                break;
            }
            let start = pos;

            // f-string or plain string
            if c == b'"' || c == b'\'' || (c == b'f' && pos + 1 < bytes.len() && (bytes[pos + 1] == b'"' || bytes[pos + 1] == b'\'')) {
                let end = match scan_string(bytes, pos) {
                    Some(end) => end,
                    None => {
                        return Err(CompileError::new(
                            "unterminated string literal",
                            line_no,
                            start,
                            lines.iter().map(|s| s.to_string()).collect(),
                        )
                        .with_hint("close the quote, or escape it with a backslash"));
                    }
                };
                let text = &raw[start..end];
                let is_f = text.starts_with('f');
                out.push(Token {
                    ty: if is_f { TokType::FString } else { TokType::String },
                    value: text.to_string(),
                    line: line_no,
                    col: start,
                });
                pos = end;
                continue;
            }

            // number
            if c.is_ascii_digit() {
                let mut end = pos;
                while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
                    end += 1;
                }
                out.push(Token { ty: TokType::Number, value: raw[start..end].to_string(), line: line_no, col: start });
                pos = end;
                continue;
            }

            // identifier / keyword — decoded as chars, not bytes, so a
            // multi-byte letter is one step and `raw[start..end]` stays on a
            // char boundary.
            if is_ident_start(raw[pos..].chars().next().unwrap_or('\0')) {
                let mut end = pos;
                for ch in raw[pos..].chars() {
                    if !is_ident_cont(ch) {
                        break;
                    }
                    end += ch.len_utf8();
                }
                let word = &raw[start..end];
                let ty = match keyword(word) {
                    Some(k) => TokType::Kw(k),
                    None => TokType::Ident,
                };
                out.push(Token { ty, value: word.to_string(), line: line_no, col: start });
                pos = end;
                continue;
            }

            // two-char operators first. Slice by chars: `&raw[pos..pos + 2]`
            // panics the moment a multi-byte character sits at `pos`.
            let two = raw[pos..].chars().take(2).collect::<String>();
            let three = raw[pos..].chars().take(3).collect::<String>();
            let (ty, len) = if three == "**=" || three == "//=" {
                (TokType::Op, 3)
            } else if matches!(two.as_str(), "==" | "!=" | "<=" | ">=" | "+=" | "-=" | "*=" | "/=" | "**" | "//" | "&&" | "||" | "->" | "?." | "??") {
                if two == "->" {
                    (TokType::Arrow, 2)
                } else {
                    (TokType::Op, 2)
                }
            } else {
                match c {
                    b':' => (TokType::Colon, 1),
                    b',' => (TokType::Comma, 1),
                    b'.' => (TokType::Dot, 1),
                    b'(' => (TokType::LParen, 1),
                    b')' => (TokType::RParen, 1),
                    b'[' => (TokType::LBrack, 1),
                    b']' => (TokType::RBrack, 1),
                    b'{' => (TokType::LBrace, 1),
                    b'}' => (TokType::RBrace, 1),
                    b'=' | b'+' | b'-' | b'*' | b'/' | b'%' | b'<' | b'>' | b'!' | b'&' | b'|' | b'?' => {
                        (TokType::Op, 1)
                    }
                    _ => {
                        return Err(CompileError::new(
                            format!("unexpected character {:?}", raw[pos..].chars().next().unwrap_or('\0')),
                            line_no,
                            start,
                            lines.iter().map(|s| s.to_string()).collect(),
                        ))
                    }
                }
            };
            out.push(Token {
                ty,
                value: raw[start..start + len].to_string(),
                line: line_no,
                col: start,
            });
            pos = start + len;
        }

        out.push(Token { ty: TokType::Newline, value: "\n".to_string(), line: line_no, col: raw.len() });
    }

    while stack.len() > 1 {
        stack.pop();
        out.push(Token { ty: TokType::Dedent, value: "0".to_string(), line: lines.len(), col: 0 });
    }
    out.push(Token { ty: TokType::Eof, value: String::new(), line: lines.len() + 1, col: 0 });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(src: &str) -> Vec<TokType> {
        lex(src).expect("lex failed").into_iter().map(|t| t.ty).collect()
    }

    fn vals(src: &str) -> Vec<String> {
        lex(src).expect("lex failed").into_iter().map(|t| t.value).collect()
    }

    fn count(src: &str, ty: TokType) -> usize {
        kinds(src).into_iter().filter(|t| *t == ty).count()
    }

    // ------------------------------------------------------------- indentation

    #[test]
    fn indent_emitted_on_deeper_indent() {
        assert!(kinds("a:\n    b\n").contains(&TokType::Indent));
    }

    #[test]
    fn dedent_emitted_on_shallower_indent() {
        assert!(kinds("a:\n    b\nc\n").contains(&TokType::Dedent));
    }

    #[test]
    fn indent_and_dedent_are_balanced() {
        let src = "component A():\n    div:\n        span: \"x\"\n    p: \"y\"\n";
        assert_eq!(count(src, TokType::Indent), count(src, TokType::Dedent));
        assert_eq!(count(src, TokType::Indent), 2);
    }

    #[test]
    fn dedent_flush_at_eof_balances_open_indents() {
        // File ends while still indented: the lexer must close the stack.
        let src = "a:\n    b:\n        c\n";
        assert_eq!(count(src, TokType::Indent), count(src, TokType::Dedent));
    }

    #[test]
    fn trailing_eof_token_always_present() {
        assert_eq!(*kinds("a\n").last().unwrap(), TokType::Eof);
        assert_eq!(*kinds("").last().unwrap(), TokType::Eof);
    }

    #[test]
    fn inconsistent_indent_is_an_error() {
        let err = lex("a:\n    b\n  c\n").unwrap_err();
        assert!(err.msg.contains("indentation"), "msg was {:?}", err.msg);
        assert_eq!(err.line, 3);
        assert!(err.hint.is_some());
    }

    #[test]
    fn tabs_are_whitespace_not_indentation_width() {
        // A tab after the indent is skipped as whitespace, not counted.
        let toks = lex("a:\n    b\tc\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::Ident && t.value == "c"));
    }

    #[test]
    fn tabs_in_indentation_are_disallowed() {
        let err = lex("a:\n\tb\n").unwrap_err();
        assert!(err.msg.contains("tab indentation is not allowed"), "msg was {:?}", err.msg);
        let err2 = lex("a:\n  \tb\n").unwrap_err();
        assert!(err2.msg.contains("tab indentation is not allowed"), "msg was {:?}", err2.msg);
    }

    // ---------------------------------------------------------------- skipping

    #[test]
    fn comments_are_stripped() {
        let toks = lex("a: # trailing\n# whole line\n    b\n").unwrap();
        assert!(toks.iter().all(|t| !t.value.contains('#')));
        assert!(toks.iter().all(|t| t.ty != TokType::Ident || t.value != "trailing"));
    }

    #[test]
    fn blank_lines_are_skipped_but_newlines_survive() {
        let toks = kinds("a\n\n\n\nb\n");
        assert!(toks.contains(&TokType::Newline));
        // Only the two real lines produce tokens; the blank ones vanish.
        assert_eq!(toks.iter().filter(|t| **t == TokType::Ident).count(), 2);
        assert_eq!(toks.iter().filter(|t| **t == TokType::Newline).count(), 2);
    }

    #[test]
    fn comment_only_file_is_just_eof() {
        assert_eq!(kinds("# nothing here\n# at all\n"), vec![TokType::Eof]);
    }

    #[test]
    fn hash_inside_a_string_is_not_a_comment() {
        let toks = lex("a: \"# not a comment\"\n").unwrap();
        assert!(toks.iter().any(|t| t.value == "\"# not a comment\""));
    }

    // ------------------------------------------------------------------ strings

    #[test]
    fn plain_and_f_strings_are_distinguished() {
        let toks = lex("a: \"plain\"\nb: f\"interp\"\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::String && t.value == "\"plain\""));
        assert!(toks.iter().any(|t| t.ty == TokType::FString && t.value == "f\"interp\""));
    }

    #[test]
    fn single_quoted_strings_are_accepted() {
        let toks = lex("a: 'single'\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::String && t.value == "'single'"));
    }

    #[test]
    fn escapes_do_not_terminate_the_string() {
        let toks = lex("a: \"he said \\\"hi\\\"\"\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::String && t.value == "\"he said \\\"hi\\\"\""));
    }

    #[test]
    fn escaped_backslash_before_quote_still_closes() {
        // "a\\" is a complete string: the backslash escapes the backslash.
        let toks = lex("a: \"a\\\\\"\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::String));
        assert_eq!(*kinds("a: \"a\\\\\"\n").last().unwrap(), TokType::Eof);
    }

    #[test]
    fn unterminated_string_is_an_error_not_a_panic() {
        let err = lex("a: \"abc\n").unwrap_err();
        assert!(err.msg.contains("unterminated"), "msg was {:?}", err.msg);
        assert_eq!(err.line, 1);
    }

    #[test]
    fn lone_quote_is_an_error_not_a_panic() {
        assert!(lex("a: \"\n").is_err());
    }

    #[test]
    fn lone_f_quote_is_an_error_not_a_panic() {
        assert!(lex("a: f\"\n").is_err());
    }

    #[test]
    fn unicode_inside_a_string_is_preserved() {
        let toks = lex("a: \"日本語 café ünïcode\"\n").unwrap();
        assert!(toks.iter().any(|t| t.value == "\"日本語 café ünïcode\""));
    }

    // -------------------------------------------------------------- identifiers

    #[test]
    fn unicode_identifiers_lex_without_panicking() {
        // A multi-byte letter used to slice mid-character and abort the process.
        let toks = lex("café = 1\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::Ident && t.value == "café"));
    }

    #[test]
    fn unicode_identifier_can_start_a_name() {
        let toks = lex("ünïcode = 1\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::Ident && t.value == "ünïcode"));
    }

    #[test]
    fn keywords_are_recognised_and_identifiers_are_not() {
        let toks = lex("component if\n").unwrap();
        assert_eq!(toks[0].ty, TokType::Kw("component"));
        assert_eq!(toks[1].ty, TokType::Kw("if"));
        let toks = lex("component_x\n").unwrap();
        assert_eq!(toks[0].ty, TokType::Ident);
    }

    #[test]
    fn underscore_identifiers_are_identifiers() {
        let toks = lex("_private __dunder\n").unwrap();
        assert_eq!(toks[0].ty, TokType::Ident);
        assert_eq!(toks[0].value, "_private");
    }

    // ---------------------------------------------------------------- operators

    #[test]
    fn two_char_operators_lex_as_one_token() {
        for op in ["==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "**", "//", "&&", "||", "?.", "??"] {
            let toks = lex(&format!("a {} b\n", op)).unwrap();
            assert!(
                toks.iter().any(|t| t.ty == TokType::Op && t.value == op),
                "{} did not lex as one Op token: {:?}",
                op,
                toks.iter().map(|t| (&t.ty, &t.value)).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn three_char_operators_lex_as_one_token() {
        for op in ["**=", "//="] {
            let toks = lex(&format!("a {} b\n", op)).unwrap();
            assert!(toks.iter().any(|t| t.ty == TokType::Op && t.value == op), "{} failed", op);
        }
    }

    #[test]
    fn arrow_is_its_own_token_type() {
        let toks = lex("def f() -> int:\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::Arrow && t.value == "->"));
    }

    #[test]
    fn punctuation_maps_to_its_own_token_types() {
        let toks = lex("a:b,c.d(e)[f]{g}\n").unwrap();
        for ty in [
            TokType::Colon,
            TokType::Comma,
            TokType::Dot,
            TokType::LParen,
            TokType::RParen,
            TokType::LBrack,
            TokType::RBrack,
            TokType::LBrace,
            TokType::RBrace,
        ] {
            assert!(toks.iter().any(|t| t.ty == ty), "missing {:?}", ty);
        }
    }

    #[test]
    fn single_char_operators_are_recognised() {
        for op in ["=", "+", "-", "*", "/", "%", "<", ">", "!", "&", "|", "?"] {
            let toks = lex(&format!("a {} b\n", op)).unwrap();
            assert!(toks.iter().any(|t| t.ty == TokType::Op && t.value == op), "{} failed", op);
        }
    }

    #[test]
    fn unexpected_character_is_an_error() {
        let err = lex("a = ~~~\n").unwrap_err();
        assert!(err.msg.contains("unexpected character"), "msg was {:?}", err.msg);
        assert_eq!(err.line, 1);
        assert_eq!(err.col, 4);
    }

    #[test]
    fn non_ascii_operator_position_errors_instead_of_panicking() {
        // `€` is three bytes; slicing two bytes from it used to abort.
        let err = lex("a = €\n").unwrap_err();
        assert!(err.msg.contains("unexpected character"), "msg was {:?}", err.msg);
    }

    // ------------------------------------------------------------------ numbers

    #[test]
    fn integers_and_floats_lex_as_numbers() {
        let toks = lex("a = 42\nb = 3.14\n").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::Number && t.value == "42"));
        assert!(toks.iter().any(|t| t.ty == TokType::Number && t.value == "3.14"));
    }

    // --------------------------------------------------------------- positions

    #[test]
    fn tokens_carry_their_line_and_column() {
        let toks = lex("component A():\n    div: \"x\"\n").unwrap();
        let div = toks.iter().find(|t| t.value == "div").unwrap();
        assert_eq!(div.line, 2);
        assert_eq!(div.col, 4);
    }

    #[test]
    fn comment_after_code_does_not_shift_the_newline() {
        let toks = lex("a = 1  # note\n").unwrap();
        let nl = toks.iter().find(|t| t.ty == TokType::Newline).unwrap();
        assert_eq!(nl.line, 1);
    }

    // --------------------------------------------------------------------- CRLF

    #[test]
    fn crlf_line_endings_lex_cleanly() {
        // A `\r` used to reach the operator table and fail as a bad character.
        let toks = lex("component A():\r\n    div: \"z\"\r\n").unwrap();
        assert!(toks.iter().all(|t| !t.value.contains('\r')));
        assert!(toks.iter().any(|t| t.ty == TokType::Ident && t.value == "div"));
    }

    #[test]
    fn crlf_and_lf_produce_the_same_token_stream() {
        let lf = vals("component A():\n    div: \"z\"\n");
        let crlf = vals("component A():\r\n    div: \"z\"\r\n");
        assert_eq!(lf, crlf);
    }

    #[test]
    fn missing_trailing_newline_still_lexes() {
        let toks = lex("component A():\n    div: \"z\"").unwrap();
        assert!(toks.iter().any(|t| t.ty == TokType::Ident && t.value == "div"));
        assert_eq!(*kinds("component A():\n    div: \"z\"").last().unwrap(), TokType::Eof);
    }

    #[test]
    fn empty_source_is_just_eof() {
        assert_eq!(kinds(""), vec![TokType::Eof]);
    }
}
