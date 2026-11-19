# CLMM Core

The pool records a SHA-256 fingerprint of its token addresses, fee, and tick spacing when initialized. Each newly minted position stores that fingerprint alongside its position state. Mint, burn, and collect reject work with `StaleConfiguration` if the live pool configuration differs from its initialization fingerprint or the position snapshot is absent or different.

Correct a configuration mismatch before retrying the operation. A rejected operation leaves the position accounting unchanged; successful retries use the original immutable pool configuration.
