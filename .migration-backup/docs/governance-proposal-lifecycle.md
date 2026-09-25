# Governance Proposal Lifecycle

StellarYield uses a multi-signature (multi-sig) governance model to protect admin operations on the YieldVault contract. Any action that changes protocol parameters — fees, keepers, admin address, or an emergency pause — must be approved by a threshold of designated signers before it can be executed on-chain.

This document explains each stage of a proposal's lifecycle in plain language, what each participant can do at that stage, and which UI components and services are involved.

---

## How Multi-Sig Works

The governance configuration stores a list of **signer addresses** and a **threshold** (e.g. 2-of-3). A proposal is only executable once at least `threshold` signers have attached their cryptographic signature to the transaction XDR.

Configuration is managed in the **Configure Signers** panel on the Governance dashboard (`client/src/pages/governance/GovernanceDashboard.tsx`). The default contract ID is read from the `VITE_CONTRACT_ID` environment variable.

---

## Lifecycle Stages

### 1. Proposed (`pending`)

**What it means:** A signer used the Transaction Builder to assemble an admin action. The transaction XDR has been created and stored locally. The proposal is now waiting for enough co-signers to reach the threshold.

**How it gets here:** A wallet address that is in the signer list opens the Transaction Builder (`client/src/pages/governance/TransactionBuilder.tsx`), selects an admin action (e.g. `set_keeper_fee`), fills in the parameters, and clicks **Simulate & Build**. The resulting `PendingTransaction` object is added to the store with `status: "pending"`.

**What signers can do:**
- Review the proposal description and arguments on the `PendingTransactionCard`.
- Click **Sign** to attach their Freighter wallet signature.

**What non-signers can do:**
- View the proposal and its current signature count.
- Cannot sign or execute.

**What nobody can do yet:**
- Execute the transaction on-chain (threshold not reached).

---

### 2. Ready (`ready`)

**What it means:** The required number of signatures has been collected. The proposal is now eligible to be submitted to the Soroban network.

**How it gets here:** The `useGovernanceStore` hook (`client/src/pages/governance/useGovernanceStore.ts`) automatically promotes a transaction from `"pending"` to `"ready"` each time a signature is added and the total reaches the configured threshold.

**What signers can do:**
- Click **Execute** on the `PendingTransactionCard` to submit the assembled XDR to the Soroban RPC.
- Any signer can trigger execution — it does not have to be the original proposer.

**What non-signers can do:**
- View the proposal and the full list of signers.
- Cannot execute.

**What nobody can do:**
- Add more signatures (the proposal already qualifies).
- Roll back the proposal without a separate governance action.

---

### 3. Completed (`executed`)

**What it means:** The transaction has been submitted to the network and confirmed. The admin action is now in effect on-chain.

**How it gets here:** A signer clicked **Execute** and the `submitSignedXdrAndPoll` service call returned a successful result. The store marks the transaction `"executed"` via `markExecuted`.

**What anyone can do:**
- Review the completed transaction in the **Executed Transactions** list on the Governance dashboard.

**What nobody can do:**
- Undo the action. Reversing a parameter change requires a new governance proposal.

---

### 4. Expired (`expired`)

**What it means:** The proposal did not collect enough signatures before its deadline and is no longer actionable.

**How it gets here:** The `useGovernanceStore` hook sets a transaction to `"expired"` when it is checked and has passed its `createdAt` + expiry window without reaching the threshold.

**What anyone can do:**
- View the expired proposal for audit purposes.
- A signer can create a new proposal for the same action if it is still needed.

**What nobody can do:**
- Revive the expired proposal. A fresh proposal must be built and signed from scratch.

---

## Stage Transition Summary

```
[Signer builds proposal]
        |
        v
    PROPOSED (pending)
   Collecting signatures
        |
        | threshold reached (auto-promoted by useGovernanceStore)
        v
    READY (ready)
   Awaiting execution
        |
        | signer clicks Execute
        v
   COMPLETED (executed)      ← permanent
        
   OR if deadline passes without threshold:
        |
        v
    EXPIRED (expired)        ← create a new proposal to retry
```

---

## Using the Forecast Tool Before Proposing

Before creating a proposal, signers can use the **Impact Forecast** panel (`client/src/pages/governance/GovernanceForecast.tsx`) to preview the expected effect on yield, exposure, and fee revenue. This is especially useful for `fee_change`, `allocation_limit`, and `strategy_param` actions. The forecast calls the backend at `/api/governance/forecast` and displays warnings when the projected impact exceeds safe thresholds.

Running a forecast is optional but strongly encouraged for parameter changes that affect user funds.

---

## Relevant Files

| File | Purpose |
|---|---|
| `client/src/pages/governance/GovernanceDashboard.tsx` | Main governance page; lists proposals by stage |
| `client/src/pages/governance/TransactionBuilder.tsx` | Creates new proposals (signers only) |
| `client/src/pages/governance/PendingTransactionCard.tsx` | Displays a proposal with sign/execute actions |
| `client/src/pages/governance/useGovernanceStore.ts` | State management; auto-promotes pending → ready |
| `client/src/pages/governance/GovernanceForecast.tsx` | Impact preview before proposing |
| `client/src/pages/governance/types.ts` | TypeScript interfaces for proposals and config |
| `client/src/pages/governance/governanceActions.ts` | Definitions of all supported admin actions |
