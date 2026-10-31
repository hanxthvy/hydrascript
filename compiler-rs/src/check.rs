// [xihanzu-NR]
//! Compile-time semantic checks.
//!
//! The compiler validates the *shape* of what it emits, which catches broken
//! output. It does not check *meaning*: `span: total_price` where the author
//! meant `totalPrice` compiles to `<span>{total_price}</span>`, and the only
//! symptom is a blank page at runtime. This module walks the AST looking for
//! the mistakes that survive a successful compile.
//!
//! Scope, deliberately: this is not a type system. There is no inference, no
//! unification, no flow analysis. It checks exactly two things, both of which
//! need only information the compiler already has:
//!
//! 1. **A bare name that is bound nowhere.** Every scope that can bind a name
//!    is tracked, plus the globals a browser really provides and the runtime
//!    helpers `hydra` really exports. Anything else is a typo or a missing
//!    import.
//! 2. **A member the declared interface does not have.** Only when the member
//!    list comes from an `interface`/`type` written in the same file and parsed
//!    unambiguously; a body with anything unusual in it is skipped rather than
//!    guessed at.
//!
//! Everything is a warning, never an error, and `compiler.strict` is not what
//! turns it on: a checker that cried wolf on real code would simply be switched
//! off, so it is tuned on the repository's own examples and the portfolio until
//! it produced zero findings there. Findings are de-duplicated by name+line and
//! capped, so one typo used fifty times is reported once.

use crate::ast::{CaseArm, FPart, Kind, Node};
/// Names `runtime/hydra.ts` exports, generated at build time by `build.rs`.
///
/// The compiler injects `import { helper } from 'hydra'` for these on demand, so
/// a bare use is correct and must not be reported. Generated rather than
/// hand-written, because a hand-written copy drifts, and the drift is silent:
/// a helper missing from the list is reported as an unbound name.
pub use crate::generated::RUNTIME_HELPERS;

use std::collections::{BTreeMap, HashMap, HashSet};

/// A name that resolves without the author binding it.
///
/// Two groups: globals every browser and Node provides, and the helpers
/// `runtime/hydra.ts` exports (the compiler injects `import ... from 'hydra'`
/// for those on demand, so using one bare is correct and needs no import).
pub fn is_known_name(name: &str) -> bool {
    is_browser_global(name) || is_runtime_helper(name)
}

/// Helpers the runtime exports. Kept in sync with `runtime/hydra.ts` by the
/// test `runtime_helpers_are_all_known`, which parses that file.
pub fn is_runtime_helper(name: &str) -> bool {
    RUNTIME_HELPERS.contains(&name)
}

fn is_browser_global(name: &str) -> bool {
    BROWSER_GLOBALS.contains(&name)
}

/// Python builtins the compiler demonstrably makes safe.
///
/// This list is NOT a guess, and NOT "Python has these". A name belongs here
/// only if a bare use of it compiles to one of:
///
///   (a) lowered JavaScript (`len(x)` -> `len_of(x)`, `print(x)` -> `console.log(x)`), or
///   (b) a value the compiler injects `import { ... } from 'hydra'` for
///       (`int(x)` -> `parseInt(x)`, `range(n)`, `zip(a, b)`).
///
/// Anything else compiles to a bare identifier JS has no global for, which is a
/// `ReferenceError` at runtime. The test `python_builtins_are_all_honoured`
/// compiles a real use of every name below and fails if one is neither of those,
/// so the list cannot rot into a lie. It was exactly that failure mode —
/// `getattr(x, "k", 0)` emitted verbatim and crashing at runtime while the
/// checker said nothing — that this rule exists to prevent.
fn is_python_builtin(name: &str) -> bool {
    PYTHON_BUILTINS.contains(&name)
}

/// One finding, with the position needed to print it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
    pub message: String,
    pub line: usize,
    pub col: usize,
    pub hint: Option<String>,
}

impl Warning {
    /// `path:line:col: warning: message`
    pub fn render(&self, filename: &str) -> String {
        let mut s = format!(
            "{}:{}:{}: warning: {}",
            filename, self.line, self.col, self.message
        );
        if let Some(h) = &self.hint {
            s.push_str(&format!("\n  = help: {}", h));
        }
        s
    }
}

/// Names bound in one lexical scope.
#[derive(Default, Clone)]
struct Scope {
    names: HashSet<String>,
    /// Names whose declared type is an interface known in this file, so
    /// `name.member` can be checked. `name -> type name`.
    typed: HashMap<String, String>,
}

impl Scope {
    fn bind(&mut self, name: impl Into<String>) {
        self.names.insert(name.into());
    }
    fn bind_typed(&mut self, name: impl Into<String>, ty: impl Into<String>) {
        let n = name.into();
        self.names.insert(n.clone());
        self.typed.insert(n, ty.into());
    }
    fn has(&self, name: &str) -> bool {
        self.names.contains(name)
    }
    fn type_of(&self, name: &str) -> Option<&String> {
        self.typed.get(name)
    }
}

/// Members of a locally declared interface, when they could be read off
/// unambiguously. `None` means "do not check this interface".
#[derive(Debug, Clone)]
struct Interface {
    members: HashSet<String>,
}

pub struct Checker {
    scopes: Vec<Scope>,
    warnings: Vec<Warning>,
    /// De-dup key: (kind of finding, name). One report per distinct mistake.
    seen: HashSet<String>,
    interfaces: HashMap<String, Interface>,
    /// `interface X(Base)` parents, for inherited members.
    parents: HashMap<String, String>,
    /// Names bound by an `export` at module level, plus every declared fn.
    /// Module-scope statements run top to bottom, so a `def` used before it is
    /// declared would be a false positive: Python files are usually ordered
    /// definitions-first, JS function declarations hoist, and this compiler
    /// emits `function name()` (hoisted) for `def`. So the whole module's
    /// declarations are collected up front.
    hoisted: HashSet<String>,
    cap: usize,
}

/// Cap on reported findings. A single systematic typo can otherwise produce a
/// wall of output that hides everything else.
const MAX_WARNINGS: usize = 40;

impl Checker {
    pub fn new() -> Self {
        Self {
            scopes: vec![Scope::default()],
            warnings: Vec::new(),
            seen: HashSet::new(),
            interfaces: HashMap::new(),
            parents: HashMap::new(),
            hoisted: HashSet::new(),
            cap: MAX_WARNINGS,
        }
    }

    /// Check a module. Returns warnings in source order.
    pub fn check_module(mut self, module: &Node) -> Vec<Warning> {
        let body = match &module.kind {
            Kind::Module(b) => b,
            _ => return Vec::new(),
        };
        self.collect_interfaces(body);
        self.collect_hoisted(body);
        self.walk_body(body);
        self.warnings.sort_by_key(|w| (w.line, w.col));
        self.warnings
    }

    // ---------------------------------------------------------------- pass 1

    /// Read every locally declared interface and type alias. A body that is not
    /// a plain list of `name: type` lines is left unparsed, and members of such
    /// a type are never checked.
    fn collect_interfaces(&mut self, body: &[Node]) {
        for n in body {
            let (name, raw) = match &n.kind {
                Kind::Interface { name, body } => (name.clone(), body.clone()),
                Kind::TypeAlias { name, body } => (name.clone(), body.clone()),
                Kind::Export(inner) | Kind::ExportDefault(inner) => match &inner.kind {
                    Kind::Interface { name, body } => (name.clone(), body.clone()),
                    Kind::TypeAlias { name, body } => (name.clone(), body.clone()),
                    _ => continue,
                },
                _ => continue,
            };
            match parse_interface_members(&raw) {
                Some(members) => {
                    self.interfaces.insert(name, Interface { members });
                }
                None => {
                    // Explicitly not checkable. Recorded so a parameter typed
                    // with it is skipped instead of treated as unknown.
                    self.interfaces.remove(&name);
                }
            }
        }
        // Second pass for `interface X(Y):` parents, once all names are known.
        for n in body {
            if let Kind::Interface { name, body: raw } = &n.kind {
                if let Some(parent) = parse_interface_parent(raw) {
                    self.parents.insert(name.clone(), parent);
                }
            }
        }
    }

    /// Every name declared at module level. Used so a forward reference to a
    /// `def` or component later in the file is not reported.
    fn collect_hoisted(&mut self, body: &[Node]) {
        for n in body {
            match &n.kind {
                Kind::Def { name, .. } | Kind::Component { name, .. } => {
                    self.hoisted.insert(name.clone());
                }
                Kind::AsyncDef { name, .. } => {
                    self.hoisted.insert(name.clone());
                }
                Kind::Class { name, .. } => {
                    self.hoisted.insert(name.clone());
                }
                Kind::Assign { target, .. } => collect_assign_targets(target, &mut self.hoisted),
                Kind::ChainedAssign { targets, .. } => {
                    for t in targets {
                        collect_assign_targets(t, &mut self.hoisted);
                    }
                }
                Kind::TupleAssign { targets, .. } => {
                    for t in targets {
                        collect_assign_targets(t, &mut self.hoisted);
                    }
                }
                Kind::Import { names, .. } => {
                    for n in names {
                        self.hoisted.insert(n.clone());
                    }
                }
                Kind::Export(inner) | Kind::ExportDefault(inner) => {
                    let one = vec![(**inner).clone()];
                    self.collect_hoisted(&one);
                }
                Kind::DecoratedDef { inner, .. } => {
                    let one = vec![(**inner).clone()];
                    self.collect_hoisted(&one);
                }
                _ => {}
            }
        }
    }

    // ---------------------------------------------------------------- pass 2

    fn push_scope(&mut self) {
        self.scopes.push(Scope::default());
    }

    fn pop_scope(&mut self) {
        self.scopes.pop();
    }

    fn bind(&mut self, name: &str) {
        if let Some(s) = self.scopes.last_mut() {
            s.bind(name);
        }
    }

    /// Bind every function/class name declared directly in a nested body.
    ///
    /// A component body may declare `def commit():` and reference it from a
    /// callback twenty lines below. The reference is bound by walking, but a
    /// forward reference, or a reference from inside a nested block that was
    /// walked first, would not be — and the emitter turns these into JS
    /// `function` declarations that hoist. Collecting them up front is what
    /// removes the false positive.
    fn bind_local_defs(&mut self, body: &[Node]) {
        let mut names = HashSet::new();
        for n in body {
            match &n.kind {
                Kind::Def { name, .. }
                | Kind::Component { name, .. }
                | Kind::AsyncDef { name, .. }
                | Kind::Class { name, .. } => {
                    names.insert(name.clone());
                }
                Kind::Export(inner) | Kind::ExportDefault(inner) => {
                    let one = vec![(**inner).clone()];
                    self.collect_local_def_names(&one, &mut names);
                }
                Kind::DecoratedDef { inner, .. } => {
                    let one = vec![(**inner).clone()];
                    self.collect_local_def_names(&one, &mut names);
                }
                _ => {}
            }
        }
        for n in names {
            self.bind(&n);
        }
    }

    fn collect_local_def_names(&self, body: &[Node], out: &mut HashSet<String>) {
        for n in body {
            match &n.kind {
                Kind::Def { name, .. }
                | Kind::Component { name, .. }
                | Kind::AsyncDef { name, .. }
                | Kind::Class { name, .. } => {
                    out.insert(name.clone());
                }
                _ => {}
            }
        }
    }

    fn bind_typed(&mut self, name: &str, ty: &str) {
        if let Some(s) = self.scopes.last_mut() {
            s.bind_typed(name, ty);
        }
    }

    fn is_bound(&self, name: &str) -> bool {
        self.scopes.iter().any(|s| s.has(name))
            || self.hoisted.contains(name)
            || is_known_name(name)
            || is_python_builtin(name)
    }

    fn type_of(&self, name: &str) -> Option<String> {
        for s in self.scopes.iter().rev() {
            if let Some(t) = s.type_of(name) {
                return Some(t.clone());
            }
        }
        None
    }

    fn warn(&mut self, key: String, message: String, line: usize, col: usize, hint: Option<String>) {
        if self.warnings.len() >= self.cap {
            return;
        }
        if !self.seen.insert(key) {
            return;
        }
        self.warnings.push(Warning {
            message,
            line,
            col,
            hint,
        });
    }

    fn walk_body(&mut self, body: &[Node]) {
        for n in body {
            self.walk(n);
        }
    }

    /// Walk a nested block in its own scope.
    fn walk_scoped(&mut self, body: &[Node]) {
        self.push_scope();
        self.bind_local_defs(body);
        self.walk_body(body);
        self.pop_scope();
    }

    fn walk(&mut self, n: &Node) {
        match &n.kind {
            Kind::Module(b) => self.walk_body(b),
            Kind::Component { params, body, .. } => {
                self.bind(name_of(&n.kind));
                self.push_scope();
                for p in params {
                    match &p.ty {
                        Some(t) => self.bind_typed(&p.name, t),
                        None => self.bind(&p.name),
                    }
                }
                // A component body is not required to `return`; the emitter
                // turns its statements into an element. Nothing to check there.
                self.bind_local_defs(body);
                self.walk_body(body);
                self.pop_scope();
            }
            Kind::Def { params, body, .. } | Kind::AsyncDef { params, body, .. } => {
                // The name being defined is bound in the ENCLOSING scope; the
                // parameters in the new one. Missing the first half was why a
                // nested `def cleanup()` used ten lines later read as unbound.
                self.bind(name_of(&n.kind));
                self.push_scope();
                for p in params {
                    match &p.ty {
                        Some(t) => self.bind_typed(&p.name, t),
                        None => self.bind(&p.name),
                    }
                    if let Some(d) = &p.default {
                        // A default is evaluated in the enclosing scope, but
                        // binding first is harmless: names are only reported
                        // when bound NOWHERE.
                        self.walk(d);
                    }
                }
                self.bind_local_defs(body);
                self.walk_body(body);
                self.pop_scope();
            }
            Kind::Method {
                params, body, ..
            } => {
                self.push_scope();
                for p in params {
                    match &p.ty {
                        Some(t) => self.bind_typed(&p.name, t),
                        None => self.bind(&p.name),
                    }
                }
                self.bind_local_defs(body);
                self.walk_body(body);
                self.pop_scope();
            }
            Kind::Class { methods, body, .. } => {
                self.bind(name_of(&n.kind));
                self.push_scope();
                self.bind("self");
                self.walk_body(methods);
                self.walk_body(body);
                self.pop_scope();
            }
            Kind::DecoratedDef { decorators, inner } => {
                for d in decorators {
                    // A decorator is a bare name (or dotted path) that must
                    // resolve; the parser stores it as text.
                    let head = d.split('.').next().unwrap_or(d);
                    self.check_name_use(head, n.line, n.col);
                }
                self.walk(inner);
            }
            Kind::Assign { target, value } => {
                self.walk(value);
                self.bind_target(target);
            }
            Kind::AugAssign { target, value, .. } => {
                self.walk(value);
                // `x += 1` reads and writes; a target read is checked.
                self.walk_read_target(target);
                self.bind_target(target);
            }
            Kind::ChainedAssign { targets, value } => {
                self.walk(value);
                for t in targets {
                    self.bind_target(t);
                }
            }
            Kind::TupleAssign { targets, value } => {
                self.walk(value);
                for t in targets {
                    self.bind_target(t);
                }
            }
            Kind::Return(v) => {
                if let Some(v) = v {
                    self.walk(v);
                }
            }
            Kind::ExprStmt(e) => self.walk(e),
            Kind::If { test, body, orelse } => {
                self.walk(test);
                self.walk_scoped(body);
                if let Some(o) = orelse {
                    self.walk_scoped(o);
                }
            }
            Kind::While { test, body } => {
                self.walk(test);
                self.walk_scoped(body);
            }
            Kind::For { target, iter, body } => {
                self.walk(iter);
                self.push_scope();
                self.bind(target);
                self.bind_local_defs(body);
                self.walk_body(body);
                self.pop_scope();
            }
            Kind::Try {
                body,
                handlers,
                orelse,
                finally,
            } => {
                self.walk_scoped(body);
                for h in handlers {
                    self.push_scope();
                    if let Some(c) = &h.class {
                        let head = c.split('.').next().unwrap_or(c);
                        self.check_name_use(head, n.line, n.col);
                    }
                    if let Some(nm) = &h.name {
                        self.bind(nm);
                    }
                    self.bind_local_defs(&h.body);
                    self.walk_body(&h.body);
                    self.pop_scope();
                }
                if let Some(o) = orelse {
                    self.walk_scoped(o);
                }
                if let Some(f) = finally {
                    self.walk_scoped(f);
                }
            }
            Kind::Assert { test, message } => {
                self.walk(test);
                if let Some(m) = message {
                    self.walk(m);
                }
            }
            Kind::Raise(v) => {
                if let Some(v) = v {
                    self.walk(v);
                }
            }
            Kind::Yield(v) => {
                if let Some(v) = v {
                    self.walk(v);
                }
            }
            Kind::Export(inner) | Kind::ExportDefault(inner) => self.walk(inner),
            Kind::Tree { head, body } => {
                self.walk_tree_head(head);
                self.walk_body(body);
            }
            Kind::Match { subject, cases } => {
                self.walk(subject);
                for CaseArm { pattern, body } in cases {
                    self.push_scope();
                    self.bind_pattern(pattern);
                    self.walk_body(body);
                    self.pop_scope();
                }
            }
            Kind::Lambda {
                params,
                defaults,
                body,
            } => {
                self.push_scope();
                for p in params {
                    self.bind(p);
                }
                for d in defaults.iter().flatten() {
                    self.walk(d);
                }
                self.walk(body);
                self.pop_scope();
            }
            Kind::Comprehension {
                expr,
                target,
                iter,
                cond,
            } => {
                self.walk(iter);
                self.push_scope();
                self.bind(target);
                self.walk(expr);
                if let Some(c) = cond {
                    self.walk(c);
                }
                self.pop_scope();
            }
            Kind::DictComprehension {
                key,
                value,
                target,
                iter,
                cond,
            } => {
                self.walk(iter);
                self.push_scope();
                self.bind(target);
                self.walk(key);
                self.walk(value);
                if let Some(c) = cond {
                    self.walk(c);
                }
                self.pop_scope();
            }
            Kind::SetComprehension {
                expr,
                target,
                iter,
                cond,
            } => {
                self.walk(iter);
                self.push_scope();
                self.bind(target);
                self.walk(expr);
                if let Some(c) = cond {
                    self.walk(c);
                }
                self.pop_scope();
            }
            Kind::Walrus { name, value } => {
                self.walk(value);
                self.bind(name);
            }
            Kind::FString(parts) => {
                for p in parts {
                    if let FPart::Expr { value, .. } = p {
                        self.walk(value);
                    }
                }
            }
            Kind::Str { .. }
            | Kind::Num(_)
            | Kind::Bool(_)
            | Kind::Null
            | Kind::Pass
            | Kind::Break
            | Kind::Continue
            | Kind::Super
            | Kind::TemplateLiteral(_)
            | Kind::RawTS(_)
            | Kind::Import { .. }
            | Kind::Interface { .. }
            | Kind::TypeAlias { .. } => {}
            Kind::Name(name) => self.check_name_use(name, n.line, n.col),
            Kind::Attr { obj, name } => {
                self.check_member(obj, name, n.line, n.col);
                self.walk(obj);
            }
            Kind::OptAttr { obj, .. } | Kind::OptIndex { obj, .. } => self.walk(obj),
            Kind::Index { obj, index } => {
                self.walk(obj);
                self.walk(index);
            }
            Kind::Bin { left, right, .. } => {
                self.walk(left);
                self.walk(right);
            }
            Kind::Unary { operand, .. } => self.walk(operand),
            Kind::Ternary {
                test,
                body,
                orelse,
            } => {
                self.walk(test);
                self.walk(body);
                self.walk(orelse);
            }
            Kind::List(xs) | Kind::Tuple(xs) => {
                for x in xs {
                    self.walk(x);
                }
            }
            Kind::Dict(pairs) => {
                for (k, v) in pairs {
                    if let Some(k) = k {
                        self.walk(k);
                    }
                    self.walk(v);
                }
            }
            Kind::Spread(e) | Kind::Await(e) | Kind::New(e) | Kind::DynamicImport(e) => {
                self.walk(e)
            }
            Kind::Call { func, args, kwargs } | Kind::OptCall { func, args, kwargs } => {
                // `div(cls="x")` with no block is a JSX element, not a call:
                // `div` is an HTML tag the emitter recognises, not a name that
                // must resolve. An uppercase callee is a real call to a
                // component, and its name is checked.
                if crate::emitter::Emitter::is_element(func) {
                    self.walk_tree_head(func);
                } else {
                    self.walk(func);
                }
                for a in args {
                    self.walk(a);
                }
                for (_, v) in kwargs {
                    self.walk(v);
                }
            }
            Kind::Slice {
                obj,
                start,
                stop,
                step,
            } => {
                self.walk(obj);
                for x in [start, stop, step].into_iter().flatten() {
                    self.walk(x);
                }
            }
            Kind::ChainedCompare { operands, .. } => {
                for o in operands {
                    self.walk(o);
                }
            }
            Kind::Contains {
                item,
                container,
                ..
            } => {
                self.walk(item);
                self.walk(container);
            }
        }
    }

    /// The head of a `tag:` block is an element name when it is a plain
    /// lowercase HTML tag, or a component when it starts with a capital. Only
    /// the second form refers to something that must exist.
    fn walk_tree_head(&mut self, head: &Node) {
        match &head.kind {
            Kind::Name(id) => {
                if starts_component(id) {
                    self.check_name_use(id, head.line, head.col);
                }
            }
            Kind::Call { func, args, kwargs } => {
                if let Kind::Name(id) = &func.kind {
                    if starts_component(id) {
                        self.check_name_use(id, func.line, func.col);
                    }
                }
                self.walk_tree_head(func);
                for a in args {
                    self.walk(a);
                }
                for (_, v) in kwargs {
                    self.walk(v);
                }
            }
            Kind::Attr { obj, .. } => self.walk(obj),
            _ => self.walk(head),
        }
    }

    fn check_name_use(&mut self, name: &str, line: usize, col: usize) {
        if name == "_" || name.is_empty() || self.is_bound(name) {
            return;
        }
        let hint = if name.contains('_') {
            let camel = to_camel(name);
            if camel != name {
                Some(format!("did you mean `{}`?", camel))
            } else {
                None
            }
        } else {
            let snake = to_snake(name);
            if snake != name {
                Some(format!("did you mean `{}`?", snake))
            } else {
                None
            }
        };
        self.warn(
            format!("unbound:{name}"),
            format!("`{name}` is used but never bound"),
            line,
            col,
            hint,
        );
    }

    /// `user.profile.name` — report a member the declared interface lacks.
    fn check_member(&mut self, obj: &Node, member: &str, line: usize, col: usize) {
        let Kind::Name(base) = &obj.kind else {
            return;
        };
        let Some(ty) = self.type_of(base) else {
            return;
        };
        let Some(iface) = self.interface_members(&ty) else {
            return;
        };
        if iface.contains(member) {
            return;
        }
        // A member list read from a local declaration only. Report once per
        // (base, member) so a repeated mistake does not repeat.
        self.warn(
            format!("member:{base}.{member}"),
            format!("`{ty}` has no member `{member}` (used as `{base}.{member}`)"),
            line,
            col,
            Some(format!(
                "known members: {}",
                sorted_join(&self.interface_members(&ty).unwrap_or_default())
            )),
        );
    }

    /// Members of `ty`, following one level of interface inheritance. `None`
    /// means the type is unknown or was not parsed cleanly.
    fn interface_members(&self, ty: &str) -> Option<HashSet<String>> {
        let iface = self.interfaces.get(ty)?;
        let mut out = iface.members.clone();
        if let Some(parent) = self.parents.get(ty) {
            if let Some(p) = self.interfaces.get(parent) {
                out.extend(p.members.iter().cloned());
            }
        }
        Some(out)
    }

    fn bind_target(&mut self, target: &Node) {
        match &target.kind {
            Kind::Name(n) => self.bind(n),
            Kind::Tuple(xs) | Kind::List(xs) => {
                for x in xs {
                    self.bind_target(x);
                }
            }
            Kind::Attr { .. } | Kind::OptAttr { .. } | Kind::Index { .. } | Kind::OptIndex { .. } => {
                // Assigning to a member mutates something that already exists,
                // and this check does not track object shapes.
            }
            _ => self.walk(target),
        }
    }

    /// A target that is read before being written (`x += 1`), where a missing
    /// binding is a real mistake.
    fn walk_read_target(&mut self, target: &Node) {
        match &target.kind {
            Kind::Name(n) => {
                let (l, c) = (target.line, target.col);
                self.check_name_use(n, l, c);
            }
            Kind::Index { obj, index } => {
                self.walk(obj);
                self.walk(index);
            }
            Kind::Attr { obj, .. } => self.walk(obj),
            Kind::Tuple(xs) | Kind::List(xs) => {
                for x in xs {
                    self.walk_read_target(x);
                }
            }
            _ => self.walk(target),
        }
    }

    fn bind_pattern(&mut self, pattern: &Node) {
        match &pattern.kind {
            Kind::Name(n) => self.bind(n),
            Kind::Tuple(xs) | Kind::List(xs) => {
                for x in xs {
                    self.bind_pattern(x);
                }
            }
            Kind::Dict(pairs) => {
                for (_, v) in pairs {
                    self.bind_pattern(v);
                }
            }
            _ => {}
        }
    }
}

/// Public entry: check a parsed module.
pub fn check(module: &Node) -> Vec<Warning> {
    Checker::new().check_module(module)
}

/// The name a definition binds, from its own kind.
fn name_of(kind: &Kind) -> &str {
    match kind {
        Kind::Def { name, .. }
        | Kind::Component { name, .. }
        | Kind::AsyncDef { name, .. }
        | Kind::Class { name, .. } => name,
        _ => "",
    }
}

fn collect_assign_targets(target: &Node, out: &mut HashSet<String>) {
    match &target.kind {
        Kind::Name(n) => {
            out.insert(n.clone());
        }
        Kind::Tuple(xs) | Kind::List(xs) => {
            for x in xs {
                collect_assign_targets(x, out);
            }
        }
        _ => {}
    }
}

/// A tree head is a component when it starts uppercase; `div` and `span` are
/// HTML elements and are not names that must resolve.
fn starts_component(id: &str) -> bool {
    id.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

fn to_camel(s: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for ch in s.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn to_snake(s: &str) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.extend(ch.to_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn sorted_join(set: &HashSet<String>) -> String {
    let mut v: Vec<&String> = set.iter().collect();
    v.sort();
    let mut s: BTreeMap<&String, ()> = BTreeMap::new();
    for x in v {
        s.insert(x, ());
    }
    s.keys()
        .map(|k| k.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Read `name: type` lines out of an interface body.
///
/// Returns `None` when the body contains anything this simple reader cannot
/// account for — a computed key, an index signature, a union, a spread. In that
/// case the interface's members are never checked, which is the correct
/// failure direction: silence, not a wrong warning.
fn parse_interface_members(raw: &str) -> Option<HashSet<String>> {
    let body = strip_outer_braces(raw);
    if body.contains('[') && body.contains("]:") {
        return None; // index signature
    }
    if body.contains('&') || body.contains("extends ") {
        return None; // intersection or an inherited shape this cannot resolve
    }
    let mut out = HashSet::new();
    for line in body.split(['\n', ';', ',']) {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") || line.starts_with("/*") {
            continue;
        }
        let line = line.trim_end_matches(',').trim();
        let Some((name, _ty)) = line.split_once(':') else {
            return None; // not a `name: type` member
        };
        let name = name.trim().trim_end_matches('?').trim();
        let name = name.trim_start_matches("readonly ").trim();
        if name.is_empty() || !is_ident(name) {
            return None;
        }
        out.insert(name.to_string());
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

fn parse_interface_parent(raw: &str) -> Option<String> {
    let head = raw.trim();
    let head = head.trim_start_matches('{').trim();
    let idx = head.find('(')?;
    let after = &head[idx + 1..];
    let end = after.find(')')?;
    let parent = after[..end].trim();
    if is_ident(parent) {
        Some(parent.to_string())
    } else {
        None
    }
}

fn strip_outer_braces(raw: &str) -> String {
    let t = raw.trim();
    if let Some(inner) = t.strip_prefix('{') {
        if let Some(inner) = inner.strip_suffix('}') {
            return inner.to_string();
        }
    }
    t.to_string()
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

const PYTHON_BUILTINS: &[&str] = &[
    // Verified by `python_builtins_are_all_honoured`: each of these compiles to
    // JavaScript, or to a name the emitter also imports from 'hydra'.
    "abs", "bool", "len", "list", "max", "min", "pow", "print", "reversed", "round", "sorted",
    "str", "sum", "int", "float", "isinstance", "enumerate", "range", "zip",
    // Bare names that are always legal here, not builtins.
    "self", "cls",
];

const BROWSER_GLOBALS: &[&str] = &[
    "AbortController",
    "AbortSignal",
    "Array",
    "ArrayBuffer",
    "Audio",
    "Blob",
    "Boolean",
    "CSS",
    "CustomEvent",
    "DOMParser",
    "DataView",
    "Date",
    "Document",
    "Element",
    "Error",
    "EvalError",
    "Event",
    "EventSource",
    "EventTarget",
    "File",
    "FileList",
    "FileReader",
    "FormData",
    "Function",
    "Headers",
    "History",
    "HTMLElement",
    "Image",
    "Infinity",
    "IntersectionObserver",
    "Intl",
    "JSON",
    "KeyboardEvent",
    "Location",
    "Map",
    "Math",
    "MouseEvent",
    "MutationObserver",
    "NaN",
    "Navigator",
    "Node",
    "Number",
    "Object",
    "PerformanceObserver",
    "PointerEvent",
    "Promise",
    "Proxy",
    "RangeError",
    "ReferenceError",
    "Reflect",
    "RegExp",
    "Request",
    "ResizeObserver",
    "Response",
    "Set",
    "ShadowRoot",
    "String",
    "Symbol",
    "SyntaxError",
    "TextDecoder",
    "TextEncoder",
    "TouchEvent",
    "TypeError",
    "URIError",
    "URL",
    "URLSearchParams",
    "WeakMap",
    "WeakSet",
    "WebSocket",
    "WheelEvent",
    "Worker",
    "alert",
    "atob",
    "btoa",
    "cancelAnimationFrame",
    "clearInterval",
    "clearTimeout",
    "confirm",
    "console",
    "crypto",
    "decodeURI",
    "decodeURIComponent",
    "devicePixelRatio",
    "document",
    "encodeURI",
    "encodeURIComponent",
    "fetch",
    "getComputedStyle",
    "globalThis",
    "history",
    "innerHeight",
    "innerWidth",
    "isFinite",
    "isNaN",
    "localStorage",
    "location",
    "matchMedia",
    "navigator",
    "parseFloat",
    "parseInt",
    "performance",
    "prompt",
    "queueMicrotask",
    "requestAnimationFrame",
    "screen",
    "scrollTo",
    "sessionStorage",
    "setInterval",
    "setTimeout",
    "structuredClone",
    "undefined",
    "window",
];



#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::Kind;

    /// Parse a source the way the compiler does and run the checker.
    fn warn(src: &str) -> Vec<Warning> {
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        let toks = crate::lexer::lex(src).expect("lex");
        let module = crate::parser::Parser::new(toks, lines).module().expect("parse");
        check(&module)
    }

    fn msgs(src: &str) -> Vec<String> {
        warn(src).into_iter().map(|w| w.message).collect()
    }

    #[test]
    fn unbound_name_is_reported() {
        let m = msgs("component A():\n    div:\n        span: total_price\n");
        assert_eq!(m.len(), 1, "{m:?}");
        assert!(m[0].contains("total_price"), "{m:?}");
    }

    #[test]
    fn unbound_name_suggests_camel_case() {
        let w = warn("component A():\n    div:\n        span: total_price\n");
        assert!(w[0].hint.as_deref().unwrap_or("").contains("totalPrice"), "{w:?}");
    }

    #[test]
    fn params_and_locals_are_bound() {
        let m = msgs("component A(title: str, n: int):\n    x = n + 1\n    div:\n        span: title\n        span: x\n");
        assert!(m.is_empty(), "{m:?}");
    }

    #[test]
    fn nested_def_may_be_used_below() {
        // The portfolio's pattern: `def cleanup():` inside an `if`, returned
        // below. A checker that flags this gets switched off.
        let src = "component A():\n    if True:\n        def cleanup():\n            pass\n        return cleanup\n";
        assert!(msgs(src).is_empty(), "{:?}", msgs(src));
    }

    #[test]
    fn for_target_and_comprehension_vars_are_bound() {
        let src = "component A(xs: list):\n    for x in xs:\n        y = x + 1\n    zs = [x * 2 for x in xs]\n    div: \"ok\"\n";
        assert!(msgs(src).is_empty(), "{:?}", msgs(src));
    }

    #[test]
    fn html_tag_is_not_a_name_use() {
        let src = "component A():\n    div(cls=\"x\")\n    div:\n        span(cls=\"y\")\n        h1: \"t\"\n";
        assert!(msgs(src).is_empty(), "{:?}", msgs(src));
    }

    #[test]
    fn component_element_must_resolve() {
        let m = msgs("component A():\n    div:\n        Missing(): \"x\"\n");
        assert_eq!(m.len(), 1, "{m:?}");
        assert!(m[0].contains("Missing"), "{m:?}");
    }

    #[test]
    fn runtime_helpers_need_no_import() {
        // `capitalize` is injected from 'hydra' automatically.
        let src = "component A(s: str):\n    div:\n        span: capitalize(s)\n";
        assert!(msgs(src).is_empty(), "{:?}", msgs(src));
    }

    #[test]
    fn browser_globals_need_no_import() {
        let src = "component A():\n    def go():\n        window.scrollTo(0, 0)\n        console.log(\"x\")\n    div: \"ok\"\n";
        assert!(msgs(src).is_empty(), "{:?}", msgs(src));
    }

    #[test]
    fn missing_interface_member_is_reported() {
        let src = "interface Props:\n    title: str\n    count: int\n\ncomponent A(p: Props):\n    div:\n        span: p.titel\n";
        let w = warn(src);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].message.contains("titel"), "{w:?}");
        let hint = w[0].hint.as_deref().unwrap_or("");
        assert!(hint.contains("title") && hint.contains("count"), "{hint}");
    }

    #[test]
    fn present_member_is_not_reported() {
        let src = "interface Props:\n    title: str\n\ncomponent A(p: Props):\n    div:\n        span: p.title\n";
        assert!(msgs(src).is_empty(), "{:?}", msgs(src));
    }

    #[test]
    fn member_of_unknown_type_is_not_reported() {
        // `p` has no declared type, so nothing can be said about its members.
        let src = "component A(p):\n    div:\n        span: p.anything\n";
        assert!(msgs(src).is_empty(), "{:?}", msgs(src));
    }

    #[test]
    fn complicated_interface_is_skipped_not_guessed() {
        // An index signature means the member list is incomplete, so the check
        // must stay silent rather than report every dynamic key.
        let src = "interface Bag:\n    [key: str]: any\n\ncomponent A(b: Bag):\n    div:\n        span: b.mystery\n";
        assert!(msgs(src).is_empty(), "{:?}", msgs(src));
    }

    #[test]
    fn one_mistake_is_reported_once() {
        let src = "component A():\n    div:\n        span: oops\n        span: oops\n        span: oops\n";
        assert_eq!(msgs(src).len(), 1, "{:?}", msgs(src));
    }

    #[test]
    fn findings_carry_a_usable_position() {
        let w = warn("component A():\n    div:\n        span: nope\n");
        assert_eq!(w[0].line, 3, "{w:?}");
        assert!(w[0].col > 0, "{w:?}");
    }

    /// The helper list is generated from `runtime/hydra.ts` by `build.rs`, which
    /// already fails the build if the scan finds too few names. This checks the
    /// generated table actually arrived, since an empty or stale one would make
    /// every runtime helper read as an unbound name.
    #[test]
    fn generated_helper_list_is_intact() {
        assert!(
            RUNTIME_HELPERS.len() > 100,
            "generated helper list has only {} names; the build script is not running",
            RUNTIME_HELPERS.len()
        );
        for must in ["capitalize", "state", "use_path", "len_of", "contains", "cx"] {
            assert!(
                is_runtime_helper(must),
                "`{must}` is exported by runtime/hydra.ts but missing from the generated list"
            );
        }
        // A name the runtime does not export must not be treated as a helper.
        assert!(!is_runtime_helper("definitely_not_a_helper"));
    }

    /// Every name in `PYTHON_BUILTINS` must actually be honoured by the
    /// compiler. A name that is neither lowered nor imported emits as a bare
    /// identifier, which is a `ReferenceError` at runtime — and worse, the
    /// checker would then stay silent about it precisely because the name is on
    /// this list. This test is what stops the list from becoming a lie.
    #[test]
    fn python_builtins_are_all_honoured() {
        // One use per name, in call position where that is how it is used.
        let uses: &[(&str, &str)] = &[
            ("abs", "abs(-1)"),
            ("bool", "bool(x)"),
            ("len", "len(xs)"),
            ("list", "list(xs)"),
            ("max", "max(a, b)"),
            ("min", "min(a, b)"),
            ("pow", "pow(a, b)"),
            ("print", "print(x)"),
            ("reversed", "reversed(xs)"),
            ("round", "round(a)"),
            ("sorted", "sorted(xs)"),
            ("str", "str(x)"),
            ("sum", "sum(xs)"),
            ("int", "int(x)"),
            ("float", "float(x)"),
            ("isinstance", "isinstance(x, Number)"),
            ("enumerate", "enumerate(xs)"),
            ("range", "range(3)"),
            ("zip", "zip(xs, ys)"),
            ("self", "self"),
            ("cls", "cls"),
        ];
        // The case table and the list must agree in BOTH directions, or the
        // test silently stops covering a name.
        for (name, _) in uses {
            assert!(
                is_python_builtin(name),
                "`{name}` is exercised here but missing from PYTHON_BUILTINS"
            );
        }
        for name in PYTHON_BUILTINS {
            assert!(
                uses.iter().any(|(n, _)| n == name),
                "`{name}` is in PYTHON_BUILTINS but no case exercises it, so nothing \
                 proves it is honoured"
            );
        }
        for (name, expr) in uses {
            assert!(
                is_python_builtin(name),
                "`{name}` is exercised by this test but missing from PYTHON_BUILTINS"
            );
            let src = format!(
                "component A(x, a, b, xs, ys, f, Number):\n    r = {expr}\n    div: \"ok\"\n"
            );
            let out = match crate::compile(&src, "t.hyx") {
                Ok((code, _)) => code,
                Err(e) => panic!("compiling `{expr}` failed: {}", e.pretty()),
            };
            // Honoured = the bare identifier was replaced, or imported.
            let replaced = !out.contains(&format!(" {name}("))
                && !out.contains(&format!("= {name};"))
                && !out.contains(&format!("return {name}"));
            let imported = out.contains(&format!("import {{ {name} }} from 'hydra'"));
            let is_literal_name = *name == "self" || *name == "cls";
            assert!(
                replaced || imported || is_literal_name,
                "`{expr}` emitted `{name}` verbatim with no import from 'hydra', \
                 so it is a ReferenceError at runtime while the checker stays silent.\n\
                 Emitted:\n{out}"
            );
        }
    }

    /// The specific bug that motivated the rule: `getattr` looked like a
    /// builtin, so a call to it was accepted and emitted verbatim.
    #[test]
    fn getattr_is_reported_not_silently_emitted() {
        let m = msgs("def f(obj):\n    x = getattr(obj, \"k\", 0)\n    return x\n");
        assert_eq!(m.len(), 1, "{m:?}");
        assert!(m[0].contains("getattr"), "{m:?}");
    }

    #[test]
    fn empty_module_is_fine() {
        assert!(msgs("").is_empty());
    }

    #[test]
    fn tree_head_component_is_checked() {
        let src = "component A():\n    Ghost:\n        span: \"x\"\n";
        let m = msgs(src);
        assert_eq!(m.len(), 1, "{m:?}");
        assert!(m[0].contains("Ghost"), "{m:?}");
    }

    #[test]
    fn name_of_reads_the_definition_kinds() {
        assert_eq!(name_of(&Kind::Def { name: "f".into(), params: vec![], body: vec![] }), "f");
        assert_eq!(name_of(&Kind::Pass), "");
    }
}
