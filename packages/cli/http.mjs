// [xihanzu-NR]
/**
 * HTTP intent: what a loader, an action or an API handler asked the SERVER to
 * do, as opposed to what it returned as data.
 *
 * `redirect(path)` and `fail(status, data)` from `hydra/server` are not values a
 * page should render. They are instructions. Before this module existed each
 * consumer decided for itself: `handleAction` knew about `redirect`, the loader
 * path knew about nothing, and `apiResult` treated both as ordinary JSON — so
 * `fail(401)` answered HTTP **200** with the refusal sitting in the body, and a
 * loader that redirected rendered a page with a redirect object as its props.
 *
 * One function, four call sites (action, API route, SSR render, data endpoint),
 * so a new consumer cannot invent a fifth reading of the same two shapes.
 */

/**
 * Read an intent out of a returned value, or null when the value is just data.
 *
 * Deliberately narrow. A handler that returns `{"redirect": "/x"}` as DATA —
 * a config object, say — would be misread, so the shape is checked strictly:
 * `redirect` must be a string, and a fail envelope must have an integer
 * `status` in range plus a `data` key and no `body` key (which is what
 * distinguishes it from the `{status, body}` shape `apiResult` documents).
 */
export function httpIntent(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;

  if (typeof out.redirect === 'string') {
    const status = Number.isInteger(out.status) ? out.status : 303;
    return { kind: 'redirect', status, location: out.redirect };
  }

  const hasStatus = Number.isInteger(out.status) && out.status >= 100 && out.status <= 599;
  if (hasStatus && 'data' in out && !('body' in out)) {
    return { kind: 'fail', status: out.status, data: out.data === undefined ? null : out.data };
  }

  return null;
}

/**
 * Write an intent to a node response. Returns true when it answered.
 *
 * A redirect is `Location` + the status the helper chose (303 by default, so a
 * POST becomes a GET on the next request — the behaviour a form expects).
 * A fail is the status plus the data as JSON, which is what the page needs to
 * explain itself.
 */
export function sendHttpIntent(res, intent, extraHeaders = {}) {
  if (!intent) return false;
  if (intent.kind === 'redirect') {
    res.writeHead(intent.status, { ...extraHeaders, Location: intent.location });
    res.end();
    return true;
  }
  const head = { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders };
  res.writeHead(intent.status, head);
  res.end(JSON.stringify(intent.data === null ? null : intent.data));
  return true;
}
