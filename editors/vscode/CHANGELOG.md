# Changelog

## 0.2.0

The extension stops being a syntax file with a `check` call bolted on.

- **Real language server.** `hydra lsp` is started over stdio and used for
  diagnostics, hover, go-to-definition, cross-file rename, completion and
  signature help. `hydra check --json` is kept only as the fallback for a
  workspace where the server cannot start, so a squiggle does not disappear
  because a process did.
- **No npm dependencies.** The `Content-Length` framing is `src/lsp-client.js`;
  `vscode-languageclient` is not vendored, so the .vsix stays a handful of files.
- **Commands** for the project: dev, build, serve, preview, routes, check,
  format, doctor, stats, list, test, `explain`, restart-server, show-log.
- **Scaffolds** that follow the conventions: page, component, page server half,
  API route, API middleware. Every one is checked against the compiler by the
  test suite, and each reports the URL it creates.
- **Snippets** for `component`, pages, loaders, actions, API routes, middleware,
  `slot`, loops with `key=`, hooks. All of them are parsed by the compiler in CI.
- **`hydraconfig.json`** validation against the schema the compiler ships.
- **Grammar:** specifier strings (`from "hydra/server" import …`), triple-quoted
  strings, f-string interpolation, `slot`, the lowered builtins, call names,
  properties after `.`, and numbers with `_`/hex/exponents.
- **Language configuration:** folding markers, colourised brackets, indent rules
  for `component`/`async def`/`match`, and 4-space tabs per language.
- **Removed:** the `hsx`/`hs`/`hx` aliases and the bundled native binary. The
  language is two extensions, `.hyx` and `.hys`; the runner is what the editor
  starts.

## 0.1.0

Syntax highlighting and `hydra check --json` diagnostics on open and save.
