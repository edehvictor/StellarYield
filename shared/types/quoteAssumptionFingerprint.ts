/**
 * Quote Assumption Fingerprint Domain Model & Utilities (#1366)
 *
 * Computes deterministic cryptographic fingerprints over the mathematical
 * and operational assumptions of a swap/deposit quote.
 *
 * When a user reviews a transaction before signing, this fingerprint ensures:
 * 1. The execution parameters (amounts, slippage, route, asset config) exactly
 *    match what was quoted.
 * 2. Any assumption drift (stale price, changed route, modified slippage, expired
 *    quote) is immediately detected and surfaced with stable typed error codes.
 * 3. The user can visually inspect and verify the fingerprint against the review
 *    dialog, ensuring zero-trust verification.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type PricingSource = "router_simulation" | "fallback_rate" | "direct" | string;

/**
 * Normalized immutable parameters that constitute a quote's mathematical assumptions.
 */
export interface QuoteAssumptions {
  /** Input token contract identifier or SAC address. */
  inputTokenContract: string;
  /** Input token symbol if available (e.g. "XLM", "USDC"). */
  inputTokenSymbol?: string;
  /** Vault token contract identifier. */
  vaultTokenContract: string;
  /** Vault token symbol if available. */
  vaultTokenSymbol?: string;
  /** Exact deposit amount in stroops (integer string). */
  amountInStroops: string;
  /** Model-projected gross output in stroops before slippage. */
  expectedAmountOutStroops: string;
  /** Minimum guaranteed output in stroops after slippage deduction. */
  minAmountOutStroops: string;
  /** Applied slippage tolerance as a percentage (e.g., 0.5 for 0.5%). */
  slippageTolerancePct: number;
  /** Canonical route hash representing the path of token swaps. */
  routeHash: string;
  /** Sequence of token contract IDs forming the execution path. */
  path: string[];
  /** Pricing and simulation model source. */
  source: PricingSource;
  /** Version digest of the asset configuration used when quoting. */
  assetConfigVersion: string;
  /** ISO timestamp when the quote was computed. */
  quotedAt: string;
  /** ISO timestamp when the quote becomes invalid. */
  expiresAt: string;
  /** Optional protocol identifier (e.g., "soroswap", "phoenix", "default"). */
  protocol?: string;
  /** Whether the quote verified minimum Stellar wallet reserves. */
  reserveSafe?: boolean;
}

/**
 * Result of computing a quote assumption fingerprint.
 */
export interface QuoteAssumptionFingerprintResult {
  /** 64-character lowercase SHA-256 hex digest. */
  fingerprint: string;
  /** Human-readable compact format (e.g., "qaf-8f3a1c...4b2d"). */
  shortFingerprint: string;
  /** Deterministic sorted JSON string from which the digest was computed. */
  canonicalPayload: string;
  /** The snapshot of assumptions represented by this fingerprint. */
  assumptions: QuoteAssumptions;
  /** ISO timestamp when the fingerprint was generated. */
  computedAt: string;
}

export type FingerprintVerificationStatus =
  | "verified"
  | "expired"
  | "drifted"
  | "invalid";

export interface FingerprintVerificationResult {
  /** True only when assumptions match the fingerprint and quote is still valid. */
  valid: boolean;
  /** High-level verification status for badge display. */
  status: FingerprintVerificationStatus;
  /** Stable machine-readable error or success code. */
  code:
    | "FINGERPRINT_VERIFIED"
    | "STALE_QUOTE"
    | "ASSUMPTION_DRIFT"
    | "ROUTE_MISMATCH"
    | "SLIPPAGE_EXCEEDED"
    | "CONFIG_DRIFT"
    | "INVALID_FINGERPRINT";
  /** Human-readable explanation. */
  message: string;
  /** Specific field discrepancies if drift was detected. */
  driftReasons?: string[];
  /** Expected fingerprint computed from active assumptions. */
  expectedFingerprint: string;
  /** Fingerprint claimed by the quote/caller. */
  actualFingerprint?: string;
  /** Age of the quote in milliseconds at evaluation time. */
  quoteAgeMs: number;
}

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

  // UTF-8 encode
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
      // surrogate pair
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

  // Append 64-bit length big-endian
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

// ── Canonicalization & Fingerprinting ──────────────────────────────────────

/**
 * Normalizes a QuoteAssumptions record into an order-independent canonical representation.
 */
export function canonicalizeQuoteAssumptions(
  assumptions: QuoteAssumptions,
): Record<string, unknown> {
  const normalizedPath = Array.isArray(assumptions.path)
    ? assumptions.path.map((h) => String(h).trim().toLowerCase())
    : [];

  const canonical: Record<string, unknown> = {
    amountInStroops: String(assumptions.amountInStroops ?? "").trim(),
    assetConfigVersion: String(assumptions.assetConfigVersion ?? "").trim(),
    expectedAmountOutStroops: String(assumptions.expectedAmountOutStroops ?? "").trim(),
    expiresAt: String(assumptions.expiresAt ?? "").trim(),
    inputTokenContract: String(assumptions.inputTokenContract ?? "").trim().toLowerCase(),
    minAmountOutStroops: String(assumptions.minAmountOutStroops ?? "").trim(),
    path: normalizedPath,
    protocol: assumptions.protocol ? String(assumptions.protocol).trim().toLowerCase() : "default",
    quotedAt: String(assumptions.quotedAt ?? "").trim(),
    reserveSafe: Boolean(assumptions.reserveSafe),
    routeHash: String(assumptions.routeHash ?? "").trim().toLowerCase(),
    slippageTolerancePct: Number(Number(assumptions.slippageTolerancePct ?? 0).toFixed(4)),
    source: String(assumptions.source ?? "router_simulation").trim().toLowerCase(),
    vaultTokenContract: String(assumptions.vaultTokenContract ?? "").trim().toLowerCase(),
  };

  return canonical;
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

/**
 * Computes a deterministic SHA-256 fingerprint for a set of quote assumptions.
 */
export function computeQuoteAssumptionFingerprint(
  assumptions: QuoteAssumptions,
): QuoteAssumptionFingerprintResult {
  const canonical = canonicalizeQuoteAssumptions(assumptions);
  const canonicalPayload = stableStringify(canonical);
  const fingerprint = sha256Pure(canonicalPayload);
  const shortFingerprint = formatShortFingerprint(fingerprint);

  return {
    fingerprint,
    shortFingerprint,
    canonicalPayload,
    assumptions,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Formats a 64-char hex digest into a readable badge (e.g. "qaf-8f3a1c...4b2d").
 */
export function formatShortFingerprint(fingerprint: string, prefix = "qaf-"): string {
  if (!fingerprint || typeof fingerprint !== "string") {
    return `${prefix}invalid`;
  }
  const clean = fingerprint.replace(/^0x/i, "");
  if (clean.length < 12) {
    return `${prefix}${clean}`;
  }
  return `${prefix}${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

// ── Verification & Drift Detection ─────────────────────────────────────────

export interface VerifyFingerprintOptions {
  /** Optional custom timestamp for deterministic test evaluation. */
  nowMs?: number;
  /** Maximum allowable quote age in milliseconds (default 60,000 ms = 60s). */
  maxAgeMs?: number;
}

/**
 * Verifies that active quote assumptions match a claimed fingerprint and validity window.
 */
export function verifyQuoteAssumptionFingerprint(
  assumptions: QuoteAssumptions,
  claimedFingerprint: string,
  options?: VerifyFingerprintOptions,
): FingerprintVerificationResult {
  const now = options?.nowMs ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? 60_000;

  if (!claimedFingerprint || typeof claimedFingerprint !== "string" || claimedFingerprint.trim() === "") {
    return {
      valid: false,
      status: "invalid",
      code: "INVALID_FINGERPRINT",
      message: "Missing or malformed quote assumption fingerprint.",
      expectedFingerprint: "",
      actualFingerprint: claimedFingerprint,
      quoteAgeMs: 0,
    };
  }

  const computed = computeQuoteAssumptionFingerprint(assumptions);
  const expected = computed.fingerprint.toLowerCase();
  const actual = claimedFingerprint.trim().toLowerCase().replace(/^0x/i, "");

  const quotedTime = new Date(assumptions.quotedAt).getTime();
  const expiresTime = new Date(assumptions.expiresAt).getTime();
  const quoteAgeMs = Number.isFinite(quotedTime) ? Math.max(0, now - quotedTime) : 0;

  // Check 1: Expiration
  const isExpired = (Number.isFinite(expiresTime) && now > expiresTime) || quoteAgeMs > maxAgeMs;
  if (isExpired) {
    return {
      valid: false,
      status: "expired",
      code: "STALE_QUOTE",
      message: "Quote has expired. Assumptions must be refreshed before reviewing or signing.",
      expectedFingerprint: expected,
      actualFingerprint: actual,
      quoteAgeMs,
    };
  }

  // Check 2: Exact fingerprint match
  if (expected !== actual) {
    const driftReasons: string[] = [];
    if (assumptions.slippageTolerancePct > 15) {
      driftReasons.push("Slippage exceeds safe limit of 15%");
    }
    driftReasons.push("Parameters diverge from original quoted assumptions");

    return {
      valid: false,
      status: "drifted",
      code: "ASSUMPTION_DRIFT",
      message: "Quote assumptions have drifted from the initial calculation. Re-quote to proceed.",
      driftReasons,
      expectedFingerprint: expected,
      actualFingerprint: actual,
      quoteAgeMs,
    };
  }

  // Check 3: Applied slippage bounds safety check
  if (assumptions.slippageTolerancePct > 15) {
    return {
      valid: false,
      status: "invalid",
      code: "SLIPPAGE_EXCEEDED",
      message: `Slippage tolerance ${assumptions.slippageTolerancePct}% exceeds maximum allowed threshold of 15%.`,
      expectedFingerprint: expected,
      actualFingerprint: actual,
      quoteAgeMs,
    };
  }

  return {
    valid: true,
    status: "verified",
    code: "FINGERPRINT_VERIFIED",
    message: "Quote assumptions verified and cryptographically bound.",
    expectedFingerprint: expected,
    actualFingerprint: actual,
    quoteAgeMs,
  };
}

/**
 * Detailed diff between two assumption records (e.g., initial quote vs modified review state).
 */
export function detectAssumptionDrift(
  original: QuoteAssumptions,
  current: QuoteAssumptions,
): { hasDrift: boolean; differences: string[] } {
  const diffs: string[] = [];

  if (original.amountInStroops !== current.amountInStroops) {
    diffs.push(`Input amount changed: ${original.amountInStroops} → ${current.amountInStroops}`);
  }
  if (original.minAmountOutStroops !== current.minAmountOutStroops) {
    diffs.push(`Min output guarantee changed: ${original.minAmountOutStroops} → ${current.minAmountOutStroops}`);
  }
  if (original.slippageTolerancePct !== current.slippageTolerancePct) {
    diffs.push(`Slippage tolerance changed: ${original.slippageTolerancePct}% → ${current.slippageTolerancePct}%`);
  }
  if (original.routeHash !== current.routeHash) {
    diffs.push(`Execution route changed: ${original.routeHash} → ${current.routeHash}`);
  }
  if (original.assetConfigVersion !== current.assetConfigVersion) {
    diffs.push(`Asset configuration drifted: ${original.assetConfigVersion} → ${current.assetConfigVersion}`);
  }
  if (original.source !== current.source) {
    diffs.push(`Pricing source model changed: ${original.source} → ${current.source}`);
  }

  return {
    hasDrift: diffs.length > 0,
    differences: diffs,
  };
}
