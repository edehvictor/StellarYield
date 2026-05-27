#!/usr/bin/env bash
set -euo pipefail

FRONTEND_URL=${FRONTEND_URL:-"http://localhost:5173"}
BACKEND_URL=${BACKEND_URL:-"http://localhost:3001"}
OUTPUT_MODE=${OUTPUT_MODE:-"text"}

BACKEND_HEALTH_PATH=${BACKEND_HEALTH_PATH:-"/api/health"}
BACKEND_YIELDS_PATH=${BACKEND_YIELDS_PATH:-"/api/yields"}
FRONTEND_ASSET_PATH=${FRONTEND_ASSET_PATH:-"/favicon.svg"}

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
    echo "[PASS] $label (200)"
  else
    if [[ "$status" == "000" ]]; then
      echo "[FAIL] $label (unreachable)"
      echo "   URL: $url"
      echo "   Hint: set FRONTEND_URL/BACKEND_URL to deployed URLs or start local services."
      exit 1
    fi
    echo "[FAIL] $label ($status)"
    echo "   URL: $url"
    exit 1
  fi
}

run_check() {
  local label="$1"
  local url="$2"
  local status
  status="$(curl_status "$url")"
  if [[ "$status" == "200" ]]; then
    echo "{\"label\":\"$label\",\"url\":\"$url\",\"status\":\"pass\",\"httpCode\":200}"
    return 0
  fi

  if [[ "$status" == "000" ]]; then
    echo "{\"label\":\"$label\",\"url\":\"$url\",\"status\":\"fail\",\"httpCode\":0,\"message\":\"unreachable\"}"
    return 1
  fi

  echo "{\"label\":\"$label\",\"url\":\"$url\",\"status\":\"fail\",\"httpCode\":$status}"
  return 1
}

if [[ "${1:-}" == "--json" || "$OUTPUT_MODE" == "json" ]]; then
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  checks=(
    "Backend ${BACKEND_HEALTH_PATH}|${BACKEND_URL}${BACKEND_HEALTH_PATH}"
    "Backend ${BACKEND_YIELDS_PATH}|${BACKEND_URL}${BACKEND_YIELDS_PATH}"
    "Frontend /|${FRONTEND_URL}/"
    "Frontend ${FRONTEND_ASSET_PATH}|${FRONTEND_URL}${FRONTEND_ASSET_PATH}"
  )

  results=()
  overall="pass"
  for check in "${checks[@]}"; do
    label="${check%%|*}"
    url="${check##*|}"
    result="$(run_check "$label" "$url")" || overall="fail"
    results+=("$result")
  done

  printf '{"timestamp":"%s","frontendUrl":"%s","backendUrl":"%s","status":"%s","checks":[%s]}\n' \
    "$timestamp" "$FRONTEND_URL" "$BACKEND_URL" "$overall" "$(IFS=,; echo "${results[*]}")"
  [[ "$overall" == "pass" ]] || exit 1
  exit 0
fi

echo "----------------------------------------"
echo "StellarYield Smoke Test"
echo "----------------------------------------"
echo "Target Frontend: $FRONTEND_URL"
echo "Target Backend:  $BACKEND_URL"
echo "----------------------------------------"

echo ""
echo "[1/4] Checking backend health..."
expect_200 "Backend ${BACKEND_HEALTH_PATH}" "${BACKEND_URL}${BACKEND_HEALTH_PATH}"

echo ""
echo "[2/4] Checking backend yield endpoint..."
expect_200 "Backend ${BACKEND_YIELDS_PATH}" "${BACKEND_URL}${BACKEND_YIELDS_PATH}"

echo ""
echo "[3/4] Checking frontend root..."
expect_200 "Frontend /" "${FRONTEND_URL}/"

echo ""
echo "[4/4] Checking frontend static asset..."
expect_200 "Frontend ${FRONTEND_ASSET_PATH}" "${FRONTEND_URL}${FRONTEND_ASSET_PATH}"

echo ""
echo "----------------------------------------"
echo "All smoke tests passed."
echo "----------------------------------------"
