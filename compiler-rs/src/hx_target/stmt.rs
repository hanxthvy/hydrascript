//! Statements: `def` becomes a hoisted function declaration.

use crate::ast::{Kind, Node};
use crate::error::CompileError;
use crate::emitter::Scope;

use super::*;
use super::util::body_has_yield;


impl JsEmitter {
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
                // Remember WHERE each name came from, so a keyword argument at a
                // call site can be reordered against the real signature. The
                // React emitter has done this for a while; this target did not,
                // so the same call compiled in a `.hsx` file and failed in a
                // `.hys` one with "no signature to read".
                if let Some(f) = from.as_ref() {
                    for nm in names {
                        let bare = nm.trim_start_matches("* as ").trim();
                        if !bare.is_empty() && bare != "default" {
                            self.import_specs
                                .borrow_mut()
                                .insert(bare.to_string(), f.clone());
                        }
                    }
                }
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
}
