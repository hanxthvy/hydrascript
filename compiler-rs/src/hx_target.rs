// [xihanzu-NR]
//! The `.hx` target: plain JavaScript instead of React TSX.
//!
//! Same front end (lexer, parser, AST) as `.hsx`. Only the emitter differs, and
//! only in three places:
//!   1. `def` emits a hoisted `function` declaration, not a `const` arrow.
//!   2. Tree blocks and `component` are errors — there is no element to nest.
//!   3. Props are not renamed; `on_click` stays `on_click`.
//!
//! Everything else (f-strings, comprehensions, builtins, operators) is shared.

use crate::ast::{Kind, Node, Param};
use crate::emitter::{free_func, str_method, Scope};
use crate::error::CompileError;

pub struct JsEmitter {
    pub lines: Vec<String>,
    pub linemap: Vec<usize>,
    pub cur_src: usize,
    pub depth: usize,
    pub imports: std::collections::HashSet<String>,
    pub used_helpers: std::cell::RefCell<std::collections::HashSet<String>>,
    /// Every `def` in the file, by name. Keyword arguments do not exist in
    /// JavaScript, so a call like `f(a=1, b=2)` needs the signature to be
    /// reordered into positional arguments — otherwise it emits `f(a: 1)`,
    /// which no JS engine parses.
    pub fn_params: std::cell::RefCell<std::collections::HashMap<String, Vec<String>>>,
    /// Names bound by a walrus (`:=`).
    pub walrus_names: std::cell::RefCell<std::collections::HashSet<String>>,
    /// Names declared by `class`, so calling one emits `new` — in
    /// Python, `Foo(1)` constructs an instance.
    pub class_names: std::cell::RefCell<std::collections::HashSet<String>>,
    pub head_lines: Vec<String>,
    pub scopes: Vec<Scope>,
}

impl JsEmitter {
    pub fn new() -> Self {
        Self {
            lines: Vec::new(),
            linemap: Vec::new(),
            cur_src: 1,
            depth: 0,
            imports: std::collections::HashSet::new(),
            used_helpers: std::cell::RefCell::new(std::collections::HashSet::new()),
            fn_params: std::cell::RefCell::new(std::collections::HashMap::new()),
            walrus_names: std::cell::RefCell::new(std::collections::HashSet::new()),
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
            Kind::Super => Ok("super".to_string()),
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
                if op == "+"
                    && (matches!(left.kind, Kind::List(_) | Kind::Tuple(_))
                        || matches!(right.kind, Kind::List(_) | Kind::Tuple(_)))
                {
                    return Ok(format!("[...{}, ...{}]", l, r));
                }
                // `//` is floor division, and JS `/` truncates toward zero.
                if op == "floordiv" {
                    return Ok(format!("Math.floor({} / {})", l, r));
                }
                // `is` / `is not` -> strict identity (JS has no `is` operator).
                if op == "is" {
                    return Ok(format!("({} === {})", l, r));
                }
                if op == "is not" {
                    return Ok(format!("({} !== {})", l, r));
                }
                Ok(format!("({} {} {})", l, op, r))
            }
            Kind::Unary { op, operand } => Ok(format!("({}{})", op, self.js(operand)?)),
            Kind::New(inner) => Ok(format!("new {}", self.js(inner)?)),
            Kind::OptCall { func, args, kwargs } => {
                let f = self.js(func)?;
                let mut all: Vec<String> = Vec::new();
                for a in args {
                    all.push(self.js(a)?);
                }
                for (k, v) in kwargs {
                    all.push(format!("{}: {}", k, self.js(v)?));
                }
                Ok(format!("{}?.({})", f, all.join(", ")))
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
            Kind::List(items) | Kind::Tuple(items) => {
                let bits: Result<Vec<_>, _> = items.iter().map(|i| self.js(i)).collect();
                Ok(format!("[{}]", bits?.join(", ")))
            }
            Kind::Spread(v) => Ok(format!("...{}", self.js(v)?)),
            // `0 < x < 10` -> `(0 < x) && (x < 10)`: comparing a boolean with a
            // number is valid JS with the wrong answer.
            Kind::ChainedCompare { ops, operands } => {
                let mut parts: Vec<String> = Vec::new();
                for i in 0..ops.len() {
                    let l = self.js(&operands[i])?;
                    let rr = self.js(&operands[i + 1])?;
                    let op = match ops[i].as_str() {
                        "is" => "===",
                        "is not" => "!==",
                        other => other,
                    };
                    parts.push(format!("({} {} {})", l, op, rr));
                }
                Ok(format!("({})", parts.join(" && ")))
            }
            // Python membership; JS `in` asks about keys, not values.
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
            Kind::DynamicImport(spec) => Ok(format!("import({})", self.js(spec)?)),
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
            Kind::Await(v) => Ok(format!("await {}", self.js(v)?)),
            Kind::Slice {
                obj,
                start,
                stop,
                step,
            } => {
                let o = self.js(obj)?;
                // `xs[::-1]` needs a negative step, which slice() cannot express.
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
                    return Ok(format!(
                        "slice_step({}, {}, {}, {})",
                        o,
                        a,
                        b,
                        self.js(st)?
                    ));
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
                // `Point(1, 2)` constructs in Python; JS needs the `new`.
                if let Kind::Name(id) = &func.kind {
                    if self.class_names.borrow().contains(id) {
                        let bits: Result<Vec<_>, _> =
                            args.iter().map(|a| self.js(a)).collect();
                        return Ok(format!("new {}({})", id, bits?.join(", ")));
                    }
                }
                // `super().__init__(x)` -> `super(x)`; other calls on `super`
                // become `super.name(...)`, which is JS semantics exactly.
                if let Kind::Attr { obj, name } = &func.kind {
                    if matches!(obj.kind, Kind::Super) {
                        let bits: Result<Vec<_>, _> =
                            args.iter().map(|a| self.js(a)).collect();
                        let all = bits?;
                        return Ok(if name == "__init__" {
                            format!("super({})", all.join(", "))
                        } else {
                            format!("super.{}({})", str_method(name), all.join(", "))
                        });
                    }
                }
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
                if let Kind::Name(id) = &func.kind {
                    if args.len() == 1 && kwargs.is_empty() {
                        let arg = self.js(&args[0])?;
                        match id.as_str() {
                            // `len` on a dict needs Object.keys().length — a
                            // plain object has no `.length`, so this used to
                            // evaluate to undefined and poison the arithmetic
                            // that followed.
                            "len" => {
                                self.used_helpers.borrow_mut().insert("len_of".into());
                                return Ok(format!("len_of({})", arg));
                            }
                            "pow" => return Ok(format!("Math.pow({})", arg)),
                            "str" => return Ok(format!("String({})", arg)),
                            "abs" => return Ok(format!("Math.abs({})", arg)),
                            "round" => return Ok(format!("Math.round({})", arg)),
                            // `type(x)` -> the constructor; `type(x).__name__`
                            // resolves through the `__name__` -> `name` map.
                            "type" => return Ok(format!("({}).constructor", arg)),
                            "sum" => return Ok(format!("{}.reduce((a, b) => a + b, 0)", arg)),
                            "sorted" => return Ok(format!("{}.slice().sort()", arg)),
                            "reversed" => return Ok(format!("{}.slice().reverse()", arg)),
                            "list" => return Ok(format!("{}.slice()", arg)),
                            "bool" => return Ok(format!("Boolean({})", arg)),
                            // In `.hx` these must RAISE like Python, so they call
                            // the runtime instead of the JS builtin.
                            "int" => {
                                self.used_helpers.borrow_mut().insert("int".into());
                                return Ok(format!("int({})", arg));
                            }
                            "float" => {
                                self.used_helpers.borrow_mut().insert("float".into());
                                return Ok(format!("float({})", arg));
                            }
                            "print" => return Ok(format!("console.log({})", arg)),
                            "range" => {
                                self.used_helpers.borrow_mut().insert("range".into());
                                return Ok(format!("range({})", arg));
                            }
                            "enumerate" => {
                                self.used_helpers.borrow_mut().insert("enumerate".into());
                                return Ok(format!("enumerate({})", arg));
                            }
                            _ => {}
                        }
                    }
                    if id == "print" && !args.is_empty() {
                        let bits: Result<Vec<_>, _> = args.iter().map(|a| self.js(a)).collect();
                        return Ok(format!("console.log({})", bits?.join(", ")));
                    }
                    // `sum(xs, start)` — Python's two-argument form.
                    if id == "sum" && args.len() == 2 {
                        let a = self.js(&args[0])?;
                        let b = self.js(&args[1])?;
                        return Ok(format!("{}.reduce((acc, x) => acc + x, {})", a, b));
                    }
                    // `pow(a, b)`
                    if id == "pow" && args.len() == 2 {
                        return Ok(format!(
                            "Math.pow({}, {})",
                            self.js(&args[0])?,
                            self.js(&args[1])?
                        ));
                    }
                    if id == "enumerate" && !args.is_empty() {
                        let bits: Result<Vec<_>, _> = args.iter().map(|a| self.js(a)).collect();
                        self.used_helpers.borrow_mut().insert("enumerate".into());
                        return Ok(format!("enumerate({})", bits?.join(", ")));
                    }
                    if id == "zip" && !args.is_empty() {
                        let bits: Result<Vec<_>, _> = args.iter().map(|a| self.js(a)).collect();
                        self.used_helpers.borrow_mut().insert("zip".into());
                        return Ok(format!("zip({})", bits?.join(", ")));
                    }
                    // `min(xs, default=0)` / `max(xs, key=...)`: handle the
                    // keyword before falling through to the positional path.
                    if (id == "max" || id == "min") && !kwargs.is_empty() {
                        if args.is_empty() {
                            return Err(CompileError::new(
                                format!("{}() needs at least one argument", id),
                                n.line,
                                n.col,
                                Vec::new(),
                            ));
                        }
                        let src_arg = self.js(&args[0])?;
                        let helper = if id == "max" { "max_by" } else { "min_by" };
                        self.used_helpers.borrow_mut().insert(helper.into());
                        let mut extra = String::new();
                        for (k, v) in kwargs {
                            match k.as_str() {
                                "default" => {
                                    self.used_helpers.borrow_mut().insert("first_or".into());
                                    let dv = self.js(v)?;
                                    extra.push_str(&format!(
                                        ", {}",
                                        if id == "max" {
                                            format!("first_or({}, {})", src_arg, dv)
                                        } else {
                                            format!("first_or({}, {})", src_arg, dv)
                                        }
                                    ));
                                }
                                "key" => {
                                    let kv = self.js(v)?;
                                    extra.push_str(&format!(", {}", kv));
                                }
                                other => {
                                    return Err(CompileError::new(
                                        format!("{}() got an unexpected keyword argument `{}`", id, other),
                                        n.line,
                                        n.col,
                                        Vec::new(),
                                    )
                                    .with_hint("supported: key, default"));
                                }
                            }
                        }
                        if extra.is_empty() {
                            let bits: Result<Vec<_>, _> =
                                args.iter().map(|a| self.js(a)).collect();
                            let all = bits?;
                            return Ok(if id == "max" {
                                format!("Math.max({})", all.join(", "))
                            } else {
                                format!("Math.min({})", all.join(", "))
                            });
                        }
                        return Ok(format!("{}({}{})", helper, src_arg, extra));
                    }
                    if (id == "max" || id == "min") && !args.is_empty() && kwargs.is_empty() {
                        let bits: Result<Vec<_>, _> = args.iter().map(|a| self.js(a)).collect();
                        let all = bits?;
                        return Ok(if id == "max" {
                            format!("Math.max({})", all.join(", "))
                        } else {
                            format!("Math.min({})", all.join(", "))
                        });
                    }
                    if id == "isinstance" && args.len() == 2 {
                        self.used_helpers.borrow_mut().insert("isinstance".into());
                        let a = self.js(&args[0])?;
                        let ty = &args[1];
                        let mapped = match &ty.kind {
                            Kind::Name(n) => match n.as_str() {
                                "str" => "String",
                                "int" | "float" => "Number",
                                "bool" => "Boolean",
                                "list" => "Array",
                                "dict" => "Object",
                                "None" | "NoneType" => "null",
                                other => other,
                            },
                            _ => "",
                        };
                        if !mapped.is_empty() {
                            return Ok(format!("isinstance({}, {})", a, mapped));
                        }
                    }
                    // `sorted(xs, key=..., reverse=...)`
                    if id == "sorted" && !args.is_empty() && !kwargs.is_empty() {
                        let src_arg = self.js(&args[0])?;
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
                        let mut out = format!("{}.slice()", src_arg);
                        if let Some(k) = key_fn {
                            out = format!(
                                "{}.sort((a, b) => ({})(a) < ({})(b) ? -1 : ({})(a) > ({})(b) ? 1 : 0)",
                                out, k, k, k, k
                            );
                        } else {
                            out = format!("{}.sort()", out);
                        }
                        if let Some(rv) = reverse {
                            out = format!("({}) ? {}.reverse() : {}", rv, out, out);
                        }
                        return Ok(out);
                    }
                }
                // Keyword arguments: reorder against a known signature, or fail.
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
                            for (k, v) in kwargs {
                                match names.iter().position(|n| n == k) {
                                    Some(i) => slots[i] = Some(self.js(v)?),
                                    None => {
                                        return Err(CompileError::new(
                                            format!("{}() has no parameter named `{}`", id, k),
                                            n.line,
                                            n.col,
                                            Vec::new(),
                                        )
                                        .with_hint(format!(
                                            "{}() takes: {}",
                                            id,
                                            names.join(", ")
                                        )))
                                    }
                                }
                            }
                            let filled: Vec<String> =
                                slots.into_iter().filter_map(|x| x).collect();
                            return Ok(format!("{}({})", id, filled.join(", ")));
                        }
                    }
                    return Err(CompileError::new(
                        "keyword arguments are only supported for functions defined in this file".to_string(),
                        n.line,
                        n.col,
                        Vec::new(),
                    )
                    .with_hint("pass the argument positionally, or use a dict"));
                }
                let fn_str = self.js(func)?;
                let mut all = Vec::new();
                for a in args {
                    all.push(self.js(a)?);
                }
                Ok(format!("{}({})", fn_str, all.join(", ")))
            }
            Kind::Return(_)
            | Kind::If { .. }
            | Kind::For { .. }
            | Kind::Assign { .. }
            | Kind::AugAssign { .. }
            | Kind::ExprStmt(_)
            | Kind::Def { .. }
            | Kind::Import { .. }
            | Kind::Tree { .. }
            | Kind::Component { .. }
            | Kind::Match { .. } => Err(CompileError::new(
                "statement in expression position",
                n.line,
                n.col,
                Vec::new(),
            )),
            _ => Err(CompileError::new(
                format!("cannot compile expression {:?}", n.kind),
                n.line,
                n.col,
                Vec::new(),
            )),
        }
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

                if let Kind::Name(id) = &target.kind {
                    if let Some(scope) = self.scopes.last_mut() {
                        if scope.is_mutable(id) {
                            if scope.declared.insert(id.clone()) {
                                self.w(&format!("let {} = {};", lhs, rhs));
                            } else {
                                self.w(&format!("{} = {};", lhs, rhs));
                            }
                            return Ok(());
                        }
                    }
                }
                // Fallbacks, in order: a plain name that the scope did not
                // claim is still a NEW binding, so it declares. A destructuring
                // pattern binds names too. Member and index targets
                // (`this.x = 1`, `rows[i] = v`) bind nothing and must never take
                // `const`: `const this.x` is not JavaScript.
                match &target.kind {
                    Kind::Name(_) => {
                        self.w(&format!("const {} = {};", lhs, rhs));
                    }
                    Kind::Tuple(items) => {
                        let all_names = items.iter().all(|i| matches!(i.kind, Kind::Name(_)));
                        if all_names {
                            self.w(&format!("const {} = {};", lhs, rhs));
                        } else {
                            self.w(&format!("{} = {};", lhs, rhs));
                        }
                    }
                    Kind::Dict(_) | Kind::List(_) => {
                        self.w(&format!("const {} = {};", lhs, rhs));
                    }
                    _ => {
                        self.w(&format!("{} = {};", lhs, rhs));
                    }
                }
            }
            // `x, y = y, x` — parallel assignment. `let [x, y] = ...` evaluates
            // the right side before binding, which is Python's semantics.
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
            // `a = b = c = 0`
            Kind::ChainedAssign { targets, value } => {
                let rhs = self.js(value)?;
                let mut exprs: Vec<String> = Vec::new();
                for t in targets {
                    exprs.push(self.js(t)?);
                }
                if let Some(scope) = self.scopes.last() {
                    let undeclared: Vec<String> = targets
                        .iter()
                        .filter_map(|t| match &t.kind {
                            Kind::Name(id) if !scope.declared.contains(id) => Some(id.clone()),
                            _ => None,
                        })
                        .collect();
                    if !undeclared.is_empty() {
                        self.w(&format!("let {};", undeclared.join(", ")));
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
            // `assert` and `raise` are statements, so they must not be routed
            // through ExprStmt where a bare expression would silently do
            // nothing.
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
                let stmt = match op.as_str() {
                    "**=" => format!("{} = Math.pow({}, {});", lhs, lhs, rhs),
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
            Kind::Def { name, params, body } => {
                let ps: Result<Vec<String>, CompileError> =
                    params.iter().map(|p| self.param(p)).collect();
                self.w(&format!(
                    "function {}{}({}) {{",
                    if body_has_yield(body) { "*" } else { "" },
                    name,
                    ps?.join(", ")
                ));
                self.depth += 1;
                let mut scope = Scope::scan(body);
                for p in params {
                    let bare = p.name.trim_start_matches("...").to_string();
                    scope.params.insert(bare.clone());
                    scope.declared.insert(bare);
                }
                self.scopes.push(scope);
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.scopes.pop();
                self.depth -= 1;
                self.w("}");
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
            Kind::While { test, body } => {
                let cond = self.js(test)?;
                self.w(&format!("while ({}) {{", cond));
                self.depth += 1;
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.depth -= 1;
                self.w("}");
            }
            Kind::Break => self.w("break;"),
            Kind::Continue => self.w("continue;"),
            Kind::Pass => self.w("/* pass */"),
            Kind::AsyncDef { name, params, body } => {
                let ps: Result<Vec<String>, CompileError> =
                    params.iter().map(|p| self.param(p)).collect();
                self.w(&format!("async function {}({}) {{", name, ps?.join(", ")));
                self.depth += 1;
                let mut scope = Scope::scan(body);
                for p in params {
                    let bare = p.name.trim_start_matches("...").to_string();
                    scope.params.insert(bare.clone());
                    scope.declared.insert(bare);
                }
                self.scopes.push(scope);
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.scopes.pop();
                self.depth -= 1;
                self.w("}");
            }
            // `class Foo(Base):` -> a real JS class. Semantics that matter:
            // `__init__` becomes `constructor`, methods keep their names, and
            // `self` is stripped from the parameter list (JS uses `this`).
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
                // Class-level assignments become fields, which is what Python
                // class attributes are for in practice.
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
                        } else if mname.starts_with("__") && mname.ends_with("__") {
                            // Other dunders have no JS counterpart; keep the
                            // Python name so behaviour is at least explicit.
                            mname.as_str()
                        } else {
                            mname.as_str()
                        };
                        let is_static = decorator.as_deref() == Some("staticmethod");
                        // Drop `self`: it is implicit as `this` in JS.
                        let ps: Result<Vec<String>, CompileError> = params
                            .iter()
                            .filter(|p| p.name != "self" && p.name != "cls")
                            .map(|p| self.param(p))
                            .collect();
                        let star = if body_has_yield(mbody) { "*" } else { "" };
                        let keyword = if *is_async { "async " } else { "" };
                        self.w(&format!(
                            "{}{}{}{}({}) {{",
                            keyword,
                            if is_static { "static " } else { "" },
                            star,
                            js_name,
                            ps?.join(", ")
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
            // `export default def f()` -> `export default function f()`
            Kind::ExportDefault(inner) => {
                match &inner.kind {
                    Kind::Def { name, params, body } => {
                        let ps: Result<Vec<String>, CompileError> =
                            params.iter().map(|p| self.param(p)).collect();
                        self.w(&format!(
                            "export default function {}({}) {{",
                            name,
                            ps?.join(", ")
                        ));
                        self.depth += 1;
                        let mut scope = Scope::scan(body);
                        for p in params {
                            let bare = p.name.trim_start_matches("...").to_string();
                            scope.params.insert(bare.clone());
                            scope.declared.insert(bare);
                        }
                        self.scopes.push(scope);
                        for stmt in body {
                            self.stmt(stmt)?;
                        }
                        self.scopes.pop();
                        self.depth -= 1;
                        self.w("}");
                    }
                    Kind::AsyncDef { name, params, body } => {
                        let ps: Result<Vec<String>, CompileError> =
                            params.iter().map(|p| self.param(p)).collect();
                        self.w(&format!(
                            "export default async function {}({}) {{",
                            name,
                            ps?.join(", ")
                        ));
                        self.depth += 1;
                        let mut scope = Scope::scan(body);
                        for p in params {
                            let bare = p.name.trim_start_matches("...").to_string();
                            scope.params.insert(bare.clone());
                            scope.declared.insert(bare);
                        }
                        self.scopes.push(scope);
                        for stmt in body {
                            self.stmt(stmt)?;
                        }
                        self.scopes.pop();
                        self.depth -= 1;
                        self.w("}");
                    }
                    other => {
                        let val = self.js(&Node::new(other.clone(), inner.line, inner.col))?;
                        self.w(&format!("export default {};", val));
                    }
                }
            }
            Kind::Export(inner) => {
                // `export def` -> `export function`
                match &inner.kind {
                    Kind::Def { name, params, body } => {
                        let ps: Result<Vec<String>, CompileError> =
                            params.iter().map(|p| self.param(p)).collect();
                        self.w(&format!(
                    "export function {}{}({}) {{",
                    if body_has_yield(body) { "*" } else { "" },
                    name,
                    ps?.join(", ")
                ));
                        self.depth += 1;
                        let mut scope = Scope::scan(body);
                        for p in params {
                            let bare = p.name.trim_start_matches("...").to_string();
                            scope.params.insert(bare.clone());
                            scope.declared.insert(bare);
                        }
                        self.scopes.push(scope);
                        for stmt in body {
                            self.stmt(stmt)?;
                        }
                        self.scopes.pop();
                        self.depth -= 1;
                        self.w("}");
                    }
                    Kind::AsyncDef { name, params, body } => {
                        let ps: Result<Vec<String>, CompileError> =
                            params.iter().map(|p| self.param(p)).collect();
                        self.w(&format!(
                            "export async function {}({}) {{",
                            name,
                            ps?.join(", ")
                        ));
                        self.depth += 1;
                        let mut scope = Scope::scan(body);
                        for p in params {
                            let bare = p.name.trim_start_matches("...").to_string();
                            scope.params.insert(bare.clone());
                            scope.declared.insert(bare);
                        }
                        self.scopes.push(scope);
                        for stmt in body {
                            self.stmt(stmt)?;
                        }
                        self.scopes.pop();
                        self.depth -= 1;
                        self.w("}");
                    }
                    Kind::Assign { target, value } => {
                        let lhs = match &target.kind {
                            Kind::Tuple(items) => {
                                let bits: Result<Vec<_>, _> =
                                    items.iter().map(|i| self.js(i)).collect();
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
                        self.w(&format!("export const {} = {};", lhs, rhs));
                    }
                    _ => {
                        self.w("export ");
                        self.stmt(inner)?;
                    }
                }
            }
            Kind::Try {
                body,
                handlers,
                orelse: _,
                finally,
            } => {
                self.w("try {");
                self.depth += 1;
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.depth -= 1;
                self.w("}");

                if !handlers.is_empty() {
                    // Python: multiple typed `except` arms. JS has only one `catch (err)`.
                    // We emit `catch (__err)` and dispatch via `if (__err instanceof Cls)`
                    // for each typed handler, with a final rethrow for unhandled errors.
                    let catch_var = "__err";
                    self.w(&format!("catch ({}) {{", catch_var));
                    self.depth += 1;

                    let mut first = true;
                    for h in handlers {
                        if let Some(cls) = &h.class {
                            self.used_helpers.borrow_mut().insert(cls.clone());
                            let cond = format!("{} instanceof {}", catch_var, cls);
                            if first {
                                self.w(&format!("if ({}) {{", cond));
                            } else {
                                self.w(&format!("else if ({}) {{", cond));
                            }
                            self.depth += 1;
                            if let Some(n) = &h.name {
                                self.w(&format!("const {} = {};", n, catch_var));
                            }
                            for stmt in &h.body {
                                self.stmt(stmt)?;
                            }
                            self.depth -= 1;
                            self.w("}");
                        } else {
                            // Bare `except:` catches everything.
                            if first {
                                for stmt in &h.body {
                                    self.stmt(stmt)?;
                                }
                            } else {
                                self.w("else {");
                                self.depth += 1;
                                for stmt in &h.body {
                                    self.stmt(stmt)?;
                                }
                                self.depth -= 1;
                                self.w("}");
                            }
                            break;
                        }
                        first = false;
                    }
                    if !first {
                        // Rethrow unhandled exceptions so we don't swallow errors silently.
                        self.w(&format!("else {{ throw {}; }}", catch_var));
                    }
                    self.depth -= 1;
                    self.w("}");
                }

                if let Some(fin) = finally {
                    self.w("finally {");
                    self.depth += 1;
                    for stmt in fin {
                        self.stmt(stmt)?;
                    }
                    self.depth -= 1;
                    self.w("}");
                }
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
                    let mod_name = if f == "serpent_js" {
                        "serpent"
                    } else {
                        f.as_str()
                    };
                    if names.is_empty() {
                        self.imports.insert(format!("import '{}';", mod_name));
                    } else if names.len() == 1 && names[0].starts_with("* as ") {
                        self.imports
                            .insert(format!("import {} from '{}';", names[0], mod_name));
                    } else {
                        self.imports.insert(format!(
                            "import {{ {} }} from '{}';",
                            names.join(", "),
                            mod_name
                        ));
                    }
                } else {
                    self.imports
                        .insert(format!("import {} from 'serpent';", names.join(", ")));
                }
            }
            // These two only make sense with a component tree.
            Kind::Component { name, .. } => {
                return Err(CompileError::new(
                    format!("`component {name}` is not available in a .hx file"),
                    s.line,
                    s.col,
                    Vec::new(),
                )
                .with_hint("components compile to React — use a .hsx file instead"));
            }
            Kind::Tree { .. } => {
                return Err(CompileError::new(
                    "a tree block is not available in a .hx file",
                    s.line,
                    s.col,
                    Vec::new(),
                )
                .with_hint("element nesting compiles to JSX — use a .hsx file instead"));
            }
            // Anything that reaches here is a statement the emitter was never
            // taught. Silently dropping it is the worst possible outcome: code
            // that looks guarded compiles to nothing. Fail loudly instead.
            other => {
                return Err(CompileError::new(
                    format!("cannot emit statement {:?} in a .hx file", other),
                    s.line,
                    s.col,
                    Vec::new(),
                )
                .with_hint("this is a compiler gap, not a mistake in your source"));
            }
        }
        Ok(())
    }

    fn param(&self, p: &Param) -> Result<String, CompileError> {
        // Types are erased in the JS target.
        if let Some(d) = &p.default {
            if !matches!(&d.kind, Kind::Null) {
                return Ok(format!("{} = {}", p.name, self.js(d)?));
            }
        }
        Ok(p.name.clone())
    }

    pub fn run(&mut self, module: &Node) -> Result<String, CompileError> {
        let body = match &module.kind {
            Kind::Module(stmts) => stmts,
            _ => unreachable!(),
        };

        // ponytail: top-level scope for mutability tracking
        // Collect every function signature first; a call may appear before the
        // `def` it names, and kwargs are resolved against it.
        {
            let mut table = self.fn_params.borrow_mut();
            for st in body {
                let record = |name: &str, params: &[Param], table: &mut std::collections::HashMap<String, Vec<String>>| {
                    table.insert(
                        name.to_string(),
                        params
                            .iter()
                            .map(|p| p.name.trim_start_matches("...").to_string())
                            .collect(),
                    );
                };
                match &st.kind {
                    Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                        record(name, params, &mut table)
                    }
                    Kind::Export(inner) => match &inner.kind {
                        Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                            record(name, params, &mut table)
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
        }

        let top_scope = Scope::scan(body);
        self.scopes.push(top_scope);

        for s in body {
            match &s.kind {
                Kind::Component { .. } | Kind::Tree { .. } => self.stmt(s)?,
                Kind::Import { from, names } => {
                    if let Some(f) = from {
                        let mod_name = if f == "serpent_js" {
                            "serpent"
                        } else {
                            f.as_str()
                        };
                        if names.is_empty() {
                            self.imports.insert(format!("import '{}';", mod_name));
                        } else if names.len() == 1 && names[0].starts_with("* as ") {
                            self.imports
                                .insert(format!("import {} from '{}';", names[0], mod_name));
                        } else {
                            self.imports.insert(format!(
                                "import {{ {} }} from '{}';",
                                names.join(", "),
                                mod_name
                            ));
                        }
                    } else {
                        self.imports
                            .insert(format!("import {} from 'serpent';", names.join(", ")));
                    }
                }
                _ => self.stmt(s)?,
            }
        }

        self.scopes.pop();

        // Inject helpers the source used but did not import.
        let helpers: Vec<String> = self.used_helpers.borrow().iter().cloned().collect();
        if !helpers.is_empty() {
            let mut h = helpers;
            h.sort();
            self.imports
                .insert(format!("import {{ {} }} from 'serpent';", h.join(", ")));
        }

        let mut head = vec![
            "// [xihanzu-NR]".to_string(),
            "// GENERATED by serpent — edit the .hx file, not this one".to_string(),
        ];
        let mut sorted: Vec<_> = self.imports.iter().cloned().collect();
        sorted.sort();
        head.extend(sorted);
        head.push(String::new());

        self.head_lines = head.clone();
        Ok(format!("{}\n{}", head.join("\n"), self.lines.join("\n")))
    }

    pub fn sourcemap(&self, filename: &str, src: &str) -> String {
        use crate::emitter::encode_vlq;
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
        format!(
            "{{\"version\":3,\"file\":\"{}\",\"sources\":[\"{}\"],\"sourcesContent\":[{}],\"names\":[],\"mappings\":\"{}\"}}",
            filename.replace(".hx", ".js"),
            filename,
            json_escape(src),
            segs.join(";")
        )
    }
}

fn json_escape(s: &str) -> String {
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

/// True when a function body contains `yield` at its own level (nested
/// functions excluded): such a function is a generator, and JS requires the
/// `*` on the declaration or the emitted `yield` is a syntax error.
fn body_has_yield(body: &[Node]) -> bool {
    fn walk(n: &Node) -> bool {
        match &n.kind {
            Kind::Yield(_) => true,
            Kind::If { body, orelse, .. } => {
                body.iter().any(walk) || orelse.as_ref().is_some_and(|b| b.iter().any(walk))
            }
            Kind::While { body, .. } | Kind::For { body, .. } => body.iter().any(walk),
            Kind::Try {
                body,
                handlers,
                finally,
                ..
            } => {
                body.iter().any(walk)
                    || handlers.iter().any(|c| c.body.iter().any(walk))
                    || finally.as_ref().is_some_and(|f| f.iter().any(walk))
            }
            _ => false,
        }
    }
    body.iter().any(walk)
}
