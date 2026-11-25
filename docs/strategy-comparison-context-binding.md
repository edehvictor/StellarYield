# Strategy Comparison — Network and Ledger Context Binding (#1924)

Strategy comparison reads and selection writes must not silently cross a Stellar
network or ledger transition.

The client now executes both operations through the SDK's
`runWithSimulationContext` guard. Each context observation includes:

- canonical network id and network passphrase;
- vault contract id and SDK contract-spec version;
- latest Soroban ledger sequence.

The SDK accepts asynchronous context readers so the guard can query the live
Soroban RPC ledger before and after an operation.

## Read behavior

A strategy-data read captures the live context before the request and checks it
again after the response. If the network, passphrase, contract, or spec version
changes, the read is rejected. If the ledger regresses or advances more than
20 ledgers while the request is in flight, the read is repeated against a
fresh context, up to three attempts.

## Selection behavior

A selection write is pinned to the context captured by the most recent
successful strategy-data read. Before the write starts, the SDK verifies that
the live context still matches that snapshot and is no more than 20 ledgers
ahead. A stale or mismatched context rejects the write before the selection
request is sent. The existing optimistic workspace-version check remains in
place as a separate concurrency guard.

## State preservation

The context guard receives a snapshot of the visible comparison data and
selection state. Context mismatches are typed SDK errors and do not invoke the
wrapped operation when detected during the preflight check. The strategy page
keeps the last successfully loaded comparison data and displays a refresh
warning when the context guard rejects an operation.

## Verification

The SDK simulation-context tests cover asynchronous context readers and
preflight rejection when the captured ledger is outside the allowed drift.
The strategy comparison component tests mock the context adapter so their
existing UI tests remain deterministic and do not require a live Stellar RPC.
