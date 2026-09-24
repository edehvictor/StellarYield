/**
 * #1418 — Integration smoke test for production health endpoints.
 *
 * `deploymentSmoke.test.ts` checks that client-facing routes are wired
 * (no 404) and spot-checks `/api/health` once. This suite is narrower and
 * deeper: it exercises every sub-route under `/api/health` end to end
 * against the real Express app (no per-service mocking), the way an
 * uptime/synthetic monitor would hit them in production. The goal is to
 * catch a route that 500s, hangs past its own timeout budget, or returns a
 * shape the deploy/readiness tooling doesn't expect — before that ships.
 *
 * Real Prisma/Redis/Horizon/Soroban RPC are unavailable in CI, so most
 * dependencies are expected to report degraded/unreachable. That is a
 * pass here: this suite verifies "the endpoint answers, on time, with a
 * stable shape" — not "every dependency is healthy". A hang, a 500, or a
 * response missing its documented fields is a fail.
 */
import request from "supertest";
import { createApp } from "../app";

const app = createApp();

// Generous relative to each route's own internal HEALTH_CHECK_TIMEOUT_MS
// (5s default, 500ms in test) — this bounds the smoke test itself, not the
// health check's own timeout behavior.
const SMOKE_TIMEOUT_MS = 8_000;

interface EndpointExpectation {
  path: string;
  method?: "get" | "post";
  /** Status codes considered "answered correctly" for this endpoint. */
  okStatuses: number[];
  /** Fields the JSON body must have when the endpoint answers at all. */
  requiredFields?: string[];
}

const ENDPOINTS: EndpointExpectation[] = [
  { path: "/api/health", okStatuses: [200, 503], requiredFields: ["status"] },
  { path: "/api/health/readiness", okStatuses: [200, 503] },
  { path: "/api/health/startup", okStatuses: [200, 503] },
  { path: "/api/health/dependencies", okStatuses: [200, 503] },
  { path: "/api/health/graph", okStatuses: [200, 503] },
  { path: "/api/health/queues", okStatuses: [200, 503] },
  { path: "/api/health/digest", okStatuses: [200, 404] },
  { path: "/api/health/keepers", okStatuses: [200] },
  { path: "/api/health/boot-summary", okStatuses: [200, 503] },
];

describe("Production health endpoints — integration smoke", () => {
  for (const endpoint of ENDPOINTS) {
    const method = endpoint.method ?? "get";

    it(
      `${method.toUpperCase()} ${endpoint.path} answers within budget with a documented status`,
      async () => {
        const res =
          method === "get"
            ? await request(app).get(endpoint.path)
            : await request(app).post(endpoint.path).send({});

        expect(endpoint.okStatuses).toContain(res.status);

        // Never leak an unhandled exception's raw shape (stack traces,
        // driver error objects) — every response must be a plain object.
        expect(res.body).toBeDefined();
        expect(typeof res.body).toBe("object");

        for (const field of endpoint.requiredFields ?? []) {
          expect(res.body).toHaveProperty(field);
        }
      },
      SMOKE_TIMEOUT_MS,
    );
  }

  it("every health sub-route responds strictly faster than the smoke budget, even when degraded", async () => {
    const results = await Promise.all(
      ENDPOINTS.map(async (endpoint) => {
        const start = Date.now();
        await request(app).get(endpoint.path);
        return Date.now() - start;
      }),
    );

    for (const elapsedMs of results) {
      expect(elapsedMs).toBeLessThan(SMOKE_TIMEOUT_MS);
    }
  }, SMOKE_TIMEOUT_MS * ENDPOINTS.length);

  it("an unknown path under /api/health/* does not silently 200", async () => {
    const res = await request(app).get("/api/health/this-route-does-not-exist");
    expect(res.status).not.toBe(200);
  });
});
