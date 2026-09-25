/**
 * #1337 — Backend smoke test for production API base configuration.
 *
 * Exercises `validateServerEnv` (server/src/config/env.ts) against
 * production-shaped env objects to ensure:
 *  1. A fully-configured production env reports no errors.
 *  2. Missing required production vars each produce a named error.
 *  3. Placeholder values are rejected in production.
 *  4. Non-production envs produce warnings (not errors) for optional vars.
 *  5. Structural constraints (paired DEX/ZAP keys, numeric PORT) are enforced
 *     regardless of NODE_ENV.
 *
 * These tests run against the pure validation logic — no HTTP server, no DB.
 * They cover the "normal path" (valid full production config) and the two
 * most important failure paths (missing required secrets, stale placeholders).
 */
import { validateServerEnv } from "../config/env";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal env that passes all production validation rules. */
function validProductionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PORT: "3001",
    DATABASE_URL: "postgresql://user:pass@db.prod.example.com:5432/stellaryield",
    MONGODB_URI: "mongodb+srv://user:pass@cluster.prod.example.com/stellaryield",
    METRICS_TOKEN: "sm_prod_real_token_abc123",
    RELAYER_SECRET_KEY: "SCZANGBA5TNMJURPIY6ZPBETP4VXMM2FXBKEWXP5GFBH57TNKVMJ777",
    AUDIT_SIGNING_KEY: "prod-audit-key-32-chars-at-least!",
    SOROBAN_RPC_URL: "https://soroban-rpc.prod.example.com",
    STELLAR_HORIZON_URL: "https://horizon.prod.example.com",
    ...overrides,
  };
}

// ── 1. Valid production configuration ────────────────────────────────────────

describe("validateServerEnv — valid production configuration (#1337)", () => {
  it("reports no errors for a complete, well-formed production env", () => {
    const result = validateServerEnv(validProductionEnv());
    expect(result.errors).toHaveLength(0);
  });

  it("reports no errors even when optional URL vars are present", () => {
    const result = validateServerEnv(
      validProductionEnv({
        DEX_ROUTER_CONTRACT_ID: "CDEX123",
        ZAP_QUOTE_SIM_SOURCE_ACCOUNT: "GABC456",
      }),
    );
    expect(result.errors).toHaveLength(0);
  });

  it("returns an object with errors and warnings arrays", () => {
    const result = validateServerEnv(validProductionEnv());
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ── 2. Missing required production secrets ───────────────────────────────────

describe("validateServerEnv — missing required production secrets (#1337)", () => {
  it("errors when METRICS_TOKEN is absent in production", () => {
    const result = validateServerEnv(validProductionEnv({ METRICS_TOKEN: undefined }));
    expect(result.errors.some((e) => e.includes("METRICS_TOKEN"))).toBe(true);
  });

  it("errors when AUDIT_SIGNING_KEY is absent in production", () => {
    const result = validateServerEnv(validProductionEnv({ AUDIT_SIGNING_KEY: undefined }));
    expect(result.errors.some((e) => e.includes("AUDIT_SIGNING_KEY"))).toBe(true);
  });

  it("errors when DATABASE_URL is absent in production", () => {
    const result = validateServerEnv(validProductionEnv({ DATABASE_URL: undefined }));
    expect(result.errors.some((e) => e.includes("DATABASE_URL"))).toBe(true);
  });

  it("errors when MONGODB_URI is absent in production", () => {
    const result = validateServerEnv(validProductionEnv({ MONGODB_URI: undefined }));
    expect(result.errors.some((e) => e.includes("MONGODB_URI"))).toBe(true);
  });
});

// ── 3. Placeholder values rejected in production ─────────────────────────────

describe("validateServerEnv — placeholder values rejected in production (#1337)", () => {
  it("errors when METRICS_TOKEN is a placeholder string", () => {
    const result = validateServerEnv(validProductionEnv({ METRICS_TOKEN: "change-this" }));
    expect(result.errors.some((e) => e.includes("METRICS_TOKEN"))).toBe(true);
  });

  it("errors when AUDIT_SIGNING_KEY is a well-known placeholder", () => {
    const result = validateServerEnv(
      validProductionEnv({ AUDIT_SIGNING_KEY: "your-secure-signing-key-change-this-in-production" }),
    );
    expect(result.errors.some((e) => e.includes("AUDIT_SIGNING_KEY"))).toBe(true);
  });

  it("errors when RELAYER_SECRET_KEY is the documented placeholder value", () => {
    const result = validateServerEnv(validProductionEnv({ RELAYER_SECRET_KEY: "SAH2..." }));
    expect(result.errors.length + result.warnings.length).toBeGreaterThan(0);
    const combined = [...result.errors, ...result.warnings].join(" ");
    expect(combined).toMatch(/RELAYER_SECRET_KEY/);
  });
});

// ── 4. Non-production degrades to warnings, not errors ───────────────────────

describe("validateServerEnv — development env degrades to warnings (#1337)", () => {
  it("missing DATABASE_URL is a warning (not error) outside production", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });
    const hasError = result.errors.some((e) => e.includes("DATABASE_URL"));
    const hasWarning = result.warnings.some((w) => w.includes("DATABASE_URL"));
    expect(hasError).toBe(false);
    expect(hasWarning).toBe(true);
  });

  it("missing MONGODB_URI is a warning (not error) outside production", () => {
    const result = validateServerEnv({ NODE_ENV: "test" });
    expect(result.errors.some((e) => e.includes("MONGODB_URI"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("MONGODB_URI"))).toBe(true);
  });

  it("METRICS_TOKEN is not required outside production", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });
    expect(result.errors.some((e) => e.includes("METRICS_TOKEN"))).toBe(false);
  });
});

// ── 5. Structural constraints enforced regardless of NODE_ENV ────────────────

describe("validateServerEnv — structural constraints (#1337)", () => {
  it("errors when PORT is a non-numeric string", () => {
    const result = validateServerEnv({ PORT: "not-a-port" });
    expect(result.errors.some((e) => e.includes("PORT"))).toBe(true);
  });

  it("accepts PORT as a numeric string", () => {
    const result = validateServerEnv(validProductionEnv({ PORT: "8080" }));
    expect(result.errors.some((e) => e.includes("PORT"))).toBe(false);
  });

  it("errors when DEX_ROUTER_CONTRACT_ID is set without ZAP_QUOTE_SIM_SOURCE_ACCOUNT", () => {
    const result = validateServerEnv(
      validProductionEnv({
        DEX_ROUTER_CONTRACT_ID: "CDEX123",
        ZAP_QUOTE_SIM_SOURCE_ACCOUNT: undefined,
      }),
    );
    expect(
      result.errors.some(
        (e) => e.includes("DEX_ROUTER_CONTRACT_ID") || e.includes("ZAP_QUOTE_SIM_SOURCE_ACCOUNT"),
      ),
    ).toBe(true);
  });

  it("errors when ZAP_QUOTE_SIM_SOURCE_ACCOUNT is set without DEX_ROUTER_CONTRACT_ID", () => {
    const result = validateServerEnv(
      validProductionEnv({
        DEX_ROUTER_CONTRACT_ID: undefined,
        ZAP_QUOTE_SIM_SOURCE_ACCOUNT: "GABC456",
      }),
    );
    expect(
      result.errors.some(
        (e) => e.includes("DEX_ROUTER_CONTRACT_ID") || e.includes("ZAP_QUOTE_SIM_SOURCE_ACCOUNT"),
      ),
    ).toBe(true);
  });

  it("neither DEX key alone is a valid half-config — both or neither", () => {
    const neitherResult = validateServerEnv(
      validProductionEnv({
        DEX_ROUTER_CONTRACT_ID: undefined,
        ZAP_QUOTE_SIM_SOURCE_ACCOUNT: undefined,
      }),
    );
    expect(
      neitherResult.errors.some(
        (e) => e.includes("DEX_ROUTER_CONTRACT_ID") || e.includes("ZAP_QUOTE_SIM_SOURCE_ACCOUNT"),
      ),
    ).toBe(false);
  });
});

// ── 6. Optional Stellar endpoint warnings ────────────────────────────────────

describe("validateServerEnv — optional Stellar endpoint warnings (#1337)", () => {
  it("warns when SOROBAN_RPC_URL is absent", () => {
    const result = validateServerEnv(validProductionEnv({ SOROBAN_RPC_URL: undefined }));
    expect(result.warnings.some((w) => w.includes("SOROBAN_RPC_URL"))).toBe(true);
  });

  it("warns when STELLAR_HORIZON_URL is absent", () => {
    const result = validateServerEnv(validProductionEnv({ STELLAR_HORIZON_URL: undefined }));
    expect(result.warnings.some((w) => w.includes("STELLAR_HORIZON_URL"))).toBe(true);
  });

  it("no warning when both Stellar URLs are provided", () => {
    const result = validateServerEnv(validProductionEnv());
    expect(result.warnings.some((w) => w.includes("SOROBAN_RPC_URL"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("STELLAR_HORIZON_URL"))).toBe(false);
  });
});
