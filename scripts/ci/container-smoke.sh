#!/usr/bin/env bash
set -euo pipefail

# Isolate the smoke test from live Azure data and other local containers.
suffix="${GITHUB_RUN_ID:-local}-$$"
network="jaj-ci-$suffix"
database="jaj-ci-db-$suffix"
app="jaj-ci-app-$suffix"
cleanup() {
  result=$?
  if [[ "$result" != 0 ]]; then docker logs "$app" 2>/dev/null || true; fi
  docker rm -f "$app" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run -d --name "$database" --network "$network" --network-alias database \
  -e POSTGRES_USER=qa -e POSTGRES_PASSWORD=qa_test_only -e POSTGRES_DB=restaurant \
  postgres:17-alpine >/dev/null
ready=false
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U qa -d restaurant >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == true ]] || { echo 'CI PostgreSQL did not start'; exit 1; }
for migration in database/migrations/*.sql; do
  docker exec -i "$database" psql -U qa -d restaurant -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done

docker run -d --name "$app" --network "$network" \
  -e DATABASE_URL=postgresql://qa:qa_test_only@database:5432/restaurant \
  -e DATABASE_SSL=false -e DATABASE_POOL_SIZE=5 \
  -e NODE_ENV=production -e ENABLE_DEMO_CRUD=false \
  -e KAFKA_BROKERS= -e KBANK_WEBHOOK_TOKEN=ci_test_only \
  jaj-api:ci >/dev/null
ready=false
for attempt in {1..30}; do
  if docker exec "$app" node -e '
    const base = "http://127.0.0.1:3000/api";
    (async () => {
      for (const route of ["/health/live", "/health/ready"]) {
        const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(route + ": " + response.status);
      }
      for (const route of ["/users", "/products"]) {
        const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
        if (response.status !== 404) throw new Error("Demo route is exposed: " + route);
      }
    })().catch(() => process.exit(1));
  ' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == true ]] || { echo 'Container health or production route checks failed'; exit 1; }
echo 'Container smoke checks passed.'
