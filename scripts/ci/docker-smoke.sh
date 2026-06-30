#!/usr/bin/env bash
set -euo pipefail

IMAGE="squawkie-talkie"
CONTAINER="squawkie-smoke-$$"
PORT=3099

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CONTAINER" -p "$PORT:3000" "$IMAGE"

for i in $(seq 1 10); do
  if curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
  echo "✗ Container did not respond within 10s"
  docker logs "$CONTAINER"
  exit 1
fi

echo "✓ Container is listening on port $PORT"

if ! curl -sf "http://localhost:$PORT/api/lists" >/dev/null 2>&1; then
  echo "✗ API endpoint /api/lists failed (DB not accessible)"
  docker logs "$CONTAINER"
  exit 1
fi

echo "✓ API responds (DB working)"
