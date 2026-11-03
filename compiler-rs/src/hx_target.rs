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

/// True when a module specifier points at an asset the bundler loads as a
/// default export rather than at a JavaScript module with named exports.
///
/// `import { logo } from './logo.svg'` is unresolvable in every bundler: asset
/// loaders (esbuild `file`, webpack asset modules, vite assets) hand back one
/// default value. `from "./logo.svg" import logo` used to emit the named form,
/// so importing an image, font or stylesheet failed the build with
/// `No matching export in "logo.svg" for import "logo"`.
pub fn asset_import(spec: &str) -> bool {
    let lower = spec.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or(&lower);
    const EXTS: &[&str] = &[
        ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".css", ".scss",
        ".sass", ".less", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3",
        ".wav", ".ogg", ".glb", ".gltf", ".wasm", ".pdf",
    ];
    EXTS.iter().any(|e| path.ends_with(e))
}

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
    /// Saat tidak kosong, `w()` menulis ke sini, bukan ke `lines`. Dipakai untuk
    /// merakit badan sebuah `export def` lebih dulu supaya bisa diletakkan di
    /// `head_lines` (deklarasi `export function` diangkat JavaScript, jadi badan
    /// boleh berada di atas pemanggil-pemanggilnya).
    pub buffer: Option<Vec<String>>,
    /// Nama fungsi yang sudah diantrekan ke head_lines, supaya tidak dobel.
    pub queued_decls: std::collections::HashSet<String>,
    /// `export def` yang menunggu ditulis ke head_lines: (nama, teks).
    pub exported_decls: Vec<(String, String)>,
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
            buffer: None,
            queued_decls: std::collections::HashSet::new(),
            exported_decls: Vec::new(),
            scopes: Vec::new(),
        }
    }

    fn pad(&self) -> String {
        "  ".repeat(self.depth)
    }

    /// Push a function scope, then declare at the top of the emitted body every
    /// name whose first assignment sits inside a nested block.
    ///
    /// Python scopes names to the whole function; JavaScript block-scopes them.
    ///
    /// ```text
    /// if flag:
    ///     x = 1
    /// else:
    ///     x = 2
    /// return x
    /// ```
    ///
    /// is legal Python. Emitting the first binding inside the `if` produced
    /// `let x = 1` in one arm and a bare `x = 2` in the other — `x is not defined`
    /// at run time, with the build reporting success. A helper library that
    /// initialises a variable inside a branch could not be used at all.
    ///
    /// The `.hyx` emitter has always done this for component bodies
    /// (`Emitter::hoist_nested_assignments`); this one skipped it on EVERY
    /// function form it emits — plain, async, exported, and export-default.
    fn hoist_nested(&mut self, scope: Scope) {
        self.push_scope_js(scope);
        let names = self
            .scopes
            .last()
            .map(|s| s.hoist_names())
            .unwrap_or_default();
        if names.is_empty() {
            return;
        }
        // Recording them as declared is what stops the first assignment inside the
        // branch from emitting a second, shadowing binding.
        if let Some(s) = self.scopes.last_mut() {
            for n in &names {
                s.declared.insert(n.clone());
            }
        }
        for n in names {
            self.w(&format!("let {};", n));
        }
    }

    /// Same as `Emitter::push_scope`: record which names the enclosing scopes
    /// already bind, so an assignment to one of them is a closure capture and not
    /// a fresh local. Without this, hoisting re-declared a captured name and cut
    /// the outer binding off.
    fn push_scope_js(&mut self, mut scope: Scope) {
        let mut bound = std::collections::HashSet::new();
        for s in &self.scopes {
            bound.extend(s.params.iter().cloned());
            bound.extend(s.declared.iter().cloned());
            bound.extend(s.assigned_anywhere.iter().cloned());
        }
        scope.outer_bound = bound;
        self.scopes.push(scope);
    }

    pub fn w(&mut self, s: &str) {
        let line = if s.is_empty() {
            String::new()
        } else {
            format!("{}{}", self.pad(), s)
        };
        let count = line.matches('\n').count() + 1;
        if let Some(buf) = self.buffer.as_mut() {
            buf.push(line);
            return;
        }
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
                        FPart::Expr { value, conv, spec } => {
                            let mut e = self.js(value)?;
                            if conv.is_some() {
                                e = format!("String({})", e);
                            }
                            if let Some(spec) = spec {
                                e = crate::fstr::translate(spec, &e).map_err(|why| {
                                    let msg = format!("unsupported format spec `:{}`", spec);
                                    let hint = format!(
                                        "{} — write the formatting as JS instead, e.g. `({}).toFixed(2)`",
                                        why,
                                        self.js(value).unwrap_or_default()
                                    );
                                    CompileError::new(msg, 0, 0, Vec::new()).with_hint(hint)
                                })?;
                                // The translator INVENTS these calls; no AST node
                                // mentions them, so the helper is recorded here or
                                // the emitted module names an import that was never
                                // written. That was `ReferenceError: py_fixed is not
                                // defined` on every `f"{x:.2f}"` in a .hys.
                                for helper in ["py_fixed", "py_group"] {
                                    if e.contains(&format!("{helper}(")) {
                                        self.used_helpers.borrow_mut().insert(helper.to_string());
                                    }
                                }
                            }
                            out.push_str("${");
                            out.push_str(&e);
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
            Kind::Name(id) => {
                // A runtime exception class — `raise ValueError("x")`,
                // `except ValueError:` — is a value that has to be imported.
                // Emitted bare it named a global nothing defines, and the
                // module threw ReferenceError on load.
                //
                // Only when the name is NOT declared in this file: a user's
                // `class ValueError(Exception)` must keep its own class, which
                // is what `class_names` records. Without that guard the emitted
                // import collided with the class and `hydra run` died with
                // `SyntaxError: Identifier 'ValidationError' has already been
                // declared` — from a .hys that ran before.
                let declared_here = self.class_names.borrow().contains(id);
                if !declared_here {
                    if let Some(fix) = crate::emitter::python_base_class(id) {
                        self.used_helpers.borrow_mut().insert(fix);
                    }
                }
                Ok(id.clone())
            }
            Kind::Attr { obj, name } => {
                // `self.x` -> `this.x` (see Kind::Name above) — routed through
                // the same code path by rewriting the object first.
                let o = self.js(obj)?;
                // `type(x).__name__` — `type(x)` emits `py_type_name(x)`, a
                // STRING, and a string has no `.name`. Recognised here so the
                // emitted pair agrees (see emitter.rs).
                if name == "__name__" && o.starts_with("py_type_name(") && o.ends_with(')') {
                    let inner = &o["py_type_name(".len()..o.len() - 1];
                    return Ok(format!("py_type_name({})", inner));
                }
                Ok(format!("{}.{}", o, str_method(name)))
            }
            Kind::OptAttr { obj, name } => {
                let o = self.js(obj)?;
                Ok(format!("{}?.{}", o, str_method(name)))
            }
            Kind::Super => Ok("super".to_string()),
            // See the .hyx emitter: `__init__` becomes a bare `super(...)`,
            // every other member becomes `super.name(...)`.
            Kind::SuperMember { member } => {
                if member == "__init__" {
                    Ok("super".to_string())
                } else {
                    Ok(format!("super.{}", str_method(member)))
                }
            }
            Kind::Index { obj, index } => {
                let o = self.js(obj)?;
                // A NEGATIVE LITERAL index is Python's count-from-the-end and
                // JS's missing property: `xs[-1]` returned undefined where the
                // author meant the last element. Only the literal form is
                // rewritten — an expression's sign is not known here.
                let i = self.js(index)?;
                // `-1` parses as Unary(-, Num(1)), not as a negative literal,
                // so both shapes name a negative index.
                let negative_literal = match &index.kind {
                    Kind::Num(n) => n.starts_with('-'),
                    Kind::Unary { op, operand } => {
                        op == "-" && matches!(operand.kind, Kind::Num(_))
                    }
                    _ => false,
                };
                if negative_literal {
                    self.used_helpers.borrow_mut().insert("py_at".into());
                    return Ok(format!("py_at({}, {})", o, i));
                }
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
                // `%` in Python takes the sign of the DIVISOR (-7 % 3 is 2,
                // JS says -1). A ring index or a bucket calculation then lands
                // one cell off for negative input and nothing throws.
                if op == "%" {
                    self.used_helpers.borrow_mut().insert("py_mod".into());
                    return Ok(format!("py_mod({}, {})", l, r));
                }
                // `"ab" * 3` repeats in Python and is NaN in JS; `[0] * 3` is a
                // number where a list was meant. Only a LITERAL left operand is
                // rewritten: that is the case the author cannot see is wrong, and
                // the same bound the `+` case above already accepts. A variable
                // holding a string still emits `*` — detectable statically is not
                // the same as detectable at all.
                if op == "*" && matches!(left.kind, Kind::Str { .. } | Kind::List(_) | Kind::Tuple(_)) {
                    self.used_helpers.borrow_mut().insert("py_repeat".into());
                    return Ok(format!("py_repeat({}, {})", l, r));
                }
                if op == "floordiv" {
                    return Ok(format!("Math.floor({} / {})", l, r));
                }
                // `is` / `is not` -> strict identity (JS has no `is` operator).
                // `==` on two sequences: Python compares by VALUE, JS by
                // identity, so `[1, 2] == [1, 2]` was false and the guard took
                // the wrong branch. Only when an operand is visibly a list,
                // dict or tuple literal — a scalar comparison must stay `===`,
                // which is what every `x == 1` in the language relies on.
                let structural = matches!(left.kind, Kind::List(_) | Kind::Tuple(_) | Kind::Dict(_))
                    || matches!(right.kind, Kind::List(_) | Kind::Tuple(_) | Kind::Dict(_));
                if structural && (op == "===" || op == "!==") {
                    let helper = if op == "===" { "py_eq" } else { "py_ne" };
                    self.used_helpers.borrow_mut().insert(helper.into());
                    return Ok(format!("{}({}, {})", helper, l, r));
                }
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
                // `not []` is True in Python: an empty list is falsy. `(![])` is
                // false, because JS calls every array truthy. A list, dict or
                // string LITERAL is visible here, so the Python answer is chosen
                // without a runtime call; anything else keeps JS's `!`, which
                // agrees with Python for the scalars that use it.
                if op == "!" {
                    if let Some(helper) = match &operand.kind {
                        Kind::List(_) | Kind::Tuple(_) | Kind::Dict(_) => Some("truthy"),
                        _ => None,
                    } {
                        self.used_helpers.borrow_mut().insert(helper.into());
                        return Ok(format!("(!{}({}))", helper, v));
                    }
                }
                Ok(format!("({}{})", op, v))
            }
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
            Kind::TaggedTemplate { tag, raw } => Ok(format!("{}{}", self.js(tag)?, raw)),
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
                // A runtime exception class: `new ValueError(...)`, and the
                // name has to be IMPORTED or the emitted code names a global
                // nothing defines (`ReferenceError: KeyError is not defined`
                // from a `.hys` that only did `raise KeyError("x")`).
                if let Kind::Name(id) = &func.kind {
                    if !self.class_names.borrow().contains(id) {
                        if let Some(fix) = crate::emitter::python_base_class(id) {
                            self.used_helpers.borrow_mut().insert(fix);
                            let bits: Result<Vec<_>, _> =
                                args.iter().map(|a| self.js(a)).collect();
                            return Ok(format!("new {}({})", id, bits?.join(", ")));
                        }
                    }
                }
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
                            // The plain-JS side of the language (`hydra run x.hys`)
                            // gets the same builtins, or `run` and `build` answer
                            // differently for the same source — which is worse
                            // than either answer alone.
                            "any" => {
                                self.used_helpers.borrow_mut().insert("any".into());
                                return Ok(format!("any({})", arg));
                            }
                            "all" => {
                                self.used_helpers.borrow_mut().insert("all".into());
                                return Ok(format!("all({})", arg));
                            }
                            "repr" => {
                                self.used_helpers.borrow_mut().insert("repr".into());
                                return Ok(format!("repr({})", arg));
                            }
                            "ord" => return Ok(format!("{}.charCodeAt(0)", arg)),
                            "chr" => return Ok(format!("String.fromCharCode({})", arg)),
                            "pow" => return Ok(format!("Math.pow({})", arg)),
                            // `str(x)` — Python's spelling, not JS's. See the
                            // same branch in emitter.rs.
                            "str" => {
                                self.used_helpers.borrow_mut().insert("py_str".into());
                                return Ok(format!("py_str({})", arg));
                            }
                            "abs" => return Ok(format!("Math.abs({})", arg)),
                            // Python's tie-to-even, not Math.round.
                            "round" => {
                                self.used_helpers.borrow_mut().insert("round_py".into());
                                return Ok(format!("round_py({})", arg));
                            }
                            // `type(x)` -> `py_type_name(x)`. The constructor
                            // answers the JAVASCRIPT class ("Object" for a dict,
                            // "Number" for int and float alike) and throws on
                            // None. See emitter.rs for the full note.
                            "type" => {
                                self.used_helpers.borrow_mut().insert("py_type_name".into());
                                return Ok(format!("py_type_name({})", arg));
                            }
                            "sum" => return Ok(format!("{}.reduce((a, b) => a + b, 0)", arg)),
                            // Numeric comparison, like the runtime helper.
                            "sorted" => {
                                self.used_helpers.borrow_mut().insert("sorted".into());
                                return Ok(format!("sorted({})", arg));
                            }
                            "reversed" => return Ok(format!("{}.slice().reverse()", arg)),
                            "list" => return Ok(format!("{}.slice()", arg)),
                            // `bool([])` is False in Python and `Boolean([])` is true in
                            // JS. The runtime helper is the Python answer.
                            "bool" => {
                                self.used_helpers.borrow_mut().insert("truthy".into());
                                return Ok(format!("truthy({})", arg));
                            }
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
                    // `range(...)` — variadic. Without this arm the call emitted
                    // verbatim and the module threw `ReferenceError: range is not
                    // defined` even though the checker treats it as a runtime
                    // import; the one-argument arm below could never see 2 or 3.
                    if id == "range" && !args.is_empty() {
                        let bits: Result<Vec<_>, _> = args.iter().map(|a| self.js(a)).collect();
                        self.used_helpers.borrow_mut().insert("range".into());
                        return Ok(format!("range({})", bits?.join(", ")));
                    }
                    // `sum(xs, start)` — Python's two-argument form.
                    if id == "sum" && args.len() == 2 {
                        let a = self.js(&args[0])?;
                        let b = self.js(&args[1])?;
                        return Ok(format!("{}.reduce((acc, x) => acc + x, {})", a, b));
                    }
                    // `format(value, spec)` — Python's builtin, two arguments.
                    // It fell through every arm and emitted `format(...)`
                    // verbatim: a green build and a `ReferenceError` on the first
                    // request that used it (see emitter.rs).
                    // Not when imported: `from "date-fns" import format` is that
                    // library's pattern formatter, not Python's spec grammar.
                    let format_imported = self
                        .imports
                        .iter()
                        .any(|l| l.contains("import {") && l.contains("format") && l.contains("from '") && !l.contains("from 'hydra'"));
                    if id == "format" && args.len() == 2 && !format_imported {
                        self.used_helpers.borrow_mut().insert("py_format".into());
                        let a = self.js(&args[0])?;
                        let b = self.js(&args[1])?;
                        return Ok(format!("py_format({}, {})", a, b));
                    }
                    // `divmod`, and the attribute trio. Present on both targets
                    // because the runtime helpers are target-agnostic; the only
                    // thing that differs is which JS this file used to be.
                    if args.len() == 2 {
                        let a = self.js(&args[0])?;
                        let b = self.js(&args[1])?;
                        match id.as_str() {
                            "divmod" => {
                                self.used_helpers.borrow_mut().insert("divmod".into());
                                return Ok(format!("divmod({}, {})", a, b));
                            }
                            "getattr" => {
                                self.used_helpers.borrow_mut().insert("getattr".into());
                                return Ok(format!("getattr({}, {})", a, b));
                            }
                            "hasattr" => {
                                self.used_helpers.borrow_mut().insert("hasattr".into());
                                return Ok(format!("hasattr({}, {})", a, b));
                            }
                            "map" => return Ok(format!("(fn => {}.map(fn))({})", b, a)),
                            "filter" => return Ok(format!("(fn => {}.filter(fn))({})", b, a)),
                            _ => {}
                        }
                    }
                    if args.len() == 3 && (id == "getattr" || id == "setattr") {
                        self.used_helpers.borrow_mut().insert(id.clone());
                        let bits: Result<Vec<_>, _> = args.iter().map(|a| self.js(a)).collect();
                        return Ok(format!("{}({})", id, bits?.join(", ")));
                    }
                    // `round(x, n)` — JS has no digit argument, and
                    // `round(2.675, 2)` emitted `round(...)` verbatim, which is
                    // a ReferenceError the moment the file runs.
                    if id == "round" && args.len() == 2 {
                        self.used_helpers.borrow_mut().insert("round_to".into());
                        return Ok(format!(
                            "round_to({}, {})",
                            self.js(&args[0])?,
                            self.js(&args[1])?
                        ));
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
                    // `max(a, b)` compares arguments; `max(xs)` compares the
                    // ELEMENTS of one sequence. `Math.max(xs)` with an array is
                    // NaN, and `Math.max(...xs)` is NaN for anything that is not
                    // an array. One argument must go through the helper.
                    if (id == "max" || id == "min") && !args.is_empty() && kwargs.is_empty() {
                        if args.len() == 1 {
                            let arg = self.js(&args[0])?;
                            let helper = if id == "max" { "max_of" } else { "min_of" };
                            self.used_helpers.borrow_mut().insert(helper.into());
                            return Ok(format!("{}({})", helper, arg));
                        }
                        let bits: Result<Vec<_>, _> = args.iter().map(|a| self.js(a)).collect();
                        let all = bits?;
                        return Ok(if id == "max" {
                            format!("Math.max({})", all.join(", "))
                        } else {
                            format!("Math.min({})", all.join(", "))
                        });
                    }
                    if id == "isinstance" && args.len() == 2 {
                        let a = self.js(&args[0])?;
                        let ty = &args[1];
                        // `int` and `float` are different questions in Python and
                        // the same `Number` in JavaScript, so the specific helper
                        // is chosen from the type NAME while it is still visible.
                        if let Kind::Name(n) = &ty.kind {
                            match n.as_str() {
                                "int" => {
                                    self.used_helpers.borrow_mut().insert("isinstance_int".into());
                                    return Ok(format!("isinstance_int({})", a));
                                }
                                "float" => {
                                    self.used_helpers.borrow_mut().insert("isinstance_float".into());
                                    return Ok(format!("isinstance_float({})", a));
                                }
                                _ => {}
                            }
                        }
                        self.used_helpers.borrow_mut().insert("isinstance".into());
                        let mapped = match &ty.kind {
                            Kind::Name(n) => match n.as_str() {
                                "str" => "String",
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
                        "keyword arguments are not supported here: no signature to read \
                         (a package import, or a method call)"
                            .to_string(),
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
                    // A name the enclosing scopes already bind is a CAPTURE, not a
                    // new binding. Emitting `const`/`let` here shadowed it: a
                    // module-level counter written from a helper
                    // (`SALAH = SALAH + 1` inside a function) came out as
                    // `const SALAH = (SALAH + 1);` — `Cannot access 'SALAH' before
                    // initialization`, thrown on the first call. The `.hyx` emitter
                    // has always checked this via `bound_in_enclosing`; this one
                    // never did.
                    let captured = self
                        .scopes
                        .last()
                        .map(|s| s.outer_bound.contains(id))
                        .unwrap_or(false);
                    if captured {
                        self.w(&format!("{} = {};", lhs, rhs));
                        return Ok(());
                    }
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
                    Kind::Name(id) => {
                        // The name is hoisted (declared at the top of the function) but
                        // not `mutable`, so the old fallback emitted `const fcu = ...`
                        // INSIDE the loop. That shadows the hoisted `let fcu` for the
                        // whole block, so every use after the loop read the outer,
                        // still-uninitialised one: `Cannot read properties of undefined`.
                        // The rule has three cases, and this is the third.
                        let sudah = self
                            .scopes
                            .last()
                            .map(|s| s.declared.contains(id))
                            .unwrap_or(false);
                        if sudah {
                            self.w(&format!("{} = {};", lhs, rhs));
                        } else {
                            if let Some(s) = self.scopes.last_mut() {
                                s.declared.insert(id.clone());
                            }
                            self.w(&format!("const {} = {};", lhs, rhs));
                        }
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
                self.hoist_nested(scope);
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.scopes.pop();
                self.depth -= 1;
                self.w("}");
            }
            Kind::If { test, body, orelse } => {
                let cond = self.js(test)?;
                // Python truthiness for a bare condition: an empty list or dict is
                // falsy in Python and true in JS, so `if items:` took the wrong
                // branch and nothing threw.
                let cond = crate::emitter::py_cond(&cond);
                if cond.starts_with("truthy(") {
                    self.used_helpers.borrow_mut().insert("truthy".into());
                }
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
                let cond = crate::emitter::py_cond(&cond);
                if cond.starts_with("truthy(") {
                    self.used_helpers.borrow_mut().insert("truthy".into());
                }
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
                self.hoist_nested(scope);
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
                    Some(b) => match crate::emitter::python_base_class(b) {
                        Some(fix) if !self.class_names.borrow().contains(b.as_str()) => {
                            self.used_helpers.borrow_mut().insert(fix.clone());
                            format!("class {} extends {}", name, fix)
                        }
                        _ => format!("class {} extends {}", name, b),
                    },
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
                        self.hoist_nested(scope);
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
                        self.hoist_nested(scope);
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
                        self.hoist_nested(scope);
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
                //
                // `export function` is hoisted, so the declaration can be written
                // into `head_lines` (above the rest of the module) while its body
                // text is emitted here. That inversion is what lets one exported
                // `def` call another defined later in the file.
                match &inner.kind {
                    Kind::Def { name, params, body } => {
                        let ps: Result<Vec<String>, CompileError> =
                            params.iter().map(|p| self.param(p)).collect();
                        if self.queued_decls.contains(name.as_str()) {
                            // Sudah diantre: jangan tulis dua kali.
                            return Ok(());
                        }
                        self.queued_decls.insert(name.clone());
                        // Rakit badan ke buffer, lalu pindahkan seluruhnya ke
                        // head_lines. Urutan ini penting: badan `export def` sering
                        // memanggil fungsi lain di modul yang sama, dan fungsi itu
                        // belum ditulis saat baris ini diproses.
                        let mut buf: Vec<String> = Vec::new();
                        buf.push(format!(
                            "export function {}{}({}) {{",
                            if body_has_yield(body) { "*" } else { "" },
                            name,
                            ps?.join(", ")
                        ));
                        let simpan = self.lines.clone();
                        let simpan_map = self.linemap.clone();
                        self.lines.clear();
                        self.depth += 1;
                        let mut scope = Scope::scan(body);
                        for p in params {
                            let bare = p.name.trim_start_matches("...").to_string();
                            scope.params.insert(bare.clone());
                            scope.declared.insert(bare);
                        }
                        self.hoist_nested(scope);
                        for stmt in body {
                            self.stmt(stmt)?;
                        }
                        self.scopes.pop();
                        self.depth -= 1;
                        self.w("}");
                        let mut isi = std::mem::take(&mut self.lines);
                        self.lines = simpan;
                        self.linemap = simpan_map;
                        buf.append(&mut isi);
                        self.exported_decls.push((name.clone(), buf.join("\n")));
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
                        self.hoist_nested(scope);
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
                            // Only a RUNTIME exception class is imported. A
                            // user's `class ValidationError(Exception)` is a
                            // declaration in this same file, so importing the
                            // name as well produced two declarations of it and
                            // the module did not parse.
                            let is_catch_all = matches!(cls.as_str(), "Exception" | "BaseException");
                            let declared_here = self.class_names.borrow().contains(cls);
                            if !declared_here && !is_catch_all {
                                if let Some(fix) = crate::emitter::python_base_class(cls) {
                                    self.used_helpers.borrow_mut().insert(fix);
                                }
                            }
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
                    let mod_name = if f == "hydra_js" {
                        "hydra"
                    } else {
                        f.as_str()
                    };
                    if names.is_empty() {
                        self.imports.insert(format!("import '{}';", mod_name));
                    } else if names.len() == 1 && names[0].starts_with("* as ") {
                        self.imports
                            .insert(format!("import {} from '{}';", names[0], mod_name));
                    } else if asset_import(mod_name) && names.len() == 1 {
                        // Asset modules (bundlers: esbuild `file` loader, webpack
                        // asset modules, vite assets) expose a single DEFAULT
                        // export — never a named one. `from "./logo.svg" import
                        // logo` must emit `import logo from './logo.svg'`, or the
                        // build dies with `No matching export in "logo.svg" for
                        // import "logo"`.
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
                        .insert(format!("import {} from 'hydra';", names.join(", ")));
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

        // Register EVERY class in this file first: a class declared after its
        // first use would otherwise be unknown at that use, and a user's
        // `class ValidationError(Exception)` collided with the runtime's
        // exception classes — the import was emitted AND the declaration
        // followed, which does not parse (`Identifier 'ValidationError' has
        // already been declared`). The user's class must win.
        for s in body {
            if let Kind::Class { name, .. } = &s.kind {
                self.class_names.borrow_mut().insert(name.clone());
            }
        }

        let top_scope = Scope::scan(body);
        self.scopes.push(top_scope);

        for s in body {
            match &s.kind {
                Kind::Component { .. } | Kind::Tree { .. } => self.stmt(s)?,
                Kind::Import { from, names } => {
                    if let Some(f) = from {
                        let mod_name = if f == "hydra_js" {
                            "hydra"
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
                            .insert(format!("import {} from 'hydra';", names.join(", ")));
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
            // The author may already have imported some of these by hand
            // (`from "hydra" import sorted`). Emitting a second `import { sorted }`
            // is a duplicate binding, which esbuild reports as
            // "The symbol "sorted" has already been declared" — so every helper
            // already named in a hydra import is dropped from the generated one,
            // and the generated line is dropped entirely when nothing is left.
            let already: std::collections::HashSet<String> = self
                .imports
                .iter()
                .filter(|l| l.contains("from 'hydra';"))
                .flat_map(|l| {
                    l.trim()
                        .trim_start_matches("import {")
                        .split('}')
                        .next()
                        .unwrap_or("")
                        .split(',')
                        .map(|n| n.trim().to_string())
                        .collect::<Vec<_>>()
                })
                .collect();
            h.retain(|n| !already.contains(n));
            if !h.is_empty() {
                self.imports
                    .insert(format!("import {{ {} }} from 'hydra';", h.join(", ")));
            }
        }

        let mut head = vec![
            "// [xihanzu-NR]".to_string(),
            "// GENERATED by hydra — edit the .hx file, not this one".to_string(),
        ];
        let mut sorted: Vec<_> = self.imports.iter().cloned().collect();
        sorted.sort();
        head.extend(sorted);
        head.push(String::new());

        // Sisipkan `export function` yang diantre. Deklarasi fungsi diangkat
        // JavaScript, jadi urutannya tidak masalah, dan menaruhnya di atas membuat
        // satu def bisa memanggil def lain yang ditulis belakangan.
        let queued = self.exported_decls.clone();
        for (_, text) in queued.iter() {
            head.push(text.clone());
            head.push(String::new());
        }
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
