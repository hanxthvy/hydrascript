#!/usr/bin/env bash
# [xihanzu-NR]
# Per-file test runner: which suite leaves a handle open, and which is just slow.
#
# `node --test packages/cli/*.test.mjs` reports 155 passing tests and then never
# exits, which makes it useless as a CI gate. Running each file with its own
# timeout answers "which file" instead of guessing.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
for f in packages/cli/*.test.mjs; do
  started=$(date +%s)
  timeout 90 node --test "$f" > /tmp/one-test.log 2>&1
  rc=$?
  elapsed=$(( $(date +%s) - started ))
  case $rc in
    0) state="pass" ;;
    124) state="TIMEOUT (handle left open)"; fail=1 ;;
    *) state="FAIL ($(grep -c '^not ok' /tmp/one-test.log) failing)"; fail=1 ;;
  esac
  printf '%-44s %-28s %ss\n' "$(basename "$f")" "$state" "$elapsed"
done
exit $fail
