#!/usr/bin/env bash
# [xihanzu-NR]
#
# End-to-end check of the thing that gets published: pack the tarball, install it
# into a clean project, and build a scaffolded app with it.
#
# Why this exists: everything else in CI tests the REPOSITORY. What a user
# receives is the TARBALL, and the two differ in ways that fail silently —
# a missing entry in `files`, a `bin` path that is not executable, a binary the
# tarball forgot, a `vite-plugin` that resolves the compiler relative to a
# directory that is not shipped. Every one of those passes every unit test and
# breaks on install.
#
# Network is required: the scaffolded app installs React. That is the point —
# it exercises the same path a user takes.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
FAILED=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

cd "$REPO"

say "== pack =="
TARBALL="$(npm pack --pack-destination "$WORK" 2>/dev/null | tail -1)"
[ -f "$WORK/$TARBALL" ] || { bad "npm pack produced no tarball"; exit 1; }
ok "packed $TARBALL ($(du -h "$WORK/$TARBALL" | cut -f1))"

# The tarball must contain the compiler binary and the runtime. These are the two
# things a user cannot get from the registry any other way on linux-x64.
say "== tarball contents =="
LIST="$(tar -tzf "$WORK/$TARBALL")"
for need in package/bin/hydra package/bin/hydra.js package/bin/hydra.node \
            package/runtime/hydra.ts package/packages/cli/runner.mjs \
            package/packages/cli/esbuild-plugin.mjs package/vite-plugin/index.js; do
  case "$LIST" in
    *"$need"*) ok "contains $need" ;;
    *)         bad "MISSING $need" ;;
  esac
done

# The compiler SOURCE is deliberately excluded: it is not needed to run the
# shipped binaries and it doubled the tarball. Assert that it stays out.
case "$LIST" in
  *package/compiler-rs/src/*) bad "compiler-rs/src is back in the tarball (it is excluded on purpose)" ;;
  *)                          ok "no compiler-rs source (excluded on purpose)" ;;
esac

# A private copy of the binary inside vite-plugin/ would be a second copy that
# can lag behind the real compiler.
case "$LIST" in
  *package/vite-plugin/bin/*) bad "vite-plugin ships its own binary again" ;;
  *)                          ok "vite-plugin ships no private binary" ;;
esac

say "== install into a clean project =="
mkdir -p "$WORK/user"
cd "$WORK/user"
printf '{"name":"user","private":true}\n' > package.json
if npm install "$WORK/$TARBALL" --no-audit --no-fund >/dev/null 2>&1; then
  ok "installed"
else
  bad "npm install failed"
  exit 1
fi

VER="$(./node_modules/.bin/hydra --version 2>&1 | head -1)"
case "$VER" in
  "hydra 0.3.0"*) ok "bin works: $VER" ;;
  *)              bad "bin does not report a version: $VER" ;;
esac

say "== scaffold and build a real app =="
if ./node_modules/.bin/hydra init app >/dev/null 2>&1; then
  ok "hydra init"
else
  bad "hydra init failed"
fi

cd app
if npm install --no-audit --no-fund >/dev/null 2>&1; then
  ok "npm install (app deps)"
else
  bad "npm install in the scaffolded app failed"
fi

# The scaffold deliberately does NOT depend on `hydrascript` (the toolchain is the
# `hydra` command, not a package the app pulls in), so there is no local bin here.
# Use the one installed into the parent project, which is the package under test.
HYDRA="../node_modules/.bin/hydra"
[ -x "$HYDRA" ] || { bad "the installed bin disappeared"; exit 1; }

OUT="$($HYDRA build 2>&1)"
if printf '%s' "$OUT" | grep -q "Built successfully"; then
  ok "hydra build: $(printf '%s' "$OUT" | grep -o 'Built successfully in [0-9]*ms')"
else
  bad "hydra build did not report success:"
  printf '%s\n' "$OUT" | sed 's/^/       /' | head -12
fi

if [ -f dist/index.html ] && grep -q '<script' dist/index.html; then
  ok "dist/index.html references a bundle"
else
  bad "dist/index.html missing or has no script tag"
fi

# The runtime gate is on by default for a production build; a clean scaffold must
# pass it. If it reported an exception, the scaffold is shipping broken output.
if printf '%s' "$OUT" | grep -q "runtime gate passed"; then
  ok "runtime gate passed on a freshly scaffolded app"
elif printf '%s' "$OUT" | grep -q "runtime gate"; then
  bad "runtime gate reported a problem:"
  printf '%s\n' "$OUT" | grep -A 3 "runtime gate" | sed 's/^/       /'
else
  ok "runtime gate skipped (no Chrome) — not a failure"
fi

say ""
if [ "$FAILED" -eq 0 ]; then
  say "pack/install: PASS"
else
  say "pack/install: FAILED"
fi
exit "$FAILED"
