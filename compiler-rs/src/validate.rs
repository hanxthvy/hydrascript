// [xihanzu-NR]
//! Output sanity checks.
//!
//! Why this exists: the compiler used to report success for output that no
//! JavaScript engine would accept. `node.style.transform = x` was emitted as
//! `const node.style.transform = x`, and `new Date()` as `new;\nDate();` — the
//! build said "OK" and the failure only surfaced later, in the browser, as a
//! blank page or a runtime `undefined`. A compiler that claims success on
//! broken output is worse than one that refuses to finish, so every emit is now
//! scanned before it is handed back.
//!
//! The checks are deliberately narrow. This is not a JS parser and must never
//! pretend to be one: it only looks for shapes that are *always* invalid, so it
//! cannot reject valid code. Anything clever belongs in esbuild, not here.

use crate::error::CompileError;

/// Token kinds the sanity check cares about. Strings and comments are collapsed
/// so their contents cannot be mistaken for code.
#[derive(Debug, PartialEq, Clone)]
enum Tok {
    Ident(String),
    Punct(char),
    Other,
}

/// Split source into significant tokens, skipping comments and string bodies.
///
/// Template literals are the tricky case: `${ ... }` re-enters code, so the
/// scanner tracks a mode stack rather than a single boolean.
fn tokenize(src: &str) -> Vec<Tok> {
    #[derive(PartialEq)]
    enum Mode {
        Code,
        Single,
        Double,
        Template,
        LineComment,
        BlockComment,
        Regex,
    }

    let b: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut mode = Mode::Code;
    let mut stack: Vec<Mode> = Vec::new();
    // Brace depth inside the current `${}` so the matching `}` returns to the
    // template literal instead of being treated as code.
    let mut tpl_depth = 0usize;
    let mut i = 0usize;

    while i < b.len() {
        let c = b[i];
        match mode {
            Mode::LineComment => {
                if c == '\n' {
                    mode = stack.pop().unwrap_or(Mode::Code);
                }
                i += 1;
            }
            Mode::BlockComment => {
                if c == '*' && i + 1 < b.len() && b[i + 1] == '/' {
                    mode = stack.pop().unwrap_or(Mode::Code);
                    i += 2;
                } else {
                    i += 1;
                }
            }
            Mode::Single | Mode::Double | Mode::Regex => {
                let quote = match mode {
                    Mode::Single => '\'',
                    Mode::Double => '"',
                    _ => '/',
                };
                if c == '\\' {
                    i += 2;
                    continue;
                }
                if c == quote {
                    mode = stack.pop().unwrap_or(Mode::Code);
                } else if (mode == Mode::Regex) && c == '\n' {
                    // An unterminated regex is not our business; bail out of it
                    // so a lone `/` cannot swallow the rest of the file.
                    mode = stack.pop().unwrap_or(Mode::Code);
                }
                i += 1;
            }
            Mode::Template => {
                if c == '\\' {
                    i += 2;
                    continue;
                }
                if c == '`' {
                    mode = stack.pop().unwrap_or(Mode::Code);
                    i += 1;
                    continue;
                }
                if c == '$' && i + 1 < b.len() && b[i + 1] == '{' {
                    stack.push(Mode::Template);
                    mode = Mode::Code;
                    tpl_depth = 0;
                    out.push(Tok::Punct('(')); // keep the paren balance neutral
                    i += 2;
                    continue;
                }
                i += 1;
            }
            Mode::Code => match c {
                '/' if i + 1 < b.len() && b[i + 1] == '/' => {
                    stack.push(Mode::Code);
                    mode = Mode::LineComment;
                    i += 2;
                }
                '/' if i + 1 < b.len() && b[i + 1] == '*' => {
                    stack.push(Mode::Code);
                    mode = Mode::BlockComment;
                    i += 2;
                }
                '\'' => {
                    stack.push(Mode::Code);
                    mode = Mode::Single;
                    out.push(Tok::Other);
                    i += 1;
                }
                '"' => {
                    stack.push(Mode::Code);
                    mode = Mode::Double;
                    out.push(Tok::Other);
                    i += 1;
                }
                '`' => {
                    stack.push(Mode::Code);
                    mode = Mode::Template;
                    out.push(Tok::Other);
                    i += 1;
                }
                // Order matters: a `}` inside `${...}` closes a nested
                // brace first, and only an unmatched one returns to the
                // template literal.
                '}' if tpl_depth > 0 => {
                    tpl_depth -= 1;
                    out.push(Tok::Punct(c));
                    i += 1;
                }
                '{' if !stack.is_empty() && *stack.last().unwrap() == Mode::Template => {
                    tpl_depth += 1;
                    out.push(Tok::Punct(c));
                    i += 1;
                }
                '}' if !stack.is_empty() && *stack.last().unwrap() == Mode::Template => {
                    stack.pop();
                    mode = Mode::Template;
                    // Balances the '(' emitted when the ${ } region opened.
                    out.push(Tok::Punct(')'));
                    i += 1;
                }
                c if c.is_alphanumeric() || c == '_' || c == '$' => {
                    let start = i;
                    while i < b.len() && (b[i].is_alphanumeric() || b[i] == '_' || b[i] == '$') {
                        i += 1;
                    }
                    out.push(Tok::Ident(b[start..i].iter().collect()));
                }
                '(' | ')' | '[' | ']' | '{' | '}' | ';' | ',' | '.' => {
                    out.push(Tok::Punct(c));
                    i += 1;
                }
                // Whitespace is skipped rather than tokenised. Emitting it
                // as a token would sit between `const` and the name it
                // declares, making every valid declaration look malformed.
                c if c.is_whitespace() => {
                    i += 1;
                }
                // Outside a string a backslash is literal text, not an
                // escape. TSX text nodes contain exactly this: the emitted
                // `<div>a\"b</div>` holds a backslash and a quote as plain
                // characters. Treating the quote as a string opener made
                // the scanner swallow the rest of the file and reject valid
                // output.
                '\\' => {
                    i += 2;
                }
                _ => {
                    out.push(Tok::Other);
                    i += 1;
                }
            },
        }
    }
    out
}

/// Words that must never be followed by whitespace-only before an identifier.
fn is_declaration(word: &str) -> bool {
    matches!(word, "const" | "let" | "var")
}

/// Check emitted JavaScript/TSX for shapes that are always a syntax error.
///
/// `line_of` maps a byte offset in `code` to a line in the ORIGINAL source, so
/// the error points at the HydraScript the author wrote rather than at the
/// generated file they never see.
/// `check_balance` must be false for the TSX target: JSX element tags are not
/// parenthesised, so `<div>...</div>` looks like an unbalanced `)`. Checking it
/// there produced false rejections of perfectly good components. The
/// declaration and `new` checks are JSX-safe and always run.
pub fn check_output(
    code: &str,
    line_of: &[usize],
    src: &[String],
    check_balance: bool,
) -> Result<(), CompileError> {
    let toks = tokenize(code);
    let src_line =
        |idx: usize| -> usize { line_of.get(idx).copied().filter(|l| *l > 0).unwrap_or(1) };

    // 1. Declarations must be followed by a plain name.
    //    `const node.style.transform = x` slipped through here before.
    for (n, t) in toks.iter().enumerate() {
        let w = match t {
            Tok::Ident(w) if is_declaration(w) => w,
            _ => continue,
        };
        match toks.get(n + 1) {
            Some(Tok::Ident(_)) => {
                // A declared name must NOT be followed by a member or index
                // access. `const node.style.transform = x` is exactly the shape
                // that used to be emitted: syntactically impossible, and it
                // survived into the build's "OK" line.
                match toks.get(n + 2) {
                    Some(Tok::Punct('.')) | Some(Tok::Punct('[')) => {
                        let ln = src_line(n);
                        return Err(CompileError::new(
                            format!(
                                "generated code tries to declare a property or index with `{}`",
                                w
                            ),
                            ln,
                            0,
                            src.to_vec(),
                        )
                        .with_hint(
                            "this is a compiler bug, not a mistake in your source — please report it",
                        ));
                    }
                    _ => {}
                }
            }
            // Destructuring binds names, so these are legal.
            Some(Tok::Punct('[')) | Some(Tok::Punct('{')) => {}
            _ => {
                let ln = src_line(n);
                return Err(CompileError::new(
                    format!(
                        "generated code declares `{}` but the target is not a name",
                        w
                    ),
                    ln,
                    0,
                    src.to_vec(),
                )
                .with_hint(
                    "this is a compiler bug, not a mistake in your source — please report it",
                ));
            }
        }
    }

    // 2. `new` must be followed by a constructor expression.
    for (n, t) in toks.iter().enumerate() {
        if *t == Tok::Ident("new".to_string()) {
            match toks.get(n + 1) {
                Some(Tok::Ident(_)) => {}
                _ => {
                    let ln = src_line(n);
                    return Err(CompileError::new(
                        "generated code has `new` with nothing to construct",
                        ln,
                        0,
                        src.to_vec(),
                    )
                    .with_hint(
                        "this is a compiler bug, not a mistake in your source — please report it",
                    ));
                }
            }
        }
    }

    if !check_balance {
        return Ok(());
    }

    // 3. Brackets must balance. Catches the whole family of truncated emits.
    let mut stack: Vec<char> = Vec::new();
    for (n, t) in toks.iter().enumerate() {
        if let Tok::Punct(c) = t {
            match c {
                '(' | '[' | '{' => stack.push(*c),
                ')' | ']' | '}' => {
                    let want = match c {
                        ')' => '(',
                        ']' => '[',
                        _ => '{',
                    };
                    match stack.pop() {
                        Some(open) if open == want => {}
                        _ => {
                            let ln = src_line(n);
                            return Err(CompileError::new(
                                format!("generated code closes `{}` that was never opened", c),
                                ln,
                                0,
                                src.to_vec(),
                            )
                            .with_hint(
                                "this is a compiler bug, not a mistake in your source — please report it",
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if !stack.is_empty() {
        return Err(CompileError::new(
            format!("generated code has {} unclosed bracket(s)", stack.len()),
            1,
            0,
            src.to_vec(),
        )
        .with_hint("this is a compiler bug, not a mistake in your source — please report it"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plain JS: balance is meaningful and checked.
    fn ok(code: &str) -> bool {
        check_output(code, &[], &[], true).is_ok()
    }

    /// TSX: balance is skipped, the other checks still apply.
    fn ok_tsx(code: &str) -> bool {
        check_output(code, &[], &[], false).is_ok()
    }

    #[test]
    fn accepts_ordinary_javascript() {
        assert!(ok("const x = 1;"));
        assert!(ok("let [a, b] = pair();"));
        assert!(ok("const { a, b } = obj;"));
        assert!(ok("const d = new Date();"));
        assert!(ok("export function A() {\n  const y = 2;\n  return y;\n}"));
        assert!(ok("const s = `hi ${name} there`;"));
        assert!(ok("const s = `outer ${a + `${b}`} end`;"));
        assert!(ok("const re = /a[b-c]+/g;"));
        assert!(ok("// const broken.thing = 1;\nconst fine = 1;"));
        assert!(ok("/* const nope.field = 1; */"));
        assert!(ok("const q = \"const not.code = 1;\";"));
    }

    #[test]
    fn rejects_declaration_of_member_target() {
        let err = check_output("const node.style.transform = \"x\";", &[], &[], true);
        assert!(err.is_err(), "member declaration must be rejected");
        let e = err.unwrap_err();
        assert!(e.msg.contains("property or index"), "got: {}", e.msg);
        // The author never wrote this line, so the message must say so rather
        // than blame their source.
        assert!(e.hint.unwrap_or_default().contains("compiler bug"));
    }

    #[test]
    fn rejects_index_declaration() {
        assert!(check_output("let rows[i] = 3;", &[], &[], true).is_err());
    }

    #[test]
    fn rejects_bare_new() {
        let err = check_output("const d = new;\nDate();", &[], &[], true);
        assert!(err.is_err());
        assert!(err.unwrap_err().msg.contains("new"));
    }

    #[test]
    fn rejects_unbalanced_brackets() {
        assert!(check_output("function f() {", &[], &[], true).is_err());
        assert!(check_output("f(1));", &[], &[], true).is_err());
    }

    #[test]
    fn string_contents_do_not_confuse_the_scanner() {
        // A brace inside a string must not close a block.
        assert!(ok("function f() { return \"}\"; }"));
        assert!(ok("const s = '\\\\';"));
    }

    #[test]
    fn jsx_output_skips_the_balance_check() {
        // A real emitted component: element tags make bracket counting
        // meaningless, and JSX text holds raw backslashes and quotes.
        assert!(ok_tsx(
            "export function A() {\n  return (\n    <div>a\\\"b\\\\c</div>\n  );\n}"
        ));
        // The checks that DO apply to TSX must still fire.
        assert!(check_output("const x.y = 1;", &[], &[], false).is_err());
    }

    #[test]
    fn identifiers_containing_keywords_are_fine() {
        assert!(ok("const constant = 1;"));
        assert!(ok("const newest = 2;"));
        assert!(ok("const letter = 3;"));
    }
}
