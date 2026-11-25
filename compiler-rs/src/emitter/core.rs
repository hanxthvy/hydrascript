//! Construction, scopes, and the three entry points.
use std::collections::HashSet;

use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;

use super::*;
use super::element::node_uses_slot;
use super::imports::import_shapes_as_default;
use super::sourcemap::serde_json_escape;

impl Emitter {
    pub fn new() -> Self {
        Self {
            lines: Vec::new(),
            linemap: Vec::new(),
            cur_src: 1,
            depth: 0,
            imports: HashSet::new(),
            used_helpers: std::cell::RefCell::new(HashSet::new()),
            refresh_boundary: false,
            fn_params: std::cell::RefCell::new(std::collections::HashMap::new()),
            walrus_names: std::cell::RefCell::new(HashSet::new()),
            class_names: std::cell::RefCell::new(std::collections::HashSet::new()),
            head_lines: Vec::new(),
            imported_names: std::cell::RefCell::new(HashSet::new()),
            import_specs: std::cell::RefCell::new(std::collections::HashMap::new()),
            exported_decls: std::cell::RefCell::new(Vec::new()),
            scopes: Vec::new(),
            tmp_counter: 0,
            base_dir: None,
        }
    }

    /// Point the emitter at the file's directory so it can resolve relative
    /// imports and tell a named export from a default-only module.
    pub fn with_base_dir(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.base_dir = Some(dir.into());
        self
    }

    /// The name after `new`.
    ///
    /// `js()` routes a capitalised callee to the JSX element path, so `new THREE.Box3()`
    /// used to print as `new <THREE.Box3 />` — a `new` with nothing to construct. After
    /// `new` the target is always a constructor, so the dotted chain is printed as the
    /// member expression it is.
    pub(super) fn ctor_name(&self, n: &Node) -> Result<String, CompileError> {
        match &n.kind {
            Kind::Attr { obj, name } => Ok(format!("{}.{}", self.ctor_name(obj)?, str_method(name))),
            // A call inside a constructor chain: `new THREE.Box3().setFromObject(o)`.
            // The intervening call must be printed here too, because its own callee is
            // a capitalised member that `js()` would take for a JSX element.
            Kind::Call { func, args, kwargs } => {
                let f = self.ctor_name(func)?;
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
                Ok(format!("{}({})", f, all.join(", ")))
            }
            _ => self.js(n),
        }
    }

    pub(super) fn pad(&self) -> String {
        "  ".repeat(self.depth)
    }

    /// A name no source binding can collide with. Used for the temporary a
    /// `try/else` needs; the counter is per-emitter so two blocks never share one.
    pub(super) fn fresh_var(&mut self, hint: &str) -> String {
        self.tmp_counter += 1;
        format!("__{}{}", hint, self.tmp_counter)
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

    pub(super) fn push_scope(&mut self, mut scope: Scope) {
        let mut bound = HashSet::new();
        for s in &self.scopes {
            bound.extend(s.params.iter().cloned());
            bound.extend(s.declared.iter().cloned());
            bound.extend(s.assigned_anywhere.iter().cloned());
        }
        scope.outer_bound = bound;
        self.scopes.push(scope);
    }

    /// Push a scope onto the stack, recording every name the enclosing scopes bind.
    ///
    /// Doing it at push time keeps a plain assignment O(1): the emitter needs to know
    /// whether `raf = ...` inside a callback creates a binding or writes the `let raf`
    /// declared by the component body, and scanning the whole stack per statement
    /// would be both slower and easier to get wrong.
    /// Does the innermost scope's enclosing chain already bind this name?
    /// Forwarded to `Scope` so the assignment path stays readable.
    pub(super) fn bound_in_enclosing(&self, id: &str) -> bool {
        self.scopes
            .last()
            .map(|s| s.bound_in_enclosing(id))
            .unwrap_or(false)
    }

    pub fn is_element(n: &Node) -> bool {
        match &n.kind {
            Kind::Name(id) => {
                if JS_BUILTIN_GLOBALS.contains(&id.as_str()) {
                    return false;
                }
                if python_base_class(id).is_some() {
                    return false;
                }
                HTML_TAGS.contains(&id.as_str())
                    || id.chars().next().map_or(false, |c| c.is_uppercase())
            }
            Kind::Attr { obj, name } => {
                if JS_BUILTIN_GLOBALS.contains(&name.as_str()) {
                    return false;
                }
                // A dotted head is an element when the MEMBER looks like a
                // component: `Tabs.List`, `motion.div`. Member case is the
                // right discriminator because it is the same rule the bare form
                // uses (`stroke_text` never became a component either).
                //
                // Deciding this on the OBJECT being uppercase was wrong and
                // silent: `SignupSchema.safeParse({...})` was emitted as the JSX
                // element `<SignupSchema.safeParse>{...}</SignupSchema.safeParse>`,
                // which drops the receiver, so `safeParse` ran with
                // `this === undefined` and threw at runtime while the build
                // reported success.
                if MEMBER_METHOD_NAMES.contains(&name.as_str()) {
                    return false;
                }
                matches!(&obj.kind, Kind::Name(_) | Kind::Attr { .. })
                    && (name.chars().next().is_some_and(|c| c.is_uppercase())
                        || HTML_TAGS.contains(&name.as_str()))
            }
            _ => false,
        }
    }

    /// Like `is_element`, but a name THIS module declares is never a tag.
    ///
    /// `main`, `header`, `footer`, `section`, `aside`, `menu` and `output` are all
    /// valid HTML tag names AND entirely reasonable function names. `is_element`
    /// alone answers "is this identifier spelled like a tag", which is right for a
    /// component reference and wrong for a call: `main()` at module level compiled
    /// to `<main />` — the call disappeared, the app rendered nothing, and no error
    /// was reported anywhere. Lowercase method names got a second list
    /// (`MEMBER_METHOD_NAMES`) years ago; this is the same class of bug for a bare
    /// name, and it is worse because a whole entry point can vanish.
    ///
    /// The knowledge needed is already collected: `fn_params` holds every top-level
    /// `def`/`export def` and `class_names` every class.
    pub fn is_element_call(&self, func: &Node) -> bool {
        if let Kind::Name(id) = &func.kind {
            // A Python exception class is called to CONSTRUCT one:
            // `raise ValueError("bad")` emitted `<ValueError>bad</ValueError>`,
            // which is a React element and not a throw. README documents both
            // `raise ValueError("x")` and `class MyError(Exception)`, so this
            // was a documented feature that silently did the wrong thing.
            if python_base_class(id).is_some() && !self.class_names.borrow().contains(id) {
                return false;
            }
            if self.fn_params.borrow().contains_key(id) {
                return false;
            }
            if self.class_names.borrow().contains(id) {
                return false;
            }
            if self.imported_names.borrow().contains(id) {
                return false;
            }
            // A Python builtin the compiler lowers is never an element, whatever
            // the capitalisation rule says. `map` and `filter` ARE real HTML tags
            // (`<map>`, `<filter>`) and `Map`/`Filter` classify as components, so
            // `map(fn, xs)` was emitted as `<map>{fn}{xs}</map>`: the receiver was
            // dropped and the mapping never happened, with a green build. The
            // lowerer below already knows the correct shape for these names.
            if PYTHON_BUILTIN_NAMES.contains(&id.as_str()) {
                return false;
            }
        }
        // A MEMBER call in expression position is almost never a tag.
        //
        // JSX allows namespaced tags (`motion.div`), so the member-name rule cannot be
        // "uppercase only" outright. But a lowercase member that happens to be an HTML
        // tag name swallows ordinary method calls: `rujukan.current.b()` — where `b` is
        // a plain accessor — compiled to `jsx(rujukan.current.b, {})`, i.e. the element
        // `<b>`, and the call and its arguments disappeared with no build error. The
        // same shape bit `z.object()`, `map()`, and now `.b()`.
        //
        // The discriminator that works for this language: a namespaced JSX tag is a
        // NAMESPACE OBJECT plus a member (`motion.div`), and trees are written with a
        // colon, not parentheses. So an explicit allowlist of component namespaces is
        // the honest rule here — anything else with a lowercase member is a call.
        if let Kind::Attr { obj, name } = &func.kind {
            const NS: &[&str] = &["motion", "m", "AnimatePresence", "styled"];
            let nama_upper = name.chars().next().map_or(false, |c| c.is_uppercase());
            let ns_terkenal = match &obj.kind {
                Kind::Name(o) => NS.contains(&o.as_str()),
                _ => false,
            };
            if nama_upper == false && ns_terkenal == false {
                return false;
            }
        }
        Self::is_element(func)
    }

    pub fn run(&mut self, module: &Node) -> Result<String, CompileError> {
        let body = match &module.kind {
            Kind::Module(stmts) => stmts,
            _ => unreachable!(),
        };

        for s in body {
            if let Kind::Import { from, names } = &s.kind {
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
        }

        // Collect every function signature first: a call may appear before the
        // `def` it refers to, and kwargs must be resolved against it.
        {
            let mut table = self.fn_params.borrow_mut();
            // Imported names count as functions of this module.
            //
            // A call to an imported helper was read as a JSX TAG, because the tag test
            // only knows what THIS file declares: `part_putar(b, "R1", 90)` inside a
            // lambda compiled to `jsx(part_putar, { ...b })` — the call and its arguments
            // DISAPPEARED, replaced by a React element. No build error. The symptom was
            // a command that silently did nothing ("dokumen board tidak sah"), which is
            // exactly the shape of bug that costs an afternoon.
            //
            // A module cannot call an imported name as a tag legitimately: JSX tags are
            // either HTML elements (lowercase, in HTML_TAGS) or components. A name
            // imported into this file and used as `f(...)` is a function call.
            for st in body {
                // Imported names go into their own set, NOT into `fn_params`.
                //
                // Putting them there with an empty parameter list made the keyword-argument
                // reordering believe `Header()` (an imported COMPONENT) took no arguments at
                // all, and every `Header(on_nav=...)` failed the build with
                // "Header() has no parameter named `on_nav`". The only question this
                // answers is "is this name a callable of this module, rather than a tag",
                // and that needs a set, not a signature table.
                if let Kind::Import { from, names } = &st.kind {
                    for n in names {
                        let bare = n.trim_start_matches("* as ").trim();
                        // Only a LOWERCASE imported name is a call. An uppercase one is a
                        // component, and `Header(on_nav=...)` must stay a JSX tag with
                        // props — registering it as a call made the build reject its
                        // `on_nav=...` as an unknown keyword. Case is exactly the
                        // distinction the language already uses everywhere else.
                        let kecil = bare.chars().next().map_or(false, |c| c.is_lowercase());
                        if !bare.is_empty() && kecil && bare != "default" {
                            self.imported_names.borrow_mut().insert(bare.to_string());
                            // Remember WHERE it came from. Only a relative
                            // specifier can be read back at emit time; a package
                            // name is recorded too so the error message can say
                            // which one it was.
                            if let Some(spec) = from {
                                self.import_specs
                                    .borrow_mut()
                                    .insert(bare.to_string(), spec.clone());
                            }
                        }
                    }
                }
            }
            for st in body {
                let mut visit = |name: &str, params: &[Param]| {
                    let names = params
                        .iter()
                        .map(|p| p.name.trim_start_matches("...").to_string())
                        .collect::<Vec<_>>();
                    table.insert(name.to_string(), names);
                };
                match &st.kind {
                    Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                        visit(name, params)
                    }
                    Kind::Export(inner) => match &inner.kind {
                        Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                            visit(name, params)
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
        }

        // Register EVERY class declared in this file BEFORE emitting anything.
        //
        // `class_names` is filled as each statement is emitted, and a class
        // declared AFTER its first use is then unknown at that use. That is how
        // a user's own `class ValidationError(Exception)` collided with the
        // runtime's exception classes: the earlier `except ValidationError:`
        // (or a `raise`) had already recorded `ValidationError` as a runtime
        // helper, the import was emitted, and the class declaration that
        // followed produced
        //     SyntaxError: Identifier 'ValidationError' has already been declared
        // — a module that does not parse. The user's class must win, so the
        // names are collected first and the shadowing is decided once.
        for s in body {
            if let Kind::Class { name, .. } = &s.kind {
                self.class_names.borrow_mut().insert(name.clone());
            }
        }

        // ponytail: single top-level scope; nested function scopes already push their own
        let top_scope = Scope::scan(body);
        self.push_scope(top_scope);

        for s in body {
            match &s.kind {
                Kind::Component { name, params, body } => {
                    self.cur_src = s.line;
                    self.component(name, params, body)?;
                    self.w("");
                }
                Kind::Import { .. } => {}
                _ => self.stmt(s)?,
            }
        }

        self.scopes.pop();

        // Inject imports for any runtime helper the source used but did not
        // import itself. `s.capitalize()` should not need the author to know
        // that `capitalize` lives in the runtime.
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
            "// GENERATED by hydra — edit the .hsx file, not this one".to_string(),
        ];
        let mut sorted_imports: Vec<_> = self.imports.iter().cloned().collect();
        sorted_imports.sort();
        head.extend(sorted_imports);
        head.push(String::new());

        // head_lines must reflect the final head; the source map indexes body
        // lines against it, so recompute after the helper injection.
        self.head_lines = head.clone();
        Ok(format!("{}\n{}", head.join("\n"), self.lines.join("\n")))
    }

    pub fn component(
        &mut self,
        name: &str,
        params: &[Param],
        body: &[Node],
    ) -> Result<(), CompileError> {
        let ps = self.format_params(params)?;
        // `slot` inside the body renders `props.children`, so a component that
        // uses it must accept the prop. Without this the emitted code
        // referenced a bare `slot` identifier that did not exist — the build
        // succeeded and the page died at render time with "slot is not defined".
        let uses_slot = body.iter().any(node_uses_slot);
        let arg = if params.is_empty() {
            if uses_slot {
                "{ children }: { children?: React.ReactNode }".to_string()
            } else {
                String::new()
            }
        } else if uses_slot {
            // `children` must appear in the DESTRUCTURING PATTERN, not only in
            // the type annotation: a type alone does not bind a variable, and
            // the body reads `children` directly.
            //
            // It goes BEFORE a rest element, never after: `{ ...props, children }`
            // is a syntax error in the bundle ("Unexpected "," after rest
            // pattern") because a rest must be last, and `**props` is exactly how a
            // component receives the whole props object.
            let with_children = match ps.find("...") {
                Some(at) => {
                    let head = &ps[..at];
                    let tail = &ps[at..];
                    if head.trim_end().ends_with(',') {
                        format!("{} children, {}", head, tail)
                    } else {
                        format!("children, {}", ps)
                    }
                }
                None => format!("{}, children", ps),
            };
            format!(
                "{{ {} }}: {}Props & {{ children?: React.ReactNode }}",
                with_children, name
            )
        } else {
            format!("{{ {} }}: {}Props", ps, name)
        };
        // DEV ONLY: the component's binding is a registry slot, not a hard
        // reference, so an edit swaps the implementation and keeps the state of
        // the tree that is already mounted. `__refresh` returns a stable component
        // whose identity React does not see change.
        //
        // The boundary is per COMPONENT, not per module, and that is what makes it
        // provable: a component that uses an import, a context or a module-level
        // value still gets a new closure, but React keeps the hook state because
        // the element type is the same. Nothing here decides "can this be
        // hot-swapped" — every component can, and none is claimed to be special.
        let refresh = self.refresh_boundary;
        if refresh {
            self.used_helpers.borrow_mut().insert("__refresh".into());
            self.w(&format!(
                "export const {} = __refresh({:?}, function {}({}) {{",
                name, name, name, arg
            ));
        } else {
            self.w(&format!("export function {}({}) {{", name, arg));
        }
        self.depth += 1;

        let mut scope = Scope::scan(body);
        for p in params {
            let bare = p.name.trim_start_matches("...").to_string();
            scope.params.insert(bare.clone());
            scope.declared.insert(bare);
        }
        self.push_scope(scope);
        self.hoist_nested_assignments();

        let tree_count = body
            .iter()
            .filter(|s| matches!(s.kind, Kind::Tree { .. }))
            .count();
        if tree_count > 1 {
            for s in body {
                if !matches!(s.kind, Kind::Tree { .. }) {
                    self.stmt(s)?;
                }
            }
            let mut parts = Vec::new();
            for s in body {
                if matches!(s.kind, Kind::Tree { .. }) {
                    parts.push(self.tree(s, self.depth + 1)?);
                }
            }
            let pad = self.pad();
            let pad2 = "  ".repeat(self.depth + 1);
            let inner = parts
                .into_iter()
                .map(|p| format!("{}{}", pad2, p))
                .collect::<Vec<_>>()
                .join("\n");
            self.w(&format!(
                "return (\n{}<>\n{}\n{}</>\n{});",
                pad, inner, pad, pad
            ));
        } else {
            // The LAST statement of a component is its return value when it is an
            // element — which is what the tree form (`div():`) already does.
            //
            // A bare element call was not: `component App(): Router()` emitted
            // `Router();` and fell off the end of the function, returning
            // undefined. React rendered nothing, and because nothing failed the
            // build reported success while every page of the app was blank. A
            // component whose whole body is a single element is the most natural
            // way to write a router root, so it has to work.
            let last_is_element = matches!(
                body.last().map(|s| &s.kind),
                Some(Kind::ExprStmt(e)) if matches!(&e.kind, Kind::Call { func, .. } if self.is_element_call(func))
            );
            for (i, s) in body.iter().enumerate() {
                if last_is_element && i + 1 == body.len() {
                    if let Kind::ExprStmt(e) = &s.kind {
                        let val = self.js(e)?;
                        self.w(&format!("return (\n  {}{}\n{});", self.pad(), val, self.pad()));
                        continue;
                    }
                }
                self.stmt(s)?;
            }
        }
        self.scopes.pop();
        self.depth -= 1;
        self.w(if refresh { "});" } else { "}" });

        if !params.is_empty() {
            self.w("");
            self.w(&format!("export interface {}Props {{", name));
            self.depth += 1;
            for p in params {
                if p.name.starts_with("...") {
                    self.w("[key: string]: any;");
                } else {
                    let opt = if p.has_default { "?" } else { "" };
                    let ty = p.ty.as_deref().unwrap_or("any");
                    self.w(&format!("{}{}: {};", p.name, opt, ty));
                }
            }
            self.depth -= 1;
            self.w("}");
        }
        Ok(())
    }

    pub fn sourcemap(&self, filename: &str, src: &str) -> String {
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
        // `file` names the artifact this map describes: same path as the
        // source, with the extension swapped for `.tsx` (matching the name the
        // Vite plugin hands to esbuild). Both paths go through the JSON escaper
        // — a Windows path is full of backslashes and would otherwise produce
        // a map that `JSON.parse` rejects.
        let out_file = match filename.rfind('.') {
            Some(dot) => format!("{}.tsx", &filename[..dot]),
            None => format!("{}.tsx", filename),
        };
        format!(
            "{{\"version\":3,\"file\":{},\"sources\":[{}],\"sourcesContent\":[{}],\"names\":[],\"mappings\":\"{}\"}}",
            serde_json_escape(&out_file),
            serde_json_escape(filename),
            serde_json_escape(src),
            segs.join(";")
        )
    }

    /// Declare, at the top of the current function, every name whose first
    /// assignment sits inside a nested block. Python's names are function
    /// scoped; without this, `if c: v = 1` followed by `return v` emitted a
    /// binding that only existed inside the branch. `let` (never `const`)
    /// because the declaration is intentionally uninitialised.
    pub(super) fn hoist_nested_assignments(&mut self) {
        let Some(scope) = self.scopes.last_mut() else {
            return;
        };
        let names = scope.hoist_names();
        if names.is_empty() {
            return;
        }
        // Recording them as declared is what stops the first assignment inside
        // the branch from emitting a second, shadowing binding.
        for n in &names {
            scope.declared.insert(n.clone());
        }
        for n in names {
            self.w(&format!("let {};", n));
        }
    }

    pub(super) fn format_params(&self, params: &[Param]) -> Result<String, CompileError> {
        let mut out = Vec::new();
        for p in params {
            if let Some(d) = &p.default {
                // `x=None` marks a prop optional without setting a JS default.
                if !matches!(&d.kind, Kind::Null) {
                    out.push(format!("{} = {}", p.name, self.js(d)?));
                    continue;
                }
            }
            out.push(p.name.clone());
        }
        Ok(out.join(", "))
    }
}
