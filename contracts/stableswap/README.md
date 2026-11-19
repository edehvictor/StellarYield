# StableSwap Contract

## Purpose

`stableswap` implements low-slippage swaps for correlated assets using an amplified invariant and dynamic fee model.

## Public API (selected)

- `initialize(admin, token0, token1, lp_token, amp_coeff, base_fee, fee_multiplier)`
- `get_pool_context()` returns the pool's network, deployment and version context
- `migrate()` (admin only) binds a legacy pool to the live network and current context version
- `add_liquidity(sender, amount0, amount1, min_mint_amount, expected_context, operation_id)`
- `remove_liquidity(sender, lp_amount, min_amount0, min_amount1, expected_context, operation_id)`
- `swap(sender, token_in, amount_in, min_out, expected_context, operation_id)`
- `is_operation_consumed(sender, kind, operation_id)` (`kind` is `add_liq`, `rem_liq` or `swap`)
- pool views and pricing helpers

## Events

Every successful mutating call also emits `("op",) -> (sender, kind, operation_id)`
so a client can match a landed transaction to the submission it retried.

Init, liquidity, swap (including fee output) and `migrate` events. `migrate`
publishes topics `(migrate,)` with the payload `(admin, network_id, version)`.
Existing init, liquidity and swap event shapes are unchanged.

## Errors

`StableSwapError` includes initialization, invariant, amount, token, and slippage/fee validation errors:
- `AlreadyInitialized` (1): Pool already initialized.
- `NotInitialized` (2): Pool not yet initialized.
- `InvalidAmount` (3): Amount is zero/negative or negative slippage bound.
- `InsufficientLiquidity` (4): Insufficient pool reserves or LP liquidity.
- `InsufficientOutput` (5): Output fell below caller-specified minimum.
- `Unauthorized` (6): Caller is not admin.
- `InvalidAmpCoeff` (7): Amplification coefficient out of bounds (`1..=MAX_A`).
- `InvalidFee` (8): Base fee or total dynamic fee exceeds bounds (`FEE_PRECISION`).
- `MathOverflow` (9): Arithmetic overflow or solver convergence failure.
- `ZeroInvariant` (10): Invariant is zero or fails to increase on liquidity deposit.
- `InvalidToken` (11): Duplicate token pair, LP token used as pool asset, or unrecognized token in swap.
- `WrongNetwork` (12): Live ledger or the caller's context belongs to another network than the pool's bound state, or `migrate` would re-bind it.
- `WrongContract` (13): The caller's context names a different pool deployment.
- `WrongVersion` (14): Stored state or the caller's context is not at the supported pool context version.
- `DuplicateOperation` (15): `operation_id` was already consumed by a successful call of the same kind from the same sender.

## Pool Context Binding

A pool's state is bound to an explicit context: the network it was created on
(`SHA-256` of the network passphrase), its deployment address, and a context
version. `get_pool_context()` returns it; pass that value to every state-mutating
call (`add_liquidity`, `remove_liquidity`, `swap`).

Validation runs before any reserve math, token transfer or storage write:

1. the live ledger network must equal the network the stored state is bound to
   (`WrongNetwork`), so a snapshot restored on another chain is rejected instead
   of being traded against;
2. the caller's `network_id` must equal the bound network (`WrongNetwork`);
3. the caller's `contract` must be this deployment (`WrongContract`);
4. the stored and caller's `version` must both match the supported
   `CURRENT_POOL_VERSION` (`WrongVersion`), so code running against an unknown
   (newer or downgraded) storage layout refuses to interpret it.

`get_reserves()` applies the same live-network check, because it is the read
used to price swaps.

### Legacy pools and `migrate`

Pools initialized before context binding have no stored network or version. They
continue to operate unchanged: the pool adopts the live network and reports
version `0`. An admin can call `migrate()` to persist that binding and set the
version to `CURRENT_POOL_VERSION`; migration is idempotent, changes no reserves,
LP supply or balances, and refuses (`WrongNetwork`) to re-bind a pool already
bound to another network.

### Retries

A rejected call changes nothing, so a caller that captured a context before a
migration can refresh it with `get_pool_context()` and retry the same operation.

## Safety & Invariant Guarantees

- **Boundary Validation**: Untrusted fields (`token0`, `token1`, `lp_token`, `amp_coeff`, `base_fee`, `fee_multiplier`, amounts, and slippage bounds) are validated at contract entry points before state or balance mutation.
- **State & Balance Preservation**: Token transfers and storage mutations occur only after all validations, reserve math, and slippage checks succeed. When validation or execution fails, existing state, pool reserves, and user balances remain strictly untouched.
- **Safe Retry**: Because failures leave state and balances unmodified, callers may safely retry operations immediately with adjusted slippage bounds or valid parameters without risk of fund lockup or state corruption.
- **Operation Identity**: `add_liquidity`, `remove_liquidity` and `swap` take a caller-generated `operation_id: BytesN<32>`. The contract stores a receipt keyed by `sha256("stellaryield_stableswap_op_v1" || xdr(contract, sender, kind, operation_id))` only after the call's effect is applied, so:
  - resubmitting a call that already succeeded (for example after a lost response or a wallet double-submit) fails with `DuplicateOperation` and moves nothing;
  - a call that failed (including a context mismatch) never consumes its id, so the same id can be retried with fixed parameters or a refreshed context;
  - ids are scoped per deployment, sender and operation kind, so one caller cannot burn another's id.
  Receipts are kept for about 30 days of ledgers (TTL extended to 518 400 ledgers). Use a fresh random id for every new intent, and reuse it only when retrying that same intent.
- **Solver Hardening**: Newton-Raphson solvers (`compute_d` and `compute_y`) validate bounds, guard against non-positive intermediate reserves and zero denominators, and explicitly fail with `MathOverflow` rather than returning unverified approximations on non-convergence.

## Storage Model

- Instance: admin, tokens, amp, reserves, fee parameters, LP accounting metadata, bound network id and context version.
- Persistent: LP/user position state where applicable, and `Operation(key)` receipts for consumed operation ids.

## Local Test

```bash
cd contracts
cargo test -p stableswap
```

## Integration Notes

- Fee precision is `1e7` units (`FEE_PRECISION` in code).
