/**
 * Alert preferences — optimistic concurrency (#1903).
 *
 * Uses the real in-memory preference store and audit trail; only Prisma-free
 * paths are exercised, and the router is mounted on its own.
 */
import express from "express";
import request from "supertest";
import alertsRouter, { readExpectedVersion } from "../routes/alerts";
import * as auditService from "../services/alertPreferenceAuditService";
import {
  PreferenceVersionConflictError,
  clearAlertOperationStore,
  getAlertPreferences,
  getAlertPreferencesVersion,
  resetAlertPreferencesStore,
  revertAlertPreferences,
  setAlertPreferences,
  updateAlertPreferences,
} from "../services/alertsService";
import type { AlertPreferences } from "../services/alertsPreferenceRules";

const WALLET = "GCONCURRENCY";
const VAULT = "Blend";

const prefs = (cooldownMinutes: number): AlertPreferences => ({
  channel: "email",
  cooldownMinutes,
  severityThreshold: 10,
  quietHoursStart: 23,
  quietHoursEnd: 6,
});

beforeEach(() => {
  resetAlertPreferencesStore();
  clearAlertOperationStore();
  auditService.resetAuditStore();
  jest.restoreAllMocks();
});

describe("alertsService versioning", () => {
  it("starts at version 0 and increments once per committed write", () => {
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(0);
    expect(setAlertPreferences(WALLET, VAULT, prefs(10)).version).toBe(1);
    expect(updateAlertPreferences(WALLET, VAULT, prefs(20), { expectedVersion: 1 }).version).toBe(2);
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(2);
    // Keys are case-insensitive, as the store is.
    expect(getAlertPreferencesVersion(WALLET.toLowerCase(), VAULT.toUpperCase())).toBe(2);
  });

  it("lets only the first of two writers holding the same version commit", () => {
    setAlertPreferences(WALLET, VAULT, prefs(10));
    const seen = getAlertPreferencesVersion(WALLET, VAULT);

    updateAlertPreferences(WALLET, VAULT, prefs(30), { expectedVersion: seen });
    let caught: unknown;
    try {
      updateAlertPreferences(WALLET, VAULT, prefs(45), { expectedVersion: seen });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PreferenceVersionConflictError);
    const conflict = caught as PreferenceVersionConflictError;
    expect(conflict.code).toBe("PREFERENCE_VERSION_CONFLICT");
    expect(conflict.currentVersion).toBe(2);
    expect(conflict.currentPreferences).toEqual(prefs(30));
    // The loser changed nothing and recorded no audit entry.
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(30));
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(2);
    expect(auditService.getAuditEntryCount(WALLET, VAULT)).toBe(1);
  });

  it("treats expectedVersion 0 as create-only", () => {
    expect(setAlertPreferences(WALLET, VAULT, prefs(5), undefined, 0).version).toBe(1);
    expect(() => setAlertPreferences(WALLET, VAULT, prefs(6), undefined, 0)).toThrow(
      PreferenceVersionConflictError,
    );
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(5));
  });

  it("restores the previous preferences and version when the audit write fails", () => {
    setAlertPreferences(WALLET, VAULT, prefs(10));
    jest.spyOn(auditService, "recordPreferenceChange").mockImplementationOnce(() => {
      throw new Error("audit store unavailable");
    });

    expect(() =>
      updateAlertPreferences(WALLET, VAULT, prefs(99), { expectedVersion: 1 }),
    ).toThrow("audit store unavailable");
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(10));
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(1);

    // Safe retry with the same version succeeds once the audit store is back.
    expect(updateAlertPreferences(WALLET, VAULT, prefs(99), { expectedVersion: 1 }).version).toBe(2);
  });

  it("removes a first-ever write entirely when its audit write fails", () => {
    jest.spyOn(auditService, "recordPreferenceChange").mockImplementationOnce(() => {
      throw new Error("audit store unavailable");
    });
    expect(() => updateAlertPreferences(WALLET, VAULT, prefs(1))).toThrow();
    expect(getAlertPreferences(WALLET, VAULT)).toBeUndefined();
    expect(getAlertPreferencesVersion(WALLET, VAULT)).toBe(0);
  });

  it("replays an already-committed operation even after its version moved on", () => {
    const first = setAlertPreferences(WALLET, VAULT, prefs(10), "op-1", 0);
    updateAlertPreferences(WALLET, VAULT, prefs(20));
    const replay = setAlertPreferences(WALLET, VAULT, prefs(10), "op-1", 0);
    expect(replay).toEqual({ preferences: prefs(10), replayed: true, version: first.version });
    // The replay wrote nothing.
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(20));
  });

  it("does not consume the operation identity when the version check fails", () => {
    setAlertPreferences(WALLET, VAULT, prefs(10));
    expect(() => setAlertPreferences(WALLET, VAULT, prefs(15), "op-stale", 0)).toThrow(
      PreferenceVersionConflictError,
    );
    // Retried with the reloaded version under the same identity: it commits.
    expect(setAlertPreferences(WALLET, VAULT, prefs(15), "op-stale", 1)).toEqual({
      preferences: prefs(15),
      replayed: false,
      version: 2,
    });
  });

  it("checks the version before a revert reads the audit trail", () => {
    updateAlertPreferences(WALLET, VAULT, prefs(10));
    updateAlertPreferences(WALLET, VAULT, prefs(20));
    const lookup = jest.spyOn(auditService, "findRevertTarget");
    expect(() => revertAlertPreferences(WALLET, VAULT, undefined, 1)).toThrow(
      PreferenceVersionConflictError,
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(20));
    expect(revertAlertPreferences(WALLET, VAULT, undefined, 2).version).toBe(3);
  });
});

describe("routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/alerts", alertsRouter);

  it("returns the version on read and accepts it back as If-Match", async () => {
    setAlertPreferences(WALLET, VAULT, prefs(10));

    const read = await request(app).get(`/api/alerts/${WALLET}/preferences/${VAULT}`);
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe('"1"');
    expect(read.body.version).toBe(1);

    const write = await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("If-Match", read.headers.etag)
      .send(prefs(30));
    expect(write.status).toBe(200);
    expect(write.body.version).toBe(2);
    expect(write.headers["x-preferences-version"]).toBe("2");
  });

  it("answers the stale writer 409 with the current record, leaving it unchanged", async () => {
    setAlertPreferences(WALLET, VAULT, prefs(10));
    const [a, b] = await Promise.all([
      request(app).put(`/api/alerts/${WALLET}/preferences/${VAULT}`).set("If-Match", '"1"').send(prefs(30)),
      request(app).put(`/api/alerts/${WALLET}/preferences/${VAULT}`).set("If-Match", '"1"').send(prefs(45)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.body.code).toBe("PREFERENCE_VERSION_CONFLICT");
    expect(loser.body.currentVersion).toBe(2);
    expect(loser.body.preferences).toEqual(winner.body.preferences);
    expect(loser.headers.etag).toBe('"2"');
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(winner.body.preferences);
  });

  it("accepts expectedVersion in the body on PUT /preferences", async () => {
    const created = await request(app)
      .put("/api/alerts/preferences")
      .send({ walletAddress: WALLET, vaultId: VAULT, preferences: prefs(10), expectedVersion: 0 });
    expect(created.status).toBe(200);
    expect(created.headers.etag).toBe('"1"');

    const stale = await request(app)
      .put("/api/alerts/preferences")
      .send({ walletAddress: WALLET, vaultId: VAULT, preferences: prefs(20), expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(getAlertPreferences(WALLET, VAULT)).toEqual(prefs(10));
  });

  it("rejects a malformed If-Match with 400 and writes nothing", async () => {
    const res = await request(app)
      .put(`/api/alerts/${WALLET}/preferences/${VAULT}`)
      .set("If-Match", '"abc"')
      .send(prefs(10));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_EXPECTED_VERSION");
    expect(getAlertPreferences(WALLET, VAULT)).toBeUndefined();
  });

  it("keeps unconditional writes working when no version is sent", async () => {
    setAlertPreferences(WALLET, VAULT, prefs(10));
    const res = await request(app).put(`/api/alerts/${WALLET}/preferences/${VAULT}`).send(prefs(20));
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
  });
});

describe("readExpectedVersion", () => {
  const req = (headers: Record<string, string>, body: unknown = {}) =>
    ({ headers, body }) as unknown as Parameters<typeof readExpectedVersion>[0];

  it("reads strong, weak and bare If-Match values, then the body", () => {
    expect(readExpectedVersion(req({ "if-match": '"3"' }))).toBe(3);
    expect(readExpectedVersion(req({ "if-match": 'W/"4"' }))).toBe(4);
    expect(readExpectedVersion(req({ "if-match": "5" }))).toBe(5);
    expect(readExpectedVersion(req({}, { expectedVersion: 0 }))).toBe(0);
    expect(readExpectedVersion(req({}))).toBeUndefined();
  });

  it("rejects negative, fractional and non-numeric versions", () => {
    for (const bad of ['"-1"', '"1.5"', '"x"', '""']) {
      expect(() => readExpectedVersion(req({ "if-match": bad }))).toThrow();
    }
    expect(() => readExpectedVersion(req({}, { expectedVersion: "" }))).toThrow();
  });
});
