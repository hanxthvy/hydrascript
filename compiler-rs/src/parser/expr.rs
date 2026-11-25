//! Expressions: precedence climbing from ternary down to atom.

use crate::ast::{Kind, Node};
use crate::error::CompileError;
use crate::lexer::{TokType, Token};

use super::*;

impl Parser {
    pub(super) fn expr(&mut self) -> PResult<Node> {
        // Each expression gets its own chain budget: `f(a.b.b…, c.d.d…)` is two
        // chains, not one.
        self.chain = 0;
        self.enter_depth()?;
        let res = self.ternary();
        self.leave_depth();
        res
    }

    #[inline(always)]
    pub(super) fn ternary(&mut self) -> PResult<Node> {
        let n = self.coalesce()?;
        if self.cur().ty == TokType::Kw("if") {
            self.enter_depth()?;
            self.i += 1;
            let test = self.coalesce()?;
            self.eat(TokType::Kw("else"))?;
            let orelse = self.ternary()?;
            self.leave_depth();
            let (line, col) = (n.line, n.col);
            self.chain_step(line, col)?;
            return Ok(Node::new(
                Kind::Ternary {
                    test: Box::new(test),
                    body: Box::new(n),
                    orelse: Box::new(orelse),
                },
                line,
                col,
            ));
        }
        Ok(n)
    }

    #[inline(always)]
    pub(super) fn coalesce(&mut self) -> PResult<Node> {
        let mut n = self.or()?;
        while self.cur().ty == TokType::Op && self.cur().value == "??" {
            self.i += 1;
            let r = self.or()?;
            let (line, col) = (n.line, n.col);
            self.chain_step(line, col)?;
            n = Node::new(
                Kind::Bin {
                    op: "??".into(),
                    left: Box::new(n),
                    right: Box::new(r),
                },
                line,
                col,
            );
        }
        Ok(n)
    }

    #[inline(always)]
    pub(super) fn or(&mut self) -> PResult<Node> {
        let mut n = self.and()?;
        while self.cur().ty == TokType::Kw("or") {
            self.i += 1;
            let r = self.and()?;
            let (line, col) = (n.line, n.col);
            self.chain_step(line, col)?;
            n = Node::new(
                Kind::Bin {
                    op: "||".into(),
                    left: Box::new(n),
                    right: Box::new(r),
                },
                line,
                col,
            );
        }
        Ok(n)
    }

    #[inline(always)]
    pub(super) fn and(&mut self) -> PResult<Node> {
        let mut n = self.not()?;
        while self.cur().ty == TokType::Kw("and") {
            self.i += 1;
            let r = self.not()?;
            let (line, col) = (n.line, n.col);
            self.chain_step(line, col)?;
            n = Node::new(
                Kind::Bin {
                    op: "&&".into(),
                    left: Box::new(n),
                    right: Box::new(r),
                },
                line,
                col,
            );
        }
        Ok(n)
    }

    #[inline(always)]
    pub(super) fn not(&mut self) -> PResult<Node> {
        if self.cur().ty == TokType::Kw("not") {
            self.enter_depth()?;
            let t = self.cur().clone();
            self.i += 1;
            let v = self.not()?;
            self.leave_depth();
            return Ok(Node::new(
                Kind::Unary {
                    op: "!".into(),
                    operand: Box::new(v),
                },
                t.line,
                t.col,
            ));
        }
        self.comparison()
    }

    #[inline(always)]
    pub(super) fn comparison(&mut self) -> PResult<Node> {
        let first = self.additive()?;
        let mut ops: Vec<String> = Vec::new();
        let mut operands: Vec<Node> = vec![first];
        loop {
            // `not in` is written with `not` FIRST, so it is checked before the
            // plain operator cases. `is not` is the mirror image.
            let negated_membership = self.cur().ty == TokType::Kw("not")
                && self.peek(1).ty == TokType::Kw("in");
            let is_is = self.cur().ty == TokType::Kw("is");
            let is_in = self.cur().ty == TokType::Kw("in");
            if !negated_membership
                && !is_is
                && !is_in
                && !(self.cur().ty == TokType::Op
                    && matches!(
                        self.cur().value.as_str(),
                        "==" | "!=" | "<" | ">" | "<=" | ">="
                    ))
            {
                break;
            }

            let membership = is_in || negated_membership;
            let mut op = if membership {
                "in".to_string()
            } else if is_is {
                "is".to_string()
            } else {
                match self.cur().value.as_str() {
                    "==" => "===".to_string(),
                    "!=" => "!==".to_string(),
                    other => other.to_string(),
                }
            };
            self.i += 1;
            if negated_membership {
                self.i += 1; // consume `in`
            }
            // `is not` — the negation belongs to the operator, not to the operand.
            if is_is && self.cur().ty == TokType::Kw("not") {
                self.i += 1;
                op = "is not".to_string();
            }
            let r = self.additive()?;

            if membership {
                let (line, col) = (operands[operands.len() - 1].line, operands[operands.len() - 1].col);
                let left = operands.pop().unwrap();
                operands.push(Node::new(
                    Kind::Contains {
                        item: Box::new(left),
                        container: Box::new(r),
                        negated: negated_membership,
                    },
                    line,
                    col,
                ));
            } else {
                ops.push(op);
                operands.push(r);
            }
        }
        if ops.is_empty() {
            return Ok(operands.pop().unwrap());
        }
        if ops.len() == 1 && operands.len() == 2 {
            let (line, col) = (operands[0].line, operands[0].col);
            let right = operands.pop().unwrap();
            let left = operands.pop().unwrap();
            return Ok(Node::new(
                Kind::Bin {
                    op: ops.pop().unwrap(),
                    left: Box::new(left),
                    right: Box::new(right),
                },
                line,
                col,
            ));
        }
        // `0 < x < 10` — Python chains, JavaScript does not. Comparing a boolean
        // with a number is valid JS that answers the wrong question, so this
        // becomes an `&&` chain.
        let (line, col) = (operands[0].line, operands[0].col);
        Ok(Node::new(
            Kind::ChainedCompare { ops, operands },
            line,
            col,
        ))
    }

    #[inline(always)]
    pub(super) fn additive(&mut self) -> PResult<Node> {
        let mut n = self.multiplicative()?;
        while self.cur().ty == TokType::Op && matches!(self.cur().value.as_str(), "+" | "-") {
            let op = self.cur().value.clone();
            self.i += 1;
            let r = self.multiplicative()?;
            let (line, col) = (n.line, n.col);
            self.chain_step(line, col)?;
            n = Node::new(
                Kind::Bin {
                    op,
                    left: Box::new(n),
                    right: Box::new(r),
                },
                line,
                col,
            );
        }
        Ok(n)
    }

    #[inline(always)]
    pub(super) fn power(&mut self) -> PResult<Node> {
        // Python's `**` is right-associative and binds tighter than unary minus
        // on the right: `-2 ** 2` is `-(2 ** 2)`, and `2 ** 3 ** 2` is `2 ** (3 ** 2)`.
        // JS `Math.pow` has neither property, so the call form carries it.
        let base = self.unary()?;
        if self.cur().ty == TokType::Op && self.cur().value == "**" {
            self.i += 1;
            let exp = self.power()?;
            let (line, col) = (base.line, base.col);
            return Ok(Node::new(
                Kind::Call {
                    func: Box::new(Node::new(Kind::Name("pow".into()), line, col)),
                    args: vec![base, exp],
                    kwargs: Vec::new(),
                },
                line,
                col,
            ));
        }
        Ok(base)
    }

    #[inline(always)]
    pub(super) fn multiplicative(&mut self) -> PResult<Node> {
        let mut n = self.power()?;
        while self.cur().ty == TokType::Op
            && matches!(self.cur().value.as_str(), "*" | "/" | "%" | "//")
        {
            let raw = self.cur().value.clone();
            self.i += 1;
            let r = self.power()?;
            // `//` is floor division; JS `/` truncates toward zero, which is a
            // different answer for negatives, so it goes through Math.floor.
            let op = if raw == "//" { "floordiv".to_string() } else { raw };
            let (line, col) = (n.line, n.col);
            self.chain_step(line, col)?;
            n = Node::new(
                Kind::Bin {
                    op,
                    left: Box::new(n),
                    right: Box::new(r),
                },
                line,
                col,
            );
        }
        Ok(n)
    }

    #[inline(always)]
    pub(super) fn unary(&mut self) -> PResult<Node> {
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
            return Ok(Node::new(
                Kind::Unary {
                    op: "-".into(),
                    operand: Box::new(v?),
                },
                t.line,
                t.col,
            ));
        }
        // `new Foo(args)` — constructor call. Parsed at unary level, then the
        // whole postfix chain is wrapped, so `new Foo().bar` keeps JavaScript's
        // precedence ((new Foo()).bar).
        if self.cur().ty == TokType::Kw("new") {
            self.enter_depth()?;
            let t = self.cur().clone();
            self.i += 1;
            let target = self.postfix();
            self.leave_depth();
            return Ok(Node::new(Kind::New(Box::new(target?)), t.line, t.col));
        }
        // typeof operator — pass through to JS
        if self.cur().ty == TokType::Ident && self.cur().value == "typeof" {
            let t = self.cur().clone();
            self.i += 1;
            let v = self.unary()?;
            return Ok(Node::new(
                Kind::Unary {
                    op: "typeof ".into(),
                    operand: Box::new(v),
                },
                t.line,
                t.col,
            ));
        }
        self.postfix()
    }

    #[inline(always)]
    pub(super) fn postfix(&mut self) -> PResult<Node> {
        let mut n = self.atom()?;
        // `super()` and `super().__init__(x)` are the two spellings of a parent
        // constructor call, and neither is an ordinary member expression: `super` is
        // not a value, so `super(...)` is syntax, and `super.__init__` does not exist.
        //
        // This is why the rewrite cannot live in `atom`. `super` is followed by `(`
        // and NOT by `.` — the empty parentheses come first — so a check for `.` in
        // atom never fires; it consumes `()` as an argument list, and the `.` then
        // applies to the whole call, printing `super().__init__(props)`. Both forms
        // are collapsed here instead, where the token stream is visible ahead.
        if matches!(n.kind, Kind::Super) {
            let (line, col) = (n.line, n.col);
            self.chain_step(line, col)?;
            if self.cur().ty == TokType::LParen {
                let after = n;
                n = self.call(after)?;
                // `super()` followed by `.<member>(args)`.
                //
                // This used to accept ONLY `__init__`, so every other parent
                // method was a parse error: `super().greet("x")` reported
                // "unexpected Dot". The README recorded that as a limitation of
                // KEYWORD arguments, which undersold it — nothing worked, with
                // keywords or without. The member is carried through as
                // `SuperMember` and the emitter decides the spelling, because
                // that is where `__init__` has to become a bare `super(...)`.
                if self.cur().ty == TokType::Dot && self.peek(1).ty == TokType::Ident {
                    let member = match &self.peek(1).ty {
                        TokType::Ident => self.peek(1).value.clone(),
                        _ => unreachable!("guarded by the peek above"),
                    };
                    self.i += 2;
                    if self.cur().ty == TokType::LParen {
                        n = self.call(Node::new(
                            Kind::SuperMember { member },
                            line,
                            col,
                        ))?;
                    } else {
                        // `super().name` with no call: not a value in JS either,
                        // so report it here rather than emit nonsense.
                        return Err(CompileError::new(
                            format!("`super().{}` is not a call", member),
                            line,
                            col,
                            Vec::new(),
                        )
                        .with_hint("JS has no value for `super`; call a parent method: `super().name(...)`"));
                    }
                }
                return Ok(n);
            }
        }
        loop {
            match self.cur().ty {
                TokType::LParen => {
                    // `f()()()…` is a chain too, and the only one whose node is
                    // built inside `call()` rather than here — so it needs its own
                    // count or 900 calls overflow the stack during emit.
                    self.chain_step(n.line, n.col)?;
                    n = self.call(n)?;
                }
                // `` tag`text` `` — a tagged template. The token after an expression
                // belongs to it, and leaving it out split the call in two statements.
                TokType::Template => {
                    let t = self.cur().clone();
                    self.i += 1;
                    let (line, col) = (n.line, n.col);
                    self.chain_step(line, col)?;
                    n = Node::new(
                        Kind::TaggedTemplate {
                            tag: Box::new(n),
                            raw: t.value,
                        },
                        line,
                        col,
                    );
                }
                TokType::Dot => {
                    self.i += 1;
                    let name = self.ident_or_kw()?;
                    let (line, col) = (n.line, n.col);
                    self.chain_step(line, col)?;
                    n = Node::new(
                        Kind::Attr {
                            obj: Box::new(n),
                            name,
                        },
                        line,
                        col,
                    );
                }
                TokType::Op if self.cur().value == "?." => {
                    self.i += 1;
                    // `fn?.(x)` — optional CALL. Without this the parser saw `(`
                    // where it expected a property name and refused to parse,
                    // which is why callback props had to be guarded by hand.
                    if self.cur().ty == TokType::LParen {
                        let (line, col) = (n.line, n.col);
                        self.chain_step(line, col)?;
                        // `call` consumes the parentheses and hands back a
                        // normal Call; take its pieces and mark them optional.
                        let inner = self.call(n)?;
                        match inner.kind {
                            Kind::Call { func, args, kwargs } => {
                                n = Node::new(Kind::OptCall { func, args, kwargs }, line, col);
                            }
                            other => {
                                n = Node::new(other, line, col);
                            }
                        }
                        continue;
                    }
                    if self.cur().ty == TokType::LBrack {
                        self.i += 1;
                        let idx = self.expr()?;
                        self.eat(TokType::RBrack)?;
                        let (line, col) = (n.line, n.col);
                        self.chain_step(line, col)?;
                        n = Node::new(
                            Kind::OptIndex {
                                obj: Box::new(n),
                                index: Box::new(idx),
                            },
                            line,
                            col,
                        );
                    } else {
                        let name = self.ident_or_kw()?;
                        let (line, col) = (n.line, n.col);
                        self.chain_step(line, col)?;
                        n = Node::new(
                            Kind::OptAttr {
                                obj: Box::new(n),
                                name,
                            },
                            line,
                            col,
                        );
                    }
                }
                TokType::LBrack => {
                    self.i += 1;
                    // Slice: xs[start:stop]. Python's most-used list idiom and
                    // there is no JS equivalent, so it gets its own node.
                    let start = if self.cur().ty == TokType::Colon {
                        None
                    } else {
                        Some(self.expr()?)
                    };
                    if self.cur().ty == TokType::Colon {
                        self.i += 1;
                        let stop = if self.cur().ty == TokType::Colon
                            || self.cur().ty == TokType::RBrack
                        {
                            None
                        } else {
                            Some(self.expr()?)
                        };
                        // `xs[::step]` — a second colon carries the step.
                        let step = if self.cur().ty == TokType::Colon {
                            self.i += 1;
                            if self.cur().ty == TokType::RBrack {
                                None
                            } else {
                                Some(self.expr()?)
                            }
                        } else {
                            None
                        };
                        self.eat(TokType::RBrack)?;
                        let (line, col) = (n.line, n.col);
                        self.chain_step(line, col)?;
                        n = Node::new(
                            Kind::Slice {
                                obj: Box::new(n),
                                start: start.map(Box::new),
                                stop: stop.map(Box::new),
                                step: step.map(Box::new),
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
                    self.chain_step(line, col)?;
                    n = Node::new(
                        Kind::Index {
                            obj: Box::new(n),
                            index: Box::new(idx),
                        },
                        line,
                        col,
                    );
                }
                _ => break,
            }
        }
        Ok(n)
    }

    pub(super) fn call(&mut self, func: Node) -> PResult<Node> {
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
            if self.cur().ty == TokType::Op && (self.cur().value == "*" || self.cur().value == "**")
            {
                self.i += 1;
                args.push(Node::new(Kind::Spread(Box::new(self.expr()?)), line, col));
            } else if (self.cur().ty == TokType::Ident || matches!(self.cur().ty, TokType::Kw(_)))
                && self.peek(1).ty == TokType::Op
                && self.peek(1).value == "="
            {
                let key = self.ident_or_kw()?;
                self.i += 1; // '='
                kwargs.push((key, self.expr()?));
            } else {
                args.push(self.expr()?);
            }

            if self.cur().ty == TokType::Comma {
                self.i += 1;
            } else if matches!(
                self.cur().ty,
                TokType::Newline | TokType::Indent | TokType::Dedent
            ) {
                continue;
            } else {
                break;
            }
        }
        self.skip_bracket_newlines(&mut depth);
        self.eat(TokType::RParen)?;
        Ok(Node::new(
            Kind::Call {
                func: Box::new(func),
                args,
                kwargs,
            },
            line,
            col,
        ))
    }

    pub(super) fn atom(&mut self) -> PResult<Node> {
        let t = self.cur().clone();
        // `super` — Python's `super().__init__(x)` becomes JS `super(x)`, and
        // a bare `super()` becomes `super`.
        //
        // `super()` alone is a complete call in JS, so consuming the name here (and
        // leaving the `(x)` to the ordinary postfix loop) produced `super(x)` only
        // because the emitter printed `super` followed by the argument list — but
        // `super().__init__(x)`, the spelling every Python `__init__` uses, printed
        // `super.__init__(x)`. That is not JS: it throws at construction time, and
        // because it happens while React builds the component tree the whole app
        // unmounts. An error boundary written this way took the entire site down
        // instead of catching anything.
        //
        // `super(...)` has no member access and no receiver, so it cannot be expressed
        // as an `Attr` — the call has to be built here, with `super` as the callee.
        if t.ty == TokType::Kw("super") {
            self.i += 1;
            let (line, col) = (t.line, t.col);
            // `super()` is completed in `postfix`, where the argument list and
            // any following member access are visible. See the note there for
            // why this cannot be done with the ordinary member path.
            return Ok(Node::new(Kind::Super, line, col));
        }
        // A JavaScript template literal: its contents are already JS, so the
        // whole raw token is passed through rather than re-parsed.
        if t.ty == TokType::Template {
            self.i += 1;
            return Ok(Node::new(Kind::TemplateLiteral(t.value), t.line, t.col));
        }
        // `import("./Page.hyx")` — the dynamic form. React.lazy needs it, and
        // without it code splitting is unreachable from the language.
        if t.ty == TokType::Kw("import")
            && self.peek(1).ty == TokType::LParen
        {
            self.i += 1;
            self.eat(TokType::LParen)?;
            let mut depth: i32 = 0;
            self.skip_bracket_newlines(&mut depth);
            let spec = self.expr()?;
            self.skip_bracket_newlines(&mut depth);
            self.eat(TokType::RParen)?;
            return Ok(Node::new(Kind::DynamicImport(Box::new(spec)), t.line, t.col));
        }
        match t.ty {
            TokType::String => {
                self.i += 1;
                Ok(Node::new(
                    Kind::Str {
                        value: t.value,
                        is_f: false,
                    },
                    t.line,
                    t.col,
                ))
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
                        let pname = self.ident_or_kw()?;
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
                    Kind::Lambda {
                        params,
                        defaults,
                        body: Box::new(body),
                    },
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
                    let target = self.comprehension_target()?;
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
                        Kind::Comprehension {
                            expr: Box::new(first),
                            target,
                            iter: Box::new(iter),
                            cond,
                        },
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
                    // `[1, *xs, 2]` — Python's unpack-in-literal. JS spells it
                    // `[...xs]`, so the star becomes a Spread node here rather
                    // than being rejected as a stray operator.
                    if self.cur().ty == TokType::Op
                        && (self.cur().value == "*" || self.cur().value == "**")
                    {
                        self.i += 1;
                        let v = self.expr()?;
                        items.push(Node::new(Kind::Spread(Box::new(v)), t.line, t.col));
                        continue;
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
                    // Dict comprehension `{k: v for k in xs}` and set
                    // comprehension `{x for x in xs}`. Neither has a JS
                    // equivalent, so both compile to a reducer expression.
                    let (is_dict, value_node) = if self.cur().ty == TokType::Colon {
                        self.i += 1;
                        (true, Some(self.expr()?))
                    } else {
                        (false, None)
                    };
                    if self.cur().ty == TokType::Kw("for") {
                        let comp = self.comprehension_tail(key.clone(), value_node, is_dict, &t)?;
                        self.skip_bracket_newlines(&mut depth);
                        self.eat(TokType::RBrace)?;
                        return Ok(comp);
                    }
                    match value_node {
                        Some(v) => pairs.push((Some(key), v)),
                        None => pairs.push((None, key)),
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
                // `(n := len(xs))` — the walrus binds a name inside an
                // expression, which is how Python reads a value and tests it at
                // the same time.
                if self.cur().ty == TokType::Ident
                    && self.peek(1).ty == TokType::Op
                    && self.peek(1).value == ":="
                {
                    let name = self.cur().value.clone();
                    self.i += 2;
                    let value = self.coalesce()?;
                    self.skip_bracket_newlines(&mut depth);
                    self.eat(TokType::RParen)?;
                    return Ok(Node::new(
                        Kind::Walrus {
                            name,
                            value: Box::new(value),
                        },
                        t.line,
                        t.col,
                    ));
                }
                let first = self.expr()?;
                // `(x) => expr` with exactly one parameter.
                if self.cur().ty == TokType::RParen
                    && self.peek(1).ty == TokType::Arrow
                    && matches!(first.kind, Kind::Name(_))
                {
                    self.i += 1; // )
                    self.i += 1; // =>
                    let params = match first.kind {
                        Kind::Name(n) => vec![n],
                        _ => unreachable!(),
                    };
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
                    // `(a, b) => expr` — JavaScript arrow with a parameter list.
                    // The parenthesised names parse as a tuple expression, so the
                    // arrow is recognised after the fact and turned into a lambda.
                    if self.cur().ty == TokType::Arrow
                        && items.iter().all(|i| matches!(i.kind, Kind::Name(_)))
                    {
                        self.i += 1;
                        let params: Vec<String> = items
                            .into_iter()
                            .map(|i| match i.kind {
                                Kind::Name(n) => n,
                                _ => unreachable!(),
                            })
                            .collect();
                        let body = self.expr()?;
                        let defaults = vec![None; params.len()];
                        return Ok(Node::new(
                            Kind::Lambda {
                                params,
                                defaults,
                                body: Box::new(body),
                            },
                            t.line,
                            t.col,
                        ));
                    }
                    return Ok(Node::new(Kind::Tuple(items), t.line, t.col));
                }
                self.skip_bracket_newlines(&mut depth);
                self.eat(TokType::RParen)?;
                Ok(first)
            }
            // A keyword used as a callable: `type(x)`, `assert(x)`, `match(x)`.
            // Python has no reserved words in this position, and the builtin
            // names collide with the TypeScript/statement keywords the lexer
            // reserves for the other target.
            TokType::Kw(kw)
                if self.peek(1).ty == TokType::LParen && kw != "not" =>
            {
                self.i += 1;
                Ok(Node::new(Kind::Name(kw.to_string()), t.line, t.col))
            }
            _ => Err(self
                .err(format!(
                    "unexpected {:?} ({:?}) — expected an expression",
                    t.ty, t.value
                ))
                .with_hint("check for a missing comma or a stray operator")),
        }
    }

    /// Python type annotation -> TypeScript type string.
    pub(super) fn type_expr(&mut self) -> PResult<String> {
        let map = |s: &str| -> String {
            match s {
                "str" => "string".into(),
                "int" | "float" => "number".into(),
                "bool" => "boolean".into(),
                "None" => "null".into(),
                "Any" => "any".into(),
                // Bare `Array` and `Record` are not valid TypeScript: both are
                // generic and require type arguments. The bare forms are
                // expanded right after this, where it is known whether a type
                // argument follows (`list[str]` -> `Array<string>`, plain
                // `list` -> `Array<any>`).
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
        } else if base == "list" {
            out = "Array<any>".into();
        } else if base == "dict" {
            out = "Record<string, any>".into();
        }
        while self.cur().ty == TokType::Op && self.cur().value == "|" {
            self.i += 1;
            out.push_str(" | ");
            out.push_str(&self.type_expr()?);
        }
        Ok(out)
    }

    pub(super) fn parse_fstring(&self, tok: &Token) -> PResult<Vec<crate::ast::FPart>> {
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
                    // Python allows a format spec and a conversion after the
                    // expression: `{x:.2f}`, `{x!r}`, `{x!r:>8}`. Splitting
                    // happens here, on the raw text, so a `:` inside a dict
                    // literal or a lambda inside `{}` is not mistaken for one.
                    let (value_src, conv, spec_src) = Self::split_placeholder(&expr_src);
                    let value_trimmed = value_src.trim().to_string();
                    if value_trimmed.is_empty() {
                        return Err(CompileError::new(
                            "empty expression in f-string",
                            tok.line,
                            tok.col,
                            self.src.clone(),
                        )
                        .with_hint("put a value between the braces, or double them for a literal brace"));
                    }
                    let sub_lines: Vec<String> =
                        value_trimmed.split('\n').map(|s| s.to_string()).collect();
                    let sub_toks = crate::lexer::lex(&value_trimmed)?;
                    let mut sub = Parser::new(sub_toks, sub_lines);
                    sub.depth = self.depth;
                    let e = sub.expr()?;
                    parts.push(FPart::Expr {
                        value: e,
                        conv: conv.map(|c| c.to_string()),
                        spec: (!spec_src.is_empty()).then(|| spec_src.to_string()),
                    });
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

    /// Split `value`, `conversion` and `format spec` out of one f-string
    /// placeholder body, in Python's grammar order: `{value!conv:spec}`.
    ///
    /// A `:` only counts as the spec separator at bracket depth zero and outside
    /// any string, so `{d['a']:>5}`, `{x if y else z}` and `{f(a, b):.2f}` all
    /// split where a reader expects. Everything that decides a split is ASCII
    /// (`:`, `!`, `=`, brackets, quotes) and a UTF-8 continuation byte is never
    /// ASCII, so scanning bytes and slicing the `&str` cannot cut a char.
    pub(super) fn split_placeholder(raw: &str) -> (&str, Option<char>, &str) {
        let b = raw.as_bytes();
        let mut depth: i32 = 0;
        let mut quote: Option<u8> = None;
        let mut i = 0;
        while i < b.len() {
            let c = b[i];
            if let Some(q) = quote {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            } else {
                match c {
                    b'"' | b'\'' => quote = Some(c),
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => depth -= 1,
                    b'!' if depth == 0 => {
                        // `!=` is an operator, not a conversion.
                        if b.get(i + 1) == Some(&b'=') {
                            i += 2;
                            continue;
                        }
                        let conv = b.get(i + 1).copied().map(|c| c as char);
                        let spec = if b.get(i + 2) == Some(&b':') {
                            &raw[(i + 3).min(raw.len())..]
                        } else {
                            ""
                        };
                        return (&raw[..i], conv, spec);
                    }
                    b':' if depth == 0 => {
                        return (&raw[..i], None, &raw[(i + 1).min(raw.len())..]);
                    }
                    _ => {}
                }
            }
            i += 1;
        }
        (raw, None, "")
    }
}
