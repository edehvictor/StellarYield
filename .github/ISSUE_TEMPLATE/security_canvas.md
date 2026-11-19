---
name: Security Remediation Canvas
about: Structured canvas for security advisories, vulnerability remediations, and threat modeling
title: '[Security Canvas]: '
labels: ['security', 'canvas']
assignees: ''
---

# Security Remediation Canvas: [Vulnerability / Advisory Summary]

## Overview & Advisory Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Security Remediation Canvas` | Security fix and threat mitigation plan |
| **Advisory / Issue #** | `SEC-Pending` | Security tracking ID |
| **Lead Responder** | `@` | Security lead |
| **Severity / CVSS** | `Critical / High / Medium / Low` | Severity rating |
| **Disclosure Status** | `Responsible Disclosure / Internal Audit` | Source |
| **Affected Components** | `Contracts / Backend / Frontend` | Impacted components |
| **Patch Target Release** | `vX.X Hotfix` | Target release |

---

## Threat Description & Attack Vectors

Explain the vulnerability, underlying flaw, and prerequisites for exploitation.

> [!CAUTION]
> Do not include live exploit payloads or targeted mainnet addresses in public tickets before patch deployment.

---

## Severity & Blast Radius

- **Confidentiality Impact**: `None / Low / High`
- **Integrity Impact**: `None / Low / High`
- **Availability Impact**: `None / Low / High`
- **Estimated Loss of Funds / Exposure**:

---

## Remediation Strategy & Core Fixes

Describe the code changes to neutralize the vulnerability.

> [!IMPORTANT]
> The fix must eliminate the root vulnerability without creating regressions in legitimate workflows.

---

## Security Test Suite & Regression Verification

- [ ] Exploit reproduction test written (fails on unpatched code, passes on patch).
- [ ] Concurrency and boundary tests added.
- [ ] Emergency runbook and rollback plan confirmed.
- [ ] Security sign-off completed.
