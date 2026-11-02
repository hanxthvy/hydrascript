// [xihanzu-NR]
/**
 * HydraScript runtime — the batteries.
 *
 * Design rule: every export here must be explicable in one sentence, and must
 * not surprise a Python developer. Where React's model differs from Python's
 * (immutability), we surface the difference in the NAME rather than hiding it.
 */
import React, {
  useState, useEffect, useMemo, useRef, useCallback, useContext,
  createContext, useReducer, Fragment, useId, useTransition,
  useDeferredValue, useLayoutEffect, Suspense, forwardRef,
  type DependencyList,
} from 'react'
import * as ReactDOM from 'react-dom/client'

import {
  matchRoute as core_match_route,
  parseQuery as core_parse_query,
  pickPageComponent as core_pick_page,
} from './router-core.js'

// A STATIC import, so the route table is present on the first render.
//
// It used to be `import('hydra:routes')` inside an effect, which is the shape
// everyone reaches for and which cannot work here: the first paint has no table,
// renders nothing, and then fills in — while the server's HTML for the same URL
// has content. React reports that as a hydration mismatch (#418), and the runtime
// gate caught it on the very case this is for: a correctly pre-rendered page.
import * as generated_routes from 'hydra:routes'

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


/* ------------------------------------------------------------------ state */

/**
 * `count, set_count = state(0)`
 *
 * The setter accepts a value OR a function, exactly like React's setState.
 * A function form is the Pythonic way to update a list without mutating:
 *     set_items(lambda old: old + [new_item])
 */
export function state<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const [v, set] = useState<T>(initial as any)
  return [v, set]
}

/**
 * `count = computed(lambda: len(items) * 2)`
 *
 * A derived value. Recomputes only when its dependencies change.
 * Pass deps explicitly — implicit dependency tracking would be "magic",
 * and magic is the thing that made CoffeeScript miserable to debug.
 */
export function computed<T>(fn: () => T, deps: DependencyList): T {
  return useMemo(fn, deps)
}

/** `effect(lambda: ..., [count])` — runs after render when deps change. */
export function effect(fn: () => void | (() => void), deps?: DependencyList): void {
  useEffect(fn, deps)
}

/** `box = ref(None)` — a mutable slot that does NOT trigger a re-render. */
export function ref<T>(initial: T): { current: T } {
  return useRef<T>(initial)
}

/** `handle = callback(lambda: ..., [dep])` — a stable function identity. */
export function callback<T extends (...a: any[]) => any>(fn: T, deps: DependencyList): T {
  return useCallback(fn, deps)
}

/** `count, dispatch = reducer(fn, 0)` — for state with more than two verbs. */
export function reducer<S, A>(fn: (s: S, a: A) => S, initial: S) {
  return useReducer(fn, initial)
}

/**
 * `is_open, toggle_open = toggle(False)`
 * Toggle boolean state without repetitive `set_open(lambda o: not o)` ceremony.
 */
export function toggle(initial: boolean = false): [boolean, () => void, (v: boolean) => void] {
  const [val, setVal] = useState<boolean>(initial)
  const flip = useCallback(() => setVal((v) => !v), [])
  return [val, flip, setVal]
}

/**
 * `debounced_query = debounce(query, 300)`
 * Delay state updates until typing or actions pause.
 */
export function debounce<T>(value: T, delay_ms: number = 300): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay_ms)
    return () => clearTimeout(timer)
  }, [value, delay_ms])
  return debounced
}

/**
 * `theme, set_theme = local_storage("app_theme", "dark")`
 * Syncs state with browser localStorage including JSON serialization.
 */
export function local_storage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [stored, setStored] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const item = window.localStorage.getItem(key)
      return item ? JSON.parse(item) : initial
    } catch {
      return initial
    }
  })

  const setValue = useCallback(
    (val: T | ((prev: T) => T)) => {
      setStored((prev) => {
        const next = typeof val === 'function' ? (val as (p: T) => T)(prev) : val
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(key, JSON.stringify(next))
          } catch (e) {
            console.error(`[hydrascript] localStorage error for key "${key}":`, e)
          }
        }
        return next
      })
    },
    [key]
  )

  return [stored, setValue]
}

/**
 * `mounted = use_mounted()`
 * Avoids React hydration mismatch when rendering client-only UI.
 */
export function use_mounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted
}

/* ---------------------------------------------------------------- context */

/**
 * `Theme = context("light")` then `value = use(Theme)`.
 * Two calls instead of React's three, because createContext+useContext
 * is the same verb wearing two hats.
 */
export function context<T>(defaultValue: T) {
  const ctx = createContext<T>(defaultValue)
  return { Provider: ctx.Provider, __ctx: ctx }
}

export function use<T>(c: { __ctx: React.Context<T> }): T {
  return useContext(c.__ctx)
}

/* ------------------------------------------------------------------ async */

export interface Async<T> {
  data: T | null
  error: Error | null
  loading: boolean
}

/**
 * `result = fetch_json("/api/todos")`
 *
 * Returns {data, error, loading} rather than throwing, because an exception
 * thrown during render is invisible to the person who wrote the fetch.
 * Add `deps` to refetch.
 */
export function fetch_json<T = any>(url: string, deps: DependencyList = []): Async<T> {
  const [s, set] = useState<Async<T>>({ data: null, error: null, loading: true })
  useEffect(() => {
    let live = true
    set({ data: null, error: null, loading: true })
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((d) => live && set({ data: d as T, error: null, loading: false }))
      .catch((e) => live && set({ data: null, error: e, loading: false }))
    return () => { live = false }
  }, deps)
  return s
}

/* ------------------------------------------------------------- collections
 *
 * Python devs reach for len/sorted/sum constantly. The compiler rewrites the
 * common ones to plain JS, but these are the runtime fallbacks for the cases
 * the compiler cannot see (a variable holding a builtin, dynamic dispatch).
 */

export const len = <T,>(x: { length: number } | T[]): number => x.length
export const sorted = <T,>(xs: T[]): T[] => xs.slice().sort()
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

/** Python-style truthiness: empty list/dict/string and 0 are falsy. */
export const truthy = (x: unknown): boolean =>
  x == null ? false
  : Array.isArray(x) ? x.length > 0
  : typeof x === 'object' ? Object.keys(x as object).length > 0
  : Boolean(x)

/* ------------------------------------------------------------------- dict */

/** `d = dict_get(obj, "key", default)` — attribute access that will not throw. */
export const dict_get = <T,>(o: any, key: string, fallback: T): T =>
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

/* ---------------------------------------------------------------- re-exports */

export {
  useState, useEffect, useMemo, useRef, useCallback, useContext, createContext,
  Fragment, useId, useTransition, useDeferredValue, useLayoutEffect, Suspense, forwardRef,
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
  if (type === Number) return typeof x === 'number' && Number.isFinite(x)
  if (type === String) return typeof x === 'string'
  if (type === Boolean) return typeof x === 'boolean'
  if (type === Array) return Array.isArray(x)
  if (type === Object) return typeof x === 'object' && x !== null && !Array.isArray(x)
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
/* --------------------------------------------------- SaaS routing & hydration */

/**
 * `mount(component, element)`
 * Hydrates if server-rendered child elements exist, otherwise creates a fresh root and renders.
 */
export function mount(component: any, element: HTMLElement | null) {
  if (!element) return null
  const node = typeof component === 'function' && !React.isValidElement(component)
    ? React.createElement(component)
    : component
  if (element.hasChildNodes() && element.children.length > 0) {
    return ReactDOM.hydrateRoot(element, node)
  } else {
    const root = ReactDOM.createRoot(element)
    root.render(node)
    return root
  }
}

/**
 * `path = use_path()`
 * Reactive hook returning current window.location.pathname or hash, listening to popstate.
 */
export function use_path(): string {
  const getPath = () => {
    // The pre-render pass walks several URLs with one module instance, so the
    // path it is currently rendering wins over `window.location` — which in SSG
    // is a stub that never changes.
    if (ssr_seed && ssr_seed.path) return ssr_seed.path
    if (typeof window === 'undefined') return '/'
    return (window.location.pathname !== '/' ? window.location.pathname : window.location.hash) || '/'
  }
  const [path, setPath] = useState<string>(getPath)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPopState = () => {
      setPath(getPath())
    }
    window.addEventListener('popstate', onPopState)
    window.addEventListener('hashchange', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('hashchange', onPopState)
    }
  }, [])

  return path
}

/**
 * `navigate(to)`
 * Client-side push navigation dispatching a PopStateEvent.
 */
export function navigate(to: string): void {
  if (typeof window !== 'undefined') {
    window.history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
}

export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  to?: string
  href?: string
  replace?: boolean
  children?: React.ReactNode
  [key: string]: any
}

/**
 * `Link`: component handling client-side transitions.
 */
export function Link({ to, href, onClick, replace = false, children, ...rest }: LinkProps) {
  const targetUrl = to ?? href ?? ''

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onClick) {
      onClick(e)
    }
    if (
      !e.defaultPrevented &&
      e.button === 0 &&
      (!rest.target || rest.target === '_self') &&
      !e.metaKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.shiftKey
    ) {
      e.preventDefault()
      if (replace) {
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', targetUrl)
          window.dispatchEvent(new PopStateEvent('popstate'))
        }
      } else {
        navigate(targetUrl)
      }
    }
  }

  return React.createElement('a', {
    href: targetUrl,
    onClick: handleClick,
    ...rest,
  }, children)
}

/* ------------------------------------------------------- file-based routing
 *
 * The route table is generated from the pages directory at build time and
 * arrives as the virtual module `hydra:routes`. Everything below works off that
 * one table, including the same matcher the CLI used to build it — see
 * `runtime/router-core.js` for why the matcher is not written twice.
 *
 * The table is read through a lazy, cached import rather than a static import,
 * because a project that does not use file-based routing must still be able to
 * import this runtime. A static import of a virtual module would make every
 * project require a generated file it has no pages for.
 */

export interface RouteEntry {
  pattern: string
  file: string
  params: string[]
  /** The page's `meta` dict, or null. Applied by `Router`; not a public hook. */
  meta?: { title?: string; description?: string } | null
}

/**
 * The per-page metadata a page declares at module level:
 *
 *     meta = {"title": "About — Hanz", "description": "Who writes this."}
 *
 * Two keys, `title` and `description`. Read from the page's source at build
 * time and carried in the route table, so the build can put them in the static
 * HTML and the browser can put them back after a navigation.
 */
export interface PageMeta {
  title?: string
  description?: string
}

/**
 * The generated route table.
 *
 * Every value except `notFound` is keyed by route pattern, so the table cannot
 * pair a page with the wrong layout: they are two views of one key.
 */
export interface RouteTable {
  routes: RouteEntry[]
  /**
   * pattern -> the page COMPONENT.
   *
   * Not a loader: the generated table imports each page statically, so the
   * component is here from the first render. See `Router` for why the lazy
   * shape had to go.
   */
  pages: Record<string, any>
  /** pattern -> the layout components, nearest first. */
  pageLayouts: Record<string, any[]>
  /** pattern -> the nearest `_error` component, or null. */
  pageErrors: Record<string, any>
  /** The `_404` component, or null. */
  notFound: any
  hasNotFound: boolean
  base: string
  /** pattern -> the page's `meta`. Only routes that declare one appear. */
  pageMeta: Record<string, PageMeta>
  /**
   * The project's own `index.html` title and description, read at build time.
   *
   * A route that declares no `meta` must put the SHELL's title back after a
   * navigation, not leave the previous page's in place, and the shell lives in
   * the project — not in the browser. Null means the shell has none, which a
   * page must be able to tell from an empty string.
   */
  shellMeta: { title: string | null; description: string | null }
}

/**
 * What the pre-render pass is currently rendering.
 *
 * `renderToString` runs no effects, and the build walks several URLs with one
 * module instance, so the seed is how a synchronous renderer learns which route
 * it is on. In the browser the seed is always null.
 */
export interface SsrSeed {
  table: RouteTable
  path?: string
  /** What the route's loader returned, for the page it renders. */
  data?: Record<string, any> | null
}

let ssr_seed: SsrSeed | null = null

/** Called by the generated pre-render entry. Not for application code. */
export function __seed_for_ssr(seed: SsrSeed): void {
  ssr_seed = seed
  if (seed.table) route_table_cache = seed.table
}

/** Clear the seed. Called after pre-rendering so nothing leaks into a later call. */
export function __clear_ssr_seed(): void {
  ssr_seed = null
  route_table_cache = undefined
}

let route_table_cache: RouteTable | undefined = undefined

/** Whatever `hydra:routes` gave us. Never null: the module always resolves. */
function readGeneratedTable(): RouteTable {
  const m: any = generated_routes
  return {
    routes: m.routes || [],
    pages: m.pages || {},
    pageLayouts: m.pageLayouts || {},
    pageErrors: m.pageErrors || {},
    notFound: m.notFound || null,
    hasNotFound: Boolean(m.hasNotFound),
    base: m.base || '/',
    pageMeta: m.pageMeta || {},
    shellMeta: m.shellMeta || { title: null, description: null },
  }
}

/**
 * The route table, SYNCHRONOUSLY.
 *
 * Not a hook. There is nothing to wait for: the module is imported statically, so
 * the table exists before the first render, in the browser and during
 * pre-rendering alike. That is the whole reason the import is static — see the
 * note at the top — and it is what makes a hook pointless here.
 *
 * During a pre-render the build's seed wins, because that pass renders several
 * URLs with one module instance.
 */
export function get_route_table_sync(): RouteTable {
  if (ssr_seed) return ssr_seed.table
  if (route_table_cache === undefined) route_table_cache = readGeneratedTable()
  return route_table_cache
}

/** Kept for callers written against the old name; same synchronous value. */
export function use_route_table(): RouteTable {
  return get_route_table_sync()
}

/**
 * `params = use_params()`
 *
 * The dynamic segments of the current URL, `{}` on a static route.
 */
export function use_params(): Record<string, string | string[]> {
  const match = use_route_match()
  return match ? match.params : {}
}

/**
 * `query = use_query_string()`
 *
 * The query string as an object. Named to stay out of the way of `use_query`,
 * which is this runtime's data-fetching hook and has nothing to do with URLs.
 */
export function use_query_string(): Record<string, string> {
  const path = use_path()
  const location = typeof window !== 'undefined' ? window.location.href : path
  return useMemo(() => core_parse_query(location), [location])
}

/**
 * The full route for the current URL.
 *
 * `pattern` and `file` are null when nothing matched, which is information the
 * caller usually wants: a page can tell "wrong URL" from "right URL, no data".
 */
export function use_route(): {
  path: string
  params: Record<string, string | string[]>
  query: Record<string, string>
  pattern: string | null
  file: string | null
} {
  const path = use_path()
  const query = use_query_string()
  const match = use_route_match()
  return {
    path,
    params: match ? match.params : {},
    query,
    pattern: match ? match.route.pattern : null,
    file: match ? match.route.file : null,
  }
}

/** The raw match for the current URL, or null. */
export function use_route_match(): { route: RouteEntry; params: Record<string, string | string[]> } | null {
  const path = use_path()
  const table = use_route_table()
  return useMemo(() => {
    if (!table || table.routes.length === 0) return null
    return core_match_route(path, table.routes as any) as any
  }, [path, table])
}

/**
 * Put the current page's `meta` into the document.
 *
 * Called by `Router`, which is the one place that knows both the matched
 * pattern and when navigation happened. Deliberately NOT a public hook: there
 * is no `use_head` for a page to call, because the whole point of a module-level
 * `meta` is that the page says it once and the framework applies it. A second
 * API for the same data would be one more thing to keep in sync.
 *
 * The effect is what makes it work on a CLIENT navigation: `navigate()` changes
 * the path, `use_path` re-renders, and the new route's title lands here. During
 * the first paint on a server-rendered page the effect does not run — the HTML
 * already has the right title, which is what SSG is for.
 */
function use_page_meta(meta: PageMeta, table: RouteTable | null): void {
  useEffect(() => {
    if (typeof document === 'undefined') return
    // The shell's own values, not the previous route's: a page with no `title`
    // of its own must not inherit the title of the page it navigated from.
    const shell = (table && table.shellMeta) || { title: null, description: null }
    const title = typeof meta.title === 'string' ? meta.title : shell.title
    if (title !== null) document.title = title
    if (typeof meta.description === 'string') {
      set_description(meta.description)
    } else if (shell.description !== null) {
      set_description(shell.description)
    }
  }, [meta, table])
}

/** Replace the description tag, or add one next to `<title>` when there is none. */
function set_description(value: string): void {
  let tag = document.querySelector('meta[name="description"]')
  if (!tag) {
    const head = document.head || document.querySelector('head')
    if (!head) return
    tag = document.createElement('meta')
    tag.setAttribute('name', 'description')
    head.appendChild(tag)
  }
  tag.setAttribute('content', value)
}

/**
 * `navigate_to("/blog/12", replace=True)`
 *
 * `navigate` is the primitive; this is the same thing with the parts that are
 * easy to get wrong handled: the deployment base prefix, and a query string
 * built from a dict rather than concatenated by hand.
 */
export function navigate_to(
  to: string,
  opts: { replace?: boolean; query?: Record<string, string | number | boolean | null | undefined> } = {},
): void {
  if (typeof window === 'undefined') return
  const base = get_route_table_sync().base || '/'
  let url = to
  if (base !== '/' && url.startsWith('/') && !url.startsWith(base)) {
    url = base.replace(/\/$/, '') + url
  }
  if (opts.query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== null && v !== undefined && v !== false) qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }
  if (opts.replace) {
    window.history.replaceState({}, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  } else {
    navigate(url)
  }
}

/**
 * `use_loader_data(pattern)` — what the route's `loader` returned at build time.
 *
 * Read from the JSON the pre-render pass inlined. Returns `null` in a browser
 * that navigated client-side to a route whose HTML was never pre-rendered, which
 * is the honest answer: there is no data because no loader ran, and a page that
 * needs it should say so rather than render with empty props.
 */
/**
 * Do two URLs name the same page?
 *
 * A trailing slash is the same route (`/about` and `/about/`), and a
 * pre-render writes the PATTERN as its url while the browser reports whatever
 * the address bar says. Comparing them raw made the client conclude the
 * inlined data was for another URL, so it rendered without the loader's props
 * while the server had rendered with them: React #425/#418 on every
 * pre-rendered route that had a loader.
 *
 * Only the trailing slash, and only the path: two URLs that differ otherwise
 * are different pages, which is what stops `/blog/a`'s data appearing on
 * `/blog/b`.
 */
function same_path(a: string, b: string): boolean {
  const norm = (s: string) => {
    let v = String(s ?? '/').split('#')[0].split('?')[0]
    if (v.length > 1 && v.endsWith('/')) v = v.replace(/\/+$/, '')
    return v || '/'
  }
  return norm(a) === norm(b)
}

/** Read the inlined payload, if there is one. */
function read_inlined_data(): { pattern: string; url?: string; data: any } | null {
  if (typeof document === 'undefined') return null
  const el = document.getElementById('__hydra_data__')
  if (!el || !el.textContent) return null
  try {
    const parsed = JSON.parse(el.textContent)
    return parsed && typeof parsed.pattern === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Where a loader's data comes from when the page was NOT pre-rendered for this
 * URL: a server that runs the loader on demand.
 *
 * The endpoint exists in `hydra dev`, `hydra preview` and `hydra serve`. On a
 * purely static deploy it does not, the fetch fails, and the hook reports that
 * honestly rather than pretending the data is empty — an empty list and a
 * failed request look identical in the UI and mean different things.
 */
export const DATA_ENDPOINT = '/__hydra/data'

export interface LoaderState {
  data: Record<string, any> | null
  status: 'ready' | 'loading' | 'error' | 'absent'
  error: string | null
}

/**
 * `state = use_loader(pattern)` — the route's loaders, live.
 *
 * Three sources, in order:
 *
 *   1. The payload the server inlined, when its URL is the URL being rendered.
 *      That is what makes the first paint match the HTML, and it is why the
 *      payload carries `url` and not only `pattern`.
 *   2. Otherwise a `fetch` to the data endpoint, so a client-side navigation to
 *      a route that was never pre-rendered still gets its data.
 *   3. A route with no loader at all is `absent`, not `loading`: nothing will
 *      ever arrive, and a spinner for it would spin forever.
 */
export function use_loader(pattern: string | null, url: string): LoaderState {
  const table = use_route_table()
  const has_loader = useMemo(() => {
    if (!pattern || !table) return false
    const entry = (table.routes || []).find((r: any) => r.pattern === pattern) as any
    return Boolean(entry && entry.serverFile)
  }, [pattern, table])

  const inlined = useMemo(() => read_inlined_data(), [])

  // `url` is a dependency, so navigating between two URLs of the SAME pattern
  // re-fetches. Keying on `pattern` alone would show /blog/a's data on /blog/b.
  const [fetched, set_fetched] = useState<{ url: string; data: any } | null>(null)
  const [failed, set_failed] = useState<string | null>(null)

  const inlined_matches =
    !!inlined &&
    !!pattern &&
    inlined.pattern === pattern &&
    same_path(inlined.url ?? pattern, url)

  useEffect(() => {
    if (!has_loader || inlined_matches) return
    if (typeof window === 'undefined') return
    let cancelled = false
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const qs = new URLSearchParams({ url })
    fetch(`${DATA_ENDPOINT}?${qs.toString()}`, {
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((payload) => {
        if (cancelled) return
        if (payload && payload.pattern === pattern && same_path(payload.url ?? pattern, url)) {
          set_failed(null)
          set_fetched({ url, data: payload.data ?? null })
        } else {
          // A payload for a different URL is a stale response, not this route's
          // data. Racing navigations make this reachable.
          set_fetched({ url, data: null })
        }
      })
      .catch((err) => {
        if (cancelled || (err && err.name === 'AbortError')) return
        set_failed(err && err.message ? err.message : String(err))
      })
    return () => {
      cancelled = true
      if (controller) controller.abort()
    }
  }, [has_loader, inlined_matches, pattern, url])

  if (!has_loader) return { data: null, status: 'absent', error: null }
  if (inlined_matches) return { data: inlined!.data || null, status: 'ready', error: null }
  if (failed) return { data: null, status: 'error', error: failed }
  if (fetched && same_path(fetched.url, url)) return { data: fetched.data, status: 'ready', error: null }
  return { data: null, status: 'loading', error: null }
}

export function use_loader_data(pattern: string | null): Record<string, any> | null {
  return useMemo(() => {
    if (!pattern) return null
    const parsed = read_inlined_data()
    if (!parsed || parsed.pattern !== pattern) return null
    return parsed.data || null
  }, [pattern])
}

/** Wrap `inner` in a layout chain, outermost first. */

/**
 * Error boundary for one route's subtree.
 *
 * React only supports error boundaries as class components, so this is one. It
 * exists in the runtime rather than in generated code so that every project
 * gets the same behaviour, and so the fallback contract (`error`, `path` props)
 * is documented in one place.
 */
/**
 * Wrap `page` in its layout chain.
 *
 * `chain` is nearest-first and layouts nest outermost-first, so it is walked
 * backwards: for `[dashboard, root]`, root wraps dashboard wraps the page. One
 * function, used by the browser and by the pre-render pass, so a page cannot
 * render inside its layout in the HTML and outside it after hydration.
 */
export function wrapInLayouts(page: React.ReactNode, chain: any[]): React.ReactNode {
  let el = page
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i]) el = React.createElement(chain[i], null, el)
  }
  return el
}

export class RouteErrorBoundary extends React.Component<
  { fallback?: any; path?: string; children?: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: any) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    // Swallowing this would make a broken page look like a styling problem.
    if (typeof console !== 'undefined') console.error('[hydra] route error:', error)
  }

  render() {
    if (this.state.error) {
      const Fallback = this.props.fallback
      if (Fallback) {
        return React.createElement(Fallback, { error: this.state.error, path: this.props.path })
      }
      return React.createElement(
        'div',
        { style: { padding: '2rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap' } },
        `This route threw.\n\n${this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)}`,
      )
    }
    return this.props.children
  }
}

export interface RouterProps {
  /** Route table. Defaults to the generated one. */
  routes?: RouteEntry[]
  /** Already-loaded components, keyed by pattern, layout file or `_404`. */
  components?: Record<string, any>
  /** Rendered while a page is loading. The generated table is synchronous, so
   *  this only matters for a project that supplies its own async source. */
  loading?: React.ReactNode
  children?: React.ReactNode
}

/**
 * `Router`: render the page for the current URL.
 *
 * With no props it uses the generated table, which is the point: an app writes
 * `Router()` and the folder layout decides what that means.
 *
 * Resolution is SYNCHRONOUS on purpose. An earlier version loaded pages through
 * `() => import('./pages/x.hyx')`, which reads better and does not work: esbuild
 * treats a dynamic import of a statically-resolvable path as its own entry
 * point, so the route table landed in a chunk the entry never referenced — the
 * client bundle contained no `Router`, the page rendered nothing, and the build
 * reported success. The runtime gate caught it. Static imports are compiled in,
 * so the first render has everything it needs and there is no loading state to
 * get wrong.
 */
export function Router(props: RouterProps) {
  const { components, loading, children } = props
  const path = use_path()
  const table = use_route_table()

  const routes: RouteEntry[] = useMemo(() => {
    if (props.routes) return props.routes
    return table ? table.routes : []
  }, [props.routes, table])

  const match = useMemo(
    () => (routes.length > 0 ? (core_match_route(path, routes as any) as any) : null),
    [path, routes],
  )
  const pattern = match ? match.route.pattern : null

  // A supplied `components` entry wins for the pattern; otherwise the generated
  // table's own maps are consulted. One code path, so a project that passes its
  // own components cannot end up with a different nesting rule.
  const page = useMemo(() => {
    if (!pattern) return null
    if (components && components[pattern]) return components[pattern]
    // Already the component: the generated table resolves `default` / named
    // exports when it builds the map. Calling `pick` again here asked a
    // COMPONENT for a default export and got null, so every pre-rendered page
    // rendered an empty `<main>` while its data sat correctly beside it.
    return (table && table.pages[pattern]) || null
  }, [pattern, components, table])

  // Where the page's props come from. Three cases, and the order matters:
  //
  //   1. A pre-render (SSG) or a server render (SSR): the loader already ran and
  //      its result is in the seed. There is no document to read and no second
  //      render to wait for, so the seed is the answer.
  //   2. The browser, on the URL the server rendered: `use_loader` returns the
  //      payload the server inlined, so the first paint uses the SAME data and
  //      hydrates clean. Re-fetching here would be a second source of truth and
  //      a mismatch the moment the two differ.
  //   3. The browser, after a client-side navigation to a URL that was never
  //      rendered: the inline payload is for a different URL, `use_loader`
  //      fetches, and the page re-renders with real data when it arrives.
  //
  // The hook is called unconditionally: a conditional hook changes the hook
  // order between renders the first time a navigation happens.
  const live = use_loader(pattern, path)
  const loaderData =
    ssr_seed && ssr_seed.path === pattern ? ssr_seed.data : live.data


  const layoutChain = useMemo(() => {
    if (!pattern || !table) return []
    const files = table.pageLayouts[pattern] || []
    return files.filter(Boolean)
  }, [pattern, table])

  const errorComponent = useMemo(() => {
    if (!pattern || !table) return null
    return table.pageErrors[pattern] || null
  }, [pattern, table])

  const notFoundComponent = useMemo(() => (table ? table.notFound || null : null), [table])

  // The page's metadata, applied to the document on every navigation. Hooks are
  // called before the early `!match` return below, because a conditional hook
  // changes the hook order the first time a URL matches nothing.
  const meta = useMemo<PageMeta>(() => {
    if (!pattern || !table || !table.pageMeta) return {}
    return table.pageMeta[pattern] || {}
  }, [pattern, table])
  use_page_meta(meta, table)

  if (!match) {
    if (notFoundComponent) {
      return React.createElement(
        Fragment,
        null,
        React.createElement(notFoundComponent, { path }),
        children,
      )
    }
    return null
  }

  const pageProps: any = {
    ...(loaderData || {}),
    params: match.params,
    path,
    route: match.route,
  }
  // The data state travels to the page, so a page can tell "still loading" from
  // "loaded and empty" without re-deriving it from the props. A page that does
  // not look at it is unaffected.
  if (live.status !== 'absent') {
    pageProps.loading = live.status === 'loading'
    pageProps.error = live.error
  }

  const body = page
    ? wrapInLayouts(React.createElement(page, pageProps), layoutChain)
    : ((loading as any) ?? null)

  return React.createElement(
    RouteErrorBoundary,
    { fallback: errorComponent, path },
    React.createElement(Fragment, null, body, children),
  )
}

// [xihanzu-NR]
/* ------------------------------------------------------------- data fetching
 *
 * A query cache small enough to read in one sitting. It covers the everyday
 * case — loading / error / data / refetch / mutate / invalidate — and stops
 * there: no background revalidation, no windowing, no retry backoff. If you
 * need those, install the real thing.
 */

type Listener = () => void

interface QueryEntry {
  value: any
  error: Error | null
  loading: boolean
  has_data: boolean
  promise: Promise<any> | null
  listeners: Set<Listener>
  /** Set by `use_query` so `invalidate` can refresh a mounted query. */
  rerun: (() => void) | null
}

const query_cache = new Map<string, QueryEntry>()

/** The cache slot for `key`, created on first use. */
function busy_until(key: string): QueryEntry {
  let entry = query_cache.get(key)
  if (!entry) {
    entry = {
      value: null, error: null, loading: false, has_data: false,
      promise: null, listeners: new Set(), rerun: null,
    }
    query_cache.set(key, entry)
  }
  return entry
}

/** Notify every mounted `use_query` watching `key`. */
function query_notify(key: string): void {
  const entry = query_cache.get(key)
  if (entry) for (const l of Array.from(entry.listeners)) l()
}

/**
 * `await fetch_query(key, fn)` — the imperative twin of `use_query`.
 * Concurrent callers for the same key share one in-flight promise, so a list
 * of twenty rows rendering the same query issues one request, not twenty.
 */
export function fetch_query<T = any>(key: string, fn?: () => Promise<T> | T): Promise<T> {
  const entry = busy_until(key)
  if (entry.promise) return entry.promise
  if (!fn) return Promise.resolve(entry.value as T)
  const p = Promise.resolve()
    .then(fn)
    .then((value) => {
      entry.value = value
      entry.error = null
      entry.has_data = true
      entry.loading = false
      entry.promise = null
      query_notify(key)
      return value
    })
    .catch((e: any) => {
      const err = e instanceof Error ? e : new Error(String(e))
      entry.error = err
      entry.loading = false
      entry.promise = null
      query_notify(key)
      throw err
    })
  entry.loading = true
  entry.promise = p
  query_notify(key)
  return p
}

/**
 * `invalidate("todos")` — drop a cached query and refetch it if it is mounted,
 * so a mutation can refresh the list it just changed.
 * Pass a predicate to invalidate a family of keys at once.
 */
export function invalidate(key: string | ((k: string) => boolean) = () => true): void {
  const matches =
    typeof key === 'string'
      ? (k: string) => typeof k === 'string' && (k === key || k.startsWith(key + ':'))
      : key
  for (const [k, entry] of Array.from(query_cache.entries())) {
    if (!matches(k)) continue
    entry.has_data = false
    entry.promise = null
    if (entry.rerun) {
      // A mounted `use_query` owns the fetch function, so ask it to refetch
      // rather than guessing at one from here.
      entry.loading = true
      entry.rerun()
    } else if (entry.listeners.size === 0) {
      query_cache.delete(k)
    }
  }
}

/** Drop a single cached query without refetching it. */
export function clear_query(key: string): void {
  query_cache.delete(key)
}

/** Wipe the whole query cache. Mostly useful in tests. */
export function clear_query_cache(): void {
  query_cache.clear()
}

/** `seed_query("todos", [...])` — prime the cache so the first render has data. */
export function seed_query(key: string, value: any): void {
  const entry = busy_until(key)
  entry.value = value
  entry.has_data = true
  entry.loading = false
  entry.error = null
  query_notify(key)
}

export interface UseQuery<T> {
  data: T | null
  error: Error | null
  loading: boolean
  refetch: () => Promise<T | null>
}

/**
 * `{data, error, loading, refetch} = use_query("todos", lambda: fetch_json(...))`
 *
 * `fn` runs on mount and whenever `key` or `deps` change. Results are cached by
 * `key`, so two components asking for "todos" make one request.
 */
export function use_query<T = any>(
  key: string,
  fn: () => Promise<T> | T,
  deps: DependencyList = []
): UseQuery<T> {
  const fn_ref = useRef(fn)
  fn_ref.current = fn
  const mounted = useRef(true)
  const [, force] = useReducer((n: number) => n + 1, 0)
  const force_ref = useRef(force)
  force_ref.current = force

  useEffect(() => {
    const entry = busy_until(key)
    const notify = () => { if (mounted.current) force_ref.current() }
    entry.listeners.add(notify)
    // Let `invalidate` drive a refetch through this component, which is the
    // only place that knows `fn`.
    entry.rerun = () => { fetch_query(key, () => fn_ref.current()).catch(() => {}) }
    // Only fetch on first mount for this key; later subscribers reuse the cache.
    if (!entry.has_data && !entry.promise) {
      entry.rerun()
    }
    return () => {
      entry.listeners.delete(notify)
      // Only drop the refetch hook once no subscriber can service it.
      if (entry.listeners.size === 0) entry.rerun = null
    }
    // fn_ref is deliberately not a dependency: a fresh `fn` identity on every
    // render must not refetch. `deps` is the caller's contract for that.
  }, [key, ...deps])

  useEffect(() => () => {
    // Mark dead so an in-flight response for this component is ignored.
    mounted.current = false
  }, [])

  const entry = query_cache.get(key)
  return {
    data: (entry?.has_data ? entry.value : null) as T | null,
    error: entry?.error ?? null,
    loading: entry ? entry.loading || (!entry.has_data && !entry.error) : true,
    refetch: useCallback(() => {
      invalidate(key)
      return fetch_query(key, () => fn_ref.current()).then(
        (v) => v as T | null,
        () => null as T | null
      )
    }, [key]),
  }
}

export interface UseMutation<T, A extends any[]> {
  mutate: (...args: A) => Promise<T | null>
  data: T | null
  error: Error | null
  loading: boolean
  reset: () => void
}

/**
 * `{mutate, loading, error, data} = use_mutation(lambda body: post_json(url, body))`
 *
 * `mutate(...)` runs `fn`, remembers the result, and resolves to it — so a
 * caller can chain `invalidate(key)` on success:
 *     save.handle_submit(lambda v: save.mutate(v).then(lambda _: invalidate("todos")))
 */
export function use_mutation<T = any, A extends any[] = any[]>(
  fn: (...args: A) => Promise<T> | T,
  options: { on_success?: (data: T) => void; on_error?: (e: Error) => void } = {}
): UseMutation<T, A> {
  const fn_ref = useRef(fn)
  fn_ref.current = fn
  const opts_ref = useRef(options)
  opts_ref.current = options

  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null,
    error: null,
    loading: false,
  })

  // Tracks the component's liveness so a late response after unmount does not
  // call setState — the classic mutation memory-leak warning.
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const mutate = useCallback(async (...args: A): Promise<T | null> => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const data = (await fn_ref.current(...args)) as T
      if (alive.current) setState({ data, error: null, loading: false })
      opts_ref.current.on_success?.(data)
      return data
    } catch (e: any) {
      const err = e instanceof Error ? e : new Error(String(e))
      if (alive.current) setState({ data: null, error: err, loading: false })
      opts_ref.current.on_error?.(err)
      return null
    }
  }, [])

  const reset = useCallback(() => setState({ data: null, error: null, loading: false }), [])

  return { ...state, mutate, reset }
}

// [xihanzu-NR]
/* ------------------------------------------------------------------- forms
 *
 * Form state is the single most-written React pattern and the one the raw
 * hooks model fits worst: five pieces of state, three handlers, and a
 * validation pass that must not re-render the world. `form_state` is that
 * whole object in one call.
 */

/** A validator returns an error message, or null when the value is acceptable. */
export type Validator = (value: any) => string | null

/** The props `form.field(name)` spreads onto an `<input>`. */
export interface Field {
  name: string
  value: any
  onChange: (e: any) => void
  onBlur: () => void
  error: string | null
}

/** The object returned by `form_state`. */
export interface FormState {
  values: Record<string, any>
  errors: Record<string, string>
  touched: Record<string, boolean>
  dirty: boolean
  submitting: boolean
  set_field: (name: string, value: any) => void
  set_values: (next: Record<string, any>) => void
  set_errors: (next: Record<string, string>) => void
  validate: (fn: (values: Record<string, any>) => Record<string, string>) => Record<string, string>
  reset: () => void
  handle_submit: (fn: (values: Record<string, any>) => any) => (e?: any) => any
  field: (name: string) => Field
}

/**
 * `form = form_state({"email": "", "age": 0})`
 *
 * Returns values/errors/touched/dirty/submitting plus the verbs to change them.
 * `form.field("email")` spreads directly onto an input:
 *     <input {...form.field("email")} />
 * `form.handle_submit(fn)` runs the last schema passed to `form.validate`, then
 * calls `fn(values)` only if it produced no errors, toggling `submitting` for
 * the duration of an async submit.
 */
export function form_state(initial: Record<string, any>): FormState {
  const initial_ref = useRef(initial)
  const schema = useRef<((v: Record<string, any>) => Record<string, string>) | null>(null)
  const [values, setValues] = useState<Record<string, any>>(() => ({ ...initial }))
  const [errors, setErrorsState] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)
  const [dirty, setDirty] = useState(false)

  const set_field = useCallback((name: string, value: any) => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setDirty(true)
  }, [])

  const set_values = useCallback((next: Record<string, any>) => {
    setValues(next)
    setDirty(true)
  }, [])

  const set_errors = useCallback((next: Record<string, string>) => {
    setErrorsState(next)
  }, [])

  // Depends on `values` rather than reading a mirror ref: reading a ref here
  // would race the render that just changed a field.
  const validate = useCallback(
    (fn: (v: Record<string, any>) => Record<string, string>) => {
      schema.current = fn
      const found = fn(values)
      setErrorsState(found)
      return found
    },
    [values]
  )

  const handle_submit = useCallback(
    (fn: (v: Record<string, any>) => any) => (e?: any) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault()
      const check = schema.current
      const found = check ? check(values) : {}
      setErrorsState(found)
      if (Object.keys(found).length > 0) return undefined
      setSubmitting(true)
      return Promise.resolve(fn(values)).finally(() => setSubmitting(false))
    },
    [values]
  )

  const reset = useCallback(() => {
    setValues({ ...initial_ref.current })
    setErrorsState({})
    setTouched({})
    setDirty(false)
    setSubmitting(false)
  }, [])

  const field = useCallback(
    (name: string): Field => ({
      name,
      value: values[name] ?? '',
      error: touched[name] ? errors[name] ?? null : null,
      onChange: (e: any) => set_field(name, e && e.target ? e.target.value : e),
      onBlur: () => setTouched((t) => ({ ...t, [name]: true })),
    }),
    [values, errors, touched, set_field]
  )

  return {
    values, errors, touched, dirty, submitting,
    set_field, set_values, set_errors, validate, reset, handle_submit, field,
  }
}

/**
 * `validators` — the five checks that cover most forms.
 * `required` and `email` are validators themselves; the rest are factories
 * because they need a parameter. Each returns `(value) => error | null`.
 */
export const validators = {
  /** Fails on null, undefined, empty string, and empty array. */
  required: ((v: any): string | null =>
    v == null || v === '' || (Array.isArray(v) && v.length === 0)
      ? 'This field is required'
      : null) as Validator,

  /** Deliberately permissive: shape only, no RFC 5322 theatre. */
  email: ((v: any): string | null => {
    if (v == null || v === '') return null
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v)) ? null : 'Enter a valid email address'
  }) as Validator,

  /** `validators.min_len(8)` — minimum character count. */
  min_len: (n: number, msg?: string): Validator => (v: any) =>
    v == null || String(v).length >= n ? null : msg ?? `Must be at least ${n} characters`,

  /** `validators.max_len(120)` — maximum character count. */
  max_len: (n: number, msg?: string): Validator => (v: any) =>
    v == null || String(v).length <= n ? null : msg ?? `Must be at most ${n} characters`,

  /** `validators.pattern(/^\d{5}$/, "Five digits")` — empty values pass. */
  pattern: (re: RegExp, msg?: string): Validator => (v: any) =>
    v == null || v === '' || re.test(String(v)) ? null : msg ?? 'Invalid format',

  /** `validators.all(validators.required, validators.email)` — first failure wins. */
  all: (...vs: Validator[]): Validator => (v: any) => {
    for (const check of vs) {
      const err = check(v)
      if (err) return err
    }
    return null
  },
}

// [xihanzu-NR]
/* ----------------------------------------------------------- async & timing */

/** `await sleep(300)` — pause, without setTimeout's callback shape. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `use_interval(lambda: tick(), 1000)`
 * Runs `fn` every `ms`. The latest `fn` is used without resetting the timer,
 * and the interval is cleared on unmount. Pass `ms = null` to pause.
 */
export function use_interval(fn: () => void, ms: number | null = 1000): void {
  const fn_ref = useRef(fn)
  fn_ref.current = fn
  useEffect(() => {
    if (ms == null) return
    const id = setInterval(() => fn_ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

/**
 * `use_timeout(lambda: hide_toast(), 3000)`
 * Runs `fn` once after `ms`, cancelling on unmount or when `ms` changes.
 */
export function use_timeout(fn: () => void, ms: number | null = 300): void {
  const fn_ref = useRef(fn)
  fn_ref.current = fn
  useEffect(() => {
    if (ms == null) return
    const id = setTimeout(() => fn_ref.current(), ms)
    return () => clearTimeout(id)
  }, [ms])
}

/**
 * `query = use_debounced(input, 300)` — the debounced VALUE.
 *
 * Returns the last value that stopped changing for `ms`, so it drops straight
 * into a dependency list or a render. Note this is the value, not a callback:
 * `debounce` above already covers the callback case.
 */
export function use_debounced<T>(value: T, ms: number = 300): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

/**
 * `on_scroll = use_throttled(lambda e: ..., 100)`
 * Wraps a function so it runs at most once per `ms`, with a trailing call for
 * the final invocation. Identity is stable across renders.
 */
export function use_throttled<A extends any[]>(fn: (...a: A) => void, ms: number = 100): (...a: A) => void {
  const fn_ref = useRef(fn)
  fn_ref.current = fn
  const last_run = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<A | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return useCallback((...args: A) => {
    const now = Date.now()
    const elapsed = now - last_run.current
    if (elapsed >= ms) {
      last_run.current = now
      fn_ref.current(...args)
    } else {
      // Remember only the newest call — intermediate ones are dropped.
      pending.current = args
      if (timer.current) return
      timer.current = setTimeout(() => {
        timer.current = null
        last_run.current = Date.now()
        const a = pending.current
        pending.current = null
        if (a) fn_ref.current(...a)
      }, ms - elapsed)
    }
  }, [ms])
}

/**
 * `previous = use_previous(value)` — the value from the render before this one.
 * Starts as `null`, because on the first render there is no previous.
 */
export function use_previous<T>(value: T, initial: T | null = null): T | null {
  const ref = useRef<T | null>(initial)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref.current
}

export interface UseAsync<T> {
  data: T | null
  error: Error | null
  loading: boolean
  reload: () => Promise<T | null>
}

/**
 * `{data, error, loading, reload} = use_async(lambda: api.load(id), [id])`
 *
 * Like `fetch_json`, but for any async function rather than a URL — no cache,
 * no key. Use `use_query` when several components want the same data.
 */
export function use_async<T = any>(fn: () => Promise<T> | T, deps: DependencyList = []): UseAsync<T> {
  const fn_ref = useRef(fn)
  fn_ref.current = fn
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  })
  const [nonce, setNonce] = useState(0)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    let live = true
    setState({ data: null, error: null, loading: true })
    Promise.resolve()
      .then(() => fn_ref.current())
      .then(
        (data) => { if (live) setState({ data, error: null, loading: false }) },
        (e: any) => {
          if (live) setState({ data: null, error: e instanceof Error ? e : new Error(String(e)), loading: false })
        }
      )
    return () => { live = false }
  }, [nonce, ...deps])

  const reload = useCallback(async (): Promise<T | null> => {
    setState({ data: null, error: null, loading: true })
    try {
      const data = (await fn_ref.current()) as T
      if (alive.current) setState({ data, error: null, loading: false })
      return data
    } catch (e: any) {
      if (alive.current) {
        setState({ data: null, error: e instanceof Error ? e : new Error(String(e)), loading: false })
      }
      return null
    }
  }, [])

  return { ...state, reload }
}

// [xihanzu-NR]
/* --------------------------------------------------------------- dom & ui */

/**
 * `use_local_storage("token", "")` — the SSR-safe `local_storage`.
 *
 * Unlike `local_storage`, the first render always yields `initial` and the
 * stored value is read in an effect. That costs one extra render but makes it
 * safe under server rendering: the server and the client's first pass produce
 * identical markup, so hydration cannot mismatch.
 */
export function use_local_storage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(initial)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(key)
      if (raw != null) setValue(JSON.parse(raw) as T)
    } catch {
      // A corrupt or blocked entry leaves the initial value in place.
    }
    setReady(true)
  }, [key])

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(key, JSON.stringify(resolved))
          } catch (e) {
            console.error(`[hydra] localStorage error for key "${key}":`, e)
          }
        }
        return resolved
      })
    },
    [key]
  )

  return [value, set, ready]
}

/** `dark = use_media_query("(prefers-color-scheme: dark)")` — false while server-rendered. */
export function use_media_query(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    // addEventListener is the modern API; older Safari only has addListener.
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [query])

  return matches
}

/** `{x, y} = use_scroll_position()` — page scroll offset, updated on scroll. */
export function use_scroll_position(): { x: number; y: number } {
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onScroll = () =>
      setPos({ x: window.scrollX || window.pageXOffset || 0, y: window.scrollY || window.pageYOffset || 0 })
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return pos
}

/** `{width, height} = use_window_size()` — viewport size, updated on resize. */
export function use_window_size(): { width: number; height: number } {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight })
  const [size, setSize] = useState(() =>
    typeof window === 'undefined' ? { width: 0, height: 0 } : read()
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    setSize(read())
    const onResize = () => setSize(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return size
}

/**
 * `use_click_outside(menu_ref, lambda: set_open(False))`
 * Calls `handler` when a pointer goes down outside the referenced element —
 * the standard "close the dropdown" behaviour.
 */
export function use_click_outside(
  ref: { current: any },
  handler: (e: Event) => void,
  active: boolean = true
): void {
  const handler_ref = useRef(handler)
  handler_ref.current = handler
  useEffect(() => {
    if (!active || typeof document === 'undefined') return
    const onDown = (e: Event) => {
      const el = ref.current
      if (el && !el.contains(e.target as Node)) handler_ref.current(e)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [ref, active])
}

/**
 * `use_key_press("Escape", lambda: set_open(False))`
 * Fires while the key is held, ignoring keystrokes aimed at inputs unless
 * `allow_in_inputs` is set — otherwise typing "n" in a field opens your modal.
 */
export function use_key_press(
  key: string,
  handler: (e: KeyboardEvent) => void,
  options: { allow_in_inputs?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}
): void {
  const handler_ref = useRef(handler)
  handler_ref.current = handler
  const { allow_in_inputs = false, shift } = options
  const ctrl = options.ctrl ?? options.meta

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      if (ctrl != null && !!e.ctrlKey !== ctrl) return
      if (shift != null && !!e.shiftKey !== shift) return
      if (e.key.toLowerCase() !== key.toLowerCase()) return
      if (!allow_in_inputs) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if ((e.target as HTMLElement | null)?.isContentEditable) return
      }
      handler_ref.current(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key, allow_in_inputs, ctrl, shift])
}

export interface HoverState {
  hovered: boolean
  props: {
    onMouseEnter: (e: any) => void
    onMouseLeave: (e: any) => void
  }
}

/**
 * `{hovered, props} = use_hover()` then `<div {...props} />`.
 * Pointer-only, deliberately: combining hover and focus in one flag produces
 * UI that sticks "hovered" after a keyboard tab.
 */
export function use_hover(): HoverState {
  const [hovered, setHovered] = useState(false)
  return {
    hovered,
    props: useMemo(
      () => ({
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
      }),
      []
    ),
  }
}

export interface FocusState {
  focused: boolean
  props: {
    onFocus: (e: any) => void
    onBlur: (e: any) => void
  }
}

/** `{focused, props} = use_focus()` then `<input {...props} />`. */
export function use_focus(): FocusState {
  const [focused, setFocused] = useState(false)
  return {
    focused,
    props: useMemo(
      () => ({
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
      }),
      []
    ),
  }
}

export interface CopyState {
  copied: boolean
  copy: (text?: string) => Promise<boolean>
}

/**
 * `{copied, copy} = use_copy(code)` — click-to-copy with a `copied` flag that
 * resets itself after `reset_ms`. Falls back to a hidden textarea when the
 * Clipboard API is unavailable (http:// and older browsers).
 */
export function use_copy(text: string = '', reset_ms: number = 1500): CopyState {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const text_ref = useRef(text)
  text_ref.current = text

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = useCallback(
    async (override?: string): Promise<boolean> => {
      const value = override ?? text_ref.current
      const done = copy_text(String(value))
      setCopied(done)
      if (timer.current) clearTimeout(timer.current)
      if (done) timer.current = setTimeout(() => setCopied(false), reset_ms)
      return done
    },
    [reset_ms]
  )

  return { copied, copy }
}

/** `focus_element(ref)` — move keyboard focus to a referenced element. */
export function focus_element(ref: { current: any }): void {
  const el = ref?.current
  if (el && typeof el.focus === 'function') el.focus()
}

/**
 * `scroll_to("section-2")` — smooth-scroll to an element id, or
 * `scroll_to(0)` to scroll the window to an absolute offset.
 */
export function scroll_to(
  target: string | number,
  options: { behavior?: ScrollBehavior; block?: ScrollLogicalPosition; offset?: number } = {}
): void {
  if (typeof document === 'undefined') return
  const { offset = 0, behavior = 'smooth', block = 'start' } = options
  if (typeof target === 'number') {
    if (typeof window === 'undefined') return
    window.scrollTo({ top: target + offset, behavior })
    return
  }
  const el = document.getElementById(target)
  if (!el) return
  if (offset && typeof window !== 'undefined') {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + offset, behavior })
    return
  }
  el.scrollIntoView({ behavior, block })
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

/** `round_to(3.14159, 2)` -> 3.14 — `round(2.675, 2)` gives 2.67 in Python too. */
export const round_to = (x: number, digits: number = 0): number => {
  const f = Math.pow(10, digits)
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f
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
/* ----------------------------------------------------------------- objects
 *
 * Dict verbs Python has and JS expresses with twelve characters of spread
 * syntax. Everything here is non-mutating: `set_path` returns a NEW object,
 * because mutation is the thing React cannot see.
 */

/** `pick(user, ["id", "name"])` — a new object with only those keys. */
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  if (obj == null) return out
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

/** `omit(user, ["password"])` — a new object without those keys. */
export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const out = { ...(obj as any) }
  if (out == null) return out as Omit<T, K>
  for (const k of keys) delete out[k as any]
  return out as Omit<T, K>
}

/** `merge({a: 1}, {b: 2})` -> {a: 1, b: 2} — SHALLOW: `b` wins per top-level key. */
export function merge<A extends object, B extends object>(a: A, b: B): A & B {
  return { ...(a as any), ...(b as any) }
}

const is_plain_object = (x: unknown): x is Record<string, any> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) &&
  (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null)

/**
 * `deep_merge(defaults, overrides)` — recursive; nested objects merge rather
 * than replace, arrays and scalars replace. Returns a new object, cloning the
 * branches it descends into so neither input is mutated.
 */
export function deep_merge<A extends object, B extends object>(a: A, b: B): A & B {
  const out: Record<string, any> = { ...(a as any) }
  for (const [k, v] of Object.entries(b as any)) {
    const prev = out[k]
    out[k] = is_plain_object(prev) && is_plain_object(v) ? deep_merge(prev, v) : v
  }
  return out as A & B
}

/** `deep_clone(x)` — structuredClone when the platform has it (no function/Date loss). */
export function deep_clone<T>(x: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(x)
    } catch {
      // Functions, DOM nodes and class instances are not cloneable — fall through.
    }
  }
  if (x === null || typeof x !== 'object') return x
  if (Array.isArray(x)) return x.map((v) => deep_clone(v)) as unknown as T
  if (x instanceof Date) return new Date(x.getTime()) as unknown as T
  if (x instanceof Map) return new Map(Array.from(x, ([k, v]) => [k, deep_clone(v)])) as unknown as T
  if (x instanceof Set) return new Set(Array.from(x, (v) => deep_clone(v))) as unknown as T
  const out: Record<string, any> = {}
  for (const k of Object.keys(x as any)) out[k] = deep_clone((x as any)[k])
  return out as T
}

/**
 * `is_empty(x)` — true for None, "", [], {} and empty Map/Set; FALSE for 0 and
 * False. Numbers and booleans always have a value, so "empty" cannot apply.
 */
export function is_empty(x: unknown): boolean {
  if (x == null) return true
  if (typeof x === 'string' || Array.isArray(x)) return x.length === 0
  if (x instanceof Map || x instanceof Set) return x.size === 0
  if (typeof x === 'object') return Object.keys(x as object).length === 0
  return false
}

/** `get_path(data, "user.address.city", "unknown")` — no throw on a missing branch. */
export function get_path<T = any>(obj: any, path: string, fallback: T | null = null): T | null {
  if (obj == null || !path) return fallback
  const parts = Array.isArray(path) ? path : String(path).split('.')
  let cur: any = obj
  for (const p of parts) {
    if (cur == null) return fallback
    cur = cur[p]
  }
  return cur === undefined ? fallback : (cur as T)
}

/**
 * `next = set_path(form.values, "address.city", "Paris")`
 * Immutable deep set: every object along the path is copied, everything else is
 * shared. This is the update React's state model demands and JS does not give.
 */
export function set_path<T>(obj: T, path: string, value: any): T {
  const parts = String(path).split('.')
  const clone = (node: any): any => {
    if (Array.isArray(node)) return node.slice()
    if (node && typeof node === 'object') return { ...node }
    return {}
  }
  const root = clone(obj)
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    cur[key] = clone(cur[key])
    cur = cur[key]
  }
  cur[parts[parts.length - 1]] = value
  return root as T
}

/**
 * `equals(a, b)` — structural comparison, so `{a: 1}` equals `{a: 1}`.
 * Compares Dates by time and treats NaN as equal to NaN, both of which `===`
 * gets wrong and both of which show up the moment you compare fetched data.
 */
export function equals(a: any, b: any): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  if (a == null || b == null) return a === b
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => equals(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equals(a[k], b[k]))
  }
  return false
}

// [xihanzu-NR]
/* ------------------------------------------------------------- browser misc */

/**
 * `copy_text("hello")` -> true on success.
 * Uses the Clipboard API when present and falls back to a temporary textarea,
 * which is what still works on http:// and in older Safari.
 */
export function copy_text(s: string): boolean {
  if (typeof document === 'undefined') return false
  // The Clipboard API is async and only exists in a secure context, so it
  // cannot be awaited here; report success optimistically and let the
  // rejection be swallowed rather than failing the user's copy action.
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(s).catch(() => {})
    return true
  }
  if (typeof document.execCommand !== 'function') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = s
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (e) {
    console.error('[hydra] copy failed:', e)
    return false
  }
}

/** `download("todos.csv", csv, "text/csv")` — trigger a client-side file save. */
export function download(filename: string, content: string | Blob, mime: string = 'text/plain'): void {
  if (typeof document === 'undefined') return
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on the next tick: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** `text = await read_file(event.target.files[0])` — an <input type="file"> file. */
export function read_file(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.readAsText(file)
  })
}

/** `prefers_dark()` — a one-shot read of the OS setting; false while server-rendered. */
export function prefers_dark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * `dark, set_dark = use_dark_mode()`
 * Dark-mode state that follows the OS by default, persists the user's explicit
 * choice under localStorage, and puts the `dark` class on <html> so Tailwind's
 * `dark:` variants work without further wiring.
 */
export function use_dark_mode(
  initial?: boolean,
  storage_key: string = 'hydra:dark'
): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const [dark, setDark] = useState<boolean>(() => {
    if (initial != null) return initial
    if (typeof window === 'undefined') return false
    try {
      const saved = window.localStorage.getItem(storage_key)
      if (saved != null) return saved === 'true'
    } catch {
      // Ignore a blocked localStorage and fall through to the OS preference.
    }
    return prefers_dark()
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.classList.toggle('dark', dark)
    try {
      window.localStorage.setItem(storage_key, String(dark))
    } catch {
      // Persistence is best-effort; the class is already applied.
    }
  }, [dark, storage_key])

  return [dark, setDark]
}

/** `online = use_online()` — navigator.onLine, kept current across network changes. */
export function use_online(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    on()  // resync: the value may have changed between render and effect
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  return online
}

/** `visible = use_visibility()` — false when the tab is hidden (pause polling, video, etc.). */
export function use_visibility(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  )

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    onChange()
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}

/** `uuid()` — a v4 UUID via the platform RNG, with a fallback for old browsers. */
export function uuid(): string {
  const c = typeof crypto !== 'undefined' ? (crypto as Crypto) : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** `random_id("item")` -> "item-k3f9a2x1" — for DOM ids and list keys. */
export const random_id = (prefix: string = 'id'): string =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

type AnyFn = (...a: any[]) => any

/**
 * `save = debounced_fn(lambda v: api.save(v), 500)` — trailing-edge debounce for
 * event handlers (as opposed to `use_debounced`, which debounces a value).
 * `.cancel()` and `.flush()` are attached for the cases that need them.
 */
export function debounced_fn<F extends AnyFn>(
  fn: F,
  ms: number = 300
): F & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: any[] | null = null
  const wrapped = ((...args: any[]) => {
    pending = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const a = pending
      pending = null
      if (a) fn(...a)
    }, ms)
  }) as F & { cancel: () => void; flush: () => void }
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }
  wrapped.flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    const a = pending
    pending = null
    if (a) fn(...a)
  }
  return wrapped
}

/**
 * `on_scroll = throttled_fn(handler, 100)` — leading + trailing throttle.
 * The first call runs immediately; calls during the window collapse into one.
 */
export function throttled_fn<F extends AnyFn>(fn: F, ms: number = 100): F {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: any[] | null = null
  return ((...args: any[]) => {
    const now = Date.now()
    const elapsed = now - last
    if (elapsed >= ms) {
      last = now
      fn(...args)
      return
    }
    pending = args
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      last = Date.now()
      const a = pending
      pending = null
      if (a) fn(...a)
    }, ms - elapsed)
  }) as F
}

/** `init = once(lambda: do_setup())` — the body runs on the first call only. */
export function once<F extends AnyFn>(fn: F): F {
  let called = false
  let result: any
  return ((...args: any[]) => {
    if (!called) {
      called = true
      result = fn(...args)
    }
    return result
  }) as F
}

/**
 * `data = await retry(lambda: fetch(url).then(r => r.json()), 3, 300)`
 * Retries on rejection with exponential backoff (300ms, 600ms, 1200ms…) and
 * rethrows the FINAL error, so the caller still sees a real failure.
 */
export async function retry<T>(fn: () => Promise<T> | T, attempts: number = 3, delay: number = 300): Promise<T> {
  let last_err: unknown
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await fn()
    } catch (e) {
      last_err = e
      if (i < attempts - 1 && delay > 0) await sleep(delay * Math.pow(2, i))
    }
  }
  throw last_err
}

/**
 * `storage.set("token", value)` — JSON-aware localStorage that no-ops (rather
 * than throws) on the server and when storage is blocked by the browser.
 */
export const storage = {
  /** The stored value, or `fallback` when absent, corrupt, or unavailable. */
  get<T = any>(key: string, fallback: T | null = null): T | null {
    if (typeof window === 'undefined') return fallback
    try {
      const raw = window.localStorage.getItem(key)
      return raw == null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  },

  /** Write a value, JSON-encoded. Returns false when persistence was denied. */
  set(key: string, value: any): boolean {
    if (typeof window === 'undefined') return false
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch (e) {
      console.error(`[hydra] storage.set("${key}") failed:`, e)
      return false
    }
  },

  /** Remove one key. */
  remove(key: string): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(key)
    } catch {
      // Nothing to do: the entry was already unreachable.
    }
  },

  /** Remove every key in this origin's localStorage. */
  clear(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.clear()
    } catch {
      // Same as remove — a blocked store has nothing to clear.
    }
  },
}


