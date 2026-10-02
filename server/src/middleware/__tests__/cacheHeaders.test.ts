import express, { Express } from "express";
import request from "supertest";
import { cacheControl } from "../cacheHeaders";

describe("cacheControl middleware", () => {
  function buildApp(handler: (req: express.Request, res: express.Response) => void): Express {
    const app = express();
    app.get(
      "/thing",
      cacheControl({ maxAgeSeconds: 60, staleWhileRevalidateSeconds: 30 }),
      handler,
    );
    return app;
  }

  it("sets a public, max-age, stale-while-revalidate header on a 200 JSON response", async () => {
    const app = buildApp((_req, res) => res.json({ ok: true }));

    const response = await request(app).get("/thing").expect(200);

    expect(response.headers["cache-control"]).toBe(
      "public, max-age=60, stale-while-revalidate=30",
    );
  });

  it("omits stale-while-revalidate when not configured", async () => {
    const app = express();
    app.get(
      "/thing",
      cacheControl({ maxAgeSeconds: 15 }),
      (_req, res) => res.json({ ok: true }),
    );

    const response = await request(app).get("/thing").expect(200);

    expect(response.headers["cache-control"]).toBe("public, max-age=15");
  });

  it("does not cache a 4xx error response", async () => {
    const app = buildApp((_req, res) => res.status(400).json({ ok: false }));

    const response = await request(app).get("/thing").expect(400);

    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("does not cache a 5xx error response", async () => {
    const app = buildApp((_req, res) => res.status(500).json({ ok: false }));

    const response = await request(app).get("/thing").expect(500);

    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("respects an explicit private scope", async () => {
    const app = express();
    app.get(
      "/thing",
      cacheControl({ maxAgeSeconds: 10, scope: "private" }),
      (_req, res) => res.json({ ok: true }),
    );

    const response = await request(app).get("/thing").expect(200);

    expect(response.headers["cache-control"]).toBe("private, max-age=10");
  });
});
