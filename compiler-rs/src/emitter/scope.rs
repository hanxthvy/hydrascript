//! Scope: what a name means where, and who writes what.
use std::collections::{HashMap, HashSet};

use crate::ast::{Kind, Node};


#[derive(Default, Debug, Clone)]
pub struct Scope {
    /// Names introduced by the function signature itself. They are already
    /// declared by the time the body runs, so re-declaring one (`let [a, b] = ...`
    /// inside a function that takes `a, b`) is a SyntaxError.
    pub params: HashSet<String>,
    /// Whether each name needs `let` rather than `const`. A `let` is required when
    /// the name is assigned more than once, is the target of `+=`, or is written
    /// from inside a nested function. This is the ONE thing the `.hys` emitter
    /// (hx_target.rs) needs from the scope; the other fields below exist for the
    /// `.hyx` emitter's tree/component handling.
    pub mutable: HashSet<String>,
    pub assign_counts: HashMap<String, usize>,
    pub aug_assigned: HashSet<String>,
    /// Names assigned from inside a nested function in this body.
    ///
    /// A closure that writes to an enclosing binding (`clock += dt` inside an effect)
    /// forces that binding to stay mutable, or the emitted `const clock = 0;` is a
    /// "Cannot assign to a constant" build error. Collected separately from
    /// `assign_counts` because the write does not happen in THIS scope's statement
    /// list.
    pub nested_assigned: HashSet<String>,
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
    /// Every name already bound by the scopes on the stack when this one was
    /// pushed — params, declarations and assignments of every enclosing scope.
    ///
    /// Filled by `push_scope`. It answers one question at a plain assignment: is
    /// this a NEW binding, or a write to something an enclosing scope already
    /// owns? Getting that wrong emitted a shadowing `const` and put the real
    /// variable in the temporal dead zone.
    pub outer_bound: HashSet<String>,
}

impl Scope {
    pub fn scan(body: &[Node]) -> Self {
        let mut scope = Scope::default();
        scope.scan_nodes(body);
        scope
    }

    fn scan_nodes(&mut self, nodes: &[Node]) {
        self.scan_at(nodes, 0);
        // Names this body's statements write, but only from inside a nested function:
        // a closure capture. Including the body's OWN assignments here made every
        // `x = 1` look captured and promoted it to `let` (the `const` tests caught it);
        // excluding them keeps a module-level `maskCount = 0` mutable when a component
        // callback does `maskCount += 1`.
        collect_closure_writes(nodes, &mut self.nested_assigned);

        // `.hys` needs one thing from this scan: which names need `let`. Fill it
        // here so hx_target.rs does not have to duplicate the scan.
        for n in self.assigned_anywhere.iter() {
            let banyak = self.assign_counts.get(n).copied().unwrap_or(0) > 1;
            if banyak || self.aug_assigned.contains(n) || self.nested_assigned.contains(n) {
                self.mutable.insert(n.clone());
            }
        }
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
                // A nested function is its own scope for its own bindings, but a
                // write to a name from the enclosing scope is a closure capture, and
                // the enclosing binding has to stay mutable.
                Kind::Def { body, .. } | Kind::AsyncDef { body, .. } => {
                    let mut freed = HashSet::new();
                    collect_assigned(body, &mut freed);
                    self.nested_assigned.extend(freed);
                }
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
        if self.assign_counts.get(id).copied().unwrap_or(0) > 1 || self.aug_assigned.contains(id) {
            return true;
        }
        // A binding this scope declares and a nested function writes to must be `let`.
        self.nested_assigned.contains(id)
            && (self.params.contains(id) || self.assign_counts.contains_key(id))
    }

    /// Does any scope ENCLOSING the innermost one already bind this name?
    ///
    /// If it does, an assignment in the innermost scope is a write to that outer
    /// binding, not a new declaration. Emitting `const x = ...` there created a
    /// shadowing binding: the outer variable kept its old value, the inner one sat
    /// in the temporal dead zone, and the next read threw
    /// `Cannot access 'x' before initialization`. That single mistake accounted for
    /// the largest class of blank cards in the React Bits port — an effect would
    /// call `start()` and `start` would assign the effect-local `raf` instead of the
    /// one the animation loop reads.
    ///
    /// The enclosing scopes are the ones below the top of the stack; the innermost
    /// scope is excluded because a name it binds is this statement's own binding.
    pub fn bound_in_enclosing(&self, id: &str) -> bool {
        self.outer_bound.contains(id)
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
            // A name the signature already binds is declared by the parameter list;
            // hoisting it again emitted `function f(el) { let el; ... }`, a
            // "symbol has already been declared" build error.
            .filter(|n| !self.params.contains(*n))
            // A name an ENCLOSING scope already binds is a closure capture, not a
            // local. Hoisting it here declared a fresh local and cut the outer
            // binding off: `GlassIcons` has `let raf = 0` in the component body and
            // `raf = requestAnimationFrame(tick)` inside `wake()`, and the hoist made
            // `wake` emit `let raf; raf = requestAnimationFrame(tick)` — a local
            // variable, so the outer `raf` stayed 0, `cancelAnimationFrame(0)` ran on
            // every teardown, and the animation never started at all. Silent: the
            // page rendered, nothing threw.
            //
            // This is the same rule the `Kind::Assign` arm already applies via
            // `bound_in_enclosing`; the hoist was the one place that ignored it.
            .filter(|n| !self.outer_bound.contains(*n))
            .filter(|n| self.first_assign_depth.get(*n).copied().unwrap_or(0) > 0)
            .cloned()
            .collect();
        v.sort();
        v
    }
}

/// Every name assigned anywhere inside `nodes`, including nested functions.
///
/// Used to tell a closure's captures from its own bindings: a name the body assigns is
/// either local to it or captured from an enclosing scope, and only the enclosing
/// scope can decide which — so the set is handed up and filtered there.
pub(super) fn collect_assigned(nodes: &[Node], out: &mut HashSet<String>) {
    for s in nodes {
        match &s.kind {
            Kind::Assign { target, .. } => {
                if let Kind::Name(id) = &target.kind {
                    out.insert(id.clone());
                }
            }
            Kind::AugAssign { target, .. } => {
                if let Kind::Name(id) = &target.kind {
                    out.insert(id.clone());
                }
            }
            Kind::TupleAssign { targets, .. } | Kind::ChainedAssign { targets, .. } => {
                for t in targets {
                    if let Kind::Name(id) = &t.kind {
                        out.insert(id.clone());
                    }
                }
            }
            Kind::If { body, orelse, .. } => {
                collect_assigned(body, out);
                if let Some(o) = orelse {
                    collect_assigned(o, out);
                }
            }
            Kind::For { body, .. } | Kind::While { body, .. } => collect_assigned(body, out),
            Kind::Try { body, handlers, orelse, finally } => {
                collect_assigned(body, out);
                for h in handlers {
                    collect_assigned(&h.body, out);
                }
                if let Some(o) = orelse {
                    collect_assigned(o, out);
                }
                if let Some(f) = finally {
                    collect_assigned(f, out);
                }
            }
            Kind::Match { cases, .. } => {
                for c in cases {
                    collect_assigned(&c.body, out);
                }
            }
            Kind::Def { body, .. } | Kind::AsyncDef { body, .. } => collect_assigned(body, out),
            _ => {}
        }
    }
}

/// Every name written by a function nested inside `nodes`, but none written by
/// `nodes`' own statements.
///
/// This is the closure-capture test: a name in here that the enclosing scope also
/// declares (or takes as a parameter) has to stay mutable, or the emitted `const`
/// makes the closure's write a build error. Names the enclosing body assigns itself
/// are deliberately absent — those are ordinary locals.
pub(super) fn collect_closure_writes(nodes: &[Node], out: &mut HashSet<String>) {
    for s in nodes {
        match &s.kind {
            // A component IS a nested function: its body runs later, so a name it
            // writes from an inner callback is a closure capture of the enclosing
            // (module) scope. Missing this arm left a module-level `maskCount = 0`
            // emitted as `const` while a component's callback did `maskCount += 1`
            // ("Cannot assign to maskCount because it is a constant").
            Kind::Def { body, .. } | Kind::AsyncDef { body, .. } | Kind::Component { body, .. } => {
                collect_assigned(body, out);
            }
            Kind::If { body, orelse, .. } => {
                collect_closure_writes(body, out);
                if let Some(o) = orelse {
                    collect_closure_writes(o, out);
                }
            }
            Kind::For { body, .. } | Kind::While { body, .. } => collect_closure_writes(body, out),
            Kind::Try { body, handlers, orelse, finally } => {
                collect_closure_writes(body, out);
                for h in handlers {
                    collect_closure_writes(&h.body, out);
                }
                if let Some(o) = orelse {
                    collect_closure_writes(o, out);
                }
                if let Some(f) = finally {
                    collect_closure_writes(f, out);
                }
            }
            Kind::Match { cases, .. } => {
                for c in cases {
                    collect_closure_writes(&c.body, out);
                }
            }
            _ => {}
        }
    }
}
