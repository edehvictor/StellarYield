#!/usr/bin/env bash
set -euo pipefail

FRONTEND_URL=${FRONTEND_URL:-"http://localhost:5173"}
BACKEND_URL=${BACKEND_URL:-"http://localhost:3001"}

BACKEND_HEALTH_PATH=${BACKEND_HEALTH_PATH:-"/api/health"}
BACKEND_YIELDS_PATH=${BACKEND_YIELDS_PATH:-"/api/yields"}
FRONTEND_ASSET_PATH=${FRONTEND_ASSET_PATH:-"/favicon.ico"}

curl_status() {
  local url="$1"
  curl -sS -o /dev/null -w "%{http_code}" "$url" || echo "000"
}

expect_200() {
  local label="$1"
  local url="$2"
  local status
  status="$(curl_status "$url")"
  if [[ "$status" == "200" ]]; then
    echo "✅ [SUCCESS] $label (200)"
  else
    if [[ "$status" == "000" ]]; then
      echo "❌ [FAILED]  $label (unreachable)"
      echo "   URL: $url"
      echo "   Hint: set FRONTEND_URL/BACKEND_URL to deployed URLs or start local services."
      exit 1
    fi
    echo "❌ [FAILED]  $label ($status)"
    echo "   URL: $url"
    exit 1
  fi
}

echo "----------------------------------------"
echo "StellarYield Smoke Test"
echo "----------------------------------------"
echo "Target Frontend: $FRONTEND_URL"
echo "Target Backend:  $BACKEND_URL"
echo "----------------------------------------"

echo ""
echo "[1/4] Checking Backend health..."
expect_200 "Backend ${BACKEND_HEALTH_PATH}" "${BACKEND_URL}${BACKEND_HEALTH_PATH}"

echo ""
echo "[2/4] Checking Backend yield endpoint..."
expect_200 "Backend ${BACKEND_YIELDS_PATH}" "${BACKEND_URL}${BACKEND_YIELDS_PATH}"

echo ""
echo "[3/4] Checking Frontend root..."
expect_200 "Frontend /" "${FRONTEND_URL}/"

echo ""
echo "[4/4] Checking Frontend static asset..."
expect_200 "Frontend ${FRONTEND_ASSET_PATH}" "${FRONTEND_URL}${FRONTEND_ASSET_PATH}"

echo ""
echo "----------------------------------------"
echo "All smoke tests passed."
echo "----------------------------------------"
