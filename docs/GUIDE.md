<!-- [xihanzu-NR] -->
# Guide: the meta-framework

Everything `hydra dev`, `hydra build` and `hydra preview` do, in one place:
file-based routing, pre-rendering, loaders and actions, API routes, middleware,
environment variables, deployment targets, SSR, the test runner, and the
language server.

The [README](../README.md) carries the short version of each; this file is the
reference when you need the detail and the exact behaviour.

---

**`hydra dev`, `build` and `preview` use esbuild, not Vite.** No `vite.config.ts`
is needed. The CSS pipeline is the project's choice, and every form it can take
is described under [Styling](#styling).

| Command | Does |
|---|---|
| `hydra dev` | Builds, serves, rebuilds on change, live-reloads the browser |
| `hydra build` | Production build: hashed assets, minified CSS, SSG |
| `hydra preview` | Serves `dist/` (builds first if it is missing) |
| `hydra run <file.hys>` | Executes a script in-process |

**On "HMR":** `hydra dev` watches `src/`, rebuilds, and **reloads the page in the
browser over a websocket** — no dependency, no browser extension. Measured
save-to-reload is **~190 ms** on this repo, median of 3 edits
(`node benchmarks/dev-reload.mjs`); the first build is ~1.4 s. What it does *not* do is preserve component state across a
change: a successful edit reloads, it does not hot-swap the module. Calling that
React Fast Refresh would be wrong, so this README calls it live reload.

**A failed rebuild does not reload.** It sends the error to the page instead, so
the console shows the compiler's message with the file and line, and you keep the
last working page until the code compiles again.

### File-based routing

`src/pages/` is the route table. The filename decides the URL, and `hydra routes`
prints the result so that none of it is hidden.

```
src/pages/index.hyx             -> /
src/pages/about.hyx             -> /about
src/pages/blog/index.hyx        -> /blog
src/pages/blog/[slug].hyx       -> /blog/:slug
src/pages/docs/[...rest].hyx    -> /docs/*      (one segment or more)
src/pages/files/[[...rest]].hyx -> /files/*     (also /files)
src/pages/(marketing)/price.hyx -> /price       (group: layout scope only)
src/pages/_partials/Hero.hyx    -> not routable
```

`_layout.hyx` wraps every route in its folder and below, `_404.hyx` renders when
nothing matches, and `_error.hyx` is the error boundary for its folder. All three
may appear at several levels; the nearest one wins.

`hydra routes --json` includes each route's `meta`, so the title a page declares
is inspectable from the shell rather than only by reading the build's output.

Two files that claim the same URL are a **build error naming both files**, not a
race decided silently. That covers `blog/[slug].hyx` + `blog/[id].hyx` (one URL
position, two parameter names) and `about.hyx` + `about/index.hyx` (one URL, two
files).

The directory is configurable through `"routes"` in `hydraconfig.json`, or turned
off with `"routes": false`.

## Pre-rendering, per route

**A build writes one HTML file per static route**: `dist/about/index.html`, not
one `dist/index.html` for the whole site. Dynamic routes are skipped and **named**
in the build log, because a URL with a parameter has no single page to build:

```
[hydra] 4 route(s) from src/pages, 1 dynamic (/blog/:slug)
[hydra] SSG: pre-rendered 3/3 static route(s) into dist/
[hydra] SSG: 1 dynamic route(s) left as the client shell (/blog/:slug) —
        a URL with a parameter has no single page to build
```

The runtime gate now loads **every** `index.html` the build produced, not only the
root one: with per-route HTML, checking one page leaves every other route
unchecked, which is exactly where a route bug lives.

**A dynamic route becomes real pages when it says which ones.** Export
`static_params()` (or `generateStaticParams`) from the page's `.server.hys` and the
build renders one document per entry:

```python
# src/pages/blog/[slug].server.hys
POSTS = ["hello", "world"]

export def static_params():
    return [{"slug": p} for p in POSTS]

export def loader(event):
    return {"slug": event.params["slug"]}
```

```
[hydra] SSG: pre-rendered 4/4 static route(s) into dist/     # index + 2 posts + not-found
```

Returning `[]` means "no static instances, render per request" and is honoured —
a dashboard should not be prerendered. Not exporting it at all means the route
stays dynamic and the build names it, so a crawler that sees a shell can be
explained by reading the log.

**A page's title can come from its data.** The static `meta = {...}` dict is one
dict for the whole route, so `/blog/hello` and `/blog/world` could only ever share
a title. `metadata(event)` fixes that, with the same event the loader receives:

```python
# src/pages/blog/[slug].server.hys
export def metadata(event):
    slug = event.params["slug"]
    return {
        "title": "Post " + slug + " — Hanz",
        "canonical": "https://example.com/blog/" + slug,
        "og:title": "Post " + slug,
        "og:type": "article",
        "twitter:card": "summary_large_image",
    }
```

The key list is a fixed allowlist — `title`, `description`, `canonical`, the
`og:` set and the `twitter:` set — and every value is escaped. An unknown key is
a build error that names it, because a typo that ships silently is a page with no
title and no way to find out why. Nothing here is a template: a value from a
database cannot become markup.

**SSG is on by default for static routes.** A project with `src/pages` and a
`Router()` pre-renders every static route without any configuration. Static
means: no URL parameter, and no `rendering = "csr"` in the page.

Two ways to opt out, both without new syntax:

```python
# src/pages/dashboard.hyx — this page renders on the client only
rendering = "csr"

component Dashboard():
    ...
```

```json
// hydraconfig.json — the whole project, back to the old behaviour
{ "rendering": { "ssg": false } }
```

A **dynamic** route (`[slug]`) has no single page to build, so it is skipped and
named in the build log. That is deliberate, not a gap: SSR for dynamic routes
needs a server at request time, and the static build does not have one. The
four example projects still set `"ssg": false` — each is a single-page app
exercising the runtime, not a site with URLs a crawler would want, so
pre-rendering them would demonstrate the feature without exercising it.

If a project has `src/pages` but its `App` never calls `Router()`, nothing is
pre-rendered: with no router there is no route to pre-render, and the build says
so instead of writing empty pages.

## Metadata: `meta`

A page may declare its own `<title>` and description as a module-level dict:

```python
# src/pages/about.hyx
meta = {"title": "About — Hanz", "description": "Who writes this, and why."}

component About():
    ...
```

That is applied in two places, from one value:

- **At build time**, into the static HTML for the route: `dist/about/index.html`
  gets that `<title>` and that `<meta name="description">`, replacing the shell's.
  A page with no `meta` keeps the shell's title, and so does every route a
  project never gave one.
- **On a client-side navigation**, by `Router()`, which is what every routable
  project already renders. Navigating from `/` to `/about` sets the new title;
  navigating back restores the shell's, because a page that declares nothing
  must not inherit the title of the page before it.

Two keys, `title` and `description`. A third is a **build error naming it**, not
a value that sits in the file reaching no page: this is not a head manager, and
it is not growing into one. It is also not a hook — there is no `use_head`, and
adding one would be a second way to say the same thing.

`meta` is read from the page's SOURCE, at the same place `rendering = "csr"` is
read, and not by importing the page. The compiler emits a module-level `meta` as
a local `const`, not an export, so importing would not carry it — and a page is a
client module, so importing it during the build would run its imports in node,
across the boundary `.server.hys` exists to keep.

**Not done, deliberately:** a `title`/`description` that depends on the URL
(`/blog/hello` wanting "hello" in its title) cannot be static metadata, and this
does not pretend otherwise — a dynamic route's static shell has the app's title
and the client sets the page's after hydration. A `rendering = "csr"` page is the
same trade from the other side: it has no static HTML at all, so its title shows
up when the client mounts. There is no open-graph, twitter card, canonical or
structured-data support; those are separate promises about a page and each needs
its own verifiable statement.

## Data: `loader` and `action`

A page can have a **server half** in a file beside it — same name, `.server.hys`
instead of `.hyx`:

```
src/pages/blog/index.hyx           -> the page (client module: it renders in the browser)
src/pages/blog/index.server.hys    -> its loader and action (server module: never in the bundle)
```

```python
# src/pages/blog/index.server.hys
from "hydra/server" import env

export async def loader(event):
    return {"posts": await db.fetch_all(), "region": env("REGION", "local")}

export async def action(event):
    text = event.request.body.get("text")
    if not text:
        return {"ok": False, "reason": "empty"}
    await db.insert(text)
    return redirect("/blog?added=1")
```

```python
# src/pages/blog/index.hyx — the props ARE the loader's return value
component BlogIndex(posts: list = [], region: str = "?"):
    ...
```

`loader` runs **once per route at build time** (SSG), its result is rendered
into the HTML *and* inlined as JSON, so the client hydrates with the same values
instead of re-fetching. `action` runs when the same URL is `POST`ed.

**Why a separate file, and not `export def loader` inside the page.** A page
module is a client module: it renders in the browser and its imports end up in
the client bundle. A loader declared there could only be server-only *by
convention* — one stray `import fs` and the build breaks in a way that is hard to
read. A `.server.hys` is not reachable from the client at all, so the split is a
fact about the build rather than a rule to remember. It also means the client
bundle can never contain the loader even by accident.

`event` is one object, so the signature does not change when the framework adds a
field:

| field | is |
|---|---|
| `event.params` | dict of URL parameters (`{"slug": "hello"}`) |
| `event.url` | the path (`/blog`) |
| `event.query` | a `URLSearchParams`, so `.get("q")` |
| `event.request` | `method`, `url`, `headers`, `body` — the REAL request headers on a server render, so a cookie or an `authorization` header is readable |

A `.server.hys` with no page beside it is a **build error naming both files**,
because a loader nobody calls is almost always a typo in the filename.

Loaders **do** re-run on a client-side navigation now (0.8): a URL that was never
server-rendered fetches its data from `/__hydra/data`. See "SSR for dynamic
routes" below.

## API routes: `src/api/*.hys`

`src/api/hello.hys` answers `/api/hello`. One file is one URL, and it exports
one function per HTTP method:

```python
# src/api/hello.hys
from "hydra/server" import env

export def get(req):
    return {"ok": True, "at": env("BUILD_REGION", "local")}

export def post(req, body):
    return {"created": body["name"]}, 201
```

```bash
curl /api/hello            -> 200 {"ok": true, "at": "local"}
curl -X POST /api/hello    -> 201 {"created": "..."}
```

- `req` is the same request object an action sees (`method`, `url`, `headers`,
  `body`, `json()`, `text()`), plus `path`.
- `get(req)` takes one argument; every other method takes `(req, body)` with the
  body **already parsed** (JSON, form fields, or the raw string).
- Return a dict/string for `200`, or `(value, status)` for anything else.
  `None` is `204`. A dict with `status`/`body`/`headers` also works, which is the
  shape an `action` already returns.
- A method the file does not export is `405` with an `Allow` header listing the
  ones it does. A URL with no file is a **JSON `404`**, never `index.html`.
- `index.hys` answers `/api` itself. A **folder is a URL segment**, and the
  naming rules are the same ones the page router uses — one naming language in a
  project, not two:

```
src/api/users/index.hys     -> /api/users
src/api/users/[id].hys      -> /api/users/:id      req.params["id"]
src/api/files/[...path].hys -> /api/files/*        req.params["path"] (a list)
```

  A leading `_` is private at any level. Two files that answer the same URL —
  `users/[id].hys` and `users/[slug].hys` — are a **build error naming both**,
  because the URL shape is the same even though the printed patterns differ.
- Every error this layer produces is one envelope: `{"error": "...", "code":
  "machine_readable", "detail": {...}}`. `fail(status, data)` is the exception,
  deliberately: that body is the application's answer, not the framework's
  complaint.

`hydra dev` and `hydra preview` serve these. A `--target static` build cannot,
and says so with every dropped route named — an endpoint that builds
"successfully" and 404s in production is the failure that report prevents.

## Middleware: `src/middleware.hys`

One file, one exported `handle(req)`. It runs for every request that reaches the
API layer (`/api` and below), before routing:

```python
# src/middleware.hys
export def handle(req):
    if req.path.startswith("/api/admin"):
        return {"error": "forbidden"}, 403   # replies, and the request stops here
    req.headers["x-seen"] = "1"              # mutates; the handler sees the change
    return None                              # passes through
```

Scope is `/api` on purpose: a static file has no middleware on any host, so
running it for `/about` would make `dev` and production disagree about a page.
Returning `None` (or `undefined`, or `false`) continues; anything else is
treated as the response.

### Middleware for pages: `server.middlewarePages`

The same file can guard pages, and the reason it is opt-in is in the name of the
thing it changes: a project that already had middleware saw `/api` only, and a
release that quietly widened that would start answering requests it answered
before.

```json
{ "server": { "middlewarePages": true } }
```

With it on, middleware runs for a **page request** — a `GET`/`HEAD` whose last
segment has no file extension, and not `/api` or `/__hydra/…` — before the page
is rendered and before the dev proxy:

```python
# src/middleware.hys
from "hydra/server" import env_require, redirect, session

export def handle(req):
    if req.path.startswith("/dashboard"):
        if not session(req, env_require("SESSION_SECRET")).get("user"):
            return redirect("/login")     # 303, and the page is never rendered
    return None
```

Static files are excluded on purpose: a static host has no middleware, so a
`dist/` served by `hydra serve` must not behave differently from the same
`dist/` on a CDN.

## Cookies, sessions, and a login

Three functions in `hydra/server`, available in a loader, an action, an API
route and middleware — the four places that receive the request `event`:

| Call | Does |
|---|---|
| `cookies(event)` | read the request's cookies, write the response's |
| `session(event, secret)` | a signed, `HttpOnly` cookie carrying a small dict |
| `set_header(event, name, value)` | any response header |

```python
# src/pages/login.server.hys — the action
from "hydra/server" import env_require, redirect, session

export def action(event):
    form = event.request.body
    user = form.get("user", "")
    if not user:
        return {"error": "nama kosong"}          # rendered as the action's data
    session(event, env_require("SESSION_SECRET")).set("user", user)
    return redirect("/dashboard")                # 303 + Set-Cookie
```

```python
# src/pages/dashboard.server.hys — the guard, in the loader
from "hydra/server" import env_require, redirect, session

export def loader(event):
    s = session(event, env_require("SESSION_SECRET"))
    if not s.get("user"):
        return redirect("/login")
    return {"user": s.get("user")}
```

What this is, precisely:

- **A signed cookie, not a store.** The data is base64 in the cookie and the
  signature is HMAC-SHA256. No server memory, no id, survives a restart, works
  across instances. It is **not encrypted** — put an id, a role, a username in
  it, never a password or anything you would not hand to the visitor.
- **`HttpOnly`, `SameSite=Lax`, `Path=/` by default.** `Secure` is off so dev
  over plain HTTP works; set `{"secure": True}` in production.
- **A tampered cookie reads as an empty session, never a throw.** An attacker
  gets the logged-out branch, not a 500.
- **`secret` must be at least 16 characters**, and a short one is refused at the
  call. Read it from `.env`; a literal in the source is a secret in the repo.
- **A 5xx sends no `Set-Cookie`.** A handler that throws after calling `set`
  does not rewrite the visitor's session.
- Calling `set` twice for one session name produces ONE `Set-Cookie` (the later
  value), because two headers with the same name are not two cookies.

`cookies(event)` on its own, for anything outside a session:

```python
jar = cookies(event)
theme = jar.get("theme", "light")     # or jar["theme"] — same thing
jar.set("theme", "dark", {"maxAge": 31536000})
jar.delete("legacy")
```

`event.params`, `event.query`, `event.headers` and `event.request` are unchanged;
`event.headers` is new, and is the request's headers — the same object as
`event.request.headers`.

### `hydra build` and a guarded page

A route whose loader redirects **at build time** is not pre-rendered, and the
build says so:

```
[hydra] SSG: not pre-rendered, loader refuses at build time: /dashboard (redirect /login)
```

Before this rule, the build wrote `dist/dashboard/index.html` from the
logged-out branch, and `hydra serve` then answered `/dashboard` from that file —
a static copy of a guarded page, readable by anyone. A loader that returns
`redirect()` or `fail()` was never describing a page.


## Hooks: `src/hooks.hys`

Two functions, both optional, both running on the server for every request:

```python
# src/hooks.hys
export def on_request(event):
    print(event.id + " " + event.method + " " + event.path)   # see event.id below
    if event.path == "/maintenance":
        return redirect("/soon")
    return None

export def on_error(event, err):
    print("failed " + event.path + ": " + str(err))
    return None
```

- `on_request(event)` runs before the middleware and before routing. Its event is
  `{id, path, method, url, headers, _headers}`. Returning `redirect()` or `fail()`
  answers the request; returning nothing continues. Any other return value is
  ignored **with a line in the log**, because the usual accident is returning the
  thing you just logged.
- `on_error(event, err)` runs for a failure a handler answered itself (an API
  route, loader or action that threw) and for one that escaped to the framework's
  failure boundary. It is fire-and-forget: an async reporter is not awaited, and
  a reporter that throws is not a second failure.

`event.id` is the `X-Request-Id` the server generated for that request and echoed
to the client, so one report from a visitor maps to one line anywhere you log.

## Access log: `server.accessLog`

```json
{ "server": { "accessLog": true } }
```

One line per request, written on response `finish` — the only moment that knows
the status the response actually got:

```json
{"t":"2026-11-22T08:32:03.911Z","id":"53d37254b6e322ec","method":"GET","path":"/api/boom","status":500,"ms":2.1}
```

## CORS: `server.cors`

```json
{ "server": { "cors": { "origins": ["https://app.example.com"], "credentials": true, "maxAge": 600 } } }
```

`true` sends `*`, a string is one origin, an object is an allowlist with optional
`methods`, `headers` and `maxAge`. Two rules: an origin that is not allowed gets
**no** `Access-Control-*` header at all (which is what makes the browser refuse
it — echoing back whatever `Origin` arrived is how an allowlist becomes a welcome
mat), and `credentials: true` can never be combined with `*`, so the origin is
echoed and `Vary: Origin` is set. `OPTIONS` is answered `204` before routing,
because a browser sends it to a path that may have no handler yet.

## `.env`, and the `PUBLIC_` split

`.env` in the project root, `KEY=VALUE`, `#` comments, no interpolation and no
dependency doing it:

```bash
PUBLIC_SITE_URL=https://example.com   # inlined into the client bundle
DATABASE_URL=postgres://...           # server only
```

- `PUBLIC_*` is the only part of `.env` that reaches the browser. It is inlined
  at build time, so `process.env.PUBLIC_SITE_URL` is a literal string by the time
  the bundle runs.
- Everything else stays on the server. `env("NAME")` from `hydra/server` reads it
  in a loader, an API route, or middleware.
- **Using a non-`PUBLIC_` variable from a client file is a build error**, naming
  the variable and the file:

```
✘ [ERROR] src/lib/api.hys: STRIPE_KEY is not available in the browser. Only names
  starting with PUBLIC_ are inlined into the client bundle; STRIPE_KEY stays on
  the server. Read it in a loader (*.server.hys), an API route, or middleware —
  or rename it to PUBLIC_STRIPE_KEY if the value really is public.
```

  The rule covers every module reachable from the entry, `.hys` included — a
  `.hyx`-only check would miss the case a secret actually leaks through.
- A computed key (`process.env[name]`) is also refused: it cannot be checked or
  inlined, so it would be a silent `undefined` in the browser.
- A variable already set in the real environment wins over `.env`, so a deploy's
  secrets are never overridden by a file that shipped in the tarball.

## Caching: `revalidate(event, seconds)`

A loader asks for a cache lifetime; the server decides whether to grant it:

```python
# src/pages/blog/[slug].server.hys
from "hydra/server" import revalidate

export def loader(event):
    revalidate(event, 60)          # a minute
    return {"post": find_post(event.params["slug"])}
```

What happens when it is granted (`--target node`):

- The rendered HTML is kept in-process for that many seconds, so the **loader
  does not run again** while the entry is fresh.
- The answer carries
  `Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=60`, so
  a CDN in front of the server can serve it too.
- An `ETag` over the body is sent, and `If-None-Match` is answered `304` with no
  body. This is also true for a page that did NOT ask for caching: the tag is
  cheap and a 304 saves the transfer.

**The rule that makes it safe:** an entry is only stored when the request carried
no `Cookie` header. A page rendered for a signed-in visitor must never be handed
to the next one, and "the loader checked" is not a guarantee a cache can be built
on — so the check is the framework's. `revalidate(event, 0)` is the default and
means no caching.

Two limits, stated rather than discovered:

- A cached page is **not streamed** (a cache entry needs the whole body before
  the first byte). A page that calls `revalidate()` therefore waits for its full
  render; that is the trade for not running the loader again.
- The cache is per process and bounded (200 entries). It is not shared between
  instances — put a CDN in front, or a real store behind, when that matters.

`rendering.ssg` still governs files: with `{"ssg": false}` nothing is pre-rendered
and every route goes through the path above.

## Architecture rules: `architecture`

```json
{ "architecture": {
    "layers": { "ui": "./src/pages", "data": "./src/db" },
    "rules": ["ui -/-> data"]
} }
```

`-/->` is enforced by the BUILD, before anything is compiled, and fails it naming
both files:

```
Error: [hydra] architecture rule violated (1):
  src/pages/leak.hyx
    imports src/db/db.hys
    which the rule "ui -/-> data" forbids
```

`->` is documentation: only forbidden edges are checked, because an allowlist
would have to mean "everything else is forbidden", which is a bigger promise
than this makes. The import scan is line-based — an import is one line in this
language — so a *computed* specifier is a false negative, never a false positive.

## Strings: `t()` and `i18n.catalog`

```python
from "hydra" import t

h1: t("nav.home", "Home")
```

Every `t("key")` in `.hyx`/`.hys` is extracted at build time and written to
`dist/.hydra-i18n.json` (`{keys, usedIn}`). Declare a catalog and the missing
side becomes a build error:

```json
{ "i18n": { "catalog": "./i18n/id.json" } }
```

```
[hydra] i18n: 1 key(s) used in source are missing from ./i18n/id.json:
  nav.home
```

At runtime the catalog is `globalThis.__hydra_i18n`, or whatever `set_i18n()`
was given. A missing key renders the `default` argument, then the key itself —
never a thrown error in the middle of a render.

## Dead code and links

Two more build-time checks, both warnings:

```
[hydra] links: 32 internal reference(s), all resolve
[hydra] dead code: 1 component(s) nothing imports: src/components/Unused.hyx
```

An entry file and `_404`/`_error`/`_layout` are excluded by definition (the HTML
and the router reach them, not an import), because one false positive is enough
for a check to be switched off.

## Testing routes: `hydra test --routes`

Every route with a loader gets five assertions nobody writes by hand:

```
$ hydra test --routes
  ok   /about                       0 ms
  ok   /dashboard                   1 ms
  FAIL /blog/[slug]                 threw: post not found
[hydra] route tests: 2/3 loader(s) ok
```

For each loader: it does not throw, its result is JSON-serializable, a
`redirect()` has a destination and a 3xx status, and a `fail()` carries a real
status. `.env` is loaded first, exactly as a build or a server would, so a loader
that needs a secret fails here for the reason it would fail in production.

`hydra test --routes /dashboard` runs one route. This does not render anything —
a loader whose shape the page cannot render passes here and is caught by the
runtime gate, which is the other half.

## End-to-end smoke test

`node scripts/e2e-smoke.mjs <project-dir>` builds the project twice (static and
node), serves it, and asks for 28 things over HTTP: routing, a login that sets a
session and a guard that reads it, the cache (s-maxage, ETag, 304, and a request
with a cookie never being cached), page middleware, the `on_request` header, a
throwing handler answering 500 with `on_error` firing, CORS with a disallowed
origin, `robots.txt`/`sitemap.xml`, and one access-log line per request. It needs
a project with `react` installed; the expectations are listed at the top of the
script.

## Why is this page like this: `hydra explain`

```
$ hydra explain /blog/hello
/blog/hello
  file      : src/pages/blog/[slug].hyx
  server    : src/pages/blog/[slug].server.hys
  rendering : server-rendered per request
  params    : slug
  cache     : decided by the loader at request time (revalidate(event, seconds))
  chunk     : [slug]-GSKVRUUD.js (0.4 KB)
```

No argument prints every route. The answer comes from the route table and the
last build's metafile, so it describes the build that exists rather than the one
the documentation imagines.

## Navigation: prefetch and scroll memory

`Link` warms a route's loader payload on hover and on focus (`prefetch=False`
turns that off), so the round trip to `/__hydra/data` has already happened by the
time the click lands. `prefetch_route(to)` does the same thing from a handler.

Going back to a page returns to where you left it. Each navigation records the
scroll position in `sessionStorage`, keyed by pathname, and restores it two
frames after the render; a page you have not visited starts at the top. Query
strings are deliberately not part of the key: a filter change is the same page,
and jumping into the middle of a new list is worse than starting at the top.

## Budgets, accessibility, and `hydra migrate`

```json
{
  "budget": { "entry": 80, "total": 400, "chunks": 12 },
  "a11y": "warn"
}
```

**`budget`** fails the BUILD (not a separate command) when the client bundle
outgrows the numbers, and prints the figure next to the limit:

```
[hydra] budget: entry 2 KB, js 235.5 KB across 10 chunk(s)
Error: [hydra] bundle budget exceeded:
  entry chunk is 2 KB, over the 1 KB budget
  chunk count is 10, over the 1 budget
```

`entry` and `total` are KB, `chunks` is a count. A budget that only fails when
someone remembers to run a second command is a budget that drifts.

**`a11y`** runs a small, dependency-free set of accessibility rules in the same
browser the runtime gate already opens: `html-lang`, `img-alt`, `control-name`,
`input-label`, `duplicate-id`, `tabindex-positive`. `warn` (the default) prints
them and passes; `error` fails the build; `off` skips the probe. The set is a
floor chosen so a finding is always certain — there is no colour-contrast
heuristic here, and the list is in `packages/cli/runtime-gate.mjs` next to the
code that implements it.

**`hydra migrate <from> <to>`** applies registered codemods to a project's `.hyx`
and `.hys` files. The registry is empty today and the command says so:

```
[hydra] no codemods registered for 0.15 → 0.16 — nothing to rewrite
```

- `hydra migrate --list` prints what is registered.
- `--dry-run` reports what would change without writing.
- A version step compares `major.minor`; a patch release never carries a codemod.
- Every codemod must be pure and idempotent, because the second run is what
  happens when somebody is not sure whether they already ran it.

## `sitemap.xml` and `robots.txt`

Declare the site's absolute URL and the build writes both:

```json
{ "site": "https://example.com" }
```

```
[hydra] sitemap: 12 URL(s) from 12 written page(s)
```

- The list is **what the build actually wrote**, not what the route table
  contains. A dynamic route without `static_params`, a `csr` route, and a guarded
  page whose loader redirected at build time are all absent, because none of them
  is a file a crawler can fetch.
- `robots.txt` is written only when the project has not written one. A project
  that blocked a path on purpose keeps its file.
- No `site`, no files. A sitemap full of `http://localhost/...` is worse than
  none, because a crawler believes it.

One caveat that belongs here rather than in a footnote: with
`server.middlewarePages` on and `--target static`, the middleware is **dropped**
(the build says so). A page that only middleware was guarding is therefore
readable on a static host. Mark such a page `rendering = "ssr"` for the route, or
deploy with `--target node`.

## `hydra build --target node|static`

Two targets, and the list is closed.

| target | contains |
|---|---|
| `static` (default) | HTML, JS, CSS. `src/api` and middleware are **not** served |
| `node` | the same client build, plus the API routes, middleware, loaders and actions that `hydra serve` answers from |

`static` is the default because it is what every release before this one
produced; switching the default would turn a deployed API into a 404 for anyone
who upgrades without reading the changelog. An adapter per host is a maintenance
cost with no reader yet, so there are deliberately no presets.

## SSR for dynamic routes

A route with a parameter has no single URL, so the static build cannot write one
file for it. `hydra dev` and `hydra preview` render those routes **per
request** from the same server bundle the build produces:

```
GET /blog/hello   ->  a full page, server-rendered, with the loader's data
GET /blog/world   ->  a full page with ITS data, not hello's
```

Two rules keep that honest, and both come from the runtime having one
module-global seed:

1. **Loading and rendering are separate calls**, and nothing may `await` between
   the render and `renderToString`. Otherwise two concurrent requests interleave
   and the second page renders with the first one's props.
2. **Identity is the full URL.** `/blog/a` and `/blog/b` match the same pattern,
   so the inlined payload carries `url` as well as `pattern`, and the client only
   trusts a payload for the URL it is rendering.

`GET /__hydra/data?url=/blog/hello` runs a loader on demand. That is what a
client-side navigation uses: the route was never server-rendered, so there is no
inlined payload, and the page fetches. A loader that throws is a `500` with its
message — never an empty data object, because "no items" and "the request
failed" look identical in a UI and mean different things.

**On a purely static deploy the endpoint does not exist.** The page then reports
`status: "error"` rather than pretending the data is empty; `use_loader` returns
`{data, status, error}` and a page that ignores it is unaffected.

## `hydra test`

```
hydra test                 # every *.test.hys under tests/, src/ or the root
hydra test path/to/x.test.hys
SNAP_UPDATE=1 hydra test   # accept snapshot changes
```

```python
# tests/card.test.hys
from "hydra/test" import test, expect, render, snapshot
from "../src/Card.hyx" import Card

def renders_the_title():
    expect(render(Card, {"title": "hi"})).to_contain("hi")

def the_whole_card():
    snapshot("card", render(Card, {"title": "s"}))

test("renders the title", renders_the_title)
test("the whole card", the_whole_card)
```

A `.test.hyx` may call `render(Card(title="hi"))` directly; in a `.hys` the props
go in a dict, because a `.hys` call with keyword arguments has no signature to
read for an imported component.

Each file is bundled with the same resolver and plugins the build uses and run
in **its own process**, so a global left behind by one file cannot affect the
next. A snapshot is written on first run and compared after that; a change is a
**failure**, not a silent rewrite.

## `hydra lsp`

```
hydra lsp        # JSON-RPC over stdio, LSP 3.17
```

What it does: `initialize`/`shutdown`/`exit` with real `Content-Length` framing,
`publishDiagnostics` from the **compiler's own** check (via `hydra check --json -`,
so the server cannot disagree with the build), hover, go-to-definition.

- **Rename** is a WorkspaceEdit across files: the declaration and every relative
  importer change together, because a rename that touches one of them leaves the
  other's import naming something the module no longer exports. `prepareRename`
  is implemented, so the editor refuses a position with nothing under it. A
  **package** import is refused with the reason — that declaration belongs to
  someone else.
- **Completion** offers the file's own names and imports, the Python builtins the
  compiler lowers (read from `check.rs`, so the list cannot drift), a module's real
  exports after `from "x" import `, and the methods of a list/dict/string literal
  after a dot. It is not a type checker: a completion it cannot justify is one it
  does not offer.
- **Signature help** names the parameters and the active argument, from the
  callable's own declaration — in this file, or in a relative import it resolves.
  It answers with nothing rather than a guess when there is no source to read.

What it does **not** do, said plainly rather than implied: formatting (use
`hydra fmt`), semantic tokens, code actions, workspace symbols. An unimplemented
request gets `method not found` rather than silence.

## Incremental and parallel builds

Compiled modules are cached on disk under `.hydra/cache/`, keyed by
`sha256(source, compiler version, filename)`. Content-addressed, so a changed
file is a different key by construction, and a compiler upgrade is a miss rather
than a stale hit. A second build of an untouched project compiles nothing and
says so:

```
[hydra] compile cache: 8 reused, 0 compiled
```

`HYDRA_NO_CACHE=1`, or `"build": {"cache": false}`, turns it off.

**Parallel compilation is implemented, tested, and off below scale — because it
was measured.** `benchmarks/compile.mjs` on a 2-vCPU box, 120 files:

| | time |
|---|---|
| serial, cold | 47 ms (0.39 ms/file) |
| cache, cold | 91 ms (first run; it writes) |
| cache, warm | 1 ms (120/120 hits) |
| worker pool | 124 ms |

The compiler is fast enough per file that a `worker_threads` pool spends more on
startup and a second copy of the addon than it saves. `shouldPool` is that
measured threshold, so the pool runs on a project large enough for it to pay
(roughly 5,000 files at this speed) and is a no-op otherwise.

Build output: `dist/index.html`, `dist/assets/index-<hash>.js`, `dist/assets/index.css`,
plus chunks for dynamic `import()`.

---
