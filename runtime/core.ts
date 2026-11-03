// [xihanzu-NR]
/**
 * HydraScript runtime, core half: no React, no DOM, no bundler plugin.
 *
 * Everything here is a pure function the compiler lowers a Python idiom onto —
 * number formatting, the builtins, the exception classes, dict/list/string ops,
 * truthiness. It lives in its own module because importing ANY of it from a
 * server file used to drag all of `react` and `react-dom` in with it: a
 * two-kilobyte API bundle became 1.25 MB and answered 13x slower, for a helper
 * that has nothing to do with a component.
 *
 * `hydra` re-exports this module, so `from "hydra" import len` keeps working and
 * the public surface is unchanged. `hydra/core` is the name a SERVER file should
 * import, and the build aliases `hydra` to this module for server bundles so a
 * `.hys` that imports a helper cannot pull the UI in by accident.
 */

/* ------------------------------------------------- f-string number format
 *
 * Python's `format(1.5, ":.0f")` is `2`, and `format(0.5, ":.0f")` is `0`:
 * ties go to the EVEN digit, and the tie is judged against the double's exact
 * binary value, not against its shortest printed form. JavaScript's `toFixed`
 * rounds ties AWAY from zero, which is a different answer for exactly the cases
 * a person notices — money, percentages, anything ending in .5.
 *
 * There is no option to make `toFixed` do it, so it is done here: expand the
 * double to plain decimal, look at the digit after the one being kept, and if it
 * is exactly a tie (5 followed by nothing), pick the even neighbour.
 *
 * `toFixed(100)` is what makes the expansion usable. Its spec picks the n
 * closest to the true value, and a double's exact decimal expansion needs at
 * most ~767 fraction digits, so 100 digits still separates a real tie from a
 * near one. Beyond |x| < 1e-100 the difference is below the precision any
 * f-string spec can express; that bound is stated rather than implied.
 */

/** Decimal digits of `Math.abs(x)`, without exponent notation. */
function plainDecimal(abs: number, digits: number): string {
  return abs.toFixed(digits)
}

/**
 * `py_fixed(x, n)` — Python's `format(x, "<spec>.Nf")`.
 *
 * Round-half-to-even on the exact value, negative zero preserved (`-0`), and
 * the non-finite spellings Python uses (`inf`, `-inf`, `nan`).
 */
export function py_fixed(x: any, n: number): string {
  const v = Number(x)
  const digits = Math.max(0, Math.trunc(n))
  if (Number.isNaN(v)) return 'nan'
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf'

  const negative = v < 0 || Object.is(v, -0)
  const plain = plainDecimal(Math.abs(v), 100)
  const dot = plain.indexOf('.')
  const intPart = plain.slice(0, dot)
  const fracAll = plain.slice(dot + 1)

  const keep = fracAll.slice(0, digits)
  const rest = fracAll.slice(digits)
  // A tie is exactly `5` followed by zeros, or nothing at all.
  const isTie = rest.length > 0 && rest[0] === '5' && /^0*$/.test(rest.slice(1))
  const roundUpWithoutTie = rest.length > 0 && !isTie && rest[0] >= '5'
  const lastKept = keep.length > 0 ? Number(keep[keep.length - 1]) : Number(intPart[intPart.length - 1])

  let bumped = keep === '' ? intPart : intPart + keep
  const shouldCarry = roundUpWithoutTie || (isTie && lastKept % 2 === 1)
  if (shouldCarry) {
    // String arithmetic: adding 1 to a 100-digit integer exceeds Number.
    const asInt = bumped
    let carry = ''
    let i = asInt.length - 1
    let add = 1
    const chars = asInt.split('')
    for (; i >= 0 && add === 1; i--) {
      const d = Number(chars[i]) + 1
      if (d === 10) {
        chars[i] = '0'
      } else {
        chars[i] = String(d)
        add = 0
      }
    }
    carry = chars.join('')
    if (add === 1) carry = '1' + carry
    bumped = carry
  }

  const cut = bumped.length - digits
  let outInt = cut > 0 ? bumped.slice(0, cut) : '0'
  let outFrac = cut > 0 ? bumped.slice(cut) : bumped.padStart(digits, '0')
  if (digits === 0) outFrac = ''
  // A carry can lengthen the integer part; that is the point of doing it by
  // string and not by arithmetic.
  outInt = outInt.replace(/^0+(?=\d)/, '') || '0'

  const body = digits > 0 ? `${outInt}.${outFrac}` : outInt
  if (!negative) return body
  // Python prints `-0` for a negative zero, so `negative` is NOT reduced to
  // "less than zero" above.
  return '-' + body
}

/**
 * `.pop()` — one name, two meanings, decided by the receiver.
 *
 * On a LIST `xs.pop()` removes and returns the LAST element. On a DICT
 * `d.pop("k")` removes the entry for that key and returns its value, with an
 * optional fallback. The compiler has one spelling for both, so the helper
 * dispatches: the receiver's type is the only thing that says which was meant.
 *
 * Routing the list case to `dict_pop` (the old mapping) read a key of
 * `undefined` and returned the fallback, so `xs.pop()` was `None` while the list
 * silently kept its element.
 */
export function pop_of(x: any, key: any = -1, fallback: any = null): any {
  if (Array.isArray(x)) {
    if (x.length === 0) throw new IndexError('pop from empty list')
    const at = key === undefined || key === null || key === -1 ? x.length - 1 : Number(key)
    const i = at < 0 ? x.length + at : at
    if (i < 0 || i >= x.length) throw new IndexError('pop index out of range')
    return x.splice(i, 1)[0]
  }
  if (Object.prototype.hasOwnProperty.call(x, key)) {
    const v = x[key]
    delete x[key]
    return v
  }
  if (fallback !== null) return fallback
  throw new KeyError(JSON.stringify(key))
}

/**
 * `xs[-1]` — Python's negative index, which JS reads as a missing property.
 *
 * `xs[-1]` is `undefined` in JS and the LAST element in Python, so a "peek at the
 * most recent item" returned `undefined`, silently, on every list. Only literal
 * negative indexes are rewritten (the compiler can see the sign), so this costs
 * nothing at a call site that was not written that way.
 */
/**
 * `xs[i]` with Python's bounds check.
 *
 * A negative literal index and a plain one both land here. The out-of-range
 * case used to return `undefined`, which travels: it becomes "undefined" in a
 * page, `NaN` in arithmetic, and a silent empty list in a loop. Python raises,
 * and `except IndexError:` is the code an author already wrote for it.
 */
export function py_at(xs: any, i: number): any {
  const idx = i < 0 ? (xs ? xs.length + i : -1) : i
  if (xs == null || idx < 0 || idx >= xs.length) {
    throw new IndexError(`list index out of range: ${i}`)
  }
  return xs[idx]
}

/**
 * `d[key]` with Python's KeyError.
 *
 * The compiler emits this for a subscript whose base it can see is a dict. A
 * missing key used to be `undefined`, so `except KeyError:` never fired and the
 * bad value travelled until it broke something unrelated.
 */
export function py_key(d: any, k: any): any {
  if (d == null) throw new KeyError(String(k))
  const present =
    d instanceof Map ? d.has(k) : Object.prototype.hasOwnProperty.call(d, k)
  if (!present) throw new KeyError(String(k))
  return d instanceof Map ? d.get(k) : d[k]
}

/**
 * `a * n` where the LEFT side is a string or a list — Python repeats.
 *
 * JS has no `*` for sequences, so `"ab" * 3` was `NaN` and `[0] * 3` was `0`:
 * a value that looks like arithmetic and is silently nonsense. Numbers keep the
 * numeric meaning, which is what the same operator means in Python.
 */
export function py_repeat(a: any, n: number): any {
  if (typeof a === 'number') return a * n
  if (typeof a === 'string') return a.repeat(Math.max(0, Math.trunc(n)))
  if (Array.isArray(a)) {
    const out: any[] = []
    for (let i = 0; i < Math.max(0, Math.trunc(n)); i++) out.push(...a)
    return out
  }
  return a as any
}

/**
 * `a == b` — Python's equality, which is STRUCTURAL for sequences.
 *
 * `[1, 2] == [1, 2]` is `false` in JavaScript because two array literals are two
 * objects. That comparison is everywhere in Python code — a guard, a memo check,
 * a state comparison — and it silently took the wrong branch. Numbers, strings,
 * booleans and null keep the `===` answer; arrays and plain objects compare by
 * value, recursively.
 */
export function py_eq(a: any, b: any): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b))
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!py_eq(a[i], b[i])) return false
    return true
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !py_eq(a[k], b[k])) return false
    return true
  }
  return false
}

/** `a != b` — the negation, so the two can never disagree. */
export const py_ne = (a: any, b: any): boolean => !py_eq(a, b)

/**
 * `a % b` — Python's sign, not JavaScript's.
 *
 * Python's result takes the SIGN OF THE DIVISOR: `-7 % 3` is 2, and JS's is -1.
 * The difference is invisible until it is not — a ring buffer index, a modulo
 * hash, a "which column is this" calculation all go one cell the wrong way for
 * negative input, and nothing throws.
 */
/**
 * `a / b` and `a // b` with Python's ZeroDivisionError.
 *
 * JavaScript answers `Infinity` and `NaN`, which are values that look like
 * numbers and poison every expression downstream. Python raises, and the
 * `except ZeroDivisionError:` block an author wrote is the handle for it.
 */
export function py_div(a: number, b: number): number {
  if (b === 0) throw new ZeroDivisionError('division by zero')
  return a / b
}

export function py_floordiv(a: number, b: number): number {
  if (b === 0) throw new ZeroDivisionError('integer division or modulo by zero')
  return Math.floor(a / b)
}

export function py_mod(a: number, b: number): number {
  const r = a % b
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r
}

/** Group the integer part in threes, as `,` does in Python's format spec. */
function groupThousands(intPart: string): string {
  const neg = intPart.startsWith('-')
  const digits = neg ? intPart.slice(1) : intPart
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return neg ? '-' + grouped : grouped
}

/**
 * `py_group(x, n)` — Python's `format(x, ",.Nf")` / `format(x, ",")`.
 *
 * Grouping is applied to the ALREADY-ROUNDED digits. `toLocaleString` does both
 * at once and rounds half-away, so it was the source of the same
 * disagreement `py_fixed` fixes. `n` of `null` means "no fixed precision",
 * which is Python's bare `,`.
 */
export function py_group(x: any, n: number | null): string {
  if (n === null || n === undefined) {
    const v = Number(x)
    if (!Number.isFinite(v)) return py_fixed(v, 0)
    return groupThousands(py_fixed(v, 0).split('.')[0])
  }
  const fixed = py_fixed(x, n)
  const [intPart, frac] = fixed.split('.')
  const grouped = groupThousands(intPart)
  return frac === undefined ? grouped : `${grouped}.${frac}`
}

/* ------------------------------------------------------- python builtins
 *
 * The handful of Python builtins that have no JavaScript equivalent but DO have
 * an exact one. Each of these lives here rather than in emitted inline code for
 * the same reason `len_of` does: the correct behaviour is a decision, and a
 * decision written once can be tested once.
 *
 * `any` and `all` are Python's short-circuiting forms — `xs.some(fn)` is the
 * equivalent for an array of booleans, but `any(xs)` on a boolean array is what
 * a Python developer actually writes, and `Array.prototype.some` with no
 * argument throws.
 */

/**
 * `any(xs)` — True if any element is truthy.
 *
 * Short-circuits like Python. An empty sequence is False, not undefined.
 */
export function any(xs: any): boolean {
  if (!xs) return false
  if (Array.isArray(xs)) return xs.some((x) => Boolean(x))
  if (typeof xs[Symbol.iterator] === 'function') {
    for (const x of xs) if (x) return true
    return false
  }
  return Boolean(xs)
}

/** `all(xs)` — True if every element is truthy. Empty is True, as in Python. */
export function all(xs: any): boolean {
  if (xs === null || xs === undefined) return false
  if (Array.isArray(xs)) return xs.every((x) => Boolean(x))
  if (typeof xs[Symbol.iterator] === 'function') {
    for (const x of xs) if (!x) return false
    return true
  }
  return Boolean(xs)
}

/**
 * `getattr(obj, name, default)` — Python's attribute read with a fallback.
 *
 * The two-argument form raises when the name is absent; the three-argument form
 * returns the default. Distinguishing "absent" from "present but undefined" is
 * the whole point, so `in` is used rather than a truthiness check.
 */
export function getattr(obj: any, name: string, ...rest: any[]): any {
  if (obj === null || obj === undefined) {
    if (rest.length >= 1) return rest[0]
    throw new TypeError(`getattr(): attribute '${name}' on ${obj}`)
  }
  if (name in Object(obj)) return obj[name]
  if (rest.length >= 1) return rest[0]
  throw new AttributeError(`'${name}'`)
}

/** `hasattr(obj, name)` — never raises, unlike a bare attribute read. */
export function hasattr(obj: any, name: string): boolean {
  return obj !== null && obj !== undefined && name in Object(obj)
}

/** `setattr(obj, name, value)` — returns the value, so it can be used inline. */
export function setattr(obj: any, name: string, value: any): any {
  if (obj === null || obj === undefined) {
    throw new TypeError(`setattr(): cannot set '${name}' on ${obj}`)
  }
  obj[name] = value
  return value
}

/**
 * `repr(x)` — the debugging form.
 *
 * Not identical to Python's: a JS object has no `__repr__`, so the closest
 * faithful thing is JSON for plain data and `String(x)` for everything else.
 * Claiming more than that would be a lie the first time it was used on a class.
 */
export function repr(x: any): string {
  if (typeof x === 'string') return JSON.stringify(x)
  if (x === null) return 'None'
  if (x === undefined) return 'None'
  if (typeof x === 'object') {
    try {
      return JSON.stringify(x)
    } catch {
      return String(x)
    }
  }
  return String(x)
}

/** An `AttributeError` for `getattr`/`setattr`: a real class, so `except` works. */
export class AttributeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttributeError'
  }
}

/* --------------------------------------------------------- exception classes
 *
 * Python's exception hierarchy, as real JS classes.
 *
 * `raise ValueError("bad")` and `except ValueError:` are documented in the
 * README, and both need a NAME to exist: the raise becomes
 * `new ValueError(...)`, the handler becomes `x instanceof ValueError`. They
 * were emitted as bare identifiers, so a module that used either threw
 * `ReferenceError: ValueError is not defined` the moment it loaded.
 *
 * They cannot all be `Error` aliases: every handler would then match every
 * error, which is worse than not compiling. The hierarchy here is Python's —
 * `ValueError` is a `LookupError`? no: Python's tree is
 *
 *     BaseException
 *       Exception
 *         ArithmeticError -> ZeroDivisionError, OverflowError
 *         LookupError -> KeyError, IndexError
 *         AssertionError, AttributeError, EOFError, RuntimeError,
 *         NotImplementedError, StopIteration, OSError -> FileNotFoundError,
 *         PermissionError, TypeError, ValueError
 *
 * and `except LookupError:` catching a `KeyError` is the reason to keep it.
 * The shape is asserted by a test, not just written here.
 */
export class BaseException extends Error {
  constructor(message = '') {
    super(message)
    this.name = new.target.name || 'BaseException'
  }
}
export class Exception extends BaseException {}
export class ArithmeticError extends Exception {}
export class ZeroDivisionError extends ArithmeticError {}
export class OverflowError extends ArithmeticError {}
export class LookupError extends Exception {}
export class KeyError extends LookupError {}
export class IndexError extends LookupError {}
export class AssertionError extends Exception {}
export class RuntimeError extends Exception {}
export class NotImplementedError extends RuntimeError {}
export class StopIteration extends Exception {}
/**
 * `TypeError` IS the JS built-in, not a subclass of ours.
 *
 * `except TypeError:` has to catch the ``x is not a function`` the ENGINE
 * throws, and a class of our own would never be in that error's prototype
 * chain. Exporting the native one makes the handler work in both directions
 * (a `raise TypeError(...)` and an engine TypeError), which is what a reader
 * expects from the name. `RangeError` is the same argument.
 */
export const TypeError = globalThis.TypeError
export const RangeError = globalThis.RangeError
export class ValueError extends Exception {}
export class OSError extends Exception {}
export class FileNotFoundError extends OSError {}
export class PermissionError extends OSError {}
export class UnicodeError extends ValueError {}


/* ------------------------------------------------------------- collections
 *
 * Python devs reach for len/sorted/sum constantly. The compiler rewrites the
 * common ones to plain JS, but these are the runtime fallbacks for the cases
 * the compiler cannot see (a variable holding a builtin, dynamic dispatch).
 */

export const len = <T,>(x: { length: number } | T[]): number => x.length

/**
 * `sorted(xs)` — Python's ordering, not JavaScript's.
 *
 * `Array.prototype.sort()` with no comparator compares the STRING forms, so
 * `sorted([10, 9, 100])` came out `[10, 100, 9]`: a build that succeeds and a
 * list in the wrong order, which is the worst kind of wrong. Numbers compare
 * numerically, everything else as text — Python compares homogeneous sequences
 * exactly this way, and a mixed sequence is a type error there rather than a
 * meaningful order.
 */
export const sorted = <T,>(xs: T[]): T[] =>
  xs
    .slice()
    .sort((a: any, b: any) =>
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a) < String(b)
          ? -1
          : String(a) > String(b)
            ? 1
            : 0,
    )

export const reversed = <T,>(xs: T[]): T[] => xs.slice().reverse()
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

/** `enumerate(xs)` -> [[0, x0], [1, x1], ...] */
export const enumerate = <T,>(xs: T[]): [number, T][] => xs.map((x, i) => [i, x])

/** `zip(a, b)` -> [[a0, b0], ...] truncated to the shorter input, like Python. */
export const zip = <A, B>(a: A[], b: B[]): [A, B][] =>
  Array.from({ length: Math.min(a.length, b.length) }, (_, i) => [a[i], b[i]] as [A, B])

/** `range(5)` / `range(2, 8)` / `range(0, 10, 2)` — same semantics as Python. */
export function range(...args: number[]): number[] {
  const [start, stop, step = 1] =
    args.length === 1 ? [0, args[0]] : args.length === 2 ? [args[0], args[1]] : args
  const out: number[] = []
  if (step > 0) for (let i = start; i < stop; i += step) out.push(i)
  else for (let i = start; i > stop; i += step) out.push(i)
  return out
}


/* ------------------------------------------------------------------- dict */

/** `d = dict_get(obj, "key", default)` — attribute access that will not throw. */
/**
 * `d.get(k)` / `d.get(k, default)`.
 *
 * Python's fallback for a MISSING key is `None`, and the compiler emitted
 * `undefined` for the one-argument form because `fallback` defaulted to nothing.
 * `None` is the value Python code tests with `is None`, so the difference is the
 * whole idiom. `!!in` rather than a truthiness check on the value: a key holding
 * `0` or `""` is present, and treating it as missing is a different bug.
 */
export const dict_get = <T,>(o: any, key: string, fallback: T | null = null): T | null =>
  o != null && key in o ? o[key] : fallback

/** `safe(fn)` — wrap a handler so a throw does not take down the tree. */
export function safe<A extends any[]>(fn: (...a: A) => void): (...a: A) => void {
  return (...a: A) => {
    try { fn(...a) } catch (e) {
      console.error('[hydra] handler threw:', e)
      throw e  // rethrow: an error boundary should still see it
    }
  }
}


/* --------------------------------------------------- python semantics core
 *
 * The compiler rewrites Python idioms that JavaScript either lacks or spells
 * with a different meaning. Each one lives here rather than being inlined so
 * the compiled output stays small and the behaviour stays in one place.
 */

/**
 * `"a" in xs` / `x in d` / `key in obj`
 *
 * JS `in` answers a different question (does the object have this KEY) and
 * throws a TypeError on a primitive. Python's `in` asks "is this value in
 * here", which needs a different implementation per container type.
 */
export function contains(container: any, item: any): boolean {
  if (container == null) return false
  if (typeof container === 'string') return container.includes(String(item))
  if (Array.isArray(container)) return container.includes(item)
  if (container instanceof Set) return container.has(item)
  if (container instanceof Map) return container.has(item)
  if (typeof container === 'object') {
    // A plain object is used as a dict: membership tests the keys.
    return Object.prototype.hasOwnProperty.call(container, item)
  }
  return false
}

/**
 * `len(xs)` — works for arrays, strings, Maps and plain objects (dicts).
 * A plain object has no `.length`, which is how `len(d)` used to evaluate to
 * `undefined` and silently poison every expression that touched it.
 */
export function len_of(x: any): number {
  if (x == null) return 0
  if (typeof x === 'string' || Array.isArray(x)) return x.length
  if (x instanceof Map || x instanceof Set) return x.size
  if (typeof x === 'object') return Object.keys(x).length
  return 0
}

/** `pow(a, b)` — Python's builtin; JS has Math.pow. */
export const pow = (a: number, b: number): number => Math.pow(a, b)

/** `divmod(a, b)` -> `[a // b, a % b]` */
export const divmod = (a: number, b: number): [number, number] => [
  Math.floor(a / b),
  a % b,
]

/** `xs[::-1]` — Python's slice with a step. `slice()` cannot express it. */
export function slice_step(
  obj: any,
  start: number | null,
  stop: number | null,
  step: number,
): any {
  if (obj == null) return obj
  const is_str = typeof obj === 'string'
  const src: any[] = is_str ? obj.split('') : Array.from(obj)
  const n = src.length
  if (step === 0) throw new Error('slice step cannot be zero')
  const out: any[] = []
  if (step > 0) {
    let i = start == null ? 0 : start < 0 ? Math.max(0, n + start) : start
    const end = stop == null ? n : stop < 0 ? Math.max(0, n + stop) : Math.min(stop, n)
    for (; i < end; i += step) out.push(src[i])
  } else {
    let i = start == null ? n - 1 : start < 0 ? n + start : Math.min(start, n - 1)
    const end = stop == null ? -1 : stop < 0 ? n + stop : stop
    for (; i > end; i += step) {
      const item = src[i]
      if (item !== undefined) out.push(item)
    }
  }
  return is_str ? out.join('') : out
}

/**
 * `assert cond, "message"` — throws on failure.
 * Emitting this as an expression made the check silently disappear, which is
 * worse than not writing it: the code looks guarded and is not.
 */
export function assert_(cond: unknown, message: string): void {
  if (!cond) throw new Error(String(message))
}

/** `raise ValueError("bad")` -> `throw`. */
export function raise_(err: unknown): never {
  throw err
}

/* ------------------------------------------------- dict / list / string ops
 *
 * Python methods that have no JS equivalent at all (not even a renamed one).
 */

/** `d.setdefault("k", [])` — insert if absent, then return the value. */
export const dict_setdefault = (o: any, key: string, fallback: any = null): any => {
  if (!Object.prototype.hasOwnProperty.call(o, key)) o[key] = fallback
  return o[key]
}

/** `d.update(other)` — in place, like Python. */
export const dict_update = (o: any, other: any): any => Object.assign(o, other)

/** `d.pop("k", fallback)` */
export const dict_pop = (o: any, key: string, fallback: any = null): any => {
  if (Object.prototype.hasOwnProperty.call(o, key)) {
    const v = o[key]
    delete o[key]
    return v
  }
  return fallback
}

/** `d.popitem()` — removes and returns the last key/value pair. */
export const dict_popitem = (o: any): [string, any] => {
  const keys = Object.keys(o)
  if (keys.length === 0) throw new Error('popitem(): dictionary is empty')
  const key = keys[keys.length - 1]
  const value = o[key]
  delete o[key]
  return [key, value]
}

/** `dict.fromkeys(xs, value)` */
export const dict_fromkeys = (keys: any[], value: any = null): Record<string, any> => {
  const out: Record<string, any> = {}
  for (const k of keys) out[k] = value
  return out
}

/**
 * `d.keys()`, `d.values()`, `d.items()`.
 *
 * These were emitted as `d.keys()` — a JavaScript METHOD CALL. For a plain
 * object literal (what `{"a": 1}` compiles to) that is `d.keys is not a
 * function` at runtime, while `hydra check` said nothing and the runtime gate
 * only noticed when the line happened to run. A real `Map` genuinely has these
 * methods, so both shapes are handled rather than breaking Map users to fix
 * object users.
 *
 * `dict_items` returns `[key, value]` PAIRS, which is what Python's `.items()`
 * gives and what `for k, v in d.items():` destructures.
 */
export const dict_keys = (d: any): any[] =>
  d instanceof Map ? Array.from(d.keys()) : Object.keys(d ?? {})

export const dict_values = (d: any): any[] =>
  d instanceof Map ? Array.from(d.values()) : Object.values(d ?? {})

export const dict_items = (d: any): any[] =>
  d instanceof Map ? Array.from(d.entries()) : Object.entries(d ?? {})

/** `xs.extend(ys)` — in place, like Python's list.extend. */
export const list_extend = <T,>(xs: T[], ys: Iterable<T>): T[] => {
  xs.push(...ys)
  return xs
}

/** `xs.insert(i, v)` — truthy return so it can be chained. */
export const list_insert = <T,>(xs: any, i: number, v: T): boolean => {
  // Non-array receivers with their own `insert` are left to themselves.
  if (!Array.isArray(xs)) {
    if (xs && typeof xs.insert === 'function') {
      xs.insert(i, v)
      return true
    }
    throw new Error('list.insert(i, x): x is not a list')
  }
  xs.splice(i, 0, v)
  return true
}

/**
 * Python's `list.remove(v)` removes by VALUE and raises when absent.
 *
 * Anything that is not an Array but does have its own `remove` — a
 * `DOMTokenList` from `classList`, a `Set`, another host object — keeps its own
 * semantics instead. Rewriting `element.classList.remove("dark")` into this
 * helper with no guard made it call `.indexOf` on a DOMTokenList, which threw
 * "n.indexOf is not a function" during a hydration effect and blanked the page.
 */
export const list_remove = <T,>(xs: any, v: T): boolean => {
  if (!Array.isArray(xs)) {
    if (xs && typeof xs.remove === 'function') {
      xs.remove(v)
      return true
    }
    throw new Error('list.remove(x): x is not a list')
  }
  const i = xs.indexOf(v)
  if (i < 0) throw new Error('list.remove(x): x not in list')
  xs.splice(i, 1)
  return true
}

/** `xs.index(v)` — throws when absent, like Python. */
export const list_index = <T,>(xs: any, v: T): number => {
  if (!Array.isArray(xs) && typeof xs?.indexOf !== 'function') {
    throw new Error('list.index(x): x is not a list')
  }
  const i = xs.indexOf(v)
  if (i < 0) throw new Error('list.index(x): x not in list')
  return i
}

/** `", ".join(xs)` -> `join(", ", xs)`: Python puts the separator on the string. */
export const join = (sep: string, xs: Iterable<any>): string => Array.from(xs).join(sep)

/**
 * Set helpers, named so `.add()` on an array cannot silently do nothing.
 *
 * A non-Set receiver that owns an `add`/`remove` — a `DOMTokenList` from
 * `classList`, a library's collection type — is delegated to instead of being
 * coerced. `classList.add(...)` reaching this helper used to work by luck;
 * `classList.remove(...)` did not, and took the whole page down with it.
 */
export const set_add = (s: any, v: any): any => {
  if (s instanceof Set || s instanceof WeakSet) {
    s.add(v)
    return s
  }
  if (s && typeof s.add === 'function') {
    s.add(v)
    return s
  }
  if (Array.isArray(s)) {
    if (!s.includes(v)) s.push(v)
    return s
  }
  throw new Error('set.add(x): x is not a set or list')
}

export const set_discard = (s: any, v: any): any => {
  if (s instanceof Set || s instanceof WeakSet) {
    s.delete(v)
    return s
  }
  if (s && typeof s.remove === 'function') {
    s.remove(v)
    return s
  }
  if (s && typeof s.delete === 'function') {
    s.delete(v)
    return s
  }
  if (Array.isArray(s)) {
    const i = s.indexOf(v)
    if (i >= 0) s.splice(i, 1)
    return s
  }
  throw new Error('set.discard(x): x is not a set or list')
}

/** `max(xs, key=f)` / `min(xs, key=f)` */
export function max_by<T,>(xs: T[], key: (x: T) => number): T | null {
  if (xs.length === 0) return null
  let best = xs[0]
  let bestKey = key(best)
  for (const x of xs) {
    const k = key(x)
    if (k > bestKey) {
      best = x
      bestKey = k
    }
  }
  return best
}

export function min_by<T,>(xs: T[], key: (x: T) => number): T | null {
  if (xs.length === 0) return null
  let best = xs[0]
  let bestKey = key(best)
  for (const x of xs) {
    const k = key(x)
    if (k < bestKey) {
      best = x
      bestKey = k
    }
  }
  return best
}

/**
 * `max(xs)` / `min(xs)` — ONE sequence.
 *
 * The compiler used to spread the argument into `Math.max(...xs)`. For a plain
 * array that answers correctly; for a Set, a string, a generator or the result of
 * `range(n)` it spreads nothing useful and returns NaN silently. Taking the
 * sequence and iterating is the same answer for the array case and a real answer
 * for the rest.
 *
 * An empty sequence is a ValueError, exactly as in Python — returning `-Infinity`
 * would let the NaN-shaped bug back in through a different door.
 */
export function max_of(xs: any): any {
  const arr = Array.isArray(xs) ? xs : [...(xs as Iterable<any>)]
  if (arr.length === 0) throw new ValueError('max() arg is an empty sequence')
  return arr.reduce((a, b) => (b > a ? b : a))
}

export function min_of(xs: any): any {
  const arr = Array.isArray(xs) ? xs : [...(xs as Iterable<any>)]
  if (arr.length === 0) throw new ValueError('min() arg is an empty sequence')
  return arr.reduce((a, b) => (b < a ? b : a))
}

/** `first(xs, fallback)` */
export const first_or = <T,>(xs: T[], fallback: T): T =>
  xs.length > 0 ? xs[0] : fallback

/** Extra string predicates Python has and JS does not. */
export const isAlnum = (s: string): boolean => /^[a-zA-Z0-9]+$/.test(s)
export const isSpace = (s: string): boolean => /^\s+$/.test(s)
export const isUpper = (s: string): boolean => s === s.toUpperCase() && /[A-Z]/.test(s)
export const isLower = (s: string): boolean => s === s.toLowerCase() && /[a-z]/.test(s)
export const center = (s: string, width: number, fill: string = ' '): string => {
  const pad = Math.max(0, width - s.length)
  const left = Math.floor(pad / 2)
  return fill.repeat(left) + s + fill.repeat(pad - left)
}
export const ljust = (s: string, width: number, fill: string = ' '): string =>
  s + fill.repeat(Math.max(0, width - s.length))
export const rjust = (s: string, width: number, fill: string = ' '): string =>
  fill.repeat(Math.max(0, width - s.length)) + s
export const swapcase = (s: string): string =>
  s.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
export const str_partition = (s: string, sep: string): [string, string, string] => {
  const i = s.indexOf(sep)
  return i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)]
}
export const str_rpartition = (s: string, sep: string): [string, string, string] => {
  const i = s.lastIndexOf(sep)
  return i < 0 ? ['', '', s] : [s.slice(0, i), sep, s.slice(i + sep.length)]
}

/* ------------------------------------------------------------- string helpers
 *
 * Python string methods with no exact JS equivalent. The compiler rewrites
 * `s.capitalize()` to `capitalize(s)`, so these are free functions rather than
 * prototype patches — never mutate a built-in.
 */

/**
 * `isinstance(x, int)` -> `isinstance(x, Number)`
 *
 * The compiler maps Python type names to their JS constructors and routes them
 * here, rather than inlining `typeof` checks: `typeof null === 'object'` and
 * `typeof [] === 'object'` are exactly the surprises this is meant to avoid,
 * and a Python developer writing `isinstance` expects Python's answer.
 */
export function isinstance(x: unknown, type: unknown): boolean {
  // Python's bool is a subclass of int, and its int and float are DIFFERENT
  // types that JavaScript spells with one (`Number`). Answering both questions
  // with `typeof x === 'number'` made `isinstance(True, int)` false, and made
  // `isinstance(1.5, int)` and `isinstance(1, float)` both true — three answers
  // that a Python author will read as "the framework is broken", and that
  // change which branch a validator takes.
  if (type === Number || (typeof type === 'function' && type.name === 'Number')) {
    return typeof x === 'number' && Number.isFinite(x)
  }
  if (type === String || (typeof type === 'function' && type.name === 'String')) {
    return typeof x === 'string'
  }
  if (type === Boolean || (typeof type === 'function' && type.name === 'Boolean')) {
    return typeof x === 'boolean'
  }
  if (type === Array || (typeof type === 'function' && type.name === 'Array')) return Array.isArray(x)
  if (type === Object || (typeof type === 'function' && type.name === 'Object')) {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
    const proto = Object.getPrototypeOf(x)
    return proto === Object.prototype || proto === null
  }
  if (type === null || type === undefined) return x === null || x === undefined
  if (typeof type === 'function') {
    try {
      return x instanceof (type as new (...a: unknown[]) => unknown)
    } catch {
      return false
    }
  }
  return false
}

/**
 * `isinstance(x, int)` / `isinstance(x, float)` — Python's two numeric types.
 *
 * The compiler lowers `isinstance(x, int)` to `isinstance_int(x)` when it can
 * see the name, because `int` and `float` both map to `Number` and the plain
 * helper cannot tell them apart.
 */
export function isinstance_int(x: unknown): boolean {
  return typeof x === 'boolean' || (typeof x === 'number' && Number.isInteger(x))
}

/** `isinstance(x, float)` — a number that is not integral. */
export function isinstance_float(x: unknown): boolean {
  return typeof x === 'number' && !Number.isInteger(x)
}

/**
 * `str(x)` — Python's spelling of a value.
 *
 * `String(x)` answers JS: `null`, `true`, `1` for `None`, `True`, `1.0`. A page
 * that shows `true` where Python shows `True` is a bug report about the
 * framework, not about the page, and a float that loses its `.0` is wrong data
 * on a receipt.
 */
export function py_str(x: unknown): string {
  if (x === null || x === undefined) return 'None'
  if (x === true) return 'True'
  if (x === false) return 'False'
  if (typeof x === 'number') {
    if (Number.isInteger(x) && !Object.is(x, -0)) return String(x)
    // Python prints 1.0 for a float that happens to be integral; JS cannot tell
    // `1.0` from `1`, so an integer stays an integer and a non-integer keeps its
    // digits. That is the honest limit, stated rather than guessed.
    return String(x)
  }
  if (Array.isArray(x)) return `[${x.map((v) => (typeof v === 'string' ? `'${v}'` : py_str(v))).join(', ')}]`
  if (x instanceof Map) {
    const parts = [...x.entries()].map(([k, v]) => `${typeof k === 'string' ? `'${k}'` : py_str(k)}: ${typeof v === 'string' ? `'${v}'` : py_str(v)}`)
    return `{${parts.join(', ')}}`
  }
  if (typeof x === 'object') {
    const proto = Object.getPrototypeOf(x)
    if (proto === Object.prototype || proto === null) {
      const parts = Object.entries(x as object).map(
        ([k, v]) => `'${k}': ${typeof v === 'string' ? `'${v}'` : py_str(v)}`,
      )
      return `{${parts.join(', ')}}`
    }
  }
  return String(x)
}

/** `"hello world".capitalize()` -> `"Hello world"` */
export const capitalize = (s: string): string =>
  s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase()

/** `"hello world".title()` -> `"Hello World"` */
export const title = (s: string): string =>
  s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())

/** `xs.count(x)` — Python counts occurrences, JS has no equivalent. */
export const count = <T,>(xs: T[], value: T): number =>
  xs.reduce((n, x) => (x === value ? n + 1 : n), 0)

/** `"{} and {}".format(a, b)` -> `format("{} and {}", a, b)` */
export const format = (template: string, ...args: unknown[]): string => {
  let i = 0
  return template.replace(/\{\}/g, () => String(args[i++] ?? ''))
}

/** `s.zfill(5)` -> `zfill(s, 5)` */
export const zfill = (s: string, width: number): string => s.padStart(width, '0')

/** `s.isdigit()` */
export const isDigit = (s: string): boolean => /^\d+$/.test(s)

/** `s.isalpha()` */
export const isAlpha = (s: string): boolean => /^[a-zA-Z]+$/.test(s)

/* ------------------------------------------------------------- styling helpers */

/**
 * `cx(...args)` — lightweight class combining for `.hsx`.
 * Handles strings, arrays, and boolean object dictionaries (`{"btn": true, "active": false}`).
 */
export function cx(...args: unknown[]): string {
  const classes: string[] = []
  for (const arg of args) {
    if (!arg) continue
    if (typeof arg === 'string') {
      classes.push(arg)
    } else if (Array.isArray(arg)) {
      const inner = cx(...arg)
      if (inner) classes.push(inner)
    } else if (typeof arg === 'object') {
      for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
        if (v) classes.push(k)
      }
    }
  }
  return classes.join(' ')
}

// [xihanzu-NR]

/* ----------------------------------------------------------------- numbers
 *
 * Python hands you round(), min/max clamping, and f-string formatting. JS
 * hands you `Math.round(3.5) === 4` but `(-3.5).toFixed(0) === "-4"`, and no
 * currency formatting at all. These are the missing verbs.
 */

/** `clamp(x, 0, 100)` — constrain to a range. Handles min > max gracefully. */
export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(Math.max(x, Math.min(lo, hi)), Math.max(lo, hi))

/** `lerp(0, 100, 0.25)` -> 25 — linear interpolation, `t` not clamped. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * `round(x)` / `round(x, n)` — Python's rounding, which is NOT `Math.round`.
 *
 * Python rounds a tie to the EVEN digit (`round(2.5)` is 2, `round(3.5)` is 4)
 * and judges that tie against the double's exact value; `Math.round` rounds
 * halfway cases up, so `round(2.5)` came out 3. Same disagreement `py_fixed`
 * settles for formatting, and the same reason: it shows up on money.
 *
 * `toFixed` is what makes the expansion usable — a double's exact decimal needs
 * at most ~767 fraction digits, so 100 separates a real tie from a near one.
 */
export const round_to = (x: number, digits: number = 0): number => {
  const v = Number(x)
  if (!Number.isFinite(v)) return v
  const n = Math.max(0, Math.trunc(digits))
  // `toFixed` is authoritative here only as a decimal expansion; the tie
  // decision below is made from the digits, not from its rounding.
  // `toFixed` caps at 100 digits TOTAL, so the expansion budget shrinks as the
  // requested precision grows. 100 is still far past any real tie.
  const plain = Math.abs(v).toFixed(Math.min(100, n + 100))
  const dot = plain.indexOf('.')
  const keep = plain.slice(0, dot) + plain.slice(dot + 1, dot + 1 + n)
  const rest = plain.slice(dot + 1 + n)
  const isTie = rest[0] === '5' && /^0*$/.test(rest.slice(1))
  const up = rest[0] > '5' || (isTie && Number(keep[keep.length - 1]) % 2 === 1)
  const bumped = (BigInt(keep) + (up ? 1n : 0n)).toString()
  const cut = bumped.length - n
  const out = Number(cut > 0 ? bumped.slice(0, cut) + '.' + bumped.slice(cut) : '0.' + bumped.padStart(n, '0'))
  return v < 0 || Object.is(v, -0) ? -out : out
}

/** `round(x)` — Python's one-argument form. */
export const round_py = (x: number): number => round_to(x, 0)

/**
 * `int(x)` — Python's constructor, which RAISES on a string it cannot parse.
 *
 * `parseInt` was what the compiler emitted before, and the two disagree on the
 * cases that matter: `parseInt("3.9")` is 3 (Python raises), `parseInt("12px")`
 * is 12 (Python raises), and `parseInt(3.9)` on a float is fine in both. The
 * difference is not cosmetic — a silent 12 from "12px" is a corrupt number that
 * travels.
 */
export function int(x: any, base: number = 10): number {
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new ValueError(`cannot convert ${x} to int`)
    return Math.trunc(x)
  }
  if (typeof x === 'boolean') return x ? 1 : 0
  if (x === null || x === undefined) throw new TypeError(`int() argument must be a string or a number, not ${x}`)
  const s = String(x).trim()
  const re = base === 16 ? /^[+-]?[0-9a-fA-F]+$/ : base === 8 ? /^[+-]?[0-7]+$/ : base === 2 ? /^[+-]?[01]+$/ : /^[+-]?\d+$/
  if (!re.test(s)) throw new ValueError(`invalid literal for int() with base ${base}: ${JSON.stringify(String(x))}`)
  return parseInt(s, base)
}

/**
 * `float(x)` — Python's constructor. `parseFloat("1.5abc")` is 1.5; Python
 * raises. Also accepts `inf`/`nan`, which `parseFloat` spells differently.
 */
export function float(x: any): number {
  if (typeof x === 'number') return x
  if (typeof x === 'boolean') return x ? 1 : 0
  if (x === null || x === undefined) throw new TypeError(`float() argument must be a string or a number, not ${x}`)
  const s = String(x).trim()
  const low = s.toLowerCase()
  if (low === 'inf' || low === '+inf' || low === 'infinity') return Infinity
  if (low === '-inf' || low === '-infinity') return -Infinity
  if (low === 'nan') return NaN
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    throw new ValueError(`could not convert string to float: ${JSON.stringify(String(x))}`)
  }
  return Number(s)
}

/** `format_number(1234567.891, "en-US")` -> "1,234,567.891" */
export const format_number = (n: number, locale: string = 'en-US', options?: Intl.NumberFormatOptions): string =>
  new Intl.NumberFormat(locale, options).format(n)

/** `format_currency(1234.5)` -> "$1,234.50" (USD unless told otherwise). */
export const format_currency = (n: number, currency: string = 'USD', locale: string = 'en-US'): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n)

/** `format_percent(0.1234, 1)` -> "12.3%" — input is a fraction, like Python's `{:.1%}`. */
export const format_percent = (x: number, digits: number = 0, locale: string = 'en-US'): string =>
  new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x)

/** `random_int(1, 6)` — inclusive on BOTH ends, like `random.randint`. */
export const random_int = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min

/**
 * `parse_number("1,234.5")` -> 1234.5
 * Strips currency symbols, thousands separators, and a trailing %, which is
 * what an <input type="text"> actually contains. Returns `fallback` on
 * anything unparseable rather than NaN.
 */
export function parse_number(s: string | number | null | undefined, fallback: number | null = null): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : fallback
  if (s == null) return fallback
  const cleaned = String(s).replace(/[^0-9.eE+-]/g, '')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : fallback
}

// [xihanzu-NR]
/* ----------------------------------------------------------------- strings */

/**
 * Split into words at case boundaries AND separators, preserving case.
 *
 * This is the one place the four case functions get their input, which is what
 * makes them agree: "hello world", "helloWorld", "hello_world" and
 * "hello-world" all produce the same four words, so all four styles round-trip.
 */
const split_words_raw = (s: string): string[] =>
  String(s ?? '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // HTTPServer -> HTTP Server
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // helloWorld  -> hello World
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)

/** `[w.lower() for w in ...]` — the words of a name, lowercased. */
const split_words = (s: string): string[] => split_words_raw(s).map((w) => w.toLowerCase())

/** `words("helloWorld")` -> ["hello", "World"] — case preserved. */
export const words = (s: string): string[] => split_words_raw(s)

/** `slugify("Hello World!")` -> "hello-world" — URL-safe, ASCII. */
export const slugify = (s: string): string => split_words(s).join('-')

/**
 * `truncate("a long title", 10)` -> "a long ti…"
 * `n` is the TOTAL length including the ellipsis, so the result never
 * overflows a container sized for `n` characters.
 */
export const truncate = (s: string, n: number, end: string = '…'): string => {
  const str = String(s ?? '')
  if (str.length <= n) return str
  if (n <= end.length) return end.slice(0, Math.max(0, n))
  return str.slice(0, n - end.length) + end
}

/** `camel_case("hello world")` -> "helloWorld" */
export const camel_case = (s: string): string =>
  split_words(s).reduce((out, w, i) => out + (i === 0 ? w : w[0].toUpperCase() + w.slice(1)), '')

/** `snake_case("helloWorld")` -> "hello_world" */
export const snake_case = (s: string): string => split_words(s).join('_')

/** `kebab_case("helloWorld")` -> "hello-world" */
export const kebab_case = (s: string): string => split_words(s).join('-')

/** `pascal_case("hello_world")` -> "HelloWorld" */
export const pascal_case = (s: string): string =>
  split_words(s).map((w) => w[0].toUpperCase() + w.slice(1)).join('')

/** `pluralize(1, "item")` -> "1 item"; `pluralize(3, "item")` -> "3 items". */
export const pluralize = (n: number, one: string, many?: string): string =>
  `${n} ${n === 1 ? one : many ?? one + 's'}`

/** `possessive("Hanz")` -> "Hanz's"; `possessive("Chris")` -> "Chris'". */
export const possessive = (s: string): string =>
  /s$/i.test(String(s ?? '')) ? `${s}'` : `${s}'s`

/** `mask("4111111111111234", 4)` -> "************1234" — keeps the last `keep`. */
export const mask = (s: string, keep: number = 4): string => {
  const str = String(s ?? '')
  if (str.length <= keep) return str
  return '*'.repeat(str.length - keep) + str.slice(str.length - keep)
}

/** `strip_html("<b>hi</b>")` -> "hi" — for rendering user HTML as text. */
export const strip_html = (s: string): string =>
  String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** `escape_html("<b>")` -> "&lt;b&gt;" — the safe way to show markup as text. */
export const escape_html = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** `format_bytes(1536)` -> "1.5 KiB" — binary units, one decimal. */
export function format_bytes(n: number, digits: number = 1): string {
  if (!Number.isFinite(n)) return '0 B'
  const neg = n < 0
  let v = Math.abs(n)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const out = i === 0 ? `${Math.round(v)} B` : `${round_to(v, digits)} ${units[i]}`
  return neg ? `-${out}` : out
}

/** `format_duration(3661)` -> "1h 1m 1s" — compact, drops leading zero units. */
export function format_duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0s'
  const neg = seconds < 0
  let s = Math.floor(Math.abs(seconds))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  // Always show seconds unless a larger unit is present and seconds are zero —
  // "1h 0m" reads worse than "1h".
  if (s || parts.length === 0) parts.push(`${s}s`)
  return (neg ? '-' : '') + parts.join(' ')
}

// [xihanzu-NR]
/* ------------------------------------------------------------------ arrays
 *
 * All of these are non-mutating, matching Python's list comprehensions rather
 * than JS's `sort`/`splice` in-place surprises.
 */

/** `unique([1, 1, 2])` -> [1, 2] — first occurrence wins, order preserved. */
export const unique = <T,>(xs: T[]): T[] => Array.from(new Set(xs))

/** `unique_by(users, lambda u: u.id)` — dedupe by a derived key. */
export function unique_by<T, K>(xs: T[], fn: (x: T) => K): T[] {
  const seen = new Set<K>()
  const out: T[] = []
  for (const x of xs) {
    const k = fn(x)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(x)
    }
  }
  return out
}

/** `chunk([1,2,3,4,5], 2)` -> [[1,2],[3,4],[5]] — last chunk may be short. */
export function chunk<T>(xs: T[], n: number): T[][] {
  if (n <= 0) return []
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** `flatten([1, [2, [3]]])` -> [1, 2, 3] — fully recursive, unlike `Array.flat()`. */
export function flatten<T>(xs: any[]): T[] {
  const out: T[] = []
  for (const x of xs) {
    if (Array.isArray(x)) out.push(...flatten<T>(x))
    else out.push(x as T)
  }
  return out
}

/** `group_by(people, lambda p: p.city)` -> {London: [...], Paris: [...]} */
export function group_by<T, K extends string | number>(
  xs: T[],
  fn: (x: T) => K
): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const x of xs) {
    const k = fn(x)
    if (!out[k]) out[k] = []
    out[k].push(x)
  }
  return out
}

/** `partition(nums, lambda n: n > 0)` -> [[positives], [rest]] — like Python's. */
export function partition<T>(xs: T[], fn: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = []
  const no: T[] = []
  for (const x of xs) (fn(x) ? yes : no).push(x)
  return [yes, no]
}

/** `first(xs)` -> xs[0] or None — no `undefined` leaking into the render. */
export const first = <T,>(xs: T[], fallback: T | null = null): T | null =>
  xs && xs.length > 0 ? xs[0] : fallback

/** `last(xs)` -> xs[-1] or None. */
export const last = <T,>(xs: T[], fallback: T | null = null): T | null =>
  xs && xs.length > 0 ? xs[xs.length - 1] : fallback

/** `compact([0, 1, None, "", 2])` -> [1, 2] — drops Python-falsy values. */
export const compact = <T,>(xs: T[]): T[] => xs.filter((x) => truthy(x))

/** `sort_by(users, lambda u: u.age)`; add `desc=True` for descending. */
export function sort_by<T>(xs: T[], fn: (x: T) => any, desc: boolean = false): T[] {
  return xs.slice().sort((a, b) => {
    const ka = fn(a)
    const kb = fn(b)
    // null/undefined sort last in ascending order rather than throwing.
    if (ka == null && kb == null) return 0
    if (ka == null) return 1
    if (kb == null) return -1
    const cmp = ka < kb ? -1 : ka > kb ? 1 : 0
    return desc ? -cmp : cmp
  })
}

/** `shuffle(xs)` — Fisher-Yates on a copy; the input is untouched. */
export function shuffle<T>(xs: T[]): T[] {
  const out = xs.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** `sample(xs)` — one random element, or None when the list is empty. */
export const sample = <T,>(xs: T[]): T | null =>
  xs && xs.length > 0 ? xs[Math.floor(Math.random() * xs.length)] : null

/** `zip_dict(["a", "b"], [1, 2])` -> {a: 1, b: 2} — truncated to the shorter. */
export function zip_dict<K extends string | number, V>(keys: K[], values: V[]): Record<K, V> {
  const out = {} as Record<K, V>
  const n = Math.min(keys.length, values.length)
  for (let i = 0; i < n; i++) out[keys[i]] = values[i]
  return out
}

// [xihanzu-NR]

/**
 * `truthy(x)` — Python truthiness, for a CONDITION.
 *
 * The empty-container rule is the whole reason this exists: `[]` and `{}` are
 * true in JS and False in Python. But it applies to PLAIN containers only. A
 * single object literal is Python's only way to spell a record, and a DOM
 * element, a Map, a Set and a React ref are all `typeof 'object'` too; keying off
 * `Object.keys().length` made `if el:` false for every HTML element the app ever
 * looked up (an element has no OWN enumerable keys), and `if ref.current:` false
 * for a ref holding one. That is a branch silently never taken.
 *
 * So: arrays by length, plain objects by key count, everything else by JS
 * truthiness — which already agrees with Python for `null`/`0`/`''`/`NaN`.
 */
export const truthy = (x: unknown): boolean => {
  if (x == null) return false
  if (Array.isArray(x)) return x.length > 0
  if (x instanceof Map || x instanceof Set) return x.size > 0
  if (typeof x === 'object') {
    const proto = Object.getPrototypeOf(x)
    // `Object.create(null)` and `{}` are plain; classes, elements, refs are not.
    if (proto === Object.prototype || proto === null) return Object.keys(x as object).length > 0
    return true
  }
  return Boolean(x)
}

/* ---------------------------------------------------------- pure helpers
 *
 * The ones from the React half that never touch React or the DOM. They live
 * here because a server file reaching for `retry()` or `uuid()` through
 * `hydra` used to drag the whole UI runtime into its bundle.
 */

/** `sleep(ms)` — await a delay. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** `deep_merge(a, b)` — plain-object merge, arrays replaced not concatenated. */
export function deep_merge<T>(base: T, patch: any): T {
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return (patch as T) ?? base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) }
  for (const k of Object.keys(patch)) {
    const b = (base as any)[k]
    const p = patch[k]
    out[k] = b && p && typeof b === 'object' && typeof p === 'object' && !Array.isArray(b) && !Array.isArray(p)
      ? deep_merge(b, p)
      : p
  }
  return out
}

/** `deep_clone(x)` — structured clone where available, JSON as the fallback. */
export function deep_clone<T>(x: T): T {
  if (x === null || typeof x !== 'object') return x
  const sc = (globalThis as any).structuredClone
  if (typeof sc === 'function') {
    try { return sc(x) } catch { /* functions inside: fall through */ }
  }
  return JSON.parse(JSON.stringify(x))
}

/** `is_empty(x)` — Python's falsy test for the containers it has. */
export function is_empty(x: unknown): boolean {
  if (x == null) return true
  if (typeof x === 'string' || Array.isArray(x)) return x.length === 0
  if (x instanceof Map || x instanceof Set) return x.size === 0
  if (typeof x === 'object') return Object.keys(x as object).length === 0
  return false
}

/** `pick(d, keys)` — a new dict with only those keys. */
export function pick(o: any, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const k of keys) if (o != null && k in o) out[k] = o[k]
  return out
}

/** `omit(d, keys)` — a new dict without those keys. */
export function omit(o: any, keys: string[]): Record<string, any> {
  const drop = new Set(keys)
  const out: Record<string, any> = {}
  for (const k of Object.keys(o || {})) if (!drop.has(k)) out[k] = o[k]
  return out
}

/** `a == b` for the deep case: Python's `==` compares values, JS compares refs. */
export function equals(a: any, b: any): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `uuid()` — RFC4122 v4, with crypto when the platform has it. */
export function uuid(): string {
  const c: any = (globalThis as any).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** `random_id(n)` — n random base36 characters, no dashes. */
export function random_id(n: number = 8): string {
  let out = ''
  while (out.length < n) out += Math.random().toString(36).slice(2)
  return out.slice(0, n)
}

/** `retry(fn, times, delay)` — call again on throw, then give up with the error. */
export async function retry<T>(
  fn: () => Promise<T> | T,
  times: number = 3,
  delay: number = 200,
): Promise<T> {
  let last: unknown
  for (let i = 0; i < Math.max(1, times); i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (i + 1 < times && delay > 0) await sleep(delay)
    }
  }
  throw last
}

/** `once(fn)` — the first call runs, every later call returns that result. */
export function once<T extends (...a: any[]) => any>(fn: T): T {
  let called = false
  let result: any
  return ((...args: any[]) => {
    if (!called) {
      called = true
      result = fn(...args)
    }
    return result
  }) as T
}

/** `throttled_fn(fn, ms)` — at most one call per window, trailing call kept. */
export function throttled_fn<T extends (...a: any[]) => any>(fn: T, ms: number): T {
  let last = 0
  let pending: any = null
  return ((...args: any[]) => {
    const now = Date.now()
    const wait = ms - (now - last)
    if (wait <= 0) {
      last = now
      return fn(...args)
    }
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      last = Date.now()
      pending = null
      fn(...args)
    }, wait)
    return undefined
  }) as T
}

/** `debounced_fn(fn, ms)` — only the last call in a burst runs. */
export function debounced_fn<T extends (...a: any[]) => any>(fn: T, ms: number): T {
  let t: any = null
  return ((...args: any[]) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      t = null
      fn(...args)
    }, ms)
    return undefined
  }) as T
}

/* ------------------------------------------------------- python type names
 *
 * `type(x).__name__` used to emit `x.constructor.name`, which answers the
 * JAVASCRIPT class: "Object" for a dict, "Array" for a list, "Number" for both
 * int and float, and a TypeError on `None`. Code that branches on a Python type
 * name therefore took the wrong branch silently, and crashed on the one value
 * Python names most often.
 *
 * `py_type_name` is what the compiler calls for `type(x).__name__`, and
 * `isinstance` uses the same classification, so the two agree.
 */
export function py_type_name(x: unknown): string {
  if (x === null || x === undefined) return 'NoneType'
  if (typeof x === 'boolean') return 'bool'
  if (typeof x === 'number') return Number.isInteger(x) ? 'int' : 'float'
  if (typeof x === 'string') return 'str'
  if (typeof x === 'bigint') return 'int'
  if (Array.isArray(x)) return 'list'
  if (x instanceof Set) return 'set'
  if (x instanceof Map) return 'dict'
  if (x instanceof Error) return x.constructor.name
  if (typeof x === 'function') return 'function'
  if (typeof x === 'object') {
    const proto = Object.getPrototypeOf(x)
    // A class instance keeps its own name (a component, a model); a plain
    // object or a null-prototype object is what Python calls a dict.
    if (proto === Object.prototype || proto === null) return 'dict'
    return (x as any).constructor?.name || 'object'
  }
  return typeof x
}

/**
 * `format(value, spec)` — Python's BUILTIN, which is a different function from
 * `format()` above (that one is `str.format`, a template expander).
 *
 * Emitting the builtin as `format(...)` routed it into the template helper and
 * threw `template.replace is not a function` on the first call: the name was
 * imported, the build was green, and the function was simply the wrong one.
 * The spec grammar is the subset `f"..."` already supports — fill, align, sign,
 * `0`, width, grouping, `.precision`, and the `f`/`%`/`d`/`s` types.
 */
export function py_format(value: unknown, spec: string): string {
  const s = String(spec || '')
  if (!s) return py_str(value)
  const m = /^(?:(.)?([<>=^]))?([+\- ])?(0)?(\d+)?(,)?(?:\.(\d+))?([fFdDis%])?$/.exec(s.trim())
  if (!m) {
    // Not a spec this implements. Throwing beats returning the value unchanged:
    // a wrong number that looks formatted is worse than a loud failure.
    throw new Error(`format(): unsupported format spec ${JSON.stringify(spec)}`)
  }
  const [, fill, align, sign, zero, width, grouping, precision, type] = m

  if (type === 's' || (!type && typeof value === 'string')) {
    return applyAlign(String(value), { fill, align, width, numeric: false })
  }
  if (type === 'd' || type === 'i') {
    const n0 = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n0)) throw new Error(`format(): ${py_str(value)} is not a finite number`)
    let digits0 = String(Math.trunc(Math.abs(n0)))
    if (grouping) digits0 = digits0.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    const neg0 = n0 < 0 || Object.is(n0, -0)
    const sign0 = neg0 ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : ''
    return applyAlign(sign0 + digits0, {
      fill,
      align: align || (zero ? '=' : undefined),
      width,
      numeric: true,
      zero,
      signChar: sign0,
    })
  }

  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new Error(`format(): ${py_str(value)} is not a finite number`)

  let digits = ''
  if (type === 'f' || type === 'F' || type === '%') {
    const p = precision === undefined ? 6 : Number(precision)
    const scaled = type === '%' ? n * 100 : n
    digits = Math.abs(scaled).toFixed(p)
  } else if (type === 'd' || type === 'i') {
    digits = String(Math.trunc(Math.abs(n)))
  } else if (precision !== undefined) {
    digits = Math.abs(n).toFixed(Number(precision))
  } else {
    digits = py_str(Math.abs(n))
  }
  if (grouping) {
    const [intPart, frac] = digits.split('.')
    digits = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac === undefined ? '' : `.${frac}`)
  }
  const negative = n < 0 || Object.is(n, -0)
  const signChar = negative ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : ''
  const suffix = type === '%' ? '%' : ''
  return applyAlign(signChar + digits + suffix, {
    fill,
    align: align || (zero ? '=' : undefined),
    width,
    numeric: true,
    zero,
    signChar,
  })
}

/** Pad a formatted value to `width` per Python's align rules. */
function applyAlign(
  text: string,
  opts: { fill?: string; align?: string; width?: string; numeric: boolean; zero?: string; signChar?: string },
): string {
  const w = opts.width ? Number(opts.width) : 0
  if (!w || text.length >= w) return text
  const pad = w - text.length
  const ch = opts.fill || '0'
  const align = opts.align || (opts.numeric ? '>' : '<')
  if (align === '<') return text + ch.repeat(pad)
  if (align === '^') {
    const left = Math.floor(pad / 2)
    return ch.repeat(left) + text + ch.repeat(pad - left)
  }
  if (align === '>') return ch.repeat(pad) + text
  // '=' — pad between the sign and the digits, which is what `05.2f` wants.
  if (opts.signChar && text.startsWith(opts.signChar)) {
    return opts.signChar + ch.repeat(pad) + text.slice(1)
  }
  return ch.repeat(pad) + text
}
