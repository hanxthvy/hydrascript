// [xihanzu-NR]
//! TSX code generator and source map builder.
//!
//! Emits clean, readable TSX and keeps an exact line-by-line map so a browser
//! stack trace points at the .hsx line that produced it.

use std::collections::{HashMap, HashSet};

use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;

// Element names. A name here is rendered as a tag; anything else is an
// expression, so a lowercase tag that is missing becomes a call and the
// subtree fails. SVG filter primitives are included for that reason.
pub static HTML_TAGS: &[&str] = &[
    "div",
    "span",
    "p",
    "a",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "button",
    "input",
    "form",
    "label",
    "select",
    "option",
    "textarea",
    "img",
    "nav",
    "header",
    "footer",
    "main",
    "section",
    "article",
    "aside",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "br",
    "hr",
    "pre",
    "code",
    "em",
    "strong",
    "small",
    "figure",
    "figcaption",
    "video",
    "audio",
    "canvas",
    "svg",
    "iframe",
    "dialog",
    "path",
    "g",
    "circle",
    "rect",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "defs",
    "clipPath",
    "symbol",
    "use",
    "ellipse",
    "mask",
    "pattern",
    "marker",
    "linearGradient",
    "radialGradient",
    "stop",
    "foreignObject",
    "details",
    "summary",
    "picture",
    "source",
    "track",
    "time",
    "slot",
    "template",
    "mark",
    "progress",
    "meter",
    "fieldset",
    "legend",
    "optgroup",
    "caption",
    "colgroup",
    "col",
    "tfoot",
    "kbd",
    "blockquote",
    "address",
    "animateMotion",
    "animateTransform",
    "mpath",
    "altGlyph",
    "glyph",
    "textPath",
    "feGaussianBlur",
    "feOffset",
    "feBlend",
    "feColorMatrix",
    "feComponentTransfer",
    "feComposite",
    "feConvolveMatrix",
    "feDiffuseLighting",
    "feDisplacementMap",
    "feDropShadow",
    "feFlood",
    "feFuncA",
    "feFuncB",
    "feFuncG",
    "feFuncR",
    "feImage",
    "feMerge",
    "feMergeNode",
    "feMorphology",
    "feSpecularLighting",
    "feTile",
    "feTurbulence",
    // SVG filter element. A method call is a member expression (`xs.filter(fn)`),
    // which the element check never sees, so the bare name is unambiguous here.
    "filter",
    // Ordinary HTML that the original list omitted. `<i>` alone accounts for several
    // components: the tag is not an element, so the whole subtree failed to compile.
    "i", "b", "u", "s", "q", "cite", "abbr", "del", "ins", "sub", "sup", "var",
    "samp", "data", "datalist", "output", "noscript", "map", "area", "embed",
    "object", "param", "base", "link", "meta", "html", "head", "body", "style",
    "script", "col", "wbr", "bdi", "bdo", "ruby", "rt", "rp", "dfn", "kbd", "samp",
    // react-three-fiber element names. A lowercase tag that is not on this list is
    // read as an expression, so `<group>` failed the same way an unknown HTML tag did.
    "group", "primitive", "directionalLight", "ambientLight", "pointLight",
    "spotLight", "hemisphereLight", "perspectiveCamera", "orthographicCamera",
    "meshStandardMaterial", "meshPhysicalMaterial", "meshBasicMaterial",
    "meshLambertMaterial", "meshPhongMaterial", "meshMatcapMaterial",
    "shadowMaterial", "bufferGeometry", "boxGeometry", "planeGeometry",
];

// [xihanzu-NR]
/// Element names that are also ordinary JS methods, so a dotted head like
/// `base.map(...)` must NOT be read as the JSX element `<base.map>`.
///
/// `map` and `filter` are real HTML tags (`<map>`, `<filter>`), and the dotted
/// branch of `is_element` accepts any HTML tag as a member name, so a call to
/// `array.map(...)` was emitted as an element: `<base.map>{...}</base.map>`. That
/// drops the receiver, and the array call never happens — a runtime failure with a
/// green build ("Cannot access 'et' before initialization" downstream).
pub static MEMBER_METHOD_NAMES: &[&str] = &[
    // HTML/SVG tag names that are also everyday JS methods, confirmed by the
    // corpus: `<map>`, `<filter>`, `<rect>`, `<text>`, `<select>`, `<progress>`.
    // A dotted head with one of these names is a call on the receiver, never the
    // JSX element `<base.map>`.
    //
    // Anything that is a real member ELEMENT must stay out: `motion.button`,
    // `motion.input` and `motion.div` are how the animation components render, and
    // excluding them turned every one of those into "a tree block must start with
    // an element or component".
    "map", "filter", "rect", "select", "progress", "text",
    // `object` collides the same way `map` does: `<object>` is a real HTML element,
    // while `z.object({...})` is a call on a lowercase receiver. The bare form stays
    // an element (this list is only consulted for a DOTTED head), so both work.
    // Missing it compiled `z.object({...})` as `<z.object>{...}</z.object>`, which
    // drops the receiver — `SignupSchema` became a JSX element, so `safeParse` was
    // undefined at runtime. Caught by the examples check, not by a test.
    "object",
    // Array/string/object methods. Not HTML tags, so they change nothing today;
    // listed to keep the intent explicit.
    "length", "push", "pop", "slice", "splice", "concat", "join", "split", "trim",
    "forEach", "reduce", "reduceRight", "find", "findIndex", "some", "every",
    "sort", "reverse", "flat", "flatMap", "keys", "values", "entries", "has",
    "add", "delete", "get", "set", "toString", "valueOf", "includes",
];

/// Python builtins the compiler LOWERS itself, in either target.
///
/// This is the emitter's own copy of the honoured set, and it is deliberately
/// small and literal rather than derived: a name lands here only when there is
/// a match arm that rewrites it. `check.rs` has the authoring-facing list with
/// the conformance test that proves each name is honoured; this one exists so
/// `is_element_call` can refuse to read `map(fn, xs)` as the JSX element
/// `<map>{fn}{xs}</map>`, which drops the receiver and silently drops the call.
pub static PYTHON_BUILTIN_NAMES: &[&str] = &[
    "abs",
    "all",
    "any",
    "bool",
    "chr",
    "divmod",
    "enumerate",
    "filter",
    "float",
    "format",
    "int",
    "isinstance",
    "len",
    "list",
    "map",
    "max",
    "min",
    "ord",
    "pow",
    "print",
    "range",
    "repr",
    "reversed",
    "round",
    "sorted",
    "str",
    "sum",
    "type",
    "zip",
];

pub static JS_BUILTIN_GLOBALS: &[&str] = &[
    "Math",
    "Date",
    "Array",
    "Object",
    "Number",
    "String",
    "Boolean",
    "RegExp",
    "JSON",
    "Promise",
    "Reflect",
    "Intl",
    "Set",
    "Map",
    "WeakSet",
    "WeakMap",
    "Symbol",
    "Error",
    "TypeError",
    "RangeError",
    "ResizeObserver",
    "IntersectionObserver",
    "MutationObserver",
    "WebSocket",
    "Worker",
    "Audio",
    "Image",
    "FormData",
    "URL",
    "URLSearchParams",
    "Console",
    "console",
    "window",
    "document",
    "globalThis",
    "navigator",
    "location",
    "localStorage",
    "sessionStorage",
    "performance",
    "Performance",
];

/// Python's exception bases, and their runtime stand-ins.
///
/// `Exception` is the root; the rest exist so `except ValueError:` names
/// something. They are needed as classes and not as aliases of `Error` because
/// `except ValueError:` is an `instanceof` test — aliasing them all to `Error`
/// would make every handler match every error, which is worse than not
/// compiling.
pub fn python_base_class(name: &str) -> Option<String> {
    const KEYS: &[&str] = &[
        "Exception",
        "BaseException",
        "ValueError",
        "KeyError",
        "IndexError",
        "RuntimeError",
        "ZeroDivisionError",
        "AttributeError",
        "StopIteration",
        "NotImplementedError",
        "FileNotFoundError",
        "PermissionError",
        "OSError",
        "IOError",
        "ArithmeticError",
        "AssertionError",
        "LookupError",
        "OverflowError",
        "RangeError",
        "UnicodeError",
    ];
    if KEYS.contains(&name) {
        Some(name.to_string())
    } else {
        None
    }
}

pub fn prop_map(k: &str) -> String {
    if k.starts_with("aria_") || k.starts_with("data_") {
        return k.replace('_', "-");
    }
    match k {
        "class" | "cls" => "className".into(),
        "for" => "htmlFor".into(),
        "on_click" => "onClick".into(),
        "on_change" => "onChange".into(),
        "on_input" => "onInput".into(),
        "on_submit" => "onSubmit".into(),
        "on_key_down" => "onKeyDown".into(),
        "on_key_up" => "onKeyUp".into(),
        "on_blur" => "onBlur".into(),
        "on_focus" => "onFocus".into(),
        "on_mouse_enter" => "onMouseEnter".into(),
        "on_mouse_leave" => "onMouseLeave".into(),
        "on_double_click" => "onDoubleClick".into(),
        "read_only" => "readOnly".into(),
        "auto_focus" => "autoFocus".into(),
        "auto_complete" => "autoComplete".into(),
        "tab_index" => "tabIndex".into(),
        "max_length" => "maxLength".into(),
        "col_span" => "colSpan".into(),
        "row_span" => "rowSpan".into(),
        "src_set" => "srcSet".into(),
        "type_" => "type".into(),
        other => other.into(),
    }
}

pub fn str_method(m: &str) -> &str {
    match m {
        "strip" => "trim",
        "lstrip" => "trimStart",
        "rstrip" => "trimEnd",
        "upper" => "toUpperCase",
        "lower" => "toLowerCase",
        "startswith" => "startsWith",
        "endswith" => "endsWith",
        "replace" => "replaceAll",
        "find" => "indexOf",
        "split" => "split",
        "join" => "join",
        "append" => "push",
        "copy" => "slice",
        // NOTE: "keys"/"values"/"items" are NOT here on purpose. They were
        // emitted as `.keys()` / `.values()` / `.entries()` — JS method calls —
        // which throw on a plain object literal (`d.keys is not a function`)
        // even though `hydra check` stayed silent. They are free-function
        // rewrites now; see `free_func` below.
        // Dunder introspection. `type(x).__name__` is the common one; without
        // this it emitted `.__name__`, which is `undefined` on every JS value.
        "__name__" => "name",
        "__class__" => "constructor",
        "__doc__" => "toString",
        "__module__" => "name",
        other => other,
    }
}

/// Python methods with no JS equivalent that are rewritten to a free function
/// call into the `hydra` runtime: `s.capitalize()` -> `capitalize(s)`.
///
/// The dict, list, str and dict-lookup entries here are the ones that used to
/// produce JavaScript that either threw or silently did the wrong thing:
/// `", ".join(xs)` emitted a method call on a string (TypeError), `d.get("k", 0)`
/// emitted a method call on an object (TypeError), `len(d)` emitted `.length` on
/// an object (undefined), and `xs.extend(ys)` emitted `.extend` (TypeError).
/// Each one is now mapped to the helper that implements the Python behaviour.
pub fn free_func(m: &str) -> Option<&'static str> {
    match m {
        // strings
        "capitalize" => Some("capitalize"),
        "title" => Some("title"),
        "count" => Some("count"),
        "format" => Some("format"),
        "zfill" => Some("zfill"),
        "isdigit" => Some("isDigit"),
        "isalpha" => Some("isAlpha"),
        "isalnum" => Some("isAlnum"),
        "isspace" => Some("isSpace"),
        "isupper" => Some("isUpper"),
        "islower" => Some("isLower"),
        "center" => Some("center"),
        "ljust" => Some("ljust"),
        "rjust" => Some("rjust"),
        "partition" => Some("str_partition"),
        "rpartition" => Some("str_rpartition"),
        "swapcase" => Some("swapcase"),
        // join is a string method in Python and an array method in JS; the
        // operands are the other way round, so it needs a helper.
        "join" => Some("join"),
        // dict
        "get" => Some("dict_get"),
        "setdefault" => Some("dict_setdefault"),
        "update" => Some("dict_update"),
        "pop" => Some("pop_of"),
        "popitem" => Some("dict_popitem"),
        "fromkeys" => Some("dict_fromkeys"),
        // list
        "extend" => Some("list_extend"),
        "insert" => Some("list_insert"),
        "remove" => Some("list_remove"),
        "index" => Some("list_index"),
        // Plain-object dicts have no JS methods at all. `d.keys()` used to emit
        // `d.keys()` and throw `d.keys is not a function` at runtime — silently,
        // because the checker did not model dict methods and the gate only sees
        // the code a render actually runs.
        "keys" => Some("dict_keys"),
        "values" => Some("dict_values"),
        "items" => Some("dict_items"),
        // set-like helpers
        "add" => Some("set_add"),
        "discard" => Some("set_discard"),
        _ => None,
    }
}


// [xihanzu-NR]
/// Python truthiness for a CONDITION: an empty list, dict or string and 0 are
/// falsy, where JS calls `[]` and `{}` true.
///
/// Only non-trivial tests are wrapped. `if x == 1`, `if not x` and `if fn()` are
/// already correct in JS, and wrapping them would emit `truthy(x === 1)` — noise
/// that makes the output harder to read for no behaviour change.
pub fn py_cond(cond: &str) -> String {
    // A bare `!expr` is already Python's `not`, because `not` lowers to `!` and
    // JS `!` agrees with Python for every falsy scalar; the sequence cases are
    // what differ, and those come through as a bare NAME or a member access.
    let trimmed = cond.trim();
    if trimmed.starts_with('!') || trimmed.starts_with("Boolean(") || trimmed.starts_with("truthy(") {
        return cond.to_string();
    }
    if trimmed.contains(" == ") || trimmed.contains(" === ") || trimmed.contains(" != ")
        || trimmed.contains(" !== ") || trimmed.starts_with("!!(") || trimmed.starts_with("(")
    {
        return cond.to_string();
    }
    format!("truthy({})", cond)
}

/// Every name assigned anywhere inside `nodes`, including nested functions.
///
/// Used to tell a closure's captures from its own bindings: a name the body assigns is
/// either local to it or captured from an enclosing scope, and only the enclosing
/// scope can decide which — so the set is handed up and filtered there.
fn collect_assigned(nodes: &[Node], out: &mut HashSet<String>) {
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
fn collect_closure_writes(nodes: &[Node], out: &mut HashSet<String>) {
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


/// How a relative import should be emitted.
///
/// React components in the wild are overwhelmingly `export default`. This
/// compiler has always emitted a named import for a relative path, which means
/// every such component failed the build with
/// `No matching export in "./X.tsx" for import "X"` until the author added a
/// second, named export. That is a papercut on every single third-party or
/// hand-written component, so the emitter now looks at the file.
///
/// Reads the module only to decide the import shape, and only for relative
/// specifiers. Anything unreadable falls back to the named form, which is what
/// an author writing `from "./local.hys" import helper` wants.
fn import_shapes_as_default(spec: &str, base_dir: Option<&std::path::Path>) -> bool {
    let dir = match base_dir {
        Some(d) => d,
        None => return false,
    };
    if !(spec.starts_with("./") || spec.starts_with("../")) {
        return false;
    }
    let base = dir.join(spec);
    const EXTS: &[&str] = &["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".hyx", ".hys"];
    for ext in EXTS {
        let candidate = if ext.is_empty() {
            base.clone()
        } else {
            std::path::PathBuf::from(format!("{}{}", base.display(), ext))
        };
        let source = match std::fs::read_to_string(&candidate) {
            Ok(s) => s,
            Err(_) => continue,
        };

        // If the imported candidate is a HydraScript file (.hyx/.hys/.hsx/.hs),
        // components (`component Name():`) and functions (`export def`) are always
        // emitted as named exports (`export function Name()`). They should never be
        // shaped as default imports.
        let is_hydra_source = candidate.extension().is_some_and(|e| {
            e == "hyx" || e == "hys" || e == "hsx" || e == "hs"
        });
        if is_hydra_source {
            // HydraScript files always emit named exports for components and functions.
            continue;
        }

        // Strip single-line comments so a mention of "export default" inside a comment
        // does not fool the heuristic into generating a broken default import.
        let non_comment_lines: Vec<&str> = source
            .lines()
            .map(|l| l.trim_start())
            .filter(|l| !l.starts_with("//") && !l.starts_with("#") && !l.starts_with("/*") && !l.starts_with("*"))
            .collect();
        let cleaned = non_comment_lines.join("\n");

        let has_default = cleaned.contains("export default")
            || cleaned.contains("module.exports")
            || cleaned.contains("exports.default");
        if !has_default {
            continue;
        }
        // `export { X }` / `export const X` / `export function X` / `component X` mean the named
        // import already works, and a default import would then be wrong.
        let named_hints = [
            "export {",
            "export const ",
            "export function ",
            "export class ",
            "export let ",
            "export var ",
            "component ",
        ];
        if named_hints.iter().any(|h| cleaned.contains(h)) {
            continue;
        }
        return true;
    }
    false
}

/// The parameter names of `name` defined in another HydraScript file.
///
/// Reads the source and finds `def name(a, b=1)` / `export def name(...)`.
/// Defaults are not returned: they matter for a MISSING argument, and the
/// compiler only reorders what the caller passed.
/// Is this a bare package name (`react`, `@scope/pkg`) rather than a path?
///
/// The distinction decides whether the signature can be read from disk: a
/// package's entrypoint is resolved by the bundler, not by this compiler.
fn is_package_specifier(spec: &str) -> bool {
    let s = spec.trim();
    if s.starts_with("./") || s.starts_with("../") || s.starts_with('/') {
        return false;
    }
    if s.starts_with("@scope/") || s.starts_with('@') {
        // `@scope/name` or `@scope/name/sub` — a package either way.
        return !s.contains(".h");
    }
    // No leading dot and no EXTENSION: `react`, `date-fns`. A project file
    // always carries `.hys`/`.hyx`/`.hs`/`.hsx` or a slash.
    !s.contains('/') && !s.contains(".h")
}

/// The same signature reader, for the plain-JS target.
///
/// `hx_target` compiles `.hys` files and has its own emitter with its own
/// fields; rather than duplicate a line-oriented parser (and let the two
/// disagree about what a `def` header looks like), this exposes the one that
/// already exists.
pub fn imported_fn_params_for_hx(
    spec: &str,
    name: &str,
    base_dir: Option<&std::path::Path>,
) -> Option<Vec<String>> {
    imported_fn_params(spec, name, base_dir)
}

fn imported_fn_params(spec: &str, name: &str, base_dir: Option<&std::path::Path>) -> Option<Vec<String>> {
    let dir = base_dir?;
    // Only a RELATIVE specifier can be read back: an npm package's signature
    // lives in `node_modules` behind whatever its entrypoint does, and reading
    // it here would be guessing. That bound was always correct.
    //
    // What was WRONG was the test for "relative": it required a leading `./` or
    // `../`, and the language's own idiom is `from "lib/stats.hys" import f`
    // (no dot), which the bundler resolves fine. So keyword arguments to a
    // function imported that way were a COMPILE ERROR while the same call with
    // the same file spelled `./lib/stats.hys` worked — two answers for one
    // import, decided by punctuation nobody documents.
    //
    // Anything that is not a bare package name is a project path. A package
    // name is one identifier, optionally scoped, with no slash after it.
    if spec.trim().is_empty() || is_package_specifier(spec) {
        return None;
    }
    let base = dir.join(spec);
    // Bound what a `from "..." import` may READ — and never block on it.
    //
    // Two holes here. A specifier that climbs out of the source tree
    // (`from "../../../../etc/passwd" import x`) was read whenever it happened to
    // parse, and a device or FIFO (`from "/dev/zero" import x`) never returned:
    // the compiler was still allocating after five seconds. Neither exfiltrates
    // content — only "has export default" and parameter names reach the output —
    // but a build that hangs on a hostile file is a build that hangs.
    let Ok(base_real) = std::fs::canonicalize(dir) else {
        return None;
    };
    for ext in ["", ".hys", ".hyx", ".hs", ".hsx"] {
        let candidate = if ext.is_empty() {
            base.clone()
        } else {
            std::path::PathBuf::from(format!("{}{}", base.display(), ext))
        };
        // Canonicalize FIRST: it resolves `..` and symlinks, and it fails for a
        // path that does not exist, which is the common case here.
        let Ok(real) = std::fs::canonicalize(&candidate) else {
            continue;
        };
        if !real.starts_with(&base_real) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&real) else {
            continue;
        };
        // A regular file, and a small one: `/dev/zero` is neither.
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&real) else {
            continue;
        };
        // Line-oriented scan: a `def` header is one line, and the compiler has
        // no cross-file parser. `def name(` at any indentation, optional
        // `export`, optional `async`.
        for line in source.lines() {
            let trimmed = line.trim_start();
            let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed);
            let trimmed = trimmed.strip_prefix("async ").unwrap_or(trimmed);
            let Some(rest) = trimmed.strip_prefix("def ") else {
                continue;
            };
            let Some(open) = rest.find('(') else { continue };
            if rest[..open].trim() != name {
                continue;
            }
            let Some(close) = rest.rfind(')') else { continue };
            let inner = &rest[open + 1..close];
            let mut params = Vec::new();
            for p in inner.split(',') {
                let p = p.trim();
                if p.is_empty() {
                    continue;
                }
                // `a: int = 1` -> `a`; `*args` -> `args`.
                let head = p.split([':', '=']).next().unwrap_or(p).trim();
                let head = head.trim_start_matches('*').trim();
                if !head.is_empty() {
                    params.push(head.to_string());
                }
            }
            return Some(params);
        }
    }
    None
}

/// The parameter names of a METHOD, looked up by its bare name.
///
/// Signatures are recorded as `Class.method`. The receiver's type is not always
/// known here (`x.greet(...)` where `x` came from a call), so the lookup asks a
/// weaker question: is there exactly ONE class in this file declaring `greet`?
/// If there is, that signature is the only candidate and using it is right. If
/// two classes declare it, the answer is genuinely ambiguous and the caller
/// falls back to the plain error rather than guessing which class `x` is.
fn method_params(
    table: &std::collections::HashMap<String, Vec<String>>,
    method: &str,
) -> Option<Vec<String>> {
    let suffix = format!(".{}", method);
    let mut found: Option<&Vec<String>> = None;
    for (key, params) in table {
        if !key.ends_with(&suffix) {
            continue;
        }
        if found.is_some() {
            return None; // ambiguous: two classes declare this name
        }
        found = Some(params);
    }
    found.cloned()
}

pub struct Emitter {
    pub lines: Vec<String>,
    pub linemap: Vec<usize>,
    pub cur_src: usize,
    pub depth: usize,
    pub imports: HashSet<String>,
    /// Directory of the file being compiled, when known.
    ///
    /// Used to answer one question at emit time: does a relative import point
    /// at a module that exports the requested name, or only a default? React
    /// components are written `export default`, and emitting a named import for
    /// one fails the build until the author re-exports by name.
    pub base_dir: Option<std::path::PathBuf>,
    /// Runtime helpers the source actually used (capitalize, title, ...).
    /// Collected during emission so the import is injected only when needed.
    pub used_helpers: std::cell::RefCell<HashSet<String>>,
    /// Whether a component is wrapped in the dev-time refresh boundary.
    ///
    /// OFF by default: the boundary exists only so a dev server can keep a mounted
    /// component's state across an edit, and a release build must emit a plain
    /// function. `hydra dev` turns it on; every other caller gets production shape
    /// without asking.
    pub refresh_boundary: bool,
    /// Every `def` in the file, by name: the ordered parameter list.
    ///
    /// Keyword arguments are a Python feature JavaScript does not have. A call
    /// written as `f(a=1, b=2)` used to emit `f(a: 1, b: 2)` — object-literal
    /// syntax inside a call, which is a syntax error in a build that reported
    /// success. With the signature known, matching kwargs are reordered into
    /// positional arguments (correct for any function in this file), and a name
    /// that matches nothing becomes a real error instead of broken output.
    pub fn_params: std::cell::RefCell<std::collections::HashMap<String, Vec<String>>>,
    /// Names bound by a walrus (`:=`), which must be declared before use.
    pub walrus_names: std::cell::RefCell<HashSet<String>>,
    /// Names declared by `class`, so calling one emits `new` — in
    /// Python, `Foo(1)` constructs an instance.
    pub class_names: std::cell::RefCell<std::collections::HashSet<String>>,
    pub head_lines: Vec<String>,
    /// Names this module IMPORTS. A call to one of them is a function call, never a
    /// JSX tag — the tag test only knows what this file declares, so
    /// `part_putar(b, "R1", 90)` used to compile to `jsx(part_putar, { ...b })` and the
    /// call vanished. Kept separate from `fn_params` because that map also carries
    /// parameter lists used to reorder keyword arguments.
    pub imported_names: std::cell::RefCell<HashSet<String>>,
    /// name -> the specifier it came from, for relative imports only.
    ///
    /// Lets the keyword-argument reordering read a signature from another file
    /// in the project. Empty for anything imported from a package.
    pub import_specs: std::cell::RefCell<std::collections::HashMap<String, String>>,
    ///
    /// `export function` is hoisted JavaScript, so the declaration may sit after its
    /// own body text. That is what makes it possible to define one module-level
    /// `def` in terms of another regardless of order: the body of the exported
    /// function is emitted where the `export def` appears, but any `def` it calls is
    /// queued on `head_lines` and written above. Without this, the `Kind::Export`
    /// arm emitted nothing whatsoever for a `.hyx` — the statement vanished and the
    /// build reported success.
    pub exported_decls: std::cell::RefCell<Vec<(String, String)>>,
    pub scopes: Vec<Scope>,
    /// Monotonic counter behind `fresh_var`.
    pub tmp_counter: u32,
}

impl Emitter {
    /// Push a scope onto the stack, recording every name the enclosing scopes bind.
    ///
    /// Doing it at push time keeps a plain assignment O(1): the emitter needs to know
    /// whether `raf = ...` inside a callback creates a binding or writes the `let raf`
    /// declared by the component body, and scanning the whole stack per statement
    /// would be both slower and easier to get wrong.
    /// Does the innermost scope's enclosing chain already bind this name?
    /// Forwarded to `Scope` so the assignment path stays readable.
    fn bound_in_enclosing(&self, id: &str) -> bool {
        self.scopes
            .last()
            .map(|s| s.bound_in_enclosing(id))
            .unwrap_or(false)
    }

    fn push_scope(&mut self, mut scope: Scope) {
        let mut bound = HashSet::new();
        for s in &self.scopes {
            bound.extend(s.params.iter().cloned());
            bound.extend(s.declared.iter().cloned());
            bound.extend(s.assigned_anywhere.iter().cloned());
        }
        scope.outer_bound = bound;
        self.scopes.push(scope);
    }

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
    fn ctor_name(&self, n: &Node) -> Result<String, CompileError> {
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

    fn pad(&self) -> String {
        "  ".repeat(self.depth)
    }

    /// A name no source binding can collide with. Used for the temporary a
    /// `try/else` needs; the counter is per-emitter so two blocks never share one.
    fn fresh_var(&mut self, hint: &str) -> String {
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

    fn attr_str(&self, args: &[Node], kwargs: &[(String, Node)]) -> Result<String, CompileError> {
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

    fn jsx_inline(
        &self,
        func: &Node,
        args: &[Node],
        kwargs: &[(String, Node)],
    ) -> Result<String, CompileError> {
        let tag = self.js(func)?;
        let a = self.attr_str(args, kwargs)?;
        let non_spread_args: Vec<_> = args
            .iter()
            .filter(|a| !matches!(a.kind, Kind::Spread(_)))
            .collect();
        if non_spread_args.is_empty() {
            return Ok(format!("<{}{} />", tag, a));
        }
        let mut inner = String::new();
        for k in non_spread_args {
            match &k.kind {
                Kind::Str { value, is_f: false } => {
                    // Strip quotes for plain text children inside JSX.
                    inner.push_str(&value[1..value.len() - 1]);
                }
                Kind::Num(v) => inner.push_str(v),
                _ => {
                    inner.push('{');
                    inner.push_str(&self.js(k)?);
                    inner.push('}');
                }
            }
        }
        Ok(format!("<{}{}>{}</{}>", tag, a, inner, tag))
    }

    pub fn tree(&self, n: &Node, ind: usize) -> Result<String, CompileError> {
        let (head, body) = match &n.kind {
            Kind::Tree { head, body } => (head, body),
            _ => unreachable!(),
        };

        let (tag, a) = match &head.kind {
            Kind::Name(id) => (id.clone(), String::new()),
            Kind::Attr { .. } if Self::is_element(head) => (self.js(head)?, String::new()),
            // A tree HEAD is always a tag: `main(className="x"):` is the HTML element,
            // whatever the module happens to declare elsewhere. Using
            // `is_element_call` here was wrong and broke the very module that motivated
            // that helper — PCBForge defines `def main()` as its entry point, so
            // `main(className="kolom"):` was rejected with "a tree block must start with
            // an element or component". The name-vs-tag ambiguity only exists for a CALL
            // in expression position, which is where `is_element_call` belongs.
            Kind::Call { func, args, kwargs } if Self::is_element(func) => {
                (self.js(func)?, self.attr_str(args, kwargs)?)
            }
            _ => {
                return Err(CompileError::new(
                    "a tree block must start with an element or component",
                    n.line,
                    n.col,
                    Vec::new(),
                )
                .with_hint("e.g. `div(className=\"x\"):` or `h1:`"))
            }
        };

        if body.is_empty() {
            return Ok(format!("<{}{} />", tag, a));
        }

        let mut kids = Vec::new();
        for k in body {
            kids.push(self.child(k, ind + 1)?);
        }

        // Inline single short child: <h1>Hello</h1>
        if kids.len() == 1 && !kids[0].contains('\n') && kids[0].len() < 60 {
            return Ok(format!("<{}{}>{}</{}>", tag, a, kids[0].trim(), tag));
        }

        let pad_inner = "  ".repeat(ind + 1);
        let pad_close = "  ".repeat(ind);
        let inner = kids
            .into_iter()
            .map(|k| format!("{}{}", pad_inner, k))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(format!(
            "<{}{}>\n{}\n{}</{}>",
            tag, a, inner, pad_close, tag
        ))
    }

    /// True when a branch produces no output at all.
    ///
    /// `{cond ? <A/> : null}` is the common React shape, and an empty `else:` in the
    /// source lowers to the same thing. Neither is an expression to wrap in parens.
    fn renders_nothing(&self, body: &[Node]) -> bool {
        let real: Vec<_> = body
            .iter()
            .filter(|s| !matches!(s.kind, Kind::Pass))
            .collect();
        if real.is_empty() {
            return true;
        }
        if real.len() != 1 {
            return false;
        }
        match &real[0].kind {
            Kind::Null => true,
            Kind::ExprStmt(e) => match &e.kind {
                Kind::Null => true,
                Kind::Name(n) => n == "None" || n == "null",
                _ => false,
            },
            _ => false,
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
    fn as_expr(frag: &str) -> String {
        let t = frag.trim();
        if Self::is_one_container(t) {
            t[1..t.len() - 1].trim().to_string()
        } else {
            t.to_string()
        }
    }

    fn is_one_container(t: &str) -> bool {
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

    fn child(&self, s: &Node, ind: usize) -> Result<String, CompileError> {
        match &s.kind {
            // `slot` is where the parent's children are rendered — React's
            // `props.children`. Bare in the JSX it has to become an expression
            // container, or the identifier is undefined at render time.
            Kind::Name(id) if id == "slot" => Ok("{children}".to_string()),
            Kind::ExprStmt(e) if matches!(&e.kind, Kind::Name(n) if n == "slot") => {
                Ok("{children}".to_string())
            }
            Kind::Tree { .. } => self.tree(s, ind),
            Kind::ExprStmt(e) => match &e.kind {
                Kind::Str { value, is_f: false } => Ok(value[1..value.len() - 1].to_string()),
                Kind::Num(v) => Ok(v.clone()),
                Kind::Call { func, args, kwargs } if self.is_element_call(func) => {
                    self.jsx_inline(func, args, kwargs)
                }
                _ => Ok(format!("{{{}}}", self.js(e)?)),
            },
            Kind::If { test, body, orelse } => {
                let cond0 = self.js(test)?;
                let cond = crate::emitter::py_cond(&cond0);
                if cond.starts_with("truthy(") {
                    self.used_helpers.borrow_mut().insert("truthy".into());
                }
                let b = Self::as_expr(&self.frag(body, ind)?);
                if let Some(ore) = orelse {
                    if ore.len() == 1 && matches!(&ore[0].kind, Kind::If { .. }) {
                        // Elif: unwrap the nested braces so we don't emit {cond ? (...) : {elif ? ...}}.
                        let inner = self.child(&ore[0], ind)?;
                        let stripped = inner.trim().trim_start_matches('{').trim_end_matches('}');
                        return Ok(format!("{{{cond} ? ({b}) : ({stripped})}}"));
                    }
                    // An `else` that renders nothing — `{cond ? <A/> : null}` — has to
                    // become the value React renders as nothing. Passing it through
                    // emitted `({null})`, which is not an expression: esbuild stopped
                    // with "Expected ':' but found '}'".
                    if self.renders_nothing(ore) {
                        return Ok(format!("{{{cond} ? ({b}) : null}}"));
                    }
                    let o = Self::as_expr(&self.frag(ore, ind)?);
                    return Ok(format!("{{{cond} ? ({b}) : ({o})}}"));
                }
                Ok(format!("{{{cond} && ({b})}}"))
            }
            Kind::For { target, iter, body } => {
                let it = self.js(iter)?;
                // The body is an expression, so a container comes off: `{cond && <A/>}`
                // must become `cond && <A/>` or the arrow gets a BLOCK body and maps
                // everything to undefined.
                let b = Self::as_expr(&self.frag(body, ind)?);
                // A multi-target loop is spelled `for item, i in items:` and means
                // "(element, index)" — the same meaning the statement form has, where
                // it becomes `[item, i]`. Written verbatim into an arrow parameter that
                // produced `.map(([item, i]) => ...)`, which JS reads as *destructuring
                // a pair out of a scalar*, so every element that is not an array threw
                // "object is not iterable" (or, for a 2-char string, silently mapped
                // characters). An arrow can take two parameters, so the brackets come
                // off: `.map((item, i) => ...)`.
                let param = {
                    let t = target.trim();
                    if t.starts_with('[') && t.ends_with(']') {
                        t[1..t.len() - 1].to_string()
                    } else {
                        t.to_string()
                    }
                };
                Ok(format!("{{{it}.map(({param}) => ({b}))}}"))
            }
            Kind::Match { subject, cases } => {
                let s_val = self.js(subject)?;
                let mut chain = String::new();
                for c in cases.iter().rev() {
                    let b = self.frag(&c.body, ind)?;
                    let is_wildcard = match &c.pattern.kind {
                        Kind::Name(n) if n == "_" => true,
                        _ => false,
                    };
                    if is_wildcard {
                        chain = format!("({b})");
                    } else {
                        let cond = match &c.pattern.kind {
                            Kind::Bin { op, left, right } if op == "|" => {
                                format!(
                                    "(({} === {}) || ({} === {}))",
                                    s_val,
                                    self.js(left)?,
                                    s_val,
                                    self.js(right)?
                                )
                            }
                            _ => format!("({} === {})", s_val, self.js(&c.pattern)?),
                        };
                        if chain.is_empty() {
                            chain = format!("{cond} ? ({b}) : null");
                        } else {
                            chain = format!("{cond} ? ({b}) : {chain}");
                        }
                    }
                }
                Ok(format!("{{{chain}}}"))
            }
            _ => Err(CompileError::new(
                format!("`{:?}` is not allowed inside a tree block", s.kind),
                s.line,
                s.col,
                Vec::new(),
            )
            .with_hint(
                "move logic above the tree — tree blocks only accept elements, if, and for",
            )),
        }
    }

    fn frag(&self, body: &[Node], ind: usize) -> Result<String, CompileError> {
        let mut kids = Vec::new();
        for s in body {
            kids.push(self.child(s, ind)?);
        }
        if kids.len() == 1 {
            return Ok(kids.into_iter().next().unwrap());
        }
        let pad_inner = "  ".repeat(ind + 1);
        let pad_close = "  ".repeat(ind);
        let inner = kids
            .into_iter()
            .map(|k| format!("{}{}", pad_inner, k))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(format!("<>\n{}\n{}</>", inner, pad_close))
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

    /// Declare, at the top of the current function, every name whose first
    /// assignment sits inside a nested block. Python's names are function
    /// scoped; without this, `if c: v = 1` followed by `return v` emitted a
    /// binding that only existed inside the branch. `let` (never `const`)
    /// because the declaration is intentionally uninitialised.
    fn hoist_nested_assignments(&mut self) {
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

    fn format_params(&self, params: &[Param]) -> Result<String, CompileError> {
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
}

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode_vlq(n: i64) -> String {
    let mut v = if n < 0 { ((-n) << 1) | 1 } else { n << 1 } as u64;
    let mut out = String::new();
    loop {
        let mut digit = (v & 31) as usize;
        v >>= 5;
        if v != 0 {
            digit |= 32;
        }
        out.push(B64[digit] as char);
        if v == 0 {
            break;
        }
    }
    out
}

fn serde_json_escape(s: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn emit_tsx(src: &str) -> String {
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        let toks = crate::lexer::lex(src).expect("lex failed");
        let module = crate::parser::Parser::new(toks, lines)
            .module()
            .expect("parse failed");
        let mut em = Emitter::new();
        em.run(&module).expect("emit failed")
    }

    fn has_all(out: &str, frags: &[&str]) {
        for f in frags {
            assert!(
                out.contains(f),
                "missing fragment {:?} in output:\n{}",
                f,
                out
            );
        }
    }

    fn lacks(out: &str, frag: &str) {
        assert!(
            !out.contains(frag),
            "unexpected fragment {:?} in output:\n{}",
            frag,
            out
        );
    }

    // ----------------------------------------------------------------- prop map

    #[test]
    fn prop_renaming_matches_react() {
        assert_eq!(prop_map("cls"), "className");
        assert_eq!(prop_map("class"), "className");
        assert_eq!(prop_map("for"), "htmlFor");
        assert_eq!(prop_map("on_click"), "onClick");
        assert_eq!(prop_map("on_change"), "onChange");
        assert_eq!(prop_map("tab_index"), "tabIndex");
        assert_eq!(prop_map("type_"), "type");
        assert_eq!(prop_map("data_custom"), "data-custom");
        assert_eq!(prop_map("aria_label"), "aria-label");
        assert_eq!(prop_map("data_test_id"), "data-test-id");
    }

    // ------------------------------------------------------------ string method

    #[test]
    fn string_methods_map_to_js() {
        assert_eq!(str_method("strip"), "trim");
        assert_eq!(str_method("upper"), "toUpperCase");
        assert_eq!(str_method("lower"), "toLowerCase");
        assert_eq!(str_method("startswith"), "startsWith");
        assert_eq!(str_method("endswith"), "endsWith");
        assert_eq!(str_method("replace"), "replaceAll");
        assert_eq!(str_method("find"), "indexOf");
    }

    #[test]
    fn free_functions_are_flagged() {
        assert_eq!(free_func("capitalize"), Some("capitalize"));
        assert_eq!(free_func("title"), Some("title"));
        assert_eq!(free_func("strip"), None);
    }

    // ------------------------------------------------------------- expressions

    #[test]
    fn strict_comparisons_emitted() {
        let out = emit_tsx("component A():\n    if x == 1:\n        p: \"y\"\n");
        has_all(&out, &["(x === 1)"]);
        let out = emit_tsx("component A():\n    if x != 1:\n        p: \"y\"\n");
        has_all(&out, &["(x !== 1)"]);
    }

    #[test]
    fn boolean_operators_emitted() {
        let out = emit_tsx("component A():\n    if a and b:\n        p: \"y\"\n");
        has_all(&out, &["(a && b)"]);
        let out = emit_tsx("component A():\n    if a or b:\n        p: \"y\"\n");
        has_all(&out, &["(a || b)"]);
        let out = emit_tsx("component A():\n    if not a:\n        p: \"y\"\n");
        has_all(&out, &["(!a)"]);
    }

    #[test]
    fn lambda_emits_arrow_function() {
        let out = emit_tsx("component A():\n    button(on_click=lambda: go()): \"x\"\n");
        has_all(&out, &["=> go()"]);
    }

    #[test]
    fn lambda_with_defaults_emits_js_defaults() {
        let out = emit_tsx("component A():\n    f = lambda m=mode: m\n");
        has_all(&out, &["((m = mode) => m)"]);
    }

    #[test]
    fn ternary_emitted() {
        let out = emit_tsx("component A():\n    p: \"y\" if a else \"n\"\n");
        has_all(&out, &["(a ? \"y\" : \"n\")"]);
    }

    #[test]
    fn arithmetic_operators_emitted() {
        let out = emit_tsx("component A():\n    x = 1 + 2 * 3 - 4 / 5 % 6\n");
        has_all(&out, &["const x = "]);
    }

    #[test]
    fn unary_minus_emitted() {
        let out = emit_tsx("component A():\n    x = -1\n");
        has_all(&out, &["(-1)"]);
    }

    // ----------------------------------------------------------------- builtins

    #[test]
    fn len_maps_to_length() {
        let out = emit_tsx("component A():\n    n = len(items)\n");
        has_all(&out, &["len_of(items)"]);
    }

    #[test]
    fn string_number_builtins_map_to_js() {
        // `int`/`float`/`round`/`bool` call the RUNTIME, not the JS builtin:
        // `parseInt("12px")` is 12 where Python raises, `Math.round(2.5)` is 3
        // where Python is 2, and `Boolean([])` is true where Python is False.
        // Every one of those was a silent wrong value with a green build.
        let out = emit_tsx("component A():\n    a = str(x)\n    b = int(x)\n    c = float(x)\n    d = abs(x)\n    e = round(x)\n    f = bool(x)\n");
        has_all(
            &out,
            &[
                // `str(x)` is `py_str(x)`: `String(null)` is "null" where Python
                // says "None", and `String(true)` is "true" where Python says
                // "True". The text lands in a page, so the spelling matters.
                "py_str(x)",
                "int(x)",
                "float(x)",
                "Math.abs(x)",
                "round_py(x)",
                "truthy(x)",
                "import { float, int, py_str, round_py, truthy } from 'hydra';",
            ],
        );
    }

    #[test]
    fn sum_maps_to_reduce() {
        let out = emit_tsx("component A():\n    n = sum(xs)\n");
        has_all(&out, &["xs.reduce((a, b) => a + b, 0)"]);
    }

    #[test]
    fn sorted_reversed_list_map_to_slice() {
        let out = emit_tsx(
            "component A():\n    a = sorted(xs)\n    b = reversed(xs)\n    c = list(xs)\n",
        );
        // `sorted` goes through the runtime so NUMBERS compare numerically:
        // the bare `.sort()` compares string forms, so [10, 9, 100] came out
        // [10, 100, 9] with a green build.
        has_all(
            &out,
            &["sorted(xs)", "xs.slice().reverse()", "xs.slice()"],
        );
    }

    #[test]
    fn string_methods_emitted() {
        let out = emit_tsx("component A():\n    a = t.strip()\n    b = t.upper()\n    c = t.lower()\n    d = t.startswith(\"x\")\n    e = t.endswith(\"y\")\n");
        has_all(
            &out,
            &[
                "t.trim()",
                "t.toUpperCase()",
                "t.toLowerCase()",
                "t.startsWith(\"x\")",
                "t.endsWith(\"y\")",
            ],
        );
    }

    #[test]
    fn runtime_helpers_are_auto_imported() {
        let out = emit_tsx("component A():\n    s = t.capitalize()\n");
        has_all(
            &out,
            &["import { capitalize } from 'hydra';", "capitalize(t)"],
        );
    }

    // ----------------------------------------------------------- comprehensions

    #[test]
    fn comprehension_map_form() {
        let out = emit_tsx("component A():\n    ys = [x * 2 for x in xs]\n");
        has_all(&out, &["xs.map((x) => (x * 2))"]);
    }

    #[test]
    fn comprehension_filter_only_form_avoids_redundant_map() {
        let out = emit_tsx("component A():\n    ys = [x for x in xs if x > 1]\n");
        has_all(&out, &["xs.filter((x) => (x > 1))"]);
        lacks(&out, ".map");
    }

    #[test]
    fn comprehension_filter_and_map_form() {
        let out = emit_tsx("component A():\n    ys = [x * 2 for x in xs if x > 1]\n");
        has_all(&out, &["xs.filter((x) => (x > 1)).map((x) => (x * 2))"]);
    }

    // ------------------------------------------------------------------ f-string

    #[test]
    fn fstring_emits_template_literal() {
        let out = emit_tsx("component A():\n    div: f\"hi {name}\"\n");
        has_all(&out, &["`hi ${name}`"]);
    }

    #[test]
    fn fstring_escaped_braces_become_literal_braces() {
        let out = emit_tsx("component A():\n    div: f\"{{literal}}\"\n");
        has_all(&out, &["`{literal}`"]);
        lacks(&out, "${literal}");
    }

    #[test]
    fn fstring_backticks_are_escaped() {
        let out = emit_tsx("component A():\n    div: f\"a`b {x}\"\n");
        has_all(&out, &["`a\\`b ${x}`"]);
    }

    #[test]
    fn fstring_dollars_are_escaped_so_literals_survive() {
        let out = emit_tsx("component A():\n    div: f\"cost: ${price}\"\n");
        has_all(&out, &["${price}"]);
    }

    // -------------------------------------------------------------------- trees

    #[test]
    fn nested_tree_elements_render() {
        let out =
            emit_tsx("component A():\n    div:\n        h1: \"Hello\"\n        p: \"World\"\n");
        has_all(&out, &["<div>", "<h1>Hello</h1>", "<p>World</p>", "</div>"]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn class_and_cls_become_className() {
        let out = emit_tsx("component A():\n    div(cls=\"x\"):\n        span: \"y\"\n");
        has_all(&out, &["className=\"x\""]);
        lacks(&out, "className={\"x\"}");
    }

    #[test]
    fn self_closing_elements() {
        let out = emit_tsx(
            "component A():\n    div:\n        br:\n        hr:\n        input(value=x)\n",
        );
        has_all(&out, &["<br />", "<hr />", "<input value={x} />"]);
    }

    #[test]
    fn empty_block_self_closes() {
        let out = emit_tsx("component A():\n    div():\n");
        has_all(&out, &["<div />"]);
    }

    #[test]
    fn inline_single_child_stays_on_one_line() {
        let out = emit_tsx("component A():\n    h1: \"Hello\"\n");
        has_all(&out, &["<h1>Hello</h1>"]);
    }

    // -------------------------------------------------- control flow inside trees

    #[test]
    fn tree_if_becomes_logical_and() {
        // A bare NAME in a condition is Python truthiness: an empty list is
        // falsy in Python and true in JS, so it goes through the runtime.
        let out = emit_tsx("component A():\n    div:\n        if a:\n            p: \"yes\"\n");
        has_all(&out, &["{truthy(a) && (", "yes"]);
    }

    #[test]
    fn tree_if_else_becomes_ternary() {
        let out = emit_tsx("component A():\n    div:\n        if a:\n            p: \"yes\"\n        else:\n            p: \"no\"\n");
        has_all(&out, &["{truthy(a) ? (<p>yes</p>) : (<p>no</p>)}"]);
    }

    #[test]
    fn tree_elif_chain_unwraps_nested_braces() {
        // Bug hunt: must NOT emit `{a ? x : {b ? y : z}}`.
        let out = emit_tsx("component A():\n    div:\n        if a:\n            p: \"1\"\n        elif b:\n            p: \"2\"\n        else:\n            p: \"3\"\n");
        has_all(&out, &["{truthy(a) ? (<p>1</p>) : (truthy(b) ? (<p>2</p>) : (<p>3</p>))}"]);
        lacks(&out, ": {");
    }

    #[test]
    fn tree_for_becomes_map() {
        let out = emit_tsx(
            "component A():\n    ul:\n        for it in items:\n            li(key=it): it\n",
        );
        has_all(&out, &["items.map((it) => (", "<li key={it}>"]);
    }

    #[test]
    fn tree_for_with_multiple_children_emits_fragment() {
        let out = emit_tsx("component A():\n    div:\n        for x in xs:\n            span: \"a\"\n            span: \"b\"\n");
        has_all(&out, &["<>", "<span>a</span>", "<span>b</span>", "</>"]);
    }

    // --------------------------------------------------------------- components

    #[test]
    fn component_props_and_interface_emitted() {
        let out = emit_tsx(
            "component Btn(label: str, count: int = 0, on_click=None):\n    button: label\n",
        );
        has_all(
            &out,
            &[
                "export function Btn({ label, count = 0, on_click }: BtnProps)",
                "export interface BtnProps {",
                "label: string;",
                "count?: number;",
                "on_click?: any;",
            ],
        );
        lacks(&out, "label?:");
        lacks(&out, "= null");
    }

    #[test]
    fn component_with_no_props_emits_no_arg_and_no_interface() {
        let out = emit_tsx("component NoProps():\n    div: \"z\"\n");
        has_all(&out, &["export function NoProps()"]);
        lacks(&out, "NoPropsProps");
    }

    // ---------------------------------------------------------------- statements

    #[test]
    fn assign_emits_const() {
        let out = emit_tsx("component A():\n    x = 1\n");
        has_all(&out, &["const x = 1;"]);
    }

    #[test]
    fn reassigned_variable_emits_let_then_reassignment() {
        let out = emit_tsx("component A():\n    x = 1\n    x = 2\n    div: \"z\"\n");
        has_all(&out, &["let x = 1;", "x = 2;"]);
        lacks(&out, "const x = 1;");
        lacks(&out, "const x = 2;");
        lacks(&out, "let x = 2;");
    }

    #[test]
    fn single_assign_variable_emits_const() {
        let out = emit_tsx("component A():\n    y = 1\n    div: \"z\"\n");
        has_all(&out, &["const y = 1;"]);
        lacks(&out, "let y = 1;");
    }

    #[test]
    fn augmented_assign_emits_let_then_aug() {
        let out = emit_tsx("component A():\n    z = 0\n    z += 1\n    div: \"z\"\n");
        has_all(&out, &["let z = 0;", "z += 1;"]);
        lacks(&out, "const z = 0;");
    }

    #[test]
    fn def_reassigned_and_augmented_emits_let() {
        let out = emit_tsx(
            "def calc():\n    x = 1\n    x = 2\n    z = 0\n    z += 1\n    return x + z\n",
        );
        has_all(&out, &["let x = 1;", "x = 2;", "let z = 0;", "z += 1;"]);
        lacks(&out, "const x = 1;");
        lacks(&out, "const z = 0;");
    }

    #[test]
    fn tuple_unpack_emits_array_destructure() {
        let out = emit_tsx("component A():\n    a, b = pair()\n");
        has_all(&out, &["let [a, b] = pair();"]);
    }

    #[test]
    fn def_emits_arrow_function() {
        let out = emit_tsx("component A():\n    def go():\n        x()\n");
        has_all(&out, &["const go = () => {"]);
    }

    #[test]
    fn augmented_assign_emits_in_place() {
        let out = emit_tsx("component A():\n    x += 1\n");
        has_all(&out, &["x += 1;"]);
    }

    #[test]
    fn statement_level_if_and_for_emit_native_blocks() {
        let out =
            emit_tsx("component A():\n    if a:\n        go()\n    for x in xs:\n        run(x)\n");
        has_all(&out, &["if (truthy(a)) {", "for (const x of xs) {"]);
    }

    #[test]
    fn js_builtins_are_not_elements() {
        let math_cos = Node::new(
            Kind::Attr {
                obj: Box::new(Node::new(Kind::Name("Math".into()), 1, 1)),
                name: "cos".into(),
            },
            1,
            1,
        );
        assert!(!Emitter::is_element(&math_cos));

        let date_now = Node::new(
            Kind::Attr {
                obj: Box::new(Node::new(Kind::Name("Date".into()), 1, 1)),
                name: "now".into(),
            },
            1,
            1,
        );
        assert!(!Emitter::is_element(&date_now));

        let resize_obs = Node::new(Kind::Name("ResizeObserver".into()), 1, 1);
        assert!(!Emitter::is_element(&resize_obs));

        let button = Node::new(Kind::Name("button".into()), 1, 1);
        assert!(Emitter::is_element(&button));

        let custom_comp = Node::new(Kind::Name("StrokeText".into()), 1, 1);
        assert!(Emitter::is_element(&custom_comp));
    }

    #[test]
    fn bare_return_emits_semicolon() {
        let out = emit_tsx("component A():\n    def go():\n        return\n");
        has_all(&out, &["return;"]);
    }

    #[test]
    fn keyword_kwargs_emit_cleanly() {
        let out = emit_tsx(
            "component A():\n    button(type=\"button\", for=\"my-id\"):\n        \"Click\"\n",
        );
        has_all(&out, &["<button type=\"button\" htmlFor=\"my-id\">"]);
    }

    // ------------------------------------------------------------------- imports

    #[test]
    fn imports_are_deduplicated_and_sorted() {
        let out = emit_tsx(
            "from b import y\nfrom a import x\nfrom b import y\n\ncomponent A():\n    div: \"z\"\n",
        );
        let lines: Vec<_> = out.lines().filter(|l| l.starts_with("import ")).collect();
        assert_eq!(
            lines,
            vec!["import { x } from 'a';", "import { y } from 'b';",]
        );
    }

    // ----------------------------------------------------------------- sourcemap

    #[test]
    fn sourcemap_structure_and_version() {
        let src = "component A():\n    div: \"x\"\n";
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        let toks = crate::lexer::lex(src).unwrap();
        let mod_ = crate::parser::Parser::new(toks, lines).module().unwrap();
        let mut em = Emitter::new();
        let code = em.run(&mod_).unwrap();
        let smap = em.sourcemap("A.hsx", src);

        assert!(smap.contains("\"version\":3"));
        assert!(smap.contains("\"file\":\"A.tsx\""));
        assert!(smap.contains("\"sources\":[\"A.hsx\"]"));
        assert!(smap.contains("\"sourcesContent\":"));

        // Exactly one segment per generated code line.
        let m: SerdeJsonLite = parse_json_lite(&smap);
        let segs = m.mappings.split(';').count();
        let code_lines = code.split('\n').count();
        assert_eq!(segs, code_lines);
    }

    #[test]
    fn sourcemap_with_windows_path_is_valid_json() {
        // Backslashes in `C:\Users\test\App.hsx` used to be emitted unescaped.
        let mut em = Emitter::new();
        em.head_lines = vec!["// [xihanzu-NR]".into()];
        em.lines = vec!["export function A() {}".into()];
        em.linemap = vec![1];
        let map = em.sourcemap("C:\\Users\\test\\App.hsx", "component A():\n");
        assert!(map.contains("\"file\":\"C:\\\\Users\\\\test\\\\App.tsx\""));
        assert!(map.contains("\"sources\":[\"C:\\\\Users\\\\test\\\\App.hsx\"]"));
    }

    struct SerdeJsonLite {
        mappings: String,
    }

    fn parse_json_lite(s: &str) -> SerdeJsonLite {
        let marker = "\"mappings\":\"";
        let start = s.find(marker).unwrap() + marker.len();
        let end = s[start..].find('"').unwrap() + start;
        SerdeJsonLite {
            mappings: s[start..end].to_string(),
        }
    }

    // ---------------------------------------------------------------- edge cases

    #[test]
    fn empty_dict_is_wrapped_for_arrow_disambiguation() {
        let out = emit_tsx("component A():\n    d = {}\n");
        has_all(&out, &["const d = ({});"]);
    }

    #[test]
    fn empty_list_and_tuple_emit_empty_arrays() {
        let out = emit_tsx("component A():\n    xs = []\n    t = ()\n");
        has_all(&out, &["const xs = [];", "const t = [];"]);
    }

    #[test]
    fn unicode_in_strings_and_identifiers_emitted_cleanly() {
        let out = emit_tsx("component A():\n    café = \"日本語\"\n");
        has_all(&out, &["const café = \"日本語\";"]);
    }

    #[test]
    fn key_prop_is_preserved_in_for_loop() {
        let out = emit_tsx(
            "component A():\n    ul:\n        for it in items:\n            li(key=it): it\n",
        );
        has_all(&out, &["<li key={it}>"]);
        lacks(&out, "key={key}");
    }

    // ------------------------------------------------- interop: default exports

    /// A React component written `export default` must be imported as a default.
    /// Every such component used to fail the build with
    /// `No matching export in "./X.tsx" for import "X"`.
    #[test]
    fn relative_default_export_emits_default_import() {
        let dir = std::env::temp_dir().join("hydra-emitter-interop");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("Card.tsx"),
            "export default function Card() { return null }\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("Named.tsx"),
            "export const Named = () => null;\nexport function other() {}\n",
        )
        .unwrap();

        let src = "from \"./Card.tsx\" import Card\ncomponent A():\n    Card()\n";
        let lines: Vec<String> = src.split('\n').map(String::from).collect();
        let toks = crate::lexer::lex(src).unwrap();
        let module = crate::parser::Parser::new(toks, lines).module().unwrap();
        let out = Emitter::new().with_base_dir(&dir).run(&module).unwrap();
        assert!(
            out.contains("import Card from './Card.tsx';"),
            "default-exporting component must be a default import, got:\n{out}"
        );
        assert!(!out.contains("import { Card }"), "named form must not be used");

        let src2 = "from \"./Named.tsx\" import Named\ncomponent B():\n    Named()\n";
        let lines2: Vec<String> = src2.split('\n').map(String::from).collect();
        let toks2 = crate::lexer::lex(src2).unwrap();
        let module2 = crate::parser::Parser::new(toks2, lines2).module().unwrap();
        let out2 = Emitter::new().with_base_dir(&dir).run(&module2).unwrap();
        assert!(
            out2.contains("import { Named } from './Named.tsx';"),
            "a module with named exports keeps the named form, got:\n{out2}"
        );
    }

    /// Without a base directory there is nothing to read, so the historical
    /// named form is kept — compiling from stdin must not change behaviour.
    #[test]
    fn no_base_dir_keeps_named_import() {
        let out =
            emit_tsx("from \"./Whatever.tsx\" import Whatever\ncomponent A():\n    Whatever()\n");
        assert!(out.contains("import { Whatever }"), "got:\n{out}");
    }

    #[test]
    fn hyx_file_with_commented_export_default_keeps_named_import() {
        let dir = std::env::temp_dir().join(format!("hydra-hyx-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A .hyx file with a comment mentioning 'export default' must not trick
        // the emitter into generating a default import for a named component.
        std::fs::write(
            dir.join("App.hyx"),
            "# [xihanzu-NR]\n# Note: writing export default does not work\ncomponent App():\n    div(): \"app\"\n",
        )
        .unwrap();

        let src = "from \"./App.hyx\" import App\ncomponent Main():\n    App()\n";
        let lines: Vec<String> = src.split('\n').map(String::from).collect();
        let toks = crate::lexer::lex(src).unwrap();
        let module = crate::parser::Parser::new(toks, lines).module().unwrap();
        let out = Emitter::new().with_base_dir(&dir).run(&module).unwrap();
        assert!(
            out.contains("import { App } from './App.hyx';"),
            "hyx component must always remain named import, got:\n{out}"
        );
        assert!(!out.contains("import App from"), "default import must not be emitted");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// True when a component body renders `slot` anywhere — including inside the
/// JSX tree it returns, which is where the marker actually appears in source.
fn node_uses_slot(n: &Node) -> bool {
    match &n.kind {
        Kind::Name(id) => id == "slot",
        Kind::Tree { head, body } => node_uses_slot(head) || body.iter().any(node_uses_slot),
        Kind::If { body, orelse, .. } => {
            body.iter().any(node_uses_slot)
                || orelse.as_ref().is_some_and(|b| b.iter().any(node_uses_slot))
        }
        Kind::For { body, iter, .. } => node_uses_slot(iter) || body.iter().any(node_uses_slot),
        Kind::While { body, .. } => body.iter().any(node_uses_slot),
        Kind::Call { func, args, kwargs } => {
            node_uses_slot(func)
                || args.iter().any(node_uses_slot)
                || kwargs.iter().any(|(_, v)| node_uses_slot(v))
        }
        Kind::Assign { value, .. } | Kind::AugAssign { value, .. } => node_uses_slot(value),
        Kind::Bin { left, right, .. } => node_uses_slot(left) || node_uses_slot(right),
        Kind::Ternary { test, body, orelse } => {
            node_uses_slot(test) || node_uses_slot(body) || node_uses_slot(orelse)
        }
        Kind::Return(Some(v)) | Kind::Unary { operand: v, .. } => node_uses_slot(v),
        // The marker arrives wrapped in the expression statement that puts it
        // in the JSX: `div(): slot` parses as Tree{ div, [ExprStmt(Name slot)] }.
        Kind::ExprStmt(inner) => node_uses_slot(inner),
        Kind::Await(v) | Kind::Spread(v) | Kind::OptAttr { obj: v, .. } => node_uses_slot(v),
        Kind::Index { obj, index } | Kind::OptIndex { obj, index } => {
            node_uses_slot(obj) || node_uses_slot(index)
        }
        Kind::Slice { obj, start, stop, .. } => {
            node_uses_slot(obj)
                || start.as_ref().is_some_and(|v| node_uses_slot(v))
                || stop.as_ref().is_some_and(|v| node_uses_slot(v))
        }
        Kind::List(items) | Kind::Tuple(items) => items.iter().any(node_uses_slot),
        Kind::Dict(pairs) => pairs.iter().any(|(k, v)| {
            k.as_ref().is_some_and(node_uses_slot) || node_uses_slot(v)
        }),
        Kind::ChainedCompare { operands, .. } => operands.iter().any(node_uses_slot),
        Kind::Contains { item, container, .. } => {
            node_uses_slot(item) || node_uses_slot(container)
        }
        _ => false,
    }
}

#[cfg(test)]
mod import_read_tests {
    use super::imported_fn_params;
    use std::fs;

    #[test]
    fn an_import_cannot_read_outside_the_source_tree() {
        // Only "has export default" / parameter names ever reach the output, so
        // this was never exfiltration — but a generated file must not depend on
        // what happens to sit next to the project.
        let root = std::env::temp_dir().join(format!("hydra-import-{}", std::process::id()));
        let src = root.join("src");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&src).unwrap();
        fs::write(root.join("secret.hys"), "export def f(a, b):\n    pass\n").unwrap();
        fs::write(src.join("lib.hys"), "export def g(x):\n    pass\n").unwrap();

        // Inside: read.
        let inside = imported_fn_params("./lib.hys", "g", Some(&src));
        assert_eq!(inside, Some(vec!["x".to_string()]));

        // Outside, by relative traversal: refused.
        assert_eq!(
            imported_fn_params("../secret.hys", "f", Some(&src)),
            None
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_device_file_is_never_read() {
        // `/dev/zero` has no end. The old code decoded whatever `read_to_string`
        // produced, which for a FIFO or a device never finished.
        if !std::path::Path::new("/dev/zero").exists() {
            return;
        }
        assert_eq!(imported_fn_params("/dev/zero", "f", Some(std::path::Path::new("/"))), None);
    }
}
