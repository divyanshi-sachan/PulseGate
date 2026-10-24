#!/usr/bin/env bash
# Dashboard end-to-end run (plan §7, ADR-0043): a fresh Docker stack, the Docker boundary checks, then Playwright.
# The stack is always torn down (compose down -v), also on failure or Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=pulsegate-e2e
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.dashboard.yml -f docker-compose.e2e.yml)
TOKEN=pulsegate-e2e-admin-token-not-a-secret

cleanup() {
  if [ "${E2E_KEEP_STACK:-}" != "1" ]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build --wait

# --- Docker boundary checks (plan §5) ---------------------------------------------------------------------
# Another container on the Compose network reaches the admin port: only the token protects it.
probe() { # $1 = authorization header value or ""
  "${COMPOSE[@]}" exec -T orders-mock node -e "
    const headers = process.argv[1] ? { authorization: process.argv[1] } : {};
    fetch('http://gateway:9090/admin/api/stats', { headers }).then((r) => console.log(r.status), () => console.log(0));
  " "$1"
}
no_token=$(probe "")
with_token=$(probe "Bearer $TOKEN")
echo "cross-container /admin/api/stats: without token $no_token, with token $with_token"
[ "$no_token" = "401" ] || { echo "FAIL: expected 401 without a token from another container" >&2; exit 1; }
[ "$with_token" = "200" ] || { echo "FAIL: expected 200 with the token from another container" >&2; exit 1; }

# The UI ships in the image and is served without a token, with the strict CSP.
headers=$(curl -s -D - -o /dev/null http://127.0.0.1:9090/admin/ui/)
echo "$headers" | grep -qi "^HTTP/1.1 200" || { echo "FAIL: /admin/ui/ is not served" >&2; exit 1; }
echo "$headers" | grep -qi "^content-security-policy: default-src 'self'" || { echo "FAIL: UI CSP missing" >&2; exit 1; }
echo "UI served from the image with the strict CSP"

# --- Playwright ----------------------------------------------------------------------------------------------
E2E_ADMIN_TOKEN=$TOKEN pnpm exec playwright test "$@"

# --- F5 in Prometheus: the recovery went through half-open to closed (operations listener, inside the container) --
metrics=$("${COMPOSE[@]}" exec -T gateway node -e "fetch('http://127.0.0.1:9091/metrics').then((r) => r.text()).then(console.log)")
for transition in 'from="closed",to="open"' 'from="open",to="half-open"' 'from="half-open",to="closed"'; do
  line=$(echo "$metrics" | grep 'pulsegate_circuit_breaker_transitions_total' | grep 'upstream="recover-service"' | grep "$transition" || true)
  count=${line##* }
  if [ -z "$line" ] || [ "${count%.*}" -lt 1 ]; then
    echo "FAIL: recover-service transition $transition missing from /metrics" >&2
    exit 1
  fi
done
echo "recover-service breaker transitions closed -> open -> half-open -> closed recorded in /metrics"
