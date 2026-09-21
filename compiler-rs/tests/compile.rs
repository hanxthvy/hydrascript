// [xihanzu-NR]
//! End-to-end integration tests for the Serpent compiler.
//!
//! Mirrors the reference Python test suite and extends it with all required
//! edge cases: Unicode identifiers, Windows paths, CRLF line endings, nested
//! lambdas, deep trees, and f-string escapes.

use hydra::{compile, CompileError};

fn comp(src: &str) -> String {
    let (code, _) = compile(src, "test.hsx").expect("compilation failed");
    code
}

fn comp_err(src: &str) -> CompileError {
    compile(src, "test.hsx").expect_err("expected compilation error")
}

fn assert_contains(out: &str, frags: &[&str]) {
    for f in frags {
        assert!(
            out.contains(f),
            "expected output to contain {:?}\n\nfull output:\n{}",
            f,
            out
        );
    }
}

fn assert_not_contains(out: &str, frags: &[&str]) {
    for f in frags {
        assert!(
            !out.contains(f),
            "expected output NOT to contain {:?}\n\nfull output:\n{}",
            f,
            out
        );
    }
}

// =========================================================================
// 1. LEXER BEHAVIOURS END-TO-END
// =========================================================================

#[test]
fn test_lexer_indent_dedent_balance() {
    let src = "component A():\n    div:\n        span: \"x\"\n        span: \"y\"\n    p: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &["<div>", "<span>x</span>", "<span>y</span>", "</div>", "<p>z</p>"]);
}

#[test]
fn test_lexer_comment_stripping() {
    let src = "# top comment\ncomponent A(): # inline comment\n    # body comment\n    div: \"x\" # trailing\n";
    let out = comp(src);
    assert_contains(&out, &["export function A()", "<div>x</div>"]);
    assert_not_contains(&out, &["top comment", "inline comment", "body comment", "trailing"]);
}

#[test]
fn test_lexer_blank_line_skipping() {
    let src = "\n\ncomponent A():\n\n    div:\n\n        span: \"x\"\n\n";
    let out = comp(src);
    assert_contains(&out, &["export function A()", "<span>x</span>"]);
}

#[test]
fn test_lexer_inconsistent_indent_error() {
    let err = comp_err("component A():\n    div:\n  span: \"x\"\n");
    assert!(err.msg.contains("indentation"), "error was: {}", err.msg);
    assert!(err.hint.is_some());
}

#[test]
fn test_lexer_string_escapes() {
    let src = "component A():\n    div: \"a\\\"b\\\\c\"\n";
    let out = comp(src);
    assert_contains(&out, &["a\\\"b\\\\c"]);
}

#[test]
fn test_lexer_fstring_basic() {
    let src = "component A():\n    div: f\"hi {name}\"\n";
    let out = comp(src);
    assert_contains(&out, &["`hi ${name}`"]);
}

#[test]
fn test_lexer_two_and_three_char_operators() {
    let src = "component A():\n    if a == b and c != d and e <= f and g >= h:\n        x += 1\n        x -= 1\n        x *= 2\n        x /= 2\n        p: \"y\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "(a === b)",
        "(c !== d)",
        "(e <= f)",
        "(g >= h)",
        "x += 1;",
        "x -= 1;",
        "x *= 2;",
        "x /= 2;",
    ]);
}

#[test]
fn test_lexer_unexpected_character_error() {
    let err = comp_err("component A():\n    div:\n        x = ~~~\n");
    assert!(
        err.msg.contains("unexpected character") || err.msg.contains("unexpected"),
        "error was: {}",
        err.msg
    );
    assert_eq!(err.line, 3);
}

// =========================================================================
// 2. EXPRESSIONS
// =========================================================================

#[test]
fn test_expr_comparisons_strict() {
    let out1 = comp("component A():\n    if x == 1:\n        p: \"y\"\n");
    assert_contains(&out1, &["(x === 1)"]);

    let out2 = comp("component A():\n    if x != 1:\n        p: \"y\"\n");
    assert_contains(&out2, &["(x !== 1)"]);
}

#[test]
fn test_expr_boolean_operators() {
    let out = comp("component A():\n    if a and b or not c:\n        p: \"y\"\n");
    assert_contains(&out, &["((a && b) || (!c))"]);
}

#[test]
fn test_expr_lambda_to_arrow() {
    let out = comp("component A():\n    button(on_click=lambda: go()): \"x\"\n");
    assert_contains(&out, &["onClick={(() => go())}"]);

    let out2 = comp("component A():\n    button(on_click=lambda e: go(e.target.value)): \"x\"\n");
    assert_contains(&out2, &["((e) => go(e.target.value))"]);
}

#[test]
fn test_expr_ternary() {
    let out = comp("component A():\n    p: \"y\" if a else \"n\"\n");
    assert_contains(&out, &["(a ? \"y\" : \"n\")"]);
}

#[test]
fn test_expr_all_arithmetic_and_unary_minus() {
    let src = "component A():\n    x = 1 + 2 * 3 - 4 / 2 % 3\n    y = -x\n    z = -1\n";
    let out = comp(src);
    assert_contains(&out, &[
        "const x = ((1 + (2 * 3)) - ((4 / 2) % 3));",
        "const y = (-x);",
        "const z = (-1);",
    ]);
}

#[test]
fn test_expr_string_methods() {
    let src = "component A():\n    a = s.strip()\n    b = s.upper()\n    c = s.lower()\n    d = s.startswith(\"x\")\n    e = s.endswith(\"y\")\n    f = s.replace(\"a\", \"b\")\n    g = s.find(\"x\")\n";
    let out = comp(src);
    assert_contains(&out, &[
        "const a = s.trim();",
        "const b = s.toUpperCase();",
        "const c = s.toLowerCase();",
        "const d = s.startsWith(\"x\");",
        "const e = s.endsWith(\"y\");",
        "const f = s.replaceAll(\"a\", \"b\");",
        "const g = s.indexOf(\"x\");",
    ]);
}

#[test]
fn test_expr_python_builtins() {
    let src = "component A():\n    a = len(xs)\n    b = str(x)\n    c = int(x)\n    d = float(x)\n    e = abs(x)\n    f = round(x)\n    g = sum(xs)\n    h = sorted(xs)\n    i = reversed(xs)\n    j = list(xs)\n    k = bool(x)\n";
    let out = comp(src);
    assert_contains(&out, &[
        "const a = xs.length;",
        "const b = String(x);",
        "const c = parseInt(x);",
        "const d = parseFloat(x);",
        "const e = Math.abs(x);",
        "const f = Math.round(x);",
        "const g = xs.reduce((a, b) => a + b, 0);",
        "const h = xs.slice().sort();",
        "const i = xs.slice().reverse();",
        "const j = xs.slice();",
        "const k = Boolean(x);",
    ]);
}

// =========================================================================
// 3. LIST COMPREHENSIONS
// =========================================================================

#[test]
fn test_list_comprehension_map_form() {
    let out = comp("component A():\n    ys = [x * 2 for x in xs]\n");
    assert_contains(&out, &["const ys = xs.map((x) => (x * 2));"]);
}

#[test]
fn test_list_comprehension_filter_only_form() {
    let out = comp("component A():\n    ys = [x for x in xs if x > 1]\n");
    assert_contains(&out, &["const ys = xs.filter((x) => (x > 1));"]);
    assert_not_contains(&out, &[".map"]);
}

#[test]
fn test_list_comprehension_filter_and_map_form() {
    let out = comp("component A():\n    ys = [x * 2 for x in xs if x > 1]\n");
    assert_contains(&out, &["const ys = xs.filter((x) => (x > 1)).map((x) => (x * 2));"]);
}

// =========================================================================
// 4. TREE BLOCKS
// =========================================================================

#[test]
fn test_tree_nested_elements() {
    let src = "component A():\n    div:\n        h1: \"Hello\"\n        p: \"World\"\n";
    let out = comp(src);
    assert_contains(&out, &["<div>", "<h1>Hello</h1>", "<p>World</p>", "</div>"]);
}

#[test]
fn test_tree_class_and_cls_rename() {
    let out1 = comp("component A():\n    div(cls=\"my-class\"):\n        span: \"y\"\n");
    assert_contains(&out1, &["className=\"my-class\""]);
    assert_not_contains(&out1, &["className={\"my-class\"}"]);

    let out2 = comp("component A():\n    div(class=\"my-class\"):\n        span: \"y\"\n");
    assert_contains(&out2, &["className=\"my-class\""]);
}

#[test]
fn test_tree_self_closing_and_empty_blocks() {
    let out1 = comp("component A():\n    input(value=x, on_change=go)\n");
    assert_contains(&out1, &["<input value={x} onChange={go} />"]);

    let out2 = comp("component A():\n    br:\n");
    assert_contains(&out2, &["<br />"]);

    let out3 = comp("component A():\n    div():\n");
    assert_contains(&out3, &["<div />"]);
}

#[test]
fn test_tree_inline_single_child() {
    let out = comp("component A():\n    h1: \"Title\"\n");
    assert_contains(&out, &["<h1>Title</h1>"]);
}

// =========================================================================
// 5. CONTROL FLOW IN TREES
// =========================================================================

#[test]
fn test_tree_if_to_logical_and() {
    let out = comp("component A():\n    div:\n        if a:\n            p: \"yes\"\n");
    assert_contains(&out, &["{a && (<p>yes</p>)}"]);
}

#[test]
fn test_tree_if_else_to_ternary() {
    let out = comp("component A():\n    div:\n        if a:\n            p: \"yes\"\n        else:\n            p: \"no\"\n");
    assert_contains(&out, &["{a ? (<p>yes</p>) : (<p>no</p>)}"]);
}

#[test]
fn test_tree_elif_chain_no_nested_braces() {
    let out = comp("component A():\n    div:\n        if a:\n            p: \"1\"\n        elif b:\n            p: \"2\"\n        else:\n            p: \"3\"\n");
    // Must NOT emit nested braces like `{a ? x : {b ? y : z}}`
    assert_contains(&out, &["{a ? (<p>1</p>) : (b ? (<p>2</p>) : (<p>3</p>))}"]);
    assert_not_contains(&out, &[": {"]);
}

#[test]
fn test_tree_for_to_map() {
    let out = comp("component A():\n    ul:\n        for item in items:\n            li(key=item): item\n");
    assert_contains(&out, &["{items.map((item) => (<li key={item}>{item}</li>))}"]);
}

#[test]
fn test_tree_for_multiple_children_fragment() {
    let out = comp("component A():\n    div:\n        for x in xs:\n            span: \"a\"\n            span: \"b\"\n");
    assert_contains(&out, &[
        "{xs.map((x) => (<>",
        "<span>a</span>",
        "<span>b</span>",
        "</>))}",
    ]);
}

// =========================================================================
// 6. COMPONENTS, PROPS, TYPES
// =========================================================================

#[test]
fn test_component_props_interface_and_types() {
    let src = "component Btn(label: str, count: int = 0, on_click=None):\n    button: label\n";
    let out = comp(src);
    assert_contains(&out, &[
        "export function Btn({ label, count = 0, on_click }: BtnProps)",
        "export interface BtnProps {",
        "label: string;",
        "count?: number;",
        "on_click?: any;",
    ]);
    assert_not_contains(&out, &["label?:", "= null"]);
}

#[test]
fn test_component_generic_and_union_types() {
    let src = "component C(x: list[str], y: dict[str, int], a: str | None):\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "x: Array<string>;",
        "y: Record<string, number>;",
        "a: string | null;",
    ]);
}

#[test]
fn test_component_no_props() {
    let out = comp("component NoProps():\n    div: \"z\"\n");
    assert_contains(&out, &["export function NoProps() {"]);
    assert_not_contains(&out, &["NoPropsProps"]);
}

// =========================================================================
// 7. STATEMENTS
// =========================================================================

#[test]
fn test_stmt_assign_and_tuple_unpack() {
    let src = "component A():\n    x = 1\n    a, b = pair()\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &["const x = 1;", "const [a, b] = pair();"]);
}

#[test]
fn test_stmt_def_to_arrow_fn() {
    let src = "component A():\n    def go():\n        x()\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &["const go = () => {", "x();", "};"]);
}

#[test]
fn test_stmt_aug_assign() {
    let src = "component A():\n    x = 0\n    x += 1\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &["const x = 0;", "x += 1;"]);
}

#[test]
fn test_stmt_level_if_and_for() {
    let src = "component A():\n    if a:\n        go()\n    for x in xs:\n        run(x)\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "if (a) {",
        "go();",
        "for (const x of xs) {",
        "run(x);",
    ]);
}

// =========================================================================
// 8. IMPORTS
// =========================================================================

#[test]
fn test_imports_from_and_bare() {
    let src = "from serpent import state, effect\nimport serpent\n\ncomponent A():\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "import serpent from 'serpent';",
        "import { state, effect } from 'serpent';",
    ]);
}

#[test]
fn test_imports_deduplicated_and_sorted() {
    let src = "from b_module import b\nfrom a_module import a\nfrom b_module import b\n\ncomponent A():\n    div: \"z\"\n";
    let out = comp(src);
    let import_lines: Vec<_> = out.lines().filter(|l| l.starts_with("import ")).collect();
    assert_eq!(import_lines, vec![
        "import { a } from 'a_module';",
        "import { b } from 'b_module';",
    ]);
}

// =========================================================================
// 9. ERRORS AND DIAGNOSTICS
// =========================================================================

#[test]
fn test_error_line_number_and_caret_rendering() {
    let err = comp_err("component A():\n    div:\n        bogus ~~~ : \"x\"\n");
    assert_eq!(err.line, 3);
    let pretty = err.pretty();
    assert!(pretty.contains("line 3"), "pretty was:\n{}", pretty);
    assert!(pretty.contains("^"), "pretty had no caret:\n{}", pretty);
}

#[test]
fn test_error_def_inside_tree_rejected_with_hint() {
    let src = "component A():\n    div:\n        for x in xs:\n            def bad():\n                y()\n";
    let err = comp_err(src);
    assert!(
        err.msg.contains("not allowed inside a tree block"),
        "error msg: {}",
        err.msg
    );
    assert!(err.hint.is_some(), "hint was missing");
}

#[test]
fn test_error_return_inside_tree_rejected() {
    let src = "component A():\n    div:\n        return 1\n";
    let err = comp_err(src);
    assert!(
        err.msg.contains("not allowed inside a tree block"),
        "error msg: {}",
        err.msg
    );
}

// =========================================================================
// 10. SOURCE MAP
// =========================================================================

#[test]
fn test_sourcemap_version_sources_and_segments() {
    let src = "component A():\n    div: \"x\"\n";
    let (code, map) = compile(src, "A.hsx").expect("compile failed");

    assert!(map.contains("\"version\":3"));
    assert!(map.contains("\"file\":\"A.tsx\""));
    assert!(map.contains("\"sources\":[\"A.hsx\"]"));
    assert!(map.contains("\"sourcesContent\":[\"component A():\\n    div: \\\"x\\\"\\n\"]"));

    // One segment per generated line
    let marker = "\"mappings\":\"";
    let start = map.find(marker).unwrap() + marker.len();
    let end = map[start..].find('"').unwrap() + start;
    let seg_count = map[start..end].split(';').count();
    let code_line_count = code.split('\n').count();
    assert_eq!(seg_count, code_line_count);
}

// =========================================================================
// 11. REQUIRED EDGE CASES
// =========================================================================

#[test]
fn test_edge_case_empty_collections() {
    let src = "component A():\n    a = []\n    b = {}\n    c = ()\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "const a = [];",
        "const b = ({});",
        "const c = [];",
    ]);
}

#[test]
fn test_edge_case_deeply_nested_trees() {
    let src = "component A():\n    div:\n        section:\n            ul:\n                li:\n                    span:\n                        em: \"deep\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "<div>",
        "<section><ul><li><span><em>deep</em></span></li></ul></section>",
        "</div>",
    ]);
}

#[test]
fn test_edge_case_fstring_escaped_braces() {
    let src = "component A():\n    div: f\"{{literal}}\"\n";
    let out = comp(src);
    assert_contains(&out, &["`{literal}`"]);
    assert_not_contains(&out, &["${literal}"]);
}

#[test]
fn test_edge_case_fstring_with_backtick() {
    let src = "component A():\n    div: f\"a`b {x}\"\n";
    let out = comp(src);
    assert_contains(&out, &["`a\\`b ${x}`"]);
}

#[test]
fn test_edge_case_fstring_with_dollar_interpolation() {
    let src = "component A():\n    div: f\"cost: ${price}\"\n";
    let out = comp(src);
    assert_contains(&out, &["`cost: \\$${price}`"]);
}

#[test]
fn test_edge_case_unicode_in_strings_and_identifiers() {
    let src = "component A():\n    café = 1\n    div: \"日本語 café ünïcode\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "const café = 1;",
        "<div>日本語 café ünïcode</div>",
    ]);
}

#[test]
fn test_edge_case_very_long_attribute_list() {
    let src = "component A():\n    div(cls=\"a\", id=\"b\", title=\"c\", role=\"d\", tab_index=1, on_click=go, data_x=\"e\", aria_label=\"f\"):\n        span: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "<div className=\"a\" id=\"b\" title=\"c\" role=\"d\" tabIndex={1} onClick={go} data_x=\"e\" aria_label=\"f\"><span>z</span></div>",
    ]);
}

#[test]
fn test_edge_case_component_with_many_props() {
    let src = "component Big(a: str, b: int, c: float, d: bool, e: list[str], f: dict[str, int], g: str | None, h=None, i: int = 3):\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "export function Big({ a, b, c, d, e, f, g, h, i = 3 }: BigProps)",
        "export interface BigProps {",
        "a: string;",
        "b: number;",
        "c: number;",
        "d: boolean;",
        "e: Array<string>;",
        "f: Record<string, number>;",
        "g: string | null;",
        "h?: any;",
        "i?: number;",
    ]);
}

#[test]
fn test_edge_case_nested_lambdas() {
    let src = "component A():\n    f = lambda x: lambda y: x + y\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &["const f = ((x) => ((y) => (x + y)));"]);
}

#[test]
fn test_edge_case_list_comprehension_inside_tree() {
    let src = "component A():\n    ul:\n        for x in [i * 2 for i in xs]:\n            li: x\n";
    let out = comp(src);
    assert_contains(&out, &[
        "<ul>{xs.map((i) => (i * 2)).map((x) => (<li>{x}</li>))}</ul>",
    ]);
}

#[test]
fn test_edge_case_key_prop_in_for_loop() {
    let src = "component A():\n    ul:\n        for it in items:\n            li(key=it): it\n";
    let out = comp(src);
    assert_contains(&out, &["<li key={it}>{it}</li>"]);
    assert_not_contains(&out, &["key={key}"]);
}

#[test]
fn test_edge_case_comments_in_every_position() {
    let src = "# top comment\ncomponent A():\n    # inside component\n    div:\n        # inside tree\n        span: \"z\"  # inline comment\n    # after tree\n# file end\n";
    let out = comp(src);
    assert_contains(&out, &["export function A()", "<span>z</span>"]);
    assert_not_contains(&out, &["# top", "# inside", "# inline", "# after", "# file"]);
}

#[test]
fn test_edge_case_crlf_line_endings() {
    let src = "component A():\r\n    div:\r\n        span: \"hello\"\r\n";
    let out = comp(src);
    assert_contains(&out, &["export function A()", "<span>hello</span>"]);
}

#[test]
fn test_edge_case_no_trailing_newline() {
    let src = "component A():\n    div: \"z\"";
    let out = comp(src);
    assert_contains(&out, &["export function A()", "<div>z</div>"]);
}

#[test]
fn test_edge_case_windows_style_paths() {
    let src = "component A():\n    div: \"z\"\n";
    let (_, map) = compile(src, "C:\\Users\\alice\\project\\App.hsx").expect("compile failed");

    // Must be valid JSON and have backslashes properly escaped
    assert!(map.contains("\"file\":\"C:\\\\Users\\\\alice\\\\project\\\\App.tsx\""));
    assert!(map.contains("\"sources\":[\"C:\\\\Users\\\\alice\\\\project\\\\App.hsx\"]"));
}

#[test]
fn test_balanced_full_todo_app() {
    let src = r#"from serpent import state

component TodoApp():
    todos, set_todos = state(["Belajar Python", "Bikin Framework"])
    text, set_text = state("")
    count = len(todos)

    def add_todo():
        if text.strip():
            set_todos(todos + [text])
            set_text("")

    div(cls="max-w-md mx-auto"):
        h1: f"Total: {count}"
        input(value=text, on_change=lambda e: set_text(e.target.value))
        if count == 0:
            p: "Empty"
        else:
            ul:
                for item in todos:
                    li(key=item): item
"#;
    let out = comp(src);
    assert_contains(&out, &[
        "export function TodoApp()",
        "const [todos, set_todos] = state([\"Belajar Python\", \"Bikin Framework\"]);",
        "const [text, set_text] = state(\"\");",
        "const count = todos.length;",
        "const add_todo = () => {",
        "set_todos([...todos, ...[text]]);",
        "<div className=\"max-w-md mx-auto\">",
        "<h1>{`Total: ${count}`}</h1>",
        "<li key={item}>{item}</li>",
    ]);

    // Balance checks
    assert_eq!(out.matches('{').count(), out.matches('}').count());
    assert_eq!(out.matches('(').count(), out.matches(')').count());
    assert_not_contains(&out, &["lambda", "None", " def "]);
}

// =========================================================================
// 8. .HX JAVASCRIPT TARGET TESTS
// =========================================================================

fn comp_hx(src: &str) -> String {
    let (code, _) = compile(src, "script.hx").expect("compilation failed");
    code
}

fn comp_hx_err(src: &str) -> CompileError {
    compile(src, "script.hx").expect_err("expected compilation error")
}

#[test]
fn test_hx_while_loop() {
    let src = "def countdown(n: int):\n    while n > 0:\n        n -= 1\n";
    let out = comp_hx(src);
    assert_contains(&out, &["function countdown(n) {", "while ((n > 0)) {", "n -= 1;"]);
}

#[test]
fn test_hx_break_continue_pass() {
    let src = "def test_loop(xs):\n    for x in xs:\n        if x == 1:\n            continue\n        if x == 2:\n            break\n        pass\n";
    let out = comp_hx(src);
    assert_contains(&out, &["continue;", "break;", "/* pass */"]);
}

#[test]
fn test_hx_try_except_finally() {
    let src = "def parse(s):\n    try:\n        return int(s)\n    except ValueError as e:\n        return None\n    finally:\n        print(\"done\")\n";
    let out = comp_hx(src);
    assert_contains(&out, &[
        "import { ValueError, int } from 'serpent-js';",
        "try {",
        "catch (__err) {",
        "if (__err instanceof ValueError) {",
        "const e = __err;",
        "return null;",
        "finally {",
        "console.log(\"done\");",
    ]);
}

#[test]
fn test_hx_async_def_and_await() {
    let src = "async def fetch_user(id):\n    res = await fetch(f\"/api/{id}\")\n    return await res.json()\n";
    let out = comp_hx(src);
    assert_contains(&out, &[
        "async function fetch_user(id) {",
        "const res = await fetch(`/api/${id}`);",
        "return await res.json();",
    ]);
}

#[test]
fn test_hx_export() {
    let src = "export def add(a: int, b: int) -> int:\n    return a + b\nexport PI = 3.14\n";
    let out = comp_hx(src);
    assert_contains(&out, &[
        "export function add(a, b) {",
        "export const PI = 3.14;",
    ]);
}

#[test]
fn test_hx_slice() {
    let src = "def sub(xs):\n    return xs[1:5]\n";
    let out = comp_hx(src);
    assert_contains(&out, &["xs.slice(1, 5)"]);
}

#[test]
fn test_hx_rejects_component_and_tree() {
    let err1 = comp_hx_err("component App():\n    div: \"x\"\n");
    assert_contains(&err1.msg, &["`component App` is not available in a .hx file"]);

    let err2 = comp_hx_err("div:\n    span: \"x\"\n");
    assert_contains(&err2.msg, &["a tree block is not available in a .hx file"]);
}

// =========================================================================
// 9. SUPERIOR HSX FEATURES (MATCH/CASE, CLS SHORTHAND, EVENT MODIFIERS, AUTO-FRAGMENT)
// =========================================================================

#[test]
fn test_feature_match_case_in_tree() {
    let src = r#"component StatusBadge(status: str):
    div(cls="badge"):
        match status:
            case "loading":
                span: "Loading..."
            case "error":
                span(cls="text-red"): "Failed"
            case _:
                span: "Ready"
"#;
    let out = comp(src);
    assert_contains(&out, &[
        "(status === \"loading\") ? (<span>Loading...</span>)",
        ": (status === \"error\") ? (<span className=\"text-red\">Failed</span>)",
        ": (<span>Ready</span>)",
    ]);
}

#[test]
fn test_feature_match_case_statement() {
    let src = r#"def get_code(status: str) -> int:
    match status:
        case "ok":
            return 200
        case "not_found":
            return 404
        case _:
            return 500
"#;
    let out = comp_hx(src);
    assert_contains(&out, &[
        "switch (status) {",
        "case \"ok\": {",
        "return 200;",
        "case \"not_found\": {",
        "return 404;",
        "default: {",
        "return 500;",
    ]);
}

#[test]
fn test_feature_cls_conditional_dict() {
    let src = r#"component Button(is_active: bool, is_disabled: bool):
    button(cls={"btn": True, "active": is_active, "opacity-50": is_disabled}): "Click"
"#;
    let out = comp(src);
    assert_contains(&out, &[
        "import { cx } from 'serpent';",
        "className={cx(({\"btn\": true, \"active\": is_active, \"opacity-50\": is_disabled}))}",
    ]);
}

#[test]
fn test_feature_cls_conditional_list() {
    let src = r#"component Card(highlight: bool):
    div(cls=["card-base", "border-blue-500" if highlight else "border-gray-200"]): "Content"
"#;
    let out = comp(src);
    assert_contains(&out, &[
        "import { cx } from 'serpent';",
        "className={cx([\"card-base\", (highlight ? \"border-blue-500\" : \"border-gray-200\")])}",
    ]);
}

#[test]
fn test_feature_event_modifiers() {
    let src = r#"component Form():
    def on_submit(e):
        pass
    def on_click(e):
        pass
    form(on_submit_prevent=on_submit):
        button(on_click_stop=on_click): "Submit"
"#;
    let out = comp(src);
    assert_contains(&out, &[
        "onSubmit={(e: any) => { e.preventDefault(); (on_submit)(e); }}",
        "onClick={(e: any) => { e.stopPropagation(); (on_click)(e); }}",
    ]);
}

#[test]
fn test_feature_auto_fragment_multiple_roots() {
    let src = r#"component MultiRoot():
    h1: "Title"
    p: "Subtitle"
    div: "Content"
"#;
    let out = comp(src);
    assert_contains(&out, &[
        "return (",
        "<>",
        "<h1>Title</h1>",
        "<p>Subtitle</p>",
        "<div>Content</div>",
        "</>",
    ]);
}
