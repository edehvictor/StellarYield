/**
 * Strategy Comparison Configuration Fingerprint (#1918)
 *
 * Provides an immutable cryptographic fingerprint for strategy comparison
 * configurations and snapshots. When strategies are compared or executed,
 * this fingerprint guarantees:
 * 1. The comparison parameters, supported protocols, and validation rules
 *    exactly match what was originally evaluated.
 * 2. Any stale configuration snapshots are rejected with stable typed error codes
 *    (e.g., STALE_STRATEGY_CONFIG), prompting a safe refresh.
 * 3. Existing application state and balances are strictly preserved when
 *    validation or execution fails.
 */

// ── Pure JavaScript SHA-256 (RFC 6234 / FIPS 180-4) ────────────────────────
// Zero external dependencies; runs synchronously and identically in Node, browser, and workers.

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export function sha256Pure(message: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let H0 = 0x6a09e667;
  let H1 = 0xbb67ae85;
  let H2 = 0x3c6ef372;
  let H3 = 0xa54ff53a;
  let H4 = 0x510e527f;
  let H5 = 0x9b05688c;
  let H6 = 0x1f83d9ab;
  let H7 = 0x5be0cd19;

  const utf8: number[] = [];
  for (let i = 0; i < message.length; i++) {
    let charCode = message.charCodeAt(i);
    if (charCode < 0x80) {
      utf8.push(charCode);
    } else if (charCode < 0x800) {
      utf8.push(0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f));
    } else if (charCode < 0xd800 || charCode >= 0xe000) {
      utf8.push(
        0xe0 | (charCode >> 12),
        0x80 | ((charCode >> 6) & 0x3f),
        0x80 | (charCode & 0x3f),
      );
    } else {
      i++;
      charCode = 0x10000 + (((charCode & 0x3ff) << 10) | (message.charCodeAt(i) & 0x3ff));
      utf8.push(
        0xf0 | (charCode >> 18),
        0x80 | ((charCode >> 12) & 0x3f),
        0x80 | ((charCode >> 6) & 0x3f),
        0x80 | (charCode & 0x3f),
      );
    }
  }

  const bitLength = utf8.length * 8;
  utf8.push(0x80);
  while ((utf8.length + 8) % 64 !== 0) {
    utf8.push(0);
  }

  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  for (let i = 3; i >= 0; i--) utf8.push((highBits >>> (i * 8)) & 0xff);
  for (let i = 3; i >= 0; i--) utf8.push((lowBits >>> (i * 8)) & 0xff);

  const W = new Uint32Array(64);

  for (let chunk = 0; chunk < utf8.length; chunk += 64) {
    for (let t = 0; t < 16; t++) {
      const idx = chunk + t * 4;
      W[t] =
        (utf8[idx] << 24) |
        (utf8[idx + 1] << 16) |
        (utf8[idx + 2] << 8) |
        utf8[idx + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rightRotate(W[t - 15], 7) ^ rightRotate(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rightRotate(W[t - 2], 17) ^ rightRotate(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let a = H0;
    let b = H1;
    let c = H2;
    let d = H3;
    let e = H4;
    let f = H5;
    let g = H6;
    let h = H7;

    for (let t = 0; t < 64; t++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H0 = (H0 + a) >>> 0;
    H1 = (H1 + b) >>> 0;
    H2 = (H2 + c) >>> 0;
    H3 = (H3 + d) >>> 0;
    H4 = (H4 + e) >>> 0;
    H5 = (H5 + f) >>> 0;
    H6 = (H6 + g) >>> 0;
    H7 = (H7 + h) >>> 0;
  }

  const toHex = (n: number) => n.toString(16).padStart(8, "0");
  return `${toHex(H0)}${toHex(H1)}${toHex(H2)}${toHex(H3)}${toHex(H4)}${toHex(H5)}${toHex(H6)}${toHex(H7)}`;
}

/**
 * Deterministically serializes an object with sorted keys.
 */
export function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${pairs.join(",")}}`;
}

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Normalized immutable parameters that constitute a strategy comparison configuration.
 */
export interface StrategyComparisonConfig {
  /** Supported protocol identifiers or names. E.g. ["Blend", "DeFindex", "Soroswap"] */
  supportedProtocols: string[];
  /** Validation rules for boundary checking. */
  validationRules: {
    requiredFields: string[];
    allowedRebalancingBehaviors: string[];
    minLiquidityUsd?: number;
  };
  /** Version of the comparison schema and rule logic. */
  schemaVersion: string;
  /** Optional risk constraints. */
  riskConstraints?: {
    maxRiskScore?: number;
    maxVolatilityPct?: number;
  };
}

/**
 * Default active strategy comparison configuration for StellarYield.
 */
export const DEFAULT_STRATEGY_COMPARISON_CONFIG: StrategyComparisonConfig = {
  supportedProtocols: ["Blend", "DeFindex", "Soroswap"],
  validationRules: {
    requiredFields: ["protocolName", "apy", "tvl", "riskScore", "liquidityUsd"],
    allowedRebalancingBehaviors: ["Static", "Dynamic", "Yield-Weighted"],
    minLiquidityUsd: 0,
  },
  schemaVersion: "1.0.0",
  riskConstraints: {
    maxRiskScore: 100,
    maxVolatilityPct: 100,
  },
};

/**
 * Computed fingerprint result for a strategy comparison configuration.
 */
export interface StrategyComparisonFingerprintResult {
  /** 64-character lowercase SHA-256 hex digest. */
  fingerprint: string;
  /** Human-readable compact format (e.g. "scf-a1b2c3...d4e5"). */
  shortFingerprint: string;
  /** Deterministic sorted JSON string from which the digest was computed. */
  canonicalPayload: string;
  /** Canonical configuration copy. */
  config: StrategyComparisonConfig;
  /** ISO timestamp when the fingerprint was computed. */
  computedAt: string;
}

export type FingerprintVerificationStatus = "verified" | "stale" | "invalid";

export interface FingerprintVerificationResult {
  valid: boolean;
  status: FingerprintVerificationStatus;
  code: "FINGERPRINT_VERIFIED" | "STALE_STRATEGY_CONFIG" | "INVALID_FINGERPRINT";
  message: string;
  expectedFingerprint: string;
  actualFingerprint?: string;
  driftReasons?: string[];
}

/**
 * Application state tracking selected strategy, balances, and execution status.
 */
export interface StrategyExecutionState<TBalance = Record<string, number>> {
  selectedStrategyId: string | null;
  balances: TBalance;
  lastConfirmedFingerprint: string | null;
  executionStatus: "idle" | "validating" | "executed" | "failed" | "stale_rejected";
  errorMessage?: string | null;
}

// ── Canonicalization & Fingerprinting ──────────────────────────────────────

/**
 * Normalizes a StrategyComparisonConfig into an order-independent canonical representation.
 */
export function canonicalizeStrategyComparisonConfig(
  config: StrategyComparisonConfig,
): Record<string, unknown> {
  const normalizedProtocols = Array.isArray(config.supportedProtocols)
    ? [...config.supportedProtocols].map((p) => String(p).trim()).sort()
    : [];

  const normalizedRequiredFields = Array.isArray(config.validationRules?.requiredFields)
    ? [...config.validationRules.requiredFields].map((f) => String(f).trim()).sort()
    : [];

  const normalizedBehaviors = Array.isArray(config.validationRules?.allowedRebalancingBehaviors)
    ? [...config.validationRules.allowedRebalancingBehaviors].map((b) => String(b).trim()).sort()
    : [];

  return {
    riskConstraints: {
      maxRiskScore: Number(config.riskConstraints?.maxRiskScore ?? 100),
      maxVolatilityPct: Number(config.riskConstraints?.maxVolatilityPct ?? 100),
    },
    schemaVersion: String(config.schemaVersion ?? "1.0.0").trim(),
    supportedProtocols: normalizedProtocols,
    validationRules: {
      allowedRebalancingBehaviors: normalizedBehaviors,
      minLiquidityUsd: Number(config.validationRules?.minLiquidityUsd ?? 0),
      requiredFields: normalizedRequiredFields,
    },
  };
}

/**
 * Computes a deterministic SHA-256 fingerprint for a strategy comparison configuration.
 */
export function computeStrategyComparisonConfigFingerprint(
  config: StrategyComparisonConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG,
): StrategyComparisonFingerprintResult {
  const canonical = canonicalizeStrategyComparisonConfig(config);
  const canonicalPayload = stableStringify(canonical);
  const fingerprint = sha256Pure(canonicalPayload);
  const shortFingerprint = formatShortFingerprint(fingerprint);

  return {
    fingerprint,
    shortFingerprint,
    canonicalPayload,
    config,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Formats a 64-char hex digest into a readable badge (e.g. "scf-8f3a1c...4b2d").
 */
export function formatShortFingerprint(fingerprint: string, prefix = "scf-"): string {
  if (!fingerprint || typeof fingerprint !== "string") {
    return `${prefix}invalid`;
  }
  const clean = fingerprint.replace(/^0x/i, "");
  if (clean.length < 12) {
    return `${prefix}${clean}`;
  }
  return `${prefix}${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

/**
 * Verifies whether a claimed configuration fingerprint matches the current configuration.
 */
export function verifyStrategyComparisonConfigFingerprint(
  currentConfig: StrategyComparisonConfig,
  claimedFingerprint: string,
): FingerprintVerificationResult {
  if (!claimedFingerprint || typeof claimedFingerprint !== "string" || claimedFingerprint.trim() === "") {
    return {
      valid: false,
      status: "invalid",
      code: "INVALID_FINGERPRINT",
      message: "Missing or malformed strategy comparison configuration fingerprint.",
      expectedFingerprint: computeStrategyComparisonConfigFingerprint(currentConfig).fingerprint,
      actualFingerprint: claimedFingerprint,
    };
  }

  const computed = computeStrategyComparisonConfigFingerprint(currentConfig);
  const expected = computed.fingerprint.toLowerCase();
  const actual = claimedFingerprint.trim().toLowerCase().replace(/^0x/i, "");

  if (expected !== actual) {
    return {
      valid: false,
      status: "stale",
      code: "STALE_STRATEGY_CONFIG",
      message: "Strategy comparison configuration snapshot is stale. Configuration must be refreshed before proceeding.",
      driftReasons: ["Active configuration rules or supported protocols have changed since snapshot was created."],
      expectedFingerprint: expected,
      actualFingerprint: actual,
    };
  }

  return {
    valid: true,
    status: "verified",
    code: "FINGERPRINT_VERIFIED",
    message: "Strategy comparison configuration snapshot verified and bound.",
    expectedFingerprint: expected,
    actualFingerprint: actual,
  };
}

// ── State and Balance Preservation Safe Executor ──────────────────────────

export interface SafeExecuteOptions<TBalance, TResult> {
  activeConfig: StrategyComparisonConfig;
  snapshotFingerprint: string;
  currentState: StrategyExecutionState<TBalance>;
  targetStrategyId?: string;
  validate?: () => boolean | string;
  execute: () => Promise<TResult> | TResult;
  onSuccessBalanceUpdate?: (currentBalances: TBalance) => TBalance;
}

export interface SafeExecuteResult<TBalance, TResult> {
  success: boolean;
  state: StrategyExecutionState<TBalance>;
  result?: TResult;
  error?: string;
  errorCode?: "STALE_STRATEGY_CONFIG" | "VALIDATION_FAILED" | "EXECUTION_FAILED";
  isRecoverable: boolean;
}

/**
 * Executes strategy selection or operation safely.
 *
 * CRITICAL ACCEPTANCE CRITERIA GUARANTEES:
 * 1. If snapshot fingerprint is stale:
 *    - Immediately rejects with STALE_STRATEGY_CONFIG.
 *    - Existing state and balances remain 100% UNCHANGED.
 * 2. If validation fails:
 *    - Immediately stops before execution.
 *    - Existing state and balances remain 100% UNCHANGED.
 * 3. If execution fails:
 *    - Caught safely, avoiding partial mutations or inconsistent state.
 *    - Existing state and balances remain 100% UNCHANGED.
 * 4. Only upon successful verification, validation, and execution:
 *    - State is updated to "executed" with updated balances and confirmed fingerprint.
 */
export async function executeStrategySafely<TBalance, TResult>(
  options: SafeExecuteOptions<TBalance, TResult>,
): Promise<SafeExecuteResult<TBalance, TResult>> {
  const {
    activeConfig,
    snapshotFingerprint,
    currentState,
    targetStrategyId,
    validate,
    execute,
    onSuccessBalanceUpdate,
  } = options;

  // 1. Immutable Fingerprint Verification: Reject stale configuration
  const verification = verifyStrategyComparisonConfigFingerprint(activeConfig, snapshotFingerprint);
  if (!verification.valid) {
    return {
      success: false,
      state: {
        ...currentState,
        executionStatus: "stale_rejected",
        errorMessage: verification.message,
      },
      error: verification.message,
      errorCode: verification.code === "INVALID_FINGERPRINT" ? "VALIDATION_FAILED" : "STALE_STRATEGY_CONFIG",
      isRecoverable: true,
    };
  }

  // 2. Boundary Validation Check: Preserve state on failure
  if (validate) {
    const valResult = validate();
    if (valResult !== true) {
      const errorMsg = typeof valResult === "string" ? valResult : "Strategy validation failed.";
      return {
        success: false,
        state: {
          ...currentState,
          executionStatus: "failed",
          errorMessage: errorMsg,
        },
        error: errorMsg,
        errorCode: "VALIDATION_FAILED",
        isRecoverable: true,
      };
    }
  }

  // 3. Execution Protection: Preserve state on execution failure
  try {
    const result = await execute();

    // 4. Successful execution: commit state and update balance safely
    const updatedBalances = onSuccessBalanceUpdate
      ? onSuccessBalanceUpdate(currentState.balances)
      : currentState.balances;

    return {
      success: true,
      state: {
        selectedStrategyId: targetStrategyId ?? currentState.selectedStrategyId,
        balances: updatedBalances,
        lastConfirmedFingerprint: verification.expectedFingerprint,
        executionStatus: "executed",
        errorMessage: null,
      },
      result,
      isRecoverable: false,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Strategy execution failed.";
    // State and balances are preserved intact
    return {
      success: false,
      state: {
        ...currentState,
        executionStatus: "failed",
        errorMessage: errorMsg,
      },
      error: errorMsg,
      errorCode: "EXECUTION_FAILED",
      isRecoverable: true,
    };
  }
}
