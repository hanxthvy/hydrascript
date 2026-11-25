//! JSX emission: elements, children, fragments.

use crate::ast::{Kind, Node};
use crate::error::CompileError;

use super::*;

impl Emitter {
    pub(super) fn child(&self, s: &Node, ind: usize) -> Result<String, CompileError> {
        match &s.kind {
            // `slot` is where the parent's children are rendered — React's
            // `props.children`. Bare in the JSX it has to become an expression
            // container, or the identifier is undefined at render time.
            Kind::Name(id) if id == "slot" => Ok("{children}".to_string()),
            Kind::ExprStmt(e) if matches!(&e.kind, Kind::Name(n) if n == "slot") => {
                Ok("{children}".to_string())
            }
            Kind::Tree { .. } => self.tree(s, ind),
            Kind::ExprStmt(e) => match &e.kind {
                Kind::Str { value, is_f: false } => Ok(value[1..value.len() - 1].to_string()),
                Kind::Num(v) => Ok(v.clone()),
                Kind::Call { func, args, kwargs } if self.is_element_call(func) => {
                    self.jsx_inline(func, args, kwargs)
                }
                _ => Ok(format!("{{{}}}", self.js(e)?)),
            },
            Kind::If { test, body, orelse } => {
                let cond0 = self.js(test)?;
                let cond = crate::emitter::py_cond(&cond0);
                if cond.starts_with("truthy(") {
                    self.used_helpers.borrow_mut().insert("truthy".into());
                }
                let b = Self::as_expr(&self.frag(body, ind)?);
                if let Some(ore) = orelse {
                    if ore.len() == 1 && matches!(&ore[0].kind, Kind::If { .. }) {
                        // Elif: unwrap the nested braces so we don't emit {cond ? (...) : {elif ? ...}}.
                        let inner = self.child(&ore[0], ind)?;
                        let stripped = inner.trim().trim_start_matches('{').trim_end_matches('}');
                        return Ok(format!("{{{cond} ? ({b}) : ({stripped})}}"));
                    }
                    // An `else` that renders nothing — `{cond ? <A/> : null}` — has to
                    // become the value React renders as nothing. Passing it through
                    // emitted `({null})`, which is not an expression: esbuild stopped
                    // with "Expected ':' but found '}'".
                    if self.renders_nothing(ore) {
                        return Ok(format!("{{{cond} ? ({b}) : null}}"));
                    }
                    let o = Self::as_expr(&self.frag(ore, ind)?);
                    return Ok(format!("{{{cond} ? ({b}) : ({o})}}"));
                }
                Ok(format!("{{{cond} && ({b})}}"))
            }
            Kind::For { target, iter, body } => {
                let it = self.js(iter)?;
                // The body is an expression, so a container comes off: `{cond && <A/>}`
                // must become `cond && <A/>` or the arrow gets a BLOCK body and maps
                // everything to undefined.
                let b = Self::as_expr(&self.frag(body, ind)?);
                // A multi-target loop is spelled `for item, i in items:` and means
                // "(element, index)" — the same meaning the statement form has, where
                // it becomes `[item, i]`. Written verbatim into an arrow parameter that
                // produced `.map(([item, i]) => ...)`, which JS reads as *destructuring
                // a pair out of a scalar*, so every element that is not an array threw
                // "object is not iterable" (or, for a 2-char string, silently mapped
                // characters). An arrow can take two parameters, so the brackets come
                // off: `.map((item, i) => ...)`.
                let param = {
                    let t = target.trim();
                    if t.starts_with('[') && t.ends_with(']') {
                        t[1..t.len() - 1].to_string()
                    } else {
                        t.to_string()
                    }
                };
                Ok(format!("{{{it}.map(({param}) => ({b}))}}"))
            }
            Kind::Match { subject, cases } => {
                let s_val = self.js(subject)?;
                let mut chain = String::new();
                for c in cases.iter().rev() {
                    let b = self.frag(&c.body, ind)?;
                    let is_wildcard = match &c.pattern.kind {
                        Kind::Name(n) if n == "_" => true,
                        _ => false,
                    };
                    if is_wildcard {
                        chain = format!("({b})");
                    } else {
                        let cond = match &c.pattern.kind {
                            Kind::Bin { op, left, right } if op == "|" => {
                                format!(
                                    "(({} === {}) || ({} === {}))",
                                    s_val,
                                    self.js(left)?,
                                    s_val,
                                    self.js(right)?
                                )
                            }
                            _ => format!("({} === {})", s_val, self.js(&c.pattern)?),
                        };
                        if chain.is_empty() {
                            chain = format!("{cond} ? ({b}) : null");
                        } else {
                            chain = format!("{cond} ? ({b}) : {chain}");
                        }
                    }
                }
                Ok(format!("{{{chain}}}"))
            }
            _ => Err(CompileError::new(
                format!("`{:?}` is not allowed inside a tree block", s.kind),
                s.line,
                s.col,
                Vec::new(),
            )
            .with_hint(
                "move logic above the tree — tree blocks only accept elements, if, and for",
            )),
        }
    }

    pub(super) fn frag(&self, body: &[Node], ind: usize) -> Result<String, CompileError> {
        let mut kids = Vec::new();
        for s in body {
            kids.push(self.child(s, ind)?);
        }
        if kids.len() == 1 {
            return Ok(kids.into_iter().next().unwrap());
        }
        let pad_inner = "  ".repeat(ind + 1);
        let pad_close = "  ".repeat(ind);
        let inner = kids
            .into_iter()
            .map(|k| format!("{}{}", pad_inner, k))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(format!("<>\n{}\n{}</>", inner, pad_close))
    }

    pub fn tree(&self, n: &Node, ind: usize) -> Result<String, CompileError> {
        let (head, body) = match &n.kind {
            Kind::Tree { head, body } => (head, body),
            _ => unreachable!(),
        };

        let (tag, a) = match &head.kind {
            Kind::Name(id) => (id.clone(), String::new()),
            Kind::Attr { .. } if Self::is_element(head) => (self.js(head)?, String::new()),
            // A tree HEAD is always a tag: `main(className="x"):` is the HTML element,
            // whatever the module happens to declare elsewhere. Using
            // `is_element_call` here was wrong and broke the very module that motivated
            // that helper — PCBForge defines `def main()` as its entry point, so
            // `main(className="kolom"):` was rejected with "a tree block must start with
            // an element or component". The name-vs-tag ambiguity only exists for a CALL
            // in expression position, which is where `is_element_call` belongs.
            Kind::Call { func, args, kwargs } if Self::is_element(func) => {
                (self.js(func)?, self.attr_str(args, kwargs)?)
            }
            _ => {
                return Err(CompileError::new(
                    "a tree block must start with an element or component",
                    n.line,
                    n.col,
                    Vec::new(),
                )
                .with_hint("e.g. `div(className=\"x\"):` or `h1:`"))
            }
        };

        if body.is_empty() {
            return Ok(format!("<{}{} />", tag, a));
        }

        let mut kids = Vec::new();
        for k in body {
            kids.push(self.child(k, ind + 1)?);
        }

        // Inline single short child: <h1>Hello</h1>
        if kids.len() == 1 && !kids[0].contains('\n') && kids[0].len() < 60 {
            return Ok(format!("<{}{}>{}</{}>", tag, a, kids[0].trim(), tag));
        }

        let pad_inner = "  ".repeat(ind + 1);
        let pad_close = "  ".repeat(ind);
        let inner = kids
            .into_iter()
            .map(|k| format!("{}{}", pad_inner, k))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(format!(
            "<{}{}>\n{}\n{}</{}>",
            tag, a, inner, pad_close, tag
        ))
    }

    /// True when a branch produces no output at all.
    ///
    /// `{cond ? <A/> : null}` is the common React shape, and an empty `else:` in the
    /// source lowers to the same thing. Neither is an expression to wrap in parens.
    fn renders_nothing(&self, body: &[Node]) -> bool {
        let real: Vec<_> = body
            .iter()
            .filter(|s| !matches!(s.kind, Kind::Pass))
            .collect();
        if real.is_empty() {
            return true;
        }
        if real.len() != 1 {
            return false;
        }
        match &real[0].kind {
            Kind::Null => true,
            Kind::ExprStmt(e) => match &e.kind {
                Kind::Null => true,
                Kind::Name(n) => n == "None" || n == "null",
                _ => false,
            },
            _ => false,
        }
    }

    pub(super) fn jsx_inline(
        &self,
        func: &Node,
        args: &[Node],
        kwargs: &[(String, Node)],
    ) -> Result<String, CompileError> {
        let tag = self.js(func)?;
        let a = self.attr_str(args, kwargs)?;
        let non_spread_args: Vec<_> = args
            .iter()
            .filter(|a| !matches!(a.kind, Kind::Spread(_)))
            .collect();
        if non_spread_args.is_empty() {
            return Ok(format!("<{}{} />", tag, a));
        }
        let mut inner = String::new();
        for k in non_spread_args {
            match &k.kind {
                Kind::Str { value, is_f: false } => {
                    // Strip quotes for plain text children inside JSX.
                    inner.push_str(&value[1..value.len() - 1]);
                }
                Kind::Num(v) => inner.push_str(v),
                _ => {
                    inner.push('{');
                    inner.push_str(&self.js(k)?);
                    inner.push('}');
                }
            }
        }
        Ok(format!("<{}{}>{}</{}>", tag, a, inner, tag))
    }
}

/// True when a component body renders `slot` anywhere — including inside the
/// JSX tree it returns, which is where the marker actually appears in source.
pub(super) fn node_uses_slot(n: &Node) -> bool {
    match &n.kind {
        Kind::Name(id) => id == "slot",
        Kind::Tree { head, body } => node_uses_slot(head) || body.iter().any(node_uses_slot),
        Kind::If { body, orelse, .. } => {
            body.iter().any(node_uses_slot)
                || orelse.as_ref().is_some_and(|b| b.iter().any(node_uses_slot))
        }
        Kind::For { body, iter, .. } => node_uses_slot(iter) || body.iter().any(node_uses_slot),
        Kind::While { body, .. } => body.iter().any(node_uses_slot),
        Kind::Call { func, args, kwargs } => {
            node_uses_slot(func)
                || args.iter().any(node_uses_slot)
                || kwargs.iter().any(|(_, v)| node_uses_slot(v))
        }
        Kind::Assign { value, .. } | Kind::AugAssign { value, .. } => node_uses_slot(value),
        Kind::Bin { left, right, .. } => node_uses_slot(left) || node_uses_slot(right),
        Kind::Ternary { test, body, orelse } => {
            node_uses_slot(test) || node_uses_slot(body) || node_uses_slot(orelse)
        }
        Kind::Return(Some(v)) | Kind::Unary { operand: v, .. } => node_uses_slot(v),
        // The marker arrives wrapped in the expression statement that puts it
        // in the JSX: `div(): slot` parses as Tree{ div, [ExprStmt(Name slot)] }.
        Kind::ExprStmt(inner) => node_uses_slot(inner),
        Kind::Await(v) | Kind::Spread(v) | Kind::OptAttr { obj: v, .. } => node_uses_slot(v),
        Kind::Index { obj, index } | Kind::OptIndex { obj, index } => {
            node_uses_slot(obj) || node_uses_slot(index)
        }
        Kind::Slice { obj, start, stop, .. } => {
            node_uses_slot(obj)
                || start.as_ref().is_some_and(|v| node_uses_slot(v))
                || stop.as_ref().is_some_and(|v| node_uses_slot(v))
        }
        Kind::List(items) | Kind::Tuple(items) => items.iter().any(node_uses_slot),
        Kind::Dict(pairs) => pairs.iter().any(|(k, v)| {
            k.as_ref().is_some_and(node_uses_slot) || node_uses_slot(v)
        }),
        Kind::ChainedCompare { operands, .. } => operands.iter().any(node_uses_slot),
        Kind::Contains { item, container, .. } => {
            node_uses_slot(item) || node_uses_slot(container)
        }
        _ => false,
    }
}
