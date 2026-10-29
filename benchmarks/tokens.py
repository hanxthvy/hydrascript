#!/usr/bin/env python3
# [xihanzu-NR]
"""Token counts for the README's "one component" comparison.

The previous README quoted "12.6% fewer tokens across 5 production components"
with no script and no corpus behind it. This measures exactly one pair of
equivalent files and prints the number so anyone can re-run it:

    pip install tiktoken
    python3 benchmarks/tokens.py

It deliberately does not extrapolate. One component is one data point.
"""
import pathlib
import sys

try:
    import tiktoken
except ImportError:
    sys.exit("tiktoken not installed: pip install tiktoken")

enc = tiktoken.get_encoding("cl100k_base")

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

# The equivalent pair lives in the repo so the comparison is not word of mouth.
HYX = (ROOT / "benchmarks" / "counter.hyx").read_text()
TSX = (ROOT / "benchmarks" / "counter.tsx").read_text()

th, tt = len(enc.encode(HYX)), len(enc.encode(TSX))
print(f"counter.hyx : {th:>4} tokens, {len(HYX.splitlines()):>2} lines")
print(f"counter.tsx : {tt:>4} tokens, {len(TSX.splitlines()):>2} lines")
print(f"difference  : {tt - th:>4} tokens ({(tt - th) / tt * 100:.1f}% fewer for .hyx)")
print()
print("One component, not a corpus. Do not quote this as a general ratio.")

# Bonus, clearly separated: how large the emitted TSX is next to its source.
# This is the honest version of "the compiler removes boilerplate" — the
# generated file is bigger, because that is what generation means.
emitted_dir = ROOT / "examples" / "ecosystem" / "src"
if emitted_dir.is_dir():
    tot_src = tot_loc = 0
    files = sorted(emitted_dir.glob("*.hyx"))
    for f in files:
        s = f.read_text()
        tot_src += len(enc.encode(s))
        tot_loc += len(s.splitlines())
    if files:
        print()
        print(f"examples/ecosystem: {len(files)} .hyx files, {tot_src} tokens, {tot_loc} lines")
        print("(source side only; the emitted TSX is not counted here because it is")
        print(" generated, not written, and generator output is not what the trade")
        print(" above measures.)")
