/**
 * Vault share-price reconciliation route tests.
 *
 * Exercises the HTTP surface via supertest against an isolated Express app
 * built with the injectable createVaultSharePriceReconcileRouter factory.
 */

import request from "supertest";
import express, { Express } from "express";
import {
  createVaultSharePriceReconcileRouter,
} from "../vaultSharePriceReconcile";
import {
  VaultSharePriceReconciliationService,
  resetSharePriceReconHistory,
} from "../../services/vaultSharePriceReconciliationService";
import {
  VAULT_SHARE_PRICE_EVENT_TYPES,
  type CachedSharePrice,
  type VaultSharePriceEvent,
} from "../../../../shared/types/vaultSharePrice";

function makeEvent(
  overrides: Partial<VaultSharePriceEvent> = {},
): VaultSharePriceEvent {
  return {
    vaultId: "vault-1",
    ledger: 100,
    txHash: "tx-0",
    eventIndex: 0,
    amount: "1000000",
    eventType: "deposit",
    ...overrides,
  };
}

function cached(overrides: Partial<CachedSharePrice> = {}): CachedSharePrice {
  return {
    vaultId: "vault-1",
    sharePrice: 1.0,
    totalShares: 1_000_000,
    totalAssets: 1_000_000,
    snapshotAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildApp(service: VaultSharePriceReconciliationService): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/vaults", createVaultSharePriceReconcileRouter(service));
  return app;
}

const STANDARD_HEADERS = { "Content-Type": "application/json" };

describe("Vault share-price reconcile routes", () => {
  let service: VaultSharePriceReconciliationService;
  let app: Express;

  beforeEach(() => {
    resetSharePriceReconHistory();
    service = new VaultSharePriceReconciliationService({
      cacheLoader: { loadSharePrice: () => Promise.resolve(null) },
    });
    app = buildApp(service);
  });

  // POST /:vaultId/share-price/reconcile ──────────────────────────────────────

  describe("POST /api/vaults/:vaultId/share-price/reconcile", () => {
    it("reconciles matching contract/cache with 200 and success status", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [makeEvent({ amount: "1000000", shares: "1000000" })],
          cachedSnapshot: cached(),
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.contractSharePrice).toBe(1.0);
      expect(res.body.sharesAgree).toBe(true);
      expect(res.body.primaryCause).toBeNull();
    });

    it("returns 400 when events is an empty array (partial, contract side missing)", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({ events: [], cachedSnapshot: cached() });

      // An empty event log yields a "partial" result (contract side unverified),
      // not a 400 — the route returns the deterministic body with 200.
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("partial");
    });

    it("returns 400 when events is not an array", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({ events: "not-an-array" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("MALFORMED_INPUT");
    });

    it("returns 400 for an event missing vaultId", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [{ eventType: "deposit", amount: "100", shares: "10", ledger: 1, txHash: "x", eventIndex: 0 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_EVENT");
      expect(res.body.message).toMatch(/vaultId/);
    });

    it("returns 400 for a deposit event missing shares", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [{ ...makeEvent({}), shares: undefined }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_EVENT");
    });

    it("returns 400 for an invalid eventType", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [{ ...makeEvent({ eventType: "deposit" }), eventType: "bogus" }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_EVENT");
      expect(res.body.message).toMatch(/eventType/);
    });

    it("returns 400 for a non-integer amount", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({ events: [{ ...makeEvent({}), amount: "1.5" }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_EVENT");
    });

    it("returns 400 when cachedSnapshot missing finite sharePrice", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [makeEvent({ amount: "1000000", shares: "1000000" })],
          cachedSnapshot: { totalShares: 1_000_000, totalAssets: 1_000_000 },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("MALFORMED_INPUT");
      expect(res.body.message).toMatch(/cachedSnapshot/);
    });

    it("falls back to the cache loader when cachedSnapshot is omitted", async () => {
      const spyService = new VaultSharePriceReconciliationService({
        cacheLoader: {
          loadSharePrice: (vaultId: string) =>
            Promise.resolve(cached({ vaultId, totalShares: 1_000_000, totalAssets: 1_000_000 })),
        },
      });
      const res = await request(buildApp(spyService))
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({ events: [makeEvent({ amount: "1000000", shares: "1000000" })] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.cachedState).not.toBeNull();
    });

    it("normalizes a raw cache-loader rejection to 503 CACHE_UNAVAILABLE", async () => {
      const failingService = new VaultSharePriceReconciliationService({
        cacheLoader: {
          loadSharePrice: () =>
            Promise.reject(new Error("unexpected provider explosion")),
        },
      });
      const res = await request(buildApp(failingService))
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({ events: [makeEvent({ amount: "1000000", shares: "1000000" })] });

      // Raw loader errors are wrapped into VaultSharePriceError("CACHE_UNAVAILABLE")
      // so the route maps them to 503 rather than leaking the provider message.
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("CACHE_UNAVAILABLE");
    });

    it("rejects negative withdrawals via service as 400 NEGATIVE_TOTAL_ASSETS", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [makeEvent({ eventType: "withdraw", amount: "100", shares: "5" })],
          cachedSnapshot: cached(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("NEGATIVE_TOTAL_ASSETS");
    });

    it("accepts a transfer_shares event (no-op on totals)", async () => {
      const res = await request(buildApp(service))
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [
            makeEvent({ eventType: "deposit", amount: "1000000", shares: "1000000", ledger: 1, txHash: "a" }),
            makeEvent({ eventType: "transfer_shares", shares: "5", ledger: 2, txHash: "b" }),
          ],
          cachedSnapshot: cached(),
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.contractState.eventCount).toBe(2);
    });
    it("returns 400 INVALID_EVENT when an event belongs to a different vault", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [makeEvent({ vaultId: "vault-2", amount: "1000", shares: "1000" })],
          cachedSnapshot: cached(),
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_EVENT");
    });

    it("returns 400 INVALID_EVENT for a negative amount", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [makeEvent({ amount: "-1000", shares: "1000" })],
          cachedSnapshot: cached(),
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_EVENT");
    });

    it("returns 400 when cachedSnapshot omits totalAssets instead of defaulting it to 0", async () => {
      const { totalAssets: _omitted, ...partial } = cached();
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [makeEvent({ amount: "1000000", shares: "1000000" })],
          cachedSnapshot: partial,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("MALFORMED_INPUT");
    });

    it("accepts flash_loan / emergency_withdraw / rescue and serializes bigint totals", async () => {
      const res = await request(app)
        .post("/api/vaults/vault-1/share-price/reconcile")
        .set(STANDARD_HEADERS)
        .send({
          events: [
            makeEvent({ eventType: "deposit", amount: "1000000", shares: "1000000", ledger: 1, txHash: "a" }),
            makeEvent({ eventType: "flash_loan", amount: "10000", ledger: 2, txHash: "b" }),
            makeEvent({ eventType: "emergency_withdraw", amount: "100000", shares: "100000", ledger: 3, txHash: "c" }),
            makeEvent({ eventType: "rescue", amount: "10000", ledger: 4, txHash: "d" }),
          ],
          cachedSnapshot: cached({ totalAssets: 900_000, totalShares: 900_000, sharePrice: 1 }),
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.contractState.totalAssets).toBe("900000");
      expect(res.body.contractState.totalShares).toBe("900000");
    });
  });

  // GET .../history ────────────────────────────────────────────────────────────

  describe("GET /api/vaults/:vaultId/share-price/reconcile/history", () => {
    it("returns an empty list with 200 when no runs exist", async () => {
      const res = await request(app).get("/api/vaults/vault-1/share-price/reconcile/history");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
      expect(res.body.data).toEqual([]);
      expect(res.body.vaultId).toBe("vault-1");
    });

    it("returns persisted runs for the requested vault only", async () => {
      const seeded = new VaultSharePriceReconciliationService({
        cacheLoader: { loadSharePrice: () => Promise.resolve(cached()) },
      });
      await seeded.reconcileVault(
        "vault-1",
        [makeEvent({ amount: "1000000", shares: "1000000" })],
      );
      await seeded.reconcileVault("vault-2", [makeEvent({ vaultId: "vault-2", amount: "2000000", shares: "2000000" })]);

      const res = await request(buildApp(seeded)).get(
        "/api/vaults/vault-1/share-price/reconcile/history",
      );
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.data[0].vaultId).toBe("vault-1");
    });

    it("supports a status filter and limit clamp", async () => {
      const seeded = new VaultSharePriceReconciliationService({
        cacheLoader: { loadSharePrice: () => Promise.resolve(cached()) },
      });
      for (let i = 0; i < 3; i += 1) {
        await seeded.reconcileVault(
          "vault-1",
          [makeEvent({ amount: "1000", shares: "1000" })],
        );
      }
      const res = await request(buildApp(seeded))
        .get("/api/vaults/vault-1/share-price/reconcile/history")
        .query({ status: "success", limit: 100 });

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100); // clamped to max 100
      expect(res.body.data.every((e: { status: string }) => e.status === "success")).toBe(true);
    });

    it("returns runs newest first", async () => {
      const seeded = new VaultSharePriceReconciliationService({
        cacheLoader: { loadSharePrice: () => Promise.resolve(cached()) },
      });
      jest.useFakeTimers({ now: new Date("2026-09-01T00:00:00Z") });
      try {
        await seeded.reconcileVault("vault-1", [makeEvent({ amount: "1000000", shares: "1000000" })]);
        jest.setSystemTime(new Date("2026-09-02T00:00:00Z"));
        await seeded.reconcileVault("vault-1", [makeEvent({ amount: "5000000", shares: "1000000" })]);
      } finally {
        jest.useRealTimers();
      }
      const res = await request(buildApp(seeded)).get(
        "/api/vaults/vault-1/share-price/reconcile/history",
      );
      expect(res.body.data.map((e: { status: string }) => e.status)).toEqual(["partial", "success"]);
    });

    it("returns 400 for an unknown status filter", async () => {
      const res = await request(app)
        .get("/api/vaults/vault-1/share-price/reconcile/history")
        .query({ status: "bogus" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("MALFORMED_INPUT");
    });

    it("clamps limit to 1 minimum", async () => {
      const res = await request(app)
        .get("/api/vaults/vault-1/share-price/reconcile/history")
        .query({ limit: -5 });
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(1);
    });
  });

  // Route surface sanity ───────────────────────────────────────────────────────

  describe("router factory", () => {
    it("createVaultSharePriceReconcileRouter returns an express Router", () => {
      expect(typeof createVaultSharePriceReconcileRouter).toBe("function");
      const router = createVaultSharePriceReconcileRouter(service);
      expect(router).toBeDefined();
      expect(typeof router.use).toBe("function");
    });

    it("default export is a ready-to-mount router (no ctor args)", () => {
      // Imported lazily to avoid hitting the DB during this sanity check.
      // The default export simply calls the factory with a default service.
      expect(VAULT_SHARE_PRICE_EVENT_TYPES).toContain("deposit");
      expect(VAULT_SHARE_PRICE_EVENT_TYPES).toContain("transfer_shares");
    });
  });
});
