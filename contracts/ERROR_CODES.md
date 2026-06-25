# Contract Error Code Reference

All Soroban contracts in this repository use the `#[contracterror]` macro with `#[repr(u32)]` error enums. When a contract call fails, the SDK surfaces the numeric error code. This document maps each code to its meaning and remediation steps.

> No contract behavior is changed by this document. It is reference-only.

---

## Common Error Codes (shared across contracts)

| Code | Name                                | Meaning                                       | Remediation                                        |
| ---- | ----------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| 1    | `NotInitialized`                    | Contract has not been initialized yet         | Call `initialize()` before any other function      |
| 2    | `AlreadyInitialized`                | `initialize()` was called more than once      | No action needed; contract is already set up       |
| 3    | `Unauthorized` / `ZeroAmount`       | Caller lacks permission, or amount is zero    | Verify the caller address and that amounts are > 0 |
| 5    | `Unauthorized`                      | Caller is not the admin or an authorized role | Use the correct admin/keeper address               |
| 7    | `Paused`                            | Contract is in emergency pause state          | Wait for admin to call `emergency_unpause`         |
| 8    | `TimelockActive`                    | A timelock window is still open               | Wait for the timelock period to expire             |
| 9    | `InvalidPrice` / `MathOverflow`     | Oracle price is stale or math overflowed      | Check oracle freshness; reduce input amounts       |
| 10   | `SlippageExceeded` / `MathOverflow` | Output fell below the slippage tolerance      | Increase slippage tolerance or retry later         |

---

## yield_vault — `VaultError`

Source: `contracts/yield_vault/src/lib.rs`

| Code | Name                    | Meaning                                     | Remediation                                            |
| ---- | ----------------------- | ------------------------------------------- | ------------------------------------------------------ |
| 1    | `NotInitialized`        | Vault not initialized                       | Call `initialize(admin, token)`                        |
| 2    | `AlreadyInitialized`    | Vault already initialized                   | No action needed                                       |
| 3    | `ZeroAmount`            | Deposit or withdrawal amount is zero        | Pass a positive amount                                 |
| 4    | `InsufficientShares`    | Caller does not hold enough vault shares    | Reduce withdrawal amount                               |
| 5    | `Unauthorized`          | Caller is not admin or registered keeper    | Use the correct privileged address                     |
| 6    | `ZeroSupply`            | Total share supply is zero (division guard) | Deposit funds first to bootstrap the vault             |
| 7    | `Paused`                | Vault is in emergency pause                 | Wait for `emergency_unpause` from admin                |
| 8    | `TimelockActive`        | Admin action is under timelock              | Wait for the timelock window to expire                 |
| 9    | `InvalidPrice`          | Oracle price is stale or out of bounds      | Refresh the oracle; check `set_oracle` config          |
| 10   | `SlippageExceeded`      | Withdrawal slippage exceeded tolerance      | Increase `min_out` tolerance or retry                  |
| 11   | `StorageKeyNotFound`    | Required storage key is missing             | Ensure contract is properly initialized and configured |
| 2001 | `InvalidDonationBps`    | Donation basis points outside 0–10 000      | Pass a value between 0 and 10 000                      |
| 2002 | `CharityNotWhitelisted` | Charity address not on protocol whitelist   | Use `set_charity_whitelist` to add the address         |

---

## stableswap — `StableSwapError`

Source: `contracts/stableswap/src/lib.rs`

| Code | Name                    | Meaning                                      | Remediation                                 |
| ---- | ----------------------- | -------------------------------------------- | ------------------------------------------- |
| 1    | `AlreadyInitialized`    | Pool already initialized                     | No action needed                            |
| 2    | `NotInitialized`        | Pool not initialized                         | Call `initialize()`                         |
| 3    | `InvalidAmount`         | Amount is zero or negative                   | Pass a positive amount                      |
| 4    | `InsufficientLiquidity` | Pool does not have enough liquidity          | Add liquidity or reduce swap size           |
| 5    | `InsufficientOutput`    | Output below minimum (slippage)              | Increase slippage tolerance or reduce input |
| 6    | `Unauthorized`          | Caller is not admin                          | Use the admin address                       |
| 7    | `InvalidAmpCoeff`       | Amplification coefficient out of range       | Use a valid amp value (typically 1–10 000)  |
| 8    | `InvalidFee`            | Fee basis points out of range                | Use a fee value within protocol limits      |
| 9    | `MathOverflow`          | Arithmetic overflow in invariant calculation | Reduce input amounts                        |
| 10   | `ZeroInvariant`         | Pool invariant is zero                       | Pool is empty; add liquidity first          |

---

## isolated_lending — `IsolatedLendingError`

Source: `contracts/isolated_lending/src/lib.rs`

| Code | Name                     | Meaning                              | Remediation                                    |
| ---- | ------------------------ | ------------------------------------ | ---------------------------------------------- |
| 1    | `Unauthorized`           | Caller is not admin                  | Use the admin address                          |
| 2    | `PairAlreadyExists`      | Lending pair already registered      | No action needed                               |
| 3    | `PairNotFound`           | Lending pair does not exist          | Register the pair first                        |
| 4    | `InvalidConfig`          | Configuration parameters are invalid | Check collateral ratio and fee values          |
| 5    | `NotInitialized`         | Contract not initialized             | Call `initialize()`                            |
| 6    | `InvalidAmount`          | Amount is zero or negative           | Pass a positive amount                         |
| 7    | `InsufficientLiquidity`  | Not enough liquidity to borrow       | Reduce borrow amount or add liquidity          |
| 8    | `InsufficientCollateral` | Collateral below required ratio      | Add more collateral                            |
| 9    | `PositionStillBacked`    | Position cannot be liquidated yet    | Wait until health factor drops below threshold |
| 10   | `MathOverflow`           | Arithmetic overflow                  | Reduce input amounts                           |

---

## liquid_staking — `Error`

Source: `contracts/liquid_staking/src/lib.rs`

| Code | Name                      | Meaning                         | Remediation                                |
| ---- | ------------------------- | ------------------------------- | ------------------------------------------ |
| 1    | `NotAdmin`                | Caller is not the admin         | Use the admin address                      |
| 2    | `NotInitialized`          | Contract not initialized        | Call `initialize()`                        |
| 3    | `AlreadyInitialized`      | Contract already initialized    | No action needed                           |
| 4    | `ValidatorNotWhitelisted` | Validator address not approved  | Add validator via admin whitelist function |
| 5    | `AmountMustBePositive`    | Stake/unstake amount is zero    | Pass a positive amount                     |
| 6    | `ZeroShares`              | Share calculation returned zero | Increase stake amount                      |
| 7    | `Unauthorized`            | Caller lacks permission         | Use the correct privileged address         |

---

## optimistic_governance — `Error`

Source: `contracts/optimistic_governance/src/lib.rs`

| Code | Name                      | Meaning                                  | Remediation                            |
| ---- | ------------------------- | ---------------------------------------- | -------------------------------------- |
| 1    | `NotInitialized`          | Contract not initialized                 | Call `initialize()`                    |
| 2    | `AlreadyInitialized`      | Contract already initialized             | No action needed                       |
| 3    | `Unauthorized`            | Caller is not admin or proposer          | Use the correct address                |
| 4    | `ProposalNotFound`        | Proposal ID does not exist               | Check the proposal ID                  |
| 5    | `ChallengeWindowActive`   | Proposal is still in challenge window    | Wait for the challenge window to close |
| 6    | `ProposalDisputed`        | Proposal has been challenged             | Resolve the dispute before executing   |
| 7    | `ProposalAlreadyExecuted` | Proposal was already executed            | No action needed                       |
| 8    | `InsufficientVotingPower` | Caller does not have enough voting power | Acquire more governance tokens         |
| 9    | `ChallengeWindowExpired`  | Challenge window has passed              | Cannot challenge after expiry          |

---

## settlement — `SettlementError`

Source: `contracts/settlement/src/lib.rs`

| Code | Name                   | Meaning                                | Remediation                                 |
| ---- | ---------------------- | -------------------------------------- | ------------------------------------------- |
| 1    | `NotInitialized`       | Contract not initialized               | Call `initialize()`                         |
| 2    | `AlreadyInitialized`   | Contract already initialized           | No action needed                            |
| 3    | `Unauthorized`         | Caller is not admin or matching engine | Use the correct address                     |
| 4    | `InvalidSignature`     | Trade signature verification failed    | Re-sign the trade data with the correct key |
| 5    | `TradeAlreadySettled`  | Trade nonce already used               | Use a fresh nonce                           |
| 6    | `InvalidTradeData`     | Trade amounts or addresses are invalid | Validate trade parameters                   |
| 7    | `InsufficientBalance`  | Trader does not have enough balance    | Fund the account before settling            |
| 8    | `TransferFailed`       | Token transfer call failed             | Check token allowances and balances         |
| 9    | `Paused`               | Contract is paused                     | Wait for admin to unpause                   |
| 10   | `InvalidAmount`        | Amount is zero or negative             | Pass a positive amount                      |
| 11   | `MatchingEngineNotSet` | No matching engine address configured  | Call `set_matching_engine` as admin         |

---

## bridge_relayer — `BridgeRelayerError`

Source: `contracts/bridge_relayer/src/lib.rs`

| Code | Name                      | Meaning                                 | Remediation                                  |
| ---- | ------------------------- | --------------------------------------- | -------------------------------------------- |
| 1    | `General`                 | Unspecified error                       | Check transaction logs for context           |
| 2    | `InvalidMessage`          | Message format is malformed             | Validate chain IDs, nonce, and amount fields |
| 3    | `InvalidMerkleProof`      | Merkle proof verification failed        | Regenerate the proof from the correct root   |
| 4    | `InvalidMultiSignature`   | Multi-sig threshold not met             | Collect enough validator signatures          |
| 5    | `InvalidNonce`            | Nonce is invalid or replayed            | Use a fresh, sequential nonce                |
| 6    | `MessageAlreadyProcessed` | Message was already relayed             | No action needed; message is settled         |
| 7    | `InsufficientValidators`  | Not enough validators approved          | Add validators via admin                     |
| 8    | `QueueFull`               | Relay queue has reached capacity        | Wait for queue to drain                      |
| 9    | `TransferNotExecutable`   | Transfer conditions not yet met         | Wait for timelock or threshold conditions    |
| 10   | `ContractPaused`          | Contract is paused                      | Wait for admin to unpause                    |
| 11   | `Unauthorized`            | Caller is not a validator or admin      | Use an authorized address                    |
| 12   | `InvalidConfig`           | Configuration values are out of range   | Check `min_validators` and `max_queue_size`  |
| 13   | `AssetNotSupported`       | Asset is not on the supported list      | Add asset via admin                          |
| 14   | `AmountExceedsThreshold`  | Transfer amount exceeds queue threshold | Split into smaller transfers                 |
| 15   | `InvalidValidator`        | Validator address or weight is invalid  | Use a non-empty address with weight > 0      |
| 16   | `TimeLockNotExpired`      | Timelock has not expired yet            | Wait for the timelock period                 |

---

## zap — `ZapError`

Source: `contracts/zap/src/lib.rs`

| Code | Name                 | Meaning                      | Remediation                              |
| ---- | -------------------- | ---------------------------- | ---------------------------------------- |
| 1    | `NotInitialized`     | Contract not initialized     | Call `initialize()`                      |
| 2    | `AlreadyInitialized` | Contract already initialized | No action needed                         |
| 3    | `ZeroAmount`         | Input amount is zero         | Pass a positive amount                   |
| 4    | `Unauthorized`       | Caller is not admin          | Use the admin address                    |
| 5    | `SlippageExceeded`   | Swap output below minimum    | Increase slippage tolerance              |
| 6    | `SwapFailed`         | Underlying swap call failed  | Check pool liquidity and token approvals |

---

## stealth_addresses — `StealthError`

Source: `contracts/stealth_addresses/src/lib.rs`

| Code | Name                  | Meaning                             | Remediation                                   |
| ---- | --------------------- | ----------------------------------- | --------------------------------------------- |
| 1    | `AlreadyInitialized`  | Contract already initialized        | No action needed                              |
| 2    | `NotInitialized`      | Contract not initialized            | Call `initialize()`                           |
| 3    | `InvalidPublicKey`    | Stealth public key is malformed     | Provide a valid 32-byte compressed public key |
| 4    | `InvalidAmount`       | Amount is zero or negative          | Pass a positive amount                        |
| 5    | `DepositNotFound`     | Deposit ID does not exist           | Check the deposit ID                          |
| 6    | `AlreadyClaimed`      | Deposit was already claimed         | No action needed                              |
| 7    | `Unauthorized`        | Caller is not the deposit recipient | Use the correct recipient key                 |
| 8    | `MetaLabelTooLong`    | Metadata label exceeds length limit | Shorten the label string                      |
| 9    | `MetaAddressNotFound` | Meta-address not registered         | Register the meta-address first               |

---

## Panic Paths

In addition to typed errors, contracts may call `panic_with_error!` or `panic!` for invariant violations. These surface as generic transaction failures without a typed code. Common causes:

- Passing `Address::default()` or a zero-length `Bytes` where a real value is required.
- Calling admin-only functions without the correct admin address in storage.
- Integer overflow in unchecked arithmetic (rare; most paths use checked math).

When you see an untyped panic, check the function's precondition guards at the top of the call.
