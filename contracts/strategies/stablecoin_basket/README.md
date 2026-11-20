# Adaptive Stablecoin Basket Strategy

## Overview

The `stablecoin_basket` strategy contract manages capital routing across a diversified basket of stablecoin assets based on:
- Admin-configured target weights per asset (summing to 10,000 basis points).
- Maximum single-asset concentration limits (to avoid excessive single-protocol exposure).
- Admin-managed token allowlisting.
- Rebalance drift threshold detection to avoid dust-trade griefing.
- Proportional multi-asset redemptions with strict asset conservation under uneven decimals.

## Key Entrypoints

- `initialize(admin, asset_configs, rebalance_threshold_bps)`: Configures initial assets, weights, and drift thresholds.
- `deposit(depositor, token, amount)`: Transfers allowlisted stablecoin into the strategy, verifying concentration caps and minting proportional pool shares.
- `mint_shares(to, shares)`: Admin-gated share allocation for liquidity seeding and vault integrations.
- `redeem(redeemer, shares)`: Liquidates shares and transfers proportional raw units of all basket assets to the caller.
- `preview_redeem(shares)`: Simulates proportional redemption, returning calculated raw units and remainders without state mutation.
- `compute_rebalance_deltas()`: Calculates per-asset drift relative to target weights.
- `pause()`, `unpause()`: Admin-controlled emergency circuit breaker.

## Uneven Decimals & Asset Conservation

In cross-protocol baskets, stablecoins frequently operate on different raw decimal scales (e.g. USDC with 6 decimals, XLM with 7 decimals, and DAI/USDS with 18 decimals):

1. **Raw-Unit Proportional Calculation**:
   Payouts are computed via integer floor division per asset:
   $$\text{payout}_i = \lfloor \frac{\text{shares} \times \text{balance}_i}{\text{total\_shares}} \rfloor$$
2. **Explicit Remainder Treatment**:
   The fractional remainder:
   $$\text{remainder}_i = (\text{shares} \times \text{balance}_i) \pmod{\text{total\_shares}}$$
   is strictly conserved inside the contract's reserve and returned in `AssetRedemption.remainder` for full accounting transparency.
3. **Strict Solvency Guarantee**:
   Because floor division is applied, $\text{payout}_i \le \text{balance}_i$ at all times. Split redemptions never overdraw the pool ($\sum \text{split payouts} \le \text{one-shot payout}$).
4. **Zero-Dust Final Sweep**:
   When the final outstanding shares are redeemed ($\text{shares} == \text{total\_shares}$), the contract distributes 100% of the remaining token balances, ensuring zero dust remains locked.

## Boundary & Error Behavior

All error scenarios fail closed and preserve state atomically:
- `BasketError::ZeroAmount`: Rejects zero or negative redemption amounts.
- `BasketError::EmptyBasket`: Rejects redemption when `total_shares == 0`.
- `BasketError::InsufficientShares`: Rejects redemption when requested shares exceed user's balance.
- `BasketError::Paused`: Rejects redemptions and deposits when the contract is paused.
- Token transfer failures revert the entire Soroban transaction atomically.

## Local Testing

```bash
cd contracts
cargo test -p stablecoin_basket
```
