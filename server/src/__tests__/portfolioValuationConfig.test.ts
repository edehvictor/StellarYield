import {
  PortfolioService,
  type VaultPosition,
} from "../services/portfolioService";
import {
  captureValuationConfig,
  computeValuationConfigFingerprint,
  runWithValuationConfig,
  ValuationConfigError,
} from "../../../shared/types/portfolioValuationConfig";

const ENV_A: NodeJS.ProcessEnv = {};
const ENV_B: NodeJS.ProcessEnv = { CONCENTRATION_ASSET_WARN_SHARE: "0.6" };

function positions(): VaultPosition[] {
  return [
    { protocol: "Blend", asset: "USDC", depositedUsd: 1000, currentValueUsd: 1100 },
    { protocol: "DeFindex", asset: "ORACLE_LESS", depositedUsd: 500, currentValueUsd: null },
  ];
}

describe("PortfolioService valuation config fingerprint (#1862)", () => {
  describe("normal operation", () => {
    it("tags the summary with the fingerprint of the config it was computed under", () => {
      const config = PortfolioService.getValuationConfig(ENV_A);
      const summary = PortfolioService.computeValuationSummary(positions(), { config });

      expect(summary.configFingerprint).toMatch(/^pvcfg1:[0-9a-f]{16}$/);
      expect(summary.configFingerprint).toBe(computeValuationConfigFingerprint(config));
      expect(summary.completeness).toBe("partial");
      expect(summary.pricedValueUsd).toBe(1100);
      expect(summary.unpricedAssets).toEqual(["ORACLE_LESS"]);
    });

    it("is deterministic and changes when deployment thresholds change", () => {
      const a1 = PortfolioService.getValuationConfigFingerprint(ENV_A);
      const a2 = PortfolioService.getValuationConfigFingerprint({ ...ENV_A });
      const b = PortfolioService.getValuationConfigFingerprint(ENV_B);
      expect(a1).toBe(a2);
      expect(b).not.toBe(a1);
    });

    it("reports whether a cached summary is still current", () => {
      const summary = PortfolioService.computeValuationSummary(positions(), {
        config: PortfolioService.getValuationConfig(ENV_A),
      });
      expect(PortfolioService.isValuationSummaryCurrent(summary, ENV_A)).toBe(true);
      expect(PortfolioService.isValuationSummaryCurrent(summary, ENV_B)).toBe(false);
    });

    it("accepts a captured snapshot and re-derives its fingerprint", () => {
      const snapshot = captureValuationConfig(PortfolioService.getValuationConfig(ENV_A));
      const summary = PortfolioService.computeValuationSummary(positions(), {
        config: snapshot,
        expectedConfigFingerprint: snapshot.fingerprint,
      });
      expect(summary.configFingerprint).toBe(snapshot.fingerprint);

      // A hand-built snapshot cannot vouch for a different config.
      const forged = {
        config: PortfolioService.getValuationConfig(ENV_B),
        fingerprint: snapshot.fingerprint,
      };
      expect(() =>
        PortfolioService.computeValuationSummary(positions(), {
          config: forged,
          expectedConfigFingerprint: snapshot.fingerprint,
        }),
      ).toThrow(ValuationConfigError);
    });
  });

  describe("failure", () => {
    it("rejects work bound to a stale fingerprint without mutating inputs", () => {
      const staleFingerprint = PortfolioService.getValuationConfigFingerprint(ENV_A);
      const input = positions();
      const before = JSON.parse(JSON.stringify(input));

      let caught: unknown;
      try {
        PortfolioService.computeValuationSummary(input, {
          config: PortfolioService.getValuationConfig(ENV_B),
          expectedConfigFingerprint: staleFingerprint,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ValuationConfigError);
      expect(caught).toMatchObject({
        code: "VALUATION_CONFIG_STALE",
        retryable: true,
        expectedFingerprint: staleFingerprint,
        actualFingerprint: PortfolioService.getValuationConfigFingerprint(ENV_B),
      });
      expect(input).toEqual(before);
    });

    it("rejects a malformed expected fingerprint as non-retryable", () => {
      expect(() =>
        PortfolioService.computeValuationSummary(positions(), {
          config: PortfolioService.getValuationConfig(ENV_A),
          expectedConfigFingerprint: "garbage",
        }),
      ).toThrow(expect.objectContaining({ code: "VALUATION_CONFIG_INVALID", retryable: false }));
    });

    it("keeps the previously committed summary when the config drifts mid-run", async () => {
      let env: NodeJS.ProcessEnv = ENV_A;
      let committed = PortfolioService.computeValuationSummary(positions(), {
        config: PortfolioService.getValuationConfig(env),
      });
      const previous = committed;

      await expect(
        runWithValuationConfig({
          readConfig: () => PortfolioService.getValuationConfig(env),
          run: (snapshot) => {
            env = ENV_B; // operator changes thresholds while pricing is in flight
            return PortfolioService.computeValuationSummary(
              [{ protocol: "Blend", asset: "USDC", depositedUsd: 1000, currentValueUsd: 9999 }],
              { config: snapshot },
            );
          },
        }).then((result) => {
          committed = result.value;
        }),
      ).rejects.toMatchObject({ code: "VALUATION_CONFIG_STALE" });

      expect(committed).toBe(previous);
      expect(committed.pricedValueUsd).toBe(1100);
    });
  });

  describe("safe retry", () => {
    it("refreshes against the new config and commits a summary bound to it", async () => {
      let env: NodeJS.ProcessEnv = ENV_A;
      let calls = 0;

      const result = await runWithValuationConfig({
        readConfig: () => PortfolioService.getValuationConfig(env),
        run: (snapshot) => {
          calls += 1;
          if (calls === 1) env = ENV_B;
          return PortfolioService.computeValuationSummary(positions(), { config: snapshot });
        },
        onStale: "refresh",
      });

      expect(calls).toBe(2);
      expect(result.attempts).toBe(2);
      expect(result.value.configFingerprint).toBe(
        PortfolioService.getValuationConfigFingerprint(ENV_B),
      );
      expect(PortfolioService.isValuationSummaryCurrent(result.value, env)).toBe(true);
    });

    it("succeeds on retry with the fresh fingerprint after a stale rejection", () => {
      const stale = PortfolioService.getValuationConfigFingerprint(ENV_A);
      const config = PortfolioService.getValuationConfig(ENV_B);

      expect(() =>
        PortfolioService.computeValuationSummary(positions(), {
          config,
          expectedConfigFingerprint: stale,
        }),
      ).toThrow(ValuationConfigError);

      const fresh = computeValuationConfigFingerprint(config);
      const summary = PortfolioService.computeValuationSummary(positions(), {
        config,
        expectedConfigFingerprint: fresh,
      });
      expect(summary.configFingerprint).toBe(fresh);
      expect(summary.totalDepositedUsd).toBe(1500);
    });
  });
});
