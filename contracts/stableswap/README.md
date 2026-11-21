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
- `get_operation_state(sender, kind, operation_id) -> OperationState { committed, state_seq }`
- `get_pool_state() -> PoolState { reserve0, reserve1, total_supply, state_seq }`
- `add_liquidity_checked(..., operation_id, expected_state_seq)`, `remove_liquidity_checked(..., operation_id, expected_state_seq)`, `swap_checked(..., operation_id, expected_state_seq)` — retry-safe variants
- `preview_add_liquidity_checked`, `preview_remove_liquidity_checked`, `preview_swap_checked` (read-only dry runs of the checked variants)
- pool views and pricing helpers
- `preview_swap(sender, token_in, amount_in, min_out, expected_context, operation_id) -> Diagnostic` (read-only dry run)
- `preview_add_liquidity(sender, amount0, amount1, min_mint_amount, expected_context, operation_id) -> Diagnostic` (read-only dry run)
- `preview_remove_liquidity(sender, lp_amount, min_amount0, min_amount1, expected_context, operation_id) -> Diagnostic` (read-only dry run)

## Diagnostics

`add_liquidity`, `remove_liquidity` and `swap` validate and compute everything
**before** any token transfer or storage write. A failed call therefore leaves
reserves, LP supply, LP balances, token balances and the operation id unchanged,
and can be retried with corrected arguments.

The `preview_*` calls run exactly the same validation (they share the planner
with the real call) without requiring auth or mutating state, and return:

```text
Diagnostic { ok: bool, stage: FailureStage, error_code: u32, remediation: RemediationPath }
```

| `FailureStage`    | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `None`            | No failure                                           |
| `PoolState`       | Not initialized / no usable liquidity                |
| `Context`         | Network, deployment or version context mismatch      |
| `Replay`          | `operation_id` already consumed                      |
| `InputValidation` | Bad amount, unknown token or LP amount above balance |
| `FeeComputation`  | Dynamic fee computation failed                       |
| `Invariant`       | D / y or share math failed or overflowed             |
| `Slippage`        | Result below the caller's minimum                    |
| `StateChanged`    | Pool checkpoint moved since the caller captured it   |

| `RemediationPath` | Suggested action                                     |
| ----------------- | ---------------------------------------------------- |
| `None`            | Nothing to do                                        |
| `InitializePool`  | Initialize the pool first                            |
| `FixInput`        | Correct arguments and retry                          |
| `AddLiquidity`    | Add liquidity or use a smaller size                  |
| `ReduceAmount`    | Reduce the amount and retry                          |
| `RelaxSlippage`   | Loosen `min_out` / `min_mint_amount` / `min_amount*` |
| `ContactAdmin`    | Not caller-fixable                                   |
| `RefreshContext`  | Re-read `get_pool_context()` and retry               |
| `CheckOperation`  | Check `is_operation_consumed` before resubmitting    |
| `RefreshState`    | Re-read `get_pool_state()` and retry with its `state_seq` |

Diagnostics are privacy-safe: they contain only these enums and the numeric
`StableSwapError` code - never addresses, amounts, reserves or balances.

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
- `StateChanged` (16): A `*_checked` call was planned against a pool checkpoint that has since advanced; re-read `get_pool_state()` before retrying.

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

## Partial completion and retry

Every successful mutation commits its reserves, LP accounting, operation receipt
and a monotonically increasing `StateSeq` **before** the token transfers. A
failing transfer reverts the whole invocation, so no half-applied state is ever
observable and the operation id stays unused.

`get_pool_state()` returns the resumable checkpoint
`{ reserve0, reserve1, total_supply, state_seq }`. `get_operation_state(sender,
kind, operation_id)` returns `{ committed, state_seq }`: whether that specific
submission landed and the checkpoint it reached. A legacy pool upgraded to this
version reports `state_seq = 0` until its first mutation.

For a submission whose outcome is unknown (timeout, dropped response), capture
`get_pool_state().state_seq` before sending and use the `*_checked` variants on
retry. They require that checkpoint to still be current:

| Situation | Checked retry result |
|---|---|
| First attempt never landed | state unchanged → retry applies once with the same op id |
| First attempt landed | checkpoint advanced → `StateChanged`, nothing moves |
| Same op id, refreshed checkpoint | `DuplicateOperation`, nothing moves |
| Fresh op id, stale checkpoint | `StateChanged`, so a blind resubmit cannot trade twice |

`StateChanged` is checked before the operation-receipt check, so the caller
first learns that it must re-read the pool (`get_pool_state()` /
`get_operation_state()`) rather than assuming the submission failed. The
ordinary `add_liquidity`, `remove_liquidity` and `swap` entry points and all
event shapes are unchanged; the checked variants are additive.

The `op` event payload remains `(sender, kind, operation_id)`. Indexers that
need the sequence can read it from `get_pool_state()` after the transaction.

## Safety & Invariant Guarantees

- **Boundary Validation**: Untrusted fields (`token0`, `token1`, `lp_token`, `amp_coeff`, `base_fee`, `fee_multiplier`, amounts, and slippage bounds) are validated at contract entry points before state or balance mutation.
- **State & Balance Preservation**: All validations, reserve math and slippage checks run before any storage write or token transfer. The checkpoint is then committed before the transfers; when validation or execution fails, existing state, pool reserves, and user balances remain strictly untouched.
- **Safe Retry**: Failures leave state and balances unmodified, so callers may retry with adjusted parameters. When the outcome is unknown, the `*_checked` entry points bind the retry to the captured `state_seq`, preventing accidental double execution even if the client generates a new operation id.
- **Operation Identity**: `add_liquidity`, `remove_liquidity` and `swap` take a caller-generated `operation_id: BytesN<32>`. The contract stores a receipt keyed by `sha256("stellaryield_stableswap_op_v1" || xdr(contract, sender, kind, operation_id))` atomically with the call's effect, so:
  - resubmitting a call that already succeeded (for example after a lost response or a wallet double-submit) fails with `DuplicateOperation` and moves nothing;
  - a call that failed (including a context mismatch) never consumes its id, so the same id can be retried with fixed parameters or a refreshed context;
  - ids are scoped per deployment, sender and operation kind, so one caller cannot burn another's id.
  Receipts are kept for about 30 days of ledgers (TTL extended to 518 400 ledgers). Use a fresh random id for every new intent, and reuse it only when retrying that same intent.
- **Solver Hardening**: Newton-Raphson solvers (`compute_d` and `compute_y`) validate bounds, guard against non-positive intermediate reserves and zero denominators, and explicitly fail with `MathOverflow` rather than returning unverified approximations on non-convergence.

## Storage Model

- Instance: admin, tokens, amp, reserves, fee parameters, LP accounting metadata, bound network id, context version and `StateSeq`.
- Persistent: LP/user position state where applicable, `Operation(key)` receipts for consumed operation ids and `OperationSeq(key)` checkpoints recording the sequence each one committed at.

## Local Test

```bash
cd contracts
cargo test -p stableswap
```

## Integration Notes

- Fee precision is `1e7` units (`FEE_PRECISION` in code).
