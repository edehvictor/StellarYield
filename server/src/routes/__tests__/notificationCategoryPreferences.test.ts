/**
 * Tests for notification category preference routes (issue #1398).
 */
import request from "supertest";
import express, { Express } from "express";
import categoryPrefRouter from "../notificationCategoryPreferences";
import * as svc from "../../services/notificationCategoryPreferences";

jest.mock("../../middleware/validation", () => ({
  validateWalletAddress: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

const WALLET = "GABC0000000000000000000000000000000000000000000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", categoryPrefRouter);
  return app;
}

beforeEach(() => {
  svc.resetCategoryPreferences(WALLET);
});

describe("GET /api/notifications/category-preferences/:walletAddress", () => {
  it("returns all 4 categories with defaults", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/notifications/category-preferences/${WALLET}`)
      .expect(200);

    expect(res.body.walletAddress).toBe(WALLET);
    expect(Array.isArray(res.body.preferences)).toBe(true);
    expect(res.body.preferences).toHaveLength(4);
    const categories = res.body.preferences.map(
      (p: svc.CategoryPreference) => p.category,
    );
    expect(categories).toEqual(
      expect.arrayContaining(["DEPOSIT", "WITHDRAWAL", "ANNOUNCEMENT", "HARVEST"]),
    );
  });

  it("defaults have enabled=true, channel=in_app, cooldownMinutes=60", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/notifications/category-preferences/${WALLET}`)
      .expect(200);

    for (const pref of res.body.preferences as svc.CategoryPreference[]) {
      expect(pref.enabled).toBe(true);
      expect(pref.channel).toBe("in_app");
      expect(pref.cooldownMinutes).toBe(60);
    }
  });
});

describe("GET /api/notifications/category-preferences/:walletAddress/:category", () => {
  it("returns the DEPOSIT preference", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/notifications/category-preferences/${WALLET}/DEPOSIT`)
      .expect(200);

    expect(res.body.category).toBe("DEPOSIT");
    expect(typeof res.body.enabled).toBe("boolean");
  });

  it("accepts lowercase category and normalises it", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/notifications/category-preferences/${WALLET}/harvest`)
      .expect(200);

    expect(res.body.category).toBe("HARVEST");
  });

  it("returns 400 for an unknown category", async () => {
    const app = makeApp();
    await request(app)
      .get(`/api/notifications/category-preferences/${WALLET}/UNKNOWN_CATEGORY`)
      .expect(400);
  });
});

describe("PUT /api/notifications/category-preferences/:walletAddress/:category", () => {
  it("updates enabled to false", async () => {
    const app = makeApp();
    const res = await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/DEPOSIT`)
      .send({ enabled: false })
      .expect(200);

    expect(res.body.category).toBe("DEPOSIT");
    expect(res.body.enabled).toBe(false);
  });

  it("updates channel to email", async () => {
    const app = makeApp();
    const res = await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/WITHDRAWAL`)
      .send({ channel: "email" })
      .expect(200);

    expect(res.body.channel).toBe("email");
  });

  it("updates cooldownMinutes", async () => {
    const app = makeApp();
    const res = await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/HARVEST`)
      .send({ cooldownMinutes: 30 })
      .expect(200);

    expect(res.body.cooldownMinutes).toBe(30);
  });

  it("accepts partial updates — untouched fields keep their values", async () => {
    const app = makeApp();
    // First set channel to email
    await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/ANNOUNCEMENT`)
      .send({ channel: "email" })
      .expect(200);

    // Then update only enabled
    const res = await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/ANNOUNCEMENT`)
      .send({ enabled: false })
      .expect(200);

    expect(res.body.channel).toBe("email"); // unchanged
    expect(res.body.enabled).toBe(false);    // updated
  });

  it("returns 400 when enabled is not a boolean", async () => {
    const app = makeApp();
    await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/DEPOSIT`)
      .send({ enabled: "yes" })
      .expect(400);
  });

  it("returns 400 when channel is invalid", async () => {
    const app = makeApp();
    await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/DEPOSIT`)
      .send({ channel: "sms" })
      .expect(400);
  });

  it("returns 400 when cooldownMinutes exceeds 1440", async () => {
    const app = makeApp();
    await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/DEPOSIT`)
      .send({ cooldownMinutes: 9999 })
      .expect(400);
  });

  it("returns 400 for unknown category", async () => {
    const app = makeApp();
    await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/BOGUS`)
      .send({ enabled: false })
      .expect(400);
  });
});

describe("DELETE /api/notifications/category-preferences/:walletAddress", () => {
  it("resets preferences to defaults and returns 204", async () => {
    const app = makeApp();
    // Mutate first
    await request(app)
      .put(`/api/notifications/category-preferences/${WALLET}/DEPOSIT`)
      .send({ enabled: false, channel: "email" })
      .expect(200);

    // Reset
    await request(app)
      .delete(`/api/notifications/category-preferences/${WALLET}`)
      .expect(204);

    // Verify defaults restored
    const res = await request(app)
      .get(`/api/notifications/category-preferences/${WALLET}/DEPOSIT`)
      .expect(200);

    expect(res.body.enabled).toBe(true);
    expect(res.body.channel).toBe("in_app");
    expect(res.body.cooldownMinutes).toBe(60);
  });
});
