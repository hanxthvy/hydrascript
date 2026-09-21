// [xihanzu-NR]
//! Recursive-descent parser.
//!
//! Precedence climbing, Python's own operator precedence, and the one rule that
//! makes the tree syntax work: a `:` after an expression opens a JSX block.

use crate::ast::{CaseArm, Kind, Node, Param};
use crate::error::CompileError;
use crate::lexer::{TokType, Token};

pub struct Parser {
    toks: Vec<Token>,
    i: usize,
    src: Vec<String>,
    depth: usize,
}

type PResult<T> = Result<T, CompileError>;

impl Parser {
    pub fn new(toks: Vec<Token>, src: Vec<String>) -> Self {
        Self { toks, i: 0, src, depth: 0 }
    }

    fn enter_depth(&mut self) -> PResult<()> {
        if self.depth >= 256 {
            return Err(self.err("maximum recursion depth exceeded (256)".into())
                .with_hint("simplify deeply nested structure"));
        }
        self.depth += 1;
        Ok(())
    }

    fn leave_depth(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn cur(&self) -> &Token {
        &self.toks[self.i]
    }

    fn peek(&self, n: usize) -> &Token {
        self.toks.get(self.i + n).unwrap_or_else(|| self.toks.last().unwrap())
    }

    fn at(&self, tys: &[TokType]) -> bool {
        tys.iter().any(|t| self.cur().ty == *t)
    }

    fn eat(&mut self, ty: TokType) -> PResult<&Token> {
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

    fn err(&self, msg: String) -> CompileError {
        let t = self.cur();
        CompileError::new(msg, t.line, t.col, self.src.clone())
    }

    fn skip_newlines(&mut self) {
        while self.cur().ty == TokType::Newline {
            self.i += 1;
        }
    }

    fn ident(&mut self) -> PResult<String> {
        Ok(self.eat(TokType::Ident)?.value.clone())
    }

    /// Skip newlines/indent/dedent tokens that appear inside a bracket pair.
    ///
    /// Python makes newlines insignificant inside `()`, `[]` and `{}`. We do the
    /// same, which is what lets a long list or a multi-line element attribute
    /// list be written across lines. `depth` tracks how many INDENTs were seen
    /// so a matching DEDENT does not terminate the enclosing block early.
    fn skip_bracket_newlines(&mut self, depth: &mut i32) {
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

    pub fn module(&mut self) -> PResult<Node> {
        let mut body = Vec::new();
        self.skip_newlines();
        while self.cur().ty != TokType::Eof {
            body.push(self.stmt()?);
            self.skip_newlines();
        }
        Ok(Node::new(Kind::Module(body), 0, 0))
    }

    /// Consume `:` then either an inline statement or an indented block.
    fn block(&mut self) -> PResult<Vec<Node>> {
        self.eat(TokType::Colon)?;
        if self.cur().ty != TokType::Newline {
            return Ok(vec![self.stmt()?]);
        }
        self.eat(TokType::Newline)?;
        if self.cur().ty != TokType::Indent {
            return Ok(Vec::new()); // empty block, e.g. `br:`
        }
        self.eat(TokType::Indent)?;
        let mut body = Vec::new();
        self.skip_newlines();
        while !self.at(&[TokType::Dedent, TokType::Eof]) {
            body.push(self.stmt()?);
            self.skip_newlines();
        }
        if self.cur().ty == TokType::Dedent {
            self.i += 1;
        }
        Ok(body)
    }

    fn stmt(&mut self) -> PResult<Node> {
        self.enter_depth()?;
        let res = self.stmt_inner();
        self.leave_depth();
        res
    }

    fn stmt_inner(&mut self) -> PResult<Node> {
        let t = self.cur().clone();
        match &t.ty {
            TokType::Kw("component") => return self.component(),
            TokType::Kw("async") => return self.async_def(),
            TokType::Kw("export") => return self.export_stmt(),
            TokType::Kw("def") => return self.def(),
            TokType::Kw("import") => return self.import(),
            TokType::Kw("from") => return self.from_import(),
            TokType::Kw("interface") => return self.interface_decl(),
            TokType::Kw("type") => return self.type_alias(),
            TokType::Kw("return") => {
                self.i += 1;
                return Ok(Node::new(Kind::Return(Box::new(self.expr()?)), t.line, t.col));
            }
            TokType::Kw("if") => return self.if_stmt(),
            TokType::Kw("for") => return self.for_stmt(),
            TokType::Kw("while") => return self.while_stmt(),
            TokType::Kw("try") => return self.try_stmt(),
            TokType::Kw("match") => return self.match_stmt(),
            TokType::Kw("break") => {
                self.i += 1;
                return Ok(Node::new(Kind::Break, t.line, t.col));
            }
            TokType::Kw("continue") => {
                self.i += 1;
                return Ok(Node::new(Kind::Continue, t.line, t.col));
            }
            TokType::Kw("pass") => {
                self.i += 1;
                return Ok(Node::new(Kind::Pass, t.line, t.col));
            }
            _ => {}
        }

        let e = self.expr()?;
        // tuple target:  a, b = ...
        let e = if self.cur().ty == TokType::Comma {
            let mut items = vec![e];
            while self.cur().ty == TokType::Comma {
                self.i += 1;
                if self.cur().ty == TokType::Op && self.cur().value == "=" {
                    break;
                }
                items.push(self.expr()?);
            }
            Node::new(Kind::Tuple(items), t.line, t.col)
        } else {
            e
        };

        if self.cur().ty == TokType::Colon {
            let body = self.block()?;
            return Ok(Node::new(Kind::Tree { head: Box::new(e), body }, t.line, t.col));
        }
        if self.cur().ty == TokType::Op && self.cur().value == "=" {
            self.i += 1;
            let v = self.expr()?;
            return Ok(Node::new(Kind::Assign { target: Box::new(e), value: Box::new(v) }, t.line, t.col));
        }
        if self.cur().ty == TokType::Op && matches!(self.cur().value.as_str(), "+=" | "-=" | "*=" | "/=") {
            let op = self.cur().value[..1].to_string();
            self.i += 1;
            let v = self.expr()?;
            return Ok(Node::new(Kind::AugAssign { target: Box::new(e), op, value: Box::new(v) }, t.line, t.col));
        }
        Ok(Node::new(Kind::ExprStmt(Box::new(e)), t.line, t.col))
    }

    fn import(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("import"))?.clone();
        let mut names = vec![self.ident()?];
        while self.cur().ty == TokType::Comma {
            self.i += 1;
            names.push(self.ident()?);
        }
        Ok(Node::new(Kind::Import { from: None, names }, t.line, t.col))
    }

    fn from_import(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("from"))?.clone();
        // A relative import is a string: `from './Other.hsx' import Thing`.
        // Bare module names stay identifiers.
        let module = if self.cur().ty == TokType::String {
            let raw = self.cur().value.clone();
            self.i += 1;
            raw[1..raw.len() - 1].to_string()
        } else {
            self.ident()?
        };
        self.eat(TokType::Kw("import"))?;
        // `import type` prefix — skip the `type` keyword, it's TS-only
        if self.cur().ty == TokType::Kw("type") {
            self.i += 1;
        }
        let mut names = Vec::new();
        loop {
            // `type Name` inline — skip the `type` keyword per-name
            if self.cur().ty == TokType::Kw("type") {
                self.i += 1;
            }
            names.push(self.ident()?);
            // `as Alias` — rename import
            if self.cur().ty == TokType::Kw("as") {
                self.i += 1;
                let _alias = self.ident()?;
                // ponytail: alias stored as "original as alias"
                let last = names.last_mut().unwrap();
                *last = format!("{} as {}", last, _alias);
            }
            if self.cur().ty == TokType::Comma {
                self.i += 1;
            } else {
                break;
            }
        }
        Ok(Node::new(Kind::Import { from: Some(module), names }, t.line, t.col))
    }

    fn component(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("component"))?.clone();
        let name = self.ident()?;
        let params = if self.cur().ty == TokType::LParen { self.params()? } else { Vec::new() };
        let body = self.block()?;
        Ok(Node::new(Kind::Component { name, params, body }, t.line, t.col))
    }

    /// `interface Name:` block — collect raw lines of the indented body and pass through as TS.
    fn interface_decl(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("interface"))?.clone();
        let name = self.ident()?;
        // Optionally consume `extends OtherInterface`
        let mut extends = String::new();
        if self.cur().ty == TokType::Ident && self.cur().value == "extends" {
            extends.push_str(" extends ");
            self.i += 1;
            extends.push_str(&self.ident()?);
            while self.cur().ty == TokType::Comma {
                self.i += 1;
                extends.push_str(", ");
                extends.push_str(&self.ident()?);
            }
        }
        // Consume the colon and the indented block as raw text
        self.eat(TokType::Colon)?;
        let body = self.raw_indented_block()?;
        let full_name = format!("{}{}", name, extends);
        Ok(Node::new(Kind::Interface { name: full_name, body }, t.line, t.col))
    }

    /// `type Name = ...` — collect everything until newline as TS type alias.
    fn type_alias(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("type"))?.clone();
        let name = self.ident()?;
        self.eat_op("=")?;
        let mut body = String::new();
        while self.cur().ty != TokType::Newline && self.cur().ty != TokType::Eof {
            if !body.is_empty() {
                body.push(' ');
            }
            body.push_str(&self.cur().value);
            self.i += 1;
        }
        Ok(Node::new(Kind::TypeAlias { name, body }, t.line, t.col))
    }

    /// Consume an operator token with a specific value (for `=` in type alias).
    fn eat_op(&mut self, op: &str) -> PResult<()> {
        if self.cur().ty == TokType::Op && self.cur().value == op {
            self.i += 1;
            Ok(())
        } else {
            Err(self.err(format!("expected `{}`, found `{}`", op, self.cur().value)))
        }
    }

    /// Collect all tokens in an indented block and join them as raw text.
    /// Used for interface/type bodies that should pass through to TypeScript verbatim.
    fn raw_indented_block(&mut self) -> PResult<String> {
        // Eat newline
        if self.cur().ty == TokType::Newline {
            self.i += 1;
        }
        if self.cur().ty != TokType::Indent {
            return Ok(String::new());
        }
        self.i += 1; // eat Indent

        let mut lines: Vec<String> = Vec::new();
        let mut current_line = String::new();

        while self.cur().ty != TokType::Dedent && self.cur().ty != TokType::Eof {
            if self.cur().ty == TokType::Newline {
                lines.push(std::mem::take(&mut current_line));
                self.i += 1;
                continue;
            }
            if self.cur().ty == TokType::Indent || self.cur().ty == TokType::Dedent {
                self.i += 1;
                continue;
            }
            if !current_line.is_empty() {
                current_line.push(' ');
            }
            // Reconstruct token: keywords become their values, ops stay as-is
            let val = &self.cur().value;
            // Special handling: `?` before `:` means optional field
            if val == "?" {
                current_line.push('?');
                self.i += 1;
                continue;
            }
            current_line.push_str(val);
            self.i += 1;
        }
        if !current_line.is_empty() {
            lines.push(current_line);
        }
        if self.cur().ty == TokType::Dedent {
            self.i += 1;
        }
        Ok(lines.join("\n"))
    }

    fn def(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("def"))?.clone();
        let name = self.ident()?;
        let params = if self.cur().ty == TokType::LParen { self.params()? } else { Vec::new() };
        if self.cur().ty == TokType::Arrow {
            self.i += 1;
            self.type_expr()?;
        }
        let body = self.block()?;
        Ok(Node::new(Kind::Def { name, params, body }, t.line, t.col))
    }

    fn params(&mut self) -> PResult<Vec<Param>> {
        self.eat(TokType::LParen)?;
        let mut depth: i32 = 0;
        self.skip_bracket_newlines(&mut depth);
        let mut out = Vec::new();
        while self.cur().ty != TokType::RParen {
            self.skip_bracket_newlines(&mut depth);
            let prefix = if self.cur().ty == TokType::Op && (self.cur().value == "*" || self.cur().value == "**") {
                self.i += 1;
                "..."
            } else {
                ""
            };
            let ident = self.ident()?;
            let name = format!("{}{}", prefix, ident);
            let mut ty = None;
            if self.cur().ty == TokType::Colon {
                self.i += 1;
                self.skip_bracket_newlines(&mut depth);
                ty = Some(self.type_expr()?);
            }
            let mut default = None;
            let mut has_default = false;
            if self.cur().ty == TokType::Op && self.cur().value == "=" {
                self.i += 1;
                self.skip_bracket_newlines(&mut depth);
                default = Some(self.expr()?);
                has_default = true;
            }
            out.push(Param { name, ty, default, has_default });
            self.skip_bracket_newlines(&mut depth);
            if self.cur().ty == TokType::Comma {
                self.i += 1;
                self.skip_bracket_newlines(&mut depth);
            } else {
                break;
            }
        }
        self.skip_bracket_newlines(&mut depth);
        self.eat(TokType::RParen)?;
        Ok(out)
    }

    /// Python type annotation -> TypeScript type string.
    fn type_expr(&mut self) -> PResult<String> {
        let map = |s: &str| -> String {
            match s {
                "str" => "string".into(),
                "int" | "float" => "number".into(),
                "bool" => "boolean".into(),
                "None" => "null".into(),
                "Any" => "any".into(),
                "list" => "Array".into(),
                "dict" => "Record".into(),
                other => other.to_string(),
            }
        };

        if self.cur().ty == TokType::LBrack {
            self.i += 1;
            let mut inner = vec![self.type_expr()?];
            while self.cur().ty == TokType::Comma {
                self.i += 1;
                inner.push(self.type_expr()?);
            }
            self.eat(TokType::RBrack)?;
            return Ok(format!("({})", inner.join(" | ")));
        }

        let base = if self.cur().ty == TokType::Kw("None") {
            self.i += 1;
            "None".to_string()
        } else {
            let mut b = self.ident()?;
            while self.cur().ty == TokType::Dot {
                self.i += 1;
                b.push('.');
                b.push_str(&self.ident()?);
            }
            b
        };
        let mut out = map(&base);
        if self.cur().ty == TokType::LBrack {
            self.i += 1;
            let mut inner = vec![self.type_expr()?];
            while self.cur().ty == TokType::Comma {
                self.i += 1;
                inner.push(self.type_expr()?);
            }
            self.eat(TokType::RBrack)?;
            out.push('<');
            out.push_str(&inner.join(", "));
            out.push('>');
        }
        while self.cur().ty == TokType::Op && self.cur().value == "|" {
            self.i += 1;
            out.push_str(" | ");
            out.push_str(&self.type_expr()?);
        }
        Ok(out)
    }

    /// Split an f-string token into literal runs and parsed expressions.
    ///
    /// The expression inside `{...}` is run through the real parser, so a
    /// Python ternary, a comprehension or a method call inside an f-string
    /// compiles correctly instead of being copied verbatim into the JS.
    fn parse_fstring(&self, tok: &Token) -> PResult<Vec<crate::ast::FPart>> {
        use crate::ast::FPart;
        let raw = &tok.value;
        // Strip the leading `f` and the surrounding quotes. A malformed token
        // (just `f"`) would slice out of bounds, so bail with a real error.
        let body = if raw.starts_with("f\"\"\"") || raw.starts_with("f'''") {
            raw.get(4..raw.len().saturating_sub(3))
        } else {
            raw.get(2..raw.len().saturating_sub(1))
        };
        let Some(body) = body else {
            return Err(CompileError::new(
                "malformed f-string",
                tok.line,
                tok.col,
                self.src.clone(),
            )
            .with_hint("an f-string needs an opening and a closing quote"));
        };

        let mut parts = Vec::new();
        let mut lit = String::new();
        let chars: Vec<char> = body.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '{' if i + 1 < chars.len() && chars[i + 1] == '{' => {
                    lit.push('{');
                    i += 2;
                }
                '}' if i + 1 < chars.len() && chars[i + 1] == '}' => {
                    lit.push('}');
                    i += 2;
                }
                '{' => {
                    // Find the matching close brace, tracking nesting and strings.
                    let start = i + 1;
                    let mut depth = 1;
                    let mut j = start;
                    let mut quote: Option<char> = None;
                    while j < chars.len() {
                        let c = chars[j];
                        if let Some(q) = quote {
                            if c == '\\' {
                                j += 2;
                                continue;
                            }
                            if c == q {
                                quote = None;
                            }
                        } else if c == '"' || c == '\'' {
                            quote = Some(c);
                        } else if c == '{' || c == '[' || c == '(' {
                            depth += 1;
                        } else if c == '}' || c == ']' || c == ')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        j += 1;
                    }
                    if depth != 0 {
                        return Err(CompileError::new(
                            "unclosed '{' in f-string",
                            tok.line,
                            tok.col,
                            self.src.clone(),
                        )
                        .with_hint("close the expression with '}'"));
                    }
                    if !lit.is_empty() {
                        parts.push(FPart::Lit(std::mem::take(&mut lit)));
                    }
                    let expr_src: String = chars[start..j].iter().collect();
                    let sub_lines: Vec<String> = expr_src.split('\n').map(|s| s.to_string()).collect();
                    let sub_toks = crate::lexer::lex(&expr_src)?;
                    let mut sub = Parser::new(sub_toks, sub_lines);
                    sub.depth = self.depth;
                    let e = sub.expr()?;
                    parts.push(FPart::Expr(e));
                    i = j + 1;
                }
                c => {
                    lit.push(c);
                    i += 1;
                }
            }
        }
        if !lit.is_empty() {
            parts.push(FPart::Lit(lit));
        }
        Ok(parts)
    }

    fn if_stmt(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("if"))?.clone();
        let test = self.expr()?;
        let body = self.block()?;
        let mut orelse = None;
        if self.cur().ty == TokType::Kw("elif") {
            orelse = Some(vec![self.elif()?]);
        } else if self.cur().ty == TokType::Kw("else") {
            self.i += 1;
            orelse = Some(self.block()?);
        }
        Ok(Node::new(
            Kind::If { test: Box::new(test), body, orelse },
            t.line,
            t.col,
        ))
    }

    fn elif(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("elif"))?.clone();
        let test = self.expr()?;
        let body = self.block()?;
        let mut orelse = None;
        if self.cur().ty == TokType::Kw("elif") {
            orelse = Some(vec![self.elif()?]);
        } else if self.cur().ty == TokType::Kw("else") {
            self.i += 1;
            orelse = Some(self.block()?);
        }
        Ok(Node::new(
            Kind::If { test: Box::new(test), body, orelse },
            t.line,
            t.col,
        ))
    }

    fn for_stmt(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("for"))?.clone();
        // `for i, x in enumerate(xs):` — Python's unpacking loop. Emitted as
        // `for (const [i, x] of ...)`.
        let mut targets = vec![self.ident()?];
        while self.cur().ty == TokType::Comma {
            self.i += 1;
            targets.push(self.ident()?);
        }
        let target = if targets.len() == 1 {
            targets.into_iter().next().unwrap()
        } else {
            format!("[{}]", targets.join(", "))
        };
        self.eat(TokType::Kw("in"))?;
        let iter = self.expr()?;
        let body = self.block()?;
        Ok(Node::new(
            Kind::For { target, iter: Box::new(iter), body },
            t.line,
            t.col,
        ))
    }

    fn while_stmt(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("while"))?.clone();
        let test = self.expr()?;
        let body = self.block()?;
        Ok(Node::new(Kind::While { test: Box::new(test), body }, t.line, t.col))
    }

    /// `try: ... except Cls as e: ... except: ... else: ... finally: ...`
    fn try_stmt(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("try"))?.clone();
        let body = self.block()?;

        let mut handlers = Vec::new();
        while self.cur().ty == TokType::Kw("except") {
            self.i += 1;
            // `except:` / `except ValueError:` / `except ValueError as e:`
            let mut class = None;
            let mut name = None;
            if self.cur().ty != TokType::Colon {
                if self.cur().ty == TokType::LParen {
                    // `except (A, B):` — take the first class; JS `catch` has no
                    // type filter, so the emitter checks instanceof in order.
                    self.i += 1;
                    class = Some(self.ident()?);
                    while self.cur().ty == TokType::Comma {
                        self.i += 1;
                        self.ident()?; // ponytail: extra classes are dropped, see emitter
                    }
                    self.eat(TokType::RParen)?;
                } else {
                    class = Some(self.ident()?);
                }
                if self.cur().ty == TokType::Kw("as") {
                    self.i += 1;
                    name = Some(self.ident()?);
                }
            }
            let hbody = self.block()?;
            handlers.push(crate::ast::Except { class, name, body: hbody });
        }

        let mut orelse = None;
        if self.cur().ty == TokType::Kw("else") {
            self.i += 1;
            orelse = Some(self.block()?);
        }
        let mut finally = None;
        if self.cur().ty == TokType::Kw("finally") {
            self.i += 1;
            finally = Some(self.block()?);
        }

        if handlers.is_empty() && finally.is_none() {
            return Err(self
                .err("`try` needs an `except` or a `finally`".into())
                .with_hint("add `except:` to handle the error, or `finally:` to clean up"));
        }

        Ok(Node::new(
            Kind::Try { body, handlers, orelse, finally },
            t.line,
            t.col,
        ))
    }

    fn match_stmt(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("match"))?.clone();
        let subject = self.expr()?;
        self.eat(TokType::Colon)?;

        self.skip_newlines();
        self.eat(TokType::Indent)?;
        let mut cases = Vec::new();

        while !self.at(&[TokType::Dedent, TokType::Eof]) {
            self.skip_newlines();
            if self.at(&[TokType::Dedent, TokType::Eof]) {
                break;
            }
            if self.cur().ty == TokType::Kw("case") {
                self.i += 1;
                let pattern = if self.cur().ty == TokType::Ident && self.cur().value == "_" {
                    let pt = self.cur().clone();
                    self.i += 1;
                    Node::new(Kind::Name("_".into()), pt.line, pt.col)
                } else {
                    self.expr()?
                };
                let body = self.block()?;
                cases.push(CaseArm {
                    pattern: Box::new(pattern),
                    body,
                });
            } else {
                return Err(self.err("expected `case` inside `match` block".into()));
            }
            self.skip_newlines();
        }
        if self.cur().ty == TokType::Dedent {
            self.i += 1;
        }
        Ok(Node::new(
            Kind::Match {
                subject: Box::new(subject),
                cases,
            },
            t.line,
            t.col,
        ))
    }

    fn async_def(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("async"))?.clone();
        self.eat(TokType::Kw("def"))?;
        let name = self.ident()?;
        let params = if self.cur().ty == TokType::LParen { self.params()? } else { Vec::new() };
        if self.cur().ty == TokType::Arrow {
            self.i += 1;
            self.type_expr()?;
        }
        let body = self.block()?;
        Ok(Node::new(Kind::AsyncDef { name, params, body }, t.line, t.col))
    }

    fn export_stmt(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("export"))?.clone();
        let inner = self.stmt()?;
        Ok(Node::new(Kind::Export(Box::new(inner)), t.line, t.col))
    }

    // ----------------------------------------------------------- expressions

    pub fn expr(&mut self) -> PResult<Node> {
        self.enter_depth()?;
        let res = self.ternary();
        self.leave_depth();
        res
    }

    #[inline(always)]
    fn ternary(&mut self) -> PResult<Node> {
        let n = self.coalesce()?;
        if self.cur().ty == TokType::Kw("if") {
            self.enter_depth()?;
            self.i += 1;
            let test = self.coalesce()?;
            self.eat(TokType::Kw("else"))?;
            let orelse = self.ternary()?;
            self.leave_depth();
            let (line, col) = (n.line, n.col);
            return Ok(Node::new(
                Kind::Ternary { test: Box::new(test), body: Box::new(n), orelse: Box::new(orelse) },
                line,
                col,
            ));
        }
        Ok(n)
    }

    #[inline(always)]
    fn coalesce(&mut self) -> PResult<Node> {
        let mut n = self.or()?;
        while self.cur().ty == TokType::Op && self.cur().value == "??" {
            self.i += 1;
            let r = self.or()?;
            let (line, col) = (n.line, n.col);
            n = Node::new(Kind::Bin { op: "??".into(), left: Box::new(n), right: Box::new(r) }, line, col);
        }
        Ok(n)
    }

    #[inline(always)]
    fn or(&mut self) -> PResult<Node> {
        let mut n = self.and()?;
        while self.cur().ty == TokType::Kw("or") {
            self.i += 1;
            let r = self.and()?;
            let (line, col) = (n.line, n.col);
            n = Node::new(Kind::Bin { op: "||".into(), left: Box::new(n), right: Box::new(r) }, line, col);
        }
        Ok(n)
    }

    #[inline(always)]
    fn and(&mut self) -> PResult<Node> {
        let mut n = self.not()?;
        while self.cur().ty == TokType::Kw("and") {
            self.i += 1;
            let r = self.not()?;
            let (line, col) = (n.line, n.col);
            n = Node::new(Kind::Bin { op: "&&".into(), left: Box::new(n), right: Box::new(r) }, line, col);
        }
        Ok(n)
    }

    #[inline(always)]
    fn not(&mut self) -> PResult<Node> {
        if self.cur().ty == TokType::Kw("not") {
            self.enter_depth()?;
            let t = self.cur().clone();
            self.i += 1;
            let v = self.not()?;
            self.leave_depth();
            return Ok(Node::new(Kind::Unary { op: "!".into(), operand: Box::new(v) }, t.line, t.col));
        }
        self.comparison()
    }

    #[inline(always)]
    fn comparison(&mut self) -> PResult<Node> {
        let mut n = self.additive()?;
        while (self.cur().ty == TokType::Op
            && matches!(self.cur().value.as_str(), "==" | "!=" | "<" | ">" | "<=" | ">="))
            || self.cur().ty == TokType::Kw("in")
        {
            let op = if self.cur().ty == TokType::Kw("in") {
                "in".to_string()
            } else {
                match self.cur().value.as_str() {
                    "==" => "===".to_string(),
                    "!=" => "!==".to_string(),
                    other => other.to_string(),
                }
            };
            self.i += 1;
            let r = self.additive()?;
            let (line, col) = (n.line, n.col);
            n = Node::new(Kind::Bin { op, left: Box::new(n), right: Box::new(r) }, line, col);
        }
        Ok(n)
    }

    #[inline(always)]
    fn additive(&mut self) -> PResult<Node> {
        let mut n = self.multiplicative()?;
        while self.cur().ty == TokType::Op && matches!(self.cur().value.as_str(), "+" | "-") {
            let op = self.cur().value.clone();
            self.i += 1;
            let r = self.multiplicative()?;
            let (line, col) = (n.line, n.col);
            n = Node::new(Kind::Bin { op, left: Box::new(n), right: Box::new(r) }, line, col);
        }
        Ok(n)
    }

    #[inline(always)]
    fn multiplicative(&mut self) -> PResult<Node> {
        let mut n = self.unary()?;
        while self.cur().ty == TokType::Op && matches!(self.cur().value.as_str(), "*" | "/" | "%") {
            let op = self.cur().value.clone();
            self.i += 1;
            let r = self.unary()?;
            let (line, col) = (n.line, n.col);
            n = Node::new(Kind::Bin { op, left: Box::new(n), right: Box::new(r) }, line, col);
        }
        Ok(n)
    }

    #[inline(always)]
    fn unary(&mut self) -> PResult<Node> {
        if self.cur().ty == TokType::Kw("await") {
            self.enter_depth()?;
            let t = self.cur().clone();
            self.i += 1;
            let v = self.unary();
            self.leave_depth();
            return Ok(Node::new(Kind::Await(Box::new(v?)), t.line, t.col));
        }
        if self.cur().ty == TokType::Op && self.cur().value == "-" {
            self.enter_depth()?;
            let t = self.cur().clone();
            self.i += 1;
            let v = self.unary();
            self.leave_depth();
            return Ok(Node::new(Kind::Unary { op: "-".into(), operand: Box::new(v?) }, t.line, t.col));
        }
        // typeof operator — pass through to JS
        if self.cur().ty == TokType::Ident && self.cur().value == "typeof" {
            let t = self.cur().clone();
            self.i += 1;
            let v = self.unary()?;
            return Ok(Node::new(Kind::Unary { op: "typeof ".into(), operand: Box::new(v) }, t.line, t.col));
        }
        self.postfix()
    }

    #[inline(always)]
    fn postfix(&mut self) -> PResult<Node> {
        let mut n = self.atom()?;
        loop {
            match self.cur().ty {
                TokType::LParen => n = self.call(n)?,
                TokType::Dot => {
                    self.i += 1;
                    let name = self.ident()?;
                    let (line, col) = (n.line, n.col);
                    n = Node::new(Kind::Attr { obj: Box::new(n), name }, line, col);
                }
                TokType::Op if self.cur().value == "?." => {
                    self.i += 1;
                    if self.cur().ty == TokType::LBrack {
                        self.i += 1;
                        let idx = self.expr()?;
                        self.eat(TokType::RBrack)?;
                        let (line, col) = (n.line, n.col);
                        n = Node::new(Kind::OptIndex { obj: Box::new(n), index: Box::new(idx) }, line, col);
                    } else {
                        let name = self.ident()?;
                        let (line, col) = (n.line, n.col);
                        n = Node::new(Kind::OptAttr { obj: Box::new(n), name }, line, col);
                    }
                }
                TokType::LBrack => {
                    self.i += 1;
                    // Slice: xs[start:stop]. Python's most-used list idiom and
                    // there is no JS equivalent, so it gets its own node.
                    let start = if self.cur().ty == TokType::Colon { None } else { Some(self.expr()?) };
                    if self.cur().ty == TokType::Colon {
                        self.i += 1;
                        let stop = if self.cur().ty == TokType::RBrack { None } else { Some(self.expr()?) };
                        self.eat(TokType::RBrack)?;
                        let (line, col) = (n.line, n.col);
                        n = Node::new(
                            Kind::Slice {
                                obj: Box::new(n),
                                start: start.map(Box::new),
                                stop: stop.map(Box::new),
                            },
                            line,
                            col,
                        );
                        continue;
                    }
                    let idx = match start {
                        Some(e) => e,
                        None => return Err(self.err("expected an index or a slice".into())),
                    };
                    self.eat(TokType::RBrack)?;
                    let (line, col) = (n.line, n.col);
                    n = Node::new(Kind::Index { obj: Box::new(n), index: Box::new(idx) }, line, col);
                }
                _ => break,
            }
        }
        Ok(n)
    }

    fn call(&mut self, func: Node) -> PResult<Node> {
        let (line, col) = (func.line, func.col);
        self.eat(TokType::LParen)?;
        let mut args = Vec::new();
        let mut kwargs = Vec::new();
        let mut depth: i32 = 0;

        loop {
            self.skip_bracket_newlines(&mut depth);
            if self.cur().ty == TokType::RParen {
                break;
            }
            if self.cur().ty == TokType::Op && (self.cur().value == "*" || self.cur().value == "**") {
                self.i += 1;
                args.push(Node::new(Kind::Spread(Box::new(self.expr()?)), line, col));
            } else if self.cur().ty == TokType::Ident
                && self.peek(1).ty == TokType::Op
                && self.peek(1).value == "="
            {
                let key = self.ident()?;
                self.i += 1; // '='
                kwargs.push((key, self.expr()?));
            } else {
                args.push(self.expr()?);
            }

            if self.cur().ty == TokType::Comma {
                self.i += 1;
            } else if matches!(self.cur().ty, TokType::Newline | TokType::Indent | TokType::Dedent) {
                continue;
            } else {
                break;
            }
        }
        self.skip_bracket_newlines(&mut depth);
        self.eat(TokType::RParen)?;
        Ok(Node::new(Kind::Call { func: Box::new(func), args, kwargs }, line, col))
    }

    fn atom(&mut self) -> PResult<Node> {
        let t = self.cur().clone();
        match t.ty {
            TokType::String => {
                self.i += 1;
                Ok(Node::new(Kind::Str { value: t.value, is_f: false }, t.line, t.col))
            }
            TokType::FString => {
                self.i += 1;
                let parts = self.parse_fstring(&t)?;
                Ok(Node::new(Kind::FString(parts), t.line, t.col))
            }
            TokType::Number => {
                self.i += 1;
                Ok(Node::new(Kind::Num(t.value), t.line, t.col))
            }
            TokType::Ident => {
                self.i += 1;
                Ok(Node::new(Kind::Name(t.value), t.line, t.col))
            }
            TokType::Kw("True") => {
                self.i += 1;
                Ok(Node::new(Kind::Bool(true), t.line, t.col))
            }
            TokType::Kw("False") => {
                self.i += 1;
                Ok(Node::new(Kind::Bool(false), t.line, t.col))
            }
            TokType::Kw("None") => {
                self.i += 1;
                Ok(Node::new(Kind::Null, t.line, t.col))
            }
            TokType::Kw("lambda") => {
                self.i += 1;
                let mut params = Vec::new();
                let mut defaults = Vec::new();
                if self.cur().ty != TokType::Colon {
                    loop {
                        let pname = self.ident()?;
                        // `lambda m=mode: ...` — Python's early-binding default.
                        // This is the idiom that makes a lambda inside a `for`
                        // capture the CURRENT value instead of the last one.
                        if self.cur().ty == TokType::Op && self.cur().value == "=" {
                            self.i += 1;
                            let d = self.expr()?;
                            params.push(pname);
                            defaults.push(Some(d));
                        } else {
                            params.push(pname);
                            defaults.push(None);
                        }
                        if self.cur().ty == TokType::Comma {
                            self.i += 1;
                        } else {
                            break;
                        }
                    }
                }
                self.eat(TokType::Colon)?;
                let body = self.expr()?;
                Ok(Node::new(
                    Kind::Lambda { params, defaults, body: Box::new(body) },
                    t.line,
                    t.col,
                ))
            }
            TokType::LBrack => {
                self.i += 1;
                let mut depth: i32 = 0;
                self.skip_bracket_newlines(&mut depth);
                if self.cur().ty == TokType::RBrack {
                    self.i += 1;
                    return Ok(Node::new(Kind::List(Vec::new()), t.line, t.col));
                }
                let first = self.expr()?;
                // list comprehension
                if self.cur().ty == TokType::Kw("for") {
                    self.i += 1;
                    let mut targets = Vec::new();
                    let has_paren = if self.cur().ty == TokType::LParen {
                        self.i += 1;
                        true
                    } else {
                        false
                    };
                    targets.push(self.ident()?);
                    while self.cur().ty == TokType::Comma {
                        self.i += 1;
                        if has_paren && self.cur().ty == TokType::RParen {
                            break;
                        }
                        targets.push(self.ident()?);
                    }
                    if has_paren {
                        self.eat(TokType::RParen)?;
                    }
                    let target = if targets.len() == 1 {
                        targets.into_iter().next().unwrap()
                    } else {
                        format!("[{}]", targets.join(", "))
                    };
                    self.eat(TokType::Kw("in"))?;
                    // `coalesce()` not `expr()`: an `if` here filters, it is not a ternary.
                    let iter = self.coalesce()?;
                    let mut cond = None;
                    if self.cur().ty == TokType::Kw("if") {
                        self.i += 1;
                        cond = Some(Box::new(self.coalesce()?));
                    }
                    self.skip_bracket_newlines(&mut depth);
                    self.eat(TokType::RBrack)?;
                    return Ok(Node::new(
                        Kind::Comprehension { expr: Box::new(first), target, iter: Box::new(iter), cond },
                        t.line,
                        t.col,
                    ));
                }
                let mut items = vec![first];
                loop {
                    self.skip_bracket_newlines(&mut depth);
                    if self.cur().ty != TokType::Comma {
                        break;
                    }
                    self.i += 1;
                    self.skip_bracket_newlines(&mut depth);
                    if self.cur().ty == TokType::RBrack {
                        break;
                    }
                    items.push(self.expr()?);
                }
                self.skip_bracket_newlines(&mut depth);
                self.eat(TokType::RBrack)?;
                Ok(Node::new(Kind::List(items), t.line, t.col))
            }
            TokType::LBrace => {
                self.i += 1;
                let mut depth: i32 = 0;
                self.skip_bracket_newlines(&mut depth);
                let mut pairs = Vec::new();
                while self.cur().ty != TokType::RBrace {
                    // `{**spread, ...}` -> `{...spread, ...}`
                    if self.cur().ty == TokType::Op && self.cur().value == "**" {
                        self.i += 1;
                        let v = self.expr()?;
                        pairs.push((None, Node::new(Kind::Spread(Box::new(v)), t.line, t.col)));
                        self.skip_bracket_newlines(&mut depth);
                        if self.cur().ty == TokType::Comma {
                            self.i += 1;
                            self.skip_bracket_newlines(&mut depth);
                            continue;
                        }
                        break;
                    }
                    let key = self.expr()?;
                    if self.cur().ty == TokType::Colon {
                        self.i += 1;
                        let v = self.expr()?;
                        pairs.push((Some(key), v));
                    } else {
                        pairs.push((None, key));
                    }
                    self.skip_bracket_newlines(&mut depth);
                    if self.cur().ty == TokType::Comma {
                        self.i += 1;
                        self.skip_bracket_newlines(&mut depth);
                    } else {
                        break;
                    }
                }
                self.skip_bracket_newlines(&mut depth);
                self.eat(TokType::RBrace)?;
                Ok(Node::new(Kind::Dict(pairs), t.line, t.col))
            }
            TokType::LParen => {
                self.i += 1;
                let mut depth: i32 = 0;
                self.skip_bracket_newlines(&mut depth);
                if self.cur().ty == TokType::RParen {
                    self.i += 1;
                    return Ok(Node::new(Kind::Tuple(Vec::new()), t.line, t.col));
                }
                let first = self.expr()?;
                if self.cur().ty == TokType::Comma {
                    let mut items = vec![first];
                    while self.cur().ty == TokType::Comma {
                        self.i += 1;
                        self.skip_bracket_newlines(&mut depth);
                        if self.cur().ty == TokType::RParen {
                            break;
                        }
                        items.push(self.expr()?);
                    }
                    self.skip_bracket_newlines(&mut depth);
                    self.eat(TokType::RParen)?;
                    return Ok(Node::new(Kind::Tuple(items), t.line, t.col));
                }
                self.skip_bracket_newlines(&mut depth);
                self.eat(TokType::RParen)?;
                Ok(first)
            }
            _ => Err(self
                .err(format!(
                    "unexpected {:?} ({:?}) — expected an expression",
                    t.ty, t.value
                ))
                .with_hint("check for a missing comma or a stray operator")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{FPart, Kind};

    fn parse(src: &str) -> Node {
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        let toks = crate::lexer::lex(src).expect("lex failed");
        Parser::new(toks, lines).module().expect("parse failed")
    }

    fn parse_err(src: &str) -> CompileError {
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        match crate::lexer::lex(src) {
            Err(e) => e,
            Ok(toks) => Parser::new(toks, lines).module().expect_err("expected a parse error"),
        }
    }

    fn stmts(src: &str) -> Vec<Node> {
        match parse(src).kind {
            Kind::Module(s) => s,
            other => panic!("expected a module, got {:?}", other),
        }
    }

    /// The body of the first component in the source.
    fn body(src: &str) -> Vec<Node> {
        match stmts(src).into_iter().next().unwrap().kind {
            Kind::Component { body, .. } => body,
            other => panic!("expected a component, got {:?}", other),
        }
    }

    /// Dig the first expression out of a component body, unwrapping the
    /// statement wrappers a test might write around it: `div: <expr>` (a tree
    /// whose only child is the expression) and `if <expr>:` (whose test is the
    /// expression we are after).
    fn first_expr(src: &str) -> Node {
        fn unwrap_stmt(n: Node) -> Node {
            match n.kind {
                Kind::ExprStmt(e) => *e,
                Kind::Assign { value, .. } => *value,
                Kind::AugAssign { value, .. } => *value,
                Kind::If { test, .. } => *test,
                Kind::Tree { body, .. } => match body.into_iter().next() {
                    Some(child) => unwrap_stmt(child),
                    None => panic!("tree block had no children"),
                },
                other => panic!("expected an expression statement, got {:?}", other),
            }
        }
        unwrap_stmt(body(src).into_iter().next().unwrap())
    }

    // ------------------------------------------------------------ module shape

    #[test]
    fn empty_source_parses_to_an_empty_module() {
        assert!(stmts("").is_empty());
        assert!(stmts("\n\n# just a comment\n").is_empty());
    }

    #[test]
    fn component_name_and_body_are_captured() {
        let s = stmts("component Widget():\n    div: \"x\"\n");
        match &s[0].kind {
            Kind::Component { name, params, body } => {
                assert_eq!(name, "Widget");
                assert!(params.is_empty());
                assert_eq!(body.len(), 1);
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn multiple_components_parse_in_order() {
        let s = stmts("component A():\n    div: \"a\"\n\ncomponent B():\n    span: \"b\"\n");
        let names: Vec<_> = s
            .iter()
            .map(|n| match &n.kind {
                Kind::Component { name, .. } => name.clone(),
                other => panic!("got {:?}", other),
            })
            .collect();
        assert_eq!(names, vec!["A", "B"]);
    }

    // ------------------------------------------------------------------- params

    #[test]
    fn params_capture_name_type_and_default() {
        let s = stmts("component Btn(label: str, count: int = 0, on_click=None):\n    button: label\n");
        match &s[0].kind {
            Kind::Component { params, .. } => {
                assert_eq!(params.len(), 3);
                assert_eq!(params[0].name, "label");
                assert_eq!(params[0].ty.as_deref(), Some("string"));
                assert!(!params[0].has_default);
                assert_eq!(params[1].name, "count");
                assert!(params[1].has_default);
                assert_eq!(params[2].name, "on_click");
                assert!(params[2].has_default);
                assert!(matches!(params[2].default.as_ref().unwrap().kind, Kind::Null));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn trailing_comma_in_params_is_allowed() {
        let s = stmts("component A(x: int, y: int,):\n    div: \"z\"\n");
        match &s[0].kind {
            Kind::Component { params, .. } => assert_eq!(params.len(), 2),
            other => panic!("got {:?}", other),
        }
    }

    // -------------------------------------------------------------- type mapping

    fn ty_of(src: &str) -> String {
        match &stmts(src)[0].kind {
            Kind::Component { params, .. } => params[0].ty.clone().unwrap(),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn primitive_types_map_to_typescript() {
        assert_eq!(ty_of("component A(x: str):\n    div: \"z\"\n"), "string");
        assert_eq!(ty_of("component A(x: int):\n    div: \"z\"\n"), "number");
        assert_eq!(ty_of("component A(x: float):\n    div: \"z\"\n"), "number");
        assert_eq!(ty_of("component A(x: bool):\n    div: \"z\"\n"), "boolean");
        assert_eq!(ty_of("component A(x: Any):\n    div: \"z\"\n"), "any");
    }

    #[test]
    fn generic_types_map_to_typescript() {
        assert_eq!(ty_of("component A(x: list[str]):\n    div: \"z\"\n"), "Array<string>");
        assert_eq!(
            ty_of("component A(x: dict[str, int]):\n    div: \"z\"\n"),
            "Record<string, number>"
        );
        assert_eq!(
            ty_of("component A(x: list[dict[str, int]]):\n    div: \"z\"\n"),
            "Array<Record<string, number>>"
        );
    }

    #[test]
    fn optional_union_types_map_to_typescript() {
        assert_eq!(ty_of("component A(x: str | None):\n    div: \"z\"\n"), "string | null");
        assert_eq!(ty_of("component A(x: None):\n    div: \"z\"\n"), "null");
    }

    #[test]
    fn dotted_and_unknown_types_pass_through() {
        assert_eq!(ty_of("component A(x: Foo.Bar):\n    div: \"z\"\n"), "Foo.Bar");
        assert_eq!(ty_of("component A(x: MyType):\n    div: \"z\"\n"), "MyType");
    }

    // -------------------------------------------------------------- expressions

    #[test]
    fn comparison_operators_become_strict() {
        for (src, want) in [("x == 1", "==="), ("x != 1", "!==")] {
            match first_expr(&format!("component A():\n    if {}:\n        p: \"y\"\n", src)).kind {
                Kind::Bin { op, .. } => assert_eq!(op, want, "for {}", src),
                other => panic!("got {:?}", other),
            }
        }
    }

    #[test]
    fn boolean_words_become_js_operators() {
        for (src, want) in [("a and b", "&&"), ("a or b", "||")] {
            match first_expr(&format!("component A():\n    if {}:\n        p: \"y\"\n", src)).kind {
                Kind::Bin { op, .. } => assert_eq!(op, want, "for {}", src),
                other => panic!("got {:?}", other),
            }
        }
    }

    #[test]
    fn not_becomes_bang() {
        match first_expr("component A():\n    if not a:\n        p: \"y\"\n").kind {
            Kind::Unary { op, .. } => assert_eq!(op, "!"),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn precedence_matches_python() {
        // 1 + 2 * 3 parses as 1 + (2 * 3)
        let e = first_expr("component A():\n    x = 1 + 2 * 3\n");
        match e.kind {
            Kind::Bin { op, right, .. } => {
                assert_eq!(op, "+");
                assert!(matches!(right.kind, Kind::Bin { ref op, .. } if op == "*"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn and_binds_tighter_than_or() {
        // a or b and c parses as a || (b && c)
        match first_expr("component A():\n    if a or b and c:\n        p: \"y\"\n").kind {
            Kind::Bin { op, right, .. } => {
                assert_eq!(op, "||");
                assert!(matches!(right.kind, Kind::Bin { ref op, .. } if op == "&&"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn unary_minus_is_preserved() {
        let e = first_expr("component A():\n    x = -1\n");
        assert!(matches!(e.kind, Kind::Unary { ref op, .. } if op == "-"));
    }

    #[test]
    fn ternary_parses_with_test_body_and_orelse() {
        let e = first_expr("component A():\n    p: \"y\" if a else \"n\"\n");
        match e.kind {
            Kind::Ternary { test, body, orelse } => {
                assert!(matches!(test.kind, Kind::Name(ref n) if n == "a"));
                assert!(matches!(body.kind, Kind::Str { .. }));
                assert!(matches!(orelse.kind, Kind::Str { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn lambda_parses_params_and_body() {
        let e = first_expr("component A():\n    f = lambda x: x + 1\n");
        match e.kind {
            Kind::Lambda { params, body, .. } => {
                assert_eq!(params, vec!["x"]);
                assert!(matches!(body.kind, Kind::Bin { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn lambda_without_params_is_allowed() {
        let e = first_expr("component A():\n    f = lambda: 1\n");
        assert!(matches!(e.kind, Kind::Lambda { ref params, .. } if params.is_empty()));
    }

    #[test]
    fn nested_lambda_parses() {
        let e = first_expr("component A():\n    f = lambda x: lambda y: x + y\n");
        match e.kind {
            Kind::Lambda { body, .. } => {
                assert!(matches!(body.kind, Kind::Lambda { .. }), "got {:?}", body.kind)
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn lambda_with_default_parses() {
        let e = first_expr("component A():\n    f = lambda m=mode: m\n");
        match e.kind {
            Kind::Lambda { defaults, .. } => {
                assert_eq!(defaults.len(), 1);
                assert!(defaults[0].is_some());
            }
            other => panic!("got {:?}", other),
        }
    }

    // ------------------------------------------------------------- collections

    #[test]
    fn empty_collections_parse() {
        assert!(matches!(first_expr("component A():\n    x = []\n").kind, Kind::List(ref v) if v.is_empty()));
        assert!(matches!(first_expr("component A():\n    x = {}\n").kind, Kind::Dict(ref v) if v.is_empty()));
        assert!(matches!(first_expr("component A():\n    x = ()\n").kind, Kind::Tuple(ref v) if v.is_empty()));
    }

    #[test]
    fn list_literal_keeps_items_and_trailing_comma() {
        assert!(matches!(first_expr("component A():\n    x = [1, 2, 3]\n").kind, Kind::List(ref v) if v.len() == 3));
        assert!(matches!(first_expr("component A():\n    x = [1, 2, 3,]\n").kind, Kind::List(ref v) if v.len() == 3));
    }

    #[test]
    fn dict_literal_keeps_keys_and_values() {
        match first_expr("component A():\n    d = {\"a\": 1, \"b\": 2}\n").kind {
            Kind::Dict(pairs) => {
                assert_eq!(pairs.len(), 2);
                assert!(pairs[0].0.is_some());
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn dict_shorthand_has_no_key() {
        match first_expr("component A():\n    d = {a, b}\n").kind {
            Kind::Dict(pairs) => {
                assert_eq!(pairs.len(), 2);
                assert!(pairs[0].0.is_none());
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn tuple_literal_becomes_a_tuple_node() {
        assert!(matches!(first_expr("component A():\n    t = (1, 2)\n").kind, Kind::Tuple(ref v) if v.len() == 2));
    }

    #[test]
    fn parenthesised_expression_is_not_a_tuple() {
        assert!(matches!(first_expr("component A():\n    x = (1 + 2)\n").kind, Kind::Bin { .. }));
    }

    // ----------------------------------------------------------- comprehensions

    #[test]
    fn comprehension_map_form_parses() {
        match first_expr("component A():\n    ys = [x * 2 for x in xs]\n").kind {
            Kind::Comprehension { target, cond, .. } => {
                assert_eq!(target, "x");
                assert!(cond.is_none());
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn comprehension_filter_form_parses() {
        match first_expr("component A():\n    ys = [x for x in xs if x > 1]\n").kind {
            Kind::Comprehension { target, cond, .. } => {
                assert_eq!(target, "x");
                assert!(cond.is_some());
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn comprehension_if_is_a_filter_not_a_ternary() {
        // `if` after `in` must bind as the filter, so the iter is just `xs`.
        match first_expr("component A():\n    ys = [x for x in xs if x]\n").kind {
            Kind::Comprehension { iter, cond, .. } => {
                assert!(matches!(iter.kind, Kind::Name(ref n) if n == "xs"), "iter was {:?}", iter.kind);
                assert!(cond.is_some());
            }
            other => panic!("got {:?}", other),
        }
    }

    // ------------------------------------------------------------------ postfix

    #[test]
    fn call_with_positional_and_keyword_args_parses() {
        match first_expr("component A():\n    input(value=x, on_change=go)\n").kind {
            Kind::Call { args, kwargs, .. } => {
                assert!(args.is_empty());
                assert_eq!(kwargs.len(), 2);
                assert_eq!(kwargs[0].0, "value");
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn call_with_spread_parses() {
        match first_expr("component A():\n    div(*items, cls=\"x\")\n").kind {
            Kind::Call { args, .. } => assert!(matches!(args[0].kind, Kind::Spread(_))),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn newlines_inside_call_parens_are_insignificant() {
        let src = "component A():\n    input(\n        value=x,\n        on_change=go\n    )\n";
        match first_expr(src).kind {
            Kind::Call { kwargs, .. } => assert_eq!(kwargs.len(), 2),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn newlines_inside_list_brackets_are_insignificant() {
        let src = "component A():\n    xs = [\n        1,\n        2,\n    ]\n";
        assert!(matches!(first_expr(src).kind, Kind::List(ref v) if v.len() == 2));
    }

    #[test]
    fn attribute_and_index_chains_parse() {
        match first_expr("component A():\n    x = a.b[0].c\n").kind {
            Kind::Attr { obj, name } => {
                assert_eq!(name, "c");
                assert!(matches!(obj.kind, Kind::Index { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    // ---------------------------------------------------------------- statements

    #[test]
    fn assignment_target_and_value_parse() {
        match &body("component A():\n    x = 1\n")[0].kind {
            Kind::Assign { target, value } => {
                assert!(matches!(target.kind, Kind::Name(ref n) if n == "x"));
                assert!(matches!(value.kind, Kind::Num(ref n) if n == "1"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn tuple_unpack_becomes_a_tuple_target() {
        match &body("component A():\n    a, b = pair()\n")[0].kind {
            Kind::Assign { target, .. } => {
                assert!(matches!(target.kind, Kind::Tuple(ref v) if v.len() == 2))
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn augmented_assignment_captures_the_operator() {
        for (src, want) in [("+=", "+"), ("-=", "-"), ("*=", "*"), ("/=", "/")] {
            let n = &body(&format!("component A():\n    x {}= 1\n", want))[0];
            match &n.kind {
                Kind::AugAssign { op, .. } => assert_eq!(op, want, "for {}", src),
                other => panic!("got {:?}", other),
            }
        }
    }

    #[test]
    fn def_parses_name_params_and_return_type() {
        match &body("component A():\n    def go(n: int) -> int:\n        return n\n")[0].kind {
            Kind::Def { name, params, body } => {
                assert_eq!(name, "go");
                assert_eq!(params.len(), 1);
                assert_eq!(body.len(), 1);
                assert!(matches!(body[0].kind, Kind::Return(_)));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn return_statement_parses() {
        match &body("component A():\n    def go():\n        return 1\n")[0].kind {
            Kind::Def { body, .. } => assert!(matches!(body[0].kind, Kind::Return(_))),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn statement_if_captures_orelse() {
        match &body("component A():\n    if a:\n        go()\n    else:\n        stop()\n")[0].kind {
            Kind::If { orelse, .. } => assert!(orelse.is_some()),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn elif_becomes_a_nested_if_in_orelse() {
        match &body("component A():\n    if a:\n        x()\n    elif b:\n        y()\n")[0].kind {
            Kind::If { orelse, .. } => match &orelse.as_ref().unwrap()[0].kind {
                Kind::If { test, .. } => assert!(matches!(test.kind, Kind::Name(ref n) if n == "b")),
                other => panic!("got {:?}", other),
            },
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn statement_for_captures_target_and_iter() {
        match &body("component A():\n    for x in xs:\n        go(x)\n")[0].kind {
            Kind::For { target, iter, .. } => {
                assert_eq!(target, "x");
                assert!(matches!(iter.kind, Kind::Name(ref n) if n == "xs"));
            }
            other => panic!("got {:?}", other),
        }
    }

    // ------------------------------------------------------------------- imports

    #[test]
    fn from_import_keeps_module_and_names() {
        match &stmts("from serpent import state, effect\n")[0].kind {
            Kind::Import { from, names } => {
                assert_eq!(from.as_deref(), Some("serpent"));
                assert_eq!(names, &vec!["state".to_string(), "effect".to_string()]);
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn bare_import_has_no_module() {
        match &stmts("import serpent\n")[0].kind {
            Kind::Import { from, names } => {
                assert!(from.is_none());
                assert_eq!(names, &vec!["serpent".to_string()]);
            }
            other => panic!("got {:?}", other),
        }
    }

    // -------------------------------------------------------------------- trees

    #[test]
    fn tree_block_captures_head_and_children() {
        match &body("component A():\n    div:\n        span: \"x\"\n")[0].kind {
            Kind::Tree { head, body } => {
                assert!(matches!(head.kind, Kind::Name(ref n) if n == "div"));
                assert_eq!(body.len(), 1);
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn tree_block_with_call_head_keeps_kwargs() {
        match &body("component A():\n    div(cls=\"x\"):\n        span: \"y\"\n")[0].kind {
            Kind::Tree { head, .. } => match &head.kind {
                Kind::Call { kwargs, .. } => assert_eq!(kwargs[0].0, "cls"),
                other => panic!("got {:?}", other),
            },
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn empty_tree_block_has_no_children() {
        match &body("component A():\n    br:\n")[0].kind {
            Kind::Tree { body, .. } => assert!(body.is_empty()),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn inline_tree_child_is_a_single_statement() {
        match &body("component A():\n    h1: \"Hello\"\n")[0].kind {
            Kind::Tree { body, .. } => assert_eq!(body.len(), 1),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn deeply_nested_trees_parse() {
        // 7 levels of element nesting: div > section > ul > li > span > em.
        let src = "component A():\n    div:\n        section:\n            ul:\n                li:\n                    span:\n                        em: \"deep\"\n";
        let mut n = &body(src)[0];
        let mut depth = 0;
        while let Kind::Tree { body, .. } = &n.kind {
            depth += 1;
            match body.first() {
                Some(child) => n = child,
                None => break,
            }
        }
        assert_eq!(depth, 6, "expected 6 nested tree levels");
    }

    #[test]
    fn if_and_for_inside_a_tree_parse_as_children() {
        let src = "component A():\n    div:\n        if a:\n            p: \"y\"\n        for x in xs:\n            li: x\n";
        match &body(src)[0].kind {
            Kind::Tree { body, .. } => {
                assert_eq!(body.len(), 2);
                assert!(matches!(body[0].kind, Kind::If { .. }));
                assert!(matches!(body[1].kind, Kind::For { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    // ------------------------------------------------------------------ f-strings

    #[test]
    fn fstring_splits_literals_and_expressions() {
        let e = first_expr("component A():\n    div: f\"hi {name}\"\n");
        match e.kind {
            Kind::FString(parts) => {
                assert_eq!(parts.len(), 2);
                assert!(matches!(parts[0], FPart::Lit(ref s) if s == "hi "));
                assert!(matches!(parts[1], FPart::Expr(_)));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn fstring_interpolation_is_parsed_not_copied() {
        // A ternary inside `{}` must become a real expression node.
        let e = first_expr("component A():\n    div: f\"{'a' if x else 'b'}\"\n");
        match e.kind {
            Kind::FString(parts) => match &parts[0] {
                FPart::Expr(n) => assert!(matches!(n.kind, Kind::Ternary { .. }), "got {:?}", n.kind),
                other => panic!("got {:?}", other),
            },
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn fstring_escaped_braces_become_literal_braces() {
        let e = first_expr("component A():\n    div: f\"{{literal}}\"\n");
        match e.kind {
            Kind::FString(parts) => {
                assert_eq!(parts.len(), 1);
                assert!(matches!(parts[0], FPart::Lit(ref s) if s == "{literal}"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn fstring_escaped_close_brace_is_literal() {
        let e = first_expr("component A():\n    div: f\"a}}b\"\n");
        match e.kind {
            Kind::FString(parts) => {
                assert!(matches!(parts[0], FPart::Lit(ref s) if s == "a}b"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn fstring_with_string_containing_a_brace_parses() {
        // The `}` inside the quoted string must not close the interpolation.
        let e = first_expr("component A():\n    div: f\"{d['}']}\"\n");
        assert!(matches!(e.kind, Kind::FString(_)));
    }

    #[test]
    fn malformed_fstring_errors_instead_of_panicking() {
        // `f"` alone is caught by the lexer, but an f-token with no room for
        // quotes must not slice out of bounds either.
        let err = parse_err("component A():\n    div: f\"\n");
        assert!(!err.msg.is_empty());
    }

    // ------------------------------------------------------------------- errors

    #[test]
    fn unexpected_token_reports_position_and_hint() {
        let err = parse_err("component A():\n    div:\n        x = ~~~\n");
        assert!(err.msg.contains("unexpected character") || err.msg.contains("unexpected"), "msg {:?}", err.msg);
        assert_eq!(err.line, 3);
    }

    #[test]
    fn missing_expression_has_a_hint() {
        let err = parse_err("component A():\n    x = )\n");
        assert!(err.hint.is_some());
    }

    #[test]
    fn error_line_points_at_the_offending_line() {
        let err = parse_err("component A():\n    x = 1\n    y = ~~~\n");
        assert_eq!(err.line, 3);
    }

    #[test]
    fn tree_head_must_be_an_element() {
        // Parsing succeeds; the emitter is what rejects a non-element head.
        // Here we only assert the tree node was built with the odd head.
        match &body("component A():\n    1 + 2:\n        p: \"y\"\n")[0].kind {
            Kind::Tree { .. } => {}
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn def_inside_a_tree_parses_but_is_rejected_later() {
        // The parser accepts it; the emitter is the gate that refuses it.
        let src = "component A():\n    div:\n        for x in xs:\n            def bad():\n                y()\n";
        match &body(src)[0].kind {
            Kind::Tree { body, .. } => assert!(matches!(body[0].kind, Kind::For { .. })),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn optional_chaining_and_nullish_coalescing_parse() {
        let e = first_expr("component A():\n    x = user?.profile?.name ?? \"anon\"\n");
        match e.kind {
            Kind::Bin { op, left, right } => {
                assert_eq!(op, "??");
                match left.kind {
                    Kind::OptAttr { obj, name } => {
                        assert_eq!(name, "name");
                        assert!(matches!(obj.kind, Kind::OptAttr { .. }));
                    }
                    other => panic!("expected OptAttr, got {:?}", other),
                }
                assert!(matches!(right.kind, Kind::Str { .. }));
            }
            other => panic!("expected Bin with ??, got {:?}", other),
        }
    }

    #[test]
    fn in_comparison_parses() {
        let e = first_expr("component A():\n    x = item in items\n");
        match e.kind {
            Kind::Bin { op, left, right } => {
                assert_eq!(op, "in");
                assert!(matches!(left.kind, Kind::Name(ref n) if n == "item"));
                assert!(matches!(right.kind, Kind::Name(ref n) if n == "items"));
            }
            other => panic!("expected Bin with in, got {:?}", other),
        }
    }

    #[test]
    fn comprehension_tuple_target_parses() {
        let e = first_expr("component A():\n    x = [v for k, v in items]\n");
        match e.kind {
            Kind::Comprehension { target, .. } => {
                assert_eq!(target, "[k, v]");
            }
            other => panic!("expected Comprehension, got {:?}", other),
        }
    }

    #[test]
    fn unclosed_brace_in_fstring_rejected() {
        let err = parse_err("component A():\n    x = f\"hello {world\"\n");
        assert!(err.msg.contains("unclosed '{' in f-string"), "got {:?}", err.msg);
    }

    #[test]
    fn recursion_depth_limit_enforced() {
        let nested = format!("component A():\n    x = {}1{}\n", "(".repeat(270), ")".repeat(270));
        let builder = std::thread::Builder::new().stack_size(8 * 1024 * 1024);
        let handler = builder.spawn(move || {
            let err = parse_err(&nested);
            assert!(err.msg.contains("maximum recursion depth exceeded"), "got {:?}", err.msg);
        }).unwrap();
        handler.join().unwrap();
    }
}
