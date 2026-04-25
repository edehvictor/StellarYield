import { validateServerEnv } from "../config/env";

describe("validateServerEnv", () => {
  it("warns for missing local development values without failing startup", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("MONGODB_URI"),
        expect.stringContaining("RELAYER_SECRET_KEY"),
      ]),
    );
  });

  it("requires production values that protect routes and jobs", () => {
    const result = validateServerEnv({ NODE_ENV: "production" });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("MONGODB_URI"),
        expect.stringContaining("METRICS_TOKEN"),
        expect.stringContaining("RELAYER_SECRET_KEY"),
      ]),
    );
  });

  it("requires zap router simulation settings to be configured together", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      DEX_ROUTER_CONTRACT_ID: "CROUTER",
    });

    expect(result.errors).toContain(
      "DEX_ROUTER_CONTRACT_ID and ZAP_QUOTE_SIM_SOURCE_ACCOUNT must be configured together.",
    );
  });
});
