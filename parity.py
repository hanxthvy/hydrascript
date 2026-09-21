#!/usr/bin/env python3
# [xihanzu-NR]
"""Parity harness: run every test through BOTH compilers and diff the output.

The Python compiler is the reference. The Rust compiler must produce byte-identical
TSX (modulo the source map, which differs by design in whitespace).

Run: python3 parity.py
"""
import subprocess, sys, os
from compiler_reference import compile_serpent as py_compile

RS_BIN = os.path.join(os.path.dirname(__file__), 'compiler-rs', 'target', 'release', 'serpent')

CASES = [
    ("counter", '''
from serpent import state

component Counter():
    count, set_count = state(0)
    def bump():
        set_count(count + 1)
    div(cls="card"):
        h1: f"Count: {count}"
        button(on_click=bump): "Increment"
'''),
    ("todo", '''
from serpent import state

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
'''),
    ("elif", '''
component A():
    div:
        if a:
            p: "1"
        elif b:
            p: "2"
        else:
            p: "3"
'''),
    ("comprehension", '''
component A():
    ys = [x * 2 for x in xs if x > 1]
    zs = [x for x in xs]
    div: "x"
'''),
    ("props-types", '''
component Btn(label: str, count: int = 0, on_click=None, tags: list[str] = []):
    button: label
'''),
    ("builtins", '''
component A():
    a = len(xs)
    b = t.strip()
    c = t.upper()
    d = sum(ns)
    e = sorted(ns)
    f = t.startswith("x")
    div: "y"
'''),
    ("nested-tree", '''
component A():
    div(cls="a"):
        div(cls="b"):
            div(cls="c"):
                span: "deep"
'''),
    ("for-multi", '''
component A():
    div:
        for x in xs:
            span: "a"
            span: "b"
'''),
    ("empty-block", '''
component A():
    div:
        br:
        hr:
        div():
'''),
    ("operators", '''
component A():
    if a and b or not c:
        p: "y"
    if x == 1 and y != 2:
        p: "z"
    n = 1 + 2 * 3 - 4
    div: "w"
'''),
    ("ternary", '''
component A():
    p: "yes" if cond else "no"
    span: "a" if x else "b" if y else "c"
    div: "z"
'''),
    ("dict-list", '''
component A():
    d = {"a": 1, "b": 2}
    xs = [1, 2, 3]
    t = (1, 2)
    div: "z"
'''),
    ("spread", '''
component A():
    div(*items, cls="x"):
        p: "y"
'''),
    ("tuple-unpack", '''
component A():
    a, b = pair()
    c, d = other()
    div: "z"
'''),
    ("def-return", '''
component A():
    def go(n: int) -> int:
        return n * 2
    x = go(5)
    div: f"{x}"
'''),
    ("aug-assign", '''
component A():
    x = 0
    x += 1
    x -= 2
    x *= 3
    div: "z"
'''),
    ("imports", '''
from serpent import state, effect, computed
import serpent

component A():
    div: "z"
'''),
]

PASS = FAIL = 0
diffs = []

for name, src in CASES:
    src = src.strip() + '\n'
    try:
        py_out = py_compile(src)
    except Exception as e:
        print(f"  \033[33mSKIP\033[0m {name}: python reference failed: {e}")
        continue

    r = subprocess.run([RS_BIN, '--stdin', f'{name}.hsx'], input=src,
                       capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        FAIL += 1
        print(f"  \033[31mFAIL\033[0m {name}: rust exited {r.returncode}")
        diffs.append((name, 'RUST ERROR:\n' + r.stderr, py_out))
        continue

    # Strip the trailing sourceMappingURL line from rust output for comparison.
    rs_out = '\n'.join(l for l in r.stdout.split('\n') if not l.startswith('//# sourceMappingURL='))

    # Normalize: python emits a trailing newline difference sometimes.
    py_norm = py_out.rstrip('\n')
    rs_norm = rs_out.rstrip('\n')

    if py_norm == rs_norm:
        PASS += 1
        print(f"  \033[32mMATCH\033[0m {name}")
    else:
        FAIL += 1
        print(f"  \033[31mDIFF\033[0m  {name}")
        diffs.append((name, rs_norm, py_norm))

print(f"\n{'='*60}")
print(f"  parity: {PASS} match, {FAIL} differ")
print(f"{'='*60}")

if diffs:
    print("\n--- FIRST DIFF DETAIL ---")
    name, rs, py = diffs[0]
    print(f"### {name}")
    import difflib
    for line in difflib.unified_diff(py.split('\n'), rs.split('\n'),
                                     fromfile='python', tofile='rust', lineterm=''):
        print(line)

sys.exit(1 if FAIL else 0)
