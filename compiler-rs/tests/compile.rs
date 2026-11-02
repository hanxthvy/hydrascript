// [xihanzu-NR]
//! End-to-end integration tests for the HydraScript compiler.
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
    assert_contains(
        &out,
        &[
            "<div>",
            "<span>x</span>",
            "<span>y</span>",
            "</div>",
            "<p>z</p>",
        ],
    );
}

#[test]
fn test_lexer_comment_stripping() {
    let src = "# top comment\ncomponent A(): # inline comment\n    # body comment\n    div: \"x\" # trailing\n";
    let out = comp(src);
    assert_contains(&out, &["export function A()", "<div>x</div>"]);
    assert_not_contains(
        &out,
        &["top comment", "inline comment", "body comment", "trailing"],
    );
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
    assert_contains(
        &out,
        &[
            "(a === b)",
            "(c !== d)",
            "(e <= f)",
            "(g >= h)",
            "x += 1;",
            "x -= 1;",
            "x *= 2;",
            "x /= 2;",
        ],
    );
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
    assert_contains(
        &out,
        &[
            "const x = ((1 + (2 * 3)) - py_mod((4 / 2), 3));",
            "const y = (-x);",
            "const z = (-1);",
        ],
    );
}

#[test]
fn test_expr_string_methods() {
    let src = "component A():\n    a = s.strip()\n    b = s.upper()\n    c = s.lower()\n    d = s.startswith(\"x\")\n    e = s.endswith(\"y\")\n    f = s.replace(\"a\", \"b\")\n    g = s.find(\"x\")\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "const a = s.trim();",
            "const b = s.toUpperCase();",
            "const c = s.toLowerCase();",
            "const d = s.startsWith(\"x\");",
            "const e = s.endsWith(\"y\");",
            "const f = s.replaceAll(\"a\", \"b\");",
            "const g = s.indexOf(\"x\");",
        ],
    );
}

#[test]
fn test_expr_python_builtins() {
    let src = "component A():\n    a = len(xs)\n    b = str(x)\n    c = int(x)\n    d = float(x)\n    e = abs(x)\n    f = round(x)\n    g = sum(xs)\n    h = sorted(xs)\n    i = reversed(xs)\n    j = list(xs)\n    k = bool(x)\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "const a = len_of(xs);",
            "const b = String(x);",
            // `int`/`float` raise like Python instead of truncating a bad
            // string, `round` rounds a tie to even, and `bool`/`sorted` use
            // Python's truthiness and numeric ordering.
            "const c = int(x);",
            "const d = float(x);",
            "const e = Math.abs(x);",
            "const f = round_py(x);",
            "const g = xs.reduce((a, b) => a + b, 0);",
            "const h = sorted(xs);",
            "const i = xs.slice().reverse();",
            "const j = xs.slice();",
            "const k = truthy(x);",
        ],
    );
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
    assert_contains(
        &out,
        &["const ys = xs.filter((x) => (x > 1)).map((x) => (x * 2));"],
    );
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
    // Bare name -> Python truthiness (an empty list is truthy in JS).
    assert_contains(&out, &["{truthy(a) && (<p>yes</p>)}"]);
}

#[test]
fn test_tree_if_else_to_ternary() {
    let out = comp("component A():\n    div:\n        if a:\n            p: \"yes\"\n        else:\n            p: \"no\"\n");
    assert_contains(&out, &["{truthy(a) ? (<p>yes</p>) : (<p>no</p>)}"]);
}

#[test]
fn test_tree_elif_chain_no_nested_braces() {
    let out = comp("component A():\n    div:\n        if a:\n            p: \"1\"\n        elif b:\n            p: \"2\"\n        else:\n            p: \"3\"\n");
    // Must NOT emit nested braces like `{a ? x : {b ? y : z}}`
    assert_contains(&out, &["{truthy(a) ? (<p>1</p>) : (truthy(b) ? (<p>2</p>) : (<p>3</p>))}"]);
    assert_not_contains(&out, &[": {"]);
}

#[test]
fn test_tree_for_to_map() {
    let out = comp(
        "component A():\n    ul:\n        for item in items:\n            li(key=item): item\n",
    );
    assert_contains(
        &out,
        &["{items.map((item) => (<li key={item}>{item}</li>))}"],
    );
}

#[test]
fn test_tree_for_multiple_children_fragment() {
    let out = comp("component A():\n    div:\n        for x in xs:\n            span: \"a\"\n            span: \"b\"\n");
    assert_contains(
        &out,
        &[
            "{xs.map((x) => (<>",
            "<span>a</span>",
            "<span>b</span>",
            "</>))}",
        ],
    );
}

// =========================================================================
// 6. COMPONENTS, PROPS, TYPES
// =========================================================================

#[test]
fn test_component_props_interface_and_types() {
    let src = "component Btn(label: str, count: int = 0, on_click=None):\n    button: label\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "export function Btn({ label, count = 0, on_click }: BtnProps)",
            "export interface BtnProps {",
            "label: string;",
            "count?: number;",
            "on_click?: any;",
        ],
    );
    assert_not_contains(&out, &["label?:", "= null"]);
}

#[test]
fn test_component_generic_and_union_types() {
    let src = "component C(x: list[str], y: dict[str, int], a: str | None):\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "x: Array<string>;",
            "y: Record<string, number>;",
            "a: string | null;",
        ],
    );
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
    assert_contains(&out, &["const x = 1;", "let [a, b] = pair();"]);
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
    assert_contains(&out, &["let x = 0;", "x += 1;"]);
}

#[test]
fn test_stmt_level_if_and_for() {
    let src = "component A():\n    if a:\n        go()\n    for x in xs:\n        run(x)\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(
        &out,
        &["if (truthy(a)) {", "go();", "for (const x of xs) {", "run(x);"],
    );
}

// =========================================================================
// 8. IMPORTS
// =========================================================================

#[test]
fn test_imports_from_and_bare() {
    let src =
        "from hydra import state, effect\nimport hydra\n\ncomponent A():\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "import hydra from 'hydra';",
            "import { state, effect } from 'hydra';",
        ],
    );
}

#[test]
fn test_imports_deduplicated_and_sorted() {
    let src = "from b_module import b\nfrom a_module import a\nfrom b_module import b\n\ncomponent A():\n    div: \"z\"\n";
    let out = comp(src);
    let import_lines: Vec<_> = out.lines().filter(|l| l.starts_with("import ")).collect();
    assert_eq!(
        import_lines,
        vec![
            "import { a } from 'a_module';",
            "import { b } from 'b_module';",
        ]
    );
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
    assert_contains(&out, &["const a = [];", "const b = ({});", "const c = [];"]);
}

#[test]
fn test_edge_case_deeply_nested_trees() {
    let src = "component A():\n    div:\n        section:\n            ul:\n                li:\n                    span:\n                        em: \"deep\"\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "<div>",
            "<section><ul><li><span><em>deep</em></span></li></ul></section>",
            "</div>",
        ],
    );
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
    assert_contains(&out, &["const café = 1;", "<div>日本語 café ünïcode</div>"]);
}

#[test]
fn test_edge_case_very_long_attribute_list() {
    let src = "component A():\n    div(cls=\"a\", id=\"b\", title=\"c\", role=\"d\", tab_index=1, on_click=go, data_x=\"e\", aria_label=\"f\"):\n        span: \"z\"\n";
    let out = comp(src);
    assert_contains(&out, &[
        "<div className=\"a\" id=\"b\" title=\"c\" role=\"d\" tabIndex={1} onClick={go} data-x=\"e\" aria-label=\"f\"><span>z</span></div>",
    ]);
}

#[test]
fn test_edge_case_component_with_many_props() {
    let src = "component Big(a: str, b: int, c: float, d: bool, e: list[str], f: dict[str, int], g: str | None, h=None, i: int = 3):\n    div: \"z\"\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
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
        ],
    );
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
    assert_contains(
        &out,
        &["<ul>{xs.map((i) => (i * 2)).map((x) => (<li>{x}</li>))}</ul>"],
    );
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
    assert_not_contains(
        &out,
        &["# top", "# inside", "# inline", "# after", "# file"],
    );
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
    let src = r#"from hydra import state

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
    assert_contains(
        &out,
        &[
            "export function TodoApp()",
            "let [todos, set_todos] = state([\"Belajar Python\", \"Bikin Framework\"]);",
            "let [text, set_text] = state(\"\");",
            "const count = len_of(todos);",
            "const add_todo = () => {",
            "set_todos([...todos, ...[text]]);",
            "<div className=\"max-w-md mx-auto\">",
            "<h1>{`Total: ${count}`}</h1>",
            "<li key={item}>{item}</li>",
        ],
    );

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
    assert_contains(
        &out,
        &["function countdown(n) {", "while ((n > 0)) {", "n -= 1;"],
    );
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
    assert_contains(
        &out,
        &[
            "import { ValueError, int } from 'hydra';",
            "try {",
            "catch (__err) {",
            "if (__err instanceof ValueError) {",
            "const e = __err;",
            "return null;",
            "finally {",
            "console.log(\"done\");",
        ],
    );
}

#[test]
fn test_hx_async_def_and_await() {
    let src = "async def fetch_user(id):\n    res = await fetch(f\"/api/{id}\")\n    return await res.json()\n";
    let out = comp_hx(src);
    assert_contains(
        &out,
        &[
            "async function fetch_user(id) {",
            "const res = await fetch(`/api/${id}`);",
            "return await res.json();",
        ],
    );
}

#[test]
fn test_hx_export() {
    let src = "export def add(a: int, b: int) -> int:\n    return a + b\nexport PI = 3.14\n";
    let out = comp_hx(src);
    assert_contains(
        &out,
        &["export function add(a, b) {", "export const PI = 3.14;"],
    );
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
    assert_contains(
        &err1.msg,
        &["`component App` is not available in a .hx file"],
    );

    let err2 = comp_hx_err("div:\n    span: \"x\"\n");
    assert_contains(&err2.msg, &["a tree block is not available in a .hx file"]);
}

#[test]
fn test_hx_modern_js_features() {
    let src = "def test_modern():\n    name = user?.name\n    item = items?.[0]\n    val = a ?? b\n    { title, content } = props\n    if \"admin\" in roles:\n        return True\n";
    let out = comp_hx(src);
    assert_contains(
        &out,
        &[
            "const name = user?.name;",
            "const item = items?.[0];",
            "const val = (a ?? b);",
            "const { title, content } = props;",
            "contains(roles, \"admin\")",
        ],
    );
    assert_not_contains(&out, &["const ({ title, content })"]);
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
    assert_contains(
        &out,
        &[
            "(status === \"loading\") ? (<span>Loading...</span>)",
            ": (status === \"error\") ? (<span className=\"text-red\">Failed</span>)",
            ": (<span>Ready</span>)",
        ],
    );
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
    assert_contains(
        &out,
        &[
            "switch (status) {",
            "case \"ok\": {",
            "return 200;",
            "case \"not_found\": {",
            "return 404;",
            "default: {",
            "return 500;",
        ],
    );
}

#[test]
fn test_feature_cls_conditional_dict() {
    let src = r#"component Button(is_active: bool, is_disabled: bool):
    button(cls={"btn": True, "active": is_active, "opacity-50": is_disabled}): "Click"
"#;
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "import { cx } from 'hydra';",
            "className={cx(({\"btn\": true, \"active\": is_active, \"opacity-50\": is_disabled}))}",
        ],
    );
}

#[test]
fn test_feature_cls_conditional_list() {
    let src = r#"component Card(highlight: bool):
    div(cls=["card-base", "border-blue-500" if highlight else "border-gray-200"]): "Content"
"#;
    let out = comp(src);
    assert_contains(&out, &[
        "import { cx } from 'hydra';",
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
    assert_contains(
        &out,
        &[
            "onSubmit={(e: any) => { e.preventDefault(); (on_submit)(e); }}",
            "onClick={(e: any) => { e.stopPropagation(); (on_click)(e); }}",
        ],
    );
}

#[test]
fn test_feature_auto_fragment_multiple_roots() {
    let src = r#"component MultiRoot():
    h1: "Title"
    p: "Subtitle"
    div: "Content"
"#;
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "return (",
            "<>",
            "<h1>Title</h1>",
            "<p>Subtitle</p>",
            "<div>Content</div>",
            "</>",
        ],
    );
}

#[test]
fn test_feature_cli_run() {
    let tmp_dir = std::env::temp_dir();
    let script_path = tmp_dir.join("test_run.hys");
    std::fs::write(
        &script_path,
        "def add(a, b):\n    return a + b\nprint(f\"result={add(20, 22)}\")\n",
    )
    .unwrap();
    let code = hydra::cli::run_script(&[script_path.to_string_lossy().to_string()]);
    assert_eq!(code, std::process::ExitCode::SUCCESS);
    let _ = std::fs::remove_file(&script_path);

    // Test backward compatibility with .hs
    let legacy_script = tmp_dir.join("test_run_legacy.hs");
    std::fs::write(
        &legacy_script,
        "def sub(a, b):\n    return a - b\nprint(f\"result={sub(50, 8)}\")\n",
    )
    .unwrap();
    let legacy_code = hydra::cli::run_script(&[legacy_script.to_string_lossy().to_string()]);
    assert_eq!(legacy_code, std::process::ExitCode::SUCCESS);
    let _ = std::fs::remove_file(&legacy_script);
}

#[test]
fn test_feature_opt_chaining_and_nullish() {
    let src = "component A():\n    name = user?.name\n    item = items?.[0]\n    val = a ?? b\n    div: name\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "const name = user?.name;",
            "const item = items?.[0];",
            "const val = (a ?? b);",
        ],
    );
}

#[test]
fn test_feature_destructuring_assignment() {
    let src = "component A():\n    { title, content } = props\n    div: title\n";
    let out = comp(src);
    assert_contains(&out, &["const { title, content } = props;"]);
    assert_not_contains(&out, &["const ({ title, content })"]);
}

#[test]
fn test_feature_bracketed_destructuring_declares() {
    // `[n, set_n] = useState(0)` is the idiom React's own docs teach for hooks,
    // and the bracketed form parses as a LIST, not a tuple. It used to emit a
    // bare assignment with no binding — `[n, set_n] = useState(0)` — which is a
    // ReferenceError at runtime. Written to the emitter's `Kind::List` arm after
    // a real React 19 project failed the runtime gate with `n is not defined`
    // while the build reported success.
    let out = comp("component A():\n    [n, set_n] = useState(0)\n    div: f\"{n}\"\n");
    assert_contains(&out, &["const [n, set_n] = useState(0);"]);
    assert_not_contains(&out, &["\n  [n, set_n] = useState(0);"]);
}

#[test]
fn test_bracketed_destructuring_binds_every_name() {
    // More than two, and mixed with a call, so the fix is not narrowly "two
    // names plus a call".
    let out = comp("component A():\n    [a, b, c] = triple()\n    div: f\"{a}{b}{c}\"\n");
    assert_contains(&out, &["const [a, b, c] = triple();"]);
}

#[test]
fn test_a_list_literal_assignment_is_untouched() {
    // The fix must not turn a real list assignment into a destructuring one.
    let out = comp("component A():\n    xs = [1, 2]\n    div: f\"{xs}\"\n");
    assert_contains(&out, &["const xs = [1, 2];"]);
}

#[test]
fn test_swap_stays_a_plain_assignment() {
    // Both names already bound: a re-assignment, not a declaration, and
    // `let [a, b] = [b, a]` over existing bindings is a SyntaxError.
    let out = comp("component A():\n    a, b = 1, 2\n    a, b = b, a\n    div: f\"{a}{b}\"\n");
    assert_contains(&out, &["let [a, b] = [1, 2];", "[a, b] = [b, a];"]);
}

#[test]
fn test_dict_methods_become_runtime_calls_not_js_methods() {
    // `d.keys()` on a plain object used to emit `d.keys()` — a JS method call —
    // which is `d.keys is not a function` at runtime. `hydra check` stayed
    // silent and the runtime gate only noticed when the line actually ran, so a
    // method inside an event handler shipped broken. Found by auditing dict
    // method calls against a real build.
    let out = comp("component A():\n    d = {\"a\": 1}\n    n = len(d.keys())\n    div: f\"{n}\"\n");
    assert_contains(&out, &["dict_keys(d)"]);
    assert_not_contains(&out, &["d.keys()"]);
}

#[test]
fn test_dict_values_and_items_are_helpers_too() {
    let out = comp(
        "component A():\n    d = {\"a\": 1}\n    a = len(d.values())\n    b = len(d.items())\n    div: f\"{a}{b}\"\n",
    );
    assert_contains(&out, &["dict_values(d)", "dict_items(d)"]);
    // `.items()` used to become `.entries()`, which is also not a method on a
    // plain object; and it returned pairs only by accident of the JS API.
    assert_not_contains(&out, &["d.entries()", "d.values()"]);
}

#[test]
fn test_dict_helpers_are_imported_from_the_runtime() {
    let out = comp("component A():\n    d = {\"a\": 1}\n    n = len(d.keys())\n    div: f\"{n}\"\n");
    assert_contains(&out, &["from 'hydra'"]);
    assert_contains(&out, &["dict_keys"]);
}

#[test]
fn test_feature_in_operator() {
    let src = "component A():\n    if \"admin\" in roles:\n        span: \"Admin\"\n";
    let out = comp(src);
    assert_contains(&out, &["contains(roles, \"admin\")"]);
}

#[test]
fn test_feature_jsx_spread_and_svg_and_compound() {
    let src = r#"component Icon(*props):
    svg(className="icon", *props):
        path(d="M0 0 L10 10", stroke_width=2)
    Tabs.List(className="tab-list"):
        Tabs.Trigger(value="1"): "Tab 1"
"#;
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "<svg {...props} className=\"icon\">",
            "<path d=\"M0 0 L10 10\"",
            "<Tabs.List className=\"tab-list\">",
            "<Tabs.Trigger value=\"1\">Tab 1</Tabs.Trigger>",
        ],
    );
}

#[test]
fn test_feature_hsx_slice_and_await() {
    let src =
        "component A():\n    sub = items[1:3]\n    res = await fetchData()\n    div: \"ok\"\n";
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "const sub = items.slice(1, 3);",
            "const res = await fetchData();",
        ],
    );
}

#[test]
fn test_feature_aria_and_data_attributes() {
    let src = r#"component Button():
    button(aria_label="Close", aria_expanded=True, data_testid="btn-close", data_custom_val="123"): "X"
"#;
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "aria-label=\"Close\"",
            "aria-expanded={true}",
            "data-testid=\"btn-close\"",
            "data-custom-val=\"123\"",
        ],
    );
}

#[test]
fn test_feature_jsx_double_star_spread() {
    let src = r#"component Wrapper(**props):
    div(**props): "content"
"#;
    let out = comp(src);
    assert_contains(&out, &["<div {...props}>content</div>"]);
}

// [xihanzu-NR]
#[test]
fn test_react_capabilities_svg_namespaced_spread_aria() {
    let src = r#"component ReactCapabilities(*svg_props, **tab_props):
    svg(viewBox="0 0 100 100", *svg_props, aria_label="Chart graphic"):
        g(className="chart-group", aria_hidden=False):
            circle(cx=50, cy=50, r=40, aria_label="Outer circle")
            path(d="M 10 10 L 90 90", stroke_width=2)
    Tabs.List(className="tab-nav", aria_label="Main tabs", **tab_props):
        Tabs.Trigger(value="1", aria_selected=True, aria_controls="panel-1"): "Tab 1"
        Tabs.Trigger(value="2", aria_selected=False, aria_controls="panel-2"): "Tab 2"
"#;
    let out = comp(src);
    assert_contains(&out, &[
        "export function ReactCapabilities({ ...svg_props, ...tab_props }: ReactCapabilitiesProps) {",
        "<svg {...svg_props} viewBox=\"0 0 100 100\" aria-label=\"Chart graphic\">",
        "<g className=\"chart-group\" aria-hidden={false}>",
        "<circle cx={50} cy={50} r={40} aria-label=\"Outer circle\" />",
        "<path d=\"M 10 10 L 90 90\" stroke_width={2} />",
        "<Tabs.List {...tab_props} className=\"tab-nav\" aria-label=\"Main tabs\">",
        "<Tabs.Trigger value=\"1\" aria-selected={true} aria-controls=\"panel-1\">Tab 1</Tabs.Trigger>",
        "<Tabs.Trigger value=\"2\" aria-selected={false} aria-controls=\"panel-2\">Tab 2</Tabs.Trigger>",
    ]);
}

#[test]
fn test_feature_comprehension_tuple_target() {
    let src = "component A():\n    vals = [v for k, v in items]\n    div: \"ok\"\n";
    let out = comp(src);
    assert_contains(&out, &["const vals = items.map(([k, v]) => v);"]);
}

#[test]
fn test_error_tab_indentation() {
    let src = "component A():\n\tdiv: \"tab\"\n";
    let err = compile(src, "App.hsx").expect_err("should reject tabs");
    assert_contains(&err.msg, &["tab indentation is not allowed"]);
}

#[test]
fn test_error_unclosed_brace_fstring() {
    let src = "component A():\n    div: f\"hello {world\"\n";
    let err = compile(src, "App.hsx").expect_err("should reject unclosed brace");
    assert_contains(&err.msg, &["unclosed '{' in f-string"]);
}

#[test]
fn test_error_recursion_depth_limit() {
    let nested = format!(
        "component A():\n    x = {}1{}\n",
        // Beyond MAX_DEPTH but well short of what a stack overflow needs.
        "(".repeat(200),
        ")".repeat(200)
    );
    let err = compile(&nested, "App.hsx").expect_err("should reject deep nesting");
    assert_contains(&err.msg, &["maximum recursion depth exceeded"]);
}

#[test]
fn test_multiline_component_and_attributes() {
    let src = r#"component Card(
        title: str,
        count: int = 0,
        is_active: bool = False,
    ):
        div(
            cls={
                "btn": True,
                "active": is_active,
            },
            id="main-card",
        ):
            h1: title
"#;
    let out = comp(src);
    assert_contains(
        &out,
        &[
            "export function Card({ title, count = 0, is_active = false }: CardProps)",
            "className={cx(({\"btn\": true, \"active\": is_active}))}",
            "id=\"main-card\"",
            "<h1>{title}</h1>",
        ],
    );
}

#[test]
fn test_feature_interface_declaration() {
    let src = "interface UserProps:\n    name: str\n    age: int\n    email: str\n";
    let (code, _) = compile(src, "test.hsx").expect("compilation failed");
    assert_contains(
        &code,
        &[
            "export interface UserProps {",
            "name",
            "string",
            "age",
            "number",
            "email",
            "}",
        ],
    );
}

#[test]
fn test_feature_type_alias() {
    let src = "type OrderStatus = 'pending' | 'completed' | 'failed'\n";
    let (code, _) = compile(src, "test.hsx").expect("compilation failed");
    assert_contains(
        &code,
        &["export type OrderStatus = 'pending' | 'completed' | 'failed';"],
    );
}

#[test]
fn test_feature_typeof_operator() {
    let src = "component A():\n    if typeof x == 'string':\n        div: \"yes\"\n";
    let out = comp(src);
    assert_contains(&out, &["typeof x"]);
}

#[test]
fn test_feature_import_type() {
    let src = "from '../types' import type AmAccountResult, AlightLinkItem\n\ncomponent A():\n    div: \"ok\"\n";
    let out = comp(src);
    assert_contains(&out, &["AmAccountResult, AlightLinkItem", "'../types'"]);
}

#[test]
fn test_feature_import_as_alias() {
    let src = "from 'lucide-react' import Image as ImageIcon, Download\n\ncomponent A():\n    div: \"ok\"\n";
    let out = comp(src);
    assert_contains(&out, &["Image as ImageIcon", "Download"]);
}

#[test]
fn test_feature_dict_comprehension_tuple_target() {
    // `{k: v for k, v in pairs}` used to fail to parse with
    // `expected Kw("in"), found Comma` while the list form worked, because
    // the dict/set comprehension tail read a single identifier. The list path
    // grew tuple targets first and the others silently lagged.
    let src = "component A():\n    d = {k: v for k, v in pairs}\n    div: \"ok\"\n";
    let out = comp(src);
    assert_contains(
        &out,
        &["Object.fromEntries(pairs.map(([k, v]) => [k , v]))"],
    );
}

#[test]
fn test_feature_dict_comprehension_tuple_target_filtered() {
    let src =
        "component A():\n    d = {k: v for k, v in pairs if v > 0}\n    div: \"ok\"\n";
    let out = comp(src);
    assert_contains(
        &out,
        &["Object.fromEntries(pairs.filter(([k, v]) => (v > 0)).map(([k, v]) => [k , v]))"],
    );
}

#[test]
fn test_feature_set_comprehension_tuple_target() {
    let src = "component A():\n    s = {k for k, v in pairs}\n    div: \"ok\"\n";
    let out = comp(src);
    assert_contains(&out, &["new Set(pairs.map(([k, v]) => k))"]);
}

#[test]
fn test_feature_comprehension_parenthesised_tuple_target() {
    let src = "component A():\n    x = [v for (k, v) in items]\n    div: \"ok\"\n";
    let out = comp(src);
    assert_contains(&out, &["items.map(([k, v]) => v)"]);
}

// ------------------------------------------------------------------ f-strings
// The format spec used to be dropped silently: `f"{amount:.2f}"` compiled to
// `${amount}`, so money rendered as `1500` where the author wrote `1500.00`.
// These tests pin the translation, and pin that what cannot be translated is a
// compile error rather than a quiet wrong string.

#[test]
fn test_fstring_precision_is_translated() {
    let src = "component A(amount: float):\n    div: f\"{amount:.2f}\"\n";
    // `py_fixed`, not `toFixed`: Python rounds a tie to the even digit and
    // `toFixed` rounds it away from zero, so `1500.5` would print `1501` where
    // Python prints `1500`.
    assert_contains(
        &comp(src),
        &["py_fixed(amount, 2)", "from 'hydra'"],
    );
}

#[test]
fn test_fstring_grouping_and_precision_together() {
    let src = "component A(amount: float):\n    div: f\"Rp {amount:,.0f}\"\n";
    let out = comp(src);
    // Grouping happens in the runtime, on the already-rounded digits, so it
    // cannot disagree with the rounding on which tie it kept.
    assert_contains(&out, &["py_group(amount, 0)", "Rp "]);
    assert_not_contains(&out, &["toLocaleString"]);
}

#[test]
fn test_fstring_precision_survives_a_long_expression() {
    let src = "component A(p: float):\n    div: f\"{Math.max(0.0, 1 - p / 0.34):.3f}\"\n";
    assert_contains(&comp(src), &["py_fixed(Math.max(0.0, (1 - (p / 0.34))), 3)"]);
}

#[test]
fn test_fstring_spec_after_a_dict_index() {
    // The `:` here is inside `['a']`, so it must not be read as the separator.
    let src = "component A(d: dict):\n    div: f\"{d['a']:>5}\"\n";
    assert_contains(&comp(src), &["padStart(5"]);
}

#[test]
fn test_fstring_conversion_becomes_string() {
    let src = "component A(x: int):\n    div: f\"{x!r}\"\n";
    assert_contains(&comp(src), &["${String(x)}"]);
}

#[test]
fn test_fstring_unsupported_spec_is_an_error_not_a_silent_drop() {
    let src = "component A(x: int):\n    div: f\"{x:08.3e}\"\n";
    let err = comp_err(src);
    let text = err.pretty();
    assert!(
        text.contains("unsupported format spec"),
        "expected a spec error, got: {text}"
    );
}

#[test]
fn test_fstring_percent_type() {
    let src = "component A(ratio: float):\n    div: f\"{ratio:.1%}\"\n";
    assert_contains(&comp(src), &["* 100).toFixed(1)", "+ '%'"]);
}

#[test]
fn test_fstring_spaces_inside_braces_are_allowed() {
    // Python allows `{ x }`; this used to fail with "unexpected Indent".
    let src = "component A(x: int):\n    div: f\"{ x }\"\n";
    assert_contains(&comp(src), &["`${x}`"]);
}

// A dotted call is an element only for `motion.<tag>`. Treating any uppercase
// object as an element dropped the receiver: `SignupSchema.safeParse({...})`
// was emitted as a JSX element, so `safeParse` ran with `this === undefined`
// and threw at runtime while the build reported success.
#[test]
fn test_dotted_call_keeps_its_receiver() {
    let src = "from \"zod\" import z\nS = z.safeParse({\"a\": 1})\ncomponent A():\n    div: \"x\"\n";
    let out = comp(src);
    assert_contains(&out, &["z.safeParse("]);
    assert!(
        !out.contains("<z.safeParse"),
        "receiver was turned into a JSX element:\n{out}"
    );
}

#[test]
fn test_motion_element_still_compiles_as_an_element() {
    let src = "component A():\n    motion.div(animate={\"x\": 1}):\n        span: \"child\"\n";
    let out = comp(src);
    assert_contains(&out, &["<motion.div"]);
    assert_contains(&out, &["</motion.div>"]);
}

#[test]
fn test_method_call_on_an_uppercase_object_is_a_call() {
    let src = "component A():\n    def go():\n        Math.max(1, 2)\n        console.log(\"x\")\n    div: \"y\"\n";
    let out = comp(src);
    assert_contains(&out, &["Math.max(1, 2)"]);
    assert_contains(&out, &["console.log(\"x\")"]);
}

// [xihanzu-NR]
// ---------------------------------------------------------------- super()

/// `super().method()` on a parent that is not `__init__`.
///
/// This used to be a PARSE ERROR — "unexpected Dot" — so no form of a parent
/// method call worked. It was recorded as a limitation of keyword arguments,
/// which understated it: the keyword handling was never reached.
#[test]
fn super_method_call_emits_super_dot_name() {
    let src = "class Base:\n    def greet(self, name):\n        return name\nclass Kid(Base):\n    def hi(self):\n        return super().greet(\"x\")\n";
    let out = comp(src);
    assert_contains(&out, &[r#"super.greet("x")"#]);
    assert_not_contains(&out, &["super.__init__", "super().greet"]);
}

/// The constructor spelling keeps working: `super().__init__(x)` is a bare
/// `super(x)` in JS, never `super.__init__(x)`.
#[test]
fn super_init_stays_a_bare_super_call() {
    let src = "class Base:\n    def __init__(self, a):\n        self.a = a\nclass Kid(Base):\n    def __init__(self, a):\n        super().__init__(a)\n";
    let out = comp(src);
    assert_contains(&out, &["super(a);"]);
    assert_not_contains(&out, &["super.__init__"]);
}

/// `super` is not a value in JS, so a member access without a call is an error
/// with a hint, not silently-emitted nonsense.
#[test]
fn super_member_without_a_call_is_rejected() {
    let src = "class Base:\n    def __init__(self):\n        self.a = 1\nclass Kid(Base):\n    def hi(self):\n        return super().a\n";
    let e = comp_err(src);
    assert!(e.msg.contains("super"), "{}", e.msg);
}

/// Python snake_case method names are spelled the same in JS, and the member
/// path must not mangle them: `__init__` is the only special case.
#[test]
fn super_method_snake_case_name_is_preserved() {
    let src = "class Base:\n    def render_text(self):\n        return \"x\"\nclass Kid(Base):\n    def hi(self):\n        return super().render_text()\n";
    let out = comp(src);
    assert_contains(&out, &["super.render_text()"]);
}

// [xihanzu-NR]
// ---------------------------------------------- keyword args across files

/// Keyword arguments now work for a function imported from a RELATIVE file.
///
/// They used to be refused everywhere except the same file, and the limitation
/// list said the signature "cannot be seen" — true of a package, and never
/// checked for a project file, which is the common case.
#[test]
fn keyword_args_work_for_a_relative_import() {
    let dir = std::env::temp_dir().join(format!("hydra-kw-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("lib.hys"),
        "export def greet(name, loud=False):\n    return name\n",
    )
    .unwrap();
    let main = dir.join("use.hyx");
    std::fs::write(
        &main,
        "from \"./lib.hys\" import greet\ncomponent A():\n    div(): greet(loud=True, name=\"x\")\n",
    )
    .unwrap();
    let src = std::fs::read_to_string(&main).unwrap();
    // `compile` takes the source and the filename; the filename carries the
    // directory, which is how a relative specifier is resolved.
    let (out, _) = hydra::compile(&src, main.to_str().unwrap()).expect("compiles");
    assert_contains(&out, &["greet(\"x\", true)"]);
    std::fs::remove_dir_all(&dir).ok();
}

/// A misspelled keyword against an imported function names the parameters that
/// DO exist, instead of a generic refusal.
#[test]
fn unknown_keyword_on_a_relative_import_lists_the_real_parameters() {
    let dir = std::env::temp_dir().join(format!("hydra-kw-bad-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("lib.hys"), "export def greet(name, loud=False):\n    return name\n").unwrap();
    let main = dir.join("use.hyx");
    std::fs::write(&main, "from \"./lib.hys\" import greet\ncomponent A():\n    div(): greet(nama=\"x\")\n").unwrap();
    let src = std::fs::read_to_string(&main).unwrap();
    let e = hydra::compile(&src, main.to_str().unwrap()).expect_err("should fail");
    assert!(e.msg.contains("nama"), "{}", e.msg);
    let hint = e.hint.clone().unwrap_or_default();
    assert!(hint.contains("name") && hint.contains("loud"), "{hint}");
    std::fs::remove_dir_all(&dir).ok();
}

/// A package import still cannot be reordered, and says which of the two
/// reasons applies rather than blaming "this file".
#[test]
fn keyword_args_on_a_package_import_say_why() {
    let src = "from \"some-pkg\" import thing\ncomponent A():\n    div(): thing(a=1)\n";
    let e = comp_err(src);
    assert!(e.msg.contains("relative"), "{}", e.msg);
}

/// A METHOD call with keyword arguments, when exactly one class in the file
/// declares that name. The receiver's type is not tracked, so the one-candidate
/// case is what can be resolved honestly.
#[test]
fn keyword_args_work_for_a_method_with_one_candidate() {
    let src = "class Greeter:\n    def greet(self, name, loud=False):\n        return name\ncomponent A():\n    g = Greeter()\n    div(): g.greet(loud=True, name=\"x\")\n";
    let out = comp(src);
    assert_contains(&out, &["g.greet(\"x\", true)"]);
}

/// `super().method(kw=...)` goes through the same lookup.
#[test]
fn keyword_args_work_through_super() {
    let src = "class Base:\n    def greet(self, name, loud=False):\n        return name\nclass Kid(Base):\n    def hi(self):\n        return super().greet(loud=True, name=\"x\")\n";
    let out = comp(src);
    assert_contains(&out, &["super.greet(\"x\", true)"]);
}

/// Two classes declaring the same method name: the receiver decides, and this
/// compiler does not know it, so the answer is a refusal rather than a guess
/// that would be right half the time.
#[test]
fn keyword_args_on_an_ambiguous_method_are_refused() {
    let src = "class A:\n    def greet(self, name):\n        return name\nclass B:\n    def greet(self, other):\n        return other\ncomponent C():\n    x = A()\n    div(): x.greet(name=\"y\")\n";
    let e = comp_err(src);
    assert!(e.msg.contains("method"), "{}", e.msg);
}

/// The README's error-handling example, as an executable contract.
///
/// `class MyError(Exception)` and `raise ValueError("x")` are both documented.
/// They were both broken in the same way: the base class and the raise were
/// emitted as names nothing defines, so the module threw
/// `ReferenceError: Exception is not defined` on LOAD and `raise ValueError(...)`
/// became a JSX element (`<ValueError>bad</ValueError>`). The tests here are on
/// the EMITTED JS, because both failures compiled cleanly and failed later.
#[test]
fn python_exception_classes_are_imported_and_constructed() {
    let src = "class MyError(Exception):\n    pass\n\ncomponent X():\n    raise MyError(\"bad\")\n";
    let out = comp(src);
    assert!(
        out.contains("import { Exception, raise_ } from 'hydra'"),
        "the base must be imported, got:\n{out}"
    );
    assert!(out.contains("class MyError extends Exception"), "got:\n{out}");
    assert!(out.contains("new MyError("), "a class call constructs, got:\n{out}");
}

#[test]
fn raise_a_builtin_exception_constructs_it() {
    let src = "component X():\n    raise ValueError(\"bad value\")\n";
    let out = comp(src);
    assert!(
        out.contains("raise_(new ValueError(\"bad value\"))"),
        "`raise ValueError(\"x\")` must be a construction, not a JSX element, got:\n{out}"
    );
    assert!(
        out.contains("ValueError") && out.contains("from 'hydra'"),
        "the class must be imported, got:\n{out}"
    );
    assert!(
        !out.contains("<ValueError>"),
        "it must not be an element, got:\n{out}"
    );
}

#[test]
fn except_a_builtin_exception_names_an_imported_class() {
    let src = "component X():\n    try:\n        pass\n    except KeyError as e:\n        pass\n";
    let out = comp(src);
    assert!(out.contains("KeyError"), "got:\n{out}");
    assert!(
        out.contains("from 'hydra'"),
        "the handler's class must be imported, got:\n{out}"
    );
}

#[test]
fn a_user_class_shadows_the_runtime_exception_of_the_same_name() {
    // Two declarations of one identifier does not parse. Emitting the import
    // AND the class declaration produced
    // `SyntaxError: Identifier 'ValueError' has already been declared`.
    let src = "class ValueError(Exception):\n    pass\n\ncomponent X():\n    raise ValueError(\"mine\")\n";
    let out = comp(src);
    assert!(out.contains("class ValueError extends Exception"), "got:\n{out}");
    assert!(
        !out.contains("import { ValueError"),
        "the user's class wins; it must not also be imported, got:\n{out}"
    );
}

// =========================================================================
// 12. PYTHON SEMANTICS THE JS BUILTIN GETS WRONG
//
// Every case below produced a GREEN build and a wrong value, which is worse
// than a rejection: nothing threw, so nothing pointed at the source line. They
// are grouped because they share one cause — an operator or builtin with a
// near-identical JS spelling that means something else.
// =========================================================================

#[test]
fn sorted_goes_through_the_runtime_so_numbers_compare_numerically() {
    // `.sort()` with no comparator compares STRING forms:
    // [10, 9, 100] -> [10, 100, 9]. Silent, green, wrong.
    let out = comp("component A():\n    a = sorted(xs)\n");
    assert_contains(&out, &["const a = sorted(xs);"]);
    assert!(
        !out.contains(".slice().sort()"),
        "the bare sort must not be emitted, got:\n{out}"
    );
}

#[test]
fn modulo_takes_the_sign_of_the_divisor_like_python() {
    // Python: -7 % 3 == 2. JS: -1. A ring index lands one cell off, silently.
    let out = comp("component A():\n    r = a % b\n");
    assert_contains(&out, &["py_mod(a, b)"]);
}

#[test]
fn a_negative_literal_index_counts_from_the_end() {
    // `xs[-1]` is the last element in Python and `undefined` in JS.
    let out = comp("component A():\n    a = xs[-1]\n    b = xs[i]\n");
    assert_contains(&out, &["py_at(xs, (-1))"]);
    assert_contains(&out, &["xs[i]"]);
}

#[test]
fn multiplying_a_literal_string_repeats_it() {
    // `"ab" * 3` is NaN in JS and "ababab" in Python.
    let out = comp("component A():\n    a = \"ab\" * 3\n    b = s * 2\n");
    assert_contains(&out, &["py_repeat(\"ab\", 3)"]);
    // A VARIABLE on the left is not statically knowable, so it keeps the numeric
    // meaning. Rewriting it would break every `price * qty` in the language.
    assert_contains(&out, &["(s * 2)"]);
}

#[test]
fn max_and_min_of_one_sequence_do_not_spread_it() {
    // `max(xs)` spread the argument, so a Set or a generator was NaN.
    let out = comp("component A():\n    a = max(xs)\n    b = min(xs)\n    c = max(1, 2)\n");
    assert_contains(&out, &["max_of(xs)", "min_of(xs)", "Math.max(1, 2)"]);
}

#[test]
fn int_and_float_raise_instead_of_truncating_a_bad_string() {
    // parseInt("12px") is 12; Python raises. A corrupt number that travels.
    let out = comp("component A():\n    a = int(s)\n    b = float(s)\n");
    assert_contains(&out, &["int(s)", "float(s)"]);
    assert!(
        !out.contains("parseInt"),
        "parseInt truncates silently, got:\n{out}"
    );
}

#[test]
fn bool_uses_python_truthiness_not_js_truthiness() {
    // Boolean([]) is true; bool([]) is False.
    let out = comp("component A():\n    a = bool(xs)\n");
    assert_contains(&out, &["truthy(xs)"]);
}

#[test]
fn round_rounds_a_tie_to_even() {
    // Math.round(2.5) is 3; round(2.5) is 2.
    let out = comp("component A():\n    a = round(x)\n    b = round(x, 2)\n");
    assert_contains(&out, &["round_py(x)", "round_to(x, 2)"]);
    assert!(
        !out.contains("Math.round"),
        "Math.round rounds ties away from zero, got:\n{out}"
    );
}

#[test]
fn every_emitted_helper_is_exported_by_the_runtime() {
    // The compiler injects `import { name } from 'hydra'` for names it invents.
    // A name the runtime does not export is a green build and a ReferenceError.
    // scripts/helper-contract.mjs walks the Rust source; this asserts the list
    // its own cases produce is non-empty, so a compile change that stops
    // recording a helper fails here rather than at run time.
    let out = comp(
        "component A():\n    a = int(x)\n    b = round(x)\n    c = sorted(xs)\n    d = max(xs)\n    e = bool(x)\n    f = \"ab\" * 2\n    g = xs[-1]\n    h = x % 3\n",
    );
    assert_contains(
        &out,
        &["import { int, max_of, py_at, py_mod, py_repeat, round_py, sorted, truthy } from 'hydra';"],
    );
}

#[test]
fn comparing_two_sequences_compares_by_value() {
    // `[1, 2] == [1, 2]` is false in JS, true in Python. A guard that tests a
    // list for equality silently took the wrong branch.
    let out = comp("component A():\n    a = [1, 2] == [1, 2]\n    b = x == 1\n");
    assert_contains(&out, &["py_eq([1, 2], [1, 2])", "(x === 1)"]);
}

#[test]
fn not_on_a_literal_sequence_uses_python_truthiness() {
    // `not []` is True in Python and `![]` is false.
    let out = comp("component A():\n    a = not []\n    b = not x\n");
    assert_contains(&out, &["(!truthy([]))", "(!x)"]);
}

#[test]
fn an_exponent_is_part_of_a_number_literal() {
    // `1e3` used to lex as the number 1 followed by the identifier `e3`.
    let out = comp("component A():\n    a = 1e3\n    b = 1.5e-2\n");
    assert_contains(&out, &["const a = 1e3;", "const b = 1.5e-2;"]);
}

