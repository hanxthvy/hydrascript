//! Expression emission: one arm per Kind, plus the Python lowering it implies.

use crate::ast::{Kind, Node};
use crate::error::CompileError;

use super::*;
use super::imports::{imported_fn_params, method_params};

impl Emitter {
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
                        FPart::Expr { value, conv, spec } => {
                            let mut e = self.js(value)?;
                            // `!r` / `!s` / `!a` ask for a string form. JS has no
                            // repr; refusing them would break code that only
                            // wanted plain interpolation, so they mean String().
                            if conv.is_some() {
                                e = format!("String({})", e);
                            }
                            // A format spec is TRANSLATED or refused, never
                            // dropped: silently rendering `1500` for `.2f` is
                            // wrong output on money, not a missing feature.
                            if let Some(spec) = spec {
                                e = crate::fstr::translate(spec, &e).map_err(|why| {
                                    CompileError::new(
                                        format!("unsupported format spec `:{}`", spec),
                                        n.line,
                                        n.col,
                                        Vec::new(),
                                    )
                                    .with_hint(format!(
                                        "{} — write the formatting as JS instead, e.g. `({}).toFixed(2)`",
                                        why,
                                        self.js(value).unwrap_or_default()
                                    ))
                                })?;
                                // The translator emits runtime calls for the
                                // specs `toFixed` gets wrong (Python rounds a
                                // tie to even; `toFixed` rounds away from zero).
                                // Those names have to be imported here, because
                                // unlike the other helpers there is no AST node
                                // that mentions them — the call is invented by
                                // the translator.
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
                // A bare exception name — `except ValueError:` — resolves to
                // the runtime class of the same name, so the `instanceof` test
                // in the emitted catch block names something that exists.
                if python_base_class(id).is_some() && !self.class_names.borrow().contains(id) {
                    self.used_helpers.borrow_mut().insert(id.clone());
                }
                Ok(id.clone())
            }
            Kind::Attr { obj, name } => {
                // `self.x` -> `this.x` (see Kind::Name above) — routed through
                // the same code path by rewriting the object first.
                let o = self.js(obj)?;
                // `type(x).__name__` — the ONE dunder that needs a call rather
                // than a property read. `type(x)` already emits
                // `py_type_name(x)`, which returns a STRING, and a string has no
                // `.name`: leaving this to the generic map below answered
                // `undefined` for every value. Recognising the shape here is
                // what makes the emitted pair agree.
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
                // Python's `is` / `is not` are identity tests. JavaScript has no
                // `is` operator at all — leaving it in produced `(a is b)`, which
                // is a syntax error. `===` is the closest faithful translation.
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
                // `veil("...")`: a literal that must not be greppable in the
                // bundle. Encoded here so the value never appears in the output;
                // a credential-shaped literal is a build error instead, because
                // veiling it would imply it is safe to ship.
                if let Kind::Name(id) = &func.kind {
                    if id == "veil" && args.len() == 1 && kwargs.is_empty() {
                        if let Kind::Str { value, is_f: false } = &args[0].kind {
                            let body = super::veil::literal_body(value);
                            if let Some(kind) = super::veil::looks_like_secret(&body) {
                                return Err(CompileError::new(
                                    format!(
                                        "veil() refuses to wrap {kind}: veil is obfuscation, not encryption"
                                    ),
                                    n.line,
                                    n.col,
                                    Vec::new(),
                                )
                                .with_hint(
                                    "keep the value in a .server.hys and read it there, so it never reaches the bundle",
                                ));
                            }
                            self.used_helpers.borrow_mut().insert("__veil".into());
                            // The salt is the call's position, so two identical
                            // literals in one file do not share a key.
                            let salt = ((n.line as u32) << 16) ^ (n.col as u32);
                            let (parts, key) = super::veil::encode(&body, salt);
                            let parts_js = parts
                                .iter()
                                .map(|p| format!("{:?}", p))
                                .collect::<Vec<_>>()
                                .join(", ");
                            let key_js = key
                                .iter()
                                .map(|b| b.to_string())
                                .collect::<Vec<_>>()
                                .join(",");
                            return Ok(format!("__veil([{}], [{}])", parts_js, key_js));
                        }
                    }
                }
                // A Python exception class: `new ValueError(...)`, imported.
                // Without the import the emitted code named a global that does
                // not exist, and the module threw on load.
                if let Kind::Name(id) = &func.kind {
                    if python_base_class(id).is_some() && !self.class_names.borrow().contains(id) {
                        self.used_helpers.borrow_mut().insert(id.clone());
                        let bits: Result<Vec<_>, _> = args.iter().map(|a| self.js(a)).collect();
                        return Ok(format!("new {}({})", id, bits?.join(", ")));
                    }
                }
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
                        //
                        // Only the names whose ONLY arity is two belong here.
                        // `pow`, `sum` and `round` are symmetric in the number
                        // of arguments, and dispatching them from this arm on
                        // `args.len() >= 2` swallowed every later branch: the
                        // `args.len() == 1` arm never ran for them, so
                        // `pow(2)` emitted `Math.pow(2)` and the dedicated
                        // `sum(xs, start)` / `round(x, n)` branches below were
                        // dead code that no test could reach.
                        let arity_two_only = matches!(id.as_str(), "max" | "min" | "isinstance");
                        if args.len() >= 2 && arity_two_only {
                            let mut all = Vec::new();
                            for a in args {
                                all.push(self.js(a)?);
                            }
                            match id.as_str() {
                                "max" => return Ok(format!("Math.max({})", all.join(", "))),
                                "min" => return Ok(format!("Math.min({})", all.join(", "))),
                                "isinstance" => {
                                    // `int` and `float` are NOT the same question:
                                    // Python separates them and JS spells both with
                                    // `Number`, so `isinstance(1.5, int)` used to
                                    // answer true. The compiler can see the type
                                    // NAME here, so it picks the helper that knows
                                    // the difference instead of collapsing them.
                                    let ty = all[1].trim().to_string();
                                    match ty.as_str() {
                                        "int" => {
                                            self.used_helpers.borrow_mut().insert("isinstance_int".into());
                                            return Ok(format!("isinstance_int({})", all[0]));
                                        }
                                        "float" => {
                                            self.used_helpers.borrow_mut().insert("isinstance_float".into());
                                            return Ok(format!("isinstance_float({})", all[0]));
                                        }
                                        _ => {}
                                    }
                                    self.used_helpers.borrow_mut().insert("isinstance".into());
                                    let mapped = match ty.as_str() {
                                        "str" => "String",
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
                        if args.len() == 2 {
                            let arg = self.js(&args[0])?;
                            let arg2 = self.js(&args[1])?;
                            match id.as_str() {
                                // `divmod(a, b)` -> [a // b, a % b]. This arm is
                                // what makes it work: the one-argument arm below
                                // can never see a two-argument call, so before
                                // this the name emitted verbatim and threw
                                // `ReferenceError: divmod is not defined`.
                                "divmod" => {
                                    self.used_helpers.borrow_mut().insert("divmod".into());
                                    return Ok(format!("divmod({}, {})", arg, arg2));
                                }
                                // `map(fn, xs)` -> the ARRAY is the receiver, the
                                // callable is the argument — the opposite of
                                // `xs.map(fn)`. Emitting `fn.map(xs)` asks a
                                // function for a method it does not have.
                                "map" => return Ok(format!("(fn => {}.map(fn))({})", arg2, arg)),
                                "filter" => return Ok(format!("(fn => {}.filter(fn))({})", arg2, arg)),
                                // `hasattr(x, "y")` and `setattr(x, "y", v)`.
                                // These used to emit verbatim: `check.rs` saw
                                // the name, found it on its "not provided"
                                // list, and the build failed — the honest
                                // outcome, but the wrong answer, because both
                                // have an exact JS equivalent.
                                // `getattr(x, "y")` without a default. The
                                // runtime raises AttributeError rather than
                                // returning undefined — that difference is what
                                // makes the three-argument form mean anything.
                                "getattr" => {
                                    self.used_helpers.borrow_mut().insert("getattr".into());
                                    return Ok(format!("getattr({}, {})", arg, arg2));
                                }
                                "hasattr" => {
                                    self.used_helpers.borrow_mut().insert("hasattr".into());
                                    return Ok(format!("hasattr({}, {})", arg, arg2));
                                }
                                _ => {}
                            }
                        }
                        // The three-argument forms. `setattr` needs all three
                        // arities to be considered here because the two-argument
                        // arm above cannot see it, and a missed arity shows up as
                        // a call to an identifier that was never emitted as an
                        // import — a ReferenceError with a green build.
                        if args.len() == 3 && (id == "getattr" || id == "setattr") {
                            self.used_helpers.borrow_mut().insert(id.clone());
                            let mut all = Vec::new();
                            for a in args {
                                all.push(self.js(a)?);
                            }
                            return Ok(format!("{}({})", id, all.join(", ")));
                        }
                        if args.len() == 1 {
                            let arg = self.js(&args[0])?;
                            match id.as_str() {
                                // `max(xs)` / `min(xs)` — ONE sequence argument.
                                // These used to spread it (`Math.max(...xs)`), which
                                // is right for an array but NaN for anything else,
                                // and the `args.len() == 1` arm returned
                                // `Math.max(...xs)` for a LIST too, so a caller with
                                // a plain array was fine while `max(range(3))`
                                // depended on the spread of a non-iterable. The
                                // runtime helper answers for both.
                                "max" => {
                                    self.used_helpers.borrow_mut().insert("max_of".into());
                                    return Ok(format!("max_of({})", arg));
                                }
                                "min" => {
                                    self.used_helpers.borrow_mut().insert("min_of".into());
                                    return Ok(format!("min_of({})", arg));
                                }
                                // `type(x)` -> `py_typename(x)`.
                                //
                                // It used to emit `x.constructor`, so
                                // `type(x).__name__` (below, via the
                                // `__name__` -> `name` map) answered the
                                // JAVASCRIPT class: "Object" for a dict,
                                // "Array" for a list, "Number" for both int and
                                // float — and `type(None)` threw, because
                                // `null.constructor` is a TypeError. A Python
                                // author branching on a type name got a wrong
                                // branch and, for None, a crash.
                                "type" => {
                                    self.used_helpers.borrow_mut().insert("py_type_name".into());
                                    return Ok(format!("py_type_name({})", arg));
                                }
                                // `len(x, y)` and `str(x, y)` are not Python, but
                                // `sorted(xs, key=...)` and friends arrive here
                                // with kwargs and are handled below.
                                _ => {}
                            }
                        }
                        // `format(value, spec)` — Python's builtin. It is a
                        // BUILTIN, not a string method, and it used to fall
                        // through every arm and emit `format(...)` verbatim:
                        // a call to an identifier nothing imported, so the
                        // build stayed green and the runtime threw
                        // `ReferenceError: format is not defined` on the first
                        // request that used it. The two-argument form is the
                        // only one Python defines.
                        // Only when `format` is NOT imported: `from "date-fns"
                        // import format` is that library's pattern formatter, and
                        // rewriting it to Python's spec grammar broke a real
                        // example (`yyyy-MM-dd` is not a Python spec).
                        if id == "format" && args.len() == 2 && !self.imported_names.borrow().contains("format") {
                            self.used_helpers.borrow_mut().insert("py_format".into());
                            return Ok(format!(
                                "py_format({}, {})",
                                self.js(&args[0])?,
                                self.js(&args[1])?
                            ));
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
                            // `str(x)` — Python's spelling. `String(x)` answers `null`, `true`
                            // and `1` where Python says `None`, `True` and `1.0`,
                            // and that text lands in a page, a log line or a
                            // receipt. `py_str` is the Python answer.
                            "str" => {
                                self.used_helpers.borrow_mut().insert("py_str".into());
                                return Ok(format!("py_str({})", arg));
                            }
                            // `parseInt("12px")` is 12 and Python RAISES. The
                            // runtime constructors do the Python thing; a silent
                            // 12 from "12px" is a corrupt number that travels.
                            "int" => {
                                self.used_helpers.borrow_mut().insert("int".into());
                                return Ok(format!("int({})", arg));
                            }
                            "float" => {
                                self.used_helpers.borrow_mut().insert("float".into());
                                return Ok(format!("float({})", arg));
                            }
                            "abs" => return Ok(format!("Math.abs({})", arg)),
                            // `round(x)` — Python's tie-to-even, not Math.round.
                            // `round(2.5)` is 2 in Python and 3 in JS.
                            "round" => {
                                self.used_helpers.borrow_mut().insert("round_py".into());
                                return Ok(format!("round_py({})", arg));
                            }
                            "sum" => return Ok(format!("{}.reduce((a, b) => a + b, 0)", arg)),
                            // The runtime sorts numbers numerically; the bare
                            // `.sort()` compares string forms and puts [10,100,9]
                            // in that order. Silent, green build, wrong list.
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
                            // Python's short-circuiting quantifiers. `any(xs)`
                            // is not `xs.some()`: with no callable, that
                            // throws. The runtime helpers do the real thing,
                            // including the empty-sequence answers (any -> False,
                            // all -> True) that a JS developer would not guess.
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
                            _ => {}
                        }
                    }
                }

                if self.is_element_call(func) {
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
                // An IMPORTED function from a relative path: the signature can
                // be read from the file, so keyword arguments work exactly as
                // they do for a local `def`. Before this, the list said the
                // reordering was impossible, which was only true of npm
                // packages — the compiler simply never looked.
                if !kwargs.is_empty() {
                    if let Kind::Name(id) = &func.kind {
                        if let Some(spec) = self.import_specs.borrow().get(id).cloned() {
                            if let Some(names) = imported_fn_params(&spec, id, self.base_dir.as_deref()) {
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
                                    if let Some(idx) = names.iter().position(|n| n == k) {
                                        if slots[idx].is_none() {
                                            slots[idx] = Some(self.js(v)?);
                                        }
                                    } else {
                                        unknown = Some(k.clone());
                                    }
                                }
                                if let Some(k) = unknown {
                                    return Err(CompileError::new(
                                        format!("{}() has no parameter named `{}`", id, k),
                                        n.line,
                                        n.col,
                                        Vec::new(),
                                    )
                                    .with_hint(format!("{}() takes: {}", id, names.join(", "))));
                                }
                                let filled: Vec<String> =
                                    slots.into_iter().flatten().collect();
                                return Ok(format!("{}({})", id, filled.join(", ")));
                            }
                        }
                    }
                }
                let fn_str = self.js(func)?;
                let mut all = Vec::new();
                for a in args {
                    all.push(self.js(a)?);
                }
                // Still no signature: a package function, or a specifier that
                // could not be read. Emit the call JS can parse and say so,
                // rather than producing `f(a: 1)` and reporting success.
                if !kwargs.is_empty() {
                    // A method call: `x.greet(b=2)` or `super().greet(b=2)`.
                    // The signature is known when exactly one class in this file
                    // declares the name, which is the common case and the one
                    // worth supporting. More than one class makes the receiver's
                    // type decide, and that is genuinely unknown here.
                    let method_name = match &func.kind {
                        Kind::Attr { name, .. } => Some(name.clone()),
                        Kind::SuperMember { member } => Some(member.clone()),
                        _ => None,
                    };
                    if let Some(m) = method_name {
                        let table = self.fn_params.borrow();
                        if let Some(names) = method_params(&table, &m) {
                            drop(table);
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
                                if let Some(idx) = names.iter().position(|n| n == k) {
                                    if slots[idx].is_none() {
                                        slots[idx] = Some(self.js(v)?);
                                    }
                                } else {
                                    unknown = Some(k.clone());
                                }
                            }
                            if let Some(k) = unknown {
                                return Err(CompileError::new(
                                    format!("{}() has no parameter named `{}`", m, k),
                                    n.line,
                                    n.col,
                                    Vec::new(),
                                )
                                .with_hint(format!("{}() takes: {}", m, names.join(", "))));
                            }
                            let filled: Vec<String> = slots.into_iter().flatten().collect();
                            return Ok(format!("{}({})", self.js(func)?, filled.join(", ")));
                        }
                    }
                    // Two reasons left, and they need different answers: the
                    // call is on a package (no source to read), or the receiver
                    // of a method call could not be narrowed. Saying "defined in
                    // this file" for both sent people looking in the wrong place.
                    let is_method = matches!(&func.kind, Kind::Attr { .. } | Kind::SuperMember { .. });
                    let msg = if is_method {
                        format!("keyword arguments are not supported for method calls (`{}`)", fn_str)
                    } else {
                        format!(
                            "keyword arguments are not supported for `{}`, which is not from a relative .hys/.hyx file (no signature to read)",
                            fn_str
                        )
                    };
                    let hint = if is_method {
                        "pass the argument positionally, or take a dict of options"
                    } else {
                        "pass the argument positionally, or wrap the options in a dict"
                    };
                    return Err(CompileError::new(msg, n.line, n.col, Vec::new()).with_hint(hint));
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
            // A tagged template keeps its tag glued to the literal. The raw token
            // already carries the backticks and any `${...}` inside it.
            Kind::TaggedTemplate { tag, raw } => Ok(format!("{}{}", self.js(tag)?, raw)),
            Kind::Super => Ok("super".to_string()),
            // A bare `super().name` is rejected by the parser, so reaching here
            // means the node was used as a callee. `__init__` is the parent
            // constructor and JS spells that `super(...)`; anything else is
            // `super.name(...)`.
            Kind::SuperMember { member } => {
                if member == "__init__" {
                    Ok("super".to_string())
                } else {
                    Ok(format!("super.{}", str_method(member)))
                }
            }
            Kind::Await(v) => Ok(format!("await {}", self.js(v)?)),
            // `new Foo(args)` where Foo is a class declared in this file: the Call
            // arm above already prefixes `new` for class names, so wrapping again
            // emitted the invalid `new new Foo(args)`.
            //
            // The inner call is built here rather than through `js()` because `js()`
            // routes a capitalised callee (`THREE.Scene()`) to the JSX path, and
            // `new <THREE.Scene />` has nothing to construct. After `new` the target
            // is a constructor, never an element, so the call form is forced.
            Kind::New(inner) => {
                if let Kind::Call { func, args, kwargs } = &inner.kind {
                    if let Kind::Name(id) = &func.kind {
                        if self.class_names.borrow().contains(id) {
                            let bits: Result<Vec<_>, _> =
                                args.iter().map(|a| self.js(a)).collect();
                            let mut all = bits?;
                            for (k, v) in kwargs {
                                all.push(format!("{}: {}", prop_map(k), self.js(v)?));
                            }
                            return Ok(format!("new {}({})", id, all.join(", ")));
                        }
                    }
                    let mut all: Vec<String> = Vec::new();
                    for a in args {
                        all.push(self.js(a)?);
                    }
                    if !kwargs.is_empty() {
                        let mut props: Vec<String> = Vec::new();
                        for (k, v) in kwargs {
                            props.push(format!("{}: {}", prop_map(k), self.js(v)?));
                        }
                        all.push(format!("{{ {} }}", props.join(", ")));
                    }
                    return Ok(format!("new {}({})", self.ctor_name(func)?, all.join(", ")));
                }
                Ok(format!("new {}", self.js(inner)?))
            }
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

    pub(super) fn attr_str(&self, args: &[Node], kwargs: &[(String, Node)]) -> Result<String, CompileError> {
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

    /// True when `t` is exactly one `{...}` container, not several concatenated.
    ///
    /// The brace depth must reach zero only at the very end, otherwise `{a}\n{b}`
    /// would have its outer characters stripped and the result is not an expression.
    /// Wrap a fragment as a parenthesised expression, unless it already IS one.
    ///
    /// `frag` returns `{cond ? (..) : null}` for a single `if:` body — an expression
    /// container, not markup. Wrapping that in parens produced `({ {..} })`, which is
    /// not valid JavaScript ("Expected '{' but found '}'" / "Expected identifier but
    /// found '('"), and the same shape appears in `&&`, ternaries and `map`.
    pub(super) fn as_expr(frag: &str) -> String {
        let t = frag.trim();
        if Self::is_one_container(t) {
            t[1..t.len() - 1].trim().to_string()
        } else {
            t.to_string()
        }
    }

    pub(super) fn is_one_container(t: &str) -> bool {
        if !t.starts_with('{') || !t.ends_with('}') || t.len() < 2 {
            return false;
        }
        let mut depth = 0usize;
        for (i, c) in t.char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 && i != t.len() - 1 {
                        return false;
                    }
                }
                _ => {}
            }
        }
        depth == 0
    }
}
