# HydraScript for VS Code

Language support for `.hyx` (Hydra XML) and `.hys` (Hydra Script), built on the
compiler the project already ships: the extension starts `hydra lsp` and maps its
replies onto the editor. There is no second parser here, so the editor cannot
disagree with the build.

## What you get

- **Diagnostics** from the compiler's own parser and semantic checker, as you
  type. Not a reimplementation — the same messages `hydra build` prints.
- **Hover** on a name: the declaration, the source line, where it lives.
- **Go to definition**, including a jump to a relative import's file.
- **Rename** an identifier — and it refuses, with a reason, when it cannot do it
  completely (a package import, a key in an object literal), because a
  half-rename is worse than none.
- **Completion** of the file's own names, its imports, the module's real exports
  after `from "x" import `, the Python builtins the compiler *lowers*, and the
  methods of a list/dict/string literal after `.`.
- **Signature help** for a callable declared in this file or a relative import.
- **Snippets** for the syntax that is easy to get wrong: `component`, pages,
  loaders, actions, API routes, middleware, `slot`, `for` with `key=`.
- **Syntax highlighting** for Hydra XML tags and attributes, specifier strings,
  f-string interpolation, and the builtins that actually exist at runtime.
- **Commands** for the project's CLI: dev, build, serve, preview, routes, check,
  fmt, doctor, stats, tests, `hydra explain`.
- **Scaffolds** that follow the file conventions: *New Page*, *New Component*,
  *New Page Server Half*, *New API Route*, *New API Middleware*. Each one knows
  its URL — `src/api/users/[id].hys` answers `/api/users/:id` — and tells you.
- **`hydraconfig.json`** validation and completion, from the compiler's own
  `schema.json`.

## Requirements

- The `hydra` CLI. It is found in this order: `hydra.compilerPath`, the
  `HYDRA_COMPILER` environment variable, the extension's own `bin/`, the
  workspace's `node_modules/hydrascript` or `bin/`, a `cargo build` output, then
  `PATH`.
- The CLI must be the **node runner** (`bin/hydra.js`), because `lsp` lives
  there. A bare native `bin/hydra` has `check`/`fmt` but no language server, and
  the extension says so in its log and falls back to running `check` on save.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `hydra.compilerPath` | `""` | Path to the CLI, when discovery is not enough. |
| `hydra.languageServer.enable` | `true` | Start `hydra lsp`. |
| `hydra.languageServer.trace` | `false` | Log every protocol message to the *HydraScript* channel. |
| `hydra.checkOnSave` | `true` | With the server **not** running, run `check` on save. |

## Install

From a checkout:

```bash
node editors/vscode/scripts/package-vsix.mjs
code --install-extension dist/hydrascript-0.2.0.vsix
```

Or press F5 in this folder to run it as a development extension.

## Tests

```bash
node --test editors/vscode/test/*.test.mjs
```

The suite drives the **real** `hydra lsp` — initialize, diagnostics, hover,
definition, rename, completion, signature help — and parses every scaffold and
every snippet with the compiler. Nothing in it asserts against a hand-written
idea of what the compiler answers.

## What this does not do

Formatting is `hydra fmt`, exposed as a command rather than as a document
formatter: the formatter rewrites files on disk, and pretending it is a
range-formatter would be a lie about how it works. There are no semantic tokens
and no code actions, because `hydra lsp` does not advertise them; a half-working
one would be presented to you as working.
