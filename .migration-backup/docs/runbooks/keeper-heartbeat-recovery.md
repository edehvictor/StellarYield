# Keeper Heartbeat Timeout Alerts & Degraded Mode Recovery Runbook (#1034)

## Overview
StellarYield relies on four core background workers (keepers) to maintain protocol health, liquidation solvency, yield compounding, and data indexing:

1. **Rebalance Keeper (`rebalance`)**
2. **Liquidation Keeper (`liquidation`)**
3. **Reward / Auto-Compound Keeper (`reward`)**
4. **Indexer Worker (`indexer`)**

When a keeper stops sending periodic heartbeats to Redis or the backend health registry, alerting systems flag the keeper as `stale` (or `missing`). This runbook provides the operational triage procedure, degraded mode impacts, and step-by-step recovery commands.

---

## Heartbeat Freshness Thresholds

| State | Heartbeat Age | Alert Severity | Operational Status |
|---|---|---|---|
| **Healthy** | $\le 60$ seconds | None | Fully operational |
| **Stale** | $> 60$ seconds and $\le 180$ seconds | Warning (Slack/PagerDuty) | Degraded execution |
| **Missing / Offline** | $> 180$ seconds or null | Critical | Component outage |

---

## Degraded Behaviors & Recovery Procedures

### 1. Rebalance Keeper (`rebalance`)
- **Degraded Behavior**: Portfolio drift is left uncorrected. Vault asset allocations may deviate from target model weights over time.
- **Triage**:
  1. Inspect queue backlog: `GET /api/health/queues`
  2. Check Soroban RPC endpoint response latency.
  3. Verify whether rebalance simulation gas costs exceed network limits.
- **Recovery Command**:
  ```bash
  docker compose restart keeper-rebalance
  # Check logs:
  docker compose logs -f --tail=100 keeper-rebalance
  ```

---

### 2. Liquidation Keeper (`liquidation`)
- **Degraded Behavior**: Undercollateralized lending positions are not liquidated in a timely manner. The vault collateral ratio is at risk of bad debt if market prices decline.
- **Triage**:
  1. Verify oracle price feed freshness on Reflector / Pyth.
  2. Check liquidation signer public key balance on Stellar testnet/mainnet to ensure gas fees can be paid.
  3. Inspect liquidation worker lock records in Redis.
- **Recovery Command**:
  ```bash
  docker compose restart keeper-liquidation
  # Check logs:
  docker compose logs -f --tail=100 keeper-liquidation
  ```

---

### 3. Reward / Auto-Compound Keeper (`reward`)
- **Degraded Behavior**: Yield harvesting and auto-compounding are paused. Rewards accumulate in strategy contracts without being reinvested into vault shares.
- **Triage**:
  1. Check gas balance for the compound distributor account.
  2. Verify if DEX router / AMM swap slippage exceeds `minHarvestAmount`.
- **Recovery Command**:
  ```bash
  docker compose restart keeper-compound
  # Check logs:
  docker compose logs -f --tail=100 keeper-compound
  ```

---

### 4. Indexer Worker (`indexer`)
- **Degraded Behavior**: On-chain Soroban contract events and Horizon ledger transactions are not ingested into Postgres. Dashboard balances, activity feeds, and tax previews lag behind real-time state.
- **Triage**:
  1. Check `GET /api/health` to view `indexerLag` against the latest Horizon ledger sequence.
  2. Check Postgres write connection pool and database CPU usage.
- **Recovery Command**:
  ```bash
  docker compose restart indexer
  # Check logs:
  docker compose logs -f --tail=100 indexer
  ```

---

## Health Endpoint Diagnostics

Maintainers and uptime monitors can query the keeper diagnostics endpoint:

```bash
GET /api/health/keepers
```

**Example Response (Degraded):**
```json
{
  "status": "degraded",
  "staleCount": 1,
  "missingCount": 0,
  "keepers": {
    "rebalance": {
      "status": "healthy",
      "lastHeartbeat": "2026-08-25T08:15:00.000Z",
      "ageMs": 12400,
      "degradedBehavior": "Portfolio drift uncorrected; vault asset allocations may diverge from target weights.",
      "recoveryGuidance": "Check rebalance queue depth, verify Soroban RPC endpoint latency, and restart rebalance keeper: `docker compose restart keeper-rebalance`."
    },
    "liquidation": {
      "status": "stale",
      "lastHeartbeat": "2026-08-25T08:12:00.000Z",
      "ageMs": 192400,
      "degradedBehavior": "Undercollateralized positions are not liquidated; vault collateral ratio at risk of bad debt.",
      "recoveryGuidance": "Verify oracle price feed freshness, check liquidation signer balance for gas, and restart liquidation keeper: `docker compose restart keeper-liquidation`."
    },
    "reward": {
      "status": "healthy",
      "lastHeartbeat": "2026-08-25T08:15:10.000Z",
      "ageMs": 2400,
      "degradedBehavior": "Yield harvesting paused; auto-compounding rewards and fee distributions are delayed.",
      "recoveryGuidance": "Check gas balance on reward distribution key and restart compound worker: `docker compose restart keeper-compound`."
    },
    "indexer": {
      "status": "healthy",
      "lastHeartbeat": "2026-08-25T08:15:08.000Z",
      "ageMs": 4400,
      "degradedBehavior": "On-chain ledger events not indexed; dashboard transaction history and balances may lag.",
      "recoveryGuidance": "Verify Horizon RPC connectivity, inspect database write latency, and restart indexer service: `docker compose restart indexer`."
    }
  },
  "timestamp": "2026-08-25T08:15:12.400Z"
}
```

> **Note**: Stale keeper alerts return HTTP 200 with `status: "degraded"` so dashboards distinguish worker degradation from entire API gateway outages.
