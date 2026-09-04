# Issue Canvas Style Guide & Specification

This specification defines the uniform structural standards, heading hierarchies, metadata formats, and callout conventions for all **Issue Canvases** in the StellarYield repository.

---

## 🎯 Purpose of Issue Canvases

An **Issue Canvas** is a structured, living specification document used across the lifecycle of complex issues, epics, smart contract changes, refactorings, security remediations, and contributor tasks. Canvases ensure:

1. **Clarity & Completeness**: Every critical aspect (architecture, security, invariants, test plan, rollout) is addressed before code is merged.
2. **Predictable Headings**: Maintainers, reviewers, and contributors can scan and locate information instantly.
3. **Actionable Invariants**: Protocol constraints and security considerations are explicitly surfaced.
4. **Transparent Verification**: Clear commands and checklists eliminate ambiguity during code review and CI verification.

---

## 📐 Standard Heading Hierarchy

All canvas templates follow a strict four-level heading hierarchy:

| Level | Syntax | Purpose | Example |
| :--- | :--- | :--- | :--- |
| **H1** | `# [Canvas Title]` | Document title and identifier | `# Feature Canvas: Dynamic Yield Allocation Engine` |
| **H2** | `## [Section Name]` | Primary lifecycle or architectural phases | `## Technical Architecture & System Design` |
| **H3** | `### [Sub-section]` | Specific components, services, or layers | `### Smart Contracts & Protocol Interaction` |
| **H4** | `#### [Granular Area]` | File-level or granular item breakdowns | `#### [MODIFY] YieldRouter.sol` |

> [!IMPORTANT]
> Never skip heading levels (e.g., jumping from `##` to `####`). Consistent hierarchy ensures screen reader accessibility and clean table of contents generation.

---

## 📋 Standard Metadata Schema

Every canvas must begin with a standardized metadata table immediately following the H1 title:

```markdown
## Overview & Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Feature` / `Bug` / `Contract` / `Architecture` / `Security` / `Task` | Canvas classification |
| **Issue / PR #** | `#XXXX` / `Pending` | Linked tracking ticket |
| **Owner / Author** | `@username` | Lead author or assignee |
| **Target Milestone** | `v1.4.0` / `Wave-3` | Target release or milestone |
| **Status** | `Draft` / `In Review` / `Approved` / `In Progress` / `Complete` | Lifecycle state |
| **Risk Level** | `Low` / `Medium` / `High` / `Critical` | Protocol and operational risk |
| **Affected Areas** | `Frontend` / `Backend` / `Contracts` / `SDK` / `Docs` | Impacted workspaces |
| **Dependencies** | `#1020`, `Soroban SDK v21` | Blocking items or prerequisites |
```

---

## 📢 Standard Callout Conventions

Canvases utilize GitHub Flavored Markdown alerts to highlight contextual information, warnings, and protocol requirements. Use callouts according to their semantic definitions:

### 1. Note Callout (`> [!NOTE]`)
Used for general background context, architectural scope, cross-references, and non-blocking information.

> [!NOTE]
> This feature extends the existing multi-vault routing engine implemented in `#890`.

### 2. Tip Callout (`> [!TIP]`)
Used for helpful implementation hints, contributor shortcuts, gas optimization recommendations, and development advice.

> [!TIP]
> Run `npm run setup:doctor` before starting local development to verify toolchains and `.env` configs.

### 3. Important Callout (`> [!IMPORTANT]`)
Used for essential requirements, invariant rules, and non-negotiable protocol constraints.

> [!IMPORTANT]
> The conservation invariant must hold across all execution paths: `yield_in == user_yield + protocol_fee + donation_share`.

### 4. Warning Callout (`> [!WARNING]`)
Used for breaking changes, migration risks, backward-incompatibility warnings, and deprecations.

> [!WARNING]
> Updating this storage key format requires a dual-read fallback to prevent bricking active user vault balances.

### 5. Caution Callout (`> [!CAUTION]`)
Used for high-risk operations, potential fund loss scenarios, re-entrancy risks, and sensitive security boundaries.

> [!CAUTION]
> Never log or persist decrypted private keys, mnemonic phrases, or raw transaction authorization secrets.

---

## 🗂️ Available Canvas Templates

| Template | File Path | Primary Use Case |
| :--- | :--- | :--- |
| **Feature & Epic Canvas** | [`feature-canvas.md`](./feature-canvas.md) | End-to-end features, yield strategies, new UI views, and service integrations |
| **Bug Investigation Canvas** | [`bug-investigation-canvas.md`](./bug-investigation-canvas.md) | Deep triage, regression root cause analysis, invariant breaks, and bug fixes |
| **Smart Contract & Invariant Canvas** | [`contract-invariant-canvas.md`](./contract-invariant-canvas.md) | Soroban contract changes, storage layouts, math invariants, and auth scopes |
| **Architecture & Refactor Canvas** | [`architecture-refactor-canvas.md`](./architecture-refactor-canvas.md) | Structural refactoring, schema migrations, state pipelines, and queue managers |
| **Security Remediation Canvas** | [`security-remediation-canvas.md`](./security-remediation-canvas.md) | Vulnerability patches, exploit defense, threat modeling, and emergency containment |
| **Contributor Task Canvas** | [`contributor-task-canvas.md`](./contributor-task-canvas.md) | Well-scoped contributor work packages (Stellar Wave tasks, good-first-issues) |

---

## ✅ Best Practices for Canvas Authors

1. **Be Specific in Acceptance Criteria**: Use unambiguous, testable bullet points with checkboxes.
2. **Explicit Verification Commands**: Include copy-pasteable commands matching CI checks for frontend, backend, and contracts.
3. **Document Invariants Early**: Define mathematical and state invariants before writing code.
4. **Update As You Go**: Treat the canvas as a living document; update design decisions as implementation evolves.
5. **Link from PRs**: Reference the canvas in pull request descriptions to provide full context to reviewers.
