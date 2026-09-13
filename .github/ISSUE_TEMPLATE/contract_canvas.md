---
name: Smart Contract Canvas
about: Structured specification canvas for Soroban smart contracts and protocol invariants
title: '[Contract Canvas]: '
labels: ['contracts', 'canvas']
assignees: ''
---

# Smart Contract Canvas: [Contract / Invariant Name]

## Overview & Contract Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Smart Contract & Invariant Canvas` | Soroban contract design specification |
| **Issue / PR #** | `Pending` | Associated tracking issue |
| **Author / Engineer** | `@` | Lead contract developer |
| **Contract Name** | `[e.g. yield-router / vault-core]` | Target contract package |
| **Network** | `Standalone / Testnet / Futurenet / Mainnet` | Target deployment network |
| **Storage Type** | `Instance / Persistent / Temporary` | Soroban storage lifetimes |
| **Audit Status** | `Pending / Approved / Exempt` | Security audit status |
| **Risk Rating** | `Low / Medium / High / Critical` | Risk rating |

---

## Purpose & Architectural Scope

Describe the contract responsibility and interaction flows within StellarYield.

---

## Mathematical Model & Protocol Invariants

> [!IMPORTANT]
> The contract must maintain mathematical and state invariants across all execution paths.

- **Conservation of Yield**: $\text{Yield}_{\text{total}} = \text{Yield}_{\text{user}} + \text{Fee}_{\text{protocol}} + \text{Donation}_{\text{pool}}$
- **Non-Negative Balances**: No share balance or debt position may underflow.

---

## Storage Schema & State Lifecycle

| Key | Storage Lifetime | TTL Management / Bump Policy | Description |
| :--- | :--- | :--- | :--- |
| `DataKey::Admin` | **Instance** | Bump on admin interactions | Protocol admin address |
| `DataKey::VaultConfig` | **Persistent** | Extended on keeper invocation | Vault configuration |
| `DataKey::UserPosition` | **Persistent** | Extended on deposit/withdraw | User position data |

> [!WARNING]
> Ensure all Persistent storage keys implement automatic TTL extension using `extend_ttl(...)` to avoid archived state locks.

---

## Authorization & Access Control Matrix

| Entrypoint | Caller Requirement | Auth Check Syntax | Risk Level |
| :--- | :--- | :--- | :--- |
| `initialize(...)` | Deployer | `admin.require_auth()` | High |
| `deposit(...)` | Depositor | `from.require_auth()` | Medium |
| `rebalance(...)` | Authorized Keeper | `keeper.require_auth()` | High |

> [!CAUTION]
> Every external entrypoint accepting caller addresses must strictly enforce signature verification with `.require_auth()`.

---

## Verification & Fuzzing Matrix

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace -- --nocapture
```

---

## Definition of Done Checklist

- [ ] All functions include explicit `require_auth()` where appropriate.
- [ ] All arithmetic uses checked operations (`checked_add`, `checked_mul`, etc.).
- [ ] Storage keys have defined TTL extension policies.
- [ ] Comprehensive unit and invariant tests written.
- [ ] Contract documentation and registry updated.
