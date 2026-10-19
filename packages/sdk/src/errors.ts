import { VaultError } from "./generated/yield_vault";

/**
 * Lifecycle phase in which an SDK error originated. Lets callers branch on
 * "where did this fail" instead of parsing error messages/class names alone.
 */
export type SdkErrorPhase = "simulate" | "sign" | "submit" | "poll" | "restore";

export const VAULT_ERROR_MESSAGES: Record<number, string> = {
  1: "Contract not initialized",
  2: "Contract already initialized",
  3: "Amount must be strictly greater than zero",
  4: "Insufficient shares available for operation",
  5: "Caller is unauthorized for this operation",
  6: "Total vault supply is zero",
  7: "Vault operations are currently paused",
  8: "Timelock is currently active",
  9: "Invalid oracle price",
  10: "Slippage tolerance exceeded",
  11: "Storage key not found",
  2001: "Invalid donation basis points (must be 0-10,000)",
  2002: "Charity address is not on protocol whitelist",
  2003: "Administrative operation has expired",
  2004: "Administrative operation was already executed",
  2005: "Cross-contract call is unauthorized or on the wrong network",
  2006: "Fee recipient is invalid",
  2007: "Donation amount is below the minimum",
  2008: "Deposit exceeds the configured liquidity depth",
  2009: "Storage is already at the requested version",
  2010: "Storage schema version does not match the contract",
};

export abstract class SorobanSdkError extends Error {
  /** Lifecycle phase in which this error was raised, when known. */
  public readonly phase?: SdkErrorPhase;
  /** Whether retrying the operation that produced this error may succeed. */
  public readonly retryable: boolean;

  constructor(message: string, phase?: SdkErrorPhase, retryable = false) {
    super(message);
    this.name = this.constructor.name;
    this.phase = phase;
    this.retryable = retryable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ContractExecutionError extends SorobanSdkError {
  public readonly errorCode: number;
  public readonly errorName: string;
  public readonly rawResultXdr?: string;
  public readonly diagnosticEvents?: string[];

  constructor(
    errorCode: number,
    errorName: string,
    message: string,
    rawResultXdr?: string,
    diagnosticEvents?: string[],
    phase: SdkErrorPhase = "submit"
  ) {
    super(`Contract Execution Error [${errorCode} ${errorName}]: ${message}`, phase, false);
    this.errorCode = errorCode;
    this.errorName = errorName;
    this.rawResultXdr = rawResultXdr;
    this.diagnosticEvents = diagnosticEvents;
  }
}

export class WrongNetworkError extends SorobanSdkError {
  public readonly expectedNetwork: string;
  public readonly actualNetwork: string;

  constructor(expectedNetwork: string, actualNetwork: string) {
    super(
      `Network passphrase mismatch: expected '${expectedNetwork}', received '${actualNetwork}'`,
      "sign",
      false
    );
    this.expectedNetwork = expectedNetwork;
    this.actualNetwork = actualNetwork;
  }
}

export class UnsupportedNetworkError extends SorobanSdkError {
  public readonly code = "unsupported_network" as const;
  public readonly network: string;
  public readonly supportedNetworks: readonly string[];

  constructor(network: string, supportedNetworks: readonly string[]) {
    super(
      `Unsupported network id: '${network}'. Supported networks are: ${supportedNetworks.join(", ")}.`,
      "simulate",
      false
    );
    this.network = network;
    this.supportedNetworks = supportedNetworks;
  }
}

export class SpecMismatchError extends SorobanSdkError {
  public readonly expectedHash: string;
  public readonly actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(
      `Contract spec hash mismatch: expected '${expectedHash}', got '${actualHash}'`,
      "simulate",
      false
    );
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class StaleSimulationError extends SorobanSdkError {
  public readonly currentLedger: number;
  public readonly validUntilLedger: number;

  constructor(currentLedger: number, validUntilLedger: number) {
    super(
      `Simulation snapshot is stale (valid until ledger ${validUntilLedger}, current ledger ${currentLedger})`,
      "simulate",
      true
    );
    this.currentLedger = currentLedger;
    this.validUntilLedger = validUntilLedger;
  }
}

export class SubmissionTimeoutError extends SorobanSdkError {
  public readonly txHash: string;
  public readonly timeoutMs: number;

  constructor(txHash: string, timeoutMs: number) {
    super(
      `Transaction '${txHash}' pending inclusion timed out after ${timeoutMs}ms. Transaction may still land on-chain; use recoverTransaction() to check.`,
      "poll",
      true
    );
    this.txHash = txHash;
    this.timeoutMs = timeoutMs;
  }
}

export class WalletRejectedError extends SorobanSdkError {
  constructor(reason?: string) {
    super(
      reason ? `Wallet rejected signature: ${reason}` : "Wallet rejected signature",
      "sign",
      true
    );
  }
}

export class InvalidXdrError extends SorobanSdkError {
  public readonly rawXdr: string;

  constructor(rawXdr: string, details?: string) {
    super(`Failed to parse or validate XDR string: ${details || "Invalid XDR"}`, "sign", false);
    this.rawXdr = rawXdr;
  }
}

export class MissingAuthError extends SorobanSdkError {
  public readonly requiredAddress: string;

  constructor(requiredAddress: string)
