// [xihanzu-NR]
/**
 * Server-side rendering for dynamic routes, and the data endpoint.
 *
 * Why a server at all: a route with a parameter (`/blog/[slug]`) has no single
 * URL, so `hydra build` cannot write one HTML file for it — it leaves a client
 * shell and says so. That is correct for a static deploy and wrong for the two
 * cases everyone actually has: a crawler asking for `/blog/hello`, and a person
 * who reloads on that URL. Both get an empty shell from a static build.
 *
 * So `hydra dev`, `hydra preview` and `hydra serve` render those routes per
 * REQUEST from the same prebuilt server bundle the SSG pass uses, and expose
 * the data endpoint a client-side navigation needs.
 *
 * Two rules kept this honest while writing it, and both come from the runtime
 * having one module-global seed:
 *
 *   1. Loading and rendering are separate calls, and nothing may `await` between
 *      `renderSync` and `renderToString`. Otherwise two concurrent requests
 *      interleave and the second page renders with the first one's data.
 *   2. Identity is the full URL. Two URLs can match the same pattern, so the
 *      inlined payload carries `url` and the client only trusts a payload for
 *      the URL it is rendering.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { matchRoute } from '../../runtime/router-core.js';
import { applyMeta } from './meta.mjs';
import { readBody, requestFor } from './actions.mjs';

/** Where the build leaves the server bundle for the dev/preview/serve commands. */
export const SERVER_BUNDLE = path.join('.hydra', 'server.cjs');

/** A route needs a server render when its URL has a parameter. */
export function patternIsDynamic(route) {
  return (route.segments || []).some((s) => s.kind === 'param' || s.kind === 'catchall');
}

/**
 * The inlined data tag. Same shape the pre-render pass writes, so the client
 * reads one format from both.
 *
 * `url` is here on purpose: it is what lets the client tell "this is my data"
 * from "this is the same pattern with different parameters".
 */
export function dataTag(pattern, url, data) {
  const payload = JSON.stringify({
    pattern,
    url,
    data: data === undefined ? null : data,
  })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/json" id="__hydra_data__">${payload}</script>`;
}

/** Replace the data tag if the shell has one, else insert before `</body>`. */
export function injectData(html, tag) {
  if (html.includes('id="__hydra_data__"')) {
    return html.replace(
      /<script type="application\/json" id="__hydra_data__">[\s\S]*?<\/script>/,
      tag,
    );
  }
  return html.includes('</body>')
    ? html.replace('</body>', `  ${tag}\n  </body>`)
    : html + `\n${tag}\n`;
}

/**
 * Replace whatever is inside `<div id="root">` with the rendered markup.
 *
 * The closing tag is found by COUNTING nested `<div`s, not by the first
 * `</div>`. A non-greedy match against a root that already had content stops at
 * the first inner close and leaves the rest of the old markup's closing tags
 * behind — which is exactly what happened the first time a shell with a
 * pre-rendered page was used: the response looked plausible and the div nesting
 * was wrong.
 *
 * The shell should be the project's own `index.html` (empty root) for the same
 * reason the pre-render pass reads that rather than `dist/index.html`. This
 * handles both correctly rather than depending on it.
 */
export function injectMarkup(html, rendered) {
  const open = /<div\s+id=["']root["'][^>]*>/i.exec(html);
  if (!open) {
    // No root element at all: the app cannot mount, so say so by returning the
    // html untouched rather than inventing a container.
    return html;
  }
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  let end = -1;
  // `depth` tracks only `<div` / `</div>`, which is all this needs to find the
  // matching close. Anything else in the markup (script tags, attributes with
  // `<`) does not affect the balance of div elements.
  const re = /<\/div\s*>|<div\b[^>]*>/gi;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0) {
        end = m.index;
        break;
      }
    } else {
      depth += 1;
    }
  }
  if (end === -1) {
    // Unbalanced markup: fall back to appending, which is visibly wrong rather
    // than subtly wrong.
    return html.slice(0, start) + rendered + html.slice(start);
  }
  return html.slice(0, start) + rendered + html.slice(end);
}

/**
 * Load a prebuilt server bundle and give back a renderer.
 *
 * The bundle is CommonJS and required from its own path so every `require` in
 * it resolves against the project's node_modules — loading it as ESM or from a
 * `data:` URL leaves it with no `require` at all and it dies on
 * "Dynamic require of react is not supported".
 */
export async function createRenderer({ cwd, bundlePath, shellPath }) {
  if (!fs.existsSync(bundlePath)) {
    return { available: false, reason: `no server bundle at ${path.relative(cwd, bundlePath)}` };
  }
  const requireFrom = createRequire(pathToFileURL(bundlePath).href);
  let mod;
  try {
    delete requireFrom.cache[requireFrom.resolve(bundlePath)];
    mod = requireFrom(bundlePath);
  } catch (e) {
    return { available: false, reason: `could not load the server bundle: ${e.message}` };
  }
  if (typeof mod.renderSync !== 'function' || typeof mod.loadFor !== 'function') {
    return {
      available: false,
      reason:
        'the server bundle predates 0.8 (no loadFor/renderSync) — run `hydra build` again',
    };
  }

  const reactDomServerPath = requireFrom.resolve('react-dom/server');
  const reactPath = requireFrom.resolve('react');
  const { renderToString } = await import(pathToFileURL(reactDomServerPath).href);
  const reactMod = await import(pathToFileURL(reactPath).href);
  const React = reactMod.default || reactMod;

  // The SOURCE shell, not `dist/index.html`.
  //
  // `dist/index.html` has a pre-rendered page inside `<div id="root">` already,
  // and injecting over it is the nesting bug `injectMarkup` documents. The
  // project's own `index.html` has the empty root every render starts from. The
  // bundle `<script>` tag, which only the build knows, is carried over from the
  // built file.
  const builtPath = shellPath;
  const srcShell = path.join(cwd, 'index.html');
  let shell = fs.existsSync(srcShell) ? fs.readFileSync(srcShell, 'utf8') : null;
  if (!shell) shell = fs.existsSync(shellPath) ? fs.readFileSync(shellPath, 'utf8') : null;
  if (!shell) {
    return { available: false, reason: `no shell HTML at ${path.relative(cwd, srcShell)}` };
  }
  if (shell !== null && fs.existsSync(builtPath)) {
    const built = fs.readFileSync(builtPath, 'utf8');
    const tag = /<script[^>]*src=["']([^"']*assets\/index-[^"']+)["'][^>]*>\s*<\/script>/i.exec(built);
    if (tag && !shell.includes(tag[1])) {
      const inn = shell.includes('</body>')
        ? shell.replace('</body>', `  ${tag[0]}\n  </body>`)
        : shell + `\n${tag[0]}\n`;
      shell = inn;
    }
  }

  const routes = Array.isArray(mod.routes) ? mod.routes : [];

  return {
    available: true,
    routes,
    /** The match for a URL, or null. */
    match(url) {
      const clean = String(url || '/').split('#')[0].split('?')[0];
      return matchRoute(clean, routes);
    },
    /**
     * Render one URL. `request` is passed through to the loader for an SSR of a
     * POST-shaped flow; a GET passes null and the loader sees a GET event.
     */
    async render(url, { request = null } = {}) {
      const hit = this.match(url);
      if (!hit) return null;
      const params = hit.params;
      const pattern = hit.route.pattern;
      const data = await mod.loadFor(pattern, params, url, request);
      const element = mod.renderSync(pattern, params, url, data);
      if (!element) return null;
      const rendered = renderToString(element);
      if (typeof mod.__clear_seed === 'function') mod.__clear_seed();
      return { pattern, params, data, html: rendered, meta: hit.route.meta || null };
    },
    /** Render a URL into a complete HTML document. */
    async renderPage(url, opts = {}) {
      const out = await this.render(url, opts);
      if (!out) return null;
      let html = injectMarkup(shell, out.html);
      html = injectData(html, dataTag(out.pattern, url, out.data));
      // The same `meta` the pre-render pass applies. `shell` here is the
      // project's own index.html, whose title is the app's; without this a
      // page served for `/blog/hello` would answer with the shell's title while
      // the static build of every OTHER route had the page's.
      html = applyMeta(html, out.meta);
      return { ...out, document: html };
    },
    /** Run just the loader, for the data endpoint. */
    async load(url, { request = null } = {}) {
      const hit = this.match(url);
      if (!hit) return null;
      const pattern = hit.route.pattern;
      const data = await mod.loadFor(pattern, hit.params, url, request);
      return { pattern, params: hit.params, data };
    },
  };
}

/**
 * `GET /__hydra/data?url=/blog/hello` — the loader's result as JSON.
 *
 * A client-side navigation to a route that was never rendered server-side has
 * no inlined payload, so this is how it gets one. 404 when no route matches,
 * and a payload with `data: null` when the route simply has no loader: those are
 * different answers and the client tells them apart by `pattern`.
 */
export async function handleDataRequest(req, res, renderer, url) {
  const parsed = new URL(url, 'http://localhost');
  const target = parsed.searchParams.get('url');
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (!target) return json(400, { error: 'missing ?url=' });
  if (!renderer || !renderer.available) {
    return json(503, { error: renderer ? renderer.reason : 'no renderer' });
  }
  let out;
  try {
    out = await renderer.load(target);
  } catch (e) {
    // The loader threw. Reporting that is the whole point: a page that renders
    // an empty list because the fetch failed looks identical to one that has no
    // items, and only one of those is a bug.
    return json(500, { error: e && e.message ? e.message : String(e), url: target });
  }
  if (!out) return json(404, { error: 'no route matches', url: target });
  return json(200, { pattern: out.pattern, url: target, data: out.data ?? null });
}

/**
 * Wrap the `serveDirectory` option object so it also answers routes the static
 * build could not write, and the data endpoint.
 *
 * Returns `{ opts, renderer }`; `opts` is what the caller passes on.
 */
export async function withSsrOptions(cwd, outDir, opts, shellName = 'index.html') {
  const renderer = await createRenderer({
    cwd,
    bundlePath: path.join(cwd, SERVER_BUNDLE),
    shellPath: path.join(outDir, shellName),
  });

  const next = { ...opts };
  next.ssr = renderer.available ? renderer : null;
  return { options: next, renderer };
}

export { readBody, requestFor };
