// [xihanzu-NR]
//! TSX code generator and source map builder.
//!
//! Emits clean, readable TSX and keeps an exact line-by-line map so a browser
//! stack trace points at the .hsx line that produced it.



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

// ---------------------------------------------------------------------------
// Where things live.
//
// This was one 4,586-line file with 25 methods on a single impl block: a file
// you read by searching rather than by scrolling. The split follows the shape of
// the work, not the alphabet.
//
//   model.rs     the Emitter struct and the state it carries
//   core.rs      construction, scopes, the entry points, source maps
//   expr.rs      js(): every expression, and the Python lowering behind it
//   element.rs   JSX: elements, children, fragments, trees
//   stmt.rs      stmt(): statements, blocks, and the hoisting rules
//   names.rs     the name-mapping tables
//   scope.rs     Scope: what a name means where, and who writes what
//   imports.rs   which specifier a name came from, and its parameter list
//   tests.rs     the unit tests, out of the production file
//
// Rust allows one type to have impl blocks in several modules of the same module
// tree, so this costs nothing at runtime: same struct, same methods, no wrapper
// and no dispatch. The one real cost is visibility — a method called from a
// sibling module must say so — and that is cheaper than a file nobody scrolls.

mod core;
mod element;
mod expr;
mod imports;
mod model;
mod names;
mod scope;
mod sourcemap;
mod stmt;
mod veil;

#[cfg(test)]
mod tests;

pub use imports::imported_fn_params_for_hx;
pub use model::Emitter;
pub use names::{free_func, prop_map, py_cond, python_base_class, str_method};
pub use scope::Scope;
pub use sourcemap::encode_vlq;
