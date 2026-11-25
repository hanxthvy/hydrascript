//! Statements: declarations, control flow, imports, classes.

use crate::ast::{CaseArm, Kind, Node, Param};
use crate::lexer::{TokType, Token};

use super::*;

impl Parser {
    /// Consume `:` then either an inline statement or an indented block.
    pub(super) fn block(&mut self) -> PResult<Vec<Node>> {
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

    pub(super) fn stmt(&mut self) -> PResult<Node> {
        self.enter_depth()?;
        let res = self.stmt_inner();
        self.leave_depth();
        res
    }

    pub(super) fn stmt_inner(&mut self) -> PResult<Node> {
        let t = self.cur().clone();
        // A decorator before a top-level `def` / `class`:
        //     @memo
        //     def f(): ...
        // desugars to `f = memo(f)`, which is what Python does.
        if t.ty == TokType::Op && t.value == "@" {
            self.i += 1;
            let deco = self.ident_or_dotted()?;
            self.skip_newlines();
            let inner = self.stmt()?;
            let name = match &inner.kind {
                Kind::Def { name, .. }
                | Kind::AsyncDef { name, .. }
                | Kind::Class { name, .. } => name.clone(),
                _ => {
                    return Err(self
                        .err("a decorator must be followed by `def` or `class`".to_string())
                        .with_hint("remove the decorator or move it above a definition"))
                }
            };
            // `@dataclass` is special: it synthesises `__init__` from the
            // annotated class attributes, which is the whole point of the
            // decorator. Anything else wraps the definition in a call.
            if deco == "dataclass" {
                if let Kind::Class {
                    name,
                    base,
                    methods,
                    body,
                } = &inner.kind
                {
                    let mut new_methods: Vec<Node> = Vec::new();
                    let mut fields: Vec<(String, Option<Node>)> = Vec::new();
                    let mut kept_body: Vec<Node> = Vec::new();
                    // Annotated field declarations (`x: int = 0`) are stored
                    // as `Assign` with the spelling kept in the target, so the
                    // default expression is what identifies a field here.
                    for st in body {
                        if let Kind::Assign { target, value } = &st.kind {
                            if let Kind::Name(n) = &target.kind {
                                fields.push((n.clone(), Some((**value).clone())));
                                continue;
                            }
                        }
                        kept_body.push(st.clone());
                    }
                    if !fields.is_empty() {
                        // __init__(self, x=default, y=default): self.x = x ...
                        let mut params: Vec<Param> = vec![Param {
                            name: "self".to_string(),
                            ty: None,
                            default: None,
                            has_default: false,
                        }];
                        let mut assigns: Vec<Node> = Vec::new();
                        for (fname, fdefault) in &fields {
                            params.push(Param {
                                name: fname.clone(),
                                ty: None,
                                default: fdefault.clone(),
                                has_default: fdefault.is_some(),
                            });
                            assigns.push(Node::new(
                                Kind::Assign {
                                    target: Box::new(Node::new(
                                        Kind::Attr {
                                            obj: Box::new(Node::new(
                                                Kind::Name("self".to_string()),
                                                t.line,
                                                t.col,
                                            )),
                                            name: fname.clone(),
                                        },
                                        t.line,
                                        t.col,
                                    )),
                                    value: Box::new(Node::new(
                                        Kind::Name(fname.clone()),
                                        t.line,
                                        t.col,
                                    )),
                                },
                                t.line,
                                t.col,
                            ));
                        }
                        new_methods.push(Node::new(
                            Kind::Method {
                                name: "__init__".to_string(),
                                params,
                                body: assigns,
                                is_async: false,
                                decorator: None,
                            },
                            t.line,
                            t.col,
                        ));
                    }
                    new_methods.extend(methods.clone());
                    return Ok(Node::new(
                        Kind::Class {
                            name: name.clone(),
                            base: base.clone(),
                            methods: new_methods,
                            body: kept_body,
                        },
                        t.line,
                        t.col,
                    ));
                }
            }
            // A decorated definition is emitted as the definition followed by
            // `name = deco(name)`, which is exactly Python's order of events.
            // Emitting `deco(def ...)` instead puts a statement inside an
            // expression, which is not JavaScript and not what we want.
            let _ = name;
            return Ok(Node::new(
                Kind::DecoratedDef {
                    decorators: vec![deco],
                    inner: Box::new(inner),
                },
                t.line,
                t.col,
            ));
        }
        match &t.ty {
            TokType::Kw("component") => return self.component(),
            TokType::Kw("async") => return self.async_def(),
            TokType::Kw("export") => return self.export_stmt(),
            TokType::Kw("def") => return self.def(),
            TokType::Kw("class") => return self.class_def(),
            TokType::Kw("import") => return self.import(),
            TokType::Kw("from") => return self.from_import(),
            TokType::Kw("interface") => return self.interface_decl(),
            // `type` is a TypeScript keyword (`type X = ...`) but also Python's
            // most-used introspection builtin. A `(` after it means the builtin.
            TokType::Kw("type") if self.peek(1).ty == TokType::LParen => {}
            TokType::Kw("type") => return self.type_alias(),
            TokType::Kw("raise") => {
                self.i += 1;
                let val = if matches!(
                    self.cur().ty,
                    TokType::Newline | TokType::Dedent | TokType::Eof
                ) {
                    None
                } else {
                    Some(Box::new(self.expr()?))
                };
                return Ok(Node::new(Kind::Raise(val), t.line, t.col));
            }
            TokType::Kw("assert") => {
                self.i += 1;
                let test = self.expr()?;
                let message = if self.cur().ty == TokType::Comma {
                    self.i += 1;
                    Some(Box::new(self.expr()?))
                } else {
                    None
                };
                return Ok(Node::new(
                    Kind::Assert {
                        test: Box::new(test),
                        message,
                    },
                    t.line,
                    t.col,
                ));
            }
            TokType::Kw("return") => {
                self.i += 1;
                let val = if matches!(
                    self.cur().ty,
                    TokType::Newline | TokType::Dedent | TokType::Eof
                ) {
                    None
                } else {
                    // `return 1, 2` returns a tuple, which is an array — the
                    // comma is not a statement separator here.
                    let first = self.expr()?;
                    if self.cur().ty == TokType::Comma {
                        let mut items = vec![first];
                        while self.cur().ty == TokType::Comma {
                            self.i += 1;
                            if matches!(
                                self.cur().ty,
                                TokType::Newline | TokType::Dedent | TokType::Eof
                            ) {
                                break;
                            }
                            items.push(self.expr()?);
                        }
                        Some(Box::new(Node::new(Kind::Tuple(items), t.line, t.col)))
                    } else {
                        Some(Box::new(first))
                    }
                };
                return Ok(Node::new(Kind::Return(val), t.line, t.col));
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
            TokType::Kw("yield") => {
                self.i += 1;
                let val = if matches!(
                    self.cur().ty,
                    TokType::Newline | TokType::Dedent | TokType::Eof
                ) {
                    None
                } else {
                    Some(Box::new(self.expr()?))
                };
                return Ok(Node::new(Kind::Yield(val), t.line, t.col));
            }
            _ => {}
        }

        // Arrow function: `x => x * 2`. JavaScript's lambda syntax reaches
        // HydraScript sources often enough (callbacks, event maps) that it is
        // worth accepting directly rather than rejecting as a stray operator.
        if self.cur().ty == TokType::Ident && self.peek(1).ty == TokType::Arrow {
            let params = vec![self.ident()?];
            self.i += 1; // =>
            let body = self.expr()?;
            return Ok(Node::new(
                Kind::Lambda {
                    params,
                    defaults: vec![None],
                    body: Box::new(body),
                },
                t.line,
                t.col,
            ));
        }
        let e = self.expr()?;
        self.finish_assignment(e, &t)
    }

    /// Parse `a, b = ...` / `a = b = ...` / plain `a = ...` after the target
    /// expression has been read. All three are Python assignment forms that do
    /// not exist in JavaScript; each gets its own node so the emitter can pick
    /// the right shape (`let [a, b] = ...`, `let a, b, c; a = b = c = 0`).
    pub(super) fn finish_assignment(&mut self, e: Node, t: &Token) -> PResult<Node> {
        // tuple target:  a, b = ...
        let e = if self.cur().ty == TokType::Comma {
            let mut items = vec![e];
            while self.cur().ty == TokType::Comma {
                self.i += 1;
                if self.cur().ty == TokType::Op && self.cur().value == "=" {
                    break;
                }
                if matches!(self.cur().ty, TokType::Newline | TokType::Dedent | TokType::Eof) {
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
            return Ok(Node::new(
                Kind::Tree {
                    head: Box::new(e),
                    body,
                },
                t.line,
                t.col,
            ));
        }
        if self.cur().ty == TokType::Op && self.cur().value == "=" {
            self.i += 1;
            // Chained assignment: `a = b = c = 0`. The inner chain is parsed
            // recursively and flattened, so the emitter can declare all the
            // names it must declare.
            let mut value = self.expr_list()?;
            let mut targets: Vec<Node> = Vec::new();
            let tuple_target = matches!(e.kind, Kind::Tuple(_));
            if let Kind::Tuple(items) = e.kind.clone() {
                targets.extend(items);
            } else {
                targets.push(e);
            }
            while self.cur().ty == TokType::Op && self.cur().value == "=" {
                self.i += 1;
                let next = self.expr_list()?;
                // The right-hand side of the previous step becomes a target.
                let prev_value = value;
                match prev_value.kind.clone() {
                    Kind::Tuple(items) => targets.extend(items),
                    _ => targets.push(prev_value),
                }
                value = next;
            }
            if targets.len() == 1 {
                return Ok(Node::new(
                    Kind::Assign {
                        target: Box::new(targets.pop().unwrap()),
                        value: Box::new(value),
                    },
                    t.line,
                    t.col,
                ));
            }
            // `a = b = c = 0` is a chain; `a, b = b, a` is a parallel
            // assignment, and the two must not be confused: treating the second
            // as a chain produced `a = b = [b, a]`, which is valid JS that
            // assigns the whole array to both names.
            if tuple_target {
                return Ok(Node::new(
                    Kind::TupleAssign {
                        targets,
                        value: Box::new(value),
                    },
                    t.line,
                    t.col,
                ));
            }
            return Ok(Node::new(
                Kind::ChainedAssign {
                    targets,
                    value: Box::new(value),
                },
                t.line,
                t.col,
            ));
        }
        if self.cur().ty == TokType::Op
            && matches!(
                self.cur().value.as_str(),
                "+=" | "-=" | "*=" | "/=" | "%=" | "**=" | "//="
            )
        {
            let raw = self.cur().value.clone();
            self.i += 1;
            let v = self.expr()?;
            return Ok(Node::new(
                Kind::AugAssign {
                    target: Box::new(e),
                    op: raw,
                    value: Box::new(v),
                },
                t.line,
                t.col,
            ));
        }
        Ok(Node::new(Kind::ExprStmt(Box::new(e)), t.line, t.col))
    }

    /// Parse an expression list: `a, b, c` becomes a Tuple. Python allows a
    /// bare comma sequence on the right of an assignment and in a return, and
    /// treating those as separate statements is how `x, y = y, x` broke.
    pub(super) fn expr_list(&mut self) -> PResult<Node> {
        let t = self.cur().clone();
        let first = self.expr()?;
        if self.cur().ty != TokType::Comma {
            return Ok(first);
        }
        let mut items = vec![first];
        while self.cur().ty == TokType::Comma {
            self.i += 1;
            if matches!(
                self.cur().ty,
                TokType::Newline | TokType::Dedent | TokType::Eof
            ) {
                break;
            }
            items.push(self.expr()?);
        }
        Ok(Node::new(Kind::Tuple(items), t.line, t.col))
    }

    /// The binding before `in` in a comprehension: `x`, or `k, v` / `(k, v)`.
    /// Returns the JS destructuring target — `x`, or `[k, v]`.
    ///
    /// Shared by list, dict and set comprehensions. The list path grew tuple
    /// support first and the other two did not, so `{k: v for k, v in pairs}`
    /// failed to parse with `expected Kw("in"), found Comma` while
    /// `[v for k, v in pairs]` worked. One helper, so they cannot drift again.
    pub(super) fn comprehension_target(&mut self) -> PResult<String> {
        let has_paren = if self.cur().ty == TokType::LParen {
            self.i += 1;
            true
        } else {
            false
        };
        let mut targets = vec![self.ident()?];
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
        Ok(if targets.len() == 1 {
            targets.into_iter().next().unwrap()
        } else {
            format!("[{}]", targets.join(", "))
        })
    }

    /// The `for x in xs if cond` tail of a comprehension. `key`/`value` are the
    /// parts emitted per element; for a set comprehension `value` is None and
    /// the key doubles as the element.
    pub(super) fn comprehension_tail(
        &mut self,
        key: Node,
        value: Option<Node>,
        is_dict: bool,
        t: &Token,
    ) -> PResult<Node> {
        self.eat(TokType::Kw("for"))?;
        let target = self.comprehension_target()?;
        self.eat(TokType::Kw("in"))?;
        // `coalesce()` rather than `expr()`: an `if` after the iterable filters,
        // it is not a ternary.
        let iter = self.coalesce()?;
        let cond = if self.cur().ty == TokType::Kw("if") {
            self.i += 1;
            Some(Box::new(self.coalesce()?))
        } else {
            None
        };
        let kind = if is_dict {
            Kind::DictComprehension {
                key: Box::new(key),
                value: Box::new(value.unwrap_or_else(|| Node::new(Kind::Null, t.line, t.col))),
                target,
                iter: Box::new(iter),
                cond,
            }
        } else {
            Kind::SetComprehension {
                expr: Box::new(key),
                target,
                iter: Box::new(iter),
                cond,
            }
        };
        Ok(Node::new(kind, t.line, t.col))
    }

    pub(super) fn import(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("import"))?.clone();
        if self.cur().ty == TokType::String {
            let raw = self.cur().value.clone();
            self.i += 1;
            let mod_name = raw[1..raw.len() - 1].to_string();
            if self.cur().ty == TokType::Kw("as") {
                self.i += 1;
                let alias = self.ident_or_kw()?;
                return Ok(Node::new(
                    Kind::Import {
                        from: Some(mod_name),
                        names: vec![format!("* as {}", alias)],
                    },
                    t.line,
                    t.col,
                ));
            }
            return Ok(Node::new(
                Kind::Import {
                    from: Some(mod_name),
                    names: Vec::new(),
                },
                t.line,
                t.col,
            ));
        }
        // Bare `import x` / `import x as y`. The `as` form is a namespace
        // import (`import * as y from 'x'`), which is what makes a library's
        // members reachable as `y.member`.
        let first = self.ident_or_kw()?;
        if self.cur().ty == TokType::Kw("as") {
            self.i += 1;
            let alias = self.ident_or_kw()?;
            return Ok(Node::new(
                Kind::Import {
                    from: Some(first),
                    names: vec![format!("* as {}", alias)],
                },
                t.line,
                t.col,
            ));
        }
        let mut names = vec![first];
        while self.cur().ty == TokType::Comma {
            self.i += 1;
            names.push(self.ident_or_kw()?);
        }
        Ok(Node::new(Kind::Import { from: None, names }, t.line, t.col))
    }

    pub(super) fn from_import(&mut self) -> PResult<Node> {
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
        Ok(Node::new(
            Kind::Import {
                from: Some(module),
                names,
            },
            t.line,
            t.col,
        ))
    }

    pub(super) fn component(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("component"))?.clone();
        let name = self.ident()?;
        let params = if self.cur().ty == TokType::LParen {
            self.params()?
        } else {
            Vec::new()
        };
        let body = self.block()?;
        Ok(Node::new(
            Kind::Component { name, params, body },
            t.line,
            t.col,
        ))
    }

    /// `interface Name:` block — collect raw lines of the indented body and pass through as TS.
    pub(super) fn interface_decl(&mut self) -> PResult<Node> {
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
        Ok(Node::new(
            Kind::Interface {
                name: full_name,
                body,
            },
            t.line,
            t.col,
        ))
    }

    /// `type Name = ...` — collect everything until newline as TS type alias.
    pub(super) fn type_alias(&mut self) -> PResult<Node> {
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

    /// Collect all tokens in an indented block and join them as raw text.
    /// Used for interface/type bodies that should pass through to TypeScript verbatim.
    pub(super) fn raw_indented_block(&mut self) -> PResult<String> {
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

    pub(super) fn def(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("def"))?.clone();
        let name = self.ident()?;
        let params = if self.cur().ty == TokType::LParen {
            self.params()?
        } else {
            Vec::new()
        };
        if self.cur().ty == TokType::Arrow {
            self.i += 1;
            self.type_expr()?;
        }
        let body = self.block()?;
        Ok(Node::new(Kind::Def { name, params, body }, t.line, t.col))
    }

    pub(super) fn params(&mut self) -> PResult<Vec<Param>> {
        self.eat(TokType::LParen)?;
        let mut depth: i32 = 0;
        self.skip_bracket_newlines(&mut depth);
        let mut out = Vec::new();
        while self.cur().ty != TokType::RParen {
            self.skip_bracket_newlines(&mut depth);
            let prefix = if self.cur().ty == TokType::Op
                && (self.cur().value == "*" || self.cur().value == "**")
            {
                self.i += 1;
                "..."
            } else {
                ""
            };
            let ident = self.ident_or_kw()?;
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
            out.push(Param {
                name,
                ty,
                default,
                has_default,
            });
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

    pub(super) fn if_stmt(&mut self) -> PResult<Node> {
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
            Kind::If {
                test: Box::new(test),
                body,
                orelse,
            },
            t.line,
            t.col,
        ))
    }

    pub(super) fn elif(&mut self) -> PResult<Node> {
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
            Kind::If {
                test: Box::new(test),
                body,
                orelse,
            },
            t.line,
            t.col,
        ))
    }

    pub(super) fn for_stmt(&mut self) -> PResult<Node> {
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
            Kind::For {
                target,
                iter: Box::new(iter),
                body,
            },
            t.line,
            t.col,
        ))
    }

    pub(super) fn while_stmt(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("while"))?.clone();
        let test = self.expr()?;
        let body = self.block()?;
        Ok(Node::new(
            Kind::While {
                test: Box::new(test),
                body,
            },
            t.line,
            t.col,
        ))
    }

    /// `try: ... except Cls as e: ... except: ... else: ... finally: ...`
    pub(super) fn try_stmt(&mut self) -> PResult<Node> {
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
            handlers.push(crate::ast::Except {
                class,
                name,
                body: hbody,
            });
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
            Kind::Try {
                body,
                handlers,
                orelse,
                finally,
            },
            t.line,
            t.col,
        ))
    }

    pub(super) fn match_stmt(&mut self) -> PResult<Node> {
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

    pub(super) fn async_def(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("async"))?.clone();
        self.eat(TokType::Kw("def"))?;
        let name = self.ident()?;
        let params = if self.cur().ty == TokType::LParen {
            self.params()?
        } else {
            Vec::new()
        };
        if self.cur().ty == TokType::Arrow {
            self.i += 1;
            self.type_expr()?;
        }
        let body = self.block()?;
        Ok(Node::new(
            Kind::AsyncDef { name, params, body },
            t.line,
            t.col,
        ))
    }

    /// `class Name(Base):` with `def` methods and `NAME = value` properties.
    pub(super) fn class_def(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("class"))?.clone();
        let name = self.ident()?;
        let base = if self.cur().ty == TokType::LParen {
            self.i += 1;
            if self.cur().ty == TokType::RParen {
                self.i += 1;
                None
            } else {
                let b = self.ident_or_dotted()?;
                // `class Foo(Base, Mixin)` is refused, and the refusal is the
                // whole feature: JavaScript has one prototype chain, so a second
                // base has to be emulated, and every emulation differs from
                // Python somewhere the author cannot see — which base wins for a
                // diamond, whether `super()` walks the MRO, what
                // `isinstance(x, Both)` answers. Emitting one of those
                // silently is the failure mode this compiler refuses everywhere
                // else.
                //
                // The hint used to end "or use a .hys file", which was a lie: the
                // parse is shared and `.hys` failed identically. A hint that
                // sends someone to a target with the same limitation costs them
                // the time to discover that, so the real options are named.
                if self.cur().ty == TokType::Comma {
                    return Err(self
                        .err("multiple inheritance is not supported".to_string())
                        .with_hint(
                            "JavaScript has one prototype chain, so a second base \
                             would silently differ from Python\n\
                             = extend one base and hold the other as a member, \
                             or copy the methods you need",
                        ));
                }
                self.eat(TokType::RParen)?;
                Some(b)
            }
        } else {
            None
        };
        self.eat(TokType::Colon)?;
        self.skip_newlines();
        self.eat(TokType::Indent)?;
        let mut methods: Vec<Node> = Vec::new();
        let mut body: Vec<Node> = Vec::new();
        while !matches!(self.cur().ty, TokType::Dedent | TokType::Eof) {
            self.skip_newlines();
            if matches!(self.cur().ty, TokType::Dedent | TokType::Eof) {
                break;
            }
            // `@staticmethod` / `@property` / `@classmethod` before a method.
            let decorator = if self.cur().ty == TokType::Op && self.cur().value == "@" {
                self.i += 1;
                Some(self.ident()?)
            } else {
                None
            };
            // The decorated `def` sits on the next line.
            if decorator.is_some() {
                self.skip_newlines();
            }
            let mt = self.cur().clone();
            let is_async = self.cur().ty == TokType::Kw("async");
            if is_async {
                self.i += 1;
            }
            if self.cur().ty == TokType::Kw("def") {
                self.i += 1;
                let mname = self.ident()?;
                let params = self.params()?;
                let mbody = self.block()?;
                methods.push(Node::new(
                    Kind::Method {
                        name: mname,
                        params,
                        body: mbody,
                        is_async,
                        decorator,
                    },
                    mt.line,
                    mt.col,
                ));
            } else {
                // A plain statement in the class body (usually `NAME = value`).
                body.push(self.stmt()?);
            }
        }
        // The class body's `Dedent` closes the block; consume it so the next
        // top-level statement starts cleanly.
        if self.cur().ty == TokType::Dedent {
            self.i += 1;
        }
        // `class Foo: pass` — the `pass` lands in the class body.
        body.retain(|n| !matches!(n.kind, Kind::Pass));
        Ok(Node::new(
            Kind::Class {
                name,
                base,
                methods,
                body,
            },
            t.line,
            t.col,
        ))
    }

    pub(super) fn export_stmt(&mut self) -> PResult<Node> {
        let t = self.eat(TokType::Kw("export"))?.clone();
        // `export default ...` is a distinct JS form — emitting `export` and
        // then `default` produced the two broken lines `export` / `default;`.
        if self.cur().ty == TokType::Ident && self.cur().value == "default" {
            self.i += 1;
            let inner = self.stmt()?;
            return Ok(Node::new(Kind::ExportDefault(Box::new(inner)), t.line, t.col));
        }
        let inner = self.stmt()?;
        Ok(Node::new(Kind::Export(Box::new(inner)), t.line, t.col))
    }

    // ----------------------------------------------------------- expressions
}
