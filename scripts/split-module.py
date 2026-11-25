#!/usr/bin/env python3
"""split-module.py — one-shot Rust module splitter.

    python3 scripts/split-module.py <src.rs> <out-dir> <Struct> groups.json

groups.json:
    {
      "core":  {"title": "...", "methods": ["new", "w"]},
      "expr":  {"title": "...", "methods": ["js"]},
      "=<free>": {"title": "...", "free": ["asset_import"]}
    }

A group named with a leading "=" holds free functions instead of impl methods.
The file is rewritten as <out-dir>/mod.rs plus one file per group, and the tail
`#[cfg(test)] mod tests` becomes <out-dir>/tests.rs when it is present.

Deliberately refuses to run twice: a second run against a moved file is how a
refactor silently loses code.
"""
import json
import os
import re
import sys

src, out, struct = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.load(open(sys.argv[4]))

if os.path.isdir(out):
    sys.exit(f"{out} already exists")

text = open(src).read()
tests_marker = "#[cfg(test)]"
i_tests = text.find(tests_marker)
i_struct = text.find(f"pub struct {struct} ")
i_impl = text.find(f"impl {struct} {{")
if min(i_struct, i_impl) < 0:
    sys.exit(f"could not find struct {struct} / impl {struct}")

impl_end = i_tests if i_tests > 0 else len(text)
body = text[i_impl:impl_end].partition("{\n")[2].rstrip()
assert body.endswith("}"), body[-40:]
body = body[:-1]

fn_re = re.compile(r"^    (pub )?fn ([a-z_0-9]+)")
chunks, cur, cur_name, pending = [], [], None, []

def flush():
    global cur, cur_name
    if cur_name:
        while cur and cur[-1].strip() == "":
            cur.pop()
        chunks.append((cur_name, cur))
        cur, cur_name = [], None

for ln in body.split("\n"):
    m = fn_re.match(ln)
    if m:
        flush()
        cur_name, cur, pending = m.group(2), pending + [ln], []
        continue
    if cur_name is None:
        if ln.strip():
            sys.exit(f"stray line before first method: {ln!r}")
        continue
    if ln.strip().startswith("///") or ln.strip().startswith("#["):
        pending.append(ln)
        continue
    if pending:
        flush()
        cur_name, cur, pending = "__pending__", pending, []
        continue
    cur.append(ln)
flush()

methods = {n: "\n".join(ls) for n, ls in chunks if n != "__pending__"}
assigned, unknown = {}, []
for group, meta in spec.items():
    if group.startswith("="):
        continue
    for name in meta["methods"]:
        if name not in methods:
            unknown.append(name)
        assigned[name] = group
if unknown:
    sys.exit("methods not found: " + ", ".join(unknown))
unassigned = [n for n in methods if n not in assigned]
if unassigned:
    sys.exit("methods not assigned: " + ", ".join(unassigned))

def widen(chunk):
    return "    pub(super) fn " + chunk[len("    fn "):] if chunk.startswith("    fn ") else chunk

PRELUDE = """use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;

use super::*;

"""

os.makedirs(out)
mods, uses = [], []
for group, meta in spec.items():
    if group.startswith("="):
        continue
    fname = group.lower()
    mods.append(fname)
    body_text = "\n\n".join(widen(methods[n]) for n in meta["methods"])
    open(f"{out}/{fname}.rs", "w").write(
        f"//! {meta['title']}\n\n{PRELUDE}impl {struct} {{\n{body_text}\n}}\n")

# free functions: everything before the struct, minus the header and the use lines
head = text[:i_struct]
free_blocks = {}
for group, meta in spec.items():
    if not group.startswith("="):
        continue
    fname = group[1:].lower()
    mods.append(fname)
    picked = []
    for fname_fn in meta["free"]:
        at = head.find(f"pub fn {fname_fn}") if f"pub fn {fname_fn}" in head else head.find(f"fn {fname_fn}")
        if at < 0:
            sys.exit(f"free fn not found: {fname_fn}")
        end = head.find("\n}\n", at) + 3
        picked.append(head[at:end].strip())
    open(f"{out}/{fname}.rs", "w").write(
        f"//! {meta['title']}\n\nuse crate::ast::{{Kind, Node}};\n\nuse super::*;\n\n"
        + "\n\n".join(picked) + "\n")
    free_blocks[fname] = True

if i_tests > 0:
    t = text[i_tests:]
    t = re.sub(r"^#\[cfg\(test\)\]\n", "", t, count=1)
    t = re.sub(r"^mod tests \{\n", "", t, count=1).rstrip()
    assert t.endswith("}"), t[-40:]
    open(f"{out}/tests.rs", "w").write(
        "//! Tests.\n\nuse super::*;\n\n" + t[:-1].rstrip() + "\n")
    mods.append("tests")

header = text[:text.find("use crate::ast")]
modrs = header.rstrip() + "\n\n"
modrs += "".join(f"mod {m};\n" for m in mods if m != "tests") + "\n"
if "tests" in mods:
    modrs += "#[cfg(test)]\nmod tests;\n\n"
modrs += f"pub use model_{struct.lower()}::{struct};\n" if False else ""
open(f"{out}/mod.rs", "w").write(modrs + f"pub use {struct.lower()}::{struct};\n")

# the struct itself
open(f"{out}/{struct.lower()}.rs", "w").write(
    f"//! The {struct} struct.\n\nuse crate::ast::*;\nuse crate::error::CompileError;\n\n"
    + text[i_struct:i_impl].rstrip() + "\n")

open(f"{out}/mod.rs", "a").write("")
os.remove(src)
print("groups:", mods)
