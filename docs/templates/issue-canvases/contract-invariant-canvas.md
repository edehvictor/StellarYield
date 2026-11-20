# Smart Contract Canvas: [Contract / Invariant Name]

> **Template Instructions**: Use this canvas when authoring, modifying, or upgrading Soroban smart contracts, storage schemas, mathematical invariants, or fee distribution rules.

---

## Overview & Contract Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Smart Contract & Invariant Canvas` | Soroban contract design specification |
| **Issue / PR #** | `#[Issue Number]` | Associated GitHub issue |
| **Author / Engineer** | `@[GitHub Handle]` | Lead contract developer |
| **Contract Name** | `[e.g. yield-router / vault-core / donation-vault]` | Target contract package |
| **Network** | `Standalone / Testnet / Futurenet / Mainnet` | Target Stellar deployment network |
| **Storage Type** | `Instance / Persistent / Temporary` | Soroban storage lifetimes used |
| **Audit Status** | `Pending / In-Review / Approved / Exempt` | Security audit status |
| **Risk Rating** | `Low` / `Medium` / `High` / `Critical` | Financial and execution risk rating |

---

## Purpose & Architectural Scope

### Contract Responsibility
Describe what this contract is responsible for within the StellarYield protocol architecture.

### Interaction Flow
```
User / Keeper ---> [YieldRouter] ---> [VaultManager] ---> [Soroban Token]
```

> [!NOTE]
> Soroban smart contracts must be built with deterministic resource usage and minimal footprint to avoid hitting transaction gas and byte limits.

---

## Mathematical Model & Protocol Invariants

> [!IMPORTANT]
> The contract must maintain mathematical and state invariants across all execution paths and re-entrancy possibilities.

### 1. Conservation of Yield
$$\text{Yield}_{\text{total}} = \text{Yield}_{\text{user}} + \text{Fee}_{\text{protocol}} + \text{Donation}_{\text{pool}}$$

### 2. Share-to-Asset Conservation
$$\text{Shares}_{\text{minted}} = \frac{\text{Assets}_{\text{deposited}} \times \text{Shares}_{\text{total}}}{\text{Assets}_{\text{total}}}$$

### 3. Non-Negative Balance Invariants
- Total vault debt can never exceed total vault collateral: $\text{Debt} \le \text{Collateral} \times \text{LTV}_{\text{max}}$.
- No user share balance can underflow or exceed total supply.

---

## Storage Schema & State Lifecycle

```rust
#[contracttype]
pub enum DataKey {
    Admin,
    VaultConfig(Address),
    UserPosition(Address),
    TotalShares,
    LastRebalanceLedger,
}
```

| Key | Storage Lifetime | TTL Management / Bump Policy | Description |
| :--- | :--- | :--- | :--- |
| `DataKey::Admin` | **Instance** | Bump on admin interactions | Protocol admin address |
| `DataKey::VaultConfig` | **Persistent** | Bumped by keeper on rebalance | Global configuration & parameters |
| `DataKey::UserPosition`| **Persistent** | Extended on deposit/withdraw | User position, shares, and timestamps |
| `DataKey::TempCache` | **Temporary** | Ephemeral per execution | Intermediate computation scratchpad |

> [!WARNING]
> Ensure all Persistent storage keys implement automatic TTL extension using `env.storage().persistent().extend_ttl(...)` to avoid archived state locks.

---

## Authorization & Access Control Matrix

| Function Entrypoint | Caller Requirement | Auth Check Syntax | Risk Level |
| :--- | :--- | :--- | :--- |
| `initialize(...)` | Deployer / Deployer Key | `admin.require_auth()` | High |
| `deposit(...)` | Depositor Address | `from.require_auth()` | Medium |
| `rebalance(...)` | Authorized Keeper Role | `keeper.require_auth()` | High |
| `emergency_pause()` | Emergency Multigov / Admin | `admin.require_auth()` | Critical |

> [!CAUTION]
> Never omit `.require_auth()` on state-modifying functions. Every external entrypoint accepting caller addresses must strictly enforce signature verification.

---

## Interface Specification (Functions, Events, Errors)

### Public Entrypoints
```rust
pub fn deposit(env: Env, from: Address, amount: i128) -> Result<i128, Error>;
pub fn withdraw(env: Env, to: Address, shares: i128) -> Result<i128, Error>;
pub fn rebalance(env: Env, keeper: Address, strategy_id: Symbol) -> Result<(), Error>;
```

### Events Emitted
- `topics: (Symbol::short("deposit"), from), data: (amount, shares)`
- `topics: (Symbol::short("rebalance"), strategy_id), data: (yield_generated, timestamp)`

### Custom Error Codes
```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    InsufficientBalance = 2,
    SlippageExceeded = 3,
    VaultPaused = 4,
    InvalidFeeConfiguration = 5,
}
```

---

## Economic Attack Surface & Threat Analysis

- **Flash-Loan / Flash-Deposit Resistance**: Minimum holding period or withdrawal queue delays.
- **Oracle Manipulation Defense**: Multi-source price verification and TWAP smoothing.
- **Rounding & Precision Direction**:
  - Vault deposits round down shares in favor of the vault.
  - Vault withdrawals round down assets in favor of the vault.

---

## Verification, Fuzzing & Gas Profiling

### Local Verification Commands
```bash
# Contract formatting & clippy analysis
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# Execute contract unit and invariant test suites
cargo test --workspace -- --nocapture
```

### Fuzzing & Property-Based Testing
- [ ] Proptest / quickcheck invariants written for deposit-withdraw roundtrips.
- [ ] Math tested against boundary values (`i128::MAX`, zero, `1 stroop`).
- [ ] Gas budget and CPU instruction limits profiled.

---

## Deployment, Migration & Upgrade Plan

1. **Build Optimized WASM**:
   ```bash
   soroban contract build --package <contract-name>
   soroban contract optimize --wasm target/wasm32-unknown-unknown/release/<name>.wasm
   ```
2. **Deploy to Testnet**:
   ```bash
   soroban contract deploy --wasm ... --source-account <key> --network testnet
   ```
3. **Initialize State**: Execute contract initialization transaction.
4. **Update Frontend & Backend Registry**: Register contract ID in `shared/contracts.ts` and `docs/contracts_registry.md`.

---

## Definition of Done Checklist

- [ ] All functions include explicit `require_auth()` where appropriate.
- [ ] All arithmetic uses checked operations (`checked_add`, `checked_mul`, etc.).
- [ ] Storage keys have defined TTL extension policies.
- [ ] Rounding direction protects vault solvency.
- [ ] Comprehensive unit tests cover unauthorized callers and error conditions.
- [ ] Gas profile is within acceptable network limits.
- [ ] Contract documentation and registry updated.
