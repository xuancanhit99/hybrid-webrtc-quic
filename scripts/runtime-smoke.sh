#!/usr/bin/env bash
set -Eeuo pipefail
project="hybrid-smoke-$RANDOM"
export SESSION_SECRET="$(openssl rand -base64 48)"
export ENROLLMENT_TOKEN="$(openssl rand -base64 32)"
export TURN_SECRET="$(openssl rand -base64 32)"
export TURN_BIND="127.0.0.1"
compose=(docker compose -f docker-compose.yml -f docker-compose.smoke.yml -p "$project")
cleanup() { "${compose[@]}" down --remove-orphans --volumes >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${compose[@]}" up --build --wait control coturn
health="$("${compose[@]}" exec -T control node -e "fetch('http://127.0.0.1:8787/healthz').then(async r=>{process.stdout.write(await r.text());if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))")"
case "$health" in *'"status":"ok"'*) echo "Hybrid runtime smoke passed: $health";; *) echo "Unexpected health payload: $health" >&2; exit 1;; esac
test "$("${compose[@]}" ps -q control)" != ""
test "$("${compose[@]}" ps -q coturn)" != ""
! "${compose[@]}" ps --format json | grep -Eq '"PublishedPort":[1-9][0-9]*'
