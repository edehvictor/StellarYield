import { describe, expect, it } from "vitest";
import { parseSmokeHistory, parseSmokeRunResult } from "./smokeResults";

describe("parseSmokeRunResult", () => {
  it("parses valid JSON smoke output", () => {
    const raw = JSON.stringify({
      timestamp: "2026-05-26T12:00:00Z",
      frontendUrl: "https://app.example",
      backendUrl: "https://api.example",
      status: "pass",
      checks: [{ label: "Backend /api/health", url: "x", status: "pass", httpCode: 200 }],
    });
    const parsed = parseSmokeRunResult(raw);
    expect(parsed?.status).toBe("pass");
    expect(parsed?.checks).toHaveLength(1);
  });

  it("returns null for invalid shape", () => {
    expect(parseSmokeRunResult('{"status":"pass"}')).toBeNull();
  });

  it("rejects malformed external check entries and invalid timestamps (#1913)", () => {
    expect(parseSmokeRunResult("null")).toBeNull();
    expect(parseSmokeRunResult("[]")).toBeNull();
    expect(
      parseSmokeRunResult(
        JSON.stringify({
          timestamp: "not-a-timestamp",
          frontendUrl: "https://app.example",
          backendUrl: "https://api.example",
          status: "pass",
          checks: [],
        }),
      ),
    ).toBeNull();
    expect(
      parseSmokeRunResult(
        JSON.stringify({
          timestamp: "2026-05-26T12:00:00Z",
          frontendUrl: "https://app.example",
          backendUrl: "https://api.example",
          status: "pass",
          checks: [{ label: "", url: "/health", status: "pass", httpCode: 200 }],
        }),
      ),
    ).toBeNull();
    expect(
      parseSmokeRunResult(
        JSON.stringify({
          timestamp: "2026-05-26T12:00:00Z",
          frontendUrl: "https://app.example",
          backendUrl: "https://api.example",
          status: "pass",
          checks: [{ label: "Health", url: "/health", status: "unknown", httpCode: 200 }],
        }),
      ),
    ).toBeNull();
  });

  it("parseSmokeHistory filters out malformed history entries and preserves valid runs (#1913)", () => {
    const validEntry = JSON.stringify({
      timestamp: "2026-05-26T12:00:00Z",
      frontendUrl: "https://app.example",
      backendUrl: "https://api.example",
      status: "pass",
      checks: [{ label: "Health", url: "/health", status: "pass", httpCode: 200 }],
    });
    const historyRaw = JSON.stringify([validEntry, '{"status":"broken"}', null, 42]);
    const history = parseSmokeHistory(historyRaw);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("pass");
    expect(parseSmokeHistory("{\"not\":\"an-array\"}")).toEqual([]);
    expect(parseSmokeHistory("not-json")).toEqual([]);
  });
});
