import { describe, it, expect } from "vitest";
import {
  CONFIG_FINGERPRINT_PREFIX,
  canonicalizeConfig,
  computeConfigFingerprint,
  configFingerprintsMatch,
  deepFreezeConfig,
  isConfigFingerprint,
} from "./configFingerprint";

describe("canonicalizeConfig", () => {
  it("is independent of object key order", () => {
    expect(canonicalizeConfig({ b: 1, a: 2 })).toBe(
      canonicalizeConfig({ a: 2, b: 1 }),
    );
  });

  it("preserves array order", () => {
    expect(canonicalizeConfig([1, 2])).not.toBe(canonicalizeConfig([2, 1]));
  });

  it("rejects unsupported and non-finite values instead of dropping them", () => {
    expect(() => canonicalizeConfig({ fn: () => 1 })).toThrow(TypeError);
    expect(() => canonicalizeConfig({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalizeConfig({ value: undefined })).toThrow(TypeError);
  });

  it("rejects circular references", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalizeConfig(circular)).toThrow(/circular/i);
  });
});

describe("computeConfigFingerprint", () => {
  it("is stable for the same configuration", () => {
    const config = { version: "v1", cacheTtlMs: 60_000, historyDays: 30 };
    expect(computeConfigFingerprint(config)).toBe(computeConfigFingerprint(config));
  });

  it("changes when any value changes", () => {
    const base = computeConfigFingerprint({ version: "v1", cacheTtlMs: 60_000 });
    const next = computeConfigFingerprint({ version: "v1", cacheTtlMs: 30_000 });
    expect(next).not.toBe(base);
  });

  it("changes when a nested value changes", () => {
    const base = computeConfigFingerprint({ registry: { vault: "A" } });
    const next = computeConfigFingerprint({ registry: { vault: "B" } });
    expect(next).not.toBe(base);
  });

  it("does not embed the raw configuration values", () => {
    const fingerprint = computeConfigFingerprint({
      horizonUrl: "https://horizon.internal.example.com",
      wallet: "GDXCN5BQ4RJXFTDMCTP3H7J6P5PT7PNZ4VP5G7F5VZ6B7K4Q7ZQ7ZQ7Z",
    });
    expect(fingerprint).not.toContain("horizon");
    expect(fingerprint).not.toContain("GDXCN5");
    expect(isConfigFingerprint(fingerprint)).toBe(true);
  });

  it("uses the versioned prefix and a fixed-width hex digest", () => {
    const fingerprint = computeConfigFingerprint({ a: 1 });
    expect(fingerprint.startsWith(`${CONFIG_FINGERPRINT_PREFIX}:`)).toBe(true);
    expect(fingerprint.split(":")[1]).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("configFingerprintsMatch", () => {
  it("matches equal fingerprints", () => {
    const fingerprint = computeConfigFingerprint({ a: 1 });
    expect(configFingerprintsMatch(fingerprint, fingerprint)).toBe(true);
  });

  it("does not match different fingerprints", () => {
    expect(
      configFingerprintsMatch(
        computeConfigFingerprint({ a: 1 }),
        computeConfigFingerprint({ a: 2 }),
      ),
    ).toBe(false);
  });

  it("treats a missing fingerprint as unknown rather than a mismatch", () => {
    expect(configFingerprintsMatch(undefined, computeConfigFingerprint({ a: 1 }))).toBe(true);
    expect(configFingerprintsMatch(null, null)).toBe(true);
  });
});

describe("deepFreezeConfig", () => {
  it("freezes the snapshot and every nested object", () => {
    const config = deepFreezeConfig({ registry: { vault: "A" }, cacheTtlMs: 1 });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.registry)).toBe(true);
  });

  it("prevents mutation of a fingerprinted snapshot", () => {
    const config = deepFreezeConfig({ cacheTtlMs: 60_000 });
    expect(() => {
      (config as { cacheTtlMs: number }).cacheTtlMs = 1;
    }).toThrow(TypeError);
    expect(config.cacheTtlMs).toBe(60_000);
  });
});
