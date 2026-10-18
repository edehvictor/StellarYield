/**
 * #1402 — Backend safety check for missing VITE API configuration.
 *
 * VITE_API_BASE_URL / VITE_API_URL are frontend build-time variables that
 * tell the client where to find the backend API. When both are absent the
 * frontend silently falls back to http://localhost:3001, which breaks every
 * API call in a deployed environment. These tests verify that
 * `validateServerEnv` surfaces that misconfiguration as a warning before
 * it reaches production.
 *
 * Three groups:
 *  1. Missing both vars → warning produced (any NODE_ENV)
 *  2. Valid URL supplied → no VITE warning
 *  3. Non-https URL in production → warning about insecure scheme
 */
import { validateServerEnv } from "../config/env";

// Minimal env that satisfies all other validators — isolates VITE checks.
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://user:pass@db:5432/sy",
    MONGODB_URI: "mongodb+srv://user:pass@cluster/sy",
    METRICS_TOKEN: "sm_real_token_abc",
    RELAYER_SECRET_KEY: "SCZANGBA5TNMJURPIY6ZPBETP4VXMM2FXBKEWXP5GFBH57TNKVMJ777",
    AUDIT_SIGNING_KEY: "prod-audit-key-long-enough-here!",
    SOROBAN_RPC_URL: "https://soroban-rpc.example.com",
    STELLAR_HORIZON_URL: "https://horizon.example.com",
    ...overrides,
  };
}

// ── 1. Missing both VITE vars ────────────────────────────────────────────────

describe("validateServerEnv — missing VITE API URL (#1402)", () => {
  it("warns when neither VITE_API_BASE_URL nor VITE_API_URL is set in production", () => {
    const result = validateServerEnv(
      baseEnv({ VITE_API_BASE_URL: undefined, VITE_API_URL: undefined }),
    );
    expect(result.warnings.some((w) => w.includes("VITE_API_BASE_URL"))).toBe(true);
  });

  it("warns when neither VITE var is set in development too (localhost fallback is wrong everywhere deployed)", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      VITE_API_BASE_URL: undefined,
      VITE_API_URL: undefined,
    });
    expect(result.warnings.some((w) => w.includes("VITE_API_BASE_URL"))).toBe(true);
  });

  it("warning message mentions the localhost fallback so the cause is clear", () => {
    const result = validateServerEnv(
      baseEnv({ VITE_API_BASE_URL: undefined, VITE_API_URL: undefined }),
    );
    const warning = result.warnings.find((w) => w.includes("localhost"));
    expect(warning).toBeDefined();
  });

  it("does not produce an error (only a warning) — a missing VITE var does not block startup", () => {
    const result = validateServerEnv(
      baseEnv({ VITE_API_BASE_URL: undefined, VITE_API_URL: undefined }),
    );
    expect(result.errors.some((e) => e.includes("VITE"))).toBe(false);
  });
});

// ── 2. Valid VITE URL supplied ───────────────────────────────────────────────

describe("validateServerEnv — valid VITE API URL suppresses warning (#1402)", () => {
  it("no VITE warning when VITE_API_BASE_URL is a valid https URL", () => {
    const result = validateServerEnv(
      baseEnv({ VITE_API_BASE_URL: "https://api.stellaryield.example" }),
    );
    expect(result.warnings.some((w) => w.includes("VITE_API_BASE_URL") && w.includes("localhost"))).toBe(false);
  });

  it("no VITE warning when only VITE_API_URL is set (fallback var)", () => {
    const result = validateServerEnv(
      baseEnv({ VITE_API_BASE_URL: undefined, VITE_API_URL: "https://api.stellaryield.example" }),
    );
    expect(result.warnings.some((w) => w.includes("localhost"))).toBe(false);
  });

  it("VITE_API_BASE_URL takes precedence over VITE_API_URL when both are set", () => {
    const result = validateServerEnv(
      baseEnv({
        VITE_API_BASE_URL: "https://primary.example.com",
        VITE_API_URL: "https://fallback.example.com",
      }),
    );
    expect(result.warnings.some((w) => w.includes("localhost"))).toBe(false);
  });
});

// ── 3. Non-https in production ───────────────────────────────────────────────

describe("validateServerEnv — non-https VITE URL in production (#1402)", () => {
  it("warns when VITE_API_BASE_URL uses http:// in production", () => {
    const result = validateServerEnv(
      baseEnv({ VITE_API_BASE_URL: "http://api.stellaryield.example" }),
    );
    expect(result.warnings.some((w) => w.includes("https://"))).toBe(true);
  });

  it("does not warn about scheme when using http:// outside production", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      VITE_API_BASE_URL: "http://localhost:3001",
    });
    expect(result.warnings.some((w) => w.includes("should use https://"))).toBe(false);
  });

  it("https URL in production produces no scheme warning", () => {
    const result = validateServerEnv(
      baseEnv({ VITE_API_BASE_URL: "https://api.stellaryield.example" }),
    );
    expect(result.warnings.some((w) => w.includes("should use https://"))).toBe(false);
  });
});
