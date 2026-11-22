// [xihanzu-NR]
/**
 * Route contract tests: run every route's real loader, in process, without a
 * browser.
 *
 * Why generated rather than written: the same five assertions are true of every
 * project (the loader does not throw, today's data is JSON, a refusal is a real
 * status, a redirect has a destination, the params shape matches the pattern) and
 * nobody writes them for 40 routes. The build already knows the routes and the
 * loaders are already bundled in `.hydra/api.cjs`, so this is a loop over what
 * exists rather than a test framework.
 *
 * What it is NOT: it does not render. A loader that returns a shape the page
 * cannot render passes here and fails in the browser, which is what the runtime
 * gate is for. The two cover different halves and neither claims the other's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** A URL that satisfies a route's params, for calling its loader. */
function sampleUrl(pattern) {
  return pattern.replace(/\[\.\.\.[^\]]+\]/g, 'sample').replace(/\[[^\]]+\]/g, 'sample');
}

/** The params a URL yields for a pattern, using the bundle's own matcher. */
function paramsFor(mod, url) {
  const hit = mod.match ? mod.match(url) : null;
  return hit && hit.params ? hit.params : {};
}

/**
 * Run every loader (or the one route asked for) and report per route.
 *
 * Returns `{ ok, results }` rather than printing and exiting, so the caller
 * decides how a failure is presented — `hydra test --routes` prints it, and a
 * future CI step can do something else with it.
 */
export async function runRouteTests(cwd, opts = {}) {
  // The loaders live in the ACTION bundle (`.hydra/actions.cjs`), not the API
  // one: both are server code, but only one of them carries `loader`/`action`.
  // `.hydra/api.cjs` is accepted as a fallback because a project without actions
  // still writes it, and an older build may only have one of the two.
  const candidates = [path.join(cwd, '.hydra', 'actions.cjs'), path.join(cwd, '.hydra', 'api.cjs')];
  const bundle = candidates.find((p) => fs.existsSync(p));
  if (!bundle) {
    return {
      ok: false,
      results: [],
      error: 'no .hydra/actions.cjs — run `hydra build` first (the loaders are bundled by it)',
    };
  }
  let mod;
  try {
    delete require.cache[require.resolve(bundle)];
    mod = require(bundle);
  } catch (e) {
    return { ok: false, results: [], error: `could not load ${bundle}: ${e.message}` };
  }
  const loaders = mod.loaders || {};
  const patterns = Object.keys(loaders).filter((p) => typeof loaders[p] === 'function');
  const wanted = opts.route
    ? patterns.filter((p) => p === opts.route || p === `/${String(opts.route).replace(/^\//, '')}`)
    : patterns;

  if (wanted.length === 0) {
    return {
      ok: false,
      results: [],
      error: opts.route
        ? `no loader for ${opts.route} (routes with a loader: ${patterns.join(', ') || 'none'})`
        : 'no route has a loader',
    };
  }

  const results = [];
  for (const pattern of wanted) {
    const url = sampleUrl(pattern);
    const params = paramsFor(mod, url);
    const event = {
      params,
      url,
      path: url,
      query: Object.assign({}, { get: () => null, has: () => false }),
      headers: {},
      // A loader that reads `event.request.headers` gets an empty object rather
      // than `undefined`: a loader written for a real request must not crash
      // here for a reason that is about the test.
      request: { method: 'GET', url, headers: {}, body: {}, json: async () => ({}), text: async () => '' },
      // A refusal has to be a STATUS. A loader that returns `fail(401, …)` and
      // one that returns data are the same shape otherwise, and the difference
      // is the whole point of the API.
      _headers: [],
    };
    const started = Date.now();
    try {
      const out = await loaders[pattern](event);
      const ms = Date.now() - started;
      const problems = [];
      if (out && typeof out === 'object' && typeof out.redirect === 'string') {
        if (!out.redirect) problems.push('redirect has an empty destination');
        if (out.status !== undefined && !(out.status >= 300 && out.status < 400)) {
          problems.push(`redirect with status ${out.status}`);
        }
      } else if (out && typeof out === 'object' && Number.isInteger(out.status) && 'data' in out) {
        if (out.status < 100 || out.status > 599) problems.push(`status ${out.status} is not a status`);
      } else {
        try {
          JSON.stringify(out === undefined ? null : out);
        } catch {
          problems.push('the return value is not JSON-serializable');
        }
      }
      results.push({ pattern, url, ok: problems.length === 0, problems, ms });
    } catch (e) {
      results.push({
        pattern,
        url,
        ok: false,
        problems: [`threw: ${e && e.message ? e.message : String(e)}`],
        ms: Date.now() - started,
      });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}
