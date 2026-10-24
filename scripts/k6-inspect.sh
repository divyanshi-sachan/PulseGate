#!/usr/bin/env bash
# Validates every k6 script's syntax and options with the pinned k6 image, without generating load (ADR-0046).
# Runs in routine CI; scripts/bench.sh runs the actual load (opt-in).
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# Scripts read per-run keys at init time; placeholders are enough to inspect them.
echo '{"auth":"inspect","limited":["0","1","2","3","4","5","6","7","8","9"]}' >"$out/keys.json"
status=0
for script in benchmarks/k6/*.js; do
  name=$(basename "$script")
  [ "$name" = lib.js ] && continue
  for profile in quick full; do
    if docker run --rm -e BENCH_PROFILE=$profile -v "$PWD/benchmarks/k6:/scripts:ro" -v "$out:/out" "$IMAGE" \
      inspect "/scripts/$name" >/dev/null 2>"$out/err"; then
      echo "ok   $name ($profile)"
    else
      echo "FAIL $name ($profile)"; cat "$out/err"; status=1
    fi
  done
done
exit $status
