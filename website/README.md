<!-- [xihanzu-NR] -->
# hydrascript.dev — the website

The project's own site, written in the language it documents. Five routes, no
dependencies beyond React: the styling is one hand-written stylesheet, because a
site whose pitch is "no hidden machinery" should not need a plugin to look right.

## Layout

```
src/
├─ main.hyx              mount(App, #root)
├─ App.hyx               renders Router()
├─ index.css             the whole design system, no Tailwind
├─ lib/nav.hys           pure helpers: active-link logic
├─ components/
│  └─ Code.hyx           code block + copy button
└─ pages/
   ├─ _layout.hyx        header, nav, footer
   ├─ _404.hyx           404
   ├─ index.hyx          /
   └─ docs/
      ├─ _layout.hyx     sidebar + repository rail
      ├─ index.hyx       /docs
      ├─ syntax.hyx      /docs/syntax
      ├─ routing.hyx     /docs/routing
      └─ cli.hyx         /docs/cli
```

Routes come from the folder, so `hydra routes` is the real table:

```
/              static   src/pages/index.hyx
/docs          static   src/pages/docs/index.hyx
/docs/syntax   static   src/pages/docs/syntax.hyx
/docs/routing  static   src/pages/docs/routing.hyx
/docs/cli      static   src/pages/docs/cli.hyx
```

## Build

```bash
npm install          # links hydrascript from the parent directory
npm run dev          # http://127.0.0.1:5173
npm run build        # pre-renders all five routes into dist/
npm run preview      # serves the built site
```

The build pre-renders every route to its own HTML file and writes `404.html` for
static hosts. `dist/` is a plain directory: upload it, or point a static host at
it. There is no server half — no API routes, no loaders — so `--target=static`
(the default) is the whole story.

## Editing rules

- Text lives in `pages/*.hyx`, not in components. A component takes props and
  renders them; a page holds the prose and the data lists.
- Data lists are lists of tuples, read in a `for` loop with index access
  (`item[0]`, `item[1]`). Tuple unpacking in a tree `for` does not do what it
  looks like it does.
- No new syntax: if a page needs a shape the language cannot express, change the
  page, not the compiler.
