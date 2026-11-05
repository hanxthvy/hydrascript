<!-- [xihanzu-NR] -->
# Migrating between versions

A breaking change means a version bump **and** an entry here. The rule exists
because frameworks die when people stop daring to upgrade: a breaking change
without a written path is a reason to stay put, and authors undercount how long
"later" lasts. Pre-1.0 is not an excuse to skip this — it is when it is cheapest.

Automate it when it can be automated (a codemod under `scripts/`), and describe it
precisely when it cannot. "Some things changed" is not an entry.

Honest state of that rule: **no entry here has needed a codemod yet**, and every
one of them says in its own words why. Three of the changes only ever removed a
failure (`getattr`, `any`, `super().method()` — there is nothing to edit), and
the rest were fixed by deleting a workaround. There is no `hydra migrate`
command, and there will not be one until a breaking change is genuinely
mechanical — a rename or a signature change. A command that exists but has
nothing to run is a promise with no content, which is the thing this file is
written to avoid.

---

## 0.13.1 -> 0.13.2

### 1. Tailwind is yours to install

`hydrascript` no longer depends on `tailwindcss`, `postcss` or `autoprefixer`, and
it no longer applies Tailwind to every build. If your project used the
framework's copy, it now gets plain CSS — and a stylesheet that still says
`@tailwind base;` will ship those directives to the browser, where they mean
nothing.

The fix, once:

```bash
npm i -D tailwindcss postcss autoprefixer
```

```json
// hydraconfig.json
{ "tailwind": {} }
```

If you already have a `tailwind.config.js`, that alone is enough — the key is
only needed when the config is expressed in `hydraconfig.json`.

Nothing else changes: same `@tailwind` directives in `src/index.css`, same
emitted stylesheet.

### 2. Using something other than Tailwind

This release adds the paths that did not exist before, so nothing breaks here —
it is listed because the old documentation said a project "needs no
`postcss.config.js`", which was true and is now false.

- `postcss.config.{js,mjs,cjs,ts}` — used as-is, plugins and all
- `"styling": ["autoprefixer", "./my-plugin.mjs"]` — exactly those plugins
- nothing — plain PostCSS, Autoprefixer only if installed

### 3. `styling` is read now

`"styling": { "tailwind": true }` never did anything (the schema said so). It now
means "run a PostCSS plugin named `tailwind`", which is not a package — so a
project carrying that dead key will fail with a resolve error naming it. Replace
it with the top-level `"tailwind"` key.

## 0.11.x -> 0.12.0

Five behaviours changed, and each has a line you can edit. Nothing here needs a
codemod: four of the five are one word in one place, and the fifth is a config
key.

### 1. `str(x)` prints Python's spelling

```python
label = str(flag)    # "true" before, "True" now
name = str(none_value)  # "null" before, "None" now
```

If a page shows a boolean or a nullable value and you want the old text, format
it explicitly rather than relying on `str`:

```python
label = "true" if flag else "false"
```

Nothing else changed about `str`: numbers print the same digits.

### 2. `type(x).__name__` returns a Python name

| value | before | now |
|---|---|---|
| `{}` | `Object` | `dict` |
| `[]` | `Array` | `list` |
| `1` | `Number` | `int` |
| `1.5` | `Number` | `float` |
| `True` | `Boolean` | `bool` |
| `None` | **threw** | `NoneType` |

Anything comparing against the JavaScript names has to change; before this
release, `type(None).__name__` did not run at all.

### 3. `isinstance` separates `int` from `float`

```python
isinstance(True, int)    # was false, now true   (Python: True is an int)
isinstance(1.5,  int)    # was true,  now false
isinstance(1,    float)  # was true,  now false
```

### 4. Source maps are off by default

```json
{ "build": { "sourcemap": true } }
```

A production build used to ship `dist/assets/index-*.js.map` containing every
line of your source in `sourcesContent`, and the built-in server served it. Turn
it back on if you upload maps to an error tracker; `"hidden"` is not a separate
mode, so a map you ship is a map a visitor can fetch.

### 5. `dist/` is emptied before a build

```json
{ "build": { "clean": false } }
```

Useful only when `dist/` holds files this build does not own — a hand-placed
asset, say. The default is on because the alternative is that a page you deleted
from `src/pages` keeps answering at its old URL, with whatever data was baked
into it.

### 6. API error bodies have a `code`

Every framework error is `{error, code, detail?}`. A client that only reads
`error` keeps working; one that parsed `limit` or `allow` out of the top level
now finds it under `detail`.

```js
// before
const limit = (await res.json()).limit;
// now
const { detail } = await res.json();
const limit = detail.limit;
```

`fail(status, data)` is unchanged: its body is whatever the handler returned.

### 7. `src/api` folders are URLs

A file that used to be ignored — `src/api/admin/users.hys` — now answers
`/api/admin/users`. That is the intended direction, but a project that kept a
folder of non-route helpers under `src/api` must rename it with a leading `_`,
which is private at any level.

## Behaviour that changed without needing an edit

- `redirect()` and `fail()` from a loader now answer with a real HTTP status. A
  project that worked around the old behaviour by rendering its own redirect
  page can delete that page.
- `return [1, 2, 3]` from an API handler is now a list. A handler that meant
  `(body, status)` and returned a two-element array still works; one that
  returned a longer array never worked and now returns the array.
- `HEAD` is answered wherever `GET` is.
- A request body over 1 MiB is a 413. `server.bodyLimit` raises it.
- A loader sees real headers and the query string. A loader that used to receive
  `undefined` for both will now receive values — check any conditional that
  relied on the empty case.
- `.env.local` is read (and gitignored). A key that was set there and silently
  ignored now takes effect; that is the intended direction, but it is a change
  in what the build sees.

---

## 0.9.x -> 0.10.0

**Nothing here requires editing a file, unless you already have a `.env`.**

### A client file that reads a non-`PUBLIC_` variable now fails the build

Before 0.10, `process.env.ANYTHING` in a component or a `.hys` it imports
compiled to a real `process` lookup, which is `undefined` in a browser — a
silent empty value, or a crash, depending on what you did with it. It is now a
build error naming the variable and the file.

Two ways out, and the choice is about where the value belongs, not about
syntax:

- **The value is server-only.** Move the read into a `*.server.hys` loader, an
  `src/api` route, or `src/middleware.hys`, and pass the result to the page as a
  prop (`loader` returns props) or fetch it from the API route.
- **The value is genuinely public.** Rename it to `PUBLIC_<NAME>` in `.env`. It
  is inlined into the bundle as a literal, which is exactly what you are
  agreeing to when you rename it.

A computed key — `process.env[name]` — is refused as well, and the fix is to
write the dot form: a computed key cannot be inlined at build time, and could
not be checked either.

### `hydra build` defaults to `--target static`, which is what it always did

If your project has no `src/api` and no `src/middleware.hys`, nothing changes:
the static target is the old behaviour, and the only new output is a `.hydra/build.json`
record. If you DO add API routes, `hydra build` prints every one of them as
dropped. That is not a warning to ignore — add `--target node` (or
`"build": { "target": "node" }`) to keep them.

### `.env` is read now, and a real environment variable wins

If a project has a `.env` that something else was loading, the values are the
same and the precedence is the one you would expect: the environment first, the
file second. Interpolation is NOT supported — `${OTHER}` stays the literal
string — so a `.env` that relied on it needs the value written out.

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
