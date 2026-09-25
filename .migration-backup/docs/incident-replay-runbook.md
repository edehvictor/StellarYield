# Incident Replay Runbook

## Overview

This document provides repeatable procedures to reconstruct incident events from keeper audit logs, event archives, and queue snapshots. Use this to validate root causes, test fixes, and educate the team on what happened.

## Quick Reference

- **Export raw events**: `npm run export:incident-events -- --from <ledger> --to <ledger>`
- **Analyze keeper audit logs**: `npm run audit:analyze -- --incident <INC-ID>`
- **Generate impact summary**: `npm run report:user-impact -- --incident <INC-ID>`
- **Test runbook against fixtures**: `npm test -- --suite replay`

## Prerequisites

- Access to keeper service logs (Redis queue history, Pino logs)
- Stellar RPC access (Horizon + Soroban)
- Read-only database credentials for vault snapshots
- Recent backup of queue database (PostgreSQL)

## Procedure: Export Raw Events for Ledger Window

Use this to collect all on-chain events and keeper decisions during a specific time window.

### Step 1: Identify Ledger Range

```bash
# Find ledger number at specific time (UTC)
curl -s https://horizon.stellar.org/ledgers?order=asc | jq '.records[] | select(.closed_at > "2024-01-01T12:00:00Z") | .sequence' | head -1

# Result: ledger sequence (e.g., 50000000)
```

### Step 2: Export Events and Audit Logs

```bash
# Export keeper audit logs for ledger window
npm run export:incident-events -- \
  --from-ledger 50000000 \
  --to-ledger 50001000 \
  --output ./replay/events-50000000-50001000.json \
  --include-audit-logs \
  --include-vault-snapshots

# Output: JSON file with:
# - Raw keeper decisions (liquidation triggers, compound scheduling)
# - Queue job states (pending, completed, failed)
# - Vault snapshots at window boundaries
# - User transaction impacts
```

### Step 3: Export Vault Anomalies

```bash
# Detect anomalies during window
npm run export:incident-events -- \
  --from-ledger 50000000 \
  --to-ledger 50001000 \
  --anomalies-only \
  --output ./replay/anomalies.json

# Output includes:
# - Collateral ratio drops below MCR
# - Unexpected fee spikes
# - Oracle price deviations (>5%)
# - Queue stalls (>30s delay)
# - Failed transaction patterns
```

## Procedure: Analyze Keeper Audit Logs

### Step 1: Collect Keeper Logs

```bash
# Export keeper logs for incident window (from application logs)
npm run audit:analyze -- \
  --incident INC-001 \
  --log-source pino-json \
  --output ./replay/keeper-audit-INC-001.json

# Output structure:
# {
#   "decisions": [
#     {
#       "timestamp": "2024-01-01T12:05:30Z",
#       "jobId": "liquidation_0xabc...",
#       "decision": "flag_for_liquidation",
#       "accountAddress": "GXXXXXXX",
#       "reason": "CR=9500bps < MCR=11000bps",
#       "confidence": 0.99
#     }
#   ]
# }
```

### Step 2: Extract Decision Timeline

```bash
# Generate timeline of keeper decisions
npm run audit:analyze -- \
  --incident INC-001 \
  --timeline \
  --output ./replay/timeline-INC-001.csv

# CSV format: timestamp | jobId | decision | account | status
```

### Step 3: Cross-Reference with On-Chain Events

```bash
# Verify keeper decisions match on-chain outcomes
npm run audit:analyze -- \
  --incident INC-001 \
  --validate-against-ledger \
  --strict

# Output: list of mismatches (if any)
```

## Procedure: Generate User Impact Summary

### Step 1: Identify Affected Accounts

```bash
# Find all affected vaults and accounts
npm run report:user-impact -- \
  --incident INC-001 \
  --output ./replay/impact-INC-001.json

# Output:
# {
#   "incidentId": "INC-001",
#   "affectedVaults": ["vault_1", "vault_2"],
#   "affectedAccounts": 45,
#   "summary": {
#     "liquidations_triggered": 12,
#     "total_collateral_at_risk": "50000 USDC",
#     "recovered": "49500 USDC",
#     "loss": "500 USDC"
#   }
# }
```

### Step 2: Generate User-Facing Report

```bash
# Create markdown template for communications
npm run report:user-impact -- \
  --incident INC-001 \
  --format markdown \
  --output ./replay/USER_IMPACT_INC-001.md

# Output: user-friendly summary with:
# - Incident duration
# - Affected vault names (sanitized)
# - Account count (no addresses listed)
# - Recovery status
# - Recommended actions
```

## Procedure: Detect Broken Replay Sequences

Replay exports never imply a clean replay. After exporting a ledger window, check `replayAnomalies` on the export — missing checkpoints, out-of-order events, and incomplete ranges are surfaced explicitly.

### Step 1: Run the Replay Integrity Check

```bash
# Export and validate replay integrity for the window
npm run export:incident-events -- \
  --from-ledger 50000000 \
  --to-ledger 50001000 \
  --validate-replay \
  --output ./replay/replay-integrity.json

# Output: replayAnomalies[] with type + details, and summary.replayAnomalyCount
```

### Step 2: Interpret Anomaly Types

| type | Meaning |
| --- | --- |
| `missing-checkpoint` | Consecutive events skip ledgers inside the range (a checkpoint is absent). |
| `out-of-order` | Event ledgers do not appear in ascending sequence. |
| `incomplete-sequence` | No events cover the range start/end boundaries (or the export is empty). |

A validation error of the form `Replay <type>: <details>` is raised for each anomaly, so broken chains are never mistaken for a clean replay.

## Procedure: Test Runbook Commands Against Fixtures

All replay commands support read-only mode with test fixtures.

### Step 1: Load Test Fixtures

```bash
# Run all replay commands against fixture data
npm test -- --suite replay --useFixtures

# Fixtures located in: backend/keepers/src/__tests__/fixtures/incidents/
# - clean-replay.json            # contiguous, in-order replay (no anomalies)
# - missing-checkpoint.json      # events skip ledgers (missing checkpoint)
# - out-of-order.json            # events not in ascending ledger order
# - incomplete-sequence.json     # events do not span the full range
```

### Step 2: Verify Event Export

```bash
# Test event export with fixture
npm run export:incident-events -- \
  --from-ledger 100 \
  --to-ledger 200 \
  --fixture-mode \
  --output ./test-output.json

# Expected: fixture JSON matches schema
```

### Step 3: Verify Audit Log Analysis

```bash
# Test audit log analysis
npm run audit:analyze -- \
  --incident INC-TEST-001 \
  --fixture-mode \
  --output ./test-audit.json

# Verify: all decisions have timestamps, jobIds, accounts
```

### Step 4: Verify Impact Report

```bash
# Test user impact report generation
npm run report:user-impact -- \
  --incident INC-TEST-001 \
  --fixture-mode \
  --output ./test-impact.json

# Verify: output has affectedVaults, affectedAccounts, summary
```

## Read-Only Mode (Safe by Default)

All replay commands run in read-only mode by default. No changes are made to databases or queues.

### To enable write operations (replay/simulation only):

```bash
# Danger: enables state mutation (use in staging only)
npm run export:incident-events -- \
  --from-ledger 50000000 \
  --to-ledger 50001000 \
  --allow-mutations \
  --target-environment staging
```

## Output Schema Reference

### Events Export

```json
{
  "ledgerRange": { "from": 50000000, "to": 50001000 },
  "exportedAt": "2024-01-05T10:00:00Z",
  "events": [
    {
      "ledger": 50000050,
      "timestamp": "2024-01-01T12:05:30Z",
      "type": "vault_state_change",
      "vaultId": "vault_1",
      "before": { "collateral": "1000000", "debt": "900000" },
      "after": { "collateral": "950000", "debt": "900000" }
    }
  ],
  "anomalies": [
    {
      "ledger": 50000055,
      "type": "collateral_ratio_drop",
      "severity": "critical",
      "details": "CR fell below MCR threshold"
    }
  ]
}
```

### Keeper Audit Logs

```json
{
  "decisions": [
    {
      "timestamp": "2024-01-01T12:05:30Z",
      "jobId": "liquidation_abc123",
      "type": "liquidation_trigger",
      "account": "GXXXXXXX",
      "decision": "approve",
      "evidence": "CR=9500bps < MCR=11000bps",
      "confidence": 0.99
    }
  ]
}
```

### User Impact Report

```json
{
  "incidentId": "INC-001",
  "duration": "1h 45m",
  "affectedVaults": ["vault_1", "vault_2"],
  "affectedAccounts": 45,
  "liquidations": {
    "triggered": 12,
    "successful": 10,
    "partial": 2,
    "failed": 0
  },
  "recovery": {
    "collateralRecovered": "49500 USDC",
    "totalAtRisk": "50000 USDC",
    "recoveryPercentage": 99.0
  }
}
```

## Incident Templates

Save incident replays as:

```
docs/postmortems/
├── INC-001/
│   ├── events.json          # Raw on-chain events
│   ├── keeper-audit.json    # Keeper decisions
│   ├── anomalies.json       # Detected anomalies
│   ├── impact-report.json   # User impact metrics
│   └── replay-commands.sh   # All commands used
```

## Verification Checklist

- [ ] Event range matches incident window
- [ ] All affected vaults listed in output
- [ ] All affected accounts accounted for
- [ ] No unresolved anomalies remain
- [ ] Recovery status accurate
- [ ] No sensitive data (private keys, emails) in exports
- [ ] Commands tested against fixtures
