import express, { Request, Response } from "express";
import request from "supertest";
import {
  requireTimestamp,
  parseTimestampHeader,
  TIMESTAMP_HEADER,
  DEFAULT_ALLOWED_SKEW_MS,
} from "../middleware/timestampValidation";

// ── parseTimestampHeader ───────────────────────────────────────────────────

describe("parseTimestampHeader", () => {
  it("parses a valid ISO-8601 string", () => {
    const ms = parseTimestampHeader("2024-05-01T12:00:00.000Z");
    expect(ms).toBe(Date.parse("2024-05-01T12:00:00.000Z"));
  });

  it("parses Unix epoch seconds (10 digits)", () => {
    const ms = parseTimestampHeader("1714557600");
    expect(ms).toBe(1_714_557_600_000);
  });

  it("parses Unix epoch milliseconds (13 digits)", () => {
    const ms = parseTimestampHeader("1714557600000");
    expect(ms).toBe(1_714_557_600_000);
  });

  it("returns null for a non-numeric, non-ISO string", () => {
    expect(parseTimestampHeader("not-a-date")).toBeNull();
  });

  it("returns null for zero or negative numeric strings", () => {
    expect(parseTimestampHeader("0")).toBeNull();
    expect(parseTimestampHeader("-100")).toBeNull();
  });
});

// ── requireTimestamp middleware (via supertest) ────────────────────────────

const NOW_MS = 1_714_557_600_000; // fixed reference time for all tests

/** Build a minimal Express app that uses the middleware before a simple 200 handler. */
function buildApp(skewMs = DEFAULT_ALLOWED_SKEW_MS) {
  const app = express();
  app.get(
    "/protected",
    requireTimestamp({ allowedSkewMs: skewMs, now: () => NOW_MS }),
    (_req: Request, res: Response) => {
      res.json({ ok: true });
    },
  );
  return app;
}

describe("requireTimestamp — missing header", () => {
  it("rejects with 400 and TIMESTAMP_MISSING when header is absent", async () => {
    const res = await request(buildApp()).get("/protected");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TIMESTAMP_MISSING");
  });

  it("rejects when the header is an empty string", async () => {
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, "");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TIMESTAMP_MISSING");
  });
});

describe("requireTimestamp — invalid timestamp", () => {
  it("rejects with TIMESTAMP_INVALID for a non-parseable value", async () => {
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, "banana");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TIMESTAMP_INVALID");
  });
});

describe("requireTimestamp — expired timestamp", () => {
  it("rejects with TIMESTAMP_EXPIRED when the timestamp is too old", async () => {
    const expiredMs = NOW_MS - DEFAULT_ALLOWED_SKEW_MS - 1_000;
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, new Date(expiredMs).toISOString());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TIMESTAMP_EXPIRED");
    expect(res.body.retryCategory).toBe("retry");
  });

  it("rejects a Unix epoch seconds timestamp that is expired", async () => {
    const expiredSec = Math.floor(
      (NOW_MS - DEFAULT_ALLOWED_SKEW_MS - 1_000) / 1000,
    );
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, String(expiredSec));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TIMESTAMP_EXPIRED");
  });
});

describe("requireTimestamp — future timestamp", () => {
  it("rejects with TIMESTAMP_FUTURE when the timestamp is too far ahead", async () => {
    const futureMs = NOW_MS + DEFAULT_ALLOWED_SKEW_MS + 1_000;
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, new Date(futureMs).toISOString());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TIMESTAMP_FUTURE");
    expect(res.body.retryCategory).toBe("blocking");
  });
});

describe("requireTimestamp — valid timestamps", () => {
  it("passes through with 200 for a timestamp at exactly now", async () => {
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, new Date(NOW_MS).toISOString());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("passes through for a timestamp at the edge of the past window", async () => {
    const edgeMs = NOW_MS - DEFAULT_ALLOWED_SKEW_MS;
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, new Date(edgeMs).toISOString());
    expect(res.status).toBe(200);
  });

  it("passes through for a timestamp at the edge of the future window", async () => {
    const edgeMs = NOW_MS + DEFAULT_ALLOWED_SKEW_MS;
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, new Date(edgeMs).toISOString());
    expect(res.status).toBe(200);
  });

  it("passes through for Unix epoch milliseconds within the window", async () => {
    const res = await request(buildApp())
      .get("/protected")
      .set(TIMESTAMP_HEADER, String(NOW_MS - 10_000));
    expect(res.status).toBe(200);
  });
});

describe("requireTimestamp — custom skew", () => {
  it("rejects with a tighter 10-second window when configured", async () => {
    const tenSeconds = 10_000;
    const expiredMs = NOW_MS - tenSeconds - 1_000;
    const res = await request(buildApp(tenSeconds))
      .get("/protected")
      .set(TIMESTAMP_HEADER, new Date(expiredMs).toISOString());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TIMESTAMP_EXPIRED");
  });

  it("accepts a timestamp within the custom window", async () => {
    const tenSeconds = 10_000;
    const withinWindowMs = NOW_MS - 5_000;
    const res = await request(buildApp(tenSeconds))
      .get("/protected")
      .set(TIMESTAMP_HEADER, new Date(withinWindowMs).toISOString());
    expect(res.status).toBe(200);
  });
});
