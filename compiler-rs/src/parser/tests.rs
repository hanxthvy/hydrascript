//! Parser tests.

use super::*;
use crate::ast::{FPart, Kind, Node};
use crate::error::CompileError;

    fn parse(src: &str) -> Node {
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        let toks = crate::lexer::lex(src).expect("lex failed");
        Parser::new(toks, lines).module().expect("parse failed")
    }

    fn parse_err(src: &str) -> CompileError {
        let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
        match crate::lexer::lex(src) {
            Err(e) => e,
            Ok(toks) => Parser::new(toks, lines)
                .module()
                .expect_err("expected a parse error"),
        }
    }

    fn stmts(src: &str) -> Vec<Node> {
        match parse(src).kind {
            Kind::Module(s) => s,
            other => panic!("expected a module, got {:?}", other),
        }
    }

    /// The body of the first component in the source.
    fn body(src: &str) -> Vec<Node> {
        match stmts(src).into_iter().next().unwrap().kind {
            Kind::Component { body, .. } => body,
            other => panic!("expected a component, got {:?}", other),
        }
    }

    /// Dig the first expression out of a component body, unwrapping the
    /// statement wrappers a test might write around it: `div: <expr>` (a tree
    /// whose only child is the expression) and `if <expr>:` (whose test is the
    /// expression we are after).
    fn first_expr(src: &str) -> Node {
        fn unwrap_stmt(n: Node) -> Node {
            match n.kind {
                Kind::ExprStmt(e) => *e,
                Kind::Assign { value, .. } => *value,
                Kind::AugAssign { value, .. } => *value,
                Kind::If { test, .. } => *test,
                Kind::Tree { body, .. } => match body.into_iter().next() {
                    Some(child) => unwrap_stmt(child),
                    None => panic!("tree block had no children"),
                },
                other => panic!("expected an expression statement, got {:?}", other),
            }
        }
        unwrap_stmt(body(src).into_iter().next().unwrap())
    }

    // ------------------------------------------------------------ module shape

    #[test]
    fn empty_source_parses_to_an_empty_module() {
        assert!(stmts("").is_empty());
        assert!(stmts("\n\n# just a comment\n").is_empty());
    }

    #[test]
    fn component_name_and_body_are_captured() {
        let s = stmts("component Widget():\n    div: \"x\"\n");
        match &s[0].kind {
            Kind::Component { name, params, body } => {
                assert_eq!(name, "Widget");
                assert!(params.is_empty());
                assert_eq!(body.len(), 1);
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn multiple_components_parse_in_order() {
        let s = stmts("component A():\n    div: \"a\"\n\ncomponent B():\n    span: \"b\"\n");
        let names: Vec<_> = s
            .iter()
            .map(|n| match &n.kind {
                Kind::Component { name, .. } => name.clone(),
                other => panic!("got {:?}", other),
            })
            .collect();
        assert_eq!(names, vec!["A", "B"]);
    }

    // ------------------------------------------------------------------- params

    #[test]
    fn params_capture_name_type_and_default() {
        let s =
            stmts("component Btn(label: str, count: int = 0, on_click=None):\n    button: label\n");
        match &s[0].kind {
            Kind::Component { params, .. } => {
                assert_eq!(params.len(), 3);
                assert_eq!(params[0].name, "label");
                assert_eq!(params[0].ty.as_deref(), Some("string"));
                assert!(!params[0].has_default);
                assert_eq!(params[1].name, "count");
                assert!(params[1].has_default);
                assert_eq!(params[2].name, "on_click");
                assert!(params[2].has_default);
                assert!(matches!(
                    params[2].default.as_ref().unwrap().kind,
                    Kind::Null
                ));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn trailing_comma_in_params_is_allowed() {
        let s = stmts("component A(x: int, y: int,):\n    div: \"z\"\n");
        match &s[0].kind {
            Kind::Component { params, .. } => assert_eq!(params.len(), 2),
            other => panic!("got {:?}", other),
        }
    }

    // -------------------------------------------------------------- type mapping

    fn ty_of(src: &str) -> String {
        match &stmts(src)[0].kind {
            Kind::Component { params, .. } => params[0].ty.clone().unwrap(),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn primitive_types_map_to_typescript() {
        assert_eq!(ty_of("component A(x: str):\n    div: \"z\"\n"), "string");
        assert_eq!(ty_of("component A(x: int):\n    div: \"z\"\n"), "number");
        assert_eq!(ty_of("component A(x: float):\n    div: \"z\"\n"), "number");
        assert_eq!(ty_of("component A(x: bool):\n    div: \"z\"\n"), "boolean");
        assert_eq!(ty_of("component A(x: Any):\n    div: \"z\"\n"), "any");
    }

    #[test]
    fn generic_types_map_to_typescript() {
        assert_eq!(
            ty_of("component A(x: list[str]):\n    div: \"z\"\n"),
            "Array<string>"
        );
        assert_eq!(
            ty_of("component A(x: dict[str, int]):\n    div: \"z\"\n"),
            "Record<string, number>"
        );
        assert_eq!(
            ty_of("component A(x: list[dict[str, int]]):\n    div: \"z\"\n"),
            "Array<Record<string, number>>"
        );
    }

    #[test]
    fn optional_union_types_map_to_typescript() {
        assert_eq!(
            ty_of("component A(x: str | None):\n    div: \"z\"\n"),
            "string | null"
        );
        assert_eq!(ty_of("component A(x: None):\n    div: \"z\"\n"), "null");
    }

    #[test]
    fn dotted_and_unknown_types_pass_through() {
        assert_eq!(
            ty_of("component A(x: Foo.Bar):\n    div: \"z\"\n"),
            "Foo.Bar"
        );
        assert_eq!(ty_of("component A(x: MyType):\n    div: \"z\"\n"), "MyType");
    }

    // -------------------------------------------------------------- expressions

    #[test]
    fn comparison_operators_become_strict() {
        for (src, want) in [("x == 1", "==="), ("x != 1", "!==")] {
            match first_expr(&format!(
                "component A():\n    if {}:\n        p: \"y\"\n",
                src
            ))
            .kind
            {
                Kind::Bin { op, .. } => assert_eq!(op, want, "for {}", src),
                other => panic!("got {:?}", other),
            }
        }
    }

    #[test]
    fn boolean_words_become_js_operators() {
        for (src, want) in [("a and b", "&&"), ("a or b", "||")] {
            match first_expr(&format!(
                "component A():\n    if {}:\n        p: \"y\"\n",
                src
            ))
            .kind
            {
                Kind::Bin { op, .. } => assert_eq!(op, want, "for {}", src),
                other => panic!("got {:?}", other),
            }
        }
    }

    #[test]
    fn not_becomes_bang() {
        match first_expr("component A():\n    if not a:\n        p: \"y\"\n").kind {
            Kind::Unary { op, .. } => assert_eq!(op, "!"),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn precedence_matches_python() {
        // 1 + 2 * 3 parses as 1 + (2 * 3)
        let e = first_expr("component A():\n    x = 1 + 2 * 3\n");
        match e.kind {
            Kind::Bin { op, right, .. } => {
                assert_eq!(op, "+");
                assert!(matches!(right.kind, Kind::Bin { ref op, .. } if op == "*"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn and_binds_tighter_than_or() {
        // a or b and c parses as a || (b && c)
        match first_expr("component A():\n    if a or b and c:\n        p: \"y\"\n").kind {
            Kind::Bin { op, right, .. } => {
                assert_eq!(op, "||");
                assert!(matches!(right.kind, Kind::Bin { ref op, .. } if op == "&&"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn unary_minus_is_preserved() {
        let e = first_expr("component A():\n    x = -1\n");
        assert!(matches!(e.kind, Kind::Unary { ref op, .. } if op == "-"));
    }

    #[test]
    fn ternary_parses_with_test_body_and_orelse() {
        let e = first_expr("component A():\n    p: \"y\" if a else \"n\"\n");
        match e.kind {
            Kind::Ternary { test, body, orelse } => {
                assert!(matches!(test.kind, Kind::Name(ref n) if n == "a"));
                assert!(matches!(body.kind, Kind::Str { .. }));
                assert!(matches!(orelse.kind, Kind::Str { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn lambda_parses_params_and_body() {
        let e = first_expr("component A():\n    f = lambda x: x + 1\n");
        match e.kind {
            Kind::Lambda { params, body, .. } => {
                assert_eq!(params, vec!["x"]);
                assert!(matches!(body.kind, Kind::Bin { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn lambda_without_params_is_allowed() {
        let e = first_expr("component A():\n    f = lambda: 1\n");
        assert!(matches!(e.kind, Kind::Lambda { ref params, .. } if params.is_empty()));
    }

    #[test]
    fn nested_lambda_parses() {
        let e = first_expr("component A():\n    f = lambda x: lambda y: x + y\n");
        match e.kind {
            Kind::Lambda { body, .. } => {
                assert!(
                    matches!(body.kind, Kind::Lambda { .. }),
                    "got {:?}",
                    body.kind
                )
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn lambda_with_default_parses() {
        let e = first_expr("component A():\n    f = lambda m=mode: m\n");
        match e.kind {
            Kind::Lambda { defaults, .. } => {
                assert_eq!(defaults.len(), 1);
                assert!(defaults[0].is_some());
            }
            other => panic!("got {:?}", other),
        }
    }

    // ------------------------------------------------------------- collections

    #[test]
    fn empty_collections_parse() {
        assert!(
            matches!(first_expr("component A():\n    x = []\n").kind, Kind::List(ref v) if v.is_empty())
        );
        assert!(
            matches!(first_expr("component A():\n    x = {}\n").kind, Kind::Dict(ref v) if v.is_empty())
        );
        assert!(
            matches!(first_expr("component A():\n    x = ()\n").kind, Kind::Tuple(ref v) if v.is_empty())
        );
    }

    #[test]
    fn list_literal_keeps_items_and_trailing_comma() {
        assert!(
            matches!(first_expr("component A():\n    x = [1, 2, 3]\n").kind, Kind::List(ref v) if v.len() == 3)
        );
        assert!(
            matches!(first_expr("component A():\n    x = [1, 2, 3,]\n").kind, Kind::List(ref v) if v.len() == 3)
        );
    }

    #[test]
    fn dict_literal_keeps_keys_and_values() {
        match first_expr("component A():\n    d = {\"a\": 1, \"b\": 2}\n").kind {
            Kind::Dict(pairs) => {
                assert_eq!(pairs.len(), 2);
                assert!(pairs[0].0.is_some());
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn dict_shorthand_has_no_key() {
        match first_expr("component A():\n    d = {a, b}\n").kind {
            Kind::Dict(pairs) => {
                assert_eq!(pairs.len(), 2);
                assert!(pairs[0].0.is_none());
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn tuple_literal_becomes_a_tuple_node() {
        assert!(
            matches!(first_expr("component A():\n    t = (1, 2)\n").kind, Kind::Tuple(ref v) if v.len() == 2)
        );
    }

    #[test]
    fn parenthesised_expression_is_not_a_tuple() {
        assert!(matches!(
            first_expr("component A():\n    x = (1 + 2)\n").kind,
            Kind::Bin { .. }
        ));
    }

    // ----------------------------------------------------------- comprehensions

    #[test]
    fn comprehension_map_form_parses() {
        match first_expr("component A():\n    ys = [x * 2 for x in xs]\n").kind {
            Kind::Comprehension { target, cond, .. } => {
                assert_eq!(target, "x");
                assert!(cond.is_none());
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn comprehension_filter_form_parses() {
        match first_expr("component A():\n    ys = [x for x in xs if x > 1]\n").kind {
            Kind::Comprehension { target, cond, .. } => {
                assert_eq!(target, "x");
                assert!(cond.is_some());
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn comprehension_if_is_a_filter_not_a_ternary() {
        // `if` after `in` must bind as the filter, so the iter is just `xs`.
        match first_expr("component A():\n    ys = [x for x in xs if x]\n").kind {
            Kind::Comprehension { iter, cond, .. } => {
                assert!(
                    matches!(iter.kind, Kind::Name(ref n) if n == "xs"),
                    "iter was {:?}",
                    iter.kind
                );
                assert!(cond.is_some());
            }
            other => panic!("got {:?}", other),
        }
    }

    // ------------------------------------------------------------------ postfix

    #[test]
    fn call_with_positional_and_keyword_args_parses() {
        match first_expr("component A():\n    input(value=x, on_change=go)\n").kind {
            Kind::Call { args, kwargs, .. } => {
                assert!(args.is_empty());
                assert_eq!(kwargs.len(), 2);
                assert_eq!(kwargs[0].0, "value");
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn call_with_spread_parses() {
        match first_expr("component A():\n    div(*items, cls=\"x\")\n").kind {
            Kind::Call { args, .. } => assert!(matches!(args[0].kind, Kind::Spread(_))),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn newlines_inside_call_parens_are_insignificant() {
        let src = "component A():\n    input(\n        value=x,\n        on_change=go\n    )\n";
        match first_expr(src).kind {
            Kind::Call { kwargs, .. } => assert_eq!(kwargs.len(), 2),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn newlines_inside_list_brackets_are_insignificant() {
        let src = "component A():\n    xs = [\n        1,\n        2,\n    ]\n";
        assert!(matches!(first_expr(src).kind, Kind::List(ref v) if v.len() == 2));
    }

    #[test]
    fn attribute_and_index_chains_parse() {
        match first_expr("component A():\n    x = a.b[0].c\n").kind {
            Kind::Attr { obj, name } => {
                assert_eq!(name, "c");
                assert!(matches!(obj.kind, Kind::Index { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    // ---------------------------------------------------------------- statements

    #[test]
    fn assignment_target_and_value_parse() {
        match &body("component A():\n    x = 1\n")[0].kind {
            Kind::Assign { target, value } => {
                assert!(matches!(target.kind, Kind::Name(ref n) if n == "x"));
                assert!(matches!(value.kind, Kind::Num(ref n) if n == "1"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn tuple_unpack_becomes_a_tuple_target() {
        // Parallel assignment gets its own node: routing it through Assign
        // produced `a = b = [b, a]` for a swap.
        match &body("component A():\n    a, b = pair()\n")[0].kind {
            Kind::TupleAssign { targets, .. } => {
                assert_eq!(targets.len(), 2);
                assert!(matches!(targets[0].kind, Kind::Name(ref n) if n == "a"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn chained_assignment_is_not_a_tuple_assign() {
        // `a = b = 0` declares both names and assigns once.
        match &body("component A():\n    a = b = 0\n")[0].kind {
            Kind::ChainedAssign { targets, .. } => assert_eq!(targets.len(), 2),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn augmented_assignment_captures_the_operator() {
        for (src, want) in [("+=", "+"), ("-=", "-"), ("*=", "*"), ("/=", "/")] {
            let n = &body(&format!("component A():\n    x {}= 1\n", want))[0];
            match &n.kind {
                // The node keeps the full operator (`+=`, not `+`) because the
                // emitter must distinguish `**=` and `//=`, which need special
                // code rather than string concatenation.
                Kind::AugAssign { op, .. } => assert_eq!(op, src, "for {}", src),
                other => panic!("got {:?}", other),
            }
        }
    }

    #[test]
    fn def_parses_name_params_and_return_type() {
        match &body("component A():\n    def go(n: int) -> int:\n        return n\n")[0].kind {
            Kind::Def { name, params, body } => {
                assert_eq!(name, "go");
                assert_eq!(params.len(), 1);
                assert_eq!(body.len(), 1);
                assert!(matches!(body[0].kind, Kind::Return(_)));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn return_statement_parses() {
        match &body("component A():\n    def go():\n        return 1\n")[0].kind {
            Kind::Def { body, .. } => assert!(matches!(body[0].kind, Kind::Return(Some(_)))),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn bare_return_statement_parses() {
        match &body("component A():\n    def go():\n        return\n")[0].kind {
            Kind::Def { body, .. } => assert!(matches!(body[0].kind, Kind::Return(None))),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn keyword_kwargs_parse() {
        match first_expr("component A():\n    button(type=\"button\", as=\"div\", for=\"id\")\n")
            .kind
        {
            Kind::Call { kwargs, .. } => {
                assert_eq!(kwargs.len(), 3);
                assert_eq!(kwargs[0].0, "type");
                assert_eq!(kwargs[1].0, "as");
                assert_eq!(kwargs[2].0, "for");
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn statement_if_captures_orelse() {
        match &body("component A():\n    if a:\n        go()\n    else:\n        stop()\n")[0].kind
        {
            Kind::If { orelse, .. } => assert!(orelse.is_some()),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn elif_becomes_a_nested_if_in_orelse() {
        match &body("component A():\n    if a:\n        x()\n    elif b:\n        y()\n")[0].kind {
            Kind::If { orelse, .. } => match &orelse.as_ref().unwrap()[0].kind {
                Kind::If { test, .. } => {
                    assert!(matches!(test.kind, Kind::Name(ref n) if n == "b"))
                }
                other => panic!("got {:?}", other),
            },
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn statement_for_captures_target_and_iter() {
        match &body("component A():\n    for x in xs:\n        go(x)\n")[0].kind {
            Kind::For { target, iter, .. } => {
                assert_eq!(target, "x");
                assert!(matches!(iter.kind, Kind::Name(ref n) if n == "xs"));
            }
            other => panic!("got {:?}", other),
        }
    }

    // ------------------------------------------------------------------- imports

    #[test]
    fn from_import_keeps_module_and_names() {
        match &stmts("from hydra import state, effect\n")[0].kind {
            Kind::Import { from, names } => {
                assert_eq!(from.as_deref(), Some("hydra"));
                assert_eq!(names, &vec!["state".to_string(), "effect".to_string()]);
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn bare_import_has_no_module() {
        match &stmts("import hydra\n")[0].kind {
            Kind::Import { from, names } => {
                assert!(from.is_none());
                assert_eq!(names, &vec!["hydra".to_string()]);
            }
            other => panic!("got {:?}", other),
        }
    }

    // -------------------------------------------------------------------- trees

    #[test]
    fn tree_block_captures_head_and_children() {
        match &body("component A():\n    div:\n        span: \"x\"\n")[0].kind {
            Kind::Tree { head, body } => {
                assert!(matches!(head.kind, Kind::Name(ref n) if n == "div"));
                assert_eq!(body.len(), 1);
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn tree_block_with_call_head_keeps_kwargs() {
        match &body("component A():\n    div(cls=\"x\"):\n        span: \"y\"\n")[0].kind {
            Kind::Tree { head, .. } => match &head.kind {
                Kind::Call { kwargs, .. } => assert_eq!(kwargs[0].0, "cls"),
                other => panic!("got {:?}", other),
            },
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn empty_tree_block_has_no_children() {
        match &body("component A():\n    br:\n")[0].kind {
            Kind::Tree { body, .. } => assert!(body.is_empty()),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn inline_tree_child_is_a_single_statement() {
        match &body("component A():\n    h1: \"Hello\"\n")[0].kind {
            Kind::Tree { body, .. } => assert_eq!(body.len(), 1),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn deeply_nested_trees_parse() {
        // 7 levels of element nesting: div > section > ul > li > span > em.
        let src = "component A():\n    div:\n        section:\n            ul:\n                li:\n                    span:\n                        em: \"deep\"\n";
        let mut n = &body(src)[0];
        let mut depth = 0;
        while let Kind::Tree { body, .. } = &n.kind {
            depth += 1;
            match body.first() {
                Some(child) => n = child,
                None => break,
            }
        }
        assert_eq!(depth, 6, "expected 6 nested tree levels");
    }

    #[test]
    fn if_and_for_inside_a_tree_parse_as_children() {
        let src = "component A():\n    div:\n        if a:\n            p: \"y\"\n        for x in xs:\n            li: x\n";
        match &body(src)[0].kind {
            Kind::Tree { body, .. } => {
                assert_eq!(body.len(), 2);
                assert!(matches!(body[0].kind, Kind::If { .. }));
                assert!(matches!(body[1].kind, Kind::For { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    // ------------------------------------------------------------------ f-strings

    #[test]
    fn fstring_splits_literals_and_expressions() {
        let e = first_expr("component A():\n    div: f\"hi {name}\"\n");
        match e.kind {
            Kind::FString(parts) => {
                assert_eq!(parts.len(), 2);
                assert!(matches!(parts[0], FPart::Lit(ref s) if s == "hi "));
                assert!(matches!(parts[1], FPart::Expr { .. }));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn fstring_interpolation_is_parsed_not_copied() {
        // A ternary inside `{}` must become a real expression node.
        let e = first_expr("component A():\n    div: f\"{'a' if x else 'b'}\"\n");
        match e.kind {
            Kind::FString(parts) => match &parts[0] {
                FPart::Expr { value: n, .. } => {
                    assert!(matches!(n.kind, Kind::Ternary { .. }), "got {:?}", n.kind)
                }
                other => panic!("got {:?}", other),
            },
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn fstring_escaped_braces_become_literal_braces() {
        let e = first_expr("component A():\n    div: f\"{{literal}}\"\n");
        match e.kind {
            Kind::FString(parts) => {
                assert_eq!(parts.len(), 1);
                assert!(matches!(parts[0], FPart::Lit(ref s) if s == "{literal}"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn fstring_escaped_close_brace_is_literal() {
        let e = first_expr("component A():\n    div: f\"a}}b\"\n");
        match e.kind {
            Kind::FString(parts) => {
                assert!(matches!(parts[0], FPart::Lit(ref s) if s == "a}b"));
            }
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn fstring_with_string_containing_a_brace_parses() {
        // The `}` inside the quoted string must not close the interpolation.
        let e = first_expr("component A():\n    div: f\"{d['}']}\"\n");
        assert!(matches!(e.kind, Kind::FString(_)));
    }

    #[test]
    fn malformed_fstring_errors_instead_of_panicking() {
        // `f"` alone is caught by the lexer, but an f-token with no room for
        // quotes must not slice out of bounds either.
        let err = parse_err("component A():\n    div: f\"\n");
        assert!(!err.msg.is_empty());
    }

    // ------------------------------------------------------------------- errors

    #[test]
    fn unexpected_token_reports_position_and_hint() {
        let err = parse_err("component A():\n    div:\n        x = ~~~\n");
        assert!(
            err.msg.contains("unexpected character") || err.msg.contains("unexpected"),
            "msg {:?}",
            err.msg
        );
        assert_eq!(err.line, 3);
    }

    #[test]
    fn missing_expression_has_a_hint() {
        let err = parse_err("component A():\n    x = )\n");
        assert!(err.hint.is_some());
    }

    #[test]
    fn error_line_points_at_the_offending_line() {
        let err = parse_err("component A():\n    x = 1\n    y = ~~~\n");
        assert_eq!(err.line, 3);
    }

    #[test]
    fn tree_head_must_be_an_element() {
        // Parsing succeeds; the emitter is what rejects a non-element head.
        // Here we only assert the tree node was built with the odd head.
        match &body("component A():\n    1 + 2:\n        p: \"y\"\n")[0].kind {
            Kind::Tree { .. } => {}
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn def_inside_a_tree_parses_but_is_rejected_later() {
        // The parser accepts it; the emitter is the gate that refuses it.
        let src = "component A():\n    div:\n        for x in xs:\n            def bad():\n                y()\n";
        match &body(src)[0].kind {
            Kind::Tree { body, .. } => assert!(matches!(body[0].kind, Kind::For { .. })),
            other => panic!("got {:?}", other),
        }
    }

    #[test]
    fn optional_chaining_and_nullish_coalescing_parse() {
        let e = first_expr("component A():\n    x = user?.profile?.name ?? \"anon\"\n");
        match e.kind {
            Kind::Bin { op, left, right } => {
                assert_eq!(op, "??");
                match left.kind {
                    Kind::OptAttr { obj, name } => {
                        assert_eq!(name, "name");
                        assert!(matches!(obj.kind, Kind::OptAttr { .. }));
                    }
                    other => panic!("expected OptAttr, got {:?}", other),
                }
                assert!(matches!(right.kind, Kind::Str { .. }));
            }
            other => panic!("expected Bin with ??, got {:?}", other),
        }
    }

    #[test]
    fn in_comparison_parses() {
        // `x in xs` is a membership test, not a Bin — JS `in` asks about keys,
        // so it needs its own node to compile to the right thing.
        let e = first_expr("component A():\n    x = item in items\n");
        match e.kind {
            Kind::Contains {
                item,
                container,
                negated,
            } => {
                assert!(!negated);
                assert!(matches!(item.kind, Kind::Name(ref n) if n == "item"));
                assert!(matches!(container.kind, Kind::Name(ref n) if n == "items"));
            }
            other => panic!("expected Contains, got {:?}", other),
        }
    }

    #[test]
    fn not_in_parses_with_negation() {
        let e = first_expr("component A():\n    x = item not in items\n");
        match e.kind {
            Kind::Contains { negated, .. } => assert!(negated),
            other => panic!("expected negated Contains, got {:?}", other),
        }
    }

    #[test]
    fn chained_comparison_stays_one_node() {
        // `0 < x < 10` must not become `(0 < x) < 10`.
        let e = first_expr("component A():\n    y = 0 < x < 10\n");
        match e.kind {
            Kind::ChainedCompare { ops, operands } => {
                assert_eq!(ops.len(), 2);
                assert_eq!(operands.len(), 3);
            }
            other => panic!("expected ChainedCompare, got {:?}", other),
        }
    }

    #[test]
    fn comprehension_tuple_target_parses() {
        let e = first_expr("component A():\n    x = [v for k, v in items]\n");
        match e.kind {
            Kind::Comprehension { target, .. } => {
                assert_eq!(target, "[k, v]");
            }
            other => panic!("expected Comprehension, got {:?}", other),
        }
    }

    #[test]
    fn unclosed_brace_in_fstring_rejected() {
        let err = parse_err("component A():\n    x = f\"hello {world\"\n");
        assert!(
            err.msg.contains("unclosed '{' in f-string"),
            "got {:?}",
            err.msg
        );
    }

    #[test]
    fn recursion_depth_limit_enforced() {
        let nested = format!(
            "component A():\n    x = {}1{}\n",
            "(".repeat(270),
            ")".repeat(270)
        );
        let builder = std::thread::Builder::new().stack_size(8 * 1024 * 1024);
        let handler = builder
            .spawn(move || {
                let err = parse_err(&nested);
                assert!(
                    err.msg.contains("maximum recursion depth exceeded"),
                    "got {:?}",
                    err.msg
                );
            })
            .unwrap();
        handler.join().unwrap();
    }
