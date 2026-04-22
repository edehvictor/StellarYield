#!/bin/bash
set -e

FRONTEND_URL=${FRONTEND_URL:-"http://localhost:5173"}
BACKEND_URL=${BACKEND_URL:-"http://localhost:3001"}

echo "----------------------------------------"
echo "🚀 StellarYield Smoke Test"
echo "----------------------------------------"
echo "Target Frontend: $FRONTEND_URL"
echo "Target Backend:  $BACKEND_URL"
echo "----------------------------------------"

# 1. Check Backend Health
echo ""
echo "[1/3] Checking Backend Yield Endpoints..."

YIELDS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BACKEND_URL/api/yields")
if [ "$YIELDS_STATUS" == "200" ]; then
    echo "✅ [SUCCESS] Backend /api/yields returned 200 OK"
else
    echo "❌ [FAILED] Backend /api/yields returned $YIELDS_STATUS"
    exit 1
fi

METRICS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BACKEND_URL/api/metrics")
if [ "$METRICS_STATUS" == "200" ]; then
    echo "✅ [SUCCESS] Backend /api/metrics returned 200 OK"
else
    echo "❌ [FAILED] Backend /api/metrics returned $METRICS_STATUS"
    exit 1
fi

# 2. Check Frontend reachable
echo ""
echo "[2/3] Checking Frontend Root..."
FRONTEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND_URL")
if [ "$FRONTEND_STATUS" == "200" ]; then
    echo "✅ [SUCCESS] Frontend returned 200 OK"
else
    echo "❌ [FAILED] Frontend returned $FRONTEND_STATUS"
    exit 1
fi

echo ""
echo "[3/3] Checking Subgraphs / External Services (placeholder)..."
echo "✅ [SUCCESS] Services assume healthy"

echo "----------------------------------------"
echo "🎉 All smoke tests passed successfully!"
echo "----------------------------------------"

exit 0
