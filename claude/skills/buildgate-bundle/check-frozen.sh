#!/bin/sh
# Bundle frozen-test check (buildgate-bundle skill). Fails when an acceptance
# test listed in .bundle/frozen-tests.sha256 changed beyond deleting its stage
# gate line. Gate lines and blank lines are ignored when hashing.
set -eu
cd "$(dirname "$0")/.."
if command -v sha256sum >/dev/null 2>&1; then hasher="sha256sum"; else hasher="shasum -a 256"; fi
status=0
while read -r want path; do
  [ -n "$path" ] || continue
  if [ ! -f "$path" ]; then
    echo "frozen test missing: $path" >&2
    status=1
    continue
  fi
  got=$(grep -v -e '^//go:build bundle_t[0-9]*$' \
                -e '^raise unittest\.SkipTest("bundle: ' \
                -e '^pytest\.skip("bundle: ' \
                -e '^[[:space:]]*$' "$path" | $hasher | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    echo "frozen test changed: $path (only deleting its bundle gate line is allowed)" >&2
    status=1
  fi
done < .bundle/frozen-tests.sha256
exit $status
