// [xihanzu-NR]
/**
 * `hydra/test` — the test API a `*.test.hys` file uses.
 *
 * Why this and not "use vitest": the components under test are `.hyx`, which no
 * JS test runner can import, and pretending otherwise means a build step and a
 * config file per project. `hydra test` bundles each test file with the same
 * resolver the build uses, then runs it here. One toolchain, no config.
 *
 * The API is deliberately small. It is a Pythonic framework's test runner, so
 * the names read like the language:
 *
 *     from "hydra/test" import test, expect, render, snapshot
 *     from "../src/Card.hyx" import Card
 *
 *     test("renders the title", lambda:
 *         html = render(Card(title="hi"))
 *         expect(html).to_contain("hi")
 *     )
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** One result per `test(...)` call, read by the CLI. */
export interface TestResult {
  name: string
  ok: boolean
  error: string | null
  ms: number
}

const results: TestResult[] = []
let currentFile = ''

/** Called by the CLI before each file, so a failure names its file. */
export function __set_file(file: string): void {
  currentFile = file
}

/** Every result so far. The CLI reads this after the file has run. */
export function __results(): TestResult[] {
  return results
}

/** Snapshot storage is supplied by the CLI; the runtime never writes files. */
let snapshotStore:
  | { read(key: string): string | null; write(key: string, value: string): void }
  | null = null

export function __set_snapshot_store(store: typeof snapshotStore): void {
  snapshotStore = store
}

/**
 * `test(name, fn)` — one test.
 *
 * `fn` may be async; `hydra test` awaits it. An exception is a failure, and the
 * message is kept verbatim: a test runner that rewrites the error is worse than
 * one that prints it.
 */
export function test(name: string, fn: () => unknown | Promise<unknown>): void {
  // Registered synchronously so the CLI sees the entry even if an async test is
  // still running when the file's top level ends.
  const entry: TestResult = { name, ok: false, error: 'did not run', ms: 0 }
  results.push(entry)
  const run = async () => {
    const started = Date.now()
    try {
      await fn()
      entry.ok = true
      entry.error = null
    } catch (err) {
      entry.ok = false
      const e = err as Error
      entry.error = e && e.stack ? e.stack : String(err)
    } finally {
      entry.ms = Date.now() - started
    }
  }
  // The queue must NOT swallow a failure into a rejected promise, and must not
  // be a promise the next `.then` cannot attach to.
  //
  // This was `pending = pending.then(run)` with `pending` typed `Promise<void>`
  // and never reset — so the second registration chained onto a promise that
  // had already settled, `__settled()` resolved before any test body ran, and
  // EVERY test reported `ok: true` with 0ms. A test runner that always says
  // pass is worse than none: it is a green light wired to nothing.
  pending = pending.then(run, run)
}
let pending: Promise<void> = Promise.resolve()

/** Resolved by the CLI after the file's top level has run. */
export function __settled(): Promise<void> {
  return pending.then(() => undefined)
}

/**
 * `expect(value)` — assertions, named the way Python reads.
 *
 * Each returns nothing and throws an `Error` whose message is the whole story:
 * what was expected, what was there. `to_contain` is here because a component
 * test almost always asserts on rendered markup.
 */
export function expect(actual: unknown) {
  const show = (v: unknown) =>
    typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'undefined' : String(v)
  return {
    to_be(expected: unknown): void {
      if (actual !== expected) {
        throw new Error(`expected ${show(expected)}, got ${show(actual)}`)
      }
    },
    to_equal(expected: unknown): void {
      const a = JSON.stringify(actual)
      const b = JSON.stringify(expected)
      if (a !== b) throw new Error(`expected ${b}, got ${a}`)
    },
    to_be_truthy(): void {
      if (!actual) throw new Error(`expected a truthy value, got ${show(actual)}`)
    },
    to_be_falsy(): void {
      if (actual) throw new Error(`expected a falsy value, got ${show(actual)}`)
    },
    to_contain(needle: string): void {
      const hay = String(actual)
      if (!hay.includes(needle)) {
        throw new Error(`expected the value to contain ${show(needle)}, got:\n${hay}`)
      }
    },
    not_to_contain(needle: string): void {
      const hay = String(actual)
      if (hay.includes(needle)) {
        throw new Error(`expected the value NOT to contain ${show(needle)}, but it did:\n${hay}`)
      }
    },
    to_throw(): void {
      let threw = false
      try {
        if (typeof actual === 'function') (actual as () => unknown)()
      } catch {
        threw = true
      }
      if (!threw) throw new Error('expected the call to throw, and it did not')
    },
  }
}

/**
 * `render(<component>)` — a component or an element to static HTML.
 *
 * `render_to_string` is the same thing under the JS-ish name. Static markup (not
 * `renderToString`): no hydration attributes, so a snapshot is the markup and
 * not the markup plus React's bookkeeping.
 */
export function render(node: unknown, props?: Record<string, any>): string {
  // Two accepted forms, because the two targets differ:
  //
  //   `.test.hyx` — `render(Card(title="hi"))`, which the .hyx compiler turns
  //                 into a JSX element, exactly as it would inside a component.
  //   `.test.hys` — `render(Card, {"title": "hi"})`. A `.hys` call with keyword
  //                 arguments has no signature to read for an imported
  //                 component, so the props are passed as an explicit dict.
  //
  // Both end up here. A component given with no props renders with its defaults,
  // which is what a smoke test wants.
  const element =
    typeof node === 'function'
      ? createElement(node as any, props || {})
      : (node as any)
  return renderToStaticMarkup(element)
}

export const render_to_string = render

/**
 * `snapshot("name", html)` — compare against the last accepted value.
 *
 * The CLI owns the file. A MISSING snapshot is written and the test PASSES: the
 * first run establishes the baseline, which is what every snapshot tool does and
 * the only behaviour that does not force a flag nobody remembers. `SNAP_UPDATE=1`
 * rewrites every snapshot it touches.
 */
export function snapshot(name: string, value: string): void {
  if (!snapshotStore) {
    throw new Error('snapshot() needs the `hydra test` runner (no snapshot store was set)')
  }
  const key = `${currentFile}::${name}`
  const existing = snapshotStore.read(key)
  if (existing === null || process.env.SNAP_UPDATE === '1') {
    snapshotStore.write(key, value)
    if (existing !== null && existing !== value) return
    return
  }
  if (existing !== value) {
    throw new Error(
      `snapshot "${name}" changed.\n--- stored ---\n${existing}\n--- now ---\n${value}` +
        `\n= if this is intended: SNAP_UPDATE=1 hydra test`,
    )
  }
}
