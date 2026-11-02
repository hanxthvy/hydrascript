<!-- [xihanzu-NR] -->
# Migrating between versions

A breaking change means a version bump **and** an entry here. The rule exists
because frameworks die when people stop daring to upgrade: a breaking change
without a written path is a reason to stay put, and authors undercount how long
"later" lasts. Pre-1.0 is not an excuse to skip this — it is when it is cheapest.

Automate it when it can be automated (a codemod under `scripts/`), and describe it
precisely when it cannot. "Some things changed" is not an entry.

---

## 0.5.x -> 0.6.0

**Nothing here requires editing a file.** Both changes make something work that
previously did not, so the migration is "delete the workaround".

### `map(fn, xs)` and `filter(fn, xs)` are calls now, not elements

If a project worked around the old behaviour by writing `xs.map(fn)`, that keeps
working — it always did, and it is still the clearer spelling for a method call.
What changes is the bare form: `map(fn, xs)` used to compile to the JSX element
`<map>{fn}{xs}</map>`, which dropped `fn` and `xs` entirely. If a project had a
real `<map>` element inside a tree, that is unaffected: the element rule applies
to a tree head or a dotted head, and only the bare CALL is a call.

Nothing to do. If a build that used the old, broken form now behaves differently,
it is because it was not doing what the source said.

### `getattr`, `hasattr`, `setattr`, `repr`, `any`, `all` no longer fail the build

They used to be reported by `hydra check --strict` and refused at build time,
because there was no implementation and shipping a `ReferenceError` is worse than
failing early. There is an implementation now, so a project that set
`HYDRA_NO_CHECK=1` to get past the check for one of these names can drop it.

The behaviour, precisely, because these are the places Python and JavaScript
disagree:

- `any([])` is `False` and `all([])` is `True`, as in Python. `Array.prototype.some`
  and `.every` agree with this; `Array.prototype.some()` with no argument throws,
  which is why the bare form does not map to it.
- `getattr(x, "y")` with **no** default raises `AttributeError`, it does not
  return `undefined`. The three-argument form returns the default.
- `hasattr` never raises, including on `null` and `undefined`.
- `repr` is `JSON.stringify` for strings and plain data, `String(x)` otherwise. It
  is not Python's `repr`, and it does not claim to be: a JS object has no
  `__repr__` to call.

### `super().method()` parses

Previously a parse error. `super().__init__(...)` still becomes a bare
`super(...)`; any other member becomes `super.name(...)`. `super().name` without a
call is an error with a hint, because `super` is not a value in JS either.

---

## 0.3.x -> 0.4.0

The database and list sections below shipped in 0.3.4; the number only caught up
in 0.4.0, because a change that can fail a build is a minor bump and 0.3.4 was
published as a patch. If you are on 0.3.0 through 0.3.3, everything here applies
to you.

### A build can now refuse to build, when a name has no runtime

**Behaviour change: possible build failures on code that used to compile.**

`hydra build` runs the semantic checker over `src/` before bundling and stops if
it finds a name no runtime provides (`any`, `all`, `map`, `filter`, `getattr`,
`setattr`, `hasattr`, `repr`, `frozenset`, `dict`, `tuple`, `set`). Those always
compiled to a call to something that does not exist; the difference is that the
failure used to reach the browser instead of the terminal.

The runtime gate cannot catch these on its own. It renders the page, so it only
sees code a render actually executes — the same call inside an event handler, or
on a branch that render does not take, built successfully and shipped a crash.

If a build now fails:

- Fix the name. `len(d)` is fine; `len(any(xs))` is not, because `any` is Python
  and has no JavaScript equivalent here.
- `HYDRA_NO_CHECK=1 hydra build` builds anyway. `hydra check src/` reports the
  same findings without failing.

Nothing else changes: `hydra check` without `--strict` is still advisory, and a
warning alone never fails a build.


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
