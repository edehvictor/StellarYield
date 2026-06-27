/**
 * #726 — Deployment smoke tests for frontend/backend runtime compatibility.
 *
 * Covers:
 *  1. Backend startup probes (health, yields, OpenAPI).
 *  2. Frontend API-URL env-validation logic (ported inline — no Vite dependency).
 *  3. Preview vs production env-shape differences.
 *  4. All client-facing backend routes respond after startup.
 */
import request from "supertest";
import { createApp } from "../app";

const app = createApp();

// ── Inline port of client/src/lib/api.ts getApiBaseUrlState ─────────────────
// Duplicated here to avoid pulling Vite's import.meta.env into Jest.

type ApiBaseUrlState =
  | { available: true; baseUrl: string }
  | { available: false; reason: string };

function trimTrailingSlash(v: string) {
  return v.replace(/\/+$/, "");
}

function getApiBaseUrlState(env: Record<string, string | undefined>): ApiBaseUrlState {
  const configured = env.VITE_API_BASE_URL || env.VITE_API_URL;
  if (configured !== undefined && configured !== null && configured.trim() !== "") {
    const trimmed = configured.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return { available: false, reason: `Invalid API URL: "${trimmed}". Must start with http:// or https://` };
    }
    return { available: true, baseUrl: trimTrailingSlash(trimmed) };
  }
  // In a non-browser context (SSR / CI) fall back to localhost
  return { available: true, baseUrl: "http://localhost:3001" };
}

// ── 1. Backend startup probes ────────────────────────────────────────────────

describe("Backend runtime — startup probes", () => {
  it("GET /api/health returns 200", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });

  it("GET /api/yields returns 200 with array payload", async () => {
    const res = await request(app).get("/api/yields");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/health response includes a status/uptime/ok field", async () => {
    const res = await request(app).get("/api/health");
    const body = res.body as Record<string, unknown>;
    const hasStatusField =
      "status" in body || "uptime" in body || "ok" in body || "healthy" in body;
    expect(hasStatusField).toBe(true);
  });

  it("GET /api/openapi returns 200 (spec reachable)", async () => {
    const res = await request(app).get("/api/openapi");
    expect(res.status).toBe(200);
  });
});

// ── 2. Frontend env-URL validation ──────────────────────────────────────────

describe("Frontend API-URL env validation", () => {
  it("accepts a valid https URL", () => {
    const state = getApiBaseUrlState({ VITE_API_BASE_URL: "https://api.stellaryield.example" });
    expect(state.available).toBe(true);
    if (state.available) expect(state.baseUrl).toBe("https://api.stellaryield.example");
  });

  it("accepts a valid http URL (dev)", () => {
    const state = getApiBaseUrlState({ VITE_API_BASE_URL: "http://localhost:3001" });
    expect(state.available).toBe(true);
  });

  it("trims trailing slash from configured URL", () => {
    const state = getApiBaseUrlState({ VITE_API_BASE_URL: "https://api.example.com/" });
    expect(state.available).toBe(true);
    if (state.available) expect(state.baseUrl).toBe("https://api.example.com");
  });

  it("rejects a URL missing the http(s) scheme", () => {
    const state = getApiBaseUrlState({ VITE_API_BASE_URL: "api.example.com" });
    expect(state.available).toBe(false);
    if (!state.available) expect(state.reason).toMatch(/Must start with http/);
  });

  it("accepts VITE_API_URL as fallback when VITE_API_BASE_URL is absent", () => {
    const state = getApiBaseUrlState({ VITE_API_URL: "https://fallback.example.com" });
    expect(state.available).toBe(true);
    if (state.available) expect(state.baseUrl).toBe("https://fallback.example.com");
  });

  it("whitespace-only VITE_API_BASE_URL is treated as missing", () => {
    const state = getApiBaseUrlState({ VITE_API_BASE_URL: "   " });
    // Falls back to localhost in SSR/CI context
    expect(state.available).toBe(true);
    if (state.available) expect(state.baseUrl).toMatch(/localhost/);
  });

  it("empty env falls back to localhost (SSR/CI context)", () => {
    const state = getApiBaseUrlState({});
    expect(state.available).toBe(true);
    if (state.available) expect(state.baseUrl).toMatch(/localhost/);
  });
});

// ── 3. Preview vs production env shapes ─────────────────────────────────────

describe("Preview vs production env compatibility", () => {
  it("preview env with VITE_API_BASE_URL is valid", () => {
    const state = getApiBaseUrlState({
      VITE_API_BASE_URL: "https://preview-api.stellaryield.example",
    });
    expect(state.available).toBe(true);
  });

  it("production env missing both URL vars falls back gracefully without throwing", () => {
    expect(() => getApiBaseUrlState({})).not.toThrow();
  });

  it("getApiBaseUrlState never returns an empty baseUrl when available=true", () => {
    const cases = [
      { VITE_API_BASE_URL: "https://prod.example.com" },
      { VITE_API_URL: "https://staging.example.com" },
      {},
    ];
    for (const env of cases) {
      const state = getApiBaseUrlState(env);
      if (state.available) {
        expect(state.baseUrl.trim()).not.toBe("");
      }
    }
  });
});

// ── 4. Runtime wiring — all client-facing routes respond ────────────────────

describe("Backend runtime wiring — client-facing routes must not 404", () => {
  const routes: Array<["get" | "post", string]> = [
    ["get", "/api/yields"],
    ["get", "/api/health"],
    ["get", "/api/leaderboard"],
    ["get", "/api/notifications"],
    ["get", "/api/rebalances"],
    ["get", "/api/reliability"],
    ["get", "/api/relayer/status"],
    ["get", "/api/correlation"],
    ["get", "/api/strategies/rotation"],
    ["get", "/api/transparency"],
    ["get", "/api/incidents"],
    ["get", "/api/governance/forecast"],
    ["get", "/api/analytics/providers/uptime"],
    ["get", "/api/analytics/sources/health"],
    ["get", "/api/vaults/test-vault/share-price-history"],
    ["post", "/relay/sign-fee-bump"],
    ["post", "/api/auth/challenge"],
    ["post", "/api/stress-scenarios/run"],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} does not return 404`, async () => {
      const res =
        method === "get"
          ? await request(app).get(path)
          : await request(app).post(path).send({});
      expect(res.status).not.toBe(404);
    });
  }
});
