import { describe, it, expect, vi } from "vitest";
import {
  assertValuationConfigCurrent,
  canonicalizeValuationConfig,
  captureValuationConfig,
  computeValuationConfigFingerprint,
  isValuationConfigError,
  isValuationConfigFingerprint,
  runWithValuationConfig,
  valuationConfigMatches,
  ValuationConfigError,
  type PortfolioValuationConfig,
} from "./portfolioValuationConfig";
import { describeValuationFailure } from "./portfolioValuationErrors";

const BASE: PortfolioValuationConfig = {
  version: 1,
  network: "testnet",
  pricingSource: "reflector",
  concentrationThresholds: {
    asset: { warn: 0.5, critical: 0.85 },
    protocol: { warn: 0.5, critical: 0.85 },
  },
  supportedAssetClasses: ["stablecoin", "crypto"],
};

describe("portfolio valuation config fingerprint (#1862)", () => {
  describe("normal operation", () => {
    it("produces a stable, well-formed fingerprint independent of key order", () => {
      const reordered: PortfolioValuationConfig = {
        supportedAssetClasses: ["stablecoin", "crypto"],
        concentrationThresholds: {
          protocol: { critical: 0.85, warn: 0.5 },
          asset: { critical: 0.85, warn: 0.5 },
        },
        pricingSource: "reflector",
        network: "testnet",
        version: 1,
      };
      const a = computeValuationConfigFingerprint(BASE);
      expect(isValuationConfigFingerprint(a)).toBe(true);
      expect(computeValuationConfigFingerprint(reordered)).toBe(a);
      expect(computeValuationConfigFingerprint(BASE)).toBe(a);
    });

    it("treats undefined members as absent and -0 as 0", () => {
      expect(computeValuationConfigFingerprint({ ...BASE, optional: undefined })).toBe(
        computeValuationConfigFingerprint(BASE),
      );
      expect(canonicalizeValuationConfig({ x: -0 })).toBe(canonicalizeValuationConfig({ x: 0 }));
    });

    it("changes when any value that affects valuation changes", () => {
      const base = computeValuationConfigFingerprint(BASE);
      expect(computeValuationConfigFingerprint({ ...BASE, network: "mainnet" })).not.toBe(base);
      expect(
        computeValuationConfigFingerprint({
          ...BASE,
          concentrationThresholds: {
            asset: { warn: 0.6, critical: 0.85 },
            protocol: { warn: 0.5, critical: 0.85 },
          },
        }),
      ).not.toBe(base);
      expect(
        computeValuationConfigFingerprint({ ...BASE, supportedAssetClasses: ["crypto", "stablecoin"] }),
      ).not.toBe(base);
    });

    it("never embeds raw configuration values in the fingerprint", () => {
      const fp = computeValuationConfigFingerprint({ apiKey: "super-secret-value" });
      expect(fp).not.toContain("super-secret-value");
      expect(fp).toMatch(/^pvcfg1:[0-9a-f]{16}$/);
    });

    it("captures an immutable snapshot that later mutation cannot alter", () => {
      const live = {
        network: "testnet",
        thresholds: { warn: 0.5 },
      };
      const snapshot = captureValuationConfig(live);
      live.network = "mainnet";
      live.thresholds.warn = 0.9;

      expect(snapshot.config).toEqual({ network: "testnet", thresholds: { warn: 0.5 } });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.config)).toBe(true);
      expect(Object.isFrozen(snapshot.config.thresholds)).toBe(true);
      expect(() => {
        (snapshot as { fingerprint: string }).fingerprint = "pvcfg1:0000000000000000";
      }).toThrow(TypeError);
      expect(computeValuationConfigFingerprint(snapshot.config)).toBe(snapshot.fingerprint);
    });

    it("matches across fingerprints, snapshots, and raw configs", () => {
      const snapshot = captureValuationConfig(BASE);
      expect(valuationConfigMatches(snapshot, BASE)).toBe(true);
      expect(valuationConfigMatches(snapshot.fingerprint, snapshot)).toBe(true);
      expect(valuationConfigMatches(snapshot, { ...BASE, network: "mainnet" })).toBe(false);
      expect(() => assertValuationConfigCurrent(snapshot, BASE)).not.toThrow();
    });
  });

  describe("failure", () => {
    it("rejects stale work with a typed, retryable error carrying only fingerprints", () => {
      const snapshot = captureValuationConfig(BASE);
      const next = { ...BASE, pricingSource: "fallback-oracle" };
      let caught: unknown;
      try {
        assertValuationConfigCurrent(snapshot, next);
      } catch (error) {
        caught = error;
      }
      expect(isValuationConfigError(caught)).toBe(true);
      const err = caught as ValuationConfigError;
      expect(err.code).toBe("VALUATION_CONFIG_STALE");
      expect(err.retryable).toBe(true);
      expect(err.expectedFingerprint).toBe(snapshot.fingerprint);
      expect(err.actualFingerprint).toBe(computeValuationConfigFingerprint(next));
      expect(err.message).not.toContain("fallback-oracle");
    });

    it.each([
      ["NaN", { x: Number.NaN }],
      ["Infinity", { x: Number.POSITIVE_INFINITY }],
      ["function", { x: () => 1 }],
      ["class instance", { x: new Date(0) }],
      ["undefined array item", { x: [1, undefined] }],
    ])("refuses to fingerprint a config containing %s", (_label, config) => {
      expect(() =>
        computeValuationConfigFingerprint(config as unknown as PortfolioValuationConfig),
      ).toThrow(ValuationConfigError);
    });

    it("refuses circular configs and malformed fingerprints as non-retryable", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      expect(() =>
        computeValuationConfigFingerprint(circular as PortfolioValuationConfig),
      ).toThrow(/circular/);

      try {
        assertValuationConfigCurrent("not-a-fingerprint", BASE);
        throw new Error("expected throw");
      } catch (error) {
        expect((error as ValuationConfigError).code).toBe("VALUATION_CONFIG_INVALID");
        expect((error as ValuationConfigError).retryable).toBe(false);
      }
    });

    it("rejects (default policy) when the config drifts during work and returns no value", async () => {
      let live: PortfolioValuationConfig = BASE;
      const committed: string[] = ["previous"];
      const run = vi.fn(async () => {
        live = { ...BASE, network: "mainnet" }; // config changes mid-flight
        return "new-valuation";
      });

      await expect(
        runWithValuationConfig({ readConfig: () => live, run }),
      ).rejects.toMatchObject({ code: "VALUATION_CONFIG_STALE", retryable: true });
      expect(run).toHaveBeenCalledTimes(1);
      // Nothing was committed by the caller, so prior state is intact.
      expect(committed).toEqual(["previous"]);
    });

    it("propagates errors from the work itself unchanged", async () => {
      const boom = new Error("oracle timeout");
      await expect(
        runWithValuationConfig({ readConfig: () => BASE, run: () => Promise.reject(boom) }),
      ).rejects.toBe(boom);
    });

    it("gives up under the refresh policy once maxAttempts is exhausted", async () => {
      let n = 0;
      const run = vi.fn(() => {
        n += 1; // config changes on every attempt
        return n;
      });
      await expect(
        runWithValuationConfig({
          readConfig: () => ({ ...BASE, generation: n }),
          run,
          onStale: "refresh",
          maxAttempts: 2,
        }),
      ).rejects.toMatchObject({ code: "VALUATION_CONFIG_STALE" });
      expect(run).toHaveBeenCalledTimes(2);
    });
  });

  describe("safe retry", () => {
    it("refreshes against the new configuration and returns its snapshot", async () => {
      let live: PortfolioValuationConfig = BASE;
      const seen: string[] = [];
      const run = vi.fn(async (snapshot: { fingerprint: string; config: PortfolioValuationConfig }) => {
        seen.push(snapshot.fingerprint);
        if (seen.length === 1) live = { ...BASE, network: "mainnet" };
        return `valued-on-${String(snapshot.config.network)}`;
      });

      const result = await runWithValuationConfig({
        readConfig: () => live,
        run,
        onStale: "refresh",
      });

      expect(result.attempts).toBe(2);
      expect(result.value).toBe("valued-on-mainnet");
      expect(result.snapshot.fingerprint).toBe(computeValuationConfigFingerprint(live));
      expect(seen[0]).not.toBe(seen[1]);
    });

    it("a rejected run can be retried manually and succeeds once config is stable", async () => {
      let live: PortfolioValuationConfig = BASE;
      let drift = true;
      const run = async () => {
        if (drift) live = { ...BASE, network: "mainnet" };
        return 42;
      };
      await expect(runWithValuationConfig({ readConfig: () => live, run })).rejects.toBeInstanceOf(
        ValuationConfigError,
      );

      drift = false;
      const result = await runWithValuationConfig({ readConfig: () => live, run });
      expect(result).toMatchObject({ value: 42, attempts: 1 });
    });

    it("maps stale errors to a retryable user-facing failure without fingerprints", () => {
      const failure = describeValuationFailure(
        new ValuationConfigError("VALUATION_CONFIG_STALE", "stale", {
          expectedFingerprint: "pvcfg1:0000000000000001",
          actualFingerprint: "pvcfg1:0000000000000002",
        }),
      );
      expect(failure.code).toBe("VALUATION_CONFIG_STALE");
      expect(failure.retryable).toBe(true);
      expect(failure.message).not.toContain("pvcfg1");

      const invalid = describeValuationFailure(
        new ValuationConfigError("VALUATION_CONFIG_INVALID", "bad"),
      );
      expect(invalid.code).toBe("VALUATION_REFRESH_FAILED");
      expect(invalid.retryable).toBe(false);
    });
  });
});
