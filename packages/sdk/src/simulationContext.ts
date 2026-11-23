/**
 * Network, ledger, and contract-version binding for SDK simulation APIs (#1857).
 *
 * A simulation preview is only meaningful for the deployment it was evaluated
 * against: the Stellar network (and its passphrase), the contract instance,
 * the contract interface version, and the ledger the reads were taken at.
 * Transitions between any of these — a wallet switching from testnet to
 * mainnet, an RPC endpoint being reconfigured to a lagging or different node,
 * a local network being reset, or simply the ledger advancing past a
 * transaction's validity window — make that preview unsafe to apply.
 *
 * This module lets callers bind reads and writes to an explicit
 * {@link SimulationContext} and rejects any mismatch with a typed
 * {@link SimulationContextMismatchError}:
 *
 * - Identity fields (`network`, `networkPassphrase`, `contractId`,
 *   `contractVersion`) must match exactly. These mismatches are never
 *   retryable, because a retry would silently run against another deployment.
 * - `ledger` must never move backwards, and may optionally be bounded by a
 *   maximum drift or a `validUntilLedger`. These mismatches are retryable:
 *   re-simulating against the current ledger is safe.
 *
 * Every check runs before caller state is touched, so a rejected operation
 * leaves balances, submission records, and cached snapshots exactly as they
 * were.
 */

import { SimulationContextMismatchError, type SdkErrorPhase } from "./errors";
import type { SimulationContextField } from "./errors";
import { validateNetworkName, type NetworkName } from "./network";
import { deepCloneAndFreeze } from "./simulationConfig";

/** Well-known passphrases for networks whose passphrase is fixed. */
export const NETWORK_PASSPHRASES: Readonly<Partial<Record<NetworkName, string>>> = Object.freeze({
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  // `local` is intentionally omitted: standalone / quickstart networks can be
  // started with any passphrase.
});

/** Loosely-typed context as supplied by callers; validated by {@link bindSimulationContext}. */
export interface SimulationContextInput {
  /** Canonical network id (`testnet`, `mainnet`, `local`). */
  network?: string;
  /** Network passphrase transactions are signed for. */
  networkPassphrase?: string;
  /** Contract instance the simulation reads from / writes to. */
  contractId?: string;
  /** Contract interface version (e.g. the bindings spec hash). */
  contractVersion?: string;
  /** Ledger sequence the reads were taken at (or the current ledger, when asserting). */
  ledger?: number;
}

/** A validated, deep-frozen simulation context. */
export interface SimulationContext {
  readonly network?: NetworkName;
  readonly networkPassphrase?: string;
  readonly contractId?: string;
  readonly contractVersion?: string;
  readonly ledger?: number;
}

export interface SimulationContextCompareOptions {
  /** Maximum number of ledgers `actual` may advance past `expected` (default: unbounded). */
  maxLedgerDrift?: number;
  /** Last ledger at which the expected context is still valid. */
  validUntilLedger?: number;
}

export interface SimulationContextAssertOptions extends SimulationContextCompareOptions {
  /** Caller state echoed back on the error to prove it was not mutated. */
  stateSnapshot?: unknown;
  /** Lifecycle phase reported on the error (default `simulate`). */
  phase?: SdkErrorPhase;
  /** Attempts completed so far, reported on the error. */
  attempts?: number;
}

/** A single binding violation, as returned by {@link compareSimulationContext}. */
export interface SimulationContextMismatch {
  readonly field: SimulationContextField;
  readonly reason: "missing" | "mismatch" | "ledger-regressed" | "ledger-expired";
  readonly expected: string | number | null;
  readonly actual: string | number | null;
  readonly retryable: boolean;
  readonly message: string;
}

const IDENTITY_FIELDS = ["network", "networkPassphrase", "contractId", "contractVersion"] as const;

function invalid(
  field: SimulationContextField,
  message: string,
  actual: string | number | null,
  phase?: SdkErrorPhase
): SimulationContextMismatchError {
  return new SimulationContextMismatchError(message, {
    field,
    reason: "invalid",
    actual,
    retryable: false,
    phase,
  });
}

function assertLedgerValue(
  value: unknown,
  field: string,
  phase?: SdkErrorPhase
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(
      "ledger",
      `Simulation context ${field} must be a non-negative safe integer (received ${String(value)})`,
      typeof value === "number" ? value : null,
      phase
    );
  }
}

/**
 * Validates, normalizes, and deep-freezes a simulation context.
 *
 * Throws {@link UnsupportedNetworkError} for an unknown network id, and a
 * non-retryable {@link SimulationContextMismatchError} (`reason: "invalid"`)
 * for an empty passphrase / contract / version, a malformed ledger, or a
 * passphrase that does not belong to the declared network.
 */
export function bindSimulationContext(
  input: SimulationContextInput | SimulationContext,
  options: { phase?: SdkErrorPhase } = {}
): SimulationContext {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("network", "Simulation context must be a non-null object", null, options.phase);
  }

  const out: {
    network?: NetworkName;
    networkPassphrase?: string;
    contractId?: string;
    contractVersion?: string;
    ledger?: number;
  } = {};

  if (input.network !== undefined) {
    out.network = validateNetworkName(input.network);
  }

  for (const field of ["networkPassphrase", "contractId", "contractVersion"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw invalid(
        field,
        `Simulation context ${field} must be a non-empty string`,
        typeof value === "string" ? value : null,
        options.phase
      );
    }
    out[field] = value;
  }

  if (input.ledger !== undefined) {
    assertLedgerValue(input.ledger, "ledger", options.phase);
    out.ledger = input.ledger;
  }

  if (out.network && out.networkPassphrase) {
    const canonical = NETWORK_PASSPHRASES[out.network];
    if (canonical !== undefined && canonical !== out.networkPassphrase) {
      throw new SimulationContextMismatchError(
        `Network passphrase does not belong to network '${out.network}'`,
        {
          field: "networkPassphrase",
          reason: "invalid",
          expected: canonical,
          actual: out.networkPassphrase,
          retryable: false,
          phase: options.phase,
        }
      );
    }
  }

  return deepCloneAndFreeze(out) as SimulationContext;
}

/**
 * Compares a bound (expected) context with the observed (actual) context and
 * returns the first violation, or `null` when the binding holds.
 *
 * Only fields present on `expected` are bound. A bound field that `actual`
 * cannot confirm is reported as `missing`. The ledger may advance (subject to
 * `maxLedgerDrift` / `validUntilLedger`) but must never move backwards.
 */
export function compareSimulationContext(
  expected: SimulationContext,
  actual: SimulationContext,
  options: SimulationContextCompareOptions = {}
): SimulationContextMismatch | null {
  for (const field of IDENTITY_FIELDS) {
    const want = expected[field];
    if (want === undefined) continue;
    const got = actual[field];
    if (got === undefined) {
      return {
        field,
        reason: "missing",
        expected: want,
        actual: null,
        retryable: false,
        message: `Simulation context ${field} '${want}' could not be confirmed by the live context`,
      };
    }
    if (got !== want) {
      return {
        field,
        reason: "mismatch",
        expected: want,
        actual: got,
        retryable: false,
        message: `Simulation context ${field} mismatch (bound '${want}', live '${got}')`,
      };
    }
  }

  const bound = expected.ledger;
  const observed = actual.ledger;
  const hasLedgerConstraint =
    bound !== undefined || options.validUntilLedger !== undefined;
  if (!hasLedgerConstraint) return null;

  if (observed === undefined) {
    return {
      field: "ledger",
      reason: "missing",
      expected: bound ?? options.validUntilLedger ?? null,
      actual: null,
      retryable: true,
      message: "Simulation context ledger could not be confirmed by the live context",
    };
  }

  if (bound !== undefined && observed < bound) {
    return {
      field: "ledger",
      reason: "ledger-regressed",
      expected: bound,
      actual: observed,
      retryable: true,
      message: `Ledger moved backwards (bound ${bound}, live ${observed}); the RPC node is lagging or serves a different network`,
    };
  }

  if (options.validUntilLedger !== undefined && observed > options.validUntilLedger) {
    return {
      field: "ledger",
      reason: "ledger-expired",
      expected: options.validUntilLedger,
      actual: observed,
      retryable: true,
      message: `Simulation expired at ledger ${options.validUntilLedger} (live ${observed}); re-simulate before applying`,
    };
  }

  if (
    bound !== undefined &&
    options.maxLedgerDrift !== undefined &&
    observed - bound > options.maxLedgerDrift
  ) {
    return {
      field: "ledger",
      reason: "ledger-expired",
      expected: bound,
      actual: observed,
      retryable: true,
      message: `Ledger advanced ${observed - bound} ledgers past the simulation (max ${options.maxLedgerDrift}); re-simulate before applying`,
    };
  }

  return null;
}

/** Converts a mismatch into a typed error carrying the preserved caller state. */
export function toSimulationContextError(
  mismatch: SimulationContextMismatch,
  options: { stateSnapshot?: unknown; phase?: SdkErrorPhase; attempts?: number } = {}
): SimulationContextMismatchError {
  return new SimulationContextMismatchError(mismatch.message, {
    field: mismatch.field,
    reason: mismatch.reason,
    expected: mismatch.expected,
    actual: mismatch.actual,
    retryable: mismatch.retryable,
    phase: options.phase,
    attempts: options.attempts,
    preservedState: options.stateSnapshot,
  });
}

/**
 * Throws {@link SimulationContextMismatchError} when `actual` violates the
 * binding described by `expected`. Both inputs are validated first.
 */
export function assertSimulationContext(
  expected: SimulationContextInput | SimulationContext,
  actual: SimulationContextInput | SimulationContext,
  options: SimulationContextAssertOptions = {}
): void {
  validateCompareOptions(options, options.phase);
  const boundExpected = bindSimulationContext(expected, { phase: options.phase });
  const boundActual = bindSimulationContext(actual, { phase: options.phase });
  const mismatch = compareSimulationContext(boundExpected, boundActual, options);
  if (mismatch) {
    throw toSimulationContextError(mismatch, options);
  }
}

/** True when `actual` satisfies the binding described by `expected`. */
export function simulationContextMatches(
  expected: SimulationContextInput | SimulationContext,
  actual: SimulationContextInput | SimulationContext,
  options: SimulationContextCompareOptions = {}
): boolean {
  return (
    compareSimulationContext(
      bindSimulationContext(expected),
      bindSimulationContext(actual),
      options
    ) === null
  );
}

function validateCompareOptions(
  options: SimulationContextCompareOptions,
  phase?: SdkErrorPhase
): void {
  if (options.maxLedgerDrift !== undefined) {
    assertLedgerValue(options.maxLedgerDrift, "maxLedgerDrift", phase);
  }
  if (options.validUntilLedger !== undefined) {
    assertLedgerValue(options.validUntilLedger, "validUntilLedger", phase);
  }
}

/** Fields of a prepared transaction needed to check its context. */
export interface PreparedContextSource {
  networkPassphrase: string;
  contractId: string;
  latestLedger: number;
  validUntilLedger: number;
  specHash?: string;
  network?: NetworkName;
}

/** Context a prepared transaction was simulated under. */
export function contextFromPreparedMeta(meta: PreparedContextSource): SimulationContext {
  return bindSimulationContext({
    network: meta.network,
    networkPassphrase: meta.networkPassphrase,
    contractId: meta.contractId,
    contractVersion: meta.specHash,
    ledger: meta.latestLedger > 0 ? meta.latestLedger : undefined,
  });
}

/**
 * Checks that a prepared transaction may still be signed / submitted in the
 * caller's current context.
 *
 * `current` describes where the caller is *now*: identity fields must match
 * what the transaction was simulated for, and `current.ledger` (when given)
 * must lie within `[meta.latestLedger, meta.validUntilLedger]`.
 */
export function assertPreparedTransactionContext(
  meta: PreparedContextSource,
  current: SimulationContextInput,
  options: { phase?: SdkErrorPhase; stateSnapshot?: unknown } = {}
): void {
  const phase = options.phase ?? "sign";
  const bound = bindSimulationContext(current, { phase });
  const prepared = contextFromPreparedMeta(meta);

  // Identity: every field the caller pins must equal the prepared value.
  // A caller-pinned field the prepared transaction does not record (e.g.
  // `network` on metadata from an older SDK) is reported as missing.
  const identityMismatch = compareSimulationContext(
    { ...bound, ledger: undefined },
    { ...prepared, ledger: undefined }
  );
  if (identityMismatch) {
    throw toSimulationContextError(identityMismatch, { ...options, phase });
  }

  if (bound.ledger === undefined) return;
  const ledgerMismatch = compareSimulationContext(
    { ledger: meta.latestLedger > 0 ? meta.latestLedger : undefined },
    { ledger: bound.ledger },
    { validUntilLedger: meta.validUntilLedger > 0 ? meta.validUntilLedger : undefined }
  );
  if (ledgerMismatch) {
    throw toSimulationContextError(ledgerMismatch, { ...options, phase });
  }
}

export type SimulationContextPolicy = "reject" | "refresh";

export interface SimulationContextRefreshEvent {
  readonly previous: SimulationContext;
  readonly next: SimulationContext;
  readonly field: SimulationContextField;
  readonly attempt: number;
}

export interface RunWithSimulationContextOptions<TResult, TState = unknown> {
  /** Reads the live network / ledger / version context before and after `run`. */
  readContext: () => SimulationContextInput | SimulationContext;
  /** Simulation work executed under the captured context. */
  run: (context: SimulationContext) => TResult | Promise<TResult>;
  /** Explicit binding the live context must satisfy before work starts. */
  expected?: SimulationContextInput | SimulationContext;
  /** Maximum ledgers the context may advance while `run` executes. */
  maxLedgerDrift?: number;
  /** Caller state / balances echoed back, untouched, on failure. */
  stateSnapshot?: TState;
  /** `reject` (default) throws on any transition; `refresh` retries retryable ones. */
  onTransition?: SimulationContextPolicy;
  /** Maximum attempts under `refresh` (default 3, clamped to [1, 10]). */
  maxAttempts?: number;
  /** Called before each refresh retry. */
  onRefresh?: (event: SimulationContextRefreshEvent) => void;
}

export interface SimulationContextRunResult<TResult, TState = unknown> {
  readonly result: TResult;
  /** Context the result was computed under. */
  readonly context: SimulationContext;
  /** Context observed after `run` completed. */
  readonly observedContext: SimulationContext;
  readonly attempts: number;
  readonly preservedState?: TState;
}

const DEFAULT_CONTEXT_MAX_ATTEMPTS = 3;
const MAX_CONTEXT_ATTEMPTS = 10;

/**
 * Runs simulation work bound to the live network / ledger / version context
 * and verifies the context did not transition while the work was in flight.
 *
 * - Identity transitions (network, passphrase, contract, version) always
 *   reject, even under `refresh`: re-running would target another deployment.
 * - Ledger regressions / excessive drift reject under `reject` and re-run
 *   under `refresh` (bounded by `maxAttempts`).
 * - Errors thrown by `run` propagate unchanged and are never retried here.
 * - On every failure path `stateSnapshot` is returned untouched on the error.
 */
export async function runWithSimulationContext<TResult, TState = unknown>(
  options: RunWithSimulationContextOptions<TResult, TState>
): Promise<SimulationContextRunResult<TResult, TState>> {
  const policy = options.onTransition ?? "reject";
  const requested = options.maxAttempts ?? DEFAULT_CONTEXT_MAX_ATTEMPTS;
  const maxAttempts =
    policy === "refresh"
      ? Math.min(
          MAX_CONTEXT_ATTEMPTS,
          Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_CONTEXT_MAX_ATTEMPTS)
        )
      : 1;
  const preservedState =
    options.stateSnapshot === undefined ? undefined : deepCloneAndFreeze(options.stateSnapshot);
  if (options.maxLedgerDrift !== undefined) {
    assertLedgerValue(options.maxLedgerDrift, "maxLedgerDrift");
  }
  const expected =
    options.expected === undefined ? undefined : bindSimulationContext(options.expected);

  let lastError: SimulationContextMismatchError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = bindSimulationContext(options.readContext());
    if (expected) {
      const preMismatch = compareSimulationContext(expected, before);
      if (preMismatch) {
        lastError = toSimulationContextError(preMismatch, {
          stateSnapshot: preservedState,
          attempts: attempt,
        });
        if (!preMismatch.retryable || policy !== "refresh" || attempt === maxAttempts) {
          throw lastError;
        }
        options.onRefresh?.({ previous: expected, next: before, field: preMismatch.field, attempt });
        continue;
      }
    }

    const result = await options.run(before);
    const after = bindSimulationContext(options.readContext());
    const mismatch = compareSimulationContext(before, after, {
      maxLedgerDrift: options.maxLedgerDrift,
    });

    if (!mismatch) {
      return { result, context: before, observedContext: after, attempts: attempt, preservedState };
    }

    lastError = toSimulationContextError(mismatch, {
      stateSnapshot: preservedState,
      attempts: attempt,
    });
    if (!mismatch.retryable || policy !== "refresh" || attempt === maxAttempts) {
      throw lastError;
    }
    options.onRefresh?.({ previous: before, next: after, field: mismatch.field, attempt });
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw lastError!;
}
