// [xihanzu-NR]
/**
 * Response headers a handler asked for, carried out of the handler.
 *
 * `cookies(event).set(...)`, `session(event).set(...)` and `set_header(event, …)`
 * do not own a `res` — the event object they are given is a plain object built
 * for a loader, an action or an API handler, and the same object is built in
 * four different places. So they append to a list on the event, and whoever
 * writes the response flushes that list at the last possible moment, before
 * `writeHead`.
 *
 * Two rules this module exists to enforce in one place:
 *
 *   1. `Set-Cookie` repeats. `res.setHeader('Set-Cookie', oneString)` on a
 *      second call REPLACES the first, so a login that sets a session cookie
 *      and a flash cookie together silently loses one. The bag is collected and
 *      written as an array, which is the only shape node sends as two headers.
 *   2. A 5xx must not carry `Set-Cookie`. An error page that sets a cookie
 *      rewrites the visitor's session with whatever half-finished value the
 *      failing handler had reached. `flushHeaderBag` takes the status and drops
 *      the cookies for a 5xx, keeping the other headers.
 */

/** A fresh bag. An array of `[name, value]` pairs, in the order they were set. */
export function newHeaderBag() {
  return [];
}

/**
 * Append one header to a bag, refusing values node would throw on.
 *
 * CR/LF in a header value is header injection, and node's answer is a throw out
 * of `writeHead` — which for a handler means an unhandled rejection instead of
 * an error page. It cannot be written either way; the difference is whether the
 * process survives saying so.
 */
export function noteHeader(bag, name, value) {
  if (!Array.isArray(bag)) return false;
  const n = String(name);
  const v = String(value);
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(n)) {
    throw new Error(`hydra: ${JSON.stringify(n)} is not a valid header name`);
  }
  if (/[\r\n\0]/.test(v)) {
    throw new Error(`hydra: header ${n} contains CR, LF or NUL`);
  }
  bag.push([n, v]);
  return true;
}

/**
 * Write a bag onto a response. Call this immediately before `writeHead`.
 *
 * `status` is required rather than optional on purpose: the 5xx rule is the
 * whole reason this is a function and not three `res.setHeader` lines at each
 * call site.
 */
export function flushHeaderBag(res, bag, status = 200) {
  if (!Array.isArray(bag) || bag.length === 0) return;
  const failed = Number(status) >= 500;
  const cookies = [];
  const plain = new Map();
  for (const [name, value] of bag) {
    if (name.toLowerCase() === 'set-cookie') {
      if (!failed) cookies.push(value);
    } else {
      plain.set(name, value);
    }
  }
  for (const [name, value] of plain) {
    try {
      res.setHeader(name, value);
    } catch {
      /* a header node refuses is not worth failing the response over */
    }
  }
  if (cookies.length) {
    // setHeader, not writeHead: writeHead with an existing name replaces the
    // earlier value, and the security headers were already set that way.
    res.setHeader('Set-Cookie', cookies);
  }
}
