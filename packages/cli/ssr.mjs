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
 * The runtime keeps one module-global seed for the synchronous SSG pass and an
 * `AsyncLocalStorage` store for a server. Every render below therefore runs
 * INSIDE `withRequest`, not merely builds an element inside it — an async
 * render that escapes the store reads whichever request wrote the global last.
 * Identity is the full URL: two URLs can match the same pattern, so the inlined
 * payload carries `url` and the client only trusts a payload for the URL it is
 * rendering.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { matchRoute } from '../../runtime/router-core.js';
import { applyMeta } from './meta.mjs';
import { readBody, requestFor } from './actions.mjs';
import { httpIntent, errorBody } from './http.mjs';

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
  // Function replacers throughout: the tag carries the loader's JSON, and a
  // replacement STRING interprets `$&`, `` $` `` and `$'` — so a query value of
  // `$'` spliced the document into the hydration payload and produced JSON that
  // does not parse (a blank, data-dependent page). No loader needed: `?q=$'` in
  // the URL was enough.
  if (html.includes('id="__hydra_data__"')) {
    return html.replace(
      /<script type="application\/json" id="__hydra_data__">[\s\S]*?<\/script>/,
      () => tag,
    );
  }
  return html.includes('</body>')
    ? html.replace('</body>', () => `  ${tag}\n  </body>`)
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
/**
 * Split a shell at the root element: everything up to and including
 * `<div id="root">`, and everything from its closing tag on.
 *
 * The streamed path needs this because the app's markup is written BETWEEN the
 * two halves as React produces it, rather than injected into a saved copy. Null
 * when the shell has no root element, which is a project the buffered path also
 * cannot render — so the caller falls back rather than guessing.
 */
export function splitAtRoot(html) {
  const open = /<div\s+id=["']root["'][^>]*>/i.exec(html);
  if (!open) return [null, null];
  const start = open.index + open[0].length;
  let depth = 1;
  const re = /<\/div\s*>|<div\b[^>]*>/gi;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0) {
        return [html.slice(0, start), html.slice(m.index)];
      }
    } else {
      depth += 1;
    }
  }
  return [null, null];
}

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
  let loadedAt = -1;
  try {
    delete requireFrom.cache[requireFrom.resolve(bundlePath)];
    mod = requireFrom(bundlePath);
    loadedAt = fs.statSync(bundlePath).mtimeMs;
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
  // Hand the runtime a real AsyncLocalStorage, ONCE, before the first request.
  //
  // The runtime cannot `require('node:async_hooks')` itself: that import would
  // have to resolve for the browser bundle too, and a bundler would either fail
  // or ship a shim. Injecting it here keeps the browser build free of it and
  // makes the server path concurrent by construction. This is what lets two
  // requests await a loader at the same time without sharing a seed.
  if (typeof mod.__with_ssr_seed !== 'function' || typeof mod.__set_async_local_storage !== 'function') {
    return {
      available: false,
      reason:
        'the server bundle predates request context (no __with_ssr_seed) — run `hydra build` again',
    };
  }
  let alsClass = null;
  try {
    alsClass = (await import('node:async_hooks')).AsyncLocalStorage;
    mod.__set_async_local_storage(alsClass);
  } catch (e) {
    return { available: false, reason: `AsyncLocalStorage is unavailable: ${e.message}` };
  }

  const reactDomServerPath = requireFrom.resolve('react-dom/server');
  const reactPath = requireFrom.resolve('react');
  const reactDomServer = await import(pathToFileURL(reactDomServerPath).href);
  const { renderToString, renderToPipeableStream } = reactDomServer;
  const canStream = typeof renderToPipeableStream === 'function';
  const reactMod = await import(pathToFileURL(reactPath).href);
  const React = reactMod.default || reactMod;

  /**
   * Re-read the shell, and the bundle when it is newer than what was loaded.
   *
   * `hydra dev` calls this once and then rebuilds on every save, so a renderer
   * that loaded the bundle at startup kept rendering the FIRST build for the
   * rest of the session: an edit to a loader or a component was invisible on a
   * dynamic route, and the only symptom was "some pages never update". Same for
   * the shell, whose bundle `<script>` hash changes on every rebuild.
   *
   * Synchronous on purpose: the caller must not be able to `await` between this
   * and `renderSync`, or two requests interleave and share the loader seed.
   */
  const readShell = () => {
    let next = fs.existsSync(srcShell) ? fs.readFileSync(srcShell, 'utf8') : null;
    if (!next) next = fs.existsSync(shellPath) ? fs.readFileSync(shellPath, 'utf8') : null;
    if (next && fs.existsSync(builtPath)) {
      const built = fs.readFileSync(builtPath, 'utf8');
      const tag = /<script[^>]*src=["']([^"']*assets\/index-[^"']+)["'][^>]*>\s*<\/script>/i.exec(built);
      if (tag && !next.includes(tag[1])) {
        next = next.includes('</body>')
          ? next.replace('</body>', `  ${tag[0]}\n  </body>`)
          : next + `\n${tag[0]}\n`;
      }
    }
    return next;
  };

  // Renders that are still running. `ensureFresh()` reloads the bundle in
  // place, so a rebuild landing between a request's `loadFor` and its
  // `renderSync` used to hand one request TWO different module instances: data
  // shaped by the old build, rendered by the new one. In dev that is a render
  // that throws on a prop the old loader never produced, at exactly the moment
  // the developer saved the file — the least reproducible bug there is. The swap
  // now waits until nothing is mid-render, and every render holds the module it
  // started with.
  let active = 0;
  let swapPending = false;

  const ensureFresh = (force = false) => {
    let mtime = loadedAt;
    try {
      mtime = fs.statSync(bundlePath).mtimeMs;
    } catch {
      /* the bundle is gone; keep the one in memory rather than crash a request */
    }
    if (mtime !== loadedAt) {
      if (active > 0 && !force) {
        // Deferred: picked up by the next request, which starts cleanly.
        swapPending = true;
        return;
      }
      try {
        delete requireFrom.cache[requireFrom.resolve(bundlePath)];
        mod = requireFrom(bundlePath);
        loadedAt = mtime;
        swapPending = false;
        // A new module instance has its own AsyncLocalStorage binding, so the
        // hook has to be installed again or every request context is lost.
        if (alsClass && typeof mod.__set_async_local_storage === 'function') {
          mod.__set_async_local_storage(alsClass);
        }
      } catch {
        /* a half-written bundle: the previous one is still the better answer */
      }
    }
    shell = readShell() || shell;
  };

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

  const routes = () => (Array.isArray(mod.routes) ? mod.routes : []);

  return {
    available: true,
    get routes() {
      return routes();
    },
    /** The match for a URL, or null. */
    match(url) {
      const clean = String(url || '/').split('#')[0].split('?')[0];
      return matchRoute(clean, routes());
    },
    /**
     * Render one URL. `request` is passed through to the loader so it can see
     * the headers, the cookies and the body of the request that caused the
     * render; `url` is the FULL url including the query string, because a
     * loader that reads `?tab=info` and a client that reads the same must agree
     * — the first version passed the path only, so the server rendered with
     * one value and hydration used another.
     */
    async render(url, { request = null } = {}) {
      ensureFresh();
      const hit = this.match(url);
      if (!hit) return null;
      const params = hit.params;
      const pattern = hit.route.pattern;
      // ONE module instance for the whole render. `ensureFresh` may reload the
      // bundle while this request is awaiting its loader (a rebuild landing
      // mid-request); reading `mod` again afterwards would pair data from the
      // old build with the renderer of the new one.
      const m = mod;
      active += 1;
      try {
      const data = await m.loadFor(pattern, params, url, request);
      // The render runs INSIDE this request's async context, so another request
      // awaiting its own loader cannot see — or overwrite — this one's data.
      // Before request context existed the comment here said the opposite: that
      // nothing may `await` between the seed write and renderToString, because
      // the seed was one module-global. It still is one global for the SSG
      // pass, which is synchronous; a server is not.
      const rendered = m.withRequest
        ? m.withRequest({ path: pattern, url, data }, () => {
            const element = m.renderSync(pattern, params, url, data);
            return element ? renderToString(element) : null;
          })
        : (() => {
            const element = m.renderSync(pattern, params, url, data);
            const html = element ? renderToString(element) : null;
            if (typeof m.__clear_seed === 'function') m.__clear_seed();
            return html;
          })();
      if (rendered === null) return null;
      return { pattern, params, data, html: rendered, meta: hit.route.meta || null };
      } finally {
        // Only now may a pending reload take effect. A rebuild that arrived
        // while this request was in flight is picked up by the next one.
        active -= 1;
        if (active === 0 && swapPending) ensureFresh(true);
      }
    },
    /** Render a URL into a complete HTML document. */
    async renderPage(url, opts = {}) {
      const out = await this.render(url, opts);
      if (!out) return null;

      // A loader that redirects or refuses asked the SERVER for something, and
      // the answer is an HTTP response — not a page with the refusal as its
      // props. Rendering it produced a 200 with a blank page, which is the one
      // failure nobody can debug from a browser.
      const intent = httpIntent(out.data);
      if (intent) {
        return { ...out, intent, document: null };
      }

      let html = injectMarkup(shell, out.html);
      html = injectData(html, dataTag(out.pattern, url, out.data));
      // The same `meta` the pre-render pass applies. `shell` here is the
      // project's own index.html, whose title is the app's; without this a
      // page served for `/blog/hello` would answer with the shell's title while
      // the static build of every OTHER route had the page's.
      html = applyMeta(html, out.meta);
      return { ...out, intent: null, document: html };
    },
    /**
     * Render a URL into a complete HTML document, streamed.
     *
     * Why this exists: `renderToString` buffers the whole tree, so a page whose
     * loader takes 400 ms sends nothing for 400 ms and the browser shows a blank
     * document. `renderToPipeableStream` sends the shell immediately, and React
     * streams the rest as boundaries resolve — which is what every framework of
     * this class does and what "streaming SSR" means when it is claimed.
     *
     * The shape is different from the buffered path in two ways that matter:
     *
     *   - The document is assembled as TWO writes: everything before the app's
     *     markup, then everything after it. The loader data tag is written in
     *     the second part, because the data only exists once the loader has
     *     resolved — which is exactly the wait this avoids making the visitor
     *     sit through.
     *   - The rendered markup is NOT injected into a saved copy of the shell. It
     *     is written between the two halves, so reactivity is progressive: a
     *     boundary that suspends leaves its fallback in the first flush and its
     *     content in a later one.
     *
     * `onShellReady` fires when the shell is complete. Before that, a throw can
     * still be answered with a real error page, which is why nothing is written
     * until then.
     *
     * @returns {null | { pattern, params, data, meta, stream }}
     *   `stream` is a Node Readable; the caller pipes it and is responsible for
     *   the status line and headers.
     */
    async renderPageStream(url, opts = {}) {
      if (!canStream) return null;
      ensureFresh();
      const hit = this.match(url);
      if (!hit) return null;
      const params = hit.params;
      const pattern = hit.route.pattern;
      const request = opts.request || null;
      // Same reason as `render`: a stream outlives its function call, so it must
      // hold the instance it started with rather than read the live binding
      // again mid-flight.
      const m = mod;

      // The route loader is awaited here, BEFORE the head is written.
      //
      // That is a real limit, and it is stated rather than glossed: streaming
      // buys nothing for the ROOT loader's own latency, because `renderSync`
      // needs a value for the page to render with. What it does buy is that
      // everything below a Suspense boundary in the page streams as it resolves
      // instead of arriving with the first flush, and the document no longer
      // waits for the whole tree to be built in memory. A framework that streams
      // the loader itself needs React Server Components or a resolver-based
      // renderer; neither exists here yet, and pretending otherwise would be the
      // exact "claimed but not measured" failure this release is cleaning up.
      const data = await m.loadFor(pattern, params, url, request);
      const intent = httpIntent(data);
      if (intent) return { pattern, params, data, meta: hit.route.meta || null, intent, stream: null };

      const [before, after] = splitAtRoot(shell);
      if (before === null) return null; // no <div id="root">; the buffered path decides

      const head = applyMeta(before, hit.route.meta || null);
      const tail = after;

      // The render must run INSIDE this request's async context, not the element
      // CONSTRUCTION only.
      //
      // The bug this fixes was critical and structural: `withRequest` is
      // `als.run(seed, fn)`, and it used to wrap a lambda that merely BUILT a
      // React element — so `als.run` had already returned before React rendered
      // anything. Every hook below that point (`use_path`, `use_params`,
      // `use_loader`) called `currentSeed()`, which then fell back to the
      // MODULE-GLOBAL seed written by `renderSync` — i.e. whichever request wrote
      // it last. A Suspense boundary resolving in a later task read another
      // visitor's `{pattern, url, data}` and streamed it into this visitor's HTML.
      //
      // So the whole streaming setup runs inside `withRequest`: `handle.pipe()`
      // is what starts the render, and async continuations created under
      // AsyncLocalStorage inherit the store.
      const start = () => {
        const element = m.renderSync(pattern, params, url, data);
        if (!element) return null;

        let shellFailed = null;
        const handle = renderToPipeableStream(element, {
          onShellError(err) {
            shellFailed = err;
          },
          onError(err) {
            // A boundary failed AFTER the shell. The page still ships, so this is
            // a log line rather than a failed request — the same distinction the
            // buffered path makes between a 500 and a rendered error boundary.
            console.error(`[hydra] SSR stream error for ${pattern}: ${err && err.message ? err.message : err}`);
          },
        });

        // Three writes, in order: the head (that is the early first byte), React's
        // chunks as they are produced, then the data tag and the closing tags.
        // The last part can only be written once the loader's result exists —
        // which is the wait streaming exists to hide.
        const out = new PassThrough();
        out.write(head);

        let finished = false;

        // A client that navigates away mid-stream leaves React rendering into a
        // pipe nobody reads: the work continues to completion, holding the
        // component tree and the loader's data for a response that will never
        // arrive. One aborted tab is nothing; a mobile client that cancels on
        // every scroll is a permanent leak. `handle.abort()` is the only thing
        // that actually stops the render — destroying the PassThrough alone
        // leaves it going.
        out.on('close', () => {
          if (!finished) {
            try {
              handle.abort();
            } catch {
              /* the handle refuses after completion; that is a no-op we ignore */
            }
          }
        });
        const finish = () => {
          if (finished) return;
          finished = true;
          // Nothing this request put in the module-global slot may outlive it: a
          // later render that has no async context (the SSG pass, a tool) must not
          // find this request's data there.
          try {
            if (typeof m.__clear_seed === 'function') m.__clear_seed();
          } catch {
            /* clearing must never be the thing that breaks a response */
          }
          if (shellFailed) {
            out.destroy(shellFailed);
            return;
          }
          out.end(injectData('', dataTag(pattern, url, data)) + tail);
        };

        // React's pipe writes into `sink` and ends it when the render is done;
        // completion is observed there because the handle is not an emitter.
        //
        // React's FIRST chunk begins with a script that hides the fallbacks it
        // intends to replace later, and the markup follows immediately. The data
        // tag must come after ALL of it, not merely after the first chunk — the
        // previous version appended it on React's `end` but React had not flushed
        // its last chunk yet, so the tag landed between the shell and the markup.
        // A client reading it would trust a payload for a document that had not
        // finished arriving.
        const sink = new PassThrough();
        sink.on('data', (chunk) => out.write(chunk));
        sink.on('end', finish);
        sink.on('error', (err) => out.destroy(err));
        handle.pipe(sink);

        return out;
      };

      const out = m.withRequest
        ? m.withRequest({ path: pattern, url, data }, start)
        : start();
      if (!out) return null;

      return { pattern, params, data, meta: hit.route.meta || null, intent: null, stream: out };
    },
    /** Run just the loader, for the data endpoint. */
    async load(url, { request = null } = {}) {
      ensureFresh();
      const hit = this.match(url);
      if (!hit) return null;
      const pattern = hit.route.pattern;
      const data = await mod.loadFor(pattern, hit.params, url, request);
      return { pattern, params: hit.params, data };
    },
    /**
     * Render the project's `_404` for a URL nothing matched.
     *
     * A 404 has to be a real 404: a URL that does not exist must answer with
     * that status, or every bad link is indexed as a page and no monitor ever
     * sees it. Rendering the app's own `_404` component (rather than a bare
     * "Not Found" string) keeps the site's chrome, and it means the HTML the
     * browser hydrates matches what `Router()` renders for the same URL —
     * which the SPA fallback got wrong: it served the HOME page for `/nope`,
     * React found different text on the client, and the whole tree was thrown
     * away and re-rendered (React #425 then #423).
     */
    async renderNotFound(url) {
      ensureFresh();
      if (typeof mod.renderNotFound !== 'function') return null;
      const element = mod.renderNotFound(url);
      if (!element) return null;
      const rendered = renderToString(element);
      const html = injectMarkup(shell, rendered);
      return { pattern: '/__404', params: {}, data: null, html: rendered, document: html };
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
export async function handleDataRequest(req, res, renderer, url, opts = {}) {
  const parsed = new URL(url, 'http://localhost');
  const target = parsed.searchParams.get('url');
  const json = (status, body) => {
    // `no-store` + `Vary`: the same URL answers differently per visitor (the
    // loader reads the request), so a shared cache storing one visitor's JSON is
    // a cross-user leak. `nosniff` because this is JSON a browser must never
    // execute as a document.
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Cookie, Authorization',
      'X-Content-Type-Options': 'nosniff',
    });
    // Serialize first: a loader that returned something circular must not take
    // the process with it after the header is on the wire.
    let body_ = 'null';
    try {
      body_ = JSON.stringify(body);
    } catch (e) {
      res.end(
        JSON.stringify({ error: 'internal error', code: 'data_unserializable', ref: 'data' }),
      );
      console.error(`[hydra] data endpoint: unserializable payload for ${target}: ${e && e.message ? e.message : e}`);
      return;
    }
    res.end(body_);
  };
  if (!target) return json(400, errorBody('data_missing_url', 'missing ?url='));
  if (!renderer || !renderer.available) {
    return json(503, errorBody('renderer_unavailable', renderer ? renderer.reason : 'no renderer'));
  }
  let out;
  try {
    // The SAME request object the render path builds. Without it, a loader that
    // reads `cookie`/`authorization` saw the real value on first paint and an
    // empty headers object on client navigation — so a header-based guard either
    // denied wrongly or silently served the public branch.
    out = await renderer.load(target, { request: opts.request || null });
  } catch (e) {
    // The loader threw. Reporting that is the whole point: a page that renders
    // an empty list because the fetch failed looks identical to one that has no
    // items, and only one of those is a bug.
    return json(500, errorBody('loader_threw', e && e.message ? e.message : String(e), { url: target }));
  }
  if (!out) return json(404, errorBody('data_no_route', 'no route matches', { url: target }));

  // A loader used as an auth gate answers HERE too.
  //
  // This path used to serialize `out.data` directly and never looked at
  // `httpIntent`, so `redirect('https://evil.example/x')` came back as
  // `200 {data:{redirect:...}}` and `fail(401,{secret})` came back as
  // `200 {data:{status:401,...}}` — the refusal object delivered as page props,
  // with the client reading 200 as `status:'ready'`. The same three lines the
  // render path already has, before anything is serialized.
  const intent = httpIntent(out.data);
  if (intent && intent.kind === 'redirect') {
    return json(200, { pattern: out.pattern, url: target, redirect: intent.location, status: intent.status });
  }
  if (intent && intent.kind === 'fail') {
    return json(intent.status, errorBody('loader_refused', 'the loader refused this URL', intent.data, intent.status));
  }

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
