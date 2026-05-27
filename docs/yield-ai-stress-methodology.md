# Yield, AI Timeline, Stress, and Efficiency Methodology

## Net Yield Engine

`netApy` is derived from gross APY after stacked execution drag:

- `protocolFeeBps`
- `vaultFeeBps`
- `rebalanceCostBps`
- `slippageBps`

Formula:

- `feeDragApy = grossApy * (totalBps / 10_000)`
- `netApy = grossApy - feeDragApy`

Bounds and validation:

- Gross APY clamped to `[-100, 1000]`.
- Each assumption clamped to `[0, 3000]` bps.
- Non-finite values are replaced with safe defaults.

API (`GET /api/yields`) now returns:

- `apy` / `totalApy` (gross representation)
- `netApy` / `feeDragApy`
- `netYieldAssumptions`
- `netYieldSensitivity` for low, medium, high fee environments

Optional query overrides:

- `protocolFeeBps`
- `vaultFeeBps`
- `rebalanceCostBps`
- `slippageBps`

## Capital Efficiency Score

Score blends four dimensions:

- Utilization (higher is better)
- Fee drag (lower drag gives higher sub-score)
- Rotation cost (lower cost gives higher sub-score)
- Liquidity depth (log normalized)

Weighted model:

- Utilization: `35%`
- Fee drag: `25%`
- Rotation cost: `20%`
- Liquidity depth: `20%`

Outputs:

- `capitalEfficiency.score` (0-100)
- `capitalEfficiency.grade` (A-D)
- `capitalEfficiency.components`
- `capitalEfficiency.hasMissingInputs`

`hasMissingInputs` is used to avoid misleading rankings when metrics are partially unavailable.

## Recommendation Timeline

Timeline endpoint stores historical recommendation snapshots:

- `POST /api/recommend` creates a recommendation and records rationale evolution
- `GET /api/recommend/timeline?userId=...` returns ordered history

Each entry includes:

- recommendation text
- rationale text
- timestamp
- changed input keys (`changedInputs`) relative to previous entry

Safety:

- rationale strings are sanitized to redact key/token-like sequences
- text payloads are bounded to avoid storage abuse

## Stress Scenario Simulation

Simulation endpoint:

- `POST /api/stress-scenarios/run`

Supported scenarios:

- `apy-collapse`
- `liquidity-drain`
- `oracle-shock`

Each result includes:

- `projectedFinalValueUsd`
- `expectedLossUsd`
- `expectedLossPct`
- `recoveryDaysEstimate`
- `exposureBreakdown` (yield/liquidity/oracle exposure)

Simulation responses are intentionally isolated from live transaction execution and only model hypothetical outcomes.
