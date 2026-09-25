# Protocol Trust Signals Registry & Scoring Specification

This document specifies the registry schema, scoring weights, and design of the Protocol Trust Signals system, which is used to augment dynamic yield reliability badges.

---

## 1. Schema Definition

Each protocol trust registry entry adheres to the following `ProtocolTrustSignal` schema:

| Field | Type | Description |
|---|---|---|
| `protocolId` | `string` | Unique lowercase identifier of the protocol (e.g. `"blend"`, `"soroswap"`). |
| `protocolName` | `string` | Human-readable name (e.g. `"Blend"`, `"Soroswap"`). |
| `ageMonths` | `number` | The age of the protocol in months since launch. |
| `auditsCount` | `number` | The count of professional smart contract audits completed. |
| `tvlUsd` | `number` | Approximate Current Total Value Locked (TVL) in USD. |
| `incidentHistory` | `Array` | History of protocol exploits, smart contract incidents, or oracle failures. |
| `operationalStatus` | `string` | Current operational state (`"active"`, `"degraded"`, `"maintenance"`). |
| `governanceType` | `string` | Structural administration type (`"dao"`, `"multisig"`, `"centralized"`). |

---

## 2. Scoring Formula & Weights

To transform these multi-dimensional trust signals into a clean `0–1` composite `trustSignal` score, we apply the following scoring logic:

### A. Age (25% Weight)
* **Rationale**: Older protocols have been battle-tested in live environments.
* **Scoring Rules**:
  * `< 3 months`: `0.1`
  * `3 - 12 months`: `0.5`
  * `12 - 24 months`: `0.8`
  * `> 24 months`: `1.0`

### B. Audits (25% Weight)
* **Rationale**: Professional third-party security reviews reduce the likelihood of exploits.
* **Scoring Rules**:
  * `0 audits`: `0.0`
  * `1 audit`: `0.7`
  * `>= 2 audits`: `1.0`

### C. TVL (15% Weight)
* **Rationale**: High TVL shows economic trust and makes exploits more costly/likely to be researched, while also demonstrating liquidity stability.
* **Scoring Rules**:
  * `< $1,000,000`: `0.3`
  * `$1,000,000 - $10,000,000`: `0.7`
  * `> $10,000,000`: `1.0`

### D. Incident History (20% Weight)
* **Rationale**: A history of unresolved incidents poses extreme risk, whereas resolved incidents show team resilience but still suggest slight systemic risk.
* **Scoring Rules**:
  * `0 incidents`: `1.0`
  * `Has incidents, all resolved`: `0.5`
  * `Has unresolved incidents`: `0.0`

### E. Operational Status (15% Weight)
* **Rationale**: Real-time status degradation demands instant reliability downgrades.
* **Scoring Rules**:
  * `"active"`: `1.0`
  * `"degraded"`: `0.4`
  * `"maintenance"`: `0.1`

---

## 3. Sample Protocol Signatures

We maintain a registry containing the following default scores:
- **Blend**: Age 18 months, 2 audits, $12M TVL, 0 incidents, active. -> Calculated score: **0.95** (High Trust)
- **Aquarius**: Age 36 months, 2 audits, $20M TVL, 1 resolved incident, active. -> Calculated score: **0.90** (High Trust)
- **DeFindex**: Age 6 months, 1 audit, $1.5M TVL, 0 incidents, active. -> Calculated score: **0.78** (High Trust)
- **Soroswap**: Age 12 months, 1 audit, $4.5M TVL, 1 resolved incident, active. -> Calculated score: **0.68** (Moderate Trust)
