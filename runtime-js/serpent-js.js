// [xihanzu-NR]
/**
 * serpent-js — the runtime for `.hx` (Serpent's plain-JavaScript target).
 *
 * Same philosophy as the React runtime: every export is one sentence, and
 * nothing is a prototype patch. The compiler inlines what it can (`len(xs)`
 * becomes `xs.length`), so these are the cases it cannot see statically.
 */

/* ------------------------------------------------------------- collections */

/** `len(xs)` — runtime fallback when the compiler cannot inline it. */
export const len = (x) => x.length

/** `sorted(xs)` — non-mutating, unlike JS `Array#sort`. */
export const sorted = (xs) => xs.slice().sort()

/** `sorted(xs, key)` — Python's `key=` parameter. */
export const sorted_by = (xs, key) => xs.slice().sort((a, b) => {
  const ka = key(a), kb = key(b)
  return ka < kb ? -1 : ka > kb ? 1 : 0
})

/** `reversed(xs)` */
export const reversed = (xs) => xs.slice().reverse()

/** `sum(xs)` */
export const sum = (xs) => xs.reduce((a, b) => a + b, 0)

/**
 * `range(stop)` / `range(start, stop)` / `range(start, stop, step)`
 * Identical semantics to Python, including negative steps.
 */
export function range(...args) {
  const [start, stop, step = 1] =
    args.length === 1 ? [0, args[0]] : args.length === 2 ? [args[0], args[1]] : args
  const out = []
  if (step > 0) for (let i = start; i < stop; i += step) out.push(i)
  else if (step < 0) for (let i = start; i > stop; i += step) out.push(i)
  else throw new RangeError('range() arg 3 must not be zero')
  return out
}

/** `enumerate(xs)` -> `[[0, x0], [1, x1], ...]` */
export const enumerate = (xs, start = 0) => xs.map((x, i) => [i + start, x])

/** `zip(a, b)` — truncated to the shorter input, like Python. */
export const zip = (a, b) =>
  Array.from({ length: Math.min(a.length, b.length) }, (_, i) => [a[i], b[i]])

/** `dict(zip(keys, values))` */
export const dict_from_pairs = (pairs) => Object.fromEntries(pairs)

/** `xs.count(x)` */
export const count = (xs, value) => xs.reduce((n, x) => (x === value ? n + 1 : n), 0)

/** `xs.index(x)` — throws like Python when absent, unless a default is given. */
export function index_of(xs, value, fallback) {
  const i = xs.indexOf(value)
  if (i === -1 && fallback === undefined) {
    throw new Error(`${JSON.stringify(value)} is not in list`)
  }
  return i === -1 ? fallback : i
}

/* ------------------------------------------------------------------- truth */

/**
 * Python truthiness: empty list, empty dict, empty string, 0, None are falsy.
 * JS disagrees on `[]` and `{}`, which is the source of most port bugs.
 */
export const truthy = (x) =>
  x == null ? false
  : Array.isArray(x) ? x.length > 0
  : typeof x === 'object' ? Object.keys(x).length > 0
  : Boolean(x)

/** The inverse, for readability at call sites. */
export const falsy = (x) => !truthy(x)

/* -------------------------------------------------------------------- dict */

/** `d.get(k, default)` — attribute access that will not throw. */
export const dict_get = (o, key, fallback) =>
  o != null && key in o ? o[key] : fallback

/** `d.setdefault(k, default)` — returns the existing value or sets and returns. */
export function dict_setdefault(o, key, fallback) {
  if (o == null) throw new TypeError('dict_setdefault on null')
  if (!(key in o)) o[key] = fallback
  return o[key]
}

/** `d.keys()` / `d.values()` / `d.items()` as arrays, not iterators. */
export const dict_keys = (o) => Object.keys(o)
export const dict_values = (o) => Object.values(o)
export const dict_items = (o) => Object.entries(o)

/** `d1 | d2` — Python 3.9 dict merge. */
export const dict_merge = (a, b) => ({ ...a, ...b })

/* ------------------------------------------------------------------ string */

/** `"hello world".capitalize()` -> `"Hello world"` */
export const capitalize = (s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase())

/** `"hello world".title()` -> `"Hello World"` */
export const title = (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())

/** `"{} and {}".format(a, b)` -> `format("{} and {}", a, b)` */
export const format = (template, ...args) => {
  let i = 0
  return template.replace(/\{\}/g, () => String(args[i++] ?? ''))
}

/** `s.zfill(5)` */
export const zfill = (s, width) => s.padStart(width, '0')

/** `s.isdigit()` */
export const isDigit = (s) => /^\d+$/.test(s)

/** `s.isalpha()` */
export const isAlpha = (s) => /^[a-zA-Z]+$/.test(s)

/** `" ".join(xs)` — Python puts the separator first; JS puts the array first. */
export const join = (sep, xs) => xs.join(sep)

/** `s.split(sep, maxsplit)` */
export function split(s, sep, maxsplit) {
  if (maxsplit === undefined) return s.split(sep)
  const parts = s.split(sep)
  if (parts.length <= maxsplit + 1) return parts
  return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)]
}

/* ------------------------------------------------------------------- error */

/**
 * Python's ValueError / KeyError / IndexError as real classes, so an
 * `except ValueError` in `.hx` can compile to `catch (e) { if (e instanceof
 * ValueError) ... }` and actually match.
 */
export class ValueError extends Error {
  constructor(message) { super(message); this.name = 'ValueError' }
}
export class KeyError extends Error {
  constructor(key) { super(`KeyError: ${JSON.stringify(key)}`); this.name = 'KeyError'; this.key = key }
}
export class IndexError extends Error {
  constructor(message) { super(message); this.name = 'IndexError' }
}
export class TypeError_ extends Error {
  constructor(message) { super(message); this.name = 'TypeError' }
}
export class StopIteration extends Error {
  constructor() { super('StopIteration'); this.name = 'StopIteration' }
}

/** `int(x)` that raises ValueError instead of returning NaN. */
export function int(x) {
  const n = typeof x === 'number' ? Math.trunc(x) : parseInt(x, 10)
  if (Number.isNaN(n)) throw new ValueError(`invalid literal for int(): ${JSON.stringify(x)}`)
  return n
}

/** `float(x)` that raises ValueError instead of returning NaN. */
export function float(x) {
  const n = typeof x === 'number' ? x : parseFloat(x)
  if (Number.isNaN(n)) throw new ValueError(`could not convert to float: ${JSON.stringify(x)}`)
  return n
}

/** `xs[i]` that raises IndexError instead of returning undefined. */
export function at(xs, i) {
  if (i < 0) i += xs.length
  if (i < 0 || i >= xs.length) throw new IndexError('list index out of range')
  return xs[i]
}

/** `d[k]` that raises KeyError instead of returning undefined. */
export function at_key(o, key) {
  if (o == null || !(key in o)) throw new KeyError(key)
  return o[key]
}
