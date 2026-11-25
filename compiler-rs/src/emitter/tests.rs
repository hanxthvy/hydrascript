//! Unit tests for the emitter, kept out of the production files.
use super::*;
use crate::ast::{Kind, Node};
use crate::error::CompileError;
use super::element::node_uses_slot;

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


#[cfg(test)]
mod import_read_tests {
    use super::super::imports::imported_fn_params;
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
