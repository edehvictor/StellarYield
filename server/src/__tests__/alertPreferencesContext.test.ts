/**
 * Alert preferences — network/ledger context binding (#1908).
 *
 * The real service, router, and audit trail are used; no Prisma-backed path
 * is exercised. Each case asserts that a rejected request leaves preferences,
 * version, and binding untouched.
 */
import express from "express";
import request from "supertest";
import alertsRouter from "../routes/alerts";
import * as auditService from "../services/alertPreferenceAuditService";
import {
  computeChecksum,
} from "../utils/checksum";
import {
  clearAlertOperationStore,
  clearAlertPreferencesStore,
  getAlertPreferences,
  getAlertPreferencesContext,
  getAlertPreferencesVersion,
} from "../services/alertsService";

const WALLET = "GCONTEXT";
const VAULT = "Blend";
const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; November 2015";

const prefs = (cooldownMinutes: number) => ({
  channel: "email" as const,
  cooldownMinutes,
  severityThreshold: 10,
  quietHoursStart: 23,
  quietHoursEnd: 6,
});

const app = express();
app.use(express.json());
app.use("/api/alerts", alertsRouter);

const context = (passphrase: string) => ({
  networkPassphrase: passphrase,
  vaultId: VAULT,
  schemaVersion: 1,
});

const networkId = (passphrase: string) => computeChecksum(passphrase);

const originalPassphrase = process.env.NETWORK_PASSPHRASE;

beforeEach(() => {
  process.env.NETWORK_PASSPHRASE = TESTNET;
  delete process.env.STELLAR_NETWORK_PASSPHRASE;
  clearAlertPreferencesStore();
  clearAlertOperationStore();
  auditService.resetAuditStore();
  jest.restoreAllMocks();
});

afterAll(() => {
  if (originalPassphrase === undefined) delete process.env.NETWORK_PASSPHRASE;
  else process.env.NETWORK_PASSPHRASE = originalPassphrase;
});

describe("context-bound preference writes", () => {
  it("binds the first write and echoes the context on read", async () => {
    const write = await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", TESTNET)
      .set("X-Alert-Schema-Version", "1")
      .send(prefs(10));
    expect(write.status).toBe(200);
    expect(write.headers["x-alert-network-id"]).toBe(networkId(TESTNET));
    expect(write.headers["x-alert-schema-version"]).toBe("1");
    expect(getAlertPreferencesContext(WALLET, VAULT)).toEqual({
      networkId: networkId(TESTNET),
      vaultId: VAULT.toLowerCase(),
      schemaVersion: 1,
    });

    const read = await request(app)
      .get(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", TESTNET);
    expect(read.status).toBe(200);
    expect(read.headers["x-alert-network-id"]).toBe(networkId(TESTNET));
    expect(read.body.context.networkId).toBe(networkId(TESTNET));
    expect(read.body.preferences).toEqual(prefs(10));
  });

  it("rejects a write prepared on another network without changing state", async () => {
    const res = await request(app)
      .put("/api/alerts/preferences")
      .send({
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: prefs(10),
        context: context(MAINNET),
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PREFERENCE_CONTEXT_CONFLICT");
    expect(res.body.reason).toBe("WRONG_NETWORK");
    expect(getAlertPreferences(WALLET, VAULT)).toBeUndefined();
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(0);
    expect(auditService.getAuditEntryCount(WALLET, VAULT)).toBe(0);
  });

  it("rejects a malformed context with 400 and writes nothing", async () => {
    const res = await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Id", "not-a-hash")
      .send(prefs(10));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ALERT_CONTEXT");
    expect(getAlertPreferences(WALLET, VAULT)).toBeUndefined();
  });

  it("preserves preferences, version, and binding when the audit write fails", async () => {
    await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", TESTNET)
      .send(prefs(10));
    jest.spyOn(auditService, "recordPreferenceChange").mockImplementationOnce(() => {
      throw new Error("audit store unavailable");
    });

    const failed = await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", TESTNET)
      .set("If-Match", '"1"')
      .send(prefs(20));
    expect(failed.status).toBe(500);
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(10));
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(1);
    expect(getAlertPreferencesContext(WALLET, VAULT).networkId).toBe(networkId(TESTNET));

    const retry = await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", TESTNET)
      .set("If-Match", '"1"')
      .send(prefs(20));
    expect(retry.status).toBe(200);
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(2);
  });
});

describe("network transitions", () => {
  it("rejects reads against a migrated network until an explicit rebind", async () => {
    await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", TESTNET)
      .send(prefs(10));

    process.env.NETWORK_PASSPHRASE = MAINNET;
    const read = await request(app)
      .get(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", MAINNET);
    expect(read.status).toBe(409);
    expect(read.body.code).toBe("PREFERENCE_CONTEXT_CONFLICT");
    expect(read.body.reason).toBe("STORED_CONTEXT_MISMATCH");
    expect(read.body.currentContext.networkId).toBe(networkId(TESTNET));
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(10));

    const staleWrite = await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", MAINNET)
      .send(prefs(20));
    expect(staleWrite.status).toBe(409);
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(10));

    const rebind = await request(app)
      .post(`/api/alerts/${WALLET}/preferences/${VAULT}/rebind`)
      .send({ context: context(TESTNET) });
    expect(rebind.status).toBe(200);
    expect(rebind.body.preferences).toEqual(prefs(10));
    expect(rebind.body.version).toBe(2);
    expect(rebind.body.context.networkId).toBe(networkId(MAINNET));
    expect(rebind.headers["x-idempotent-replayed"]).toBeUndefined();

    const again = await request(app)
      .post(`/api/alerts/${WALLET}/preferences/${VAULT}/rebind`)
      .send({ context: context(TESTNET) });
    expect(again.status).toBe(200);
    expect(again.headers["x-idempotent-replayed"]).toBe("true");
    expect(again.body.version).toBe(2);

    const reread = await request(app)
      .get(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", MAINNET);
    expect(reread.status).toBe(200);
    expect(reread.body.preferences).toEqual(prefs(10));
  });
});

describe("safe retry", () => {
  it("replays a committed operation with the same context and writes nothing", async () => {
    const body = {
      walletAddress: WALLET,
      vaultId: VAULT,
      preferences: prefs(10),
      operationIdentity: "op-context-1",
      context: context(TESTNET),
    };
    const first = await request(app).put("/api/alerts/preferences").send(body);
    expect(first.status).toBe(200);
    expect(first.headers["x-preferences-version"]).toBe("1");

    await request(app)
      .put("/api/alerts/preferences")
      .send({ ...body, operationIdentity: "op-context-2", preferences: prefs(20) });

    const replay = await request(app).put("/api/alerts/preferences").send(body);
    expect(replay.status).toBe(200);
    expect(replay.headers["x-idempotent-replayed"]).toBe("true");
    expect(replay.headers["x-preferences-version"]).toBe("1");
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(20));
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(2);
  });

  it("does not consume an operation identity on a context conflict", async () => {
    await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("X-Alert-Network-Passphrase", TESTNET)
      .send(prefs(10));

    const stale = await request(app)
      .put("/api/alerts/preferences")
      .send({
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: prefs(20),
        operationIdentity: "op-context-3",
        context: context(MAINNET),
      });
    expect(stale.status).toBe(409);

    const retry = await request(app)
      .put("/api/alerts/preferences")
      .send({
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: prefs(20),
        operationIdentity: "op-context-3",
        context: context(TESTNET),
      });
    expect(retry.status).toBe(200);
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(2);
  });
});
