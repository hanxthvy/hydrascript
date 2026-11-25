//! The Emitter's state.
use std::collections::HashSet;


use super::*;

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
