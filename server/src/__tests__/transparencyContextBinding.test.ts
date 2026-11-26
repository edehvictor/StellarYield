/**
 * Transparency status network, ledger and version binding (#1916).
 *
 * Mounts the transparency router on its own: the full app currently fails to
 * load in tests because the contract registry checksum does not match.
 */

import express from "express";
import request from "supertest";
import transparencyRouter, {
  estimateLedgerFromClock,
  resetTransparencyCache,
  resolveSnapshotContext,
  resolveTransparencyNetwork,
  setTransparencyDataSource,
} from "../routes/transparency";
import { failoverIncidentHistoryService } from "../services/failoverIncidentHistoryService";
import {
  MAINNET_PASSPHRASE,
  TESTNET_PASSPHRASE,
  TRANSPARENCY_SCHEMA_VERSION,
} from "../../../shared/types/transparencyContext";

const app = express();
app.use(express.json());
app.use("/api/transparency", transparencyRouter);

const NETWORK_KEYS = ["NETWORK_PASSPHRASE", "STELLAR_NETWORK_PASSPHRASE", "STELLAR_NETWORK"] as const;
const savedEnv: Record<string, string | undefined> = {};

function history(revenue: number) {
  return [
    { date: "2026-11-23", revenue, burned: 10 },
    { date: "2026-11-24", revenue, burned: 20 },
  ];
}

function source(payload: Record<string, unknown>) {
  return jest.fn(() => payload);
}

beforeEach(() => {
  for (const key of NETWORK_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetTransparencyCache();
  (failoverIncidentHistoryService as unknown as { reset?: () => void }).reset?.();
});

afterEach(() => {
  for (const key of NETWORK_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetTransparencyCache();
});

describe("resolveTransparencyNetwork", () => {
  it("defaults to testnet and reads passphrases or labels", () => {
    expect(resolveTransparencyNetwork({})).toBe("testnet");
    expect(resolveTransparencyNetwork({ NETWORK_PASSPHRASE: MAINNET_PASSPHRASE })).toBe("mainnet");
    expect(resolveTransparencyNetwork({ STELLAR_NETWORK: "futurenet" })).toBe("futurenet");
  });

  it("refuses an unknown configured network instead of guessing", () => {
    expect(() => resolveTransparencyNetwork({ STELLAR_NETWORK: "moonnet" })).toThrow(
      expect.objectContaining({ code: "INVALID_TRANSPARENCY_CONTEXT" }),
    );
  });
});

describe("resolveSnapshotContext", () => {
  it("uses the source's ledger, or a clock estimate when it reports none", () => {
    expect(resolveSnapshotContext({ ledger: 123 }, "testnet")).toEqual({
      network: "testnet",
      ledger: 123,
      version: TRANSPARENCY_SCHEMA_VERSION,
    });
    expect(resolveSnapshotContext({}, "testnet", 50_000).ledger).toBe(estimateLedgerFromClock(50_000));
  });

  it("rejects a source on another network and an invalid ledger", () => {
    expect(() => resolveSnapshotContext({ network: "mainnet" }, "testnet")).toThrow(
      expect.objectContaining({ code: "TRANSPARENCY_NETWORK_MISMATCH" }),
    );
    expect(() => resolveSnapshotContext({ ledger: -1 }, "testnet")).toThrow(
      expect.objectContaining({ code: "INVALID_TRANSPARENCY_CONTEXT" }),
    );
  });
});

describe("GET /api/transparency/summary context binding", () => {
  it("stamps the snapshot with network, ledger and version", async () => {
    setTransparencyDataSource(source({ history: history(100), ledger: 5000, network: TESTNET_PASSPHRASE }));

    const res = await request(app).get("/api/transparency/summary");

    expect(res.status).toBe(200);
    expect(res.body.context).toEqual({ network: "testnet", ledger: 5000, version: TRANSPARENCY_SCHEMA_VERSION });
    expect(res.body.totalRevenueLumens).toBe(200);
    expect(res.headers["x-stellar-network"]).toBe("testnet");
    expect(res.headers["x-ledger"]).toBe("5000");
    expect(res.headers["x-transparency-version"]).toBe(TRANSPARENCY_SCHEMA_VERSION);
  });

  it("serves a reader that expects the same network, version and an older ledger", async () => {
    setTransparencyDataSource(source({ history: history(100), ledger: 5000 }));
    const res = await request(app)
      .get("/api/transparency/summary")
      .query({ network: "testnet", version: TRANSPARENCY_SCHEMA_VERSION, minLedger: 4999 });
    expect(res.status).toBe(200);
  });

  it("rejects a reader on another network without serving the data", async () => {
    setTransparencyDataSource(source({ history: history(100), ledger: 5000 }));

    const res = await request(app).get("/api/transparency/summary").set("X-Stellar-Network", "mainnet");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "TRANSPARENCY_NETWORK_MISMATCH",
      retryable: false,
      context: { network: "testnet", ledger: 5000 },
    });
    expect(res.body.totalRevenueLumens).toBeUndefined();
  });

  it("rejects an incompatible schema version", async () => {
    setTransparencyDataSource(source({ history: history(100), ledger: 5000 }));
    const res = await request(app).get("/api/transparency/summary").query({ version: "99" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRANSPARENCY_VERSION_MISMATCH");
  });

  it("rejects malformed expectations with 400", async () => {
    for (const query of [{ network: "moonnet" }, { minLedger: "-3" }, { minLedger: "1.5" }, { minLedger: "abc" }]) {
      const res = await request(app).get("/api/transparency/summary").query(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_TRANSPARENCY_CONTEXT");
    }
  });

  it("re-reads the source when the reader has seen a newer ledger, then serves it", async () => {
    const reads = jest
      .fn()
      .mockReturnValueOnce({ history: history(100), ledger: 5000 })
      .mockReturnValueOnce({ history: history(150), ledger: 5010 });
    setTransparencyDataSource(reads);
    await request(app).get("/api/transparency/summary").expect(200);

    const res = await request(app).get("/api/transparency/summary").query({ minLedger: 5005 });

    expect(res.status).toBe(200);
    expect(res.body.context.ledger).toBe(5010);
    expect(res.body.totalRevenueLumens).toBe(300);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("answers a retryable 409 while the source is still behind the reader", async () => {
    setTransparencyDataSource(source({ history: history(100), ledger: 5000 }));
    const res = await request(app).get("/api/transparency/summary").set("X-Min-Ledger", "6000");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "TRANSPARENCY_LEDGER_BEHIND", retryable: true });
  });

  it("keeps the newer snapshot when the source answers from an older ledger", async () => {
    const reads = jest
      .fn()
      .mockReturnValueOnce({ history: history(100), ledger: 5000 })
      .mockReturnValueOnce({ history: history(1), ledger: 4000 });
    setTransparencyDataSource(reads);
    await request(app).get("/api/transparency/summary").expect(200);

    // Force a re-read by asking for a ledger the cache does not have yet.
    const res = await request(app).get("/api/transparency/summary").query({ minLedger: 5001 });

    expect(reads).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(409);
    expect(res.body.context.ledger).toBe(5000);

    const after = await request(app).get("/api/transparency/summary");
    expect(after.body.context.ledger).toBe(5000);
    expect(after.body.totalRevenueLumens).toBe(200);
  });

  it("does not cache or serve data from a source on another network", async () => {
    setTransparencyDataSource(source({ history: history(100), ledger: 5000 }));
    await request(app).get("/api/transparency/summary").expect(200);

    // The source is repointed at mainnet while the server stays on testnet.
    setTransparencyDataSource(source({ history: history(9), ledger: 9000, network: "mainnet" }));
    const res = await request(app).get("/api/transparency/summary").query({ minLedger: 5001 });

    // Falls back to the last good testnet snapshot, which is behind the reader.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRANSPARENCY_LEDGER_BEHIND");
    expect(res.body.context).toMatchObject({ network: "testnet", ledger: 5000 });
  });

  it("never serves a snapshot cached for another network after the server is repointed", async () => {
    setTransparencyDataSource(source({ history: history(100), ledger: 5000 }));
    await request(app).get("/api/transparency/summary").expect(200);

    process.env.STELLAR_NETWORK = "mainnet";
    setTransparencyDataSource(() => {
      throw new Error("mainnet source unavailable");
    });
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(app).get("/api/transparency/summary");

    expect(res.status).toBe(500);
    expect(res.body.totalRevenueLumens).toBeUndefined();
  });

  it("recovers on retry after a failed read without losing the last snapshot", async () => {
    const reads = jest
      .fn()
      .mockReturnValueOnce({ history: history(100), ledger: 5000 })
      .mockImplementationOnce(() => {
        throw new Error("rpc timeout");
      })
      .mockReturnValueOnce({ history: history(120), ledger: 5002 });
    setTransparencyDataSource(reads);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    await request(app).get("/api/transparency/summary").expect(200);

    const failed = await request(app).get("/api/transparency/summary").query({ minLedger: 5001 });
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ code: "TRANSPARENCY_LEDGER_BEHIND", retryable: true });

    const retried = await request(app).get("/api/transparency/summary").query({ minLedger: 5001 });
    expect(retried.status).toBe(200);
    expect(retried.body.context.ledger).toBe(5002);
  });
});

describe("failover history network binding", () => {
  const incident = { protocolId: "blend", protocolName: "Blend", reasons: ["stale"] };

  it("labels reads with the network and rejects readers on another network", async () => {
    const ok = await request(app).get("/api/transparency/failover-history");
    expect(ok.status).toBe(200);
    expect(ok.body.context).toEqual({ network: "testnet", version: TRANSPARENCY_SCHEMA_VERSION });

    const wrong = await request(app).get("/api/transparency/failover-history").query({ network: "mainnet" });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("TRANSPARENCY_NETWORK_MISMATCH");
  });

  it("refuses a write for another network and records nothing", async () => {
    const before = failoverIncidentHistoryService.getHistory("blend").length;

    const header = await request(app)
      .post("/api/transparency/failover-history")
      .set("X-Stellar-Network", "mainnet")
      .send(incident);
    expect(header.status).toBe(409);

    const body = await request(app)
      .post("/api/transparency/failover-history")
      .send({ ...incident, network: MAINNET_PASSPHRASE });
    expect(body.status).toBe(409);

    expect(failoverIncidentHistoryService.getHistory("blend")).toHaveLength(before);

    const resolve = await request(app)
      .post("/api/transparency/failover-history/blend/resolve")
      .set("X-Stellar-Network", "mainnet")
      .send({});
    expect(resolve.status).toBe(409);
  });

  it("accepts a write for the server's network", async () => {
    const res = await request(app)
      .post("/api/transparency/failover-history")
      .set("X-Stellar-Network", "testnet")
      .send(incident);
    expect(res.status).toBe(201);
    expect(res.headers["x-stellar-network"]).toBe("testnet");
  });
});
