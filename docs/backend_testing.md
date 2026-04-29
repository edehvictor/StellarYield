# Backend Testing Guide via CLI

This guide provides `curl` commands to test the new features implemented in the StellarYield backend.

## 1. APY Attribution Breakdown (#287)
Fetch the yield data to see the new `attribution` object for each protocol.

```bash
curl -X GET http://localhost:3001/api/yields | jq
```

## 2. Risk Incident Chronicle (#286)

### Fetch all incidents
```bash
curl -X GET http://localhost:3001/api/incidents | jq
```

### Create a new incident
```bash
curl -X POST http://localhost:3001/api/incidents \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "Blend",
    "severity": "HIGH",
    "type": "PAUSE",
    "title": "Protocol Upgrade Delay",
    "description": "Blend protocol is undergoing maintenance and deposits are temporarily paused.",
    "affectedVaults": ["USDC-Yield-1"],
    "startedAt": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"
  }' | jq
```

### Resolve an incident
Replace `ID` with the actual incident ID from the previous command.
```bash
curl -X PATCH http://localhost:3001/api/incidents/ID/resolve | jq
```

## 3. Emergency Freeze Control (#288)
*Note: These commands require the admin role. If the `requireAdmin` middleware is active, you may need an auth token.*

### Freeze a specific protocol (e.g., Soroswap)
```bash
curl -X POST http://localhost:3001/api/admin/recommendations/freeze \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "Soroswap",
    "reason": "Observed abnormal price volatility"
  }' | jq
```

### Freeze all recommendations globally
```bash
curl -X POST http://localhost:3001/api/admin/recommendations/freeze \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Global network maintenance"
  }' | jq
```

### Resume recommendations
```bash
curl -X POST http://localhost:3001/api/admin/recommendations/resume \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "Soroswap"
  }' | jq
```

## 4. Slippage Model Registry (#278)
Test a zap quote to see the `slippageApplied` and `amountOutAfterSlippage` fields.

```bash
curl -X POST http://localhost:3001/api/zap/quote \
  -H "Content-Type: application/json" \
  -d '{
    "inputTokenContract": "CBG64B62J46NIF6S4C5E",
    "outputTokenContract": "CC64B62J46NIF6S4C5E",
    "amountInStroops": "10000000",
    "protocol": "Blend"
  }' | jq
```
