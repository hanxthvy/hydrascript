// [xihanzu-NR]
/**
 * Route matching, shared by the compiler-side scanner and the runtime.
 *
 * This file exists as plain JavaScript for exactly one reason: there must be
 * ONE matcher. The CLI needs it to enumerate routes and the browser needs it to
 * resolve the current URL, and two implementations of the same rule is the bug
 * this repository has already been bitten by more than once — a build that
 * agrees with itself and a page that does not is exactly what a duplicated
 * source of truth produces.
 *
 * No dependencies, no imports, no build step. `packages/cli/router.mjs` imports
 * it directly under Node; `runtime/hydra.ts` imports it through esbuild when a
 * page is bundled.
 */

/**
 * Rank a pattern segment. Lower is more specific, and matching relies on the
 * route table already being sorted this way.
 */
export const SEGMENT_RANK = { literal: 0, group: 0, param: 1, catchall: 2 };

/**
 * Compare two routes so the more specific one sorts first.
 *
 * Segment by segment, left to right: a literal beats a param, which beats a
 * catch-all. The tiebreak (shorter, then alphabetical) only ever applies
 * between routes that cannot both match the same URL, so it decides the order
 * the table is *read* in, never which route answers.
 */
export function compareRoutes(a, b) {
  const shared = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < shared; i++) {
    const ra = SEGMENT_RANK[a.segments[i].kind] ?? 3;
    const rb = SEGMENT_RANK[b.segments[i].kind] ?? 3;
    if (ra !== rb) return ra - rb;
  }
  if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length;
  return String(a.pattern).localeCompare(String(b.pattern));
}

/** Split a URL path into decoded segments. `/` is the empty list. */
export function pathSegments(urlPath) {
  const raw = String(urlPath ?? '/');
  // A query string or hash is not part of the route.
  const withoutQuery = raw.split('#')[0].split('?')[0];
  // Stripping the trailing slashes of `/` leaves the empty string, and
  // `''.split('/')` is `['']` — one empty segment, which matches nothing. The
  // root URL has to become the empty LIST, or `/` stops resolving to `/`.
  const trimmed = withoutQuery.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return [];
  return trimmed.split('/').map(decodePart);
}

function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    // A malformed escape is a literal, not a crash: the URL simply will not
    // match a route, and the not-found page is the right answer.
    return part;
  }
}

/**
 * Match one route's segments against a URL's segments.
 *
 * Returns the params object, or `null`. No backtracking: this pattern language
 * has no alternation, so a single left-to-right pass is complete.
 */
export function matchSegments(urlParts, patternParts) {
  const params = {};
  let i = 0;

  for (let p = 0; p < patternParts.length; p++) {
    const seg = patternParts[p];
    if (seg.kind === 'group') continue;

    if (seg.kind === 'catchall') {
      const rest = urlParts.slice(i);
      if (rest.length === 0 && !seg.optional) return null;
      params[seg.name] = rest;
      return params;
    }

    if (i >= urlParts.length) return null;
    const value = urlParts[i];
    i += 1;

    if (seg.kind === 'param') {
      params[seg.name] = value;
    } else if (seg.value !== value) {
      return null;
    }
  }

  return i === urlParts.length ? params : null;
}

/**
 * Resolve a URL path against a sorted route table.
 *
 * Returns `{ route, params }`, or `null` when nothing matches. The first match
 * wins and the table is sorted by specificity at generation time, so there is
 * no second pass and no scoring here.
 */
export function matchRoute(urlPath, routes) {
  const parts = pathSegments(urlPath);
  for (const route of routes || []) {
    const params = matchSegments(parts, route.segments || []);
    if (params) return { route, params };
  }
  return null;
}

/** The query string of a URL path, as an object. */
export function parseQuery(urlPath) {
  const raw = String(urlPath ?? '');
  const at = raw.indexOf('?');
  if (at === -1) return {};
  const withoutHash = raw.slice(at + 1).split('#')[0];
  const out = {};
  for (const pair of withoutHash.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    out[decodePart(key)] = decodePart(value);
  }
  return out;
}

/**
 * Pick the page component out of a loaded module.
 *
 * One rule, used by the runtime and by the pre-render pass, so a page renders
 * the same in both: `default` if it was exported, otherwise the first exported
 * PascalCase function. A file that exports neither is not a page, and saying so
 * is the caller's job — this returns null rather than guessing.
 */
export function pickPageComponent(mod) {
  if (!mod) return null;
  if (typeof mod.default === 'function') return mod.default;
  const named = Object.keys(mod).filter(
    (k) => k !== 'default' && typeof mod[k] === 'function' && /^[A-Z]/.test(k),
  );
  return named.length > 0 ? mod[named[0]] : null;
}
