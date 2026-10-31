<!-- [xihanzu-NR] -->
# HydraScript language specification (0.3)

This is a short document about what the language **guarantees**. It is not a
tutorial (see `README.md`) and not an implementation guide (see the source). Its
job is to be the source of truth that tests are written against, so a
reimplementation or a second backend has something to be checked against other
than "whatever the current emitter happens to do".

Sections marked **Guaranteed** are contracts: changing them is a breaking change
and needs a migration note. Sections marked **Not guaranteed** are deliberately
loose; do not build on them.

---

## 1. Scope, and how to read this

The language is defined by this document plus the conformance tests in
`compiler-rs/tests/`. Where the two disagree, that is a bug in one of them and is
fixed, not documented around.

Version: **0.3**. The syntax is frozen at 0.3 until 1.0; see `README.md`. New
constructs are not being added, and this document describes the language as it
is, not as it might become.

## 2. Files and targets

- **Guaranteed.** `.hyx` and `.hsx` compile to a React component module:
  `component Name(params):` emits `export function Name(props) { ... }`
  returning JSX, plus an exported `<Name>Props` interface.
- **Guaranteed.** `.hys`, `.hs` and `.hx` compile to plain JavaScript with no
  React and no JSX. A component in a plain-JS target is an error.
- **Guaranteed.** An extension does not change the grammar: the same source
  parses in either target. Emitting JSX in a plain-JS target is a compile error,
  not silent output.
- **Not guaranteed.** Whitespace inside a template literal, or the exact
  parenthesisation of an emitted expression. The **meaning** of an expression is
  guaranteed; its spelling is not.

## 3. Indentation and statements

- **Guaranteed.** Indentation defines blocks; a block is opened by a line ending
  in `:` and consists of all following lines indented more deeply.
- **Guaranteed.** Indentation may be **spaces only**. A tab anywhere in the
  indentation is a compile error (`tab indentation is not allowed`).
- **Guaranteed.** Blank lines and comment-only lines do not affect nesting.
- **Guaranteed.** `#` starts a comment to end of line, outside string literals.
- **Guaranteed.** A line inside a bracketed group (`(`, `[`, `{`) may continue
  onto the next line without a backslash.
- **Guaranteed statements:** assignment, augmented assignment, `if`/`elif`/`else`,
  `for`, `while`, `try`/`except`/`else`/`finally`, `return`, `break`, `continue`,
  `pass`, `assert`, `raise`, `def`, `async def`, `class`,
  `import`/`from ... import`, `export`, `component`, interface and type
  declaration, `match`/`case`, and bare expression statements.
- **Errors, not supported:** `with`, and `for ... else` / `while ... else`. Both
  are rejected by the parser rather than mis-compiled.

## 4. Names and scoping

- **Guaranteed.** A component's parameters are the props; a parameter with a
  default is optional. `component C():` with no parameters emits no props type.
- **Guaranteed.** `self` inside a class method means `this`.
- **Guaranteed.** A name defined in an enclosing block is visible inside a nested
  block, and a function declared with `def` inside a block may be referenced from
  a line below it within that block (the emitted JS function declaration hoists).
- **Guaranteed.** Comprehension targets are scoped to the comprehension and do
  not leak.
- **Guaranteed.** A bare use of a name exported by the `hydra` runtime is valid
  without an import: the compiler injects the import. The set of such names is
  exactly the value exports of `runtime/hydra.ts`.
- **Not guaranteed.** The order in which module-level statements execute beyond
  top-to-bottom.

## 5. Components and JSX

- **Guaranteed.** A `tag:` block whose tag is a lowercase HTML name becomes that
  element; a tag starting uppercase becomes a component reference and must
  resolve.
- **Guaranteed.** `div(cls="x")` with attributes and no nested block is the same
  element as `div(cls="x"):` with an empty body, and emits a self-closing
  element.
- **Guaranteed.** Attribute names are mapped by a fixed table (`cls` ->
  `className`, `on_click` -> `onClick`, `stroke_width` -> `strokeWidth`, and so
  on); `aria_*` and `data_*` map underscores to hyphens. An unknown name is
  passed through unchanged.
- **Guaranteed.** A dotted tag is an element only when the member looks like a
  component or is an HTML tag: `Tabs.List`, `motion.div`. `obj.lowercaseMember(...)`
  is always a **call**, never an element, because emitting it as an element would
  drop the receiver.
- **Guaranteed.** `slot` inside a component means its children, and adds
  `children` to the props.
- **Guaranteed.** A `for` loop inside an element body becomes a `.map(...)`. It is
  the author's responsibility to supply `key=`; see section 10.
- **Not guaranteed.** The formatting of emitted JSX, including whether a short
  single-child element is inlined onto one line.

## 6. Expressions

- **Guaranteed.** f-strings interpolate, and a format spec is translated;
  `f"{x:.2f}"` is `Number(x).toFixed(2)`. Supported spec elements: fill, align,
  sign, `0`, width, grouping `,`, `.precision`, and the types `f`, `%`, `d`, `i`,
  `s`, and empty. **A spec outside that set is a compile error naming the spec.**
- **Guaranteed.** `!r`, `!s`, `!a` mean `String(x)`.
- **Guaranteed.** `a < b < c` emits an `&&` chain, not `(a < b) < c`.
- **Guaranteed.** `x in xs` tests membership; for a dictionary it tests keys.
- **Guaranteed.** `a is b` and `a is not b` compile; `is` is identity in the
  emitted JS.
- **Guaranteed.** List, dict and set comprehensions, with tuple targets, compile
  to the corresponding `map`/`reduce`/`Set` form.
- **Guaranteed.** `//` is floor division and emits `Math.floor(a / b)`.
- **Guaranteed.** A bare use of a Python builtin is only legal when the compiler
  honours it, which means one of: it is lowered to JavaScript (`len`, `print`,
  `abs`, `int`, `float`, `str`, `sum`, `min`, `max`, `pow`, `round`, `sorted`,
  `reversed`, `list`, `bool`, `isinstance`), or it is imported for you from the
  `hydra` runtime (`enumerate`, `range`, `zip`). **Every other Python builtin is
  emitted verbatim and throws `ReferenceError` at runtime** — `getattr`, `set`,
  `dict`, `tuple`, `filter`, `map`, `next`, `repr`, `super(...)` as a value, and
  the rest. The checker reports those as unbound names; that is the intended
  behaviour, not a false positive.
- **Not guaranteed.** Emitted helper selection. `len(xs)` may become a property
  read or a runtime call depending on context; both are correct, and neither is
  promised.

## 7. Known deviations from Python

These are deliberate. They are listed because someone will otherwise report them
as bugs.

- `f"{x:.0f}"` uses `toLocaleString`, which rounds a tie away from zero;
  Python rounds to even. `1500.5` prints `1,501`.
- `getattr`, and every other builtin not listed in section 6, is not
  implemented. Unlike multiple inheritance it is not rejected by the parser: it
  emits verbatim and fails at runtime. This is the known sharp edge of the
  language; see section 8 for the warning that catches it.
- Multiple inheritance and `super().method()` with keyword arguments are compile
  errors, so they cannot reach runtime.
- Keyword arguments work for functions defined in the same file (the signature is
  known) and are a **compile error** for imported functions (it is not).
- Truthiness follows JavaScript, not Python: an empty list and an empty dict are
  truthy in JS terms. Use the runtime's `truthy()` for Python semantics.
- Integer division, `//`, and Python's arbitrary-precision integers do not exist.

## 8. Diagnostics: what is an error, what is a warning

The compiler emits two things and they behave differently.

**Errors** stop compilation and exit non-zero. They are: lexing/parsing failure,
an unsupported f-string spec, an unknown attribute keyword-argument combination,
a keyword argument to an imported function, output that fails the emitter's own
sanity check, and `.hyx`-specific shapes in a plain-JS target.

**Warnings** are advisory. They **never** change the exit code and **never**
change emitted code — the checker re-parses the source rather than sharing state
with the emitter, so it cannot alter output by construction. Currently there are
exactly two, both from `compiler-rs/src/check.rs`:

1. **Unbound name.** A bare name that is bound nowhere in the file, is not a
   JavaScript/browser global, is not a Python builtin, and is not a `hydra`
   runtime export. Reported once per distinct name.
2. **Unknown member.** `obj.member` where `obj`'s declared type is an interface
   written in the same file **and** that interface's member list could be read
   unambiguously. If the interface body contains an index signature, an
   intersection, or anything the simple reader does not understand, that
   interface is **skipped entirely** rather than guessed at.

The deliberate policy is: **silence over a wrong finding.** A checker that
reports something which is not a mistake gets switched off, and then it catches
nothing. Both rules are tuned to produce zero findings on `examples/*` and on a
real application before shipping. When adding a rule, add it to this list and
tune it the same way.

## 9. Not the language: the runner

`hydra dev`, `hydra build`, `hydra preview`, `hydra watch` and the bundler
integration are the **framework**, not the language. Their behaviour (port
selection, `/__hydra/version`, the runtime gate, `HYDRA_NO_GATE`) is documented in
`README.md` and may change between minor versions. The language contract above is
what a `.hyx` file is entitled to rely on.

## 10. What users are expected to do (a short list)

- Supply `key=` on the element returned by a `for` loop. The compiler does not
  invent one: any guess is wrong for some list.
- Import what they use, except `hydra` runtime helpers and browser globals.
- Not rely on emitted formatting, helper selection, or file layout.

## 11. Type declarations

**Guaranteed.** `hydra types` writes a declaration file at `<source>.d.ts`, so
`src/Widget.hyx` produces `src/Widget.hyx.d.ts`. That exact name is required:
TypeScript resolves a declaration for `./Widget.hyx` as `Widget.hyx.d.ts`, and a
sibling `Widget.d.ts` is ignored.

**Guaranteed.** A component with parameters `p1: T1, p2: T2 = ...` produces
`export interface <Name>Props` with `p1: <mapped T1>` and `p2?: <mapped T2>`, and
`export declare function <Name>(props: <Name>Props)`. The types are the same ones
the emitted JavaScript references, so the declaration and the code cannot drift
without a test failing.

**Guaranteed.** Python type names are **mapped**, never copied: `int` and `float`
to `number`, `str` to `string`, `bool` to `boolean`, `list` to `any[]`/`Array<T>`,
`dict` to `Record<string, any>`. A parameter with no annotation is `any`.

**Guaranteed.** A construct the generator cannot represent is **omitted**, not
approximated. A module with no exports produces no file at all, so a hand-written
declaration is never overwritten. A class is declared with a permissive index
signature rather than invented members.

**Not guaranteed.** A default export, and the members of a `type` alias (emitted
as `any`). Both are deliberate: a guess here would type-check code that will not
work.

## 12. Changing this document

A change to a **Guaranteed** line is a breaking change: it needs a version bump, a
migration note, and — where automatable — a codemod. A change to **Not
guaranteed** text is free. A new warning rule must be added to section 8 in the
same commit that adds it, and must come with the corpus check that shows it is
silent on real code.
