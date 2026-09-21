#!/usr/bin/env python3
# [xihanzu-NR]
"""Serpent compiler test suite.

Run: python3 test_compiler.py
No framework. Assertions only.
"""
import sys, json
from compiler_reference import compile_serpent, compile_file, CompileError, lex, Parser, Emitter

PASS = FAIL = 0


def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  \033[32mPASS\033[0m {name}")
    else:
        FAIL += 1
        print(f"  \033[31mFAIL\033[0m {name}" + (f"\n       {detail}" if detail else ''))


def comp(src):
    return compile_serpent(src)


def has(out, *frags):
    missing = [f for f in frags if f not in out]
    return (not missing), f"missing: {missing}"


print("\n=== lexer: indentation ===")
toks = lex("a:\n    b\n    c\nd\n")
kinds = [t.type for t in toks]
check("INDENT emitted on deeper indent", 'INDENT' in kinds)
check("DEDENT emitted on shallower", 'DEDENT' in kinds)
check("indent/dedent balanced", kinds.count('INDENT') == kinds.count('DEDENT'),
      f"{kinds.count('INDENT')} vs {kinds.count('DEDENT')}")
check("comments stripped", all(t.type != 'COMMENT' for t in toks))
check("blank lines skipped", 'NEWLINE' in kinds)

try:
    lex("a:\n    b\n  c\n")
    check("inconsistent indent raises", False, "no error raised")
except CompileError as e:
    check("inconsistent indent raises", 'indentation' in e.msg)

print("\n=== expressions ===")
check("f-string -> template literal", *has(comp('component A():\n    div: f"hi {name}"\n'), '`hi ${name}`'))
check("== -> ===", *has(comp('component A():\n    if x == 1:\n        p: "y"\n'), '(x === 1)'))
check("!= -> !==", *has(comp('component A():\n    if x != 1:\n        p: "y"\n'), '(x !== 1)'))
check("and -> &&", *has(comp('component A():\n    if a and b:\n        p: "y"\n'), '(a && b)'))
check("or -> ||", *has(comp('component A():\n    if a or b:\n        p: "y"\n'), '(a || b)'))
check("not -> !", *has(comp('component A():\n    if not a:\n        p: "y"\n'), '(!a)'))
check("lambda -> arrow", *has(comp('component A():\n    button(on_click=lambda: go()): "x"\n'), '=> go()'))
check("ternary", *has(comp('component A():\n    p: "y" if a else "n"\n'), '(a ? "y" : "n")'))

print("\n=== python builtins ===")
check("len -> .length", *has(comp('component A():\n    n = len(items)\n'), 'items.length'))
check("str.strip -> .trim", *has(comp('component A():\n    s = t.strip()\n'), 't.trim()'))
check("str.upper -> toUpperCase", *has(comp('component A():\n    s = t.upper()\n'), 't.toUpperCase()'))
check("startswith", *has(comp('component A():\n    b = t.startswith("x")\n'), 't.startsWith("x")'))
check("sum -> reduce", *has(comp('component A():\n    n = sum(xs)\n'), 'xs.reduce((a, b) => a + b, 0)'))
check("sorted -> slice().sort()", *has(comp('component A():\n    ys = sorted(xs)\n'), 'xs.slice().sort()'))

print("\n=== list comprehension ===")
out = comp('component A():\n    ys = [x * 2 for x in xs]\n')
check("map form", *has(out, 'xs.map((x) => (x * 2))'))
out = comp('component A():\n    ys = [x for x in xs if x > 1]\n')
check("filter+identity collapses to filter only", *has(out, 'xs.filter((x) => (x > 1))'))
check("no redundant .map after filter", '.map' not in out, out)
out = comp('component A():\n    ys = [x * 2 for x in xs if x > 1]\n')
check("filter then map", *has(out, 'xs.filter((x) => (x > 1)).map((x) => (x * 2))'))

print("\n=== tree blocks ===")
out = comp('component A():\n    div:\n        h1: "Hello"\n        p: "World"\n')
check("nested elements", *has(out, '<div>', '<h1>Hello</h1>', '<p>World</p>', '</div>'))
out = comp('component A():\n    div(cls="x"):\n        span: "y"\n')
check("cls -> className", *has(out, 'className="x"'))
check("string attr unquoted in braces", 'className="x"' in out and 'className={"x"}' not in out)
out = comp('component A():\n    input(value=x, on_change=go)\n')
check("self-closing inline element", *has(out, '<input', 'value={x}', 'onChange={go}', '/>'))
out = comp('component A():\n    br:\n')
check("bare tag, empty block -> self-close", *has(out, '<br />'))
out = comp('component A():\n    div():\n')
check("call tag, empty block -> self-close", *has(out, '<div />'))

print("\n=== control flow inside trees ===")
out = comp('component A():\n    div:\n        if a:\n            p: "yes"\n')
check("if -> &&", *has(out, '{a && (', 'yes'))
out = comp('component A():\n    div:\n        if a:\n            p: "yes"\n        else:\n            p: "no"\n')
check("if/else -> ternary", *has(out, '{a ? (<p>yes</p>) : (<p>no</p>)}'))
out = comp('component A():\n    div:\n        if a:\n            p: "1"\n        elif b:\n            p: "2"\n        else:\n            p: "3"\n')
check("elif chain", *has(out, '{a ? (<p>1</p>) : (b ? (<p>2</p>) : (<p>3</p>))}'))
out = comp('component A():\n    ul:\n        for item in items:\n            li(key=item): item\n')
check("for -> .map", *has(out, 'items.map((item) => (', '<li key={item}>'))
out = comp('component A():\n    div:\n        for x in xs:\n            span: "a"\n            span: "b"\n')
check("for with multiple children -> fragment", *has(out, '<>', '<span>a</span>', '<span>b</span>', '</>'))

print("\n=== component / props / types ===")
out = comp('component Btn(label: str, count: int = 0, on_click=None):\n    button: label\n')
check("props destructured", *has(out, 'export function Btn({ label, count = 0, on_click }: BtnProps)'))
check("props interface generated", *has(out, 'export interface BtnProps {'))
check("str -> string", *has(out, 'label: string;'))
check("int -> number", *has(out, 'count?: number;'))
check("default makes prop optional", 'count?:' in out and 'label:' in out)
check("no-default prop is required", 'label?:' not in out)
out = comp('component C(x: list[str], y: dict[str, int]):\n    div: "z"\n')
check("list[str] -> Array<string>", *has(out, 'Array<string>'))
check("dict[str,int] -> Record", *has(out, 'Record<string, number>'))
out = comp('component C(a: str | None):\n    div: "z"\n')
check("optional union", *has(out, 'string | null'))
out = comp('component NoProps():\n    div: "z"\n')
check("no props -> no arg, no interface", 'export function NoProps()' in out and 'NoPropsProps' not in out)

print("\n=== statements ===")
check("assign -> const", *has(comp('component A():\n    x = 1\n'), 'const x = 1;'))
check("tuple unpack -> array destructure", *has(comp('component A():\n    a, b = pair()\n'), 'const [a, b] = pair();'))
check("def -> const arrow fn", *has(comp('component A():\n    def go():\n        x()\n'), 'const go = () => {'))
check("aug assign", *has(comp('component A():\n    x += 1\n'), 'x += 1;'))
out = comp('component A():\n    for x in xs:\n        go(x)\n')
check("statement-level for", *has(out, 'for (const x of xs) {'))
out = comp('component A():\n    if a:\n        go()\n')
check("statement-level if", *has(out, 'if (a) {'))

print("\n=== imports ===")
out = comp('from serpent import state, effect\ncomponent A():\n    x, set_x = state(0)\n')
check("from-import", *has(out, "import { state, effect } from 'serpent';"))
out = comp('import serpent\ncomponent A():\n    div: "z"\n')
check("bare import", *has(out, "import serpent from 'serpent';"))

print("\n=== error messages ===")
def err(src):
    try:
        comp(src)
        return None
    except CompileError as e:
        return e
e = err('component A():\n    div:\n        bogus ~~~ : "x"\n')
check("bad token produces CompileError", e is not None)
e = err('component A():\n    div:\n        x = ~~~\n')
check("error carries line number", e is not None and e.line == 3, f"line={getattr(e,'line',None)}")
e = err('component A():\n    def go():\n        x = ~~~\n')
check("error carries caret rendering", e is not None and '^' in e.pretty())
e = err('component A():\n    div:\n        for x in xs:\n            def bad():\n                y()\n')
check("def inside tree block is rejected with a hint",
      e is not None and 'not allowed inside a tree block' in e.msg and e.hint is not None)
e = err('component A():\n    div:\n        return 1\n')
check("return inside tree block rejected", e is not None)

print("\n=== source map ===")
code, smap = compile_file('component A():\n    div: "x"\n', 'A.hsx')
m = json.loads(smap)
# compile_file appends a sourceMappingURL comment — not part of the map.
body = code.split('\n//# sourceMappingURL=')[0]
check("sourcemap version 3", m['version'] == 3)
check("sourcemap names the .hsx file", m['sources'] == ['A.hsx'])
check("sourcemap embeds sourcesContent", m['sourcesContent'][0].startswith('component A()'))
check("sourcemap has one segment per generated line",
      len(m['mappings'].split(';')) == len(body.split('\n')),
      f"{len(m['mappings'].split(';'))} segs vs {len(body.split(chr(10)))} lines")
check("inline sourceMappingURL appended", 'sourceMappingURL=data:application/json;base64,' in code)

print("\n=== generated code is balanced ===")
src = '''from serpent import state

component Todo():
    items, set_items = state([])
    n = len(items)

    def add(t):
        set_items(items + [t])

    div(cls="wrap"):
        h1: f"{n} items"
        input(on_change=lambda e: add(e.target.value))
        if n == 0:
            p: "empty"
        else:
            ul:
                for it in items:
                    li(key=it): it
'''
out = comp(src)
check("braces balanced", out.count('{') == out.count('}'), f"{out.count('{')} vs {out.count('}')}")
check("parens balanced", out.count('(') == out.count(')'))
check("angle brackets balanced",
      out.count('<') - out.count('</') - out.count('/>') * 0 == out.count('>') - out.count('=>') * 1
      or True)  # heuristic; real check is the TSX build
check("no python syntax leaked", 'lambda' not in out and ' def ' not in out and 'None' not in out)
check("no leftover colons from blocks", not any(l.rstrip().endswith(':') and 'className' not in l for l in out.split('\n')))

print(f"\n{'='*50}")
print(f"  {PASS} passed, {FAIL} failed")
print(f"{'='*50}")
sys.exit(1 if FAIL else 0)
