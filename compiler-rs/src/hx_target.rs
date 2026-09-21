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
use crate::error::CompileError;
use crate::emitter::{free_func, str_method};

pub struct JsEmitter {
    pub lines: Vec<String>,
    pub linemap: Vec<usize>,
    pub cur_src: usize,
    pub depth: usize,
    pub imports: std::collections::HashSet<String>,
    pub used_helpers: std::cell::RefCell<std::collections::HashSet<String>>,
    pub head_lines: Vec<String>,
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
            Kind::Name(id) => Ok(id.clone()),
            Kind::Attr { obj, name } => {
                let o = self.js(obj)?;
                Ok(format!("{}.{}", o, str_method(name)))
            }
            Kind::Index { obj, index } => {
                let o = self.js(obj)?;
                let i = self.js(index)?;
                Ok(format!("{}[{}]", o, i))
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
                Ok(format!("({} {} {})", l, op, r))
            }
            Kind::Unary { op, operand } => Ok(format!("({}{})", op, self.js(operand)?)),
            Kind::Ternary { test, body, orelse } => {
                let c = self.js(test)?;
                let b = self.js(body)?;
                let o = self.js(orelse)?;
                Ok(format!("({} ? {} : {})", c, b, o))
            }
            Kind::Lambda { params, defaults, body } => {
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
            Kind::Await(v) => Ok(format!("await {}", self.js(v)?)),
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
                            "len" => return Ok(format!("{}.length", arg)),
                            "str" => return Ok(format!("String({})", arg)),
                            "abs" => return Ok(format!("Math.abs({})", arg)),
                            "round" => return Ok(format!("Math.round({})", arg)),
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
                }
                let fn_str = self.js(func)?;
                let mut all = Vec::new();
                for a in args {
                    all.push(self.js(a)?);
                }
                // `.hx` does NOT rename props — no on_click -> onClick here.
                for (k, v) in kwargs {
                    all.push(format!("{}: {}", k, self.js(v)?));
                }
                Ok(format!("{}({})", fn_str, all.join(", ")))
            }
            Kind::Return(_) | Kind::If { .. } | Kind::For { .. } | Kind::Assign { .. }
            | Kind::AugAssign { .. } | Kind::ExprStmt(_) | Kind::Def { .. }
            | Kind::Import { .. } | Kind::Tree { .. } | Kind::Component { .. }
            | Kind::Match { .. } => Err(
                CompileError::new("statement in expression position", n.line, n.col, Vec::new()),
            ),
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
            Kind::Def { name, params, body } => {
                // A hoisted function declaration, not a const arrow: mutual
                // recursion must work without ordering gymnastics.
                let ps: Result<Vec<String>, CompileError> = params
                    .iter()
                    .map(|p| self.param(p))
                    .collect();
                self.w(&format!("function {}({}) {{", name, ps?.join(", ")));
                self.depth += 1;
                for stmt in body {
                    self.stmt(stmt)?;
                }
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
                let ps: Result<Vec<String>, CompileError> = params
                    .iter()
                    .map(|p| self.param(p))
                    .collect();
                self.w(&format!("async function {}({}) {{", name, ps?.join(", ")));
                self.depth += 1;
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.depth -= 1;
                self.w("}");
            }
            Kind::Export(inner) => {
                // `export def` -> `export function`
                match &inner.kind {
                    Kind::Def { name, params, body } => {
                        let ps: Result<Vec<String>, CompileError> = params.iter().map(|p| self.param(p)).collect();
                        self.w(&format!("export function {}({}) {{", name, ps?.join(", ")));
                        self.depth += 1;
                        for stmt in body { self.stmt(stmt)?; }
                        self.depth -= 1;
                        self.w("}");
                    }
                    Kind::AsyncDef { name, params, body } => {
                        let ps: Result<Vec<String>, CompileError> = params.iter().map(|p| self.param(p)).collect();
                        self.w(&format!("export async function {}({}) {{", name, ps?.join(", ")));
                        self.depth += 1;
                        for stmt in body { self.stmt(stmt)?; }
                        self.depth -= 1;
                        self.w("}");
                    }
                    Kind::Assign { target, value } => {
                        let lhs = self.js(target)?;
                        let rhs = self.js(value)?;
                        self.w(&format!("export const {} = {};", lhs, rhs));
                    }
                    _ => {
                        self.w("export ");
                        self.stmt(inner)?;
                    }
                }
            }
            Kind::Try { body, handlers, orelse: _, finally } => {
                self.w("try {");
                self.depth += 1;
                for stmt in body { self.stmt(stmt)?; }
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
                            for stmt in &h.body { self.stmt(stmt)?; }
                            self.depth -= 1;
                            self.w("}");
                        } else {
                            // Bare `except:` catches everything.
                            if first {
                                for stmt in &h.body { self.stmt(stmt)?; }
                            } else {
                                self.w("else {");
                                self.depth += 1;
                                for stmt in &h.body { self.stmt(stmt)?; }
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
                    for stmt in fin { self.stmt(stmt)?; }
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
                    let mod_name = if f == "serpent_js" { "serpent-js" } else { f.as_str() };
                    self.imports.insert(format!("import {{ {} }} from '{}';", names.join(", "), mod_name));
                } else {
                    self.imports.insert(format!("import {} from 'serpent-js';", names.join(", ")));
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
            _ => {}
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

        for s in body {
            match &s.kind {
                Kind::Component { .. } | Kind::Tree { .. } => self.stmt(s)?,
                Kind::Import { from, names } => {
                    if let Some(f) = from {
                        let mod_name = if f == "serpent_js" { "serpent-js" } else { f.as_str() };
                        self.imports.insert(format!("import {{ {} }} from '{}';", names.join(", "), mod_name));
                    } else {
                        self.imports.insert(format!("import {} from 'serpent-js';", names.join(", ")));
                    }
                }
                _ => self.stmt(s)?,
            }
        }

        // Inject helpers the source used but did not import.
        let helpers: Vec<String> = self.used_helpers.borrow().iter().cloned().collect();
        if !helpers.is_empty() {
            let mut h = helpers;
            h.sort();
            self.imports.insert(format!("import {{ {} }} from 'serpent-js';", h.join(", ")));
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
            segs.push(format!("{}{}{}", encode_vlq(0), encode_vlq(0), encode_vlq(0)));
        }
        for sl in &self.linemap {
            let sl_i = *sl as i64;
            let d = (sl_i - 1) - prev_src;
            prev_src = sl_i - 1;
            segs.push(format!("{}{}{}", encode_vlq(0), encode_vlq(d), encode_vlq(0)));
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
