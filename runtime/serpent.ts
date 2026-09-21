// [xihanzu-NR]
/**
 * Serpent runtime — the batteries.
 *
 * Design rule: every export here must be explicable in one sentence, and must
 * not surprise a Python developer. Where React's model differs from Python's
 * (immutability), we surface the difference in the NAME rather than hiding it.
 */
import {
  useState, useEffect, useMemo, useRef, useCallback, useContext,
  createContext, useReducer, Fragment, useId, useTransition,
  useDeferredValue, useLayoutEffect, Suspense, forwardRef,
  type DependencyList,
} from 'react'

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
      console.error('[serpent] handler threw:', e)
      throw e  // rethrow: an error boundary should still see it
    }
  }
}

/* ---------------------------------------------------------------- re-exports */

export {
  useState, useEffect, useMemo, useRef, useCallback, useContext, createContext,
  Fragment, useId, useTransition, useDeferredValue, useLayoutEffect, Suspense, forwardRef,
}

/* ------------------------------------------------------------- string helpers
 *
 * Python string methods with no exact JS equivalent. The compiler rewrites
 * `s.capitalize()` to `capitalize(s)`, so these are free functions rather than
 * prototype patches — never mutate a built-in.
 */

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

