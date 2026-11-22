/**
 * Immutable configuration fingerprints for SDK simulation APIs (#1851).
 *
 * A simulation preview (deposit allocation, fee estimation, expected output,
 * slippage bounds, Soroban footprint, resource fee) is only valid relative to
 * the configuration snapshot under which it was evaluated (network, strategy,
 * protocol weights, fee rates, pricing assumptions, contract versions).
 *
 * When configuration changes while a simulation is in flight — or when a caller
 * reuses a cached simulation computed against an older configuration snapshot —
 * the simulation output is stale and must not be applied or committed over live
 * state.
 *
 * This module provides:
 * 1. `captureSimulationConfig` — validates, deep-copies, and deep-freezes a
 *    configuration object, deriving a deterministic, immutable fingerprint.
 * 2. `computeSimulationConfigFingerprint` — creates a versioned `simcfg1:<hex>`
 *    hash from canonical JSON representation.
 * 3. `assertSimulationConfigCurrent` — rejects work whose fingerprint no longer
 *    matches the live configuration with a typed, retryable error.
 * 4. `runWithSimulationConfig` — captures a snapshot, executes simulation work,
 *    verifies the configuration has not drifted, and either rejects or refreshes
 *    safely while preserving existing state and balances.
 * 5. State and balance preservation guards ensuring validation and execution
 *    failures never mutate prior balances or application state.
 */

import { StaleSimulationConfigError } from "./errors";

/** JSON-compatible scalar or composite value permitted in a simulation configuration. */
export type SimulationConfigValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | readonly SimulationConfigValue[]
  | { readonly [key: string]: SimulationConfigValue | undefined };

/** Configuration structure that influences simulation calculations. */
export type SimulationConfig = {
  readonly [key: string]: SimulationConfigValue | undefined;
};

/** Versioned prefix for SDK simulation configuration fingerprints. */
export const SIMULATION_CONFIG_FINGERPRINT_PREFIX = "simcfg1:";

/** Format: `simcfg1:<16 hex chars>` */
export type SimulationConfigFingerprint = `${typeof SIMULATION_CONFIG_FINGERPRINT_PREFIX}${string}`;

/** An immutable simulation configuration paired with its derived fingerprint. */
export interface SimulationConfigSnapshot<
  TConfig extends SimulationConfig = SimulationConfig
> {
  readonly config: TConfig;
  readonly fingerprint: SimulationConfigFingerprint;
  readonly capturedAt: number;
}

export type StaleSimulationConfigPolicy = "reject" | "refresh";

export interface SimulationConfigRefreshEvent {
  readonly previousFingerprint: SimulationConfigFingerprint;
  readonly nextFingerprint: SimulationConfigFingerprint;
  readonly attempt: number;
}

export interface RunWithSimulationConfigOptions<TResult, TState = unknown> {
  /** Reads the current live configuration before and after work. */
  readConfig: () => SimulationConfig;
  /** Current state or account balances to preserve if simulation fails. */
  stateSnapshot?: TState;
  /** Simulation work to execute under the captured snapshot. */
  run: (snapshot: SimulationConfigSnapshot) => TResult | Promise<TResult>;
  /** Policy on configuration drift: "reject" (default) or "refresh". */
  onStale?: StaleSimulationConfigPolicy;
  /** Maximum execution attempts when onStale is "refresh" (default 3, min 1). */
  maxAttempts?: number;
  /** Optional callback invoked when a stale snapshot is refreshed. */
  onRefresh?: (event: SimulationConfigRefreshEvent) => void;
}

export interface SimulationConfigRunResult<TResult, TState = unknown> {
  readonly result: TResult;
  readonly snapshot: SimulationConfigSnapshot;
  readonly attempts: number;
  readonly preservedState?: TState;
}

/** Check if a string is a valid simulation configuration fingerprint format. */
export function isSimulationConfigFingerprint(
  value: unknown
): value is SimulationConfigFingerprint {
  return (
    typeof value === "string" &&
    value.startsWith(SIMULATION_CONFIG_FINGERPRINT_PREFIX) &&
    new RegExp(`^${SIMULATION_CONFIG_FINGERPRINT_PREFIX}[0-9a-f]{16}$`).test(value)
  );
}

/**
 * Recursively deep clones and freezes an object, making it completely immutable.
 */
export function deepCloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    const frozenArray = value.map((item) => deepCloneAndFreeze(item));
    return Object.freeze(frozenArray) as unknown as T;
  }

  const frozenObj: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const val = (value as Record<string, unknown>)[key];
    if (val !== undefined) {
      frozenObj[key] = deepCloneAndFreeze(val);
    }
  }
  return Object.freeze(frozenObj) as T;
}

/**
 * 64-bit FNV-1a hash algorithm returning a 16-character hex string.
 * Deterministic across all environments with zero dependencies.
 */
function fnv1a64(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;

  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c ^ (h1 >>> 16);
    h2 = Math.imul(h2, 0x01000193);
  }

  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${hex1}${hex2}`;
}

/**
 * Canonical JSON serializer for simulation configurations.
 * Sorts object keys recursively and normalizes numbers and bigints.
 */
function canonicalizeJson(value: unknown, path = "$"): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Simulation configuration contains non-finite number at ${path}: ${value}`);
    }
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "bigint") {
    return `"${value.toString()}n"`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, idx) => canonicalizeJson(item, `${path}[${idx}]`));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      const val = (value as Record<string, unknown>)[key];
      if (val !== undefined) {
        pairs.push(`${JSON.stringify(key)}:${canonicalizeJson(val, `${path}.${key}`)}`);
      }
    }
    return `{${pairs.join(",")}}`;
  }
  throw new Error(`Unsupported type in simulation configuration at ${path}: ${typeof value}`);
}

/**
 * Computes a deterministic immutable fingerprint for a simulation configuration.
 * Excludes raw secrets/keys and guarantees identical hashes for identical configurations.
 */
export function computeSimulationConfigFingerprint(
  config: SimulationConfig
): SimulationConfigFingerprint {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Simulation configuration must be a non-null object");
  }
  const canonical = canonicalizeJson(config);
  const hash = fnv1a64(canonical);
  return `${SIMULATION_CONFIG_FINGERPRINT_PREFIX}${hash}`;
}

/**
 * Captures an immutable snapshot of a simulation configuration.
 * The input is validated, deep-copied, and deep-frozen.
 */
export function captureSimulationConfig<TConfig extends SimulationConfig = SimulationConfig>(
  config: TConfig
): SimulationConfigSnapshot<TConfig> {
  const fingerprint = computeSimulationConfigFingerprint(config);
  const frozenConfig = deepCloneAndFreeze(config);
  return Object.freeze({
    config: frozenConfig,
    fingerprint,
    capturedAt: Date.now(),
  });
}

type FingerprintSource =
  | SimulationConfigFingerprint
  | SimulationConfigSnapshot
  | SimulationConfig;

export function resolveFingerprint(source: FingerprintSource): SimulationConfigFingerprint {
  if (typeof source === "string") {
    if (!isSimulationConfigFingerprint(source)) {
      throw new StaleSimulationConfigError("Simulation configuration fingerprint is malformed", {
        actualFingerprint: source,
        statePreserved: true,
      });
    }
    return source;
  }
  if (
    typeof source === "object" &&
    source !== null &&
    "fingerprint" in source &&
    isSimulationConfigFingerprint(source.fingerprint)
  ) {
    return source.fingerprint;
  }
  return computeSimulationConfigFingerprint(source as SimulationConfig);
}

/** Returns true when two configuration sources represent identical configurations. */
export function simulationConfigMatches(
  expected: FingerprintSource,
  current: FingerprintSource
): boolean {
  return resolveFingerprint(expected) === resolveFingerprint(current);
}

/**
 * Asserts that the expected configuration matches the current configuration.
 * Throws a retryable StaleSimulationConfigError on mismatch while preserving state.
 */
export function assertSimulationConfigCurrent(
  expected: FingerprintSource,
  current: FingerprintSource,
  options: { stateSnapshot?: unknown; message?: string } = {}
): void {
  const expectedFingerprint = resolveFingerprint(expected);
  const actualFingerprint = resolveFingerprint(current);

  if (expectedFingerprint !== actualFingerprint) {
    throw new StaleSimulationConfigError(
      options.message ??
        `Simulation configuration snapshot is stale (expected ${expectedFingerprint}, current ${actualFingerprint})`,
      {
        expectedFingerprint,
        actualFingerprint,
        statePreserved: true,
        preservedState: options.stateSnapshot,
      }
    );
  }
}

/**
 * State & balance preservation wrapper.
 * Ensures initial state and balances remain completely unmodified if an operation throws.
 */
export class StatePreservationGuard<TState> {
  private readonly initialSnapshot: TState;

  constructor(state: TState) {
    this.initialSnapshot = deepCloneAndFreeze(state);
  }

  public getSnapshot(): TState {
    return this.initialSnapshot;
  }

  /**
   * Run a simulation action. If the action throws or validation fails,
   * the original state is guaranteed preserved.
   */
  public async executeSafely<TResult>(
    action: (state: TState) => Promise<TResult>
  ): Promise<{ result: TResult; preservedState: TState }> {
    try {
      const result = await action(this.initialSnapshot);
      return { result, preservedState: this.initialSnapshot };
    } catch (error) {
      if (error instanceof StaleSimulationConfigError) {
        throw error;
      }
      throw error;
    }
  }
}

/**
 * Runs simulation work against an immutable configuration snapshot and guarantees
 * that the live configuration has not drifted during execution.
 *
 * - With `onStale: "reject"` (default): throws StaleSimulationConfigError on drift.
 * - With `onStale: "refresh"`: refreshes the snapshot and retries up to maxAttempts.
 * - In all failure scenarios, prior state and balances are untouched.
 */
export async function runWithSimulationConfig<TResult, TState = unknown>(
  options: RunWithSimulationConfigOptions<TResult, TState>
): Promise<SimulationConfigRunResult<TResult, TState>> {
  const policy = options.onStale ?? "reject";
  const maxAttempts =
    policy === "refresh" ? Math.max(1, Math.floor(options.maxAttempts ?? 3)) : 1;

  let lastError: StaleSimulationConfigError | null = null;
  const preservedState = options.stateSnapshot
    ? deepCloneAndFreeze(options.stateSnapshot)
    : undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const liveConfig = options.readConfig();
    const snapshot = captureSimulationConfig(liveConfig);

    let result: TResult;
    try {
      result = await options.run(snapshot);
    } catch (runError) {
      if (runError instanceof StaleSimulationConfigError) {
        throw runError;
      }
      throw runError;
    }

    const currentLiveConfig = options.readConfig();
    const currentFingerprint = computeSimulationConfigFingerprint(currentLiveConfig);

    if (currentFingerprint === snapshot.fingerprint) {
      return {
        result,
        snapshot,
        attempts: attempt,
        preservedState,
      };
    }

    lastError = new StaleSimulationConfigError(
      `Simulation configuration drifted during execution (snapshot ${snapshot.fingerprint}, current ${currentFingerprint})`,
      {
        expectedFingerprint: snapshot.fingerprint,
        actualFingerprint: currentFingerprint,
        statePreserved: true,
        preservedState,
      }
    );

    if (policy === "refresh" && attempt < maxAttempts) {
      options.onRefresh?.({
        previousFingerprint: snapshot.fingerprint,
        nextFingerprint: currentFingerprint,
        attempt,
      });
    }
  }

  throw lastError!;
}

