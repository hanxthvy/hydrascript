#!/usr/bin/env bash
# [xihanzu-NR]
#
# hx-examples-check.sh — build every HydraScript example in examples/*/ and
# report exactly what passed and what failed.
#
# For each examples/<name>/ that contains a hydraconfig.json this script:
#   1. removes any stale dist/ so a previous run cannot mask a failure
#   2. runs the REPO toolchain:  hydra build
#   3. records the exit code, and on failure keeps the first 30 lines of output
#   4. on success verifies dist/index.html exists AND that every JS asset the
#      HTML references actually exists on disk
#   5. prints one PASS/FAIL summary line per example
#
# Full transcript goes to /tmp/hx-examples.log. Exits non-zero if any example
# failed. Exit codes 137/143 from the build are reported as OOM/SIGKILL rather
# than as a compiler error, because that is what they actually are.

set -uo pipefail

HYDRA_REPO="${HYDRA_REPO:-/root/projects/hydra}"
HYDRA_BIN="${HYDRA_BIN:-$HYDRA_REPO/compiler-rs/target/release/hydra}"
HYDRA_RUNNER="${HYDRA_RUNNER:-$HYDRA_REPO/packages/cli/runner.mjs}"
EXAMPLES_DIR="${EXAMPLES_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/examples}"
LOG="${HX_LOG:-/tmp/hx-examples.log}"
BUILD_TIMEOUT="${HYDRA_BUILD_TIMEOUT:-300}"

TOTAL=0
PASSED=0
FAILED=0
FAILED_NAMES=()

: > "$LOG"

# Everything written with log() lands in the transcript file.
log() { printf '%s\n' "$*" >>"$LOG"; }
# say() is for the operator's terminal (and also recorded).
say() { printf '%s\n' "$*"; log "$*"; }

say "hx-examples-check"
say "  toolchain : $HYDRA_BIN"
say "  runner    : $HYDRA_RUNNER"
say "  examples  : $EXAMPLES_DIR"
say "  log       : $LOG"
say ""

if [[ ! -x "$HYDRA_BIN" ]]; then
  say "FATAL: hydra binary not found or not executable: $HYDRA_BIN"
  exit 2
fi
if [[ ! -f "$HYDRA_RUNNER" ]]; then
  say "FATAL: runner not found: $HYDRA_RUNNER"
  exit 2
fi
if [[ ! -d "$EXAMPLES_DIR" ]]; then
  say "FATAL: examples directory not found: $EXAMPLES_DIR"
  exit 2
fi

# Classify a non-zero build exit code.
classify_exit() {
  case "$1" in
    124) echo "timed out after ${BUILD_TIMEOUT}s" ;;
    137) echo "killed by SIGKILL (exit 137 — out of memory / OOM killer)" ;;
    143) echo "killed by SIGTERM (exit 143)" ;;
    *)   echo "build failed (exit $1)" ;;
  esac
}

# Verify every JS file the built HTML references exists on disk.
# Prints "ok <n>" or "missing <path>" on the first missing asset.
check_assets() {
  local dist="$1"
  local html="$dist/index.html"
  local count=0
  local ref path file

  # Match both src="..." and href="..." pointing at a .js/.mjs file.
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    case "$ref" in
      http://*|https://*|//*) continue ;;
    esac
    if [[ "$ref" == /* ]]; then
      file="$dist/${ref#/}"
    else
      file="$(dirname "$html")/$ref"
    fi
    if [[ ! -f "$file" ]]; then
      echo "missing $ref"
      return 1
    fi
    count=$((count + 1))
  done < <(grep -oE '(src|href)="[^"]+\.(js|mjs)"' "$html" 2>/dev/null | sed -E 's/^(src|href)="//; s/"$//')

  echo "ok $count"
  return 0
}

for dir in "$EXAMPLES_DIR"/*/; do
  [[ -d "$dir" ]] || continue
  name="$(basename "$dir")"
  cfg="$dir/hydraconfig.json"
  [[ -f "$cfg" ]] || continue

  TOTAL=$((TOTAL + 1))
  pkg_note=""
  [[ -d "$dir/node_modules" ]] || pkg_note=" (no node_modules!)"

  log ""
  log "================================================================"
  log "== $name$pkg_note"
  log "================================================================"

  # Stale output would let a failing build look like a passing one.
  rm -rf "$dir/dist"

  out="$(mktemp)"
  start_ms=$(date +%s%3N)
  (
    cd "$dir" || exit 2
    HYDRA_RUNNER="$HYDRA_RUNNER" timeout "$BUILD_TIMEOUT" "$HYDRA_BIN" build
  ) >"$out" 2>&1
  code=$?
  end_ms=$(date +%s%3N)
  elapsed=$(( (end_ms - start_ms) / 1000 ))

  log "\$ (cd examples/$name && HYDRA_RUNNER=$HYDRA_RUNNER $HYDRA_BIN build)"
  log "--- output (exit $code, ${elapsed}s) ---"
  cat "$out" >>"$LOG"
  log "--- end output ---"

  if [[ $code -ne 0 ]]; then
    reason="$(classify_exit "$code")"
    say ""
    say "== $name — output (exit $code, ${elapsed}s) =="
    # The first 30 lines of real output, shown to the operator as well.
    head -30 "$out" | sed 's/^/   | /'
    say "FAIL  $name — $reason"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name: $reason")
    rm -f "$out"
    continue
  fi

  html="$dir/dist/index.html"
  if [[ ! -f "$html" ]]; then
    say ""
    say "== $name — output (exit 0, ${elapsed}s) =="
    head -30 "$out" | sed 's/^/   | /'
    say "FAIL  $name — build exited 0 but dist/index.html was not produced"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name: no dist/index.html")
    rm -f "$out"
    continue
  fi

  if ! asset_report="$(check_assets "$dir/dist")"; then
    say ""
    say "== $name — output (exit 0, ${elapsed}s) =="
    head -30 "$out" | sed 's/^/   | /'
    say "FAIL  $name — dist/index.html references a JS asset that is missing: ${asset_report#missing }"
    log "HTML asset check failed: $asset_report"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name: missing JS asset")
    rm -f "$out"
    continue
  fi

  n_assets="${asset_report#ok }"
  say ""
  say "PASS  $name — exit 0, dist/index.html + ${n_assets} JS asset(s) verified (${elapsed}s)"
  log "HTML asset check: $asset_report"
  PASSED=$((PASSED + 1))
  rm -f "$out"
done

say ""
say "================================================================"
say "examples: $TOTAL   pass: $PASSED   fail: $FAILED"
if [[ $FAILED -gt 0 ]]; then
  for line in "${FAILED_NAMES[@]}"; do
    say "  FAILED — $line"
  done
  say "full transcript: $LOG"
  exit 1
fi

say "full transcript: $LOG"
exit 0
