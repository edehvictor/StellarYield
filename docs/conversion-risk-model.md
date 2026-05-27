# Cross-Asset Deposit Conversion Risk Model

## Purpose
Quantifies conversion risk when deposited assets must be transformed into vault-compatible assets.

## Core Risk Factors
- Slippage risk
- Liquidity depth
- Timing/path complexity
- Guardrail enforcement

## Aggregate Formula
Risk Score =
(slippagePercent × 0.4) +
(liquidityScore × 0.3) +
(timingRiskScore × 0.3)

## Risk Levels
- Low: <=30
- Medium: <=60
- High: <=80
- Blocked: >80 or failed guardrails

## Security Controls
- Maximum slippage: 2%
- Minimum liquidity: $100k
- Protocol freeze support
- Unsupported route blocking

## Outputs
- Source asset
- Target asset
- Best route
- Alternative routes
- Aggregate score
- Risk level
- Guardrail warnings
- Block status

## Testing Scenarios
- High-liquidity routes
- Low-liquidity routes
- Excessive slippage
- Unsupported assets
- Long-path timing risk
- Guardrail enforcement