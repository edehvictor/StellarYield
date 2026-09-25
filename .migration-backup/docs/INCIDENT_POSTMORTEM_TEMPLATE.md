# Incident Postmortem Template

> Copy this template for each incident. Fill in all required sections before publishing to the transparency dashboard.
> Link the completed postmortem from the incident record via the `postmortemUrl` field.

---

## Incident Summary

| Field            | Value                   |
|------------------|-------------------------|
| **Incident ID**  | `INC-XXXX`              |
| **Severity**     | `low` / `medium` / `high` / `critical` |
| **Status**       | `resolved` / `monitoring` |
| **Duration**     | `<start> — <end> (Xh Ym)` |
| **Author**       | `@handle`               |
| **Date**         | `YYYY-MM-DD`            |

## Impact

<!-- Required. Describe who and what was affected. Be specific. -->

- **Users affected:** (number or percentage)
- **Vaults / protocols affected:**
- **Financial impact:** (tokens at risk, actual loss if any)
- **Data integrity:** (was any on-chain or off-chain data compromised?)
- **Duration of impact:**

## Root Cause

<!-- Required. What exactly caused the incident? Link to commits, transactions, or provider logs where possible. -->

- **Trigger:**
- **Contributing factors:**
- **Why it was not caught earlier:**

## Timeline

<!-- Required. Chronological list of key events in UTC. -->

| Time (UTC)       | Event                                                |
|------------------|------------------------------------------------------|
| `YYYY-MM-DD HH:MM` | First alert / user report                          |
| `YYYY-MM-DD HH:MM` | Investigation started                              |
| `YYYY-MM-DD HH:MM` | Root cause identified                              |
| `YYYY-MM-DD HH:MM` | Mitigation applied                                 |
| `YYYY-MM-DD HH:MM` | Full resolution confirmed                          |
| `YYYY-MM-DD HH:MM` | Postmortem published                               |

## Detection

<!-- How was the incident detected? -->

- [ ] Automated alert (specify: health score, APY deviation, provider uptime, etc.)
- [ ] User report
- [ ] Manual review
- [ ] Other: ___

**Time to detect:** X minutes from start

## Response

<!-- Who responded and what actions were taken? -->

- **Responders:**
- **Actions taken:**
  1.
  2.
  3.

**Time to mitigate:** X minutes from detection

## Prevention

<!-- Required. What will prevent this from happening again? -->

- [ ] **Immediate:** (what was done right after resolution)
- [ ] **Short-term:** (planned for next sprint)
- [ ] **Long-term:** (architectural or process changes)

## Lessons Learned

<!-- What went well? What could be improved? -->

**What went well:**

-

**What could be improved:**

-

## Linking Guidance

To link this postmortem from an incident record:

1. Save the completed postmortem as `docs/postmortems/INC-XXXX-<short-slug>.md`.
2. Update the incident record's `postmortemUrl` field:
   ```
   postmortemUrl: "https://github.com/edehvictor/StellarYield/blob/main/docs/postmortems/INC-XXXX-<short-slug>.md"
   ```
3. The transparency dashboard at `/transparency/incidents` will display the link automatically.

## Checklist Before Publishing

- [ ] All required sections filled in
- [ ] No wallet addresses, private keys, or secrets included
- [ ] Timeline verified with logs / alerts
- [ ] Reviewed by at least one other maintainer
- [ ] Linked from incident record
