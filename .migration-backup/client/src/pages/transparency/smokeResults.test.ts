import { describe, expect, it } from "vitest";
import { parseSmokeRunResult } from "./smokeResults";

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
});
