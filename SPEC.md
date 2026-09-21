# [xihanzu-NR]
# Serpent Language Specification v0.1

Pythonic syntax that compiles to React TSX. This document is the source of truth
for the grammar. `compiler_reference.py` is the reference implementation;
`compiler-rs/` must match it byte-for-byte (verified by `parity.py`).

---

## 1. Design Rules

These are the rules every syntax decision is checked against. They exist because
the failure mode of a new language is not "it doesn't compile" — it is "nobody
can debug it six months later."

1. **Explicit over implicit.** `computed` and `effect` take an explicit dependency
   array. No implicit tracking, no `$:` labels, no compiler-inferred reactivity.
   Svelte moved *away* from magic with Svelte 5 runes; we start where they landed.
2. **One obvious way.** A render tree is always indentation-nested `tag:` blocks.
   There is no second syntax for the same thing.
3. **The output is readable.** Generated TSX must be valid, lintable, and
   recognisable React. If a human can't read the output, they can't debug it.
4. **Every construct has one spelling.** No aliases, no optional parens that
   change meaning.
5. **Errors point at the source.** Every compile error carries line, column, the
   offending line, a caret, and a hint. Runtime errors map back via source map.

---

## 2. Lexical Structure

### 2.1 Indentation

- Blocks are delimited by indentation, like Python.
- The lexer emits `INDENT` and `DEDENT` tokens by comparing each non-blank line's
  leading spaces against a stack.
- **Any consistent width is allowed** (2, 4, 8 — the lexer does not care), but the
  width must be consistent within a file. A mismatch raises
  `inconsistent indentation: expected N spaces, got M`.
- Blank lines and comment-only lines are skipped entirely; they do not affect
  indentation.

### 2.2 Comments

`#` to end of line. No block comments.

### 2.3 Line continuation

Newlines are insignificant **inside parentheses, brackets, and braces**. This is
how multi-line element attribute lists work:

```serpent
button(
    on_click=handler,
    className="btn",
): "Label"
```

### 2.4 Identifiers and keywords

`[A-Za-z_][A-Za-z0-9_]*`. Keywords:
`component if elif else for in def return import from as and or not True False None lambda`

### 2.5 Literals

| Kind | Syntax | Compiles to |
|---|---|---|
| String | `"text"`, `'text'` | `"text"` |
| f-string | `f"hi {name}"` | `` `hi ${name}` `` |
| Number | `42`, `3.14` | `42`, `3.14` |
| Bool | `True`, `False` | `true`, `false` |
| None | `None` | `null` |
| List | `[1, 2, 3]`, `[]` | `[1, 2, 3]`, `[]` |
| Dict | `{"a": 1}`, `{}` | `{"a": 1}`, `{}` |
| Tuple | `(1, 2)`, `()` | `[1, 2]`, `[]` |

Escaped braces in f-strings: `f"{{literal}}"` -> `` `{literal}` ``.

---

## 3. Components

```serpent
component Name(param: type, param2: type = default):
    # body
```

- `component` is a keyword; the name must be capitalized by convention (the
  compiler treats capitalized call targets as components, lowercase as HTML tags).
- Parameters with a type become a generated `interface NameProps`.
- A parameter with any default becomes optional (`param?:`).
- **`x=None` is special**: it marks the prop optional but emits no JS default
  (`{ x }` not `{ x = null }`), so React's own `undefined` semantics apply.

```serpent
component Button(label: str, count: int = 0, on_click=None):
    button(on_click=on_click): label
```
```tsx
export function Button({ label, count = 0, on_click }: ButtonProps) {
  return <button onClick={on_click}>{label}</button>;
}

export interface ButtonProps {
  label: string;
  count?: number;
  on_click?: any;
}
```

### Type mapping

| Python | TypeScript |
|---|---|
| `str` | `string` |
| `int`, `float` | `number` |
| `bool` | `boolean` |
| `None` | `null` |
| `Any` | `any` |
| `list[T]` | `Array<T>` |
| `dict[K, V]` | `Record<K, V>` |
| `A \| B` | `A \| B` |

---

## 4. Tree Blocks

A tree block is an element call or bare tag followed by `:`.

```serpent
div(className="card"):
    h1: "Title"
    p: "Body"
    br:
```

Rules:
- The head is either a **bare tag** (`div:`) or a **call** (`div(cls="x"):`).
- The body is either **inline** (on the same line after `:`) or an **indented block**.
- An empty body self-closes: `<br />`.
- Only elements, `if`, and `for` may appear inside a tree block. Anything else
  (a `def`, a `return`, an assignment) is a compile error with a hint telling you
  to move it above the tree.
- A lone short inline child stays on one line: `h1: "Hi"` -> `<h1>Hi</h1>`.

### Prop name mapping

Python names are snake_case; React props are camelCase. Mapping happens at compile time.

| Serpent | React |
|---|---|
| `cls`, `class` | `className` |
| `for` | `htmlFor` |
| `on_click` | `onClick` |
| `on_change` | `onChange` |
| `on_input` | `onInput` |
| `on_submit` | `onSubmit` |
| `on_key_down` / `on_key_up` | `onKeyDown` / `onKeyUp` |
| `on_blur` / `on_focus` | `onBlur` / `onFocus` |
| `read_only` | `readOnly` |
| `auto_focus` | `autoFocus` |
| `tab_index` | `tabIndex` |
| `max_length` | `maxLength` |
| `col_span` / `row_span` | `colSpan` / `rowSpan` |

A **string literal** prop stays unquoted in braces: `cls="btn"` -> `className="btn"`.
Any other expression gets braces: `cls={cls_var}`.

---

## 5. Control Flow

### 5.1 In a tree block

```serpent
if is_admin:
    AdminPanel()
elif is_user:
    UserPanel()
else:
    GuestPanel()
```
```tsx
{is_admin ? (<AdminPanel />) : (is_user ? (<UserPanel />) : (<GuestPanel />))}
```

```serpent
ul:
    for item in items:
        li(key=item): item
```
```tsx
<ul>{items.map((item) => (<li key={item}>{item}</li>))}</ul>
```

A `for` or `if` body with multiple children is wrapped in a fragment `<>...</>`.

**Important**: an `elif` must NOT emit nested braces. The bug shape is
`{a ? x : {b ? y : z}}` — invalid JSX. The compiler strips the inner braces.

### 5.2 In a component body

`if` and `for` are ordinary statements there, emitting JS `if`/`for`.

---

## 6. Expressions

### 6.1 Operators (Python -> JS)

| Serpent | JS |
|---|---|
| `==` | `===` |
| `!=` | `!==` |
| `and` / `or` / `not` | `&&` / `\|\|` / `!` |
| `+ - * / %` | same |
| `a if c else b` | `c ? a : b` |
| `lambda x: expr` | `(x) => expr` |

### 6.2 Builtins (compile-time rewrite)

| Serpent | JS |
|---|---|
| `len(xs)` | `xs.length` |
| `str(x)` | `String(x)` |
| `int(x)` / `float(x)` | `parseInt(x)` / `parseFloat(x)` |
| `abs(x)` / `round(x)` | `Math.abs(x)` / `Math.round(x)` |
| `sum(xs)` | `xs.reduce((a, b) => a + b, 0)` |
| `sorted(xs)` | `xs.slice().sort()` |
| `reversed(xs)` | `xs.slice().reverse()` |
| `list(xs)` | `xs.slice()` |
| `bool(x)` | `Boolean(x)` |

### 6.3 String methods (compile-time rewrite)

`strip` -> `trim`, `lstrip` -> `trimStart`, `rstrip` -> `trimEnd`,
`upper` -> `toUpperCase`, `lower` -> `toLowerCase`,
`startswith` -> `startsWith`, `endswith` -> `endsWith`,
`replace` -> `replaceAll`, `find` -> `indexOf`.

### 6.4 List comprehension

```serpent
[x * 2 for x in xs]              # xs.map((x) => (x * 2))
[x for x in xs if x > 1]         # xs.filter((x) => (x > 1))   -- identity collapses
[x * 2 for x in xs if x > 1]     # xs.filter(...).map(...)
```

The `if` inside a comprehension is a **filter**, not a ternary. The parser uses
lower precedence for the iterable expression so `[x for x in a if b]` does not
parse as `[x for x in (a if b else ???)]`.

### 6.5 Spread

`div(*items, cls="x")` -> `<div {...items} className="x" />`

---

## 7. Runtime Library (`serpent` package)

| Export | Purpose |
|---|---|
| `state(init)` | `useState` — returns `[value, setter]`, setter accepts value or function |
| `computed(fn, deps)` | `useMemo` — explicit deps, no magic |
| `effect(fn, deps)` | `useEffect` |
| `ref(init)` | `useRef` — mutable, does not re-render |
| `callback(fn, deps)` | `useCallback` |
| `reducer(fn, init)` | `useReducer` |
| `context(default)` / `use(ctx)` | `createContext` + `useContext`, two calls not three |
| `fetch_json(url, deps)` | returns `{data, error, loading}` — never throws during render |
| `len` `sorted` `reversed` `sum` | runtime fallbacks for the compile-time rewrites |
| `enumerate` `zip` `range` | Python semantics |
| `truthy(x)` | Python truthiness: empty list/dict/string and 0 are falsy |
| `dict_get(o, k, fallback)` | safe attribute access |
| `safe(fn)` | wrap a handler, log and rethrow |

---

## 8. Errors

Every `CompileError` carries `line`, `col`, `src` (all source lines), and an
optional `hint`. `pretty()` renders:

```
error: a tree block must start with an element or component
  --> line 7, col 9
   |
 7 |         x = 1
   |         ^
   = hint: e.g. `div(className="x"):` or `h1:`
```

Errors are surfaced in three places:
1. CLI — stderr with ANSI colour
2. Vite — `this.error()` puts the same text in the browser overlay
3. VS Code — parsed from `--check` stderr into a diagnostic

---

## 9. Source Maps

The emitter records, for every generated line, the source line that produced it
(`Emitter.linemap`). `sourcemap()` VLQ-delta-encodes that into a v3 map with
`sourcesContent` embedded, so the browser can show the original `.hsx` even if
the file is not served.

One segment per generated line, excluding the appended
`//# sourceMappingURL=` comment.

**Why this matters**: CoffeeScript's decline was driven less by its syntax than by
the impossibility of debugging generated JS. A language that compiles must ship
mapping on day one, not as a later feature.

---

## 10. Non-Goals (deliberate)

- **Not valid Python.** These files are not importable by CPython. That is the
  price of `tag:` blocks and `component`. Do not feed them to mypy/pytest.
- **No runtime interpreter.** The compiler is a native binary; nothing Python
  ships to the browser or to CI.
- **No implicit reactivity.** See design rule 1.
- **No CSS-in-JS, no router, no data layer.** The framework is the language and
  the runtime primitives. Everything else is a normal React library.
- **No backwards-compatibility promise.** v0.x targets one small team.
