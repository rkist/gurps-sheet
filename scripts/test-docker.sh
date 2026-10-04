#!/bin/sh
# Builds the image, starts it with the same restrictions as compose.yaml and runs
# the browser tests against it. CI runs this too, through `make test-docker`.
set -eu

image=gurps-sheet:test
name=gurps-sheet-test
port=${TEST_PORT:-18080}

docker build -t "$image" .
docker rm -f "$name" >/dev/null 2>&1 || true
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -p "$port:8080" \
  --read-only --cap-drop ALL --security-opt no-new-privileges "$image" >/dev/null

status=
for _ in $(seq 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$name")
  [ "$status" = healthy ] && break
  sleep 1
done
if [ "$status" != healthy ]; then
  echo "Not healthy after 60s ($status):"
  docker logs "$name"
  exit 1
fi

TEST_URL="http://127.0.0.1:$port/" npm test || { docker logs "$name"; exit 1; }

start=$(date +%s)
docker stop "$name" >/dev/null
elapsed=$(( $(date +%s) - start ))
echo "Stopped in ${elapsed}s"
if [ "$elapsed" -ge 5 ]; then
  echo "Expected it to stop within 5s of SIGTERM"
  exit 1
fi
