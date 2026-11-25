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

mod core;
mod entry;
mod expr;
mod stmt;
mod util;

pub use util::asset_import;

use crate::emitter::Scope;

/// The `.hx` target: plain JavaScript instead of React TSX.
///
/// Same front end (lexer, parser, AST) as `.hsx`; only the emitter differs, and
/// only in three places:
///   1. `def` emits a hoisted `function` declaration, not a `const` arrow.
///   2. Tree blocks and `component` are errors — there is no element to nest.
///   3. Props are not renamed; `on_click` stays `on_click`.
/// Everything else (f-strings, comprehensions, builtins, operators) is shared.
///
/// The split follows the TSX emitter's: core, expr, stmt, entry, util.

pub struct JsEmitter {
    pub lines: Vec<String>,
    pub linemap: Vec<usize>,
    pub cur_src: usize,
    pub depth: usize,
    pub imports: std::collections::HashSet<String>,
    pub used_helpers: std::cell::RefCell<std::collections::HashSet<String>>,
    /// Every `def` in the file, by name. Keyword arguments do not exist in
    /// JavaScript, so a call like `f(a=1, b=2)` needs the signature to be
    /// reordered into positional arguments — otherwise it emits `f(a: 1)`,
    /// which no JS engine parses.
    pub fn_params: std::cell::RefCell<std::collections::HashMap<String, Vec<String>>>,
    /// Names bound by a walrus (`:=`).
    pub walrus_names: std::cell::RefCell<std::collections::HashSet<String>>,
    /// Names declared by `class`, so calling one emits `new` — in
    /// Python, `Foo(1)` constructs an instance.
    pub class_names: std::cell::RefCell<std::collections::HashSet<String>>,
    pub head_lines: Vec<String>,
    /// Saat tidak kosong, `w()` menulis ke sini, bukan ke `lines`. Dipakai untuk
    /// merakit badan sebuah `export def` lebih dulu supaya bisa diletakkan di
    /// `head_lines` (deklarasi `export function` diangkat JavaScript, jadi badan
    /// boleh berada di atas pemanggil-pemanggilnya).
    pub buffer: Option<Vec<String>>,
    /// Nama fungsi yang sudah diantrekan ke head_lines, supaya tidak dobel.
    pub queued_decls: std::collections::HashSet<String>,
    /// `export def` yang menunggu ditulis ke head_lines: (nama, teks).
    pub exported_decls: Vec<(String, String)>,
    pub scopes: Vec<Scope>,
    /// Where each imported name came from, so a keyword argument can be read
    /// back from the source file. Without this the `.hys` target could not
    /// reorder `f(b=2, a=1)` for an imported function at all: it has no other
    /// way to know the signature.
    pub import_specs: std::cell::RefCell<std::collections::HashMap<String, String>>,
    /// The directory of the file being compiled, for resolving those specifiers.
    pub base_dir: Option<std::path::PathBuf>,
}
