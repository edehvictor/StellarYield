# Liquidity Buffer and Reallocation Planning Assumptions

## Adaptive Liquidity Buffer Guidance (#366)
- Baseline reserve is stress-tiered: low 8%, medium 14%, stressed 22%.
- Stress classification inputs: withdrawal velocity, protocol health score, and liquidity depth versus strategy TVL.
- Ambiguous stress signals trigger an additional conservative +3% guardrail.
- Buffer recommendations are capped at 65% to avoid pathological outputs while preserving solvency posture.

## Cross-Vault Reallocation Timeline Planner (#365)
- Timeline plans are planning artifacts only and never execute by themselves.
- All plans start in `draft` status and can be moved to `paused`, `ready`, or `cancelled`.
- Each step must allocate exactly 100% across vaults.
- Plan updates are blocked once a plan is cancelled.
- Expected fee and recovery window values are informational outputs for staging decisions.

## Yield Confidence Decay Model for Stale Data (#368)
- Confidence now decays continuously (linear, exponential, or stepwise) rather than dropping at one fixed cutoff.
- Policies are configurable per provider/metric through freshness policy fields:
  `freshWindowMs`, `softStaleMs`, `hardStaleMs`, and curve parameters.
- Ranking and recommendation confidence should multiply by freshness confidence so stale entries naturally lose priority.
- Data older than `hardStaleMs` becomes unusable (`confidence=0`, excluded from actionable views).
