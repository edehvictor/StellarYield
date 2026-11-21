# CLMM Core

The pool records a SHA-256 fingerprint of its token addresses, fee, and tick spacing when initialized, and binds its state to the live network ID and storage version (`CURRENT_POOL_VERSION = 1`). Each newly minted position stores that configuration fingerprint alongside its position state.

- `mint`, `burn`, `collect`, and `swap` require `expected_context: PoolContext` (captured via `get_pool_context()`) and reject network, deployment, or version mismatches with `WrongNetwork`, `WrongContract`, or `WrongVersion` before any position read, math, transfer, or state write.
- Read views (`get_position`, `get_position_sequence`, `get_current_tick`, `get_sqrt_price`, `get_liquidity`) enforce live network and version compatibility.
- Legacy pools initialized before context binding adopt the live network at version `0` until `migrate()` pins the binding to version `1` without touching positions or balances.
- `mint`, `burn`, and `collect` reject work with `StaleConfiguration` if the live pool configuration differs from its initialization fingerprint or the position snapshot is absent or different.

Correct a configuration or context mismatch before retrying the operation. A rejected operation leaves position accounting, pool state, token balances, and operation identities unchanged.
