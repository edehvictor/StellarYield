import { validateServerEnv } from "../config/env";

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
});
