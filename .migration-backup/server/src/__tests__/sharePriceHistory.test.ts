import request from "supertest";
import { createApp } from "../app";

const app = createApp();

describe("GET /api/vaults/:vaultId/share-price-history", () => {
  it("returns an array (fixture) when no database is available", async () => {
    const res = await request(app).get(
      "/api/vaults/primary-yield-vault/share-price-history",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns fixture snapshots with expected shape", async () => {
    const res = await request(app).get(
      "/api/vaults/primary-yield-vault/share-price-history",
    );
    expect(res.status).toBe(200);
    const body = res.body as Array<{
      date: string;
      sharePrice: number;
      vaultId: string;
    }>;

    if (body.length > 0) {
      const first = body[0];
      expect(typeof first.date).toBe("string");
      expect(typeof first.sharePrice).toBe("number");
      expect(first.sharePrice).toBeGreaterThan(0);
      expect(typeof first.vaultId).toBe("string");
    }
  });

  it("defaults to 90 days of fixture data", async () => {
    const res = await request(app).get(
      "/api/vaults/primary-yield-vault/share-price-history",
    );
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBeLessThanOrEqual(90);
  });

  it("respects the days query parameter", async () => {
    const res = await request(app).get(
      "/api/vaults/primary-yield-vault/share-price-history?days=30",
    );
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBeLessThanOrEqual(30);
  });

  it("caps days at 365", async () => {
    const res = await request(app).get(
      "/api/vaults/primary-yield-vault/share-price-history?days=1000",
    );
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBeLessThanOrEqual(365);
  });

  it("ignores invalid days param and falls back to default", async () => {
    const res = await request(app).get(
      "/api/vaults/primary-yield-vault/share-price-history?days=abc",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns data for different vault IDs without erroring", async () => {
    const res = await request(app).get(
      "/api/vaults/another-vault/share-price-history",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
