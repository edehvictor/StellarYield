import { validateServerEnv, assertValidServerEnv } from "../config/env";

const VALID_PRODUCTION_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@host:5432/db",
  MONGODB_URI: "mongodb+srv://user:pass@cluster/db",
  METRICS_TOKEN: "a-real-production-token-64chars-long-and-random",
  RELAYER_SECRET_KEY: "SCZANGBA5QLPOBCGZFWV3IUQPVPCX5TQJVKPB6EKBJV3N5LMHBYBP",
  AUDIT_SIGNING_KEY: "a-real-audit-signing-key-that-is-not-a-placeholder",
};

describe("validateServerEnv", () => {
  describe("development mode", () => {
    it("warns for missing local development values without failing startup", () => {
      const result = validateServerEnv({ NODE_ENV: "development" });

      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("DATABASE_URL"),
          expect.stringContaining("MONGODB_URI"),
          expect.stringContaining("RELAYER_SECRET_KEY"),
        ]),
      );
    });

    it("does not require METRICS_TOKEN in development", () => {
      const result = validateServerEnv({ NODE_ENV: "development" });
      const metricsError = result.errors.find((e) => e.includes("METRICS_TOKEN"));
      expect(metricsError).toBeUndefined();
    });

    it("does not require AUDIT_SIGNING_KEY in development", () => {
      const result = validateServerEnv({ NODE_ENV: "development" });
      const auditError = result.errors.find((e) => e.includes("AUDIT_SIGNING_KEY"));
      expect(auditError).toBeUndefined();
    });
  });

  describe("production mode — complete required variables", () => {
    it("passes with all required production variables set correctly", () => {
      const result = validateServerEnv(VALID_PRODUCTION_ENV);
      expect(result.errors).toEqual([]);
    });

    it("requires DATABASE_URL, MONGODB_URI, METRICS_TOKEN, RELAYER_SECRET_KEY in production", () => {
      const result = validateServerEnv({ NODE_ENV: "production" });

      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("DATABASE_URL"),
          expect.stringContaining("MONGODB_URI"),
          expect.stringContaining("METRICS_TOKEN"),
          expect.stringContaining("RELAYER_SECRET_KEY"),
        ]),
      );
    });

    it("requires AUDIT_SIGNING_KEY in production", () => {
      const result = validateServerEnv({ NODE_ENV: "production" });
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("AUDIT_SIGNING_KEY")]));
    });
  });

  describe("production mode — placeholder rejection", () => {
    it("rejects placeholder METRICS_TOKEN in production", () => {
      const result = validateServerEnv({
        ...VALID_PRODUCTION_ENV,
        METRICS_TOKEN: "replace-with-a-real-token",
      });
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("METRICS_TOKEN")]));
    });

    it("rejects 'change-this' METRICS_TOKEN variant in production", () => {
      const result = validateServerEnv({
        ...VALID_PRODUCTION_ENV,
        METRICS_TOKEN: "change-this",
      });
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("METRICS_TOKEN")]));
    });

    it("rejects default AUDIT_SIGNING_KEY placeholder in production", () => {
      const result = validateServerEnv({
        ...VALID_PRODUCTION_ENV,
        AUDIT_SIGNING_KEY: "your-secure-signing-key-change-this-in-production",
      });
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("AUDIT_SIGNING_KEY")]));
    });

    it("rejects 'placeholder' AUDIT_SIGNING_KEY in production", () => {
      const result = validateServerEnv({
        ...VALID_PRODUCTION_ENV,
        AUDIT_SIGNING_KEY: "placeholder",
      });
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("AUDIT_SIGNING_KEY")]));
    });

    it("accepts real METRICS_TOKEN and AUDIT_SIGNING_KEY values in production", () => {
      const result = validateServerEnv(VALID_PRODUCTION_ENV);
      const metricsError = result.errors.find((e) => e.includes("METRICS_TOKEN"));
      const auditError = result.errors.find((e) => e.includes("AUDIT_SIGNING_KEY"));
      expect(metricsError).toBeUndefined();
      expect(auditError).toBeUndefined();
    });
  });

  describe("secret rotation — no unsafe fallback", () => {
    it("passes validation after rotation to a new real METRICS_TOKEN", () => {
      const rotatedEnv = {
        ...VALID_PRODUCTION_ENV,
        METRICS_TOKEN: "new-rotated-token-that-is-long-and-random-abc123",
      };
      const result = validateServerEnv(rotatedEnv);
      expect(result.errors).toEqual([]);
    });

    it("passes validation after rotation to a new real AUDIT_SIGNING_KEY", () => {
      const rotatedEnv = {
        ...VALID_PRODUCTION_ENV,
        AUDIT_SIGNING_KEY: "new-rotated-audit-key-that-is-not-a-placeholder-xyz",
      };
      const result = validateServerEnv(rotatedEnv);
      expect(result.errors).toEqual([]);
    });

    it("fails when METRICS_TOKEN is cleared during rotation (no unsafe empty fallback)", () => {
      const result = validateServerEnv({
        ...VALID_PRODUCTION_ENV,
        METRICS_TOKEN: "",
      });
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("METRICS_TOKEN")]));
    });

    it("fails when AUDIT_SIGNING_KEY is cleared during rotation (no unsafe empty fallback)", () => {
      const result = validateServerEnv({
        ...VALID_PRODUCTION_ENV,
        AUDIT_SIGNING_KEY: "",
      });
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("AUDIT_SIGNING_KEY")]));
    });
  });

  describe("zap configuration", () => {
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

  // ── Placeholder relayer key detection ─────────────────────────────────

  it("warns in development when RELAYER_SECRET_KEY is the placeholder value", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      RELAYER_SECRET_KEY: "SAH2...",
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("RELAYER_SECRET_KEY"),
      ]),
    );
  });

  it("errors in production when RELAYER_SECRET_KEY is the placeholder value", () => {
    const result = validateServerEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://db",
      MONGODB_URI: "mongodb://mongo",
      METRICS_TOKEN: "tok",
      RELAYER_SECRET_KEY: "SAH2...",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("RELAYER_SECRET_KEY"),
      ]),
    );
  });

  it("accepts a non-placeholder RELAYER_SECRET_KEY without error or warning", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      RELAYER_SECRET_KEY: "SREAL_SECRET_KEY_VALUE",
    });

    const relayerMessages = [...result.errors, ...result.warnings].filter((m) =>
      m.includes("RELAYER_SECRET_KEY"),
    );
    expect(relayerMessages).toHaveLength(0);
  });

  // ── Missing database messaging ─────────────────────────────────────────

  it("warning message for missing DATABASE_URL references Prisma and postgres", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });
    const dbWarning = result.warnings.find((w) => w.includes("DATABASE_URL"));
    expect(dbWarning).toBeDefined();
    expect(dbWarning).toMatch(/Prisma/i);
  });

  it("warning message for missing MONGODB_URI references database-backed routes", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });
    const mongoWarning = result.warnings.find((w) => w.includes("MONGODB_URI"));
    expect(mongoWarning).toBeDefined();
    expect(mongoWarning).toMatch(/database/i);
  });

  it("missing DATABASE_URL becomes an error in production", () => {
    const result = validateServerEnv({ NODE_ENV: "production" });
    expect(result.errors.some((e) => e.includes("DATABASE_URL"))).toBe(true);
  });

  it("missing MONGODB_URI becomes an error in production", () => {
    const result = validateServerEnv({ NODE_ENV: "production" });
    expect(result.errors.some((e) => e.includes("MONGODB_URI"))).toBe(true);
  });

  // ── Production-only METRICS_TOKEN ─────────────────────────────────────

  it("does not require METRICS_TOKEN outside of production", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });
    expect(result.errors.some((e) => e.includes("METRICS_TOKEN"))).toBe(false);
  });

  it("requires METRICS_TOKEN in production to protect /api/metrics", () => {
    const result = validateServerEnv({ NODE_ENV: "production" });
    const metricsError = result.errors.find((e) => e.includes("METRICS_TOKEN"));
    expect(metricsError).toBeDefined();
    expect(metricsError).toMatch(/production/i);
  });

  // ── PORT validation ───────────────────────────────────────────────────

  it("errors when PORT is not numeric", () => {
    const result = validateServerEnv({ NODE_ENV: "development", PORT: "abc" });
    expect(result.errors).toContain("PORT must be a number when provided.");
  });

  it("accepts a numeric PORT without errors", () => {
    const result = validateServerEnv({ NODE_ENV: "development", PORT: "3000" });
    expect(result.errors.some((e) => e.includes("PORT"))).toBe(false);
  });

  // ── Supplementary URL warnings ────────────────────────────────────────

  it("warns when SOROBAN_RPC_URL is absent", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });
    expect(result.warnings.some((w) => w.includes("SOROBAN_RPC_URL"))).toBe(true);
  });

  it("warns when STELLAR_HORIZON_URL is absent", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });
    expect(result.warnings.some((w) => w.includes("STELLAR_HORIZON_URL"))).toBe(true);
  });
});

// ── assertValidServerEnv ──────────────────────────────────────────────────

describe("assertValidServerEnv", () => {
  it("throws with all error messages when environment is invalid in production", () => {
    expect(() => assertValidServerEnv({ NODE_ENV: "production" })).toThrow(
      /Invalid server environment/,
    );
  });

  it("returns the validation result when environment is valid for development", () => {
    const result = assertValidServerEnv({ NODE_ENV: "development" });
    expect(result.errors).toHaveLength(0);
  });
});
