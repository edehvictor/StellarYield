import request from "supertest";
import express from "express";
import eventArchiveRoutes from "../routes/eventArchiveRoutes";
import { eventArchiveService } from "../services/eventArchiveService";

const app = express();
app.use(express.json());
app.use("/api/audit-archive", eventArchiveRoutes);

describe("GET /api/audit-archive/events", () => {
  it("returns a 200 with an empty result for an archive that has nothing", async () => {
    const res = await request(app).get("/api/audit-archive/events").query({ source: "NOTHING_EVER_ARCHIVED" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.records).toEqual([]);
    expect(res.body.data.totalCount).toBe(0);
  });

  it("returns an archived event by source, event type, and time bucket", async () => {
    await eventArchiveService.archiveEvents([
      {
        id: "route_evt_1",
        contractId: "ROUTE_CONTRACT",
        topic: "Transfer",
        data: "data",
        txHash: "hash",
        ledger: 1,
        createdAt: new Date("2024-05-01"),
      },
    ]);

    const res = await request(app).get("/api/audit-archive/events").query({
      source: "ROUTE_CONTRACT",
      eventType: "Transfer",
      timeBucket: "2024-05",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.totalCount).toBe(1);
    expect(res.body.data.records[0].id).toBe("route_evt_1");
  });

  it("returns results across mixed sources when no source filter is given", async () => {
    await eventArchiveService.archiveEvents([
      { id: "mix_evt_a", contractId: "MIX_A", topic: "Swap", data: "d", txHash: "h", ledger: 1, createdAt: new Date("2024-06-01") },
    ]);
    await eventArchiveService.archiveEvents([
      { id: "mix_evt_b", contractId: "MIX_B", topic: "Swap", data: "d", txHash: "h", ledger: 1, createdAt: new Date("2024-06-01") },
    ]);

    const res = await request(app).get("/api/audit-archive/events").query({ timeBucket: "2024-06" });

    expect(res.status).toBe(200);
    const ids = res.body.data.records.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["mix_evt_a", "mix_evt_b"]));
  });

  it("looks up a single event by exact id", async () => {
    await eventArchiveService.archiveEvents([
      { id: "route_evt_solo", contractId: "SOLO", topic: "Mint", data: "d", txHash: "h", ledger: 1, createdAt: new Date("2024-07-01") },
    ]);

    const res = await request(app).get("/api/audit-archive/events").query({ id: "route_evt_solo" });

    expect(res.status).toBe(200);
    expect(res.body.data.totalCount).toBe(1);
    expect(res.body.data.records[0].id).toBe("route_evt_solo");
  });

  it("ignores unrecognized query parameter types without erroring", async () => {
    const res = await request(app).get("/api/audit-archive/events").query({ source: ["a", "b"] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns the response shape expected by replay tooling", async () => {
    const res = await request(app).get("/api/audit-archive/events");

    expect(res.body).toHaveProperty("success");
    expect(res.body.data).toHaveProperty("records");
    expect(res.body.data).toHaveProperty("totalCount");
    expect(res.body.data).toHaveProperty("duplicateIds");
    expect(res.body.data).toHaveProperty("matchedArchiveIds");
    expect(res.body.data).toHaveProperty("queryTimeMs");
  });
});