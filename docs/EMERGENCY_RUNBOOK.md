# Emergency Mode Operator Runbook

This runbook guides operators through a protocol emergency. It is a **checklist
and reference**, not an automation tool — every privileged action (pausing,
resuming) is performed deliberately through the admin console, never triggered
automatically by the UI.

The in-app companion is the **Emergency Runbook Panel**
(`client/src/pages/governance/EmergencyRunbookPanel.tsx`), which renders these
steps, shows the current pause/health status where available, and links each
step back to this document or to a read-only status check.

## Steps

### Pause

Halt new deposits and strategy execution to contain the incident.

- Action is performed by an authorized operator via the admin freeze controls
  (`POST /api/admin/recommendations/freeze`). The panel never executes it.
- Confirm the freeze took effect before moving on.

### Verify

Establish what is actually wrong before communicating or resuming.

- Check protocol health: [`GET /api/health`](/api/health).
- Review the [Event Indexer Checkpoint](#) for replay lag and recent errors.
- Confirm the pause is active and no unexpected state changes are occurring.

### Notify

Communicate clearly with users and stakeholders.

- Post status to the official channels (status page, social, governance forum).
- Record the incident timeline for the postmortem. Use the
  [incident postmortem template](./postmortems/TEMPLATE.md) and linking flow
  once the event is mitigated or resolved.
- This step is a manual acknowledgement; the panel cannot complete it for you.

### Resume

Return to normal operation only after the root cause is understood and fixed.

- Re-run the **Verify** checks and confirm health has recovered.
- Lift the freeze via the admin controls (read-only status reflected in the panel).
- Continue monitoring for regressions after resuming.

## Principles

- **Read-only by design.** The panel surfaces status and guidance; it does not
  hold privileged keys and cannot pause or resume the protocol.
- **Verify before you act.** Each transition is gated on confirming current
  state, not assumptions.
