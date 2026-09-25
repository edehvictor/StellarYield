/**
 * Contract panic decoding for user-facing errors (#1339).
 *
 * Every Soroban contract failure is reported as a structured `ScError` inside
 * the diagnostic events of a simulation or transaction. A typed
 * `#[contracterror]` return (or `panic_with_error!`) surfaces as
 * `ScError::Contract(code)`, while an untyped `panic!` / `unwrap()` traps the
 * Wasm VM and surfaces as `ScError::WasmVm` with an `InvalidAction` code.
 *
 * This module decodes that structured value — never the RPC provider's
 * human-readable error string — into a stable, per-contract, user-facing error,
 * so the same failure always renders the same way on the server and in the UI.
 * Contract codes are looked up per contract: zap code 5 is `SlippageExceeded`,
 * vault code 5 is `Unauthorized`.
 *
 * It has no runtime dependencies on purpose: diagnostic events are walked
 * structurally, so the server and the client can each pass the XDR objects
 * produced by their own `@stellar/stellar-sdk`.
 */

/** Contracts whose `#[contracterror]` enums are catalogued below. */
export type ContractErrorNamespace = "vault" | "zap";

export type ContractPanicCode =
  /** A typed error from the invoked contract's `#[contracterror]` enum. */
  | "CONTRACT_ERROR"
  /** A typed contract error code that is not in the catalog for the contract. */
  | "UNKNOWN_CONTRACT_ERROR"
  /** An untyped `panic!` / `unwrap()` trapped the Wasm VM. */
  | "CONTRACT_TRAPPED"
  /** The call ran out of CPU, memory, or other resource budget. */
  | "RESOURCE_LIMIT_EXCEEDED"
  /** A required authorization was missing or invalid. */
  | "AUTHORIZATION_FAILED"
  /** A ledger entry the contract needed is missing or archived. */
  | "LEDGER_ENTRY_MISSING"
  /** Any other host-level failure. */
  | "HOST_ERROR"
  /** No structured error was present to decode. */
  | "UNDECODABLE";

/** The structured `ScError`, reduced to plain data. */
export interface StructuredScError {
  /** XDR `ScErrorType` name, e.g. `"sceContract"` or `"sceWasmVm"`. */
  type: string;
  /** Contract error code, present when `type` is `"sceContract"`. */
  contractCode?: number;
  /** XDR `ScErrorCode` name for host errors, e.g. `"scecInvalidAction"`. */
  code?: string;
}

export interface DecodedContractPanic {
  code: ContractPanicCode;
  /** Contract whose catalog was used, when one was supplied. */
  namespace?: ContractErrorNamespace;
  /** Numeric contract error code, for `CONTRACT_ERROR` / `UNKNOWN_CONTRACT_ERROR`. */
  contractCode?: number;
  /** Variant name from the contract's error enum, e.g. `"InsufficientShares"`. */
  errorName?: string;
  /** Short heading for a failure modal. */
  title: string;
  /** Friendly explanation for the end user. */
  message: string;
  /** What the user can do next. */
  remediation: string;
  /** Whether retrying the same action may succeed later. */
  retryable: boolean;
  /** The structured error the decode was based on, when there was one. */
  scError?: StructuredScError;
}

/** One variant of a contract's `#[contracterror]` enum, with user-facing copy. */
export interface ContractErrorEntry {
  name: string;
  title: string;
  message: string;
  remediation: string;
  retryable: boolean;
}

/** `VaultError` in `contracts/yield_vault/src/lib.rs`. */
const VAULT_ERRORS: Record<number, ContractErrorEntry> = {
  1: {
    name: "NotInitialized",
    title: "Contract Not Initialized",
    message: "The vault contract has not been set up yet.",
    remediation: "Please contact support — the contract admin must call initialize first.",
    retryable: false,
  },
  2: {
    name: "AlreadyInitialized",
    title: "Already Initialized",
    message: "The vault has already been configured.",
    remediation: "No action needed. Try refreshing the page.",
    retryable: false,
  },
  3: {
    name: "ZeroAmount",
    title: "Zero Amount",
    message: "You must deposit or withdraw an amount greater than zero.",
    remediation: "Enter a positive token amount and try again.",
    retryable: false,
  },
  4: {
    name: "InsufficientShares",
    title: "Insufficient Shares",
    message: "You don't have enough vault shares to complete this withdrawal.",
    remediation: "Reduce the withdrawal amount or wait for more shares to accrue.",
    retryable: false,
  },
  5: {
    name: "Unauthorized",
    title: "Unauthorised",
    message: "Your wallet is not permitted to perform this action.",
    remediation: "Make sure you are connected with the correct wallet address.",
    retryable: false,
  },
  6: {
    name: "ZeroSupply",
    title: "Zero Supply",
    message: "The vault has no shares in circulation, so the ratio cannot be calculated.",
    remediation: "Deposit funds into the vault first to establish the share ratio.",
    retryable: false,
  },
  7: {
    name: "Paused",
    title: "Vault Paused",
    message: "The vault is currently paused for maintenance.",
    remediation: "Check the protocol announcements for an estimated resume time.",
    retryable: true,
  },
  8: {
    name: "TimelockActive",
    title: "Timelock Active",
    message: "This administrative action is still within its time-lock period.",
    remediation: "Wait for the timelock to expire before retrying.",
    retryable: true,
  },
  9: {
    name: "InvalidPrice",
    title: "Invalid Oracle Price",
    message: "The on-chain oracle returned an invalid or stale price.",
    remediation: "Try again after a few seconds to allow the oracle to update.",
    retryable: true,
  },
  10: {
    name: "SlippageExceeded",
    title: "Slippage Exceeded",
    message: "The price moved too much during your transaction. Your slippage tolerance was exceeded.",
    remediation: "Increase your slippage tolerance or try again when markets are calmer.",
    retryable: true,
  },
  11: {
    name: "StorageKeyNotFound",
    title: "Storage Key Not Found",
    message: "A required storage entry is missing from the contract. The vault may not be fully initialized.",
    remediation: "Contact support — the contract admin may need to re-initialize or migrate storage.",
    retryable: false,
  },
  2001: {
    name: "InvalidDonationBps",
    title: "Invalid Donation Percentage",
    message: "The yield split percentage must be between 0 and 100.",
    remediation: "Enter a valid percentage between 0 and 100.",
    retryable: false,
  },
  2002: {
    name: "CharityNotWhitelisted",
    title: "Charity Not Whitelisted",
    message: "The selected charity address is not on the protocol's whitelist.",
    remediation: "Choose a charity from the approved list in the Yield for Good panel.",
    retryable: false,
  },
  2003: {
    name: "OperationExpired",
    title: "Operation Expired",
    message: "This administrative operation expired before it was executed.",
    remediation: "Create a new operation and execute it before it expires.",
    retryable: false,
  },
  2004: {
    name: "OperationReplayed",
    title: "Operation Already Executed",
    message: "This administrative operation has already been executed.",
    remediation: "No action needed — refresh to see the current state.",
    retryable: false,
  },
  2005: {
    name: "UnauthorizedContract",
    title: "Unauthorized Contract",
    message: "The call came from a contract that is not allowed to perform it on this network.",
    remediation: "Check that you are using the contracts registered for the current network.",
    retryable: false,
  },
  2006: {
    name: "InvalidRecipient",
    title: "Invalid Recipient",
    message: "The fee recipient address is not valid for this vault.",
    remediation: "Choose a different recipient address.",
    retryable: false,
  },
  2007: {
    name: "DonationBelowMinimum",
    title: "Donation Below Minimum",
    message: "Donation amount is below the minimum (dust).",
    remediation: "Increase the yield amount or donation split before submitting.",
    retryable: false,
  },
};

/** `ZapError` in `contracts/zap/src/lib.rs`. */
const ZAP_ERRORS: Record<number, ContractErrorEntry> = {
  1: {
    name: "NotInitialized",
    title: "Zap Not Configured",
    message: "The zap contract is not initialized or is missing its configuration.",
    remediation: "Please contact support — the zap contract must be (re)configured by its admin.",
    retryable: false,
  },
  2: {
    name: "AlreadyInitialized",
    title: "Already Initialized",
    message: "The zap contract has already been configured.",
    remediation: "No action needed. Try refreshing the page.",
    retryable: false,
  },
  3: {
    name: "ZeroAmount",
    title: "Zero Amount",
    message: "You must zap an amount greater than zero.",
    remediation: "Enter a positive token amount and try again.",
    retryable: false,
  },
  4: {
    name: "Unauthorized",
    title: "Unauthorised",
    message: "Your wallet is not permitted to change the zap configuration.",
    remediation: "Use the zap admin wallet for configuration changes.",
    retryable: false,
  },
  5: {
    name: "SlippageExceeded",
    title: "Slippage Exceeded",
    message: "The swap returned less than your minimum output. Your slippage tolerance was exceeded.",
    remediation: "Refresh the quote, increase your slippage tolerance, or try again when markets are calmer.",
    retryable: true,
  },
  6: {
    name: "SwapFailed",
    title: "Swap Failed",
    message: "The underlying swap could not be completed.",
    remediation: "Check pool liquidity for this pair and try again with a fresh quote.",
    retryable: true,
  },
};

const CONTRACT_ERRORS: Record<ContractErrorNamespace, Record<number, ContractErrorEntry>> = {
  vault: VAULT_ERRORS,
  zap: ZAP_ERRORS,
};

type PanicCopy = Pick<DecodedContractPanic, "title" | "message" | "remediation" | "retryable">;

const PANIC_COPY: Record<Exclude<ContractPanicCode, "CONTRACT_ERROR">, PanicCopy> = {
  UNKNOWN_CONTRACT_ERROR: {
    title: "Contract Rejected the Transaction",
    message: "The contract returned an error this app does not recognise yet.",
    remediation: "Expand the developer log below and share the error code with support.",
    retryable: false,
  },
  CONTRACT_TRAPPED: {
    title: "Contract Stopped Unexpectedly",
    message: "The contract hit an unhandled condition and aborted, so the transaction was not applied.",
    remediation: "Refresh and try again. If it keeps happening, share the developer log with support.",
    retryable: false,
  },
  RESOURCE_LIMIT_EXCEEDED: {
    title: "Resource Limit Exceeded",
    message: "The transaction needed more network resources than allowed.",
    remediation: "Try again in a moment, or try a smaller amount.",
    retryable: true,
  },
  AUTHORIZATION_FAILED: {
    title: "Authorization Failed",
    message: "The transaction is missing a required signature or authorization.",
    remediation: "Reconnect the wallet that owns these funds and sign the transaction again.",
    retryable: false,
  },
  LEDGER_ENTRY_MISSING: {
    title: "Contract Data Unavailable",
    message: "Some contract data needed for this transaction is missing or archived.",
    remediation: "Refresh the page so the data can be restored, then try again.",
    retryable: true,
  },
  HOST_ERROR: {
    title: "Network Rejected the Transaction",
    message: "The Stellar network rejected the transaction while executing the contract.",
    remediation: "Try again with fresh simulation data. If it persists, share the developer log with support.",
    retryable: false,
  },
  UNDECODABLE: {
    title: "Transaction Failed",
    message: "The transaction failed without a recognisable contract error.",
    remediation: "Expand the developer log below and share it with support.",
    retryable: false,
  },
};

/** Returns the catalog entry for a contract error code, if it is known. */
export function lookupContractError(
  namespace: ContractErrorNamespace,
  contractCode: number,
): ContractErrorEntry | undefined {
  return CONTRACT_ERRORS[namespace][contractCode];
}

function hostPanicCode(scError: StructuredScError): Exclude<ContractPanicCode, "CONTRACT_ERROR" | "UNKNOWN_CONTRACT_ERROR"> {
  switch (scError.type) {
    case "sceWasmVm":
      return "CONTRACT_TRAPPED";
    case "sceBudget":
      return "RESOURCE_LIMIT_EXCEEDED";
    case "sceAuth":
      return "AUTHORIZATION_FAILED";
    case "sceStorage":
      return scError.code === "scecMissingValue" ? "LEDGER_ENTRY_MISSING" : "HOST_ERROR";
    default:
      return "HOST_ERROR";
  }
}

/**
 * Decode a structured `ScError` into a user-facing error. Contract codes are
 * looked up in the catalog of `namespace` (the contract that was invoked);
 * without a namespace, or for a code that is not catalogued, the result is
 * `UNKNOWN_CONTRACT_ERROR` carrying the numeric code.
 */
export function decodeScError(
  scError: StructuredScError | null | undefined,
  namespace?: ContractErrorNamespace,
): DecodedContractPanic {
  if (!scError) {
    return { code: "UNDECODABLE", ...PANIC_COPY.UNDECODABLE };
  }

  if (scError.type === "sceContract" && typeof scError.contractCode === "number") {
    const entry = namespace ? lookupContractError(namespace, scError.contractCode) : undefined;
    if (entry) {
      return {
        code: "CONTRACT_ERROR",
        namespace,
        contractCode: scError.contractCode,
        errorName: entry.name,
        title: entry.title,
        message: entry.message,
        remediation: entry.remediation,
        retryable: entry.retryable,
        scError,
      };
    }
    return {
      code: "UNKNOWN_CONTRACT_ERROR",
      namespace,
      contractCode: scError.contractCode,
      ...PANIC_COPY.UNKNOWN_CONTRACT_ERROR,
      scError,
    };
  }

  const code = hostPanicCode(scError);
  return { code, namespace, ...PANIC_COPY[code], scError };
}

// ── Diagnostic event extraction ────────────────────────────────────────────

/** The parts of the XDR objects this module reads; satisfied by `@stellar/stellar-sdk`. */
interface XdrEnumLike {
  name: string;
}

interface ScErrorLike {
  switch(): XdrEnumLike;
  contractCode(): number;
  code(): XdrEnumLike;
}

interface ScValLike {
  switch(): XdrEnumLike;
  error(): ScErrorLike;
}

function readScError(value: unknown): StructuredScError | null {
  try {
    const scVal = value as ScValLike;
    if (scVal.switch().name !== "scvError") return null;
    const scError = scVal.error();
    const type = scError.switch().name;
    if (type === "sceContract") {
      return { type, contractCode: scError.contractCode() };
    }
    return { type, code: scError.code().name };
  } catch {
    return null;
  }
}

function eventScVals(event: unknown): unknown[] {
  try {
    const body = (event as {
      event(): { body(): { v0(): { topics(): unknown[]; data(): unknown } } };
    })
      .event()
      .body()
      .v0();
    return [...body.topics(), body.data()];
  } catch {
    return [];
  }
}

/**
 * Find the `ScError` that explains a failed call in its diagnostic events. The
 * first contract error wins — it is the contract's own typed code — otherwise
 * the first host error (e.g. a Wasm trap from an untyped panic) is used.
 * Returns `null` when the events carry no structured error.
 */
export function extractScError(events: readonly unknown[] | null | undefined): StructuredScError | null {
  let firstHostError: StructuredScError | null = null;
  for (const event of events ?? []) {
    for (const value of eventScVals(event)) {
      const scError = readScError(value);
      if (!scError) continue;
      if (scError.type === "sceContract") return scError;
      firstHostError ??= scError;
    }
  }
  return firstHostError;
}

/** Decode the diagnostic events of a failed simulation or transaction. */
export function decodeContractPanic(
  events: readonly unknown[] | null | undefined,
  namespace?: ContractErrorNamespace,
): DecodedContractPanic {
  return decodeScError(extractScError(events), namespace);
}
