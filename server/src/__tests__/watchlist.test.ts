import request from "supertest";
import { createApp } from "../app";

jest.mock("../services/watchlistService", () => ({
  WatchlistService: {
    getUserWatchlist: jest.fn(),
    getUserAlerts: jest.fn(),
    addToWatchlist: jest.fn(),
    removeFromWatchlist: jest.fn(),
    addThresholdRule: jest.fn(),
    removeThresholdRule: jest.fn(),
    acknowledgeAlert: jest.fn(),
    checkThresholdsAndTriggerAlerts: jest.fn(),
    batchCheckThresholds: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { WatchlistService: mockWatchlistService } = jest.requireMock(
  "../services/watchlistService"
) as any;

const WALLET_A = "GWALLETA0000000000000000000000000000000000000000000001";
const WALLET_B = "GWALLETB0000000000000000000000000000000000000000000002";

const EMPTY_WATCHLIST = { items: [], total: 0, totalUnacknowledgedAlerts: 0 };

describe("Watchlist API — wallet-scoped identity (#1173)", () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockWatchlistService.getUserWatchlist.mockResolvedValue(EMPTY_WATCHLIST);
    mockWatchlistService.getUserAlerts.mockResolvedValue([]);
  });

  describe("GET /api/watchlist", () => {
    it("returns 401 when no wallet address is provided", async () => {
      const res = await request(app).get("/api/watchlist");
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("WALLET_ADDRESS_REQUIRED");
      expect(mockWatchlistService.getUserWatchlist).not.toHaveBeenCalled();
    });

    it("scopes the lookup to the wallet in the x-wallet-address header", async () => {
      const res = await request(app)
        .get("/api/watchlist")
        .set("x-wallet-address", WALLET_A);

      expect(res.status).toBe(200);
      expect(mockWatchlistService.getUserWatchlist).toHaveBeenCalledWith(WALLET_A);
      expect(mockWatchlistService.getUserWatchlist).not.toHaveBeenCalledWith("user-1");
    });

    it("scopes distinct wallets to distinct calls — no shared 'user-1' fallback", async () => {
      await request(app).get("/api/watchlist").set("x-wallet-address", WALLET_A);
      await request(app).get("/api/watchlist").set("x-wallet-address", WALLET_B);

      expect(mockWatchlistService.getUserWatchlist).toHaveBeenNthCalledWith(1, WALLET_A);
      expect(mockWatchlistService.getUserWatchlist).toHaveBeenNthCalledWith(2, WALLET_B);
    });
  });

  describe("GET /api/watchlist/alerts", () => {
    it("returns 401 without a wallet address", async () => {
      const res = await request(app).get("/api/watchlist/alerts");
      expect(res.status).toBe(401);
    });

    it("scopes alerts to the requesting wallet", async () => {
      const res = await request(app)
        .get("/api/watchlist/alerts")
        .set("x-wallet-address", WALLET_A);

      expect(res.status).toBe(200);
      expect(mockWatchlistService.getUserAlerts).toHaveBeenCalledWith(WALLET_A);
    });
  });

  describe("POST /api/watchlist", () => {
    it("returns 401 without a wallet address, even with a valid body", async () => {
      const res = await request(app)
        .post("/api/watchlist")
        .send({ opportunityId: "opp-1", opportunityType: "vault", opportunityName: "Blend" });

      expect(res.status).toBe(401);
      expect(mockWatchlistService.addToWatchlist).not.toHaveBeenCalled();
    });

    it("adds to the requesting wallet's watchlist, not a shared default", async () => {
      mockWatchlistService.addToWatchlist.mockResolvedValue({ id: "item-1" });

      const res = await request(app)
        .post("/api/watchlist")
        .set("x-wallet-address", WALLET_A)
        .send({ opportunityId: "opp-1", opportunityType: "vault", opportunityName: "Blend" });

      expect(res.status).toBe(201);
      expect(mockWatchlistService.addToWatchlist).toHaveBeenCalledWith(
        WALLET_A,
        "opp-1",
        "vault",
        "Blend",
        0,
        0
      );
    });
  });

  describe("DELETE /api/watchlist/:itemId", () => {
    it("returns 401 without a wallet address", async () => {
      const res = await request(app).delete("/api/watchlist/item-1");
      expect(res.status).toBe(401);
    });

    it("scopes removal to the requesting wallet", async () => {
      mockWatchlistService.removeFromWatchlist.mockResolvedValue({ id: "item-1" });

      const res = await request(app)
        .delete("/api/watchlist/item-1")
        .set("x-wallet-address", WALLET_B);

      expect(res.status).toBe(200);
      expect(mockWatchlistService.removeFromWatchlist).toHaveBeenCalledWith(WALLET_B, "item-1");
    });
  });
});
