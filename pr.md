## Summary
This PR implements critical fixes, performance security enhancements, and robust verification tests across four key areas for the StellarYield platform:

1. **Checked Arithmetic & Precision-Preserving Fees (Issue #714)**:
   - Modified `settle_batch` in the `settlement` contract to enforce checked addition (`checked_add`) for `total_amount0` and `total_amount1` against individual trade values.
   - Refactored `collect_fees` to implement standard half-up rounding for fee calculations (`(amount * fee_bps + 5000) / 10000`).
   - Resolved Soroban authentication conflicts in tests by using `mock_all_auths_allowing_non_root_auth()`.
   - Added comprehensive integration and unit tests covering sum validation, negative amounts, mismatch panics, and fee rounding logic.

2. **Cross-Protocol Yield Opportunity Ranking Engine (Issue #248)**:
   - Implemented `server/src/services/opportunityRankingService.ts` with min-max normalization to rank opportunities across Stellar DeFi protocols.
   - Exposed `/api/yields/ranking` route in `server/src/routes/yields.ts` supporting custom APY, TVL, liquidity, maturity, and volatility weight inputs.
   - Verified the engine via extensive unit tests in `server/src/__tests__/opportunityRankingService.test.ts`.

3. **Secure Backend proxy for secrets & CI guardrails (Issue #717)**:
   - Added `/api/offramp` proxy endpoint under `server/src/routes/offramp.ts` to keep `OFFRAMP_API_KEY` server-side, preventing API key exposure to the browser.
   - Refactored `offRampService.ts` and `GoogleSheetsPanel.tsx` to remove direct exposure of `VITE_OFFRAMP_API_KEY` and `VITE_GOOGLE_CLIENT_SECRET`.
   - Introduced `scripts/check-frontend-env.js` as a CI check that automatically scans frontend builds and `.env` files to reject browser-exposed secrets.

4. **Rewards Merkle Distributor Integration (Issue #719)**:
   - Connected off-chain Merkle generator outputs to the `merkle_distributor` contract's validation logic.
   - Implemented `backend/rewards/src/__tests__/merkleDistributorIntegration.test.ts` verifying the encoding invariant (off-chain SHA-256 vs. on-chain `compute_leaf`), anti-double-claim bitmap tracking, and cross-epoch root rotation.

## Linked Issues
- Closes #714
- Closes #719
- Closes #717
- Closes #248

## Change Type
- [x] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [x] Documentation update
- [x] Refactor
- [ ] Other (please describe):

## Testing
- **Smart Contracts**: Ran `cargo test --package settlement --lib` (10/10 passing).
- **Backend Rewards**: Ran `npm run test` (49/49 passing).
- **CI Env Guardrail**: Verified `scripts/check-frontend-env.js` catches unsafe `VITE_` variables and exits with non-zero code.

### Checklist
- [x] Frontend changes tested
- [x] Backend changes tested
- [x] Contracts changes tested
- [x] Documentation updated
- [ ] Migrations tested (if applicable)

## Deployment Notes
- Set `OFFRAMP_API_KEY` and `GOOGLE_CLIENT_SECRET` in the backend environment variables. Do not prefix them with `VITE_` as they are now securely proxied via backend routers.
