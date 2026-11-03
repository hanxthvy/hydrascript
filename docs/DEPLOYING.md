# Deploying a HydraScript project

`hydra build --target node` produces one deployable directory, and `hydra serve`
runs it. This file is the contract between the two: what the artifact contains,
what it needs beside it, and what it answers.

## The short version

```bash
hydra build --target node     # writes dist/ and .hydra/
hydra serve --port 3000       # answers pages, dynamic routes, /api and actions
```

`hydra serve` is the same server `hydra preview` uses, with one difference that
matters in a deployment: **it refuses to start when the server half is missing**
instead of serving an empty shell to every crawler. `hydra start` is an alias,
because that is what an npm script or a platform start command is usually called.

## What the artifact is

| Path | Contains | Committed? |
|---|---|---|
| `dist/` | HTML (one file per static route), `404.html`, `assets/index-<hash>.js`, `assets/index-<hash>.css`, per-route chunks under `assets/chunks/`, everything from `public/` | no |
| `.hydra/server.cjs` | the server bundle: loaders, layouts, `renderSync`, `renderNotFound` | no |
| `.hydra/api.cjs` | `src/api/*.hys` and `src/middleware.hys`, one module | no |
| `.hydra/actions.cjs` | every `action` and `loader`, keyed by route pattern | no |
| `.hydra/build.json` | what the build was: target, mode, API routes, dynamic routes | no |

Both directories are derived. `.gitignore` covers them, and `hydra build`
removes `dist/` before writing so a route deleted from the source stops being
served.

## What the deployment needs

Three things, and `hydra serve` says which one is missing rather than failing
later:

1. `dist/`
2. `.hydra/` (built by the same command, next to `dist/`)
3. `node_modules/` with `react` and `react-dom` — the server bundle requires them
   at runtime, the same way the client bundle expects them in the browser.

A `.env` is optional. Real environment variables win over it, so a platform's
secret store is never overridden by a file that shipped in the image.

## Docker

```dockerfile
# Build stage: needs the compiler and the project's dependencies.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx hydrascript build --target node

# Runtime stage: no compiler, no source, no dev dependencies.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/.hydra ./.hydra
COPY --from=build /app/hydraconfig.json ./hydraconfig.json
# react and react-dom are the whole runtime dependency of the server bundle.
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
EXPOSE 3000
CMD ["npx", "hydrascript", "serve", "--host", "0.0.0.0", "--port", "3000"]
```

`--host 0.0.0.0` is deliberate and is NOT the default: a bind address is a
reachability decision, and the default stays loopback so a laptop on cafe wifi is
not serving the project to the room.

## Static hosts

`--target static` (the default) writes no server half. Deploy `dist/` to any
static host and:

- every static route has its own `index.html`, so a crawler gets content;
- `404.html` is written when the project has a `_404.hyx`, which Netlify,
  Cloudflare Pages and GitHub Pages all serve automatically;
- dynamic routes (`[slug]`) are listed in the build log and are **not**
  pre-rendered — they need `--target node`;
- `src/api` and `src/middleware.hys` are dropped, and the build prints every
  route it dropped rather than 404-ing quietly in production.

## Environment variables

| Name | Effect |
|---|---|
| `PUBLIC_*` | inlined into the client bundle at build time. The only prefix the browser may see. |
| anything else | server only, read with `env("NAME")` from `hydra/server` in a loader, action, API route or middleware. Reading one from a client file is a **build error** naming it. |
| `HYDRA_NO_GATE=1` | skip the headless-Chrome runtime gate for one build |
| `HYDRA_NO_SSG=1` | skip pre-rendering for one build |
| `HYDRA_GATE_PAGES=N` | how many built pages the gate checks (default 25) |
| `HYDRA_GATE_SETTLE_MS=N` | how long the gate waits before judging a page (default 900) |

`.env`, `.env.<mode>`, `.env.local` and `.env.<mode>.local` are all read, in that
order of precedence, so the file layout people already know behaves as expected.
All four are gitignored.

## Reaching the server

| Path | Answer |
|---|---|
| a static route | its pre-rendered HTML, from `dist/` |
| a dynamic route | rendered per request by `.hydra/server.cjs`, with the real headers and the full URL |
| a route marked `rendering = "ssr"` | rendered per request, never pre-rendered |
| a URL nothing matches | the project's `_404`, with status **404** |
| `/api/...` | the matching handler in `src/api`, or JSON 404 — never `index.html`. A folder is a URL segment: `/api/users/[id].hys` answers `/api/users/42` with `req.params.id === "42"`, and `[...rest].hys` gives a list |
| `/__hydra/data?url=...` | the loader's result as JSON, used by a client navigation |
| a missing file with an extension | 404, never the SPA shell |
| `.hydra-build.json`, any dotfile | 404 |

## Response headers

Every answer carries `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN` and a
`Permissions-Policy` that denies camera, microphone and geolocation.

| Response | Cache-Control |
|---|---|
| `assets/index-<hash>.js`, `assets/index-<hash>.css` | `public, max-age=31536000, immutable` — the name changes when the bytes do |
| any other `.html` | `no-cache` (revalidate; it names the hashed assets) |
| a server-rendered route | `no-store` (two visitors can get different pages) |
| anything else | `public, max-age=3600` |

Text responses are gzipped when the client sends `Accept-Encoding: gzip` and the
body is over 1 KB — a 143 KB entry chunk goes out as 44 KB. Images, fonts and
video are not re-compressed.

```json
{
  "server": {
    "bodyLimit": 2097152,
    "headers": { "Content-Security-Policy": "default-src 'self'" }
  }
}
```

A cross-origin `POST` to a route with an `action` is refused with 403. A request
with no `Origin` header (curl, a test, a server-to-server call) is allowed: the
guard exists for the browser case, which is the one that carries a victim's
cookies.

## What a loader can see

```python
# src/pages/dashboard.server.hys
export async def loader(event):
    token = event.request.headers.get("authorization")
    if not token:
        return redirect("/login")      # a real 303 + Location, not a 200 page
    return {"user": await whoami(token)}
```

`event` carries `params`, `url` (the full URL, query included), `path`, `query`
(with `.get()`), and `request` (`method`, `url`, `headers`, `body`,
`body_error`). `redirect()` and `fail(status, data)` are honoured by loaders,
actions and API routes alike — the same two helpers, read the same way, so an
endpoint cannot disagree with a page about what a redirect means.

## Installing on a platform the tarball was not built for

`bin/hydra.js` resolves the native compiler in this order: `HYDRA_BINARY`, then
`@hydrascript/<platform>-<arch>[-musl]` from `optionalDependencies`, then the
binary beside itself. `.github/workflows/binaries.yml` builds and publishes one
package per target — linux x64/arm64 on glibc and musl, darwin x64/arm64,
win32 x64 — so npm installs exactly the one your machine needs and skips the
rest.

If none is present the launcher says which triple it looked for and the two ways
to get one:

```
[hydra] no native compiler for this machine (linux-x64).

  expected either @hydrascript/linux-x64 in node_modules,
  or a binary at .../bin/hydra.

  fixes:
    npm i @hydrascript/linux-x64          # the prebuilt one
    npm run build:compiler              # from a source checkout (needs Rust)
  or point HYDRA_BINARY at one you already have.
```

A Linux binary is linked against the glibc of the runner that built it, which is
why the workflow pins the oldest LTS (`ubuntu-22.04`, glibc 2.35) rather than
`ubuntu-latest`. Older distros use the `-musl` builds, which are what Alpine
needs anyway.

## Known limits

- One process, one core. Put it behind a supervisor or a platform that runs
  several instances; there is no cluster mode.
- No streaming SSR: `renderToString` runs to completion before the response is
  written. A slow loader is a slow TTFB, in full.
- No ISR or cache revalidation. A loader runs per request; caching is the
  project's decision, not the framework's.
- No `ETag` and no conditional requests: a cached HTML document revalidates by
  refetching it, not with a 304. Compression and `Cache-Control` ARE handled
  (see below), so a proxy in front is an optimisation rather than a requirement.
- CSP is not set. `server.headers` in `hydraconfig.json` is where a project puts
  its own policy, because a correct one depends on what that project loads.
