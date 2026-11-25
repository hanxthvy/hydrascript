//! Expressions. The same Kind arms as the TSX emitter, spelled differently.

use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;
use crate::emitter::{free_func, str_method};

use super::*;


impl JsEmitter {
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
                // Plain `/` divides by zero into `Infinity` in JS and raises in
                // Python. Same reasoning as `//` above: a value that looks like a
                // number is worse than an exception, and the `except` block the
                // author wrote is the handle for it.
                if op == "/" {
                    self.used_helpers.borrow_mut().insert("py_div".into());
                    return Ok(format!("py_div({}, {})", l, r));
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
                // `//` raises ZeroDivisionError in Python. `Math.floor(a / b)`
                // answered Infinity, which is a number-shaped value that poisons
                // everything downstream, and the `except ZeroDivisionError:`
                // block the author wrote never ran.
                if op == "floordiv" {
                    self.used_helpers.borrow_mut().insert("py_floordiv".into());
                    return Ok(format!("py_floordiv({}, {})", l, r));
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
                        // A LOCAL `def` first, then an imported one. The second
                        // half is what makes `from "./lib/stats.hys" import f`
                        // accept `f(b=2, a=1)` in a `.hys` file.
                        let sig = match self.fn_params.borrow().get(id).cloned() {
                            Some(names) => Some(names),
                            None => self
                                .import_specs
                                .borrow()
                                .get(id)
                                .cloned()
                                .and_then(|spec| {
                                    crate::emitter::imported_fn_params_for_hx(
                                        &spec,
                                        id,
                                        self.base_dir.as_deref(),
                                    )
                                }),
                        };
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

    pub(super) fn param(&self, p: &Param) -> Result<String, CompileError> {
        // Types are erased in the JS target.
        if let Some(d) = &p.default {
            if !matches!(&d.kind, Kind::Null) {
                return Ok(format!("{} = {}", p.name, self.js(d)?));
            }
        }
        Ok(p.name.clone())
    }
}
