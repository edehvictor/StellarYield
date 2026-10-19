# Feature Canvas: [Feature Name]

> **Template Instructions**: Use this canvas when scoping, architecting, and implementing end-to-end features, yield strategies, or major UI/backend services. Complete all relevant sections before opening a pull request.

---

## Overview & Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Feature & Epic Canvas` | Full-stack feature specification |
| **Issue / PR #** | `#[Issue Number]` | Associated GitHub issue |
| **Owner / Author** | `@[GitHub Handle]` | Lead developer / owner |
| **Target Milestone** | `[e.g. v1.5.0 / Stellar Wave 3]` | Target release cycle |
| **Status** | `Draft` / `In Review` / `Approved` / `In Progress` / `Complete` | Current progress status |
| **Risk Level** | `Low` / `Medium` / `High` / `Critical` | Risk to user funds or system uptime |
| **Affected Areas** | `[e.g. Frontend, Backend, Contracts, SDK]` | Components touched |
| **Dependencies** | `[e.g. Issue #1020, Prisma migration]` | Prerequisite tasks or contracts |

---

## Problem Statement & Motivation

### Background Context
Describe the current state of the application and the user or protocol pain point being resolved.

### User Need
Explain who benefits from this feature (e.g., liquidity providers, vault keepers, protocol governance) and why this capability is necessary now.

> [!NOTE]
> Link to relevant user feedback, governance proposals, or roadmap milestones to provide strategic context.

---

## User Stories & Key Personas

- **As a [User Persona]**, I want to **[Action / Goal]** so that **[Benefit / Value]**.
- **As a [User Persona]**, I want to **[Action / Goal]** so that **[Benefit / Value]**.
- **As a [User Persona]**, I want to **[Action / Goal]** so that **[Benefit / Value]**.

---

## Technical Architecture & System Design

```
+------------------+         +------------------+         +----------------------+
|  React Frontend  |  <--->  |  Express/Prisma  |  <--->  |  Soroban Smart       |
|  (client/)       |         |  Server (server/)|         |  Contracts (contracts)|
+------------------+         +------------------+         +----------------------+
```

### 1. Frontend Architecture (`client/`)
- **Components to add/modify**:
- **State Management**:
- **Hooks & Data Fetching**:
- **Responsive Layout & Design Tokens**:

> [!TIP]
> Ensure all interactive elements have unique `id` attributes and adhere to accessibility (a11y) standards.

### 2. Backend Architecture (`server/` / `backend/`)
- **API Endpoints**:
  - `GET /api/v1/...` - Description
  - `POST /api/v1/...` - Description
- **Database Schema / Prisma Models**:
- **Background Jobs / Keepers**:

### 3. Smart Contracts & Protocol Interaction (`contracts/`)
- **Target Contracts**:
- **New Entrypoints / Functions**:
- **Cross-Contract Invocations**:

---

## Protocol Invariants & Constraints

> [!IMPORTANT]
> Define non-negotiable state, arithmetic, and security invariants that must remain unbroken.

1. **Conservation of Yield**: `Total Assets In == Total Assets Distributed + Protocol Fees + Reserve Buffer`
2. **Authorization**: Only verified vault managers or authorized keepers can invoke privileged methods.
3. **Bounded Slippage**: Slippage tolerances must not exceed the protocol ceiling (`MAX_SLIPPAGE_BPS = 500`).

---

## Edge Cases, Failure Modes & Fallbacks

| Scenario / Failure Mode | Expected System Behavior | Fallback / Recovery Plan |
| :--- | :--- | :--- |
| **RPC / Horizon Node Timeout** | Return cached state with `stale: true` flag | Polling backoff with visual stale indicator |
| **Insufficient Liquidity** | Reject transaction with descriptive error | Route through secondary fallback pool |
| **Transaction Simulation Revert** | Catch simulation error before wallet prompt | Surface exact revert reason to user |

> [!WARNING]
> If a state transition fails midway, the database and off-chain indexer must reconcile against on-chain state without data corruption.

---

## UI Snapshots & Visual Checklist (If Frontend Modified)

> [!NOTE]
> Per repo policy, any visual changes require responsive snapshots across all three primary breakpoints.

- [ ] **Desktop (1024px+)**: Full view layout, table views, and modal dialogs verified.
- [ ] **Tablet (768px)**: Collapsed navigation, wrapped stats cards, and touch targets verified.
- [ ] **Mobile (375px)**: Stacked layout, responsive tables, and sticky actions verified.
- [ ] **Theme Parity**: Dark mode and light mode contrast verified against WCAG AA standards.

---

## Verification & Testing Matrix

### Automated Test Matrix
| Layer | Test Command | Scope / Coverage |
| :--- | :--- | :--- |
| **Frontend** | `cd client && npm run test` | Unit tests for UI components, custom hooks, and helpers |
| **Backend** | `cd server && npm test` | Integration tests for API endpoints and Prisma models |
| **Contracts** | `cd contracts && cargo test --workspace` | Soroban smart contract logic and invariant tests |
| **Format / Lint** | `npm run validate-workspace` | Code formatting, clippy, and linter compliance |

### Manual Verification Steps
1. Step 1: Initialize local environment (`npm run setup:doctor`).
2. Step 2: Execute happy-path user flow in local dev mode.
3. Step 3: Trigger edge-case conditions (e.g., zero balance, max slippage).
4. Step 4: Validate database state in Prisma Studio.

---

## Rollout, Feature Flags & Telemetry

- **Feature Flag**: `ENABLE_FEATURE_[NAME]` (Default: `false` in staging, `false` in prod)
- **Deployment Prerequisites**: Database migrations applied before backend deployment.
- **Monitoring & Metrics**: Error rate alerts, response latency tracking, event logs.

---

## Acceptance Criteria Checklist

- [ ] Core business logic implemented across all designated layers.
- [ ] Protocol invariants mathematically proven and covered by unit tests.
- [ ] Frontend UI conforms to responsive design requirements with attached screenshots.
- [ ] Documentation updated in `docs/` and user guides.
- [ ] All CI checks pass with zero lint or build warnings.
- [ ] Reviewed and approved by at least two maintainers.

---

## Maintainer & Contributor Notes

<!-- Add any additional notes, trade-offs, or open architectural questions here -->
