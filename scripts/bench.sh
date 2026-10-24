#!/usr/bin/env bash
# k6 performance suite against the mock upstreams (docs/plans/real-data-testing.md §3, ADR-0046). Never touches
# third-party APIs. BENCH_PROFILE=quick (default, minutes) or full (published reports). BENCH_ONLY=K4,K5 runs a subset.
# Raw results stay in benchmarks/reports/raw/<run-id>/ (git-ignored). The stacks are always torn down.
set -euo pipefail
cd "$(dirname "$0")/.."

export BENCH_PROFILE=${BENCH_PROFILE:-quick}
ONLY=${BENCH_ONLY:-}
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s | tr -c 'A-Za-z0-9-\n' '-')-${BENCH_PROFILE}"
export BENCH_RUN_DIR="$PWD/benchmarks/reports/raw/$RUN_ID"
export BENCH_ADMIN_TOKEN
BENCH_ADMIN_TOKEN=$(openssl rand -hex 24)
mkdir -p "$BENCH_RUN_DIR"

LOCAL=(docker compose -p pulsegate-bench -f docker-compose.yml -f docker-compose.bench.yml)
REDIS=(docker compose -p pulsegate-bench -f docker-compose.yml -f docker-compose.distributed.yml
  -f docker-compose.bench.yml -f docker-compose.bench-redis.yml)
STACK=("${LOCAL[@]}")
SAMPLER=""

cleanup() {
  [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null || true
  "${REDIS[@]}" --profile bench down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wanted() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }
log() { echo "[bench $(date +%H:%M:%S)] $*"; }

# Fetch a URL from inside a container (operations and admin listeners are not published).
fetch_in() { # service url [authorization]
  "${STACK[@]}" exec -T "$1" node -e "
    const [url, auth] = process.argv.slice(1);
    fetch(url, { headers: auth ? { authorization: auth } : {} })
      .then((r) => r.text()).then((t) => process.stdout.write(t), (e) => { console.error(String(e)); process.exit(1); });
  " "$2" "${3:-}"
}

snapshot() { # name phase
  local base="$BENCH_RUN_DIR/$1.$2"
  fetch_in gateway http://127.0.0.1:9091/metrics >"$base.metrics.txt"
  fetch_in gateway http://127.0.0.1:9090/admin/api/stats "Bearer $BENCH_ADMIN_TOKEN" >"$base.admin.json"
  fetch_in orders-mock http://127.0.0.1:4001/_stats >"$base.orders.json"
  if "${STACK[@]}" ps --services | grep -qx gateway-2; then
    fetch_in gateway-2 http://127.0.0.1:9091/metrics >"$base.metrics-2.txt"
  else
    fetch_in payments-mock http://127.0.0.1:4002/_stats >"$base.payments.json"
  fi
}

start_sampler() { # name
  local out="$BENCH_RUN_DIR/$1.stats.jsonl" ids
  ids=$("${STACK[@]}" ps -q | tr '\n' ' ')
  # shellcheck disable=SC2086
  (while :; do
    t=$(date +%s)
    docker stats --no-stream --format '{{json .}}' $ids 2>/dev/null | sed "s/^/{\"t\":$t,\"s\":/; s/\$/}/" >>"$out"
  done) &
  SAMPLER=$!
}

stop_sampler() {
  [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null || true
  wait "$SAMPLER" 2>/dev/null || true
  SAMPLER=""
}

run_k6() { # name script [KEY=VALUE ...]
  local name=$1 script=$2
  shift 2
  local env_args=(-e "RUN_NAME=$name")
  for kv in "$@"; do env_args+=(-e "$kv"); done
  log "$name ($script $*)"
  snapshot "$name" before
  start_sampler "$name"
  local code=0
  "${STACK[@]}" --profile bench run --rm --no-deps "${env_args[@]}" k6 run --quiet \
    --out "json=/out/$name.k6.json.gz" "/scripts/$script" >"$BENCH_RUN_DIR/$name.k6.log" 2>&1 || code=$?
  stop_sampler
  snapshot "$name" after
  echo "$code" >"$BENCH_RUN_DIR/$name.exit"
  log "$name done (k6 exit $code)"
}

node scripts/bench-keys.ts "$BENCH_RUN_DIR"
node scripts/bench-meta.ts "$BENCH_RUN_DIR" "$BENCH_PROFILE"
log "run $RUN_ID, profile $BENCH_PROFILE"

# ---- Local limiter stack -----------------------------------------------------------------------------------------
"${LOCAL[@]}" up -d --build --wait
docker image inspect pulsegate-bench-gateway --format '{{.Id}}' >"$BENCH_RUN_DIR/gateway-image.txt"

if [ "$BENCH_PROFILE" = full ]; then RATES=(250 500 1000); else RATES=(50 100); fi
if wanted K0 || wanted K1; then
  for rate in "${RATES[@]}"; do
    wanted K0 && run_k6 "k0-r$rate" steady.js TARGET=direct "RATE=$rate"
    wanted K1 && run_k6 "k1-r$rate" steady.js TARGET=gateway "RATE=$rate"
  done
fi

if wanted K4; then
  # Warm the one K4 key until the gateway answers HIT (§3a), before the snapshots.
  "${STACK[@]}" exec -T orders-mock node -e "
    (async () => {
      for (let i = 0; i < 20; i++) {
        const r = await fetch('http://gateway:8080/bench/cached/k4?_bytes=1024&_contentLength=1');
        await r.arrayBuffer();
        if (r.headers.get('x-cache') === 'HIT') return;
      }
      console.error('K4 warm-up never reached HIT'); process.exit(1);
    })();
  "
  run_k6 k4-cache cache.js
fi
wanted K2 && run_k6 k2-burst burst.js
wanted K3 && run_k6 k3-mixed mixed.js
wanted K5 && run_k6 k5-limits limits.js
wanted K6 && run_k6 k6-slow slow.js
if wanted K7; then
  run_k6 k7-failing failing.js
  fetch_in gateway http://127.0.0.1:9091/health >"$BENCH_RUN_DIR/k7-failing.health.json"
fi
if [ "$BENCH_PROFILE" = full ] && wanted K9; then run_k6 k9-saturation saturation.js; fi
"${LOCAL[@]}" down -v --remove-orphans >/dev/null 2>&1

# ---- Redis limiter, 2 instances (K8) -------------------------------------------------------------------------------
if wanted K8; then
  STACK=("${REDIS[@]}")
  "${REDIS[@]}" up -d --build --wait
  run_k6 k8-shared redis.js MODE=shared
  run_k6 k8-tput-1 redis.js MODE=throughput INSTANCES=1
  run_k6 k8-tput-2 redis.js MODE=throughput INSTANCES=2
  "${REDIS[@]}" down -v --remove-orphans >/dev/null 2>&1
fi

log "generating the report"
node scripts/bench-report.ts "$BENCH_RUN_DIR"
