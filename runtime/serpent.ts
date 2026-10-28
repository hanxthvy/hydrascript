// [xihanzu-NR]
/**
 * Serpent runtime — the batteries.
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
            console.error(`[serpent] localStorage error for key "${key}":`, e)
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
    console.error('[serpent] copy failed:', e)
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
      console.error(`[serpent] storage.set("${key}") failed:`, e)
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


