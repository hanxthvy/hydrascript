<!-- [xihanzu-NR] -->
# Migrating between versions

A breaking change means a version bump **and** an entry here. The rule exists
because frameworks die when people stop daring to upgrade: a breaking change
without a written path is a reason to stay put, and authors undercount how long
"later" lasts. Pre-1.0 is not an excuse to skip this — it is when it is cheapest.

Automate it when it can be automated (a codemod under `scripts/`), and describe it
precisely when it cannot. "Some things changed" is not an entry.

---

## 0.3.0 -> unreleased

### Emitted prop types for `list` and `dict` are now valid TypeScript

**Breaking for a TypeScript consumer, in a way that was already broken.**

A component parameter annotated `list` used to appear in the emitted props
interface as bare `Array`, and `dict` as bare `Record`. Neither is valid
TypeScript — both are generic and require type arguments — so any `tsc` run over
generated output failed with `TS2314: Generic type 'Array<T>' requires 1 type
argument(s)`.

Now: `list` -> `Array<any>`, `dict` -> `Record<string, any>`, and with arguments,
`list[int]` -> `Array<number>` (unchanged). If you patched the generated output to
work around the old form, delete the patch; regenerating is correct now.

### The checker no longer treats most Python builtins as bound names

**May add warnings. Never changes output, never changes the exit code.**

`hydra check` used to accept any Python builtin as a legal bare name, which meant
it stayed silent on `getattr(x, "k", 0)` — a call the compiler does not lower, so
it emits verbatim and throws `ReferenceError` at runtime.

The name list is now only what the compiler demonstrably honours (lowered to
JavaScript, or imported from the `hydra` runtime for you): `abs`, `bool`, `len`,
`list`, `max`, `min`, `pow`, `print`, `reversed`, `round`, `sorted`, `str`, `sum`,
`int`, `float`, `isinstance`, `enumerate`, `range`, `zip`. Anything else is
reported as an unbound name.

There is nothing to migrate if your code ran: a name that is reported and did run
was one of the honoured set. If you get a new warning for `set`, `dict`, `tuple`,
`filter`, `map`, `getattr` or similar, the call was already failing at runtime and
the warning is the fix.

Two tests pin this in both directions: every name in the list must compile to
something honoured, and every name in the list must be exercised by a case, so the
list cannot grow a name that nothing proves.

### Emitted formatting is not a contract

Stated here rather than discovered: the parenthesisation, helper choice and line
breaks of emitted JavaScript are not guaranteed. Do not diff emitted output
between versions and treat a difference as a regression. See `SPEC.md`.

---

## How to add an entry

1. Write it in the same commit as the change, not afterwards.
2. Say what the old behaviour was, what it is now, and what the reader must do.
3. If a codemod is possible, ship it and name it in the entry.
4. If the change cannot break anyone, it does not need an entry — put it in the
   release notes instead. Do not pad this file; a migration guide nobody reads is
   the same as none.
