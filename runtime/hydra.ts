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

// Share React internals across dev rebuilds so re-imported module graphs
// share the active hook dispatcher rather than throwing "Invalid hook call".
if (typeof window !== 'undefined' && (React as any)?.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED) {
  const g = globalThis as any
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  if (!g.__hydra_react_internals__) {
    g.__hydra_react_internals__ = internals
  } else {
    internals.ReactCurrentDispatcher = g.__hydra_react_internals__.ReactCurrentDispatcher
    if (internals.ReactCurrentBatchConfig && g.__hydra_react_internals__.ReactCurrentBatchConfig) {
      internals.ReactCurrentBatchConfig = g.__hydra_react_internals__.ReactCurrentBatchConfig
    }
    if (internals.ReactCurrentOwner && g.__hydra_react_internals__.ReactCurrentOwner) {
      internals.ReactCurrentOwner = g.__hydra_react_internals__.ReactCurrentOwner
    }
  }
}

// The React-free half. Re-exported below so `from "hydra" import len` is
// unchanged, and importable on its own as `hydra/core` from a server file that
// must not pull React into its bundle.
export * from './core'

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

/**
 * Route chunks that have ALREADY been fetched, by pattern.
 *
 * Split routes resolve asynchronously, and hydration cannot wait inside a
 * render — the HTML on disk has the page's markup and the client's first paint
 * must produce the same tree or React throws #418/#423 and re-renders the whole
 * document. `mount()` fills this BEFORE `hydrateRoot`, so the first render sees
 * a component rather than a promise.
 */
const primed_pages: Record<string, any> =
  (globalThis as any).__hydra_primed || ((globalThis as any).__hydra_primed = {})


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

/** Python-style truthiness: empty list/dict/string and 0 are falsy. */
/* ------------------------------------------------------------ fast refresh
 *
 * A dev-time boundary that keeps a mounted component's STATE across a rebuild.
 *
 * Why a registry and not a babel plugin: the compiler already knows where every
 * component begins and ends, so it can emit the boundary itself. What React needs
 * in order to keep hooks alive is that the ELEMENT TYPE stay identical — same
 * object identity — while its implementation changes. So the exported binding is
 * a stable function that reads a slot, and a rebuild writes a new function into
 * that slot.
 *
 * What it does NOT claim, because the difference matters:
 *
 *   - It does not patch the running module. A rebuild still replaces the module;
 *     the boundary is what carries state across that replacement, through a
 *     registry that lives on `globalThis` and therefore outlives the module.
 *   - A component that reads a module-level value sees the OLD value until the
 *     module is re-evaluated. Module state is not hot-swapped, only hooks are.
 *   - A production build compiles the boundary AWAY (`refresh_boundary = false`),
 *     so the shipped component is a plain function with no indirection.
 */

interface RefreshSlot {
  impl: (props: any) => any
  /** The stable component React sees. Identity never changes for a given key. */
  component: (props: any) => any
  listeners: Set<() => void>
}

/**
 * The registry lives on `globalThis` so it outlives the module instance — a
 * rebuild replaces the module, and the components already mounted must find their
 * slot again.
 *
 * The KEY is a literal inside the function, not a module constant, because a
 * component can be registered while this module is still being evaluated: the
 * generated route table imports pages, a page imports `hydra`, and the component
 * boundary runs at import time. A module-level `const` read from that first call
 * is in the temporal dead zone, and the assignment became
 * `globalThis[undefined] = ...` — "Cannot assign to read only property
 * 'undefined'". A literal has no such ordering.
 */
function refreshRegistry(): Map<string, RefreshSlot> {
  const g = globalThis as any
  const key = '__hydra_refresh_registry__'
  if (!g[key]) g[key] = new Map<string, RefreshSlot>()
  return g[key] as Map<string, RefreshSlot>
}

/**
 * `__refresh("Card", impl)` — a component whose identity survives a rebuild.
 *
 * The key is `file:name` at build time (the compiler passes the bare name and the
 * registry is per module instance), which is enough for the one thing it must do:
 * when the same component is registered again, the EXISTING component function
 * gets the new implementation and every mounted instance keeps its hooks.
 */
export function __refresh(name: string, impl: (props: any) => any): (props: any) => any {
  const reg = refreshRegistry()
  const existing = reg.get(name)
  if (existing) {
    existing.impl = impl
    for (const notify of existing.listeners) {
      try {
        notify()
      } catch (_) {}
    }
    return existing.component
  }
  const slot: RefreshSlot = {
    impl,
    listeners: new Set(),
    component(props: any) {
      try {
        const [, setTick] = useState(0)
        useEffect(() => {
          const notify = () => setTick((t: number) => (t + 1) | 0)
          slot.listeners.add(notify)
          return () => {
            slot.listeners.delete(notify)
          }
        }, [])
      } catch (_) {}
      return slot.impl(props)
    },
  }
  Object.defineProperty(slot.component, 'name', { value: name, configurable: true })
  reg.set(name, slot)
  return slot.component
}

/**
 * `__refresh_count()` — how many components the registry holds. For a test that
 * asserts the boundary is actually in the bundle, not merely emitted.
 */
export const __refresh_count = (): number => refreshRegistry().size


/* ---------------------------------------------------------------- re-exports */

export {
  useState, useEffect, useMemo, useRef, useCallback, useContext, createContext,
  Fragment, useId, useTransition, useDeferredValue, useLayoutEffect, Suspense, forwardRef,
}

// The core half is re-exported with `export *` above, which does not bring the
// names into this module's own scope: a function here that calls `format()` or
// `pow()` needs an explicit import, and TypeScript/ESM would leave it unbound
// (a ReferenceError in a shipped bundle) without this line.
import { all, any, contains, format, join, last, pow, title } from './core'

/* --------------------------------------------------- SaaS routing & hydration */

/**
 * Hydrate (or create) the root, after making sure the matched route's chunk is
 * in hand.
 *
 * Code splitting made this necessary: a route's component now arrives as a
 * dynamic import, and `hydrateRoot` runs SYNCHRONOUSLY. Hydrating before the
 * chunk resolves renders the loading fallback over server HTML that contains
 * the real page, which React reports as #418 (server/client mismatch) and then
 * #423 (it gave up and re-rendered the tree). Both were observed on a
 * scaffolded app the first time splitting was turned on — the page LOOKED
 * right after a moment, which is exactly the kind of "works" that hides a
 * broken first paint.
 *
 * So the chunk is fetched first and the result is put where `Router` looks
 * synchronously. If the project has no split chunks (the server bundle, a
 * bundled-without-splitting build), none of this runs.
 */
export function mount(component: any, element: HTMLElement | null) {
  if (!element) return null
  const table = (() => {
    try {
      return get_route_table_sync()
    } catch {
      return null
    }
  })()
  // `Object.keys(...).length` rather than a truthiness test: an EMPTY
  // `lazyPages` object is falsy only by luck, and it is emitted for every
  // project (empty when the build does not split). A project without splitting
  // has static components in `pages`, so it must take the plain path.
  const split = Boolean(table && table.lazyPages && Object.keys(table.lazyPages).length > 0)
  const route = split && table ? core_match_route(location_path(), table.routes) : null
  const pattern = route ? route.route.pattern : null
  const chunk = pattern && table && table.lazyPages ? table.lazyPages[pattern] : null

  const hydrate = () => {
    const node = typeof component === 'function' && !React.isValidElement(component)
      ? React.createElement(component)
      : component
    if (element.hasChildNodes() && element.children.length > 0) {
      return ReactDOM.hydrateRoot(element, node)
    }
    const root = ReactDOM.createRoot(element)
    root.render(node)
    return root
  }

  if (typeof chunk !== 'function') return hydrate()

  // The chunk arrives, then the tree hydrates against the HTML that was
  // rendered from the same component. No fallback paint in between.
  chunk()
    .then((mod: any) => {
      const picked = core_pick_page(mod)
      if (picked && pattern) {
        primed_pages[pattern] = picked
        // The same object the generated table holds, so `Router` reads it on
        // the first render. Two maps would be two chances to disagree, and the
        // first paint is where that disagreement is fatal.
        if (table && table.primedPages) table.primedPages[pattern] = picked
      }
    })
    .catch((err: any) => {
      // A chunk that will not load is a blank page with no explanation
      // anywhere; say which route, then hydrate anyway so the app's own error
      // boundary gets a chance to show something.
      console.error(`[hydra] could not load the chunk for ${pattern}:`, err)
    })
    .finally(hydrate)

  // A root handle is returned synchronously for callers that keep one. Rendering
  // starts after the chunk; the object is the live root either way.
  return null
}

/** The current path, without a query string or hash. */
function location_path(): string {
  if (typeof window === 'undefined') return '/'
  return window.location.pathname || '/'
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
    //
    // PATH only, never the query string: `use_path()` is the value callers
    // compare against `"/about"`, and the query is `use_query_string()`'s job.
    // The seed's `path` is the route PATTERN, so `url` is split here to keep a
    // render on `/blog?page=2` from looking like a different route.
    const seed = currentSeed()
    if (seed && seed.url) return seed.url.split('#')[0].split('?')[0]
    if (seed && seed.path) return seed.path
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
    window.history.pushState({}, '', with_base(to))
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
}

/**
 * Prefix a project-relative path with the configured `base`.
 *
 * With `base: "/sub/"`, `Link(to="/about")` rendered `href="/about"` and
 * `navigate()` pushed `/about` — both outside the app — while `navigate_to()`
 * added the prefix correctly. Two navigation APIs, two answers, and the one
 * used everywhere (`Link`) was the wrong one. `base` is `/` for most projects,
 * where this is the identity.
 */
function with_base(to: string): string {
  const base = (() => {
    try {
      return get_route_table_sync().base || '/'
    } catch {
      return '/'
    }
  })()
  if (base === '/' || base === '') return to
  if (!to.startsWith('/')) return to // external, hash, or relative: leave it
  if (to === base || to.startsWith(base)) return to
  return base.replace(/\/$/, '') + to
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
          window.history.replaceState({}, '', with_base(targetUrl))
          window.dispatchEvent(new PopStateEvent('popstate'))
        }
      } else {
        navigate(targetUrl)
      }
    }
  }

  return React.createElement('a', {
    // The href gets the base too. Without it the link works with JavaScript
    // (the click handler navigates) and 404s without — which is exactly the
    // case `Link` exists to keep working.
    href: with_base(targetUrl),
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
  /**
   * pattern -> `() => import('./Page.hyx')`, for the client bundle.
   *
   * With code splitting, `pages` is empty in the browser and each route's chunk
   * is fetched on demand. The server bundle keeps `pages` filled, because it
   * renders synchronously and cannot await a chunk mid-render.
   */
  lazyPages?: Record<string, () => Promise<any>>
  /**
   * pattern -> the component a chunk resolved to, written by `mount()` BEFORE
   * `hydrateRoot` and read by `Router` on its first render.
   *
   * Separate from `lazyPages` on purpose: an importer and a component are both
   * functions, so one map cannot answer "is this fetched yet" without guessing.
   */
  primedPages?: Record<string, any>
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
  /** The full URL being rendered, query included. `path` is the pattern. */
  url?: string
  /** What the route's loader returned, for the page it renders. */
  data?: Record<string, any> | null
}

let ssr_seed: SsrSeed | null = null

/**
 * Per-request seed storage.
 *
 * `ssr_seed` above is one slot for the whole module instance, which is correct
 * for a pre-render pass (one synchronous walk, one URL at a time) and wrong for
 * a server: two requests that both `await` a loader would write to the same slot
 * and the second page would render with the first one's data — silently, with
 * both pages looking plausible.
 *
 * `AsyncLocalStorage` gives each async call chain its own store, so a concurrent
 * server is correct by construction rather than by the discipline of never
 * awaiting between the write and the render. It is Node-only (`node:async_hooks`
 * does not exist in a browser), so it is loaded lazily and only when a caller
 * asks for it; a client bundle never reaches this code because the store is
 * always empty there.
 *
 * Kept alongside the global rather than replacing it: the SSG pass renders
 * synchronously and does not need an async context, and the browser has none.
 */
type Als = { run: <T>(store: SsrSeed, fn: () => T) => T; getStore: () => SsrSeed | undefined }
let als: Als | null = null
let alsTried = false

function seedStore(): Als | null {
  if (alsTried) return als
  alsTried = true
  try {
    // A literal specifier so a bundler can decide for itself; the browser build
    // never evaluates this branch because `process.versions.node` is undefined.
    const req = (globalThis as any).__hydra_require_async_hooks
    if (typeof req === 'function') {
      const { AsyncLocalStorage } = req()
      als = new AsyncLocalStorage() as Als
    }
  } catch {
    als = null
  }
  return als
}

/**
 * Register the AsyncLocalStorage constructor.
 *
 * A bundler cannot be handed a runtime `require('node:async_hooks')` without
 * either failing to resolve it for the browser or shipping a shim, so the server
 * entry injects it once at startup. Nothing else calls this.
 */
export function __set_async_local_storage(Ctor: new () => Als): void {
  // NOT `alsTried = true` with the constructor left unset: `seedStore()` marks
  // itself tried the first time anything asks for a store, and if that happened
  // before this ran — which it does, because the generated entry imports the
  // runtime and calls `renderSync` at module scope — the injection was
  // overwritten by `als = null` and every request fell back to the global slot.
  // That is exactly the bug this line fixes: the store existed, was created, and
  // was then forgotten.
  als = new Ctor()
  alsTried = true
}

/** The seed for the CURRENT async context, falling back to the global one. */
function currentSeed(): SsrSeed | null {
  if (als) {
    const store = als.getStore()
    if (store) return store
  }
  return ssr_seed
}

/** Called by the generated pre-render entry. Not for application code. */
export function __seed_for_ssr(seed: SsrSeed): void {
  ssr_seed = seed
  if (seed.table) route_table_cache = seed.table
}

/**
 * Run `fn` with `seed` as this async context's request state.
 *
 * This is what a server calls per request. Everything inside — the loader's
 * `use_loader`, `use_path`, the route table — reads this context and nothing
 * else, so two renders in flight cannot see each other's data.
 */
export function __with_ssr_seed<T>(seed: SsrSeed, fn: () => T): T {
  if (!seedStore()) {
    // No AsyncLocalStorage (a browser, or a Node without it): fall back to the
    // global slot with the same discipline the single-threaded path had. The
    // caller still gets a correct render; it just cannot be concurrent.
    __seed_for_ssr(seed)
    try {
      return fn()
    } finally {
      __clear_ssr_seed()
    }
  }
  if (seed.table) route_table_cache = seed.table
  return als!.run(seed, fn)
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
    lazyPages: m.lazyPages || {},
    primedPages: m.primedPages || {},
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
  const seed = currentSeed()
  if (seed) return seed.table
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
    // A resolved chunk replaces its importer in `lazyPages` (see `mount`), so
    // this slot answers for both: a static component, or one already fetched.
    // The first paint MUST see the component: server HTML contains the page, and
    // rendering a fallback in its place is React #418 and then #423.
    const primed = table && table.primedPages ? table.primedPages[pattern] : null
    return (table && table.pages[pattern]) || primed || null
  }, [pattern, components, table])

  // Code splitting: `pages` is empty in the browser and the route's module is a
  // chunk that has not been fetched yet. This resolves it once and caches the
  // component, so a second visit to the same route does not re-import.
  const [lazy, setLazy] = useState<{ pattern: string; component: any } | null>(null)
  useEffect(() => {
    if (!pattern || page || !table || !table.lazyPages) return
    const load = table.lazyPages[pattern]
    if (typeof load !== 'function') return
    let cancelled = false
    load()
      .then((mod: any) => {
        if (cancelled) return
        const picked = core_pick_page(mod)
        if (picked) setLazy({ pattern, component: picked })
      })
      .catch((err: any) => {
        // A chunk that fails to load is a blank page with no explanation; say
        // which route and which error rather than leaving an empty tree.
        console.error(`[hydra] could not load the chunk for ${pattern}:`, err)
      })
    return () => {
      cancelled = true
    }
  }, [pattern, page, table])

  const effectivePage = page || (lazy && lazy.pattern === pattern ? lazy.component : null)

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
  const requestSeed = currentSeed()
  const loaderData =
    requestSeed && requestSeed.path === pattern ? requestSeed.data : live.data


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

  const body = effectivePage
    ? wrapInLayouts(React.createElement(effectivePage, pageProps), layoutChain)
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

/* ----------------------------------------------------------- async & timing */

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
/* ----------------------------------------------------------------- objects
 *
 * Dict verbs Python has and JS expresses with twelve characters of spread
 * syntax. Everything here is non-mutating: `set_path` returns a NEW object,
 * because mutation is the thing React cannot see.
 */

/** `merge({a: 1}, {b: 2})` -> {a: 1, b: 2} — SHALLOW: `b` wins per top-level key. */
export function merge<A extends object, B extends object>(a: A, b: B): A & B {
  return { ...(a as any), ...(b as any) }
}

const is_plain_object = (x: unknown): x is Record<string, any> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) &&
  (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null)

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

type AnyFn = (...a: any[]) => any

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


