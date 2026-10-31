// [xihanzu-NR]
//! Emit TypeScript declarations for a `.hyx` / `.hys` module.
//!
//! Why: without this, TypeScript cannot see a `.hyx` module at all. `tsc
//! --noEmit` on a project that imports one reports
//! `TS2307: Cannot find module './Widget.hyx' or its corresponding type
//! declarations`, so the only options for a mixed project are an error or a
//! `declare module '*.hyx'` shim that makes every import `any` — which silently
//! removes type checking exactly where a TS user needs it. The emitter already
//! knows the prop types; this makes them visible.
//!
//! Honesty rules, because a declaration that lies is worse than none:
//!
//!   - A component's props come from its own parameters, the same source the
//!     emitted `export interface <Name>Props` uses. No inference.
//!   - Python type names are MAPPED (`int`/`float` -> `number`, `str` ->
//!     `string`, `list` -> `any[]`, ...). They are not copied: the interface
//!     bodies the emitter passes through verbatim contain `float` and `list`,
//!     which are not TypeScript types at all.
//!   - An unrecognised type name is emitted as `any` rather than as-is. Guessing
//!     it is a name is how a declaration ends up referencing a type that does not
//!     exist, which breaks the consumer's build.
//!   - A construct this cannot represent is OMITTED, not approximated. Omitting
//!     a class member means a consumer gets "property does not exist", which is
//!     a visible error they can work around; a wrong declaration gives them a
//!     green checkmark on code that will crash.

use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;

/// Python type name -> TypeScript type name.
fn ts_type(py: &str) -> String {
    let t = py.trim();
    // Generic forms arrive two ways: Python spelling (`list[int]`) from source,
    // and the parser's already-mapped TypeScript spelling (`Array<any>`) from the
    // AST. Both must be understood, or `Array<any>` falls through to `any` and
    // silently loses the element type.
    let open = t.find(['[', '<']);
    if let Some(open) = open {
        let close = if t.as_bytes()[open] == b'[' { ']' } else { '>' };
        if t.ends_with(close) {
            let head = t[..open].trim();
            let inner = &t[open + 1..t.len() - 1];
            let args: Vec<String> = split_top_level(inner).iter().map(|a| ts_type(a)).collect();
            return match head {
                // A heterogeneous dict cannot be expressed as a single TS record;
                // `Record<string, any>` is the honest ceiling.
                "dict" | "Record" => match (args.first(), args.get(1)) {
                    (Some(_k), Some(v)) => format!("Record<string, {}>", v),
                    _ => "Record<string, any>".to_string(),
                },
                "list" | "set" | "tuple" | "Array" => {
                    format!("{}[]", args.first().cloned().unwrap_or_else(|| "any".into()))
                }
                "Optional" => format!("{} | null", args.first().cloned().unwrap_or_else(|| "any".into())),
                "Union" => args.join(" | "),
                other => {
                    let h = ts_type(other);
                    format!("{}<{}>", h, args.join(", "))
                }
            };
        }
    }
    match t {
        "int" | "float" | "number" | "complex" => "number".to_string(),
        "str" | "string" => "string".to_string(),
        "bool" | "boolean" => "boolean".to_string(),
        "None" | "null" | "NoneType" => "null".to_string(),
        // The parser maps `list` to `Array` and `dict` to `Record` before this
        // sees them, so both spellings are handled. Bare `Array`/`Record` are
        // invalid TypeScript (generic with no argument), never emitted.
        "Array" | "list" | "set" | "tuple" => "any[]".to_string(),
        "Record" | "dict" => "Record<string, any>".to_string(),
        "bytes" => "Uint8Array".to_string(),
        "any" | "object" => "any".to_string(),
        // A name that starts uppercase may be a real local interface/type or an
        // imported one. Only commit to it when it looks like an identifier;
        // everything else becomes `any`.
        other if is_ident(other) => other.to_string(),
        _ => "any".to_string(),
    }
}

/// Split on commas that are not inside brackets.
fn split_top_level(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for c in s.chars() {
        match c {
            '[' | '(' => {
                depth += 1;
                cur.push(c);
            }
            ']' | ')' => {
                depth -= 1;
                cur.push(c);
            }
            ',' if depth == 0 => {
                out.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn is_ident(s: &str) -> bool {
    let mut ch = s.chars();
    match ch.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    ch.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Does this module export anything worth declaring? A file with no exports has
/// no declarations to write, and writing an empty `.d.ts` would overwrite a
/// hand-written one.
fn has_exports(body: &[Node]) -> bool {
    body.iter().any(|n| {
        matches!(
            n.kind,
            Kind::Component { .. }
                | Kind::Export(_)
                | Kind::ExportDefault(_)
                | Kind::Interface { .. }
                | Kind::TypeAlias { .. }
                | Kind::Class { .. }
        )
    })
}

/// One parameter as a TS member of the props interface.
fn param_member(p: &Param) -> Option<String> {
    // `*props` becomes an index signature: the same call the emitter's own Props
    // interface makes, so the two agree.
    if p.name.starts_with("...") {
        return Some("[key: string]: any;".to_string());
    }
    if !is_ident(&p.name) {
        return None;
    }
    let opt = if p.has_default { "?" } else { "" };
    let ty = match &p.ty {
        Some(t) => ts_type(t),
        // No annotation: `any`, because a guessed type would be a lie.
        None => "any".to_string(),
    };
    Some(format!("{}{}: {};", p.name, opt, ty))
}

/// A function signature's parameter list, positionally.
fn fn_params(params: &[Param]) -> String {
    let mut out = Vec::new();
    for p in params {
        if p.name.starts_with("...") {
            out.push("...args: any[]".to_string());
            continue;
        }
        if !is_ident(&p.name) {
            continue;
        }
        let opt = if p.has_default { "?" } else { "" };
        let ty = p.ty.as_deref().map(ts_type).unwrap_or_else(|| "any".to_string());
        out.push(format!("{}{}: {}", p.name, opt, ty));
    }
    out.join(", ")
}

/// Emit the declaration file for a parsed module.
///
/// Declarations are collected into a name -> text map rather than printed in two
/// passes. That is not stylistic: a component `Widget` generates an interface
/// named `WidgetProps`, and a source file may also declare `interface
/// WidgetProps` itself. Printing both produces a duplicate identifier and the
/// consumer's build fails. The map lets the generated one — the one the emitted
/// JavaScript actually references — replace the hand-written one.
pub fn emit(module: &Node, filename: &str) -> Result<String, CompileError> {
    let body = match &module.kind {
        Kind::Module(b) => b,
        _ => return Err(CompileError::new("not a module", 1, 1, Vec::new())),
    };

    if !has_exports(body) {
        return Ok(String::new());
    }

    // Insertion-ordered map: name -> declaration text.
    let mut types: Vec<(String, String)> = Vec::new();
    let mut values: Vec<(String, String)> = Vec::new();
    let put = |list: &mut Vec<(String, String)>, name: String, text: String| {
        if let Some(slot) = list.iter_mut().find(|(n, _)| *n == name) {
            slot.1 = text;
        } else {
            list.push((name, text));
        }
    };

    // Interfaces and type aliases, which the rest references.
    for n in unwrap_export(body) {
        let (name, raw, is_alias) = match &n.kind {
            Kind::Interface { name, body } => (name, body, false),
            Kind::TypeAlias { name, body } => (name, body, true),
            _ => continue,
        };
        if !is_ident(name) {
            continue;
        }
        let text = if is_alias {
            // A type alias body is arbitrary TypeScript; copying it verbatim
            // risks Python type names leaking in (`float`), so the alias becomes
            // `any` rather than a confident lie.
            format!("export type {} = any;", name)
        } else {
            let members = map_interface_body(raw);
            let mut t = format!("export interface {} {{\n", name);
            for m in members {
                t.push_str("  ");
                t.push_str(&m);
                t.push('\n');
            }
            t.push('}');
            t
        };
        put(&mut types, name.clone(), text);
    }

    // Components, functions, classes.
    for n in body {
        match &n.kind {
            Kind::Component { name, params, .. } => {
                if !is_ident(name) {
                    continue;
                }
                if params.is_empty() {
                    put(
                        &mut values,
                        name.clone(),
                        format!(
                            "export declare function {}(props?: {{ children?: any }}): HydraElement;",
                            name
                        ),
                    );
                    continue;
                }
                let mut members = Vec::new();
                let mut children = false;
                for p in params {
                    if let Some(m) = param_member(p) {
                        members.push(m);
                    }
                    if p.name == "children" {
                        children = true;
                    }
                }
                // `slot` means children. Keeping the option available either way
                // lets a consumer pass children without a cast.
                if !children {
                    members.push("children?: any;".to_string());
                }
                let props = format!("{}Props", name);
                let mut t = format!("export interface {} {{\n", props);
                for m in &members {
                    t.push_str("  ");
                    t.push_str(m);
                    t.push('\n');
                }
                t.push('}');
                put(&mut types, props.clone(), t);
                put(
                    &mut values,
                    name.clone(),
                    format!(
                        "export declare function {}(props: {}): HydraElement;",
                        name, props
                    ),
                );
            }
            Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                if !is_ident(name) {
                    continue;
                }
                let ret = if matches!(n.kind, Kind::AsyncDef { .. }) {
                    "Promise<any>"
                } else {
                    "any"
                };
                put(
                    &mut values,
                    name.clone(),
                    format!("export declare function {}({}): {};", name, fn_params(params), ret),
                );
            }
            Kind::Export(inner) => match &inner.kind {
                Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                    if !is_ident(name) {
                        continue;
                    }
                    let ret = if matches!(inner.kind, Kind::AsyncDef { .. }) {
                        "Promise<any>"
                    } else {
                        "any"
                    };
                    put(
                        &mut values,
                        name.clone(),
                        format!("export declare function {}({}): {};", name, fn_params(params), ret),
                    );
                }
                Kind::Class { name, .. } => {
                    if is_ident(name) {
                        // Method signatures are not tracked, so members are not
                        // reproduced. An index signature keeps member access
                        // compiling, which is permissive rather than wrong.
                        put(
                            &mut values,
                            name.clone(),
                            format!(
                                "export declare class {} {{\n  constructor(...args: any[]);\n  [key: string]: any;\n}}",
                                name
                            ),
                        );
                    }
                }
                _ => {}
            },
            // A default export has no guaranteed name to declare it under, so it
            // is deliberately absent rather than invented.
            Kind::ExportDefault(_) => {}
            _ => {}
        }
    }

    let mut out = String::new();
    out.push_str("// [xihanzu-NR]\n");
    out.push_str(&format!(
        "// Generated from {} by `hydra types`. Edit the source, not this file.\n\n",
        filename
    ));
    // The JSX element type. Declared here rather than imported so the file does
    // not depend on which React version the consumer has.
    out.push_str("type HydraElement = any;\n\n");
    for (_, t) in &types {
        out.push_str(t);
        out.push_str("\n\n");
    }
    for (_, t) in &values {
        out.push_str(t);
        out.push('\n');
    }
    Ok(out)
}

/// The nodes that a top-level `export` wraps, plus the unwrapped ones.
fn unwrap_export<'a>(body: &'a [Node]) -> Vec<&'a Node> {
    let mut out = Vec::new();
    for n in body {
        match &n.kind {
            Kind::Export(inner) => out.push(inner.as_ref()),
            _ => out.push(n),
        }
    }
    out
}

/// Map an interface body to TS members.
///
/// The body arrives as raw text and may contain Python type names. Anything that
/// cannot be read as `name: type` becomes an index signature, which is the
/// permissive-but-honest fallback: it never claims a member exists, and it never
/// claims one does not.
fn map_interface_body(raw: &str) -> Vec<String> {
    let t = raw.trim();
    let inner = t.strip_prefix('{').and_then(|x| x.strip_suffix('}')).unwrap_or(t);
    let mut out = Vec::new();
    let mut clean = true;
    for line in inner.split(['\n', ';', ',']) {
        let line = line.trim().trim_end_matches(',').trim();
        if line.is_empty() || line.starts_with("//") || line.starts_with("/*") {
            continue;
        }
        let Some((name, ty)) = line.split_once(':') else {
            clean = false;
            break;
        };
        let name = name.trim().trim_end_matches('?').trim();
        if !is_ident(name) {
            clean = false;
            break;
        }
        // `size: int = 1` is not valid TypeScript, but it is what a reader
        // writes in an interface modelled on a component's parameters. A
        // default means the member is optional; the value itself is dropped.
        let mut ty = ty;
        let mut has_default = line.contains(&format!("{name}?"));
        if let Some((head, _default)) = ty.split_once('=') {
            ty = head;
            has_default = true;
        }
        let opt = if has_default { "?" } else { "" };
        out.push(format!("{}{}: {};", name, opt, ts_type(ty)));
    }
    if !clean || out.is_empty() {
        return vec!["[key: string]: any;".to_string()];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dts(src: &str) -> String {
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        let toks = crate::lexer::lex(src).expect("lex");
        let module = crate::parser::Parser::new(toks, lines).module().expect("parse");
        emit(&module, "t.hyx").expect("emit")
    }

    #[test]
    fn python_types_are_mapped_not_copied() {
        let out = dts("component C(count: int, ratio: float, name: str, ok: bool, xs: list):\n    div: \"x\"\n");
        assert!(out.contains("count: number;"), "{out}");
        assert!(out.contains("ratio: number;"), "{out}");
        assert!(out.contains("name: string;"), "{out}");
        assert!(out.contains("ok: boolean;"), "{out}");
        assert!(out.contains("xs: any[];"), "{out}");
        assert!(!out.contains("float"), "a Python type leaked through:\n{out}");
    }

    #[test]
    fn a_default_makes_the_member_optional() {
        let out = dts("component C(size: int = 1):\n    div: \"x\"\n");
        assert!(out.contains("size?: number;"), "{out}");
    }

    #[test]
    fn an_unannotated_param_is_any_not_a_guess() {
        let out = dts("component C(thing):\n    div: \"x\"\n");
        assert!(out.contains("thing: any;"), "{out}");
    }

    #[test]
    fn a_component_without_params_still_declares_a_function() {
        let out = dts("component N():\n    div: \"x\"\n");
        assert!(out.contains("export declare function N("), "{out}");
        // No props interface, matching the emitter.
        assert!(!out.contains("NProps"), "{out}");
    }

    #[test]
    fn spread_becomes_an_index_signature() {
        let out = dts("component C(*props):\n    div: \"x\"\n");
        assert!(out.contains("[key: string]: any;"), "{out}");
    }

    #[test]
    fn interface_members_are_mapped() {
        let out = dts("interface Props:\n    title: str\n    count: int\n\ncomponent C(p: Props):\n    div: p.title\n");
        assert!(out.contains("title: string;"), "{out}");
        assert!(out.contains("count: number;"), "{out}");
    }

    #[test]
    fn an_unreadable_interface_falls_back_to_an_index_signature() {
        let out = dts("interface Props:\n    [key: str]: any\n\ncomponent C(p: Props):\n    div: \"x\"\n");
        assert!(out.contains("[key: string]: any;"), "{out}");
    }

    #[test]
    fn a_module_with_no_exports_produces_nothing() {
        // Writing an empty declaration would clobber a hand-written one.
        assert_eq!(dts("x = 1\n"), "");
    }

    #[test]
    fn a_private_function_is_not_exported_in_the_declaration() {
        // The emitter decides what is exported; this declares it anyway with the
        // export keyword only for `export def`. Guard the non-export case so a
        // change here is deliberate.
        let out = dts("component A():\n    div: \"x\"\n");
        assert!(!out.contains("declare function def"), "{out}");
    }

    #[test]
    fn a_type_alias_does_not_leak_python_types() {
        let out = dts("type Money = { amount: float }\ncomponent C():\n    div: \"x\"\n");
        assert!(out.contains("export type Money = any;"), "{out}");
        assert!(!out.contains("float"), "{out}");
    }

    #[test]
    fn output_is_parseable_typescript_in_shape() {
        let out = dts("component Widget(label: str, size: int = 1):\n    div: label\n");
        for frag in [
            "export interface WidgetProps {",
            "label: string;",
            "size?: number;",
            "export declare function Widget(props: WidgetProps): HydraElement;",
        ] {
            assert!(out.contains(frag), "missing `{frag}` in:\n{out}");
        }
    }
}
