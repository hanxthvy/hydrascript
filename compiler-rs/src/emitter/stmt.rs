//! Statement emission: blocks, hoisting, and what a binding is.

use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;

use super::*;
use super::imports::import_shapes_as_default;

impl Emitter {
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
                    let id = id.clone();
                    // Decide `let` vs `const` and whether this is the binding's
                    // first appearance, then drop the borrow before asking about
                    // the enclosing scopes.
                    let Some((declare, first)) = self.scopes.last_mut().map(|scope| {
                        let declare = if scope.is_mutable(&id) { "let" } else { "const" };
                        let first = scope.declared.insert(id.clone());
                        (declare, first)
                    }) else {
                        self.w(&format!("const {} = {};", lhs, rhs));
                        return Ok(());
                    };
                    // A name an enclosing scope already binds is a closure capture:
                    // assigning it writes that binding. Emitting `const raf = ...`
                    // here SHADOWED the outer `let raf`, leaving the outer variable
                    // at its initial value and putting the new one in the temporal
                    // dead zone — `Cannot access 'raf' before initialization` the
                    // moment the callback ran. Every component whose effect assigns
                    // an outer `let` from a callback died this way.
                    if !first || self.bound_in_enclosing(&id) {
                        self.w(&format!("{} = {};", lhs, rhs));
                    } else {
                        self.w(&format!("{} {} = {};", declare, lhs, rhs));
                    }
                    return Ok(());
                }
                // Destructuring (`a, b = pair()`) binds names, so it declares.
                // Member and index targets do NOT: `const x.y = 1` is a syntax
                // error, so those always emit a plain assignment.
                //
                // `Kind::List` is here because the BRACKETED spelling of the same
                // thing parses as a list literal, not a tuple:
                // `[n, set_n] = useState(0)` is the idiom React's own docs teach
                // for hooks. Without this it emitted `[n, set_n] = useState(0)` —
                // no binding — which is a `ReferenceError` at runtime while the
                // build reported success. Every element must be a name; a list
                // containing anything else is a real list, and a real list is
                // never a valid assignment target, so it falls through to the
                // plain form and the emitter's output check rejects it.
                let binds_names = match &target.kind {
                    Kind::Tuple(items) | Kind::List(items) => {
                        !items.is_empty() && items.iter().all(|i| matches!(i.kind, Kind::Name(_)))
                    }
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
                        // ALL, not any. If every target is already bound this is a
                        // re-assignment (the swap `a, b = b, a`), which is a plain
                        // assignment. If only SOME are bound, the honest outcome is
                        // a build error: `let [a, b] = ...` over one existing
                        // binding is a SyntaxError, and the alternative — a plain
                        // assignment — would silently leave the new name undefined
                        // and throw at runtime instead. A loud build failure beats
                        // a quiet runtime one.
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
                // A Python exception base has no JS equivalent, so the runtime
                // provides one per name. `class ValidationError(Exception)`
                // emitted `extends Exception` — a name nothing defines, so the
                // module threw `ReferenceError: Exception is not defined` the
                // moment it loaded, and `except ValidationError:` compiled to
                // `instanceof ValidationError` against a class that never
                // existed. README documents this exact code.
                let head = match base {
                    Some(b) => {
                        if let Some(fix) = python_base_class(b).filter(|_| !self.class_names.borrow().contains(b.as_str())) {
                            self.used_helpers.borrow_mut().insert(fix.to_string());
                            format!("class {} extends {}", name, fix)
                        } else {
                            format!("class {} extends {}", name, b)
                        }
                    }
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
                        // Methods get a signature entry too, so `x.method(b=2)`
                        // can be reordered. It is keyed `Class.method`, and the
                        // call site looks it up by the receiver's inferred class
                        // when it can, or by the bare method name when there is
                        // only one class in the file declaring it.
                        self.fn_params.borrow_mut().insert(
                            format!("{}.{}", name, mname),
                            filtered.iter().map(|p| p.name.clone()).collect(),
                        );
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
                        self.push_scope(scope);
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
            // `export def` in a `.hyx`. This arm did not exist, so the statement
            // fell into the catch-all `_ => {}` and VANISHED — the function was not
            // emitted at all, the build reported success, and the only symptom was a
            // missing name at run time. `.hyx` is compiled by this emitter; the
            // `Kind::Export` arm in `hx_target.rs` serves `.hys` and never ran here.
            Kind::Export(inner) => {
                match &inner.kind {
                    Kind::Def { name, params, body } | Kind::AsyncDef { name, params, body } => {
                        let ps = self.format_params(params)?;
                        let kw = if matches!(&inner.kind, Kind::AsyncDef { .. }) {
                            "async "
                        } else {
                            ""
                        };
                        self.w(&format!("export const {} = {}({}) => {{", name, kw, ps));
                        self.depth += 1;
                        let mut scope = Scope::scan(body);
                        for p in params {
                            let bare = p.name.trim_start_matches("...").to_string();
                            scope.params.insert(bare);
                            scope.declared.insert(p.name.trim_start_matches("...").to_string());
                        }
                        self.push_scope(scope);
                        self.hoist_nested_assignments();
                        for stmt in body {
                            self.stmt(stmt)?;
                        }
                        self.scopes.pop();
                        self.depth -= 1;
                        self.w("};");
                    }
                    // `export class X:` and `export const x = ...` keep their own
                    // arms; delegate so the prefix is not lost.
                    _ => {
                        let inner_src = self.js(inner)?;
                        self.w(&format!("export {}", inner_src));
                    }
                }
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
            Kind::Def { name, params, body } | Kind::AsyncDef { name, params, body } => {
                let ps = self.format_params(params)?;
                // `async def` at module or block level has to emit `async function`.
                // Without the keyword the body's `await` is illegal, and before this
                // arm existed the whole statement was dropped by the catch-all `_ => {}`
                // — a build that reported success and a ReferenceError at run time.
                let kw = if matches!(s.kind, Kind::AsyncDef { .. }) { "async " } else { "" };
                self.w(&format!("const {} = {}({}) => {{", name, kw, ps));
                self.depth += 1;
                let mut scope = Scope::scan(body);
                for p in params {
                    let bare = p.name.trim_start_matches("...").to_string();
                    scope.params.insert(bare);
                    scope.declared.insert(p.name.trim_start_matches("...").to_string());
                }
                self.push_scope(scope);
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
            // `while` had no arm here at all — the same defect the `try` arm below
            // describes for itself. Every `while:` fell into the catch-all and was
            // DROPPED: the condition was never even evaluated, nothing was reported,
            // and the build said "Built successfully".
            //
            // This is the bug that made the whole React Bits port look broken. The
            // corpus counts with `while` (`GlassIcons`: `i = 0 / while i < count: /
            // i += 1`), so every such loop vanished and components rendered empty
            // canvases with no error at all. Measured on one component: 11 `while` in
            // the source, 0 in the emitted JS.
            Kind::While { test, body } => {
                let cond = self.js(test)?;
                let cond = crate::emitter::py_cond(&cond);
                if cond.starts_with("truthy(") {
                    self.used_helpers.borrow_mut().insert("truthy".into());
                }
                self.w(&format!("while ({}) {{", cond));
                self.depth += 1;
                if body.is_empty() {
                    self.w(";");
                }
                for stmt in body {
                    self.stmt(stmt)?;
                }
                self.depth -= 1;
                self.w("}");
            }
            // `try` had no arm here at all, so every `try:` block fell into the
            // catch-all below and was DROPPED — silently, with the build reporting
            // success while the body never reached the output. Emit a real
            // try/catch(/finally); Python's optional `else` runs only when no
            // exception was raised, which a flag reproduces faithfully.
            Kind::Try { body, handlers, orelse, finally } => {
                let needs_else = orelse.is_some();
                let mut flag = String::new();
                if needs_else {
                    flag = self.fresh_var("ok");
                    self.w(&format!("let {} = false;", flag));
                }
                self.w("try {");
                self.depth += 1;
                for stmt in body {
                    self.stmt(stmt)?;
                }
                if needs_else {
                    self.w(&format!("{} = true;", flag));
                }
                self.depth -= 1;
                if handlers.is_empty() {
                    self.w("} catch {}");
                } else {
                    self.w("} catch (__e) {");
                    self.depth += 1;
                    self.w("let __matched = false;");
                    let mut first = true;
                    for h in handlers {
                        // `except Exception:` / `except BaseException:` is Python's
                        // catch-everything handler — the same role as a bare
                        // `except:`. Emitting it as an instanceof test would name a
                        // class the JS runtime does not have and throw at the very
                        // moment the handler was supposed to catch something.
                        let is_catch_all = matches!(
                            h.class.as_deref(),
                            None | Some("Exception") | Some("BaseException")
                        );
                        match &h.class {
                            Some(cls) if !is_catch_all => {
                                // The class must be imported: `except KeyError:`
                                // emits `__e instanceof KeyError`, and without
                                // the import that named a global nothing
                                // defines — a ReferenceError at the very moment
                                // the handler was meant to catch something.
                                // A user's own class of the same name is a
                                // declaration here and must NOT be imported.
                                if !self.class_names.borrow().contains(cls) {
                                    if let Some(fix) = python_base_class(cls) {
                                        self.used_helpers.borrow_mut().insert(fix);
                                    }
                                }
                                let cond = format!("__e instanceof {}", cls);
                                if first {
                                    self.w(&format!("if (!!({})) {{", cond));
                                } else {
                                    self.w(&format!("else if (!!({})) {{", cond));
                                }
                                self.depth += 1;
                                self.w("__matched = true;");
                                if let Some(nm) = &h.name {
                                    self.w(&format!("const {} = __e;", nm));
                                }
                                for stmt in &h.body {
                                    self.stmt(stmt)?;
                                }
                                self.depth -= 1;
                                self.w("}");
                            }
                            // A bare `except:` (or its `Exception` spelling) is the
                            // fallback: it runs only if nothing above matched.
                            _ => {
                                self.w("if (!__matched) {");
                                self.depth += 1;
                                self.w("__matched = true;");
                                if let Some(nm) = &h.name {
                                    self.w(&format!("const {} = __e;", nm));
                                }
                                for stmt in &h.body {
                                    self.stmt(stmt)?;
                                }
                                self.depth -= 1;
                                self.w("}");
                            }
                        }
                        first = false;
                    }
                    // Re-throw anything no handler claimed, the way Python does.
                    // A catch-all handler (`except:` / `except Exception:`) claims
                    // everything, so the re-throw is only emitted when none exists.
                    let has_catch_all = handlers.iter().any(|h| {
                        matches!(
                            h.class.as_deref(),
                            None | Some("Exception") | Some("BaseException")
                        )
                    });
                    if !has_catch_all {
                        self.w("if (!__matched) throw __e;");
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
                if let Some(ore) = orelse {
                    self.w(&format!("if ({}) {{", flag));
                    self.depth += 1;
                    for stmt in ore {
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
                    if names.is_empty() {
                        self.imports.insert(format!("import '{}';", f));
                    } else if names.len() == 1 && names[0].starts_with("* as ") {
                        self.imports
                            .insert(format!("import {} from '{}';", names[0], f));
                    } else if names.len() == 1
                        && (crate::hx_target::asset_import(f)
                            || import_shapes_as_default(f, self.base_dir.as_deref()))
                    {
                        // A module with only a default export — an asset, or a
                        // React component written `export default` — can never
                        // satisfy a named import. `from "./X.tsx" import X` has
                        // to become `import X from './X.tsx'`, or the build fails
                        // with `No matching export in "./X.tsx" for import "X"`.
                        // See `asset_import` and `import_shapes_as_default`.
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
                        .insert(format!("import {} from 'hydra';", names.join(", ")));
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
}
