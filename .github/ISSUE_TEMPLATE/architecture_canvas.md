---
name: Architecture & Refactor Canvas
about: Structured canvas for system refactoring, Prisma migrations, and architectural changes
title: '[Architecture Canvas]: '
labels: ['refactor', 'canvas']
assignees: ''
---

# Architecture & Refactoring Canvas: [Component / Subsystem Name]

## Overview & Refactor Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Architecture & Refactor Canvas` | Architecture & refactoring specification |
| **Issue / PR #** | `Pending` | Associated tracking issue |
| **Author / Lead** | `@` | Lead architect |
| **Scope** | `Frontend / Backend / Database / Monorepo` | Target architectural boundary |
| **Risk Level** | `Low / Medium / High / Critical` | System risk |
| **Target Release** | `vX.X` | Target release |
| **Performance Impact** | `Improved / Neutral / Monitored` | Performance projection |

---

## Current State & Motivation

Describe the current architecture and why this refactoring is needed.

---

## Target Architecture & Design

Describe the new system structure, boundaries, and decoupling strategy.

---

## Schema & Migration Plan

> [!WARNING]
> Database schema migrations must maintain zero-downtime compatibility. Never drop active columns in the same release that introduces new code.

- **Phase 1 (Expand)**: Add new nullable/defaulted columns.
- **Phase 2 (Dual Write)**: Write to both legacy and new structures.
- **Phase 3 (Backfill)**: Backfill historical rows.
- **Phase 4 (Contract)**: Safely remove legacy columns.

---

## Performance & Gas Benchmarks

> [!TIP]
> Use `EXPLAIN ANALYZE` on PostgreSQL queries to confirm that new composite indexes eliminate sequential scans.

---

## Acceptance Criteria Checklist

- [ ] New architecture conforms to modularity and separation of concerns principles.
- [ ] Database migrations tested with zero downtime.
- [ ] Load and performance benchmarks meet or exceed targets.
- [ ] Integration tests verify new service layers.
- [ ] Architecture documentation updated.
