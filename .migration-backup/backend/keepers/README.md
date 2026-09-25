# StellarYield Keeper Bot Runbook

This document covers day-to-day operation of the StellarYield keeper bots: configuration, local testing, monitoring, and failure recovery.

## Table of Contents

1. [Overview](#overview)
2. [Keeper Responsibilities](#keeper-responsibilities)
3. [Architecture](#architecture)
4. [Environment Variables](#environment-variables)
5. [Running Locally](#running-locally)
6. [Safe Local Test Commands](#safe-local-test-commands)
7. [Monitoring](#monitoring)
8. [Restarting a Keeper](#restarting-a-keeper)
9. [Troubleshooting](#troubleshooting)

---

## Overview

Keeper bots are off-chain services that automate time-sensitive on-chain operations:

- **Liquidation keeper** — scans CDPs for under-collateralised positions and submits liquidation transactions before they become insolvent.
- **Compound keeper** — calls `harvest` on yield vaults on a schedule to auto-compound accrued rewards back into the vault (increasing the share price for all depositors without user action).

Both keepers are built with [BullMQ](https://docs.bullmq.io/) job queues backed by Redis, and submit Soroban transactions via `@stellar/stellar-sdk`.

---

## Keeper Responsibilities

### Liquidation Queue (`liquidation`)

| Step | Actor | Action |
|------|-------|--------|
| 1 | `VaultMonitor` | Polls the `StablecoinManager` contract every `SCAN_INTERVAL_MS` ms for CDPs whose CR < MCR. |
| 2 | `VaultMonitor` | Enqueues a `LiquidationJobData` job (deduplicated by `accountAddress`). |
| 3 | `LiquidationWorker` | Pulls the job, re-verifies position is still undercollateralised, calls `liquidate(liquidator, user)` on-chain. |
| 4 | `LiquidationWorker` | Logs `txHash` on success; failed jobs land in the BullMQ failed set for review. |

**Retry policy:** exponential back-off, up to `JOB_MAX_ATTEMPTS` (default 5).

### Compound Queue (`compound`)

| Step | Actor | Action |
|------|-------|--------|
| 1 | `CompoundScheduler` | Registers a BullMQ repeatable job per vault at a cron interval (default: every 4 hours). |
| 2 | `CompoundWorker` | Pulls the job, calls `harvest(keeper, min_amount)` on the `YieldVault` contract. |
| 3 | `CompoundWorker` | On success, logs `txHash` and the harvested amount; failed jobs are retried. |

Repeatable jobs survive worker restarts because they are stored in Redis.

---

## Architecture

```
VaultMonitor ──enqueue──▶ liquidation queue (Redis/BullMQ) ──consume──▶ LiquidationWorker
                                                                               │
                                                                               ▼
CompoundScheduler ─enqueue─▶ compound queue (Redis/BullMQ) ──consume──▶ CompoundWorker
                                                                               │
                                                                               ▼
                                                                    KeeperSigner (Stellar SDK)
                                                                               │
                                                                               ▼
                                                                  Soroban RPC → On-chain tx
```

---

## Environment Variables

All variables are read at startup. Required variables cause the process to exit immediately if absent.

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_CONTRACT_ID` | **Yes** | — | Soroban contract ID of the `YieldVault` to compound. |
| `STABLECOIN_MANAGER_CONTRACT_ID` | **Yes** | — | Soroban contract ID of the `StablecoinManager` for liquidation scanning. |
| `KEEPER_SECRET_KEY` | **Yes** | — | Stellar secret key (`S...`) used to sign keeper transactions. **Never commit this value.** |
| `REDIS_URL` | No | `redis://localhost:6379` | BullMQ connection string. |
| `STELLAR_NETWORK` | No | `testnet` | `testnet` or `mainnet`. |
| `STELLAR_HORIZON_URL` | No | `https://horizon-testnet.stellar.org` | Horizon REST endpoint. |
| `STELLAR_SOROBAN_RPC_URL` | No | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint. |
| `BASE_FEE` | No | `100` | Base transaction fee in stroops. |
| `SCAN_INTERVAL_MS` | No | `30000` | How often `VaultMonitor` scans for liquidatable CDPs (ms). |
| `MCR_BPS` | No | `11000` | Maintenance Collateralization Ratio in basis points (110% = 11000). |
| `LIQUIDATION_CONCURRENCY` | No | `3` | Max simultaneous liquidation jobs per worker process. |
| `COMPOUND_CONCURRENCY` | No | `5` | Max simultaneous compound jobs per worker process. |
| `JOB_MAX_ATTEMPTS` | No | `5` | Max retries before a job lands in the failed set. |
| `MONITORED_ADDRESSES` | No | `""` | Comma-separated list of Stellar addresses to monitor manually (useful when no indexer is available). |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |

### Example `.env` (testnet)

```env
VAULT_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
STABLECOIN_MANAGER_CONTRACT_ID=CBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
KEEPER_SECRET_KEY=SBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
REDIS_URL=redis://localhost:6379
STELLAR_NETWORK=testnet
SCAN_INTERVAL_MS=30000
MCR_BPS=11000
LOG_LEVEL=debug
```

> **Production note:** Replace `KEEPER_SECRET_KEY` with a KMS adapter that never exposes the raw private key in-process. See the `KeeperSigner` class in `src/signer/KeeperSigner.ts` for the integration point.

---

## Running Locally

### Prerequisites

- Node.js ≥ 18
- Redis running on `localhost:6379` (or set `REDIS_URL`)
- A funded testnet Stellar account whose secret key is set as `KEEPER_SECRET_KEY`
- Deployed testnet contract IDs for `VAULT_CONTRACT_ID` and `STABLECOIN_MANAGER_CONTRACT_ID`

### Install dependencies

```bash
cd backend/keepers
npm install
```

### Start Redis (Docker)

```bash
docker run -d -p 6379:6379 --name redis-keeper redis:7-alpine
```

### Start the keeper

```bash
# Copy and fill in .env
cp .env.example .env
# edit .env with your testnet values

npm run dev
```

You should see:

```
INFO  StellarYield Keeper Bot starting...
INFO  { publicKey: "G..." } Keeper bot public key
INFO  { intervalMs: 30000 } [VaultMonitor] Starting vault scan loop
INFO  { vaultCount: 1 } [CompoundScheduler] All vaults scheduled
INFO  Keeper Bot fully operational
```

---

## Safe Local Test Commands

> All commands below run against **testnet only**. Never point `STELLAR_NETWORK=mainnet` at a local test environment.

### Run unit and integration tests

```bash
# From backend/keepers/
npm test
```

Tests mock the Stellar SDK and Redis — no live network calls are made.

### Manually trigger a compound job (testnet)

```bash
# Enqueues a one-off compound job for the configured vault
VAULT_CONTRACT_ID=<your-testnet-vault-id> \
KEEPER_SECRET_KEY=<your-testnet-key> \
STELLAR_NETWORK=testnet \
node -e "
const { createCompoundQueue } = require('./dist/queues');
const q = createCompoundQueue();
q.add('manual-compound', { vaultContractId: process.env.VAULT_CONTRACT_ID, minHarvestAmount: '0' });
console.log('Job enqueued');
"
```

### Inspect queued and failed jobs

```bash
# Connect to Redis and list BullMQ keys
redis-cli keys "bull:*"

# Count jobs in each state
redis-cli llen bull:liquidation:wait
redis-cli llen bull:compound:wait
redis-cli zcard bull:liquidation:failed
redis-cli zcard bull:compound:failed
```

### Simulate a VaultMonitor scan (dry run)

Set `SCAN_INTERVAL_MS=0` (disabled) and call the monitor once manually:

```bash
SCAN_INTERVAL_MS=9999999 npm run dev
# In another terminal, send SIGUSR2 or add a one-shot scan path (see monitors/VaultMonitor.ts)
```

---

## Monitoring

The keeper emits structured JSON logs via [Pino](https://getpino.io/). In production, pipe stdout to your log aggregator (Datadog, Loki, CloudWatch, etc.).

### Key log fields to alert on

| Log event | Field | Alert condition |
|---|---|---|
| Liquidation job failed | `"Liquidation job failed"` | Any occurrence |
| Compound job failed | `"Compound job failed"` | Any occurrence |
| Signer error | `"err"` containing `"KeeperSigner"` | Any occurrence |
| VaultMonitor scan failed | `"[VaultMonitor] Scan failed"` | Any occurrence |
| High failed-job count | BullMQ `failed` set size | > 10 |

### Health endpoint

The keeper exposes a lightweight HTTP health endpoint on port `3002` (configurable):

```bash
curl http://localhost:3002/health
# {"status":"ok","queues":{"liquidation":"running","compound":"running"}}
```

---

## Restarting a Keeper

Graceful restart (drains in-progress jobs before exit):

```bash
# Send SIGTERM — the keeper calls worker.close() and redis.disconnect()
kill -SIGTERM <pid>
```

Hard restart (loses in-progress jobs — use only if the process is hung):

```bash
kill -9 <pid>
# BullMQ will automatically re-queue stalled jobs on next startup
```

For systemd deployments:

```bash
systemctl restart stellar-yield-keeper
```

---

## Troubleshooting

### Redis connection failures

**Symptom:** Keeper exits at startup with `ECONNREFUSED` or BullMQ throws `Redis connection failed`.

**Checks:**
1. Verify Redis is running: `redis-cli ping` should return `PONG`.
2. Check `REDIS_URL` in `.env` matches the running Redis address and port.
3. If Redis requires a password, include it in the URL: `redis://:password@host:6379`.
4. For TLS Redis (Upstash, Redis Cloud), use `rediss://` scheme.

**Fix:**
```bash
docker start redis-keeper         # if using Docker
# or
brew services start redis         # macOS Homebrew
# or
systemctl start redis             # Linux systemd
```

---

### Signer / keypair failures

**Symptom:** `KEEPER_SECRET_KEY is not set` at startup, or `TransactionSubmissionError` during job processing.

**Checks:**
1. Confirm `KEEPER_SECRET_KEY` is set and starts with `S` (Stellar secret key format).
2. Verify the keeper account is funded: `stellar account balance --source <public-key> --network testnet`.
3. Check the account has enough XLM for fees (`BASE_FEE` × concurrency × number of pending jobs).
4. If using a KMS, confirm the KMS role/credentials are reachable from the keeper host.

**Fix:**
```bash
# Fund testnet keeper account
stellar keys fund <public-key> --network testnet

# Verify key is valid
stellar keys address <name>
```

---

### Queue stalls / jobs not processing

**Symptom:** Jobs accumulate in the `wait` list; workers are running but nothing processes.

**Checks:**
1. Confirm workers are connected: check logs for `[LiquidationWorker]` / `[CompoundWorker]` startup messages.
2. Check for stalled jobs: BullMQ marks a job as stalled if a worker crashes mid-processing. Stalled jobs are automatically requeued on worker reconnect.
3. Check concurrency: if `LIQUIDATION_CONCURRENCY` or `COMPOUND_CONCURRENCY` is set too low for your load, increase it.
4. Check for a Redis memory limit (`maxmemory` setting) that is causing evictions.

**Fix:**
```bash
# Manually retry all failed jobs
redis-cli zrange bull:liquidation:failed 0 -1 WITHSCORES

# Via BullMQ dashboard (if installed):
# npx @bull-board/cli
```

---

### Jobs failing repeatedly

**Symptom:** The BullMQ failed set grows; logs show repeated `LiquidationWorker job failed` or `CompoundWorker job failed`.

**Checks:**
1. Read the `err` field in the failure log for root cause.
2. Common causes:
   - **`InsufficientBalance`** — keeper account is out of XLM. Top up the account.
   - **`TransactionSubmissionError: tx_bad_seq`** — sequence number conflict from concurrent workers. Reduce `LIQUIDATION_CONCURRENCY` to `1` temporarily.
   - **`ContractError`** — the on-chain call reverted. Check the contract logs; the position may have already been liquidated by another keeper.
   - **`HostError`** — Soroban resource limit exceeded. Increase `BASE_FEE` or the resource budget in `KeeperSigner`.

**Fix:**
```bash
# After fixing the root cause, move failed jobs back to the wait queue
# (use BullMQ's retryJobs API or the Bull Board UI)
```

---

### VaultMonitor not finding liquidatable positions

**Symptom:** No liquidation jobs are being enqueued despite undercollateralised CDPs existing on-chain.

**Checks:**
1. Confirm `STABLECOIN_MANAGER_CONTRACT_ID` points to the correct contract on the correct network.
2. Confirm `MCR_BPS` matches the contract's maintenance ratio. If the contract uses 120% (12000 bps) but `MCR_BPS=11000`, positions between 110%–120% are missed.
3. Confirm `MONITORED_ADDRESSES` is set if the keeper is relying on a manual list rather than an indexer.
4. Check Soroban RPC connectivity: `curl $STELLAR_SOROBAN_RPC_URL/health`.

---

*For general Stellar/Soroban questions see the [Stellar Developer Docs](https://developers.stellar.org/docs).*
