# Isolated lending diagnostics

`IsolatedLendingPair::diagnose` is a read-only preflight endpoint for clients
that need to explain a failed operation before submitting a transaction.

It returns only an operation, a stable error code, and a coarse remediation
category. It never returns balances, debt, collateral, token identifiers, or
other position details. A successful result means the local checks passed;
the transaction still performs its normal authorization and state validation.

Callers should use the remediation category to guide a retry, then submit the
original operation normally. Failed validation does not mutate pair state.
