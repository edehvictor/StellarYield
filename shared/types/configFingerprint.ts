/**
 * Immutable configuration fingerprints for status surfaces (#1910).
 *
 * A status snapshot is only meaningful for the configuration it was produced
 * under. If the configuration changes while a snapshot is cached, serving the
 * old snapshot silently mixes data from two different configurations. Callers
 * stamp a fingerprint onto their snapshot and compare it with the active
 * configuration before reusing cached work.
 *
 * The fingerprint is a deterministic change detector, not a secret or a
 * cryptographic commitment: it is built from a canonical serialization of the
 * configuration and a non-cryptographic hash. It never contains raw values, so
 * it is safe to return in an API response.
 */

/** Prefix identifying the fingerprint algorithm and version. */
export const CONFIG_FINGERPRINT_PREFIX = "cfg1";

/**
 * Canonicalize a JSON-like value so that two structurally equal
 * configurations always serialize identically, regardless of key order.
 *
 * Unsupported values (functions, symbols, `undefined`) are rejected rather
 * than silently dropped, because a dropped value would make two genuinely
 * different configurations fingerprint the same.
 */
export function canonicalizeConfig(value: unknown): string {
  const seen = new Set<object>();

  const walk = (input: unknown, path: string): string => {
    if (input === null) return "null";

    switch (typeof input) {
      case "string":
        return JSON.stringify(input);
      case "number":
        if (!Number.isFinite(input)) {
          throw new TypeError(`Config fingerprint: non-finite number at ${path}`);
        }
        return JSON.stringify(input);
      case "boolean":
        return input ? "true" : "false";
      case "object": {
        const object = input as Record<string, unknown>;
        if (seen.has(object)) {
          throw new TypeError(`Config fingerprint: circular reference at ${path}`);
        }
        seen.add(object);
        try {
          if (Array.isArray(object)) {
            return `[${object
              .map((entry, index) => walk(entry, `${path}[${index}]`))
              .join(",")}]`;
          }
          const keys = Object.keys(object).sort();
          return `{${keys
            .map((key) => `${JSON.stringify(key)}:${walk(object[key], `${path}.${key}`)}`)
            .join(",")}}`;
        } finally {
          seen.delete(object);
        }
      }
      default:
        throw new TypeError(
          `Config fingerprint: unsupported ${typeof input} at ${path}`,
        );
    }
  };

  return walk(value, "$");
}

/**
 * FNV-1a over UTF-16 code units, with two independent lanes so the result has
 * 64 bits of spread. Deterministic across runtimes (no BigInt requirement).
 */
function fnv1aLane(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Compute a stable fingerprint for a configuration value.
 *
 * @example
 * computeConfigFingerprint({ b: 1, a: 2 }) === computeConfigFingerprint({ a: 2, b: 1 })
 */
export function computeConfigFingerprint(value: unknown): string {
  const canonical = canonicalizeConfig(value);
  const length = canonical.length.toString(16);
  return `${CONFIG_FINGERPRINT_PREFIX}:${fnv1aLane(
    canonical,
    0x811c9dc5,
  )}${fnv1aLane(`${length}\u0000${canonical}`, 0x9e3779b9)}`;
}

/** True when a value looks like a fingerprint produced by this module. */
export function isConfigFingerprint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${CONFIG_FINGERPRINT_PREFIX}:[0-9a-f]{16}$`).test(value)
  );
}

/**
 * Compare two optional fingerprints.
 *
 * Missing fingerprints are treated as "unknown", not as a mismatch: older
 * callers that do not send one must keep working. Two present fingerprints
 * must match exactly.
 */
export function configFingerprintsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return true;
  return a === b;
}

/**
 * Recursively freeze a configuration snapshot so it cannot be mutated after it
 * is fingerprinted. Freezing is what makes the fingerprint trustworthy for the
 * lifetime of the snapshot.
 */
export function deepFreezeConfig<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value as Readonly<T>;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreezeConfig((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
