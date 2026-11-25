//! Construction, scopes, and the write buffer.

use crate::emitter::Scope;

use super::*;


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
            import_specs: std::cell::RefCell::new(std::collections::HashMap::new()),
            base_dir: None,
        }
    }

    pub fn with_base_dir(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.base_dir = Some(dir.into());
        self
    }

    pub(super) fn pad(&self) -> String {
        "  ".repeat(self.depth)
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
    pub(super) fn hoist_nested(&mut self, scope: Scope) {
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
    pub(super) fn push_scope_js(&mut self, mut scope: Scope) {
        let mut bound = std::collections::HashSet::new();
        for s in &self.scopes {
            bound.extend(s.params.iter().cloned());
            bound.extend(s.declared.iter().cloned());
            bound.extend(s.assigned_anywhere.iter().cloned());
        }
        scope.outer_bound = bound;
        self.scopes.push(scope);
    }
}
