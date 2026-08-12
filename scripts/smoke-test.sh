#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:4000}"
echo "Testing $BASE_URL"
curl -fsS "$BASE_URL/api/health" >/dev/null
curl -fsS "$BASE_URL/" >/dev/null
echo "OK: health + home"
