# Vesting claim configuration snapshots (#1926)

The client captures an immutable configuration fingerprint when a vesting claim starts. The fingerprint is a JSON encoding of the vesting contract ID, network passphrase, and configured RPC URL. The active RPC failover endpoint is deliberately excluded: switching endpoints on the same network is not a contract-configuration change.

The claim rechecks its fingerprint after loading the account, after simulation, and after Freighter signing, immediately before submitting. If the fingerprint changes, the client returns a failure without submitting the stale transaction. The user may retry, which captures a fresh snapshot. Simulation and signing failures likewise do not submit a transaction.

This is a client-side pre-submission check, not an atomic on-chain lock or a guarantee against changes after the last check. Once a transaction has been submitted, its outcome must be reconciled using the returned hash before attempting a potentially duplicate claim. The vesting contract remains responsible for on-chain authorization and state integrity.

Regression tests: `npm exec -- vitest run src/pages/vesting/vestingService.test.ts src/pages/vesting/vestingConfiguration.test.ts` from `client/`.
