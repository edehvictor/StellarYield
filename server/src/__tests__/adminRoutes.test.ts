import request from "supertest";
import { createApp } from "../app";

describe("Administrative Routes Role Check Authorization", () => {
  const app = createApp();

  const adminEndpoints = [
    { method: "post", path: "/api/admin/vaults/v1/parameters", body: { maxCapacity: 1000 } },
    { method: "post", path: "/api/admin/vaults/v1/pause", body: { reason: "maintenance" } },
    { method: "post", path: "/api/admin/vaults/v1/resume", body: {} },
    { method: "post", path: "/api/admin/fees/config", body: { performanceFeeBps: 500 } },
    { method: "post", path: "/api/admin/risk/parameters", body: { maxVolatility: 10 } },
    { method: "post", path: "/api/admin/recommendations/freeze", body: { reason: "critical event" } },
    { method: "post", path: "/api/admin/recommendations/resume", body: {} },
    { method: "get", path: "/api/admin/audit-logs", body: null },
    { method: "get", path: "/api/admin/audit-stats", body: null },
    { method: "get", path: "/api/admin/audit-verify", body: null },
  ];

  describe("Unauthorized Requests (No authentication)", () => {
    adminEndpoints.forEach(({ method, path, body }) => {
      it(`should reject ${method.toUpperCase()} ${path} with 403`, async () => {
        let req = request(app)[method as "get" | "post"](path);
        if (body) {
          req = req.send(body);
        }
        const res = await req;
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/Unauthorized: Admin access required/);
      });
    });
  });

  describe("Non-Admin User Requests (Role: USER)", () => {
    adminEndpoints.forEach(({ method, path, body }) => {
      it(`should reject ${method.toUpperCase()} ${path} with 403 for user role`, async () => {
        let req = request(app)[method as "get" | "post"](path)
          .set("Authorization", "Bearer mock-user-token");
        if (body) {
          req = req.send(body);
        }
        const res = await req;
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/Unauthorized: Admin access required/);
      });
    });
  });

  describe("Authorized Admin Requests (Mock Token)", () => {
    adminEndpoints.forEach(({ method, path, body }) => {
      it(`should accept ${method.toUpperCase()} ${path} for mock admin token`, async () => {
        let req = request(app)[method as "get" | "post"](path)
          .set("Authorization", "Bearer mock-admin-token");
        if (body) {
          req = req.send(body);
        }
        const res = await req;
        expect(res.status).not.toBe(403);
        expect(res.body.error).toBeUndefined();
      });
    });
  });

  describe("Authorized Admin Requests (JWT base64 Decoded)", () => {
    const payload = { sub: "admin-456", email: "sec@stellaryield.com", role: "ADMIN" };
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    
    // Construct fake header.payload.signature
    const fakeJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payloadBase64}.signature`;

    adminEndpoints.forEach(({ method, path, body }) => {
      it(`should accept ${method.toUpperCase()} ${path} with decoded JWT`, async () => {
        let req = request(app)[method as "get" | "post"](path)
          .set("Authorization", `Bearer ${fakeJwt}`);
        if (body) {
          req = req.send(body);
        }
        const res = await req;
        expect(res.status).not.toBe(403);
        expect(res.body.error).toBeUndefined();
      });
    });
  });
});
