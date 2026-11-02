// [xihanzu-NR]
/**
 * `hydra/client` — helpers that only exist in a browser.
 *
 * The mirror of `hydra/server`, and refused the same way in the opposite
 * direction: the pre-render pass does not resolve this module, so a loader that
 * touches `window` fails the build instead of producing HTML that quietly
 * differs from what the client renders.
 *
 * Each helper answers "is there a browser" honestly rather than pretending.
 */

/** `in_browser()` — false during pre-rendering, and during `hydra run`. */
export function in_browser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

/** `win()` — the window, or a clear error instead of `undefined.something`. */
export function win(): Window {
  if (!in_browser()) {
    throw new Error(
      'hydra/client: no window here. This code ran during pre-rendering or in node; ' +
        'move it into an effect (`use_effect`) so it runs in the browser only.',
    )
  }
  return window
}

/** `doc()` — the document, under the same rule as `win()`. */
export function doc(): Document {
  if (!in_browser()) {
    throw new Error(
      'hydra/client: no document here. This code ran during pre-rendering or in node; ' +
        'move it into an effect (`use_effect`) so it runs in the browser only.',
    )
  }
  return document
}

/**
 * `storage_get(key, fallback)` / `storage_set(key, value)`.
 *
 * Wrapped because `localStorage` throws in a browser with storage disabled
 * (private mode, a blocked-cookie profile) and a component that crashes on the
 * first read is a worse failure than a missing preference.
 */
export function storage_get(key: string, fallback: string | null = null): string | null {
  if (!in_browser()) return fallback
  try {
    const v = window.localStorage.getItem(key)
    return v === null ? fallback : v
  } catch {
    return fallback
  }
}

export function storage_set(key: string, value: string): boolean {
  if (!in_browser()) return false
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** `prefers_dark()` — the media query, false when there is no browser. */
export function prefers_dark(): boolean {
  if (!in_browser() || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export default { in_browser, win, doc, storage_get, storage_set, prefers_dark }
