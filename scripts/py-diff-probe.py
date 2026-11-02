#!/usr/bin/env python3
# [xihanzu-NR]
"""Differential probe: every snippet runs in real CPython and in `hydra run`.

A snippet that CRASHES hydra is loud and cheap. A snippet that produces a
DIFFERENT VALUE is silent and expensive, so the report separates the two.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

# Both paths are relative to THIS checkout, so the script works from any clone.
ROOT = Path(__file__).resolve().parent.parent
HYDRA = ['node', str(ROOT / 'bin' / 'hydra.js'), 'run']
# A project with react installed: `hydra run` resolves the `hydra` specifier
# through the project's node_modules, so a bare temp dir fails on "Could not
# resolve react" and every snippet looks broken.
PROJECT = Path(os.environ.get('HYDRA_PROBE_PROJECT', '/tmp/hxprobe/app'))
WORK = Path('/tmp/hxdiff')
WORK.mkdir(exist_ok=True)

SNIPPETS = [
    # equality / truthiness — Python semantics, JS differs
    'print([1, 2] == [1, 2])',
    'print({"a": 1} == {"a": 1})',
    'print((1, 2) == (1, 2))',
    'print(bool([]), bool([0]), bool(""), bool(0))',
    'print(not [])',
    # operators that mean something else in JS
    'print("ab" * 3)',
    'print([0] * 3)',
    'print("ab" + "cd")',
    'print(3 + 4)',
    'print("3" + str(4))',
    'print(7 / 2)',
    'print(7 // 2)',
    'print(-7 // 2)',
    'print(2 ** 10)',
    'print(7 % 3)',
    'print(-7 % 3)',
    # sequence work
    'xs = [3, 1, 2]\nprint(sorted(xs))\nprint(xs)',
    'xs = [3, 1, 2]\nprint(sorted(xs, reverse=True))',
    'xs = [1, 2, 3]\nprint(len(xs), xs[0], xs[-1])',
    'xs = [1, 2, 3, 4]\nprint(xs[1:3])',
    'xs = [1, 2, 3]\nprint(xs.index(2))',
    'print(list(range(3)))',
    'print(list(range(1, 10, 3)))',
    'print(sum([1, 2, 3]))',
    'print(max([1, 5, 3]), min([1, 5, 3]))',
    # strings
    'print(", ".join(["a", "b"]))',
    'print("  x  ".strip())',
    'print("AbC".lower(), "AbC".upper())',
    'print("abc".startswith("ab"), "abc".endswith("bc"))',
    'print("a-b-c".split("-"))',
    'print("abc".replace("b", "X"))',
    'print("a" in "abc", "z" not in "abc")',
    'print("abc"[1])',
    'print(str(12), str(1.5), str(True), str(None))',
    'print(repr("x"))',
    'print("{} and {}".format(1, 2))',
    # dicts
    'd = {"a": 1}\nprint(d.get("b"), d.get("b", 0))',
    'd = {"a": 1, "b": 2}\nprint(list(d.keys()))',
    'd = {"a": 1, "b": 2}\nprint(list(d.items()))',
    'd = {"a": 1}\nprint("a" in d)',
    # numbers and formatting
    'print(f"{1/7:.3f}")',
    'print(f"{2.5:.2f}")',
    'print(f"{1234.5:,.2f}")',
    'print(round(2.675, 2))',
    'print(round(2.5), round(3.5))',
    'print(abs(-3), abs(-3.5))',
    'print(int("42"), float("1.5"))',
    'print(int(3.9), int(-3.9))',
    'print(0.1 + 0.2)',
    'print(1e3)',
    'print(str(1/3))',
    # control flow and functions
    'def f(a, b=2):\n    return a + b\nprint(f(1), f(1, 5))',
    'print([x * 2 for x in [1, 2, 3]])',
    'print({k: v for k, v in [("a", 1)]})',
    'xs = [1, 2, 3]\nprint([x for x in xs if x > 1])',
    'print(any([False, True]), all([True, False]))',
    'print(list(enumerate(["a", "b"])))',
    'print(list(zip([1, 2], ["a", "b"])))',
    'print([1, 2] + [3])',
    'xs = [1, 2]\nxs.append(3)\nprint(xs)',
    'xs = [1, 2, 3]\nxs.remove(2)\nprint(xs)',
    'xs = [1, 2]\nprint(xs.pop())',
    'print(sorted([3, 1], key=lambda v: -v))',
    'try:\n    print(1 / 0)\nexcept ZeroDivisionError:\n    print("div0")',
    'print(type(1).__name__, type("a").__name__)',
    'x = None\nprint(x is None)',
    'print(True and 1, False or 2)',
    'print(1 if True else 2)',
]


def run_py(src):
    p = subprocess.run([sys.executable, '-c', src], capture_output=True, text=True)
    return (p.stdout.strip(), p.returncode, p.stderr.strip().splitlines()[:1])


def run_hydra(src):
    f = WORK / 'case.hys'
    f.write_text(src + '\n')
    p = subprocess.run(HYDRA + [str(f)], capture_output=True, text=True, cwd=str(PROJECT))
    out = p.stdout.strip()
    return (out, p.returncode, p.stderr.strip().splitlines()[:1])


rows = []
for src in SNIPPETS:
    py, pyrc, pyerr = run_py(src)
    hx, hxrc, hxerr = run_hydra(src)
    if hxrc != 0 or 'Error' in hx or 'error:' in hx.splitlines()[0:1].__str__():
        state = 'CRASH'
    elif py != hx:
        state = 'WRONG'
    else:
        state = 'ok'
    rows.append({'src': src, 'python': py, 'hydra': hx, 'state': state,
                 'hxerr': hxerr[:1]})

Path('/tmp/hxdiff/report.json').write_text(json.dumps(rows, indent=1))
for st in ('WRONG', 'CRASH'):
    sel = [r for r in rows if r['state'] == st]
    print(f'\n=== {st} ({len(sel)}/{len(rows)})')
    for r in sel:
        print('  src  :', r['src'].replace('\n', ' | '))
        print('  py   :', r['python'].replace('\n', ' | ')[:70])
        print('  hydra:', (r['hydra'] or r['hxerr'][0] if r['hxerr'] else r['hydra']).replace('\n', ' | ')[:90])
print(f"\nok: {sum(1 for r in rows if r['state']=='ok')}/{len(rows)}")
