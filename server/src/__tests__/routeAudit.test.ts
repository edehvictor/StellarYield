/**
 * #723 — Route audit: every frontend API path must resolve to a mounted Express route.
 * Tests that previously-drifted routes (rebalances, vaults/share-price-history,
 * reliability, relayer/status, risk) now return non-404 responses.
 */
import request from "supertest";
import { createApp } from "../app";

const app = createApp();

/**
 * Minimal probe: a mounted router must not return 404.
 * 200/400/500 all prove the route exists; 404 means it was never registered.
 */
async function probeRouteExists(method: "get" | "post", path: string) {
  const res =
    method === "get"
      ? await request(app).get(path)
      : await request(app).post(path).send({});
  expect(res.status).not.toBe(404);
}

describe("Route audit — mounted routes match client API calls (#723)", () => {
  // ── Previously missing routes ────────────────────────────────────────
  it("GET /api/rebalances is mounted", () =>
    probeRouteExists("get", "/api/rebalances"));

  it("GET /api/vaults/:vaultId/share-price-history is mounted", () =>
    probeRouteExists("get", "/api/vaults/test-vault/share-price-history"));

  it("GET /api/reliability is mounted", () =>
    probeRouteExists("get", "/api/reliability"));

  it("GET /api/relayer/status is mounted", () =>
    probeRouteExists("get", "/api/relayer/status"));

  it("POST /api/risk/drift/detect is mounted", () =>
    probeRouteExists("post", "/api/risk/drift/detect"));

  it("POST /api/risk/dispersion/compute is mounted", () =>
    probeRouteExists("post", "/api/risk/dispersion/compute"));

  // ── Stable routes — regression guard ────────────────────────────────
  it("GET /api/yields is mounted", () =>
    probeRouteExists("get", "/api/yields"));

  it("GET /api/health is mounted", () =>
    probeRouteExists("get", "/api/health"));

  it("GET /api/notifications is mounted", () =>
    probeRouteExists("get", "/api/notifications"));

  it("GET /api/leaderboard is mounted", () =>
    probeRouteExists("get", "/api/leaderboard"));

  it("POST /api/auth/challenge is mounted", () =>
    probeRouteExists("post", "/api/auth/challenge"));

  it("POST /api/auth/verify is mounted", () =>
    probeRouteExists("post", "/api/auth/verify"));

  it("GET /api/strategies/rotation is mounted", () =>
    probeRouteExists("get", "/api/strategies/rotation?limit=10"));

  it("GET /api/governance/forecast is mounted", () =>
    probeRouteExists("get", "/api/governance/forecast"));

  it("GET /api/transparency is mounted", () =>
    probeRouteExists("get", "/api/transparency"));

  it("GET /api/correlation is mounted", () =>
    probeRouteExists("get", "/api/correlation"));

  it("GET /api/incidents is mounted", () =>
    probeRouteExists("get", "/api/incidents"));

  it("POST /api/stress-scenarios/run is mounted", () =>
    probeRouteExists("post", "/api/stress-scenarios/run"));

  it("GET /api/recommend/timeline is mounted", () =>
    probeRouteExists("get", "/api/recommend/timeline?userId=anonymous"));

  // ── Routes that exist in route files but client calls differently ────
  it("GET /api/rebalances/:vaultId/recent is mounted", () =>
    probeRouteExists("get", "/api/rebalances/test-vault/recent?limit=5"));

  it("GET /api/rebalances/:vaultId/stats is mounted", () =>
    probeRouteExists("get", "/api/rebalances/test-vault/stats"));

  // ── Google Sheets OAuth routes (#818) ────────────────────────────────
  it("POST /api/google-sheets/token is mounted", () =>
    probeRouteExists("post", "/api/google-sheets/token"));

  it("POST /api/google-sheets/refresh is mounted", () =>
    probeRouteExists("post", "/api/google-sheets/refresh"));

  it("POST /api/google-sheets/verify is mounted", () =>
    probeRouteExists("post", "/api/google-sheets/verify"));

  it("POST /api/google-sheets/append is mounted", () =>
    probeRouteExists("post", "/api/google-sheets/append"));

  // ── Unimplemented endpoints flagged as stale integrations ────────────
  it.todo(
    "#723 /api/backtest — client calls relative path; backend route is /api/simulator/rebalance-backtest",
  );
  it.todo(
    "#723 /api/rewards/proof/:address — client calls this but rewards router only exposes /schedule-summary",
  );
  it.todo(
    "#723 /api/rewards/claim — client calls this but rewards router only exposes /schedule-summary",
  );
});
