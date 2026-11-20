/**
 * Immutable configuration fingerprints for portfolio valuation (#1862).
 *
 * A portfolio valuation is only meaningful relative to the configuration that
 * produced it (pricing source, network, concentration thresholds, asset-class
 * mapping, ...). When that configuration changes while a valuation is in flight
 * — or after a result has been cached — the result describes a configuration
 * that no longer exists and must not be committed over the current state.
 *
 * This module provides:
 * 1. `captureValuationConfig` — deep-copies and deep-freezes a configuration and
 *    derives a deterministic, immutable fingerprint from its canonical form.
 * 2. `assertValuationConfigCurrent` — rejects work whose fingerprint no longer
 *    matches the live configuration with a typed, retryable error.
 * 3. `runWithValuationConfig` — captures a snapshot, runs side-effect-free
 *    valuation work against it, re-checks the live configuration before
 *    returning, and either rejects or transparently refreshes (re-runs) when the
 *    configuration changed underneath it.
 *
 * Callers commit results only after these checks pass, so a stale snapshot can
 * never overwrite existing state or balances.
 *
 * The fingerprint is a change detector, not a security primitive: it is a
 * deterministic 64-bit FNV-1a digest of the canonical JSON, safe to expose in API
 * responses because it never contains raw configuration values.
 */

/** JSON-compatible value permitted inside a valuation configuration. */
export type ValuationConfigValue =
  | string
  | number
  | boolean
  | null
  | readonly ValuationConfigValue[]
  | { readonly [key: string]: ValuationConfigValue | undefined };

/** Configuration that influences how a portfolio is valued. */
export type PortfolioValuationConfig = {
  readonly [key: string]: ValuationConfigValue | undefined;
};

/** Versioned prefix so the fingerprint format can evolve safely. */
export const VALUATION_CONFIG_FINGERPRINT_PREFIX = "pvcfg1:";

/** `pvcfg1:` followed by 16 lowercase hex characters. */
export type ValuationConfigFingerprint = string;

/** An immutable configuration paired with the fingerprint derived from it. */
export interface ValuationConfigSnapshot {
  readonly config: PortfolioValuationConfig;
  readonly fingerprint: ValuationConfigFingerprint;
}

export type ValuationConfigErrorCode =
  | "VALUATION_CONFIG_STALE"
  | "VALUATION_CONFIG_INVALID";

/**
 * Raised when valuation work no longer matches the live configuration, or when a
 * configuration cannot be fingerprinted. Never carries raw configuration values.
 */
export class ValuationConfigError extends Error {
  readonly code: ValuationConfigErrorCode;
  readonly retryable: boolean;
  readonly expectedFingerprint: ValuationConfigFingerprint | null;
  readonly actualFingerprint: ValuationConfigFingerprint | null;

  constructor(
    code: ValuationConfigErrorCode,
    message: string,
    details: {
      expectedFingerprint?: ValuationConfigFingerprint | null;
      actualFingerprint?: ValuationConfigFingerprint | null;
    } = {},
  ) {
    super(message);
    this.name = "ValuationConfigError";
    this.code = code;
    // A stale snapshot is fixed by re-running against the fresh configuration;
    // an invalid configuration will fail the same way again.
    this.retryable = code === "VALUATION_CONFIG_STALE";
    this.expectedFingerprint = details.expectedFingerprint ?? null;
    this.actualFingerprint = details.actualFingerprint ?? null;
  }
}

export function isValuationConfigError(error: unknown): error is ValuationConfigError {
  return (
    error instanceof ValuationConfigError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "ValuationConfigError" &&
      typeof (error as { code?: unknown }).code === "string")
  );
}

function invalid(path: string, reason: string): ValuationConfigError {
  return new ValuationConfigError(
    "VALUATION_CONFIG_INVALID",
    `Valuation configuration is not fingerprintable at "${path}": ${reason}.`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical JSON: object keys sorted, `undefined` object members dropped (so an
 * absent optional override equals an omitted one), `-0` normalised to `0`.
 * Rejects values that have no stable JSON form (NaN, Infinity, functions,
 * class instances, cycles).
 */
export function canonicalizeValuationConfig(config: unknown): string {
  const seen = new Set<unknown>();

  const walk = (value: unknown, path: string): string => {
    if (value === null) return "null";
    switch (typeof value) {
      case "string":
        return JSON.stringify(value);
      case "boolean":
        return value ? "true" : "false";
      case "number":
        if (!Number.isFinite(value)) throw invalid(path, "non-finite number");
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
      case "object":
        break;
      default:
        throw invalid(path, `unsupported ${typeof value} value`);
    }

    if (seen.has(value)) throw invalid(path, "circular reference");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, i) => {
            if (item === undefined) throw invalid(`${path}[${i}]`, "undefined array item");
            return walk(item, `${path}[${i}]`);
          })
          .join(",")}]`;
      }
      if (!isPlainObject(value)) throw invalid(path, "non-plain object");
      const keys = Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${walk(value[key], `${path}.${key}`)}`)
        .join(",")}}`;
    } finally {
      seen.delete(value);
    }
  };

  if (!isPlainObject(config)) throw invalid("$", "configuration must be a plain object");
  return walk(config, "$");
}

/** 32-bit FNV-1a over UTF-16 code units, seeded so two lanes give 64 bits. */
function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic fingerprint of a valuation configuration. */
export function computeValuationConfigFingerprint(
  config: PortfolioValuationConfig,
): ValuationConfigFingerprint {
  const canonical = canonicalizeValuationConfig(config);
  const high = fnv1a32(canonical, 0x811c9dc5);
  const low = fnv1a32(canonical, 0x050c5d1f);
  return (
    VALUATION_CONFIG_FINGERPRINT_PREFIX +
    high.toString(16).padStart(8, "0") +
    low.toString(16).padStart(8, "0")
  );
}

export function isValuationConfigFingerprint(value: unknown): value is ValuationConfigFingerprint {
  return typeof value === "string" && /^pvcfg1:[0-9a-f]{16}$/.test(value);
}

function deepCloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepCloneAndFreeze(item))) as unknown as T;
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (value[key] !== undefined) copy[key] = deepCloneAndFreeze(value[key]);
    }
    return Object.freeze(copy) as T;
  }
  return value;
}

/**
 * Captures an immutable snapshot of `config`. The input is validated, deep-copied
 * and deep-frozen, so later mutation of the caller's object cannot change what the
 * fingerprint describes.
 */
export function captureValuationConfig(
  config: PortfolioValuationConfig,
): ValuationConfigSnapshot {
  const fingerprint = computeValuationConfigFingerprint(config);
  return Object.freeze({ config: deepCloneAndFreeze(config), fingerprint });
}

type FingerprintSource =
  | ValuationConfigFingerprint
  | ValuationConfigSnapshot
  | PortfolioValuationConfig;

function toFingerprint(source: FingerprintSource): ValuationConfigFingerprint {
  if (typeof source === "string") {
    if (!isValuationConfigFingerprint(source)) {
      throw new ValuationConfigError(
        "VALUATION_CONFIG_INVALID",
        "Valuation configuration fingerprint is malformed.",
      );
    }
    return source;
  }
  if (
    isPlainObject(source) &&
    isValuationConfigFingerprint(source.fingerprint) &&
    isPlainObject(source.config)
  ) {
    return source.fingerprint as ValuationConfigFingerprint;
  }
  return computeValuationConfigFingerprint(source as PortfolioValuationConfig);
}

/** True when both sources describe the same configuration. */
export function valuationConfigMatches(
  expected: FingerprintSource,
  current: FingerprintSource,
): boolean {
  return toFingerprint(expected) === toFingerprint(current);
}

/**
 * Throws a retryable `VALUATION_CONFIG_STALE` error when `expected` no longer
 * matches `current`. Use immediately before committing any valuation result.
 */
export function assertValuationConfigCurrent(
  expected: FingerprintSource,
  current: FingerprintSource,
): void {
  const expectedFingerprint = toFingerprint(expected);
  const actualFingerprint = toFingerprint(current);
  if (expectedFingerprint !== actualFingerprint) {
    throw new ValuationConfigError(
      "VALUATION_CONFIG_STALE",
      "Valuation configuration changed while the valuation was being computed.",
      { expectedFingerprint, actualFingerprint },
    );
  }
}

export type StaleValuationConfigPolicy = "reject" | "refresh";

export interface RunWithValuationConfigOptions<T> {
  /** Reads the live configuration. Called before and after every attempt. */
  readConfig: () => PortfolioValuationConfig;
  /**
   * Valuation work. Must not commit state: its result is discarded when the
   * configuration changed while it ran.
   */
  run: (snapshot: ValuationConfigSnapshot) => T | Promise<T>;
  /** `reject` (default) throws on drift; `refresh` re-runs on the new config. */
  onStale?: StaleValuationConfigPolicy;
  /** Maximum attempts under the `refresh` policy (default 3, minimum 1). */
  maxAttempts?: number;
}

export interface ValuationConfigRunResult<T> {
  value: T;
  snapshot: ValuationConfigSnapshot;
  attempts: number;
}

/**
 * Runs valuation work against an immutable configuration snapshot and returns
 * only when the live configuration still matches that snapshot afterwards.
 * Errors from `run` propagate unchanged, and nothing is returned for a stale
 * attempt, so callers that commit only on success preserve their prior state.
 */
export async function runWithValuationConfig<T>(
  options: RunWithValuationConfigOptions<T>,
): Promise<ValuationConfigRunResult<T>> {
  const policy = options.onStale ?? "reject";
  const maxAttempts =
    policy === "refresh" ? Math.max(1, Math.floor(options.maxAttempts ?? 3)) : 1;

  let lastError: ValuationConfigError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const snapshot = captureValuationConfig(options.readConfig());
    const value = await options.run(snapshot);
    const current = computeValuationConfigFingerprint(options.readConfig());
    if (current === snapshot.fingerprint) {
      return { value, snapshot, attempts: attempt };
    }
    lastError = new ValuationConfigError(
      "VALUATION_CONFIG_STALE",
      "Valuation configuration changed while the valuation was being computed.",
      { expectedFingerprint: snapshot.fingerprint, actualFingerprint: current },
    );
  }
  throw lastError as ValuationConfigError;
}
