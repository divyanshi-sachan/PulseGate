#!/usr/bin/env bash
# Exit criterion for Phase 4 (ADR-0034): two gateway instances enforce ONE shared budget.
# Expects `pnpm dev:distributed` (or the CI job) to be running: gateways on :8080 and :8081.
# The public /api/payments route has capacity 30, so exactly 30 of 100 concurrent requests may pass.
set -euo pipefail
codes=$(mktemp)
for i in $(seq 1 100); do
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$((8080 + i % 2))/api/payments/smoke-$i" >>"$codes" &
done
wait
ok=$(grep -c '^200$' "$codes" || true)
limited=$(grep -c '^429$' "$codes" || true)
rm -f "$codes"
echo "200: $ok  429: $limited"
if [ "$ok" -ne 30 ] || [ "$limited" -ne 70 ]; then
  echo "FAIL: expected exactly 30 x 200 and 70 x 429 across both instances" >&2
  exit 1
fi
echo "OK: shared budget enforced across instances"
