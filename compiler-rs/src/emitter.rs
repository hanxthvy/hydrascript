// [xihanzu-NR]
//! TSX code generator and source map builder.
//!
//! Emits clean, readable TSX and keeps an exact line-by-line map so a browser
//! stack trace points at the .hsx line that produced it.

use std::collections::{HashMap, HashSet};

use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;

pub static HTML_TAGS: &[&str] = &[
    "div",
    "span",
    "p",
    "a",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "button",
    "input",
    "form",
    "label",
    "select",
    "option",
    "textarea",
    "img",
    "nav",
    "header",
    "footer",
    "main",
    "section",
    "article",
    "aside",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "br",
    "hr",
    "pre",
    "code",
    "em",
    "strong",
    "small",
    "figure",
    "figcaption",
    "video",
    "audio",
    "canvas",
    "svg",
    "iframe",
    "dialog",
    // SVG elements
    "path",
    "g",
    "circle",
    "rect",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "defs",
    "clipPath",
    "symbol",
    "use",
    "ellipse",
    "mask",
    "pattern",
    "marker",
    "linearGradient",
    "radialGradient",
    "stop",
    "foreignObject",
    // HTML5 elements
    "details",
    "summary",
    "picture",
    "source",
    "track",
    "time",
    "slot",
    "template",
    "mark",
    "progress",
    "meter",
    "fieldset",
    "legend",
    "optgroup",
    "caption",
    "colgroup",
    "col",
    "tfoot",
    "kbd",
    "blockquote",
    "address",
];

// [xihanzu-NR]
pub static JS_BUILTIN_GLOBALS: &[&str] = &[
    "Math",
    "Date",
    "Array",
    "Object",
    "Number",
    "String",
    "Boolean",
    "RegExp",
    "JSON",
    "Promise",
    "Reflect",
    "Intl",
    "Set",
    "Map",
    "WeakSet",
    "WeakMap",
    "Symbol",
    "Error",
    "TypeError",
    "RangeError",
    "ResizeObserver",
    "IntersectionObserver",
    "MutationObserver",
    "WebSocket",
    "Worker",
    "Audio",
    "Image",
    "FormData",
    "URL",
    "URLSearchParams",
    "Console",
    "console",
    "window",
    "document",
    "globalThis",
    "navigator",
    "location",
    "localStorage",
    "sessionStorage",
    "performance",
    "Performance",
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
        // Dunder introspection. `type(x).__name__` is the common one; without
        // this it emitted `.__name__`, which is `undefined` on every JS value.
        "__name__" => "name",
        "__class__" => "constructor",
        "__doc__" => "toString",
        "__module__" => "name",
        other => other,
    }
}

/// Python methods with no JS equivalent that are rewritten to a free function
/// call into the `serpent` runtime: `s.capitalize()` -> `capitalize(s)`.
///
/// The dict, list, str and dict-lookup entries here are the ones that used to
/// produce JavaScript that either threw or silently did the wrong thing:
/// `", ".join(xs)` emitted a method call on a string (TypeError), `d.get("k", 0)`
/// emitted a method call on an object (TypeError), `len(d)` emitted `.length` on
/// an object (undefined), and `xs.extend(ys)` emitted `.extend` (TypeError).
/// Each one is now mapped to the helper that implements the Python behaviour.
pub fn free_func(m: &str) -> Option<&'static str> {
    match m {
        // strings
        "capitalize" => Some("capitalize"),
        "title" => Some("title"),
        "count" => Some("count"),
        "format" => Some("format"),
        "zfill" => Some("zfill"),
        "isdigit" => Some("isDigit"),
        "isalpha" => Some("isAlpha"),
        "isalnum" => Some("isAlnum"),
        "isspace" => Some("isSpace"),
        "isupper" => Some("isUpper"),
        "islower" => Some("isLower"),
        "center" => Some("center"),
        "ljust" => Some("ljust"),
        "rjust" => Some("rjust"),
        "partition" => Some("str_partition"),
        "rpartition" => Some("str_rpartition"),
        "swapcase" => Some("swapcase"),
        // join is a string method in Python and an array method in JS; the
        // operands are the other way round, so it needs a helper.
        "join" => Some("join"),
        // dict
        "get" => Some("dict_get"),
        "setdefault" => Some("dict_setdefault"),
        "update" => Some("dict_update"),
        "pop" => Some("dict_pop"),
        "popitem" => Some("dict_popitem"),
        "fromkeys" => Some("dict_fromkeys"),
        // list
        "extend" => Some("list_extend"),
        "insert" => Some("list_insert"),
        "remove" => Some("list_remove"),
        "index" => Some("list_index"),
        // set-like helpers
        "add" => Some("set_add"),
        "discard" => Some("set_discard"),
        _ => None,
    }
}


// [xihanzu-NR]
#[derive(Default, Debug, Clone)]
pub struct Scope {
    /// Names introduced by the function signature itself. They are already
    /// declared by the time the body runs, so re-declaring one (`let [a, b] = ...`
    /// inside a function that takes `a, b`) is a SyntaxError.
    pub params: HashSet<String>,
    pub assign_counts: HashMap<String, usize>,
    pub aug_assigned: HashSet<String>,
    pub declared: HashSet<String>,
    /// Depth at which each name is first assigned: 0 for a direct statement of
    /// the function body, 1+ for anything inside `if:` / `for:` / `try:`.
    ///
    /// This is what makes Python's function scoping survive the trip to
    /// JavaScript. Python has no block-scoped names, so
    ///     if ready:
    ///         signal = 1
    ///     return signal
    /// is legal Python. Emitting the binding inside the branch produced
    /// `let signal = 1;` in one arm and a use of an undeclared name after the
    /// block. Names whose first assignment is nested get hoisted to the top of
    /// the function instead.
    pub first_assign_depth: HashMap<String, usize>,
    /// Every name assigned anywhere in this scope (excluding nested functions).
    pub assigned_anywhere: HashSet<String>,
}

impl Scope {
    pub fn scan(body: &[Node]) -> Self {
        let mut scope = Scope::default();
        scope.scan_nodes(body);
        scope
    }

    fn scan_nodes(&mut self, nodes: &[Node]) {
        self.scan_at(nodes, 0);
    }

    /// Record one assignment target (a plain name, or every name inside a
    /// destructuring tuple). Member/index targets bind nothing.
    fn record_target(&mut self, target: &Node, depth: usize) {
        match &target.kind {
            Kind::Name(id) => {
                let escaped = self.assign_counts.entry(id.clone()).or_insert(0);
                if *escaped == 0 {
                    self.first_assign_depth.entry(id.clone()).or_insert(depth);
                }
                *escaped += 1;
                self.assigned_anywhere.insert(id.clone());
            }
            Kind::Tuple(items) | Kind::List(items) => {
                for item in items {
                    self.record_target(item, depth);
                }
            }
            _ => {}
        }
    }

    /// `depth` is the nesting level relative to the function body: 0 for a
    /// statement that sits directly in the body, 1 for one inside `if:`.
    /// Nested `def`s are separate scopes and are deliberately NOT descended
    /// into — their bindings belong to them, not to the enclosing function.
    fn scan_at(&mut self, nodes: &[Node], depth: usize) {
        for s in nodes {
            match &s.kind {
                Kind::Assign { target, .. } => {
                    if let Kind::Name(id) = &target.kind {
                        let escaped = self.assign_counts.entry(id.clone()).or_insert(0);
                        if *escaped == 0 {
                            self.first_assign_depth.entry(id.clone()).or_insert(depth);
                        }
                        *escaped += 1;
                        self.assigned_anywhere.insert(id.clone());
                    }
                }
                Kind::AugAssign { target, .. } => {
                    if let Kind::Name(id) = &target.kind {
                        self.aug_assigned.insert(id.clone());
                        self.assigned_anywhere.insert(id.clone());
                        self.first_assign_depth.entry(id.clone()).or_insert(depth);
                    }
                }
                // `a, b = ...` and `a = b = 0` declare every name on the left,
                // exactly like separate assignments would.
                Kind::TupleAssign { targets, .. } => {
                    for target in targets {
                        self.record_target(target, depth);
                    }
                }
                Kind::ChainedAssign { targets, .. } => {
                    for target in targets {
                        self.record_target(target, depth);
                    }
                }
                // A nested function is its own scope; do not inherit its names.
                Kind::Def { .. } | Kind::AsyncDef { .. } => {}
                Kind::If { body, orelse, .. } => {
                    self.scan_at(body, depth + 1);
                    if let Some(ore) = orelse {
                        self.scan_at(ore, depth + 1);
                    }
                }
                Kind::For { body, .. } => {
                    // The loop target is deliberately NOT hoisted: the `for`
                    // head declares it inline, and hoisting would emit a second
                    // binding that shadows the loop's own.
                    self.scan_at(body, depth + 1);
                }
                Kind::While { body, .. } => {
                    self.scan_at(body, depth + 1);
                }
                Kind::Try {
                    body,
                    handlers,
                    orelse,
                    finally,
                } => {
                    self.scan_at(body, depth + 1);
                    for h in handlers {
                        self.scan_at(&h.body, depth + 1);
                    }
                    if let Some(ore) = orelse {
                        self.scan_at(ore, depth + 1);
                    }
                    if let Some(fin) = finally {
                        self.scan_at(fin, depth + 1);
                    }
                }
                Kind::Match { cases, .. } => {
                    for c in cases {
                        self.scan_at(&c.body, depth + 1);
                    }
                }
                _ => {}
            }
        }
    }

    pub fn is_mutable(&self, id: &str) -> bool {
        self.assign_counts.get(id).copied().unwrap_or(0) > 1 || self.aug_assigned.contains(id)
    }
}

impl Scope {
    /// Names that must be declared at the top of the enclosing function because
    /// their first assignment sits inside a nested block. Sorted so the emitted
    /// order is stable across runs.
    pub fn hoist_names(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .assigned_anywhere
            .iter()
            .filter(|n| self.first_assign_depth.get(*n).copied().unwrap_or(0) > 0)
            .cloned()
            .collect();
        v.sort();
        v
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
    /// Every `def` in the file, by name: the ordered parameter list.
    ///
    /// Keyword arguments are a Python feature JavaScript does not have. A call
    /// written as `f(a=1, b=2)` used to emit `f(a: 1, b: 2)` — object-literal
    /// syntax inside a call, which is a syntax error in a build that reported
    /// success. With the signature known, matching kwargs are reordered into
    /// positional arguments (correct for any function in this file), and a name
    /// that matches nothing becomes a real error instead of broken output.
    pub fn_params: std::cell::RefCell<std::collections::HashMap<String, Vec<String>>>,
    /// Names bound by a walrus (`:=`), which must be declared before use.
    pub walrus_names: std::cell::RefCell<HashSet<String>>,
    /// Names declared by `class`, so calling one emits `new` — in
    /// Python, `Foo(1)` constructs an instance.
    pub class_names: std::cell::RefCell<std::collections::HashSet<String>>,
    pub head_lines: Vec<String>,
    pub scopes: Vec<Scope>,
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
            fn_params: std::cell::RefCell::new(std::collections::HashMap::new()),
            walrus_names: std::cell::RefCell::new(HashSet::new()),
            class_names: std::cell::RefCell::new(std::collections::HashSet::new()),
            head_lines: Vec::new(),
            scopes: Vec::new(),
        }
    }

    fn pad(&self) -> String {
        "  ".repeat(self.depth)
    }

    pub fn w(&mut self, s: &str) {
        let line = if s.is_empty() {
            String::new()
        } else {
            format!("{}{}", self.pad(), s)
        };
        let count = line.matches('\n').count() + 1;
        self.lines.push(line);
        for _ in 0..count {
            self.linemap.push(self.cur_src);
        }
    }

    pub fn is_element(n: &Node) -> bool {
        match &n.kind {
            Kind::Name(id) => {
                if JS_BUILTIN_GLOBALS.contains(&id.as_str()) {
                    return false;
                }
                HTML_TAGS.contains(&id.as_str())
                    || id.chars().next().map_or(false, |c| c.is_uppercase())
            }
            Kind::Attr { obj, name } => {
                if JS_BUILTIN_GLOBALS.contains(&name.as_str()) {
                    return false;
                }
                match &obj.kind {
                    Kind::Name(id) => {
                        if JS_BUILTIN_GLOBALS.contains(&id.as_str()) {
                            return false;
                        }
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
                                if c == '`' || c == '\\' || c == '$' {
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
            // Inside a class method `self` is JS `this`.
            Kind::Name(id) if id == "self" => Ok("this".to_string()),
            Kind::Name(id) => Ok(id.clone()),
            Kind::Attr { obj, name } => {
                // `self.x` -> `this.x` (see Kind::Name above) — routed through
                // the same code path by rewriting the object first.
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
                // `//` — floor division. JS `/` truncates toward zero, which
                // disagrees with Python for negatives (-7 // 2 is -4 in Python,
                // -3 in JS), so the floor is explicit.
                if op == "floordiv" {
                    return Ok(format!("Math.floor({} / {})", l, r));
                }
                // Python's `is` / `is not` are identity tests. JavaScript has no
                // `is` operator at all — leaving it in produced `(a is b)`, which
                // is a syntax error. `===` is the closest faithful translation.
                if op == "is" {
                    return Ok(format!("({} === {})", l, r));
                }
                if op == "is not" {
                    return Ok(format!("({} !== {})", l, r));
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
            Kind::Lambda {
                params,
                defaults,
                body,
            } => {
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
            Kind::Comprehension {
                expr,
                target,
                iter,
                cond,
            } => {
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
                // `Point(1, 2)` constructs an instance in Python; JS needs
                // the `new` keyword.
                if let Kind::Name(id) = &func.kind {
                    if self.class_names.borrow().contains(id) {
                        let bits: Result<Vec<_>, _> =
                            args.iter().map(|a| self.js(a)).collect();
                        return Ok(format!("new {}({})", id, bits?.join(", ")));
                    }
                }
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
                    if kwargs.is_empty() {
                        // Two-argument and variadic forms first: max(a, b),
                        // min(a, b), max(xs, key=...) is unsupported on purpose.
                        if args.len() >= 2 {
                            let mut all = Vec::new();
                            for a in args {
                                all.push(self.js(a)?);
                            }
                            match id.as_str() {
                                "max" => return Ok(format!("Math.max({})", all.join(", "))),
                                "min" => return Ok(format!("Math.min({})", all.join(", "))),
                                "isinstance" => {
                                    self.used_helpers.borrow_mut().insert("isinstance".into());
                                    let ty = &all[1];
                                    let mapped = match ty.as_str() {
                                        "str" => "String",
                                        "int" | "float" => "Number",
                                        "bool" => "Boolean",
                                        "list" => "Array",
                                        "dict" => "Object",
                                        "None" | "NoneType" => "null",
                                        other => other,
                                    };
                                    return Ok(format!("isinstance({}, {})", all[0], mapped));
                                }
                                _ => {}
                            }
                        }
                        if args.len() == 1 {
                            let arg = self.js(&args[0])?;
                            match id.as_str() {
                                "max" => return Ok(format!("Math.max(...{})", arg)),
                                "min" => return Ok(format!("Math.min(...{})", arg)),
                                // `type(x)` -> the constructor; `type(x).__name__`
                                // then resolves through the `__name__` -> `name` map.
                                "type" => return Ok(format!("({}).constructor", arg)),
                                // `len(x, y)` and `str(x, y)` are not Python, but
                                // `sorted(xs, key=...)` and friends arrive here
                                // with kwargs and are handled below.
                                _ => {}
                            }
                        }
                        // `sum(xs, start)` — Python's two-argument form. The
                        // one-argument form keeps the inline reduce.
                        if id == "sum" && args.len() == 2 {
                            let a = self.js(&args[0])?;
                            let b = self.js(&args[1])?;
                            return Ok(format!("{}.reduce((acc, x) => acc + x, {})", a, b));
                        }
                        // `pow(a, b)` with two args (Python's builtin).
                        if id == "pow" && args.len() == 2 {
                            return Ok(format!("Math.pow({}, {})", self.js(&args[0])?, self.js(&args[1])?));
                        }
                        // `round(x, n)` — JS has no digit argument.
                        if id == "round" && args.len() == 2 {
                            self.used_helpers.borrow_mut().insert("round_to".into());
                            return Ok(format!(
                                "round_to({}, {})",
                                self.js(&args[0])?,
                                self.js(&args[1])?
                            ));
                        }
                        // `enumerate(xs, start)` / `zip(a, b, c)` / `print(a, b)`:
                        // variadic forms the one-arg path cannot cover.
                        if id == "enumerate" {
                            let mut all = Vec::new();
                            for a in args {
                                all.push(self.js(a)?);
                            }
                            self.used_helpers.borrow_mut().insert("enumerate".into());
                            return Ok(format!("enumerate({})", all.join(", ")));
                        }
                        if id == "zip" {
                            let mut all = Vec::new();
                            for a in args {
                                all.push(self.js(a)?);
                            }
                            self.used_helpers.borrow_mut().insert("zip".into());
                            return Ok(format!("zip({})", all.join(", ")));
                        }
                        if id == "print" {
                            let mut all = Vec::new();
                            for a in args {
                                all.push(self.js(a)?);
                            }
                            return Ok(format!("console.log({})", all.join(", ")));
                        }
                        if id == "max" || id == "min" {
                            let mut all = Vec::new();
                            for a in args {
                                all.push(self.js(a)?);
                            }
                            return Ok(if id == "max" {
                                format!("Math.max({})", all.join(", "))
                            } else {
                                format!("Math.min({})", all.join(", "))
                            });
                        }
                        // `sorted(xs, key=..., reverse=...)` / `min(xs, default=...)`
                        // — keyword arguments that change the meaning entirely.
                        if !kwargs.is_empty() {
                            let key_fn = kwargs
                                .iter()
                                .find(|(k, _)| k == "key")
                                .map(|(_, v)| self.js(v))
                                .transpose()?;
                            let reverse: Option<String> = kwargs
                                .iter()
                                .find(|(k, _)| k == "reverse")
                                .map(|(_, v)| self.js(v))
                                .transpose()?;
                            if id == "sorted" {
                                let src_arg = if args.is_empty() {
                                    return Err(CompileError::new(
                                        "sorted() needs at least one argument".to_string(),
                                        n.line,
                                        n.col,
                                        Vec::new(),
                                    ));
                                } else {
                                    self.js(&args[0])?
                                };
                                let mut out = format!("{}.slice()", src_arg);
                                if let Some(k) = key_fn {
                                    out = format!("{}.sort((a, b) => ({})(a) < ({})(b) ? -1 : ({})(a) > ({})(b) ? 1 : 0)", out, k, k, k, k);
                                } else {
                                    out = format!("{}.sort()", out);
                                }
                                if let Some(rv) = reverse {
                                    out = format!("({}) ? {}.reverse() : {}", rv, out, out);
                                }
                                return Ok(out);
                            }
                            if id == "max" || id == "min" {
                                let src_arg = if args.is_empty() {
                                    return Err(CompileError::new(
                                        format!("{}() needs at least one argument", id),
                                        n.line,
                                        n.col,
                                        Vec::new(),
                                    ));
                                } else {
                                    self.js(&args[0])?
                                };
                                let fn_name = if id == "max" { "max_by" } else { "min_by" };
                                self.used_helpers.borrow_mut().insert(fn_name.into());
                                if let Some(k) = key_fn {
                                    return Ok(format!("{}({}, {})", fn_name, src_arg, k));
                                }
                                if let Some(dv) = kwargs
                                    .iter()
                                    .find(|(k, _)| k == "default")
                                    .map(|(_, v)| self.js(v))
                                    .transpose()?
                                {
                                    self.used_helpers.borrow_mut().insert("first_or".into());
                                    let base = if id == "max" {
                                        format!("Math.max(...{})", src_arg)
                                    } else {
                                        format!("Math.min(...{})", src_arg)
                                    };
                                    return Ok(format!(
                                        "{}.length ? {} : {}",
                                        src_arg, base, dv
                                    ));
                                }
                            }
                        }
                    }
                    if args.len() == 1 && kwargs.is_empty() {
                        let arg = self.js(&args[0])?;
                        match id.as_str() {
                            // `len(xs)` on a dict is Object.keys().length: a
                            // plain object has no `.length`, which is how
                            // `len(d)` used to yield `undefined` and poison
                            // every arithmetic expression downstream.
                            "len" => {
                                self.used_helpers.borrow_mut().insert("len_of".into());
                                return Ok(format!("len_of({})", arg));
                            }
                            // Python's `pow(a, b)`; JS has Math.pow.
                            "pow" => return Ok(format!("Math.pow({})", arg)),
                            // `divmod(a, b)` -> [a // b, a % b]
                            "divmod" => {
                                self.used_helpers.borrow_mut().insert("divmod".into());
                                return Ok(format!("divmod({})", arg));
                            }
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
                            "isinstance" => {
                                self.used_helpers.borrow_mut().insert("isinstance".into());
                                return Ok(format!("isinstance({})", arg));
                            }
                            "range" => {
                                self.used_helpers.borrow_mut().insert("range".into());
                                return Ok(format!("range({})", arg));
                            }
                            "enumerate" => {
                                self.used_helpers.borrow_mut().insert("enumerate".into());
                                return Ok(format!("enumerate({})", arg));
                            }
                            "ord" => return Ok(format!("{}.charCodeAt(0)", arg)),
                            "chr" => return Ok(format!("String.fromCharCode({})", arg)),
                            _ => {}
                        }
                    }
                }

                if Self::is_element(func) {
                    return self.jsx_inline(func, args, kwargs);
                }
                // Keyword arguments against a function defined in this file are
                // reordered into positional ones. `f(b=2, a=1)` on
                // `def f(a, b)` must call `f(1, 2)` — anything else is a syntax
                // error in the emitted JS (`f(b: 2, a: 1)`).
                if !kwargs.is_empty() {
                    if let Kind::Name(id) = &func.kind {
                        let sig = self.fn_params.borrow().get(id).cloned();
                        if let Some(names) = sig {
                            let mut slots: Vec<Option<String>> = vec![None; names.len()];
                            let mut positional = args.len();
                            for a in args {
                                let js = self.js(a)?;
                                if positional < slots.len() {
                                    slots[positional] = Some(js);
                                }
                                positional += 1;
                            }
                            let mut unknown: Option<String> = None;
                            for (k, v) in kwargs {
                                match names.iter().position(|n| n == k) {
                                    Some(i) => slots[i] = Some(self.js(v)?),
                                    None => unknown = Some(k.clone()),
                                }
                            }
                            if let Some(bad) = unknown {
                                return Err(CompileError::new(
                                    format!("{}() has no parameter named `{}`", id, bad),
                                    n.line,
                                    n.col,
                                    Vec::new(),
                                )
                                .with_hint(format!("{}() takes: {}", id, names.join(", "))));
                            }
                            let filled: Vec<String> =
                                slots.into_iter().filter_map(|x| x).collect();
                            return Ok(format!("{}({})", id, filled.join(", ")));
                        }
                    }
                }
                let fn_str = self.js(func)?;
                let mut all = Vec::new();
                for a in args {
                    all.push(self.js(a)?);
                }
                // No signature available (an imported library function): emit
                // the call that JS can actually parse, and say so, rather than
                // producing `f(a: 1)` and reporting success.
                if !kwargs.is_empty() {
                    return Err(CompileError::new(
                        format!(
                            "keyword arguments are only supported for functions defined in this file (called `{}`)",
                            fn_str
                        ),
                        n.line,
                        n.col,
                        Vec::new(),
                    )
                    .with_hint("pass the argument positionally, or wrap the options in a dict"));
                }
                Ok(format!("{}({})", fn_str, all.join(", ")))
            }
            Kind::Slice {
                obj,
                start,
                stop,
                step,
            } => {
                let o = self.js(obj)?;
                // `xs[::-1]` is Python's reverse idiom. `slice()` cannot express
                // a negative step, so it goes through a runtime helper that
                // handles every sign combination.
                if let Some(st) = step {
                    self.used_helpers.borrow_mut().insert("slice_step".into());
                    let a = match start {
                        Some(s) => self.js(s)?,
                        None => "null".into(),
                    };
                    let b = match stop {
                        Some(s) => self.js(s)?,
                        None => "null".into(),
                    };
                    return Ok(format!("slice_step({}, {}, {}, {})", o, a, b, self.js(st)?));
                }
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
            // `0 < x < 10` -> `(0 < x) && (x < 10)`. Comparing a boolean with a
            // number is valid JS that answers a different question, so the
            // chain has to be rebuilt with `&&`.
            Kind::ChainedCompare { ops, operands } => {
                let mut parts: Vec<String> = Vec::new();
                for i in 0..ops.len() {
                    let l = self.js(&operands[i])?;
                    let r = self.js(&operands[i + 1])?;
                    let op = match ops[i].as_str() {
                        "is" => "===",
                        "is not" => "!==",
                        other => other,
                    };
                    parts.push(format!("({} {} {})", l, op, r));
                }
                Ok(format!("({})", parts.join(" && ")))
            }
            // Python membership. JS `in` answers a different question on
            // strings and arrays (it checks keys), and throws on primitives, so
            // each container kind gets the check that actually means
            // "does this contain that".
            Kind::Contains {
                item,
                container,
                negated,
            } => {
                let needle = self.js(item)?;
                let hay = self.js(container)?;
                self.used_helpers.borrow_mut().insert("contains".into());
                let call = format!("contains({}, {})", hay, needle);
                Ok(if *negated {
                    format!("(!{})", call)
                } else {
                    call
                })
            }
            Kind::Assert { test, message } => {
                let cond = self.js(test)?;
                self.used_helpers.borrow_mut().insert("assert_".into());
                let msg = match message {
                    Some(m) => self.js(m)?,
                    None => "\"Assertion failed\"".to_string(),
                };
                // `assert x > 0, "positive"` must throw. Emitting it as an
                // expression made the check disappear silently.
                Ok(format!("assert_({}, {})", cond, msg))
            }
            Kind::Raise(v) => {
                let msg = match v {
                    Some(m) => self.js(m)?,
                    None => "new Error(\"raised\")".to_string(),
                };
                self.used_helpers.borrow_mut().insert("raise_".into());
                Ok(format!("raise_({})", msg))
            }
            Kind::DynamicImport(spec) => {
                let s = self.js(spec)?;
                // `import("./Page.hyx")` -> `import("./Page.hyx")` — the
                // specifier must stay a literal for the bundler to split on it.
                Ok(format!("import({})", s))
            }
            // `{k: v for x in xs}` -> Object.fromEntries(xs.map(...))
            Kind::DictComprehension {
                key,
                value,
                target,
                iter,
                cond,
            } => {
                let it = self.js(iter)?;
                let k = self.js(key)?;
                let v = self.js(value)?;
                let mut src = it;
                if let Some(c) = cond {
                    src = format!("{}.filter(({}) => {})", src, target, self.js(c)?);
                }
                Ok(format!(
                    "Object.fromEntries({}.map(({}) => [{} , {}]))",
                    src, target, k, v
                ))
            }
            // `{x for x in xs}` -> a real Set (dedupe is part of the meaning).
            Kind::SetComprehension {
                expr,
                target,
                iter,
                cond,
            } => {
                let it = self.js(iter)?;
                let e = self.js(expr)?;
                let mut src = it;
                if let Some(c) = cond {
                    src = format!("{}.filter(({}) => {})", src, target, self.js(c)?);
                }
                Ok(format!("new Set({}.map(({}) => {}))", src, target, e))
            }
            // `(n := len(xs))` — bind and use in one expression. `js()` takes
            // `&self`, so the binding is recorded through the same interior
            // mutability the helper set uses.
            Kind::Walrus { name, value } => {
                let v = self.js(value)?;
                self.walrus_names.borrow_mut().insert(name.clone());
                Ok(format!("({} = {})", name, v))
            }
            Kind::Yield(v) => match v {
                Some(e) => Ok(format!("yield {}", self.js(e)?)),
                None => Ok("yield".to_string()),
            },
            // A template literal is passed through untouched: its contents are
            // already JavaScript, and re-escaping would change the output.
            Kind::TemplateLiteral(raw) => Ok(raw.clone()),
            Kind::Super => Ok("super".to_string()),
            Kind::Await(v) => Ok(format!("await {}", self.js(v)?)),
            Kind::New(inner) => Ok(format!("new {}", self.js(inner)?)),
            Kind::OptCall { func, args, kwargs } => {
                let f = self.js(func)?;
                let mut all: Vec<String> = Vec::new();
                for a in args {
                    all.push(self.js(a)?);
                }
                for (k, v) in kwargs {
                    all.push(format!("{}: {}", prop_map(k), self.js(v)?));
                }
                Ok(format!("{}?.({})", f, all.join(", ")))
            }
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
        Ok(format!(
            "<{}{}>\n{}\n{}</{}>",
            tag, a, inner, pad_close, tag
        ))
    }

    fn child(&self, s: &Node, ind: usize) -> Result<String, CompileError> {
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

                // A declaration only makes sense when the target IS a name.
                // `node.style.transform = x` or `rows[i] = v` must emit a plain
                // assignment — emitting `const` in front of a member access
                // produced `const node.style.transform = ...`, which is a
                // syntax error that nevertheless used to build "successfully".
                if let Kind::Name(id) = &target.kind {
                    if let Some(scope) = self.scopes.last_mut() {
                        // Mutable names get `let` at their first assignment so
                        // later writes are legal; everything else is `const`.
                        let declare = if scope.is_mutable(id) { "let" } else { "const" };
                        // `declared` already holds hoisted names, so a name that
                        // was declared at the top of the function falls through
                        // to a plain assignment here instead of being declared
                        // a second time.
                        if scope.declared.insert(id.clone()) {
                            self.w(&format!("{} {} = {};", declare, lhs, rhs));
                        } else {
                            self.w(&format!("{} = {};", lhs, rhs));
                        }
                        return Ok(());
                    }
                    self.w(&format!("const {} = {};", lhs, rhs));
                    return Ok(());
                }
                // Destructuring (`a, b = pair()`) binds names, so it declares.
                // Member and index targets do NOT: `const x.y = 1` is a syntax
                // error, so those always emit a plain assignment.
                let binds_names = match &target.kind {
                    Kind::Tuple(items) => items.iter().all(|i| matches!(i.kind, Kind::Name(_))),
                    Kind::Dict(_) => true,
                    _ => false,
                };
                if binds_names {
                    self.w(&format!("const {} = {};", lhs, rhs));
                } else {
                    self.w(&format!("{} = {};", lhs, rhs));
                }
            }
            // `x, y = y, x` — Python's parallel assignment. `let [x, y] = ...`
            // already evaluates the right side fully before binding, which is
            // exactly Python's semantics, so the array form is correct. (Doing
            // it as two statements would break swap.)
            Kind::TupleAssign { targets, value } => {
                let rhs = self.js(value)?;
                let names: Vec<String> =
                    targets.iter().map(|x| self.js(x)).collect::<Result<_, _>>()?;
                // A destructuring declaration for names that ALREADY exist
                // (parameters, or a hoisted binding) is a SyntaxError —
                // `let [a, b] = [b, a]` inside a function taking `a, b` refuses
                // to parse. Re-binding is a plain assignment.
                let already = self
                    .scopes
                    .last()
                    .map(|scope| {
                        targets.iter().all(|t| match &t.kind {
                            Kind::Name(id) => {
                                scope.declared.contains(id) || scope.params.contains(id)
                            }
                            _ => false,
                        })
                    })
                    .unwrap_or(false);
                if already {
                    self.w(&format!("[{}] = {};", names.join(", "), rhs));
                } else {
                    if let Some(scope) = self.scopes.last_mut() {
                        for t in targets {
                            if let Kind::Name(id) = &t.kind {
                                scope.declared.insert(id.clone());
                            }
                        }
                    }
                    self.w(&format!("let [{}] = {};", names.join(", "), rhs));
                }
            }
            // `a = b = c = 0` — each name needs its own binding unless it is
            // already declared, so the names are split out and only the last
            // step carries the value.
            Kind::ChainedAssign { targets, value } => {
                let rhs = self.js(value)?;
                let mut exprs: Vec<String> = Vec::new();
                for t in targets {
                    exprs.push(self.js(t)?);
                }
                // A single assignment chain in JS (`a = b = c = 0`) needs the
                // names declared first; without this the first build is a
                // ReferenceError in strict mode, which every ES module is.
                if let Some(scope) = self.scopes.last() {
                    let undeclared: Vec<&String> = targets
                        .iter()
                        .filter_map(|t| match &t.kind {
                            Kind::Name(id) if !scope.declared.contains(id) => Some(id),
                            _ => None,
                        })
                        .collect();
                    if !undeclared.is_empty() {
                        // Always `let`: a chained assignment that never
                        // reassigns is rare, and guessing wrong would turn a
                        // later write into a TypeError.
                        let names: Vec<String> =
                            undeclared.iter().map(|s| (*s).clone()).collect();
                        self.w(&format!("let {};", names.join(", ")));
                    }
                }
                if let Some(scope) = self.scopes.last_mut() {
                    for t in targets {
                        if let Kind::Name(id) = &t.kind {
                            scope.declared.insert(id.clone());
                        }
                    }
                }
                self.w(&format!("{} = {};", exprs.join(" = "), rhs));
            }
            // `class Foo(Base):` in a .hyx file — custom error types, data
            // classes used by components, or a legacy-style helper.
            Kind::Class {
                name,
                base,
                methods,
                body,
            } => {
                // Recorded so `Point(1, 2)` emits `new Point(1, 2)`: calling a
                // class in Python constructs an instance.
                self.class_names.borrow_mut().insert(name.clone());
                let head = match base {
                    Some(b) => format!("class {} extends {}", name, b),
                    None => format!("class {}", name),
                };
                self.w(&format!("{} {{", head));
                self.depth += 1;
                for st in body {
                    if let Kind::Assign { target, value } = &st.kind {
                        if let Kind::Name(n) = &target.kind {
                            let v = self.js(value)?;
                            self.w(&format!("{} = {};", n, v));
                        }
                    }
                }
                for m in methods {
                    if let Kind::Method {
                        name: mname,
                        params,
                        body: mbody,
                        is_async,
                        decorator,
                    } = &m.kind
                    {
                        let js_name = if mname == "__init__" {
                            "constructor"
                        } else if mname == "__str__" {
                            "toString"
                        } else {
                            mname.as_str()
                        };
                        let is_static = decorator.as_deref() == Some("staticmethod");
                        let filtered: Vec<Param> = params
                            .iter()
                            .filter(|p| p.name != "self" && p.name != "cls")
                            .cloned()
                            .collect();
                        let ps = self.format_params(&filtered)?;
                        let keyword = if *is_async { "async " } else { "" };
                        self.w(&format!(
                            "{}{}{}({}) {{",
                            keyword,
                            if is_static { "static " } else { "" },
                            js_name,
                            ps
                        ));
                        self.depth += 1;
                        let mut scope = Scope::scan(mbody);
                        for p in params {
                            let bare = p.name.trim_start_matches("...").to_string();
                            scope.params.insert(bare.clone());
                            scope.declared.insert(bare);
                        }
                        self.scopes.push(scope);
                        for stmt in mbody {
                            self.stmt(stmt)?;
                        }
                        self.scopes.pop();
                        self.depth -= 1;
                        self.w("}");
                    }
                }
                self.depth -= 1;
                self.w("}");
            }
            // `@deco` on a `def`: define first, then apply — Python's order.
            Kind::DecoratedDef { decorators, inner } => {
                let name = match &inner.kind {
                    Kind::Def { name, .. }
                    | Kind::AsyncDef { name, .. }
                    | Kind::Class { name, .. } => name.clone(),
                    _ => {
                        return Err(CompileError::new(
                            "a decorator must be applied to a def or class".to_string(),
                            s.line,
                            s.col,
                            Vec::new(),
                        ))
                    }
                };
                self.stmt(inner)?;
                for d in decorators {
                    self.w(&format!("{} = {}({});", name, d, name));
                }
            }
            // `yield x` is a statement in Python's grammar even though it
            // produces a value, so it must not be routed through ExprStmt.
            Kind::Yield(_) => {
                let val = self.js(s)?;
                self.w(&format!("{};", val));
            }
            Kind::Assert { .. } | Kind::Raise(_) => {
                let val = self.js(s)?;
                self.w(&format!("{};", val));
            }
            Kind::AugAssign { target, op, value } => {
                let lhs = self.js(target)?;
                let rhs = self.js(value)?;
                // `x **= 2` / `x //= 2` — JS has no such operators, so they are
                // spelled out. `//=` also needs Math.floor, not truncation.
                let stmt = match op.as_str() {
                    "**=" => format!("{} = pow({}, {});", lhs, lhs, rhs),
                    "//=" => format!("{} = Math.floor({} / {});", lhs, lhs, rhs),
                    // `op` already carries the `=` (`+=`), so it must not be
                    // appended again — that produced `x +== 1`.
                    other => format!("{} {} {};", lhs, other, rhs),
                };
                self.w(&stmt);
            }
            Kind::Return(v) => {
                if let Some(val_node) = v {
                    let val = self.js(val_node)?;
                    self.w(&format!("return {};", val));
                } else {
                    self.w("return;");
                }
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
                let mut scope = Scope::scan(body);
                for p in params {
                    let bare = p.name.trim_start_matches("...").to_string();
                    scope.params.insert(bare);
                    scope.declared.insert(p.name.trim_start_matches("...").to_string());
                }
                self.scopes.push(scope);
                self.hoist_nested_assignments();
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.scopes.pop();
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
                    if names.is_empty() {
                        self.imports.insert(format!("import '{}';", f));
                    } else if names.len() == 1 && names[0].starts_with("* as ") {
                        self.imports
                            .insert(format!("import {} from '{}';", names[0], f));
                    } else if crate::hx_target::asset_import(f) && names.len() == 1 {
                        // Asset modules expose a single default export, never a
                        // named one: `from "./logo.svg" import logo` has to become
                        // `import logo from './logo.svg'` or the bundler fails
                        // with `No matching export in "logo.svg" for import
                        // "logo"`. See `asset_import` for the reasoning.
                        self.imports
                            .insert(format!("import {} from '{}';", names[0], f));
                    } else {
                        self.imports.insert(format!(
                            "import {{ {} }} from '{}';",
                            names.join(", "),
                            f
                        ));
                    }
                } else {
                    self.imports
                        .insert(format!("import {} from 'serpent';", names.join(", ")));
                }
            }
            Kind::Interface { name, body } => {
                self.w(&format!("export interface {} {{", name));
                for line in body.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        // Map Python types to TypeScript in interface fields
                        let mapped = trimmed
                            .replace(": str", ": string")
                            .replace(": int", ": number")
                            .replace(": float", ": number")
                            .replace(": bool", ": boolean")
                            .replace(": None", ": null")
                            .replace(": Any", ": any")
                            .replace(": list", ": Array")
                            .replace(": dict", ": Record");
                        self.w(&format!("  {};", mapped));
                    }
                }
                self.w("}");
            }
            Kind::TypeAlias { name, body } => {
                self.w(&format!("export type {} = {};", name, body));
            }
            Kind::RawTS(text) => {
                self.w(text);
            }
            _ => {}
        }
        Ok(())
    }

    /// Declare, at the top of the current function, every name whose first
    /// assignment sits inside a nested block. Python's names are function
    /// scoped; without this, `if c: v = 1` followed by `return v` emitted a
    /// binding that only existed inside the branch. `let` (never `const`)
    /// because the declaration is intentionally uninitialised.
    fn hoist_nested_assignments(&mut self) {
        let Some(scope) = self.scopes.last_mut() else {
            return;
        };
        let names = scope.hoist_names();
        if names.is_empty() {
            return;
        }
        // Recording them as declared is what stops the first assignment inside
        // the branch from emitting a second, shadowing binding.
        for n in &names {
            scope.declared.insert(n.clone());
        }
        for n in names {
            self.w(&format!("let {};", n));
        }
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

    pub fn component(
        &mut self,
        name: &str,
        params: &[Param],
        body: &[Node],
    ) -> Result<(), CompileError> {
        let ps = self.format_params(params)?;
        // `slot` inside the body renders `props.children`, so a component that
        // uses it must accept the prop. Without this the emitted code
        // referenced a bare `slot` identifier that did not exist — the build
        // succeeded and the page died at render time with "slot is not defined".
        let uses_slot = body.iter().any(node_uses_slot);
        let arg = if params.is_empty() {
            if uses_slot {
                "{ children }: { children?: React.ReactNode }".to_string()
            } else {
                String::new()
            }
        } else if uses_slot {
            // `children` must appear in the DESTRUCTURING PATTERN, not only in
            // the type annotation: a type alone does not bind a variable, and
            // the body reads `children` directly.
            format!(
                "{{ {}, children }}: {}Props & {{ children?: React.ReactNode }}",
                ps, name
            )
        } else {
            format!("{{ {} }}: {}Props", ps, name)
        };
        self.w(&format!("export function {}({}) {{", name, arg));
        self.depth += 1;

        let mut scope = Scope::scan(body);
        for p in params {
            let bare = p.name.trim_start_matches("...").to_string();
            scope.params.insert(bare.clone());
            scope.declared.insert(bare);
        }
        self.scopes.push(scope);
        self.hoist_nested_assignments();

        let tree_count = body
            .iter()
            .filter(|s| matches!(s.kind, Kind::Tree { .. }))
            .count();
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
            let inner = parts
                .into_iter()
                .map(|p| format!("{}{}", pad2, p))
                .collect::<Vec<_>>()
                .join("\n");
            self.w(&format!(
                "return (\n{}<>\n{}\n{}</>\n{});",
                pad, inner, pad, pad
            ));
        } else {
            for s in body {
                self.stmt(s)?;
            }
        }
        self.scopes.pop();
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
                    if names.is_empty() {
                        self.imports.insert(format!("import '{}';", f));
                    } else if names.len() == 1 && names[0].starts_with("* as ") {
                        self.imports
                            .insert(format!("import {} from '{}';", names[0], f));
                    } else if crate::hx_target::asset_import(f) && names.len() == 1 {
                        // Asset modules expose a single default export, never a
                        // named one: `from "./logo.svg" import logo` has to become
                        // `import logo from './logo.svg'` or the bundler fails
                        // with `No matching export in "logo.svg" for import
                        // "logo"`. See `asset_import` for the reasoning.
                        self.imports
                            .insert(format!("import {} from '{}';", names[0], f));
                    } else {
                        self.imports.insert(format!(
                            "import {{ {} }} from '{}';",
                            names.join(", "),
                            f
                        ));
                    }
                } else {
                    self.imports
                        .insert(format!("import {} from 'serpent';", names.join(", ")));
                }
            }
        }

        // Collect every function signature first: a call may appear before the
        // `def` it refers to, and kwargs must be resolved against it.
        {
            let mut table = self.fn_params.borrow_mut();
            for st in body {
                let mut visit = |name: &str, params: &[Param]| {
                    let names = params
                        .iter()
                        .map(|p| p.name.trim_start_matches("...").to_string())
                        .collect::<Vec<_>>();
                    table.insert(name.to_string(), names);
                };
                match &st.kind {
                    Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                        visit(name, params)
                    }
                    Kind::Export(inner) => match &inner.kind {
                        Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                            visit(name, params)
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
        }

        // ponytail: single top-level scope; nested function scopes already push their own
        let top_scope = Scope::scan(body);
        self.scopes.push(top_scope);

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

        self.scopes.pop();

        // Inject imports for any runtime helper the source used but did not
        // import itself. `s.capitalize()` should not need the author to know
        // that `capitalize` lives in the runtime.
        let helpers: Vec<String> = self.used_helpers.borrow().iter().cloned().collect();
        if !helpers.is_empty() {
            let mut h = helpers;
            h.sort();
            self.imports
                .insert(format!("import {{ {} }} from 'serpent';", h.join(", ")));
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
            segs.push(format!(
                "{}{}{}",
                encode_vlq(0),
                encode_vlq(0),
                encode_vlq(0)
            ));
        }
        for sl in &self.linemap {
            let sl_i = *sl as i64;
            let d = (sl_i - 1) - prev_src;
            prev_src = sl_i - 1;
            segs.push(format!(
                "{}{}{}",
                encode_vlq(0),
                encode_vlq(d),
                encode_vlq(0)
            ));
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
        let module = crate::parser::Parser::new(toks, lines)
            .module()
            .expect("parse failed");
        let mut em = Emitter::new();
        em.run(&module).expect("emit failed")
    }

    fn has_all(out: &str, frags: &[&str]) {
        for f in frags {
            assert!(
                out.contains(f),
                "missing fragment {:?} in output:\n{}",
                f,
                out
            );
        }
    }

    fn lacks(out: &str, frag: &str) {
        assert!(
            !out.contains(frag),
            "unexpected fragment {:?} in output:\n{}",
            frag,
            out
        );
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
        has_all(&out, &["len_of(items)"]);
    }

    #[test]
    fn string_number_builtins_map_to_js() {
        let out = emit_tsx("component A():\n    a = str(x)\n    b = int(x)\n    c = float(x)\n    d = abs(x)\n    e = round(x)\n    f = bool(x)\n");
        has_all(
            &out,
            &[
                "String(x)",
                "parseInt(x)",
                "parseFloat(x)",
                "Math.abs(x)",
                "Math.round(x)",
                "Boolean(x)",
            ],
        );
    }

    #[test]
    fn sum_maps_to_reduce() {
        let out = emit_tsx("component A():\n    n = sum(xs)\n");
        has_all(&out, &["xs.reduce((a, b) => a + b, 0)"]);
    }

    #[test]
    fn sorted_reversed_list_map_to_slice() {
        let out = emit_tsx(
            "component A():\n    a = sorted(xs)\n    b = reversed(xs)\n    c = list(xs)\n",
        );
        has_all(
            &out,
            &["xs.slice().sort()", "xs.slice().reverse()", "xs.slice()"],
        );
    }

    #[test]
    fn string_methods_emitted() {
        let out = emit_tsx("component A():\n    a = t.strip()\n    b = t.upper()\n    c = t.lower()\n    d = t.startswith(\"x\")\n    e = t.endswith(\"y\")\n");
        has_all(
            &out,
            &[
                "t.trim()",
                "t.toUpperCase()",
                "t.toLowerCase()",
                "t.startsWith(\"x\")",
                "t.endsWith(\"y\")",
            ],
        );
    }

    #[test]
    fn runtime_helpers_are_auto_imported() {
        let out = emit_tsx("component A():\n    s = t.capitalize()\n");
        has_all(
            &out,
            &["import { capitalize } from 'serpent';", "capitalize(t)"],
        );
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
        let out =
            emit_tsx("component A():\n    div:\n        h1: \"Hello\"\n        p: \"World\"\n");
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
        let out = emit_tsx(
            "component A():\n    div:\n        br:\n        hr:\n        input(value=x)\n",
        );
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
        let out = emit_tsx(
            "component A():\n    ul:\n        for it in items:\n            li(key=it): it\n",
        );
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
        let out = emit_tsx(
            "component Btn(label: str, count: int = 0, on_click=None):\n    button: label\n",
        );
        has_all(
            &out,
            &[
                "export function Btn({ label, count = 0, on_click }: BtnProps)",
                "export interface BtnProps {",
                "label: string;",
                "count?: number;",
                "on_click?: any;",
            ],
        );
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
    fn reassigned_variable_emits_let_then_reassignment() {
        let out = emit_tsx("component A():\n    x = 1\n    x = 2\n    div: \"z\"\n");
        has_all(&out, &["let x = 1;", "x = 2;"]);
        lacks(&out, "const x = 1;");
        lacks(&out, "const x = 2;");
        lacks(&out, "let x = 2;");
    }

    #[test]
    fn single_assign_variable_emits_const() {
        let out = emit_tsx("component A():\n    y = 1\n    div: \"z\"\n");
        has_all(&out, &["const y = 1;"]);
        lacks(&out, "let y = 1;");
    }

    #[test]
    fn augmented_assign_emits_let_then_aug() {
        let out = emit_tsx("component A():\n    z = 0\n    z += 1\n    div: \"z\"\n");
        has_all(&out, &["let z = 0;", "z += 1;"]);
        lacks(&out, "const z = 0;");
    }

    #[test]
    fn def_reassigned_and_augmented_emits_let() {
        let out = emit_tsx(
            "def calc():\n    x = 1\n    x = 2\n    z = 0\n    z += 1\n    return x + z\n",
        );
        has_all(&out, &["let x = 1;", "x = 2;", "let z = 0;", "z += 1;"]);
        lacks(&out, "const x = 1;");
        lacks(&out, "const z = 0;");
    }

    #[test]
    fn tuple_unpack_emits_array_destructure() {
        let out = emit_tsx("component A():\n    a, b = pair()\n");
        has_all(&out, &["let [a, b] = pair();"]);
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
        let out =
            emit_tsx("component A():\n    if a:\n        go()\n    for x in xs:\n        run(x)\n");
        has_all(&out, &["if (a) {", "for (const x of xs) {"]);
    }

    #[test]
    fn js_builtins_are_not_elements() {
        let math_cos = Node::new(
            Kind::Attr {
                obj: Box::new(Node::new(Kind::Name("Math".into()), 1, 1)),
                name: "cos".into(),
            },
            1,
            1,
        );
        assert!(!Emitter::is_element(&math_cos));

        let date_now = Node::new(
            Kind::Attr {
                obj: Box::new(Node::new(Kind::Name("Date".into()), 1, 1)),
                name: "now".into(),
            },
            1,
            1,
        );
        assert!(!Emitter::is_element(&date_now));

        let resize_obs = Node::new(Kind::Name("ResizeObserver".into()), 1, 1);
        assert!(!Emitter::is_element(&resize_obs));

        let button = Node::new(Kind::Name("button".into()), 1, 1);
        assert!(Emitter::is_element(&button));

        let custom_comp = Node::new(Kind::Name("StrokeText".into()), 1, 1);
        assert!(Emitter::is_element(&custom_comp));
    }

    #[test]
    fn bare_return_emits_semicolon() {
        let out = emit_tsx("component A():\n    def go():\n        return\n");
        has_all(&out, &["return;"]);
    }

    #[test]
    fn keyword_kwargs_emit_cleanly() {
        let out = emit_tsx(
            "component A():\n    button(type=\"button\", for=\"my-id\"):\n        \"Click\"\n",
        );
        has_all(&out, &["<button type=\"button\" htmlFor=\"my-id\">"]);
    }

    // ------------------------------------------------------------------- imports

    #[test]
    fn imports_are_deduplicated_and_sorted() {
        let out = emit_tsx(
            "from b import y\nfrom a import x\nfrom b import y\n\ncomponent A():\n    div: \"z\"\n",
        );
        let lines: Vec<_> = out.lines().filter(|l| l.starts_with("import ")).collect();
        assert_eq!(
            lines,
            vec!["import { x } from 'a';", "import { y } from 'b';",]
        );
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
        SerdeJsonLite {
            mappings: s[start..end].to_string(),
        }
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
        let out = emit_tsx(
            "component A():\n    ul:\n        for it in items:\n            li(key=it): it\n",
        );
        has_all(&out, &["<li key={it}>"]);
        lacks(&out, "key={key}");
    }
}

/// True when a component body renders `slot` anywhere — including inside the
/// JSX tree it returns, which is where the marker actually appears in source.
fn node_uses_slot(n: &Node) -> bool {
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
