// [xihanzu-NR]
//! TSX code generator and source map builder.
//!
//! Emits clean, readable TSX and keeps an exact line-by-line map so a browser
//! stack trace points at the .hsx line that produced it.

use std::collections::HashSet;

use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;

pub static HTML_TAGS: &[&str] = &[
    "div", "span", "p", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "button",
    "input", "form", "label", "select", "option", "textarea", "img", "nav", "header", "footer",
    "main", "section", "article", "aside", "table", "thead", "tbody", "tr", "td", "th", "br",
    "hr", "pre", "code", "em", "strong", "small", "figure", "figcaption", "video", "audio",
    "canvas", "svg", "iframe", "dialog",
    // SVG elements
    "path", "g", "circle", "rect", "line", "polyline", "polygon", "text", "tspan", "defs",
    "clipPath", "symbol", "use", "ellipse", "mask", "pattern", "marker", "linearGradient",
    "radialGradient", "stop", "foreignObject",
    // HTML5 elements
    "details", "summary", "picture", "source", "track", "time", "slot", "template",
    "mark", "progress", "meter", "fieldset", "legend", "optgroup", "caption",
    "colgroup", "col", "tfoot", "kbd", "blockquote", "address",
];

pub fn prop_map(k: &str) -> String {
    if k.starts_with("aria_") || k.starts_with("data_") {
        return k.replace('_', "-");
    }
    match k {
        "class" | "cls" => "className".into(),
        "for" => "htmlFor".into(),
        "on_click" => "onClick".into(),
        "on_change" => "onChange".into(),
        "on_input" => "onInput".into(),
        "on_submit" => "onSubmit".into(),
        "on_key_down" => "onKeyDown".into(),
        "on_key_up" => "onKeyUp".into(),
        "on_blur" => "onBlur".into(),
        "on_focus" => "onFocus".into(),
        "on_mouse_enter" => "onMouseEnter".into(),
        "on_mouse_leave" => "onMouseLeave".into(),
        "on_double_click" => "onDoubleClick".into(),
        "read_only" => "readOnly".into(),
        "auto_focus" => "autoFocus".into(),
        "auto_complete" => "autoComplete".into(),
        "tab_index" => "tabIndex".into(),
        "max_length" => "maxLength".into(),
        "col_span" => "colSpan".into(),
        "row_span" => "rowSpan".into(),
        "src_set" => "srcSet".into(),
        "type_" => "type".into(),
        other => other.into(),
    }
}

pub fn str_method(m: &str) -> &str {
    match m {
        "strip" => "trim",
        "lstrip" => "trimStart",
        "rstrip" => "trimEnd",
        "upper" => "toUpperCase",
        "lower" => "toLowerCase",
        "startswith" => "startsWith",
        "endswith" => "endsWith",
        "replace" => "replaceAll",
        "find" => "indexOf",
        "split" => "split",
        "join" => "join",
        "append" => "push",
        "copy" => "slice",
        "keys" => "keys",
        "values" => "values",
        "items" => "entries",
        other => other,
    }
}

/// Python string methods with no JS equivalent. A call to one becomes a free
/// function call into the `serpent` runtime: `s.capitalize()` -> `capitalize(s)`.
pub fn free_func(m: &str) -> Option<&'static str> {
    match m {
        "capitalize" => Some("capitalize"),
        "title" => Some("title"),
        "count" => Some("count"),
        "format" => Some("format"),
        "zfill" => Some("zfill"),
        "isdigit" => Some("isDigit"),
        "isalpha" => Some("isAlpha"),
        _ => None,
    }
}

pub struct Emitter {
    pub lines: Vec<String>,
    pub linemap: Vec<usize>,
    pub cur_src: usize,
    pub depth: usize,
    pub imports: HashSet<String>,
    /// Runtime helpers the source actually used (capitalize, title, ...).
    /// Collected during emission so the import is injected only when needed.
    pub used_helpers: std::cell::RefCell<HashSet<String>>,
    pub head_lines: Vec<String>,
}

impl Emitter {
    pub fn new() -> Self {
        Self {
            lines: Vec::new(),
            linemap: Vec::new(),
            cur_src: 1,
            depth: 0,
            imports: HashSet::new(),
            used_helpers: std::cell::RefCell::new(HashSet::new()),
            head_lines: Vec::new(),
        }
    }

    fn pad(&self) -> String {
        "  ".repeat(self.depth)
    }

    pub fn w(&mut self, s: &str) {
        let line = if s.is_empty() { String::new() } else { format!("{}{}", self.pad(), s) };
        let count = line.matches('\n').count() + 1;
        self.lines.push(line);
        for _ in 0..count {
            self.linemap.push(self.cur_src);
        }
    }

    pub fn is_element(n: &Node) -> bool {
        match &n.kind {
            Kind::Name(id) => {
                HTML_TAGS.contains(&id.as_str()) || id.chars().next().map_or(false, |c| c.is_uppercase())
            }
            Kind::Attr { obj, name } => {
                match &obj.kind {
                    Kind::Name(id) => {
                        id.chars().next().map_or(false, |c| c.is_uppercase())
                            || name.chars().next().map_or(false, |c| c.is_uppercase())
                            || id == "motion"
                    }
                    _ => name.chars().next().map_or(false, |c| c.is_uppercase()),
                }
            }
            _ => false,
        }
    }

    pub fn js(&self, n: &Node) -> Result<String, CompileError> {
        match &n.kind {
            Kind::Str { value, is_f: _ } => Ok(value.clone()),
            Kind::FString(parts) => {
                use crate::ast::FPart;
                let mut out = String::from("`");
                for p in parts {
                    match p {
                        FPart::Lit(s) => {
                            for c in s.chars() {
                                // Escape what a template literal treats specially.
                                if c == '`' || c == '\\' {
                                    out.push('\\');
                                } else if c == '$' {
                                    out.push('\\');
                                }
                                out.push(c);
                            }
                        }
                        FPart::Expr(e) => {
                            out.push_str("${");
                            out.push_str(&self.js(e)?);
                            out.push('}');
                        }
                    }
                }
                out.push('`');
                Ok(out)
            }
            Kind::Num(v) => Ok(v.clone()),
            Kind::Bool(b) => Ok(if *b { "true".into() } else { "false".into() }),
            Kind::Null => Ok("null".into()),
            Kind::Name(id) => Ok(id.clone()),
            Kind::Attr { obj, name } => {
                let o = self.js(obj)?;
                Ok(format!("{}.{}", o, str_method(name)))
            }
            Kind::OptAttr { obj, name } => {
                let o = self.js(obj)?;
                Ok(format!("{}?.{}", o, str_method(name)))
            }
            Kind::Index { obj, index } => {
                let o = self.js(obj)?;
                let i = self.js(index)?;
                Ok(format!("{}[{}]", o, i))
            }
            Kind::OptIndex { obj, index } => {
                let o = self.js(obj)?;
                let i = self.js(index)?;
                Ok(format!("{}?.[{}]", o, i))
            }
            Kind::Bin { op, left, right } => {
                let l = self.js(left)?;
                let r = self.js(right)?;
                // `[1, 2] + [3]` is list concatenation in Python but string
                // coercion in JS. When either operand is a list literal the
                // intent is unambiguous, so emit a spread instead.
                // ponytail: only literals are detectable statically. `a + b` with
                // two array variables still emits `+`; add a runtime `add()`
                // helper if that ever bites.
                if op == "+"
                    && (matches!(left.kind, Kind::List(_) | Kind::Tuple(_))
                        || matches!(right.kind, Kind::List(_) | Kind::Tuple(_)))
                {
                    return Ok(format!("[...{}, ...{}]", l, r));
                }
                Ok(format!("({} {} {})", l, op, r))
            }
            Kind::Unary { op, operand } => {
                let v = self.js(operand)?;
                Ok(format!("({}{})", op, v))
            }
            Kind::Ternary { test, body, orelse } => {
                let c = self.js(test)?;
                let b = self.js(body)?;
                let o = self.js(orelse)?;
                Ok(format!("({} ? {} : {})", c, b, o))
            }
            Kind::Lambda { params, defaults, body } => {
                let b = self.js(body)?;
                // `lambda m=mode: ...` -> `((m = mode) => ...)`. JS default
                // parameters have exactly Python's early-binding semantics, so
                // this is a direct translation, not an approximation.
                let ps: Result<Vec<String>, CompileError> = params
                    .iter()
                    .zip(defaults.iter())
                    .map(|(p, d)| match d {
                        Some(dn) => Ok(format!("{} = {}", p, self.js(dn)?)),
                        None => Ok(p.clone()),
                    })
                    .collect();
                Ok(format!("(({}) => {})", ps?.join(", "), b))
            }
            Kind::List(items) => {
                let bits: Result<Vec<_>, _> = items.iter().map(|i| self.js(i)).collect();
                Ok(format!("[{}]", bits?.join(", ")))
            }
            Kind::Tuple(items) => {
                let bits: Result<Vec<_>, _> = items.iter().map(|i| self.js(i)).collect();
                Ok(format!("[{}]", bits?.join(", ")))
            }
            Kind::Spread(v) => Ok(format!("...{}", self.js(v)?)),
            Kind::Dict(pairs) => {
                let mut ps = Vec::new();
                for (k, v) in pairs {
                    let v_str = self.js(v)?;
                    if let Some(key) = k {
                        ps.push(format!("{}: {}", self.js(key)?, v_str));
                    } else {
                        ps.push(v_str);
                    }
                }
                // Wrapped in parens: an object literal is otherwise ambiguous with
                // a block body when it lands in an arrow's expression position,
                // e.g. `todos.map((t) => {...t})` — esbuild reads that as a block.
                Ok(format!("({{{}}})", ps.join(", ")))
            }
            Kind::Comprehension { expr, target, iter, cond } => {
                let it = self.js(iter)?;
                let exp = self.js(expr)?;
                let mut res = it;
                if let Some(c) = cond {
                    res = format!("{}.filter(({}) => {})", res, target, self.js(c)?);
                }
                if exp != *target {
                    res = format!("{}.map(({}) => {})", res, target, exp);
                }
                Ok(res)
            }
            Kind::Call { func, args, kwargs } => {
                // Free-function rewrite for Python string methods with no JS equivalent:
                // `s.capitalize()` -> `capitalize(s)`. The helper is imported from
                // the runtime, so record the use here.
                if let Kind::Attr { obj, name } = &func.kind {
                    if let Some(f) = free_func(name) {
                        self.used_helpers.borrow_mut().insert(f.to_string());
                        let target = self.js(obj)?;
                        let mut all = vec![target];
                        for a in args {
                            all.push(self.js(a)?);
                        }
                        return Ok(format!("{}({})", f, all.join(", ")));
                    }
                }

                // Python builtins: len(xs) -> xs.length
                if let Kind::Name(id) = &func.kind {
                    if args.len() == 1 && kwargs.is_empty() {
                        let arg = self.js(&args[0])?;
                        match id.as_str() {
                            "len" => return Ok(format!("{}.length", arg)),
                            "str" => return Ok(format!("String({})", arg)),
                            "int" => return Ok(format!("parseInt({})", arg)),
                            "float" => return Ok(format!("parseFloat({})", arg)),
                            "abs" => return Ok(format!("Math.abs({})", arg)),
                            "round" => return Ok(format!("Math.round({})", arg)),
                            "sum" => return Ok(format!("{}.reduce((a, b) => a + b, 0)", arg)),
                            "sorted" => return Ok(format!("{}.slice().sort()", arg)),
                            "reversed" => return Ok(format!("{}.slice().reverse()", arg)),
                            "list" => return Ok(format!("{}.slice()", arg)),
                            "bool" => return Ok(format!("Boolean({})", arg)),
                            // Python's print is the obvious debugging verb; a
                            // Python dev reaches for it without thinking.
                            "print" => return Ok(format!("console.log({})", arg)),
                            _ => {}
                        }
                    }
                }

                if Self::is_element(func) {
                    return self.jsx_inline(func, args, kwargs);
                }
                let fn_str = self.js(func)?;
                let mut all = Vec::new();
                for a in args {
                    all.push(self.js(a)?);
                }
                for (k, v) in kwargs {
                    all.push(format!("{}: {}", prop_map(k), self.js(v)?));
                }
                Ok(format!("{}({})", fn_str, all.join(", ")))
            }
            Kind::Slice { obj, start, stop } => {
                let o = self.js(obj)?;
                let a = match start {
                    Some(s) => self.js(s)?,
                    None => "0".into(),
                };
                let b = match stop {
                    Some(s) => format!(", {}", self.js(s)?),
                    None => String::new(),
                };
                Ok(format!("{}.slice({}{})", o, a, b))
            }
            Kind::Await(v) => Ok(format!("await {}", self.js(v)?)),
            _ => Err(CompileError::new(
                format!("cannot compile expression {:?}", n.kind),
                n.line,
                n.col,
                Vec::new(),
            )),
        }
    }

    fn attr_str(&self, args: &[Node], kwargs: &[(String, Node)]) -> Result<String, CompileError> {
        let mut attrs = Vec::new();

        // 0. Spread attributes in args: div(*props): or div(**props):
        for arg in args {
            if let Kind::Spread(v) = &arg.kind {
                attrs.push(format!("{{...{}}}", self.js(v)?));
            }
        }

        for (k, v) in kwargs {
            // 1. Native conditional styling (cls / class shorthand)
            if k == "cls" || k == "class" || k == "className" {
                if matches!(v.kind, Kind::Dict(_) | Kind::List(_)) {
                    self.used_helpers.borrow_mut().insert("cx".to_string());
                    attrs.push(format!("className={{cx({})}}", self.js(v)?));
                    continue;
                }
            }

            // 2. Event modifiers (_prevent, _stop, _prevent_stop, _stop_prevent)
            if k.starts_with("on_") {
                let is_prevent_stop = k.ends_with("_prevent_stop") || k.ends_with("_stop_prevent");
                let is_prevent = !is_prevent_stop && k.ends_with("_prevent");
                let is_stop = !is_prevent_stop && k.ends_with("_stop");

                if is_prevent_stop || is_prevent || is_stop {
                    let base_k = if is_prevent_stop {
                        &k[..k.len() - 13]
                    } else if is_prevent {
                        &k[..k.len() - 8]
                    } else {
                        &k[..k.len() - 5]
                    };
                    let pk = prop_map(base_k);
                    let handler = self.js(v)?;
                    let body = if is_prevent_stop {
                        format!("e.preventDefault(); e.stopPropagation(); ({handler})(e);")
                    } else if is_prevent {
                        format!("e.preventDefault(); ({handler})(e);")
                    } else {
                        format!("e.stopPropagation(); ({handler})(e);")
                    };
                    attrs.push(format!("{pk}={{(e: any) => {{ {body} }}}}"));
                    continue;
                }
            }

            let pk = if k == "key" {
                "key".to_string()
            } else {
                prop_map(k)
            };

            if let Kind::Str { value, is_f: false } = &v.kind {
                // String literal: className="foo", not className={"foo"}.
                attrs.push(format!("{}={}", pk, value));
            } else {
                attrs.push(format!("{}={{{}}}", pk, self.js(v)?));
            }
        }
        if attrs.is_empty() {
            Ok(String::new())
        } else {
            Ok(format!(" {}", attrs.join(" ")))
        }
    }

    fn jsx_inline(
        &self,
        func: &Node,
        args: &[Node],
        kwargs: &[(String, Node)],
    ) -> Result<String, CompileError> {
        let tag = self.js(func)?;
        let a = self.attr_str(args, kwargs)?;
        let non_spread_args: Vec<_> = args.iter().filter(|a| !matches!(a.kind, Kind::Spread(_))).collect();
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

    pub fn tree(&self, n: &Node, ind: usize) -> Result<String, CompileError> {
        let (head, body) = match &n.kind {
            Kind::Tree { head, body } => (head, body),
            _ => unreachable!(),
        };

        let (tag, a) = match &head.kind {
            Kind::Name(id) => (id.clone(), String::new()),
            Kind::Attr { .. } if Self::is_element(head) => (self.js(head)?, String::new()),
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
        Ok(format!("<{}{}>\n{}\n{}</{}>", tag, a, inner, pad_close, tag))
    }

    fn child(&self, s: &Node, ind: usize) -> Result<String, CompileError> {
        match &s.kind {
            Kind::Tree { .. } => self.tree(s, ind),
            Kind::ExprStmt(e) => match &e.kind {
                Kind::Str { value, is_f: false } => Ok(value[1..value.len() - 1].to_string()),
                Kind::Num(v) => Ok(v.clone()),
                Kind::Call { func, args, kwargs } if Self::is_element(func) => {
                    self.jsx_inline(func, args, kwargs)
                }
                _ => Ok(format!("{{{}}}", self.js(e)?)),
            },
            Kind::If { test, body, orelse } => {
                let cond = self.js(test)?;
                let b = self.frag(body, ind)?;
                if let Some(ore) = orelse {
                    if ore.len() == 1 && matches!(&ore[0].kind, Kind::If { .. }) {
                        // Elif: unwrap the nested braces so we don't emit {cond ? (...) : {elif ? ...}}.
                        let inner = self.child(&ore[0], ind)?;
                        let stripped = inner.trim().trim_start_matches('{').trim_end_matches('}');
                        return Ok(format!("{{{cond} ? ({b}) : ({stripped})}}"));
                    }
                    let o = self.frag(ore, ind)?;
                    return Ok(format!("{{{cond} ? ({b}) : ({o})}}"));
                }
                Ok(format!("{{{cond} && ({b})}}"))
            }
            Kind::For { target, iter, body } => {
                let it = self.js(iter)?;
                let b = self.frag(body, ind)?;
                Ok(format!("{{{it}.map(({target}) => ({b}))}}"))
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
                                format!("(({} === {}) || ({} === {}))", s_val, self.js(left)?, s_val, self.js(right)?)
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
            .with_hint("move logic above the tree — tree blocks only accept elements, if, and for")),
        }
    }

    fn frag(&self, body: &[Node], ind: usize) -> Result<String, CompileError> {
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

    pub fn stmt(&mut self, s: &Node) -> Result<(), CompileError> {
        self.cur_src = s.line;
        match &s.kind {
            Kind::Assign { target, value } => {
                let lhs = match &target.kind {
                    Kind::Tuple(items) => {
                        let bits: Result<Vec<_>, _> = items.iter().map(|i| self.js(i)).collect();
                        format!("[{}]", bits?.join(", "))
                    }
                    Kind::Dict(pairs) => {
                        let mut ps = Vec::new();
                        for (k, v) in pairs {
                            if let Some(key) = k {
                                ps.push(format!("{}: {}", self.js(key)?, self.js(v)?));
                            } else {
                                ps.push(self.js(v)?);
                            }
                        }
                        format!("{{ {} }}", ps.join(", "))
                    }
                    _ => self.js(target)?,
                };
                let rhs = self.js(value)?;
                self.w(&format!("const {} = {};", lhs, rhs));
            }
            Kind::AugAssign { target, op, value } => {
                let lhs = self.js(target)?;
                let rhs = self.js(value)?;
                self.w(&format!("{} {}= {};", lhs, op, rhs));
            }
            Kind::Return(v) => {
                let val = self.js(v)?;
                self.w(&format!("return {};", val));
            }
            Kind::ExprStmt(e) => {
                let val = self.js(e)?;
                self.w(&format!("{};", val));
            }
            Kind::Tree { .. } => {
                let jsx = self.tree(s, self.depth + 1)?;
                let pad = self.pad();
                self.w(&format!("return (\n  {}{}\n{});", pad, jsx, pad));
            }
            Kind::Def { name, params, body } => {
                let ps = self.format_params(params)?;
                self.w(&format!("const {} = ({}) => {{", name, ps));
                self.depth += 1;
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.depth -= 1;
                self.w("};");
            }
            Kind::If { test, body, orelse } => {
                let cond = self.js(test)?;
                self.w(&format!("if ({}) {{", cond));
                self.depth += 1;
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.depth -= 1;
                self.w("}");
                if let Some(ore) = orelse {
                    self.w("else {");
                    self.depth += 1;
                    for stmt in ore {
                        self.stmt(stmt)?;
                    }
                    self.depth -= 1;
                    self.w("}");
                }
            }
            Kind::For { target, iter, body } => {
                let it = self.js(iter)?;
                self.w(&format!("for (const {} of {}) {{", target, it));
                self.depth += 1;
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.depth -= 1;
                self.w("}");
            }
            Kind::Match { subject, cases } => {
                let s_val = self.js(subject)?;
                self.w(&format!("switch ({}) {{", s_val));
                self.depth += 1;
                for c in cases {
                    let is_wildcard = match &c.pattern.kind {
                        Kind::Name(n) if n == "_" => true,
                        _ => false,
                    };
                    if is_wildcard {
                        self.w("default: {");
                    } else {
                        self.w(&format!("case {}: {{", self.js(&c.pattern)?));
                    }
                    self.depth += 1;
                    for stmt in &c.body {
                        self.stmt(stmt)?;
                    }
                    self.w("break;");
                    self.depth -= 1;
                    self.w("}");
                }
                self.depth -= 1;
                self.w("}");
            }
            Kind::Import { from, names } => {
                if let Some(f) = from {
                    self.imports.insert(format!("import {{ {} }} from '{}';", names.join(", "), f));
                } else {
                    self.imports.insert(format!("import {} from 'serpent';", names.join(", ")));
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn format_params(&self, params: &[Param]) -> Result<String, CompileError> {
        let mut out = Vec::new();
        for p in params {
            if let Some(d) = &p.default {
                // `x=None` marks a prop optional without setting a JS default.
                if !matches!(&d.kind, Kind::Null) {
                    out.push(format!("{} = {}", p.name, self.js(d)?));
                    continue;
                }
            }
            out.push(p.name.clone());
        }
        Ok(out.join(", "))
    }

    pub fn component(&mut self, name: &str, params: &[Param], body: &[Node]) -> Result<(), CompileError> {
        let ps = self.format_params(params)?;
        let arg = if params.is_empty() {
            String::new()
        } else {
            format!("{{ {} }}: {}Props", ps, name)
        };
        self.w(&format!("export function {}({}) {{", name, arg));
        self.depth += 1;

        let tree_count = body.iter().filter(|s| matches!(s.kind, Kind::Tree { .. })).count();
        if tree_count > 1 {
            for s in body {
                if !matches!(s.kind, Kind::Tree { .. }) {
                    self.stmt(s)?;
                }
            }
            let mut parts = Vec::new();
            for s in body {
                if matches!(s.kind, Kind::Tree { .. }) {
                    parts.push(self.tree(s, self.depth + 1)?);
                }
            }
            let pad = self.pad();
            let pad2 = "  ".repeat(self.depth + 1);
            let inner = parts.into_iter().map(|p| format!("{}{}", pad2, p)).collect::<Vec<_>>().join("\n");
            self.w(&format!("return (\n{}<>\n{}\n{}</>\n{});", pad, inner, pad, pad));
        } else {
            for s in body {
                self.stmt(s)?;
            }
        }
        self.depth -= 1;
        self.w("}");

        if !params.is_empty() {
            self.w("");
            self.w(&format!("export interface {}Props {{", name));
            self.depth += 1;
            for p in params {
                if p.name.starts_with("...") {
                    self.w("[key: string]: any;");
                } else {
                    let opt = if p.has_default { "?" } else { "" };
                    let ty = p.ty.as_deref().unwrap_or("any");
                    self.w(&format!("{}{}: {};", p.name, opt, ty));
                }
            }
            self.depth -= 1;
            self.w("}");
        }
        Ok(())
    }

    pub fn run(&mut self, module: &Node) -> Result<String, CompileError> {
        let body = match &module.kind {
            Kind::Module(stmts) => stmts,
            _ => unreachable!(),
        };

        for s in body {
            if let Kind::Import { from, names } = &s.kind {
                if let Some(f) = from {
                    self.imports.insert(format!("import {{ {} }} from '{}';", names.join(", "), f));
                } else {
                    self.imports.insert(format!("import {} from 'serpent';", names.join(", ")));
                }
            }
        }

        for s in body {
            match &s.kind {
                Kind::Component { name, params, body } => {
                    self.cur_src = s.line;
                    self.component(name, params, body)?;
                    self.w("");
                }
                Kind::Import { .. } => {}
                _ => self.stmt(s)?,
            }
        }

        // Inject imports for any runtime helper the source used but did not
        // import itself. `s.capitalize()` should not need the author to know
        // that `capitalize` lives in the runtime.
        let helpers: Vec<String> = self.used_helpers.borrow().iter().cloned().collect();
        if !helpers.is_empty() {
            let mut h = helpers;
            h.sort();
            self.imports.insert(format!("import {{ {} }} from 'serpent';", h.join(", ")));
        }

        let mut head = vec![
            "// [xihanzu-NR]".to_string(),
            "// GENERATED by serpent — edit the .hsx file, not this one".to_string(),
        ];
        let mut sorted_imports: Vec<_> = self.imports.iter().cloned().collect();
        sorted_imports.sort();
        head.extend(sorted_imports);
        head.push(String::new());

        // head_lines must reflect the final head; the source map indexes body
        // lines against it, so recompute after the helper injection.
        self.head_lines = head.clone();
        Ok(format!("{}\n{}", head.join("\n"), self.lines.join("\n")))
    }

    pub fn sourcemap(&self, filename: &str, src: &str) -> String {
        let mut segs = Vec::new();
        let mut prev_src: i64 = 0;
        for _ in 0..self.head_lines.len() {
            segs.push(format!("{}{}{}", encode_vlq(0), encode_vlq(0), encode_vlq(0)));
        }
        for sl in &self.linemap {
            let sl_i = *sl as i64;
            let d = (sl_i - 1) - prev_src;
            prev_src = sl_i - 1;
            segs.push(format!("{}{}{}", encode_vlq(0), encode_vlq(d), encode_vlq(0)));
        }
        // `file` names the artifact this map describes: same path as the
        // source, with the extension swapped for `.tsx` (matching the name the
        // Vite plugin hands to esbuild). Both paths go through the JSON escaper
        // — a Windows path is full of backslashes and would otherwise produce
        // a map that `JSON.parse` rejects.
        let out_file = match filename.rfind('.') {
            Some(dot) => format!("{}.tsx", &filename[..dot]),
            None => format!("{}.tsx", filename),
        };
        format!(
            "{{\"version\":3,\"file\":{},\"sources\":[{}],\"sourcesContent\":[{}],\"names\":[],\"mappings\":\"{}\"}}",
            serde_json_escape(&out_file),
            serde_json_escape(filename),
            serde_json_escape(src),
            segs.join(";")
        )
    }
}

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode_vlq(n: i64) -> String {
    let mut v = if n < 0 { ((-n) << 1) | 1 } else { n << 1 } as u64;
    let mut out = String::new();
    loop {
        let mut digit = (v & 31) as usize;
        v >>= 5;
        if v != 0 {
            digit |= 32;
        }
        out.push(B64[digit] as char);
        if v == 0 {
            break;
        }
    }
    out
}

fn serde_json_escape(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            other => o.push(other),
        }
    }
    o.push('"');
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emit_tsx(src: &str) -> String {
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        let toks = crate::lexer::lex(src).expect("lex failed");
        let module = crate::parser::Parser::new(toks, lines).module().expect("parse failed");
        let mut em = Emitter::new();
        em.run(&module).expect("emit failed")
    }

    fn has_all(out: &str, frags: &[&str]) {
        for f in frags {
            assert!(out.contains(f), "missing fragment {:?} in output:\n{}", f, out);
        }
    }

    fn lacks(out: &str, frag: &str) {
        assert!(!out.contains(frag), "unexpected fragment {:?} in output:\n{}", frag, out);
    }

    // ----------------------------------------------------------------- prop map

    #[test]
    fn prop_renaming_matches_react() {
        assert_eq!(prop_map("cls"), "className");
        assert_eq!(prop_map("class"), "className");
        assert_eq!(prop_map("for"), "htmlFor");
        assert_eq!(prop_map("on_click"), "onClick");
        assert_eq!(prop_map("on_change"), "onChange");
        assert_eq!(prop_map("tab_index"), "tabIndex");
        assert_eq!(prop_map("type_"), "type");
        assert_eq!(prop_map("data_custom"), "data-custom");
        assert_eq!(prop_map("aria_label"), "aria-label");
        assert_eq!(prop_map("data_test_id"), "data-test-id");
    }

    // ------------------------------------------------------------ string method

    #[test]
    fn string_methods_map_to_js() {
        assert_eq!(str_method("strip"), "trim");
        assert_eq!(str_method("upper"), "toUpperCase");
        assert_eq!(str_method("lower"), "toLowerCase");
        assert_eq!(str_method("startswith"), "startsWith");
        assert_eq!(str_method("endswith"), "endsWith");
        assert_eq!(str_method("replace"), "replaceAll");
        assert_eq!(str_method("find"), "indexOf");
    }

    #[test]
    fn free_functions_are_flagged() {
        assert_eq!(free_func("capitalize"), Some("capitalize"));
        assert_eq!(free_func("title"), Some("title"));
        assert_eq!(free_func("strip"), None);
    }

    // ------------------------------------------------------------- expressions

    #[test]
    fn strict_comparisons_emitted() {
        let out = emit_tsx("component A():\n    if x == 1:\n        p: \"y\"\n");
        has_all(&out, &["(x === 1)"]);
        let out = emit_tsx("component A():\n    if x != 1:\n        p: \"y\"\n");
        has_all(&out, &["(x !== 1)"]);
    }

    #[test]
    fn boolean_operators_emitted() {
        let out = emit_tsx("component A():\n    if a and b:\n        p: \"y\"\n");
        has_all(&out, &["(a && b)"]);
        let out = emit_tsx("component A():\n    if a or b:\n        p: \"y\"\n");
        has_all(&out, &["(a || b)"]);
        let out = emit_tsx("component A():\n    if not a:\n        p: \"y\"\n");
        has_all(&out, &["(!a)"]);
    }

    #[test]
    fn lambda_emits_arrow_function() {
        let out = emit_tsx("component A():\n    button(on_click=lambda: go()): \"x\"\n");
        has_all(&out, &["=> go()"]);
    }

    #[test]
    fn lambda_with_defaults_emits_js_defaults() {
        let out = emit_tsx("component A():\n    f = lambda m=mode: m\n");
        has_all(&out, &["((m = mode) => m)"]);
    }

    #[test]
    fn ternary_emitted() {
        let out = emit_tsx("component A():\n    p: \"y\" if a else \"n\"\n");
        has_all(&out, &["(a ? \"y\" : \"n\")"]);
    }

    #[test]
    fn arithmetic_operators_emitted() {
        let out = emit_tsx("component A():\n    x = 1 + 2 * 3 - 4 / 5 % 6\n");
        has_all(&out, &["const x = "]);
    }

    #[test]
    fn unary_minus_emitted() {
        let out = emit_tsx("component A():\n    x = -1\n");
        has_all(&out, &["(-1)"]);
    }

    // ----------------------------------------------------------------- builtins

    #[test]
    fn len_maps_to_length() {
        let out = emit_tsx("component A():\n    n = len(items)\n");
        has_all(&out, &["items.length"]);
    }

    #[test]
    fn string_number_builtins_map_to_js() {
        let out = emit_tsx("component A():\n    a = str(x)\n    b = int(x)\n    c = float(x)\n    d = abs(x)\n    e = round(x)\n    f = bool(x)\n");
        has_all(&out, &[
            "String(x)",
            "parseInt(x)",
            "parseFloat(x)",
            "Math.abs(x)",
            "Math.round(x)",
            "Boolean(x)",
        ]);
    }

    #[test]
    fn sum_maps_to_reduce() {
        let out = emit_tsx("component A():\n    n = sum(xs)\n");
        has_all(&out, &["xs.reduce((a, b) => a + b, 0)"]);
    }

    #[test]
    fn sorted_reversed_list_map_to_slice() {
        let out = emit_tsx("component A():\n    a = sorted(xs)\n    b = reversed(xs)\n    c = list(xs)\n");
        has_all(&out, &["xs.slice().sort()", "xs.slice().reverse()", "xs.slice()"]);
    }

    #[test]
    fn string_methods_emitted() {
        let out = emit_tsx("component A():\n    a = t.strip()\n    b = t.upper()\n    c = t.lower()\n    d = t.startswith(\"x\")\n    e = t.endswith(\"y\")\n");
        has_all(&out, &[
            "t.trim()",
            "t.toUpperCase()",
            "t.toLowerCase()",
            "t.startsWith(\"x\")",
            "t.endsWith(\"y\")",
        ]);
    }

    #[test]
    fn runtime_helpers_are_auto_imported() {
        let out = emit_tsx("component A():\n    s = t.capitalize()\n");
        has_all(&out, &["import { capitalize } from 'serpent';", "capitalize(t)"]);
    }

    // ----------------------------------------------------------- comprehensions

    #[test]
    fn comprehension_map_form() {
        let out = emit_tsx("component A():\n    ys = [x * 2 for x in xs]\n");
        has_all(&out, &["xs.map((x) => (x * 2))"]);
    }

    #[test]
    fn comprehension_filter_only_form_avoids_redundant_map() {
        let out = emit_tsx("component A():\n    ys = [x for x in xs if x > 1]\n");
        has_all(&out, &["xs.filter((x) => (x > 1))"]);
        lacks(&out, ".map");
    }

    #[test]
    fn comprehension_filter_and_map_form() {
        let out = emit_tsx("component A():\n    ys = [x * 2 for x in xs if x > 1]\n");
        has_all(&out, &["xs.filter((x) => (x > 1)).map((x) => (x * 2))"]);
    }

    // ------------------------------------------------------------------ f-string

    #[test]
    fn fstring_emits_template_literal() {
        let out = emit_tsx("component A():\n    div: f\"hi {name}\"\n");
        has_all(&out, &["`hi ${name}`"]);
    }

    #[test]
    fn fstring_escaped_braces_become_literal_braces() {
        let out = emit_tsx("component A():\n    div: f\"{{literal}}\"\n");
        has_all(&out, &["`{literal}`"]);
        lacks(&out, "${literal}");
    }

    #[test]
    fn fstring_backticks_are_escaped() {
        let out = emit_tsx("component A():\n    div: f\"a`b {x}\"\n");
        has_all(&out, &["`a\\`b ${x}`"]);
    }

    #[test]
    fn fstring_dollars_are_escaped_so_literals_survive() {
        let out = emit_tsx("component A():\n    div: f\"cost: ${price}\"\n");
        has_all(&out, &["${price}"]);
    }

    // -------------------------------------------------------------------- trees

    #[test]
    fn nested_tree_elements_render() {
        let out = emit_tsx("component A():\n    div:\n        h1: \"Hello\"\n        p: \"World\"\n");
        has_all(&out, &["<div>", "<h1>Hello</h1>", "<p>World</p>", "</div>"]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn class_and_cls_become_className() {
        let out = emit_tsx("component A():\n    div(cls=\"x\"):\n        span: \"y\"\n");
        has_all(&out, &["className=\"x\""]);
        lacks(&out, "className={\"x\"}");
    }

    #[test]
    fn self_closing_elements() {
        let out = emit_tsx("component A():\n    div:\n        br:\n        hr:\n        input(value=x)\n");
        has_all(&out, &["<br />", "<hr />", "<input value={x} />"]);
    }

    #[test]
    fn empty_block_self_closes() {
        let out = emit_tsx("component A():\n    div():\n");
        has_all(&out, &["<div />"]);
    }

    #[test]
    fn inline_single_child_stays_on_one_line() {
        let out = emit_tsx("component A():\n    h1: \"Hello\"\n");
        has_all(&out, &["<h1>Hello</h1>"]);
    }

    // -------------------------------------------------- control flow inside trees

    #[test]
    fn tree_if_becomes_logical_and() {
        let out = emit_tsx("component A():\n    div:\n        if a:\n            p: \"yes\"\n");
        has_all(&out, &["{a && (", "yes"]);
    }

    #[test]
    fn tree_if_else_becomes_ternary() {
        let out = emit_tsx("component A():\n    div:\n        if a:\n            p: \"yes\"\n        else:\n            p: \"no\"\n");
        has_all(&out, &["{a ? (<p>yes</p>) : (<p>no</p>)}"]);
    }

    #[test]
    fn tree_elif_chain_unwraps_nested_braces() {
        // Bug hunt: must NOT emit `{a ? x : {b ? y : z}}`.
        let out = emit_tsx("component A():\n    div:\n        if a:\n            p: \"1\"\n        elif b:\n            p: \"2\"\n        else:\n            p: \"3\"\n");
        has_all(&out, &["{a ? (<p>1</p>) : (b ? (<p>2</p>) : (<p>3</p>))}"]);
        lacks(&out, ": {");
    }

    #[test]
    fn tree_for_becomes_map() {
        let out = emit_tsx("component A():\n    ul:\n        for it in items:\n            li(key=it): it\n");
        has_all(&out, &["items.map((it) => (", "<li key={it}>"]);
    }

    #[test]
    fn tree_for_with_multiple_children_emits_fragment() {
        let out = emit_tsx("component A():\n    div:\n        for x in xs:\n            span: \"a\"\n            span: \"b\"\n");
        has_all(&out, &["<>", "<span>a</span>", "<span>b</span>", "</>"]);
    }

    // --------------------------------------------------------------- components

    #[test]
    fn component_props_and_interface_emitted() {
        let out = emit_tsx("component Btn(label: str, count: int = 0, on_click=None):\n    button: label\n");
        has_all(&out, &[
            "export function Btn({ label, count = 0, on_click }: BtnProps)",
            "export interface BtnProps {",
            "label: string;",
            "count?: number;",
            "on_click?: any;",
        ]);
        lacks(&out, "label?:");
        lacks(&out, "= null");
    }

    #[test]
    fn component_with_no_props_emits_no_arg_and_no_interface() {
        let out = emit_tsx("component NoProps():\n    div: \"z\"\n");
        has_all(&out, &["export function NoProps()"]);
        lacks(&out, "NoPropsProps");
    }

    // ---------------------------------------------------------------- statements

    #[test]
    fn assign_emits_const() {
        let out = emit_tsx("component A():\n    x = 1\n");
        has_all(&out, &["const x = 1;"]);
    }

    #[test]
    fn tuple_unpack_emits_array_destructure() {
        let out = emit_tsx("component A():\n    a, b = pair()\n");
        has_all(&out, &["const [a, b] = pair();"]);
    }

    #[test]
    fn def_emits_arrow_function() {
        let out = emit_tsx("component A():\n    def go():\n        x()\n");
        has_all(&out, &["const go = () => {"]);
    }

    #[test]
    fn augmented_assign_emits_in_place() {
        let out = emit_tsx("component A():\n    x += 1\n");
        has_all(&out, &["x += 1;"]);
    }

    #[test]
    fn statement_level_if_and_for_emit_native_blocks() {
        let out = emit_tsx("component A():\n    if a:\n        go()\n    for x in xs:\n        run(x)\n");
        has_all(&out, &["if (a) {", "for (const x of xs) {"]);
    }

    // ------------------------------------------------------------------- imports

    #[test]
    fn imports_are_deduplicated_and_sorted() {
        let out = emit_tsx("from b import y\nfrom a import x\nfrom b import y\n\ncomponent A():\n    div: \"z\"\n");
        let lines: Vec<_> = out.lines().filter(|l| l.starts_with("import ")).collect();
        assert_eq!(lines, vec![
            "import { x } from 'a';",
            "import { y } from 'b';",
        ]);
    }

    // ----------------------------------------------------------------- sourcemap

    #[test]
    fn sourcemap_structure_and_version() {
        let src = "component A():\n    div: \"x\"\n";
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        let toks = crate::lexer::lex(src).unwrap();
        let mod_ = crate::parser::Parser::new(toks, lines).module().unwrap();
        let mut em = Emitter::new();
        let code = em.run(&mod_).unwrap();
        let smap = em.sourcemap("A.hsx", src);

        assert!(smap.contains("\"version\":3"));
        assert!(smap.contains("\"file\":\"A.tsx\""));
        assert!(smap.contains("\"sources\":[\"A.hsx\"]"));
        assert!(smap.contains("\"sourcesContent\":"));

        // Exactly one segment per generated code line.
        let m: SerdeJsonLite = parse_json_lite(&smap);
        let segs = m.mappings.split(';').count();
        let code_lines = code.split('\n').count();
        assert_eq!(segs, code_lines);
    }

    #[test]
    fn sourcemap_with_windows_path_is_valid_json() {
        // Backslashes in `C:\Users\test\App.hsx` used to be emitted unescaped.
        let mut em = Emitter::new();
        em.head_lines = vec!["// [xihanzu-NR]".into()];
        em.lines = vec!["export function A() {}".into()];
        em.linemap = vec![1];
        let map = em.sourcemap("C:\\Users\\test\\App.hsx", "component A():\n");
        assert!(map.contains("\"file\":\"C:\\\\Users\\\\test\\\\App.tsx\""));
        assert!(map.contains("\"sources\":[\"C:\\\\Users\\\\test\\\\App.hsx\"]"));
    }

    struct SerdeJsonLite {
        mappings: String,
    }

    fn parse_json_lite(s: &str) -> SerdeJsonLite {
        let marker = "\"mappings\":\"";
        let start = s.find(marker).unwrap() + marker.len();
        let end = s[start..].find('"').unwrap() + start;
        SerdeJsonLite { mappings: s[start..end].to_string() }
    }

    // ---------------------------------------------------------------- edge cases

    #[test]
    fn empty_dict_is_wrapped_for_arrow_disambiguation() {
        let out = emit_tsx("component A():\n    d = {}\n");
        has_all(&out, &["const d = ({});"]);
    }

    #[test]
    fn empty_list_and_tuple_emit_empty_arrays() {
        let out = emit_tsx("component A():\n    xs = []\n    t = ()\n");
        has_all(&out, &["const xs = [];", "const t = [];"]);
    }

    #[test]
    fn unicode_in_strings_and_identifiers_emitted_cleanly() {
        let out = emit_tsx("component A():\n    café = \"日本語\"\n");
        has_all(&out, &["const café = \"日本語\";"]);
    }

    #[test]
    fn key_prop_is_preserved_in_for_loop() {
        let out = emit_tsx("component A():\n    ul:\n        for it in items:\n            li(key=it): it\n");
        has_all(&out, &["<li key={it}>"]);
        lacks(&out, "key={key}");
    }
}
