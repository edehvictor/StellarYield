import { describe, expect, it } from "vitest";
import {
  YIELD_DIAGNOSTIC_CATALOG,
  YIELD_FAILURE_STAGES,
  buildYieldDiagnostic,
  isYieldDiagnosticCode,
  resolveYieldDiagnostic,
  sanitizeRequestId,
  type YieldDiagnosticCode,
} from "./yieldDiagnostics";

describe("yield diagnostic catalog", () => {
  it("has exactly one code per stage, and only `unknown` lacks remediation", () => {
    const stages = Object.values(YIELD_DIAGNOSTIC_CATALOG).map((e) => e.stage);
    expect([...stages].sort()).toEqual([...YIELD_FAILURE_STAGES].sort());
    for (const [code, entry] of Object.entries(YIELD_DIAGNOSTIC_CATALOG)) {
      if (entry.stage === "unknown") {
        expect(entry.remediation).toBeNull();
      } else {
        expect(entry.remediation, code).toEqual(expect.any(String));
      }
    }
  });

  it("contains no internal implementation details in user-facing copy", () => {
    const copy = JSON.stringify(YIELD_DIAGNOSTIC_CATALOG);
    expect(copy).not.toMatch(/stack|exception|undefined|null pointer|https?:\/\//i);
  });
});

describe("buildYieldDiagnostic", () => {
  it("builds a known-stage diagnostic", () => {
    expect(buildYieldDiagnostic("reliability_scoring", "req-1")).toEqual({
      code: "YIELD_RELIABILITY_UNAVAILABLE",
      stage: "reliability_scoring",
      stageKnown: true,
      summary: YIELD_DIAGNOSTIC_CATALOG.YIELD_RELIABILITY_UNAVAILABLE.summary,
      remediation: YIELD_DIAGNOSTIC_CATALOG.YIELD_RELIABILITY_UNAVAILABLE.remediation,
      retryable: true,
      requestId: "req-1",
    });
  });

  it.each([undefined, null, "", "db_query", 42, {}])(
    "falls back to the unknown stage for %p without inventing remediation",
    (stage) => {
      const d = buildYieldDiagnostic(stage);
      expect(d.stage).toBe("unknown");
      expect(d.stageKnown).toBe(false);
      expect(d.code).toBe("YIELD_STAGE_UNKNOWN");
      expect(d.remediation).toBeNull();
      expect(d).not.toHaveProperty("requestId");
    },
  );
});

describe("sanitizeRequestId", () => {
  it("accepts opaque ids and rejects anything else", () => {
    expect(sanitizeRequestId("3f1c2a9e-1b2c-4d5e-8f90-123456789abc")).toBeDefined();
    expect(sanitizeRequestId("<img src=x>")).toBeUndefined();
    expect(sanitizeRequestId("a".repeat(65))).toBeUndefined();
    expect(sanitizeRequestId("user@example.com")).toBeUndefined();
    expect(sanitizeRequestId(123)).toBeUndefined();
    expect(sanitizeRequestId(null)).toBeUndefined();
  });
});

describe("resolveYieldDiagnostic", () => {
  it("uses a complete server diagnostic", () => {
    const server = buildYieldDiagnostic("source_retrieval", "req-9");
    const d = resolveYieldDiagnostic({ error: "YIELD_FETCH_FAILED", diagnostic: server }, { httpStatus: 500 });
    expect(d).toEqual({
      ...server,
      title: YIELD_DIAGNOSTIC_CATALOG.YIELD_SOURCE_UNAVAILABLE.title,
      source: "server",
      httpStatus: 500,
    });
  });

  it("completes a partial diagnostic that only names the stage", () => {
    const d = resolveYieldDiagnostic({ diagnostic: { stage: "yield_enrichment" } });
    expect(d.code).toBe("YIELD_ENRICHMENT_FAILED");
    expect(d.stageKnown).toBe(true);
    expect(d.remediation).toBe(YIELD_DIAGNOSTIC_CATALOG.YIELD_ENRICHMENT_FAILED.remediation);
    expect(d.source).toBe("server");
  });

  it("prefers the code when code and stage disagree", () => {
    const d = resolveYieldDiagnostic({
      diagnostic: { code: "YIELD_INPUT_INVALID", stage: "network" },
    });
    expect(d.stage).toBe("input_validation");
    expect(d.retryable).toBe(false);
  });

  it.each([
    ["null body", null],
    ["undefined body", undefined],
    ["string body", "<html>502 Bad Gateway</html>"],
    ["array body", [1, 2]],
    ["legacy body without diagnostic", { error: "YIELD_FETCH_FAILED", message: "Unable" }],
    ["null diagnostic", { diagnostic: null }],
    ["diagnostic of the wrong type", { diagnostic: "source_retrieval" }],
    ["unknown code and stage", { diagnostic: { code: "NOPE", stage: "warp_core" } }],
    ["fields of the wrong type", { diagnostic: { code: 7, stage: ["x"], remediation: 1 } }],
  ])("falls back safely for a %s", (_label, body) => {
    const d = resolveYieldDiagnostic(body, { httpStatus: 503 });
    expect(d.code).toBe("YIELD_STAGE_UNKNOWN");
    expect(d.stage).toBe("unknown");
    expect(d.stageKnown).toBe(false);
    expect(d.remediation).toBeNull();
    expect(d.source).toBe("client");
    expect(d.httpStatus).toBe(503);
  });

  it("classifies transport failures and malformed success bodies", () => {
    expect(resolveYieldDiagnostic(null, { networkFailure: true }).code).toBe(
      "YIELD_NETWORK_UNREACHABLE",
    );
    expect(resolveYieldDiagnostic({ rows: [] }, { malformedSuccess: true, httpStatus: 200 }).stage).toBe(
      "response_parsing",
    );
  });

  it("never renders free text from the body", () => {
    const d = resolveYieldDiagnostic({
      diagnostic: {
        code: "YIELD_SOURCE_UNAVAILABLE",
        summary: "ECONNREFUSED 10.0.0.12:5432 password=hunter2",
        remediation: "Run `rm -rf /`",
        title: "pwned",
      },
    });
    const text = JSON.stringify(d);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("rm -rf");
    expect(text).not.toContain("pwned");
    expect(d.summary).toBe(YIELD_DIAGNOSTIC_CATALOG.YIELD_SOURCE_UNAVAILABLE.summary);
  });

  it("takes a safe request id from the diagnostic, the body or the headers", () => {
    expect(resolveYieldDiagnostic({ diagnostic: { requestId: "a-1" } }).requestId).toBe("a-1");
    expect(resolveYieldDiagnostic({ requestId: "b-2" }).requestId).toBe("b-2");
    expect(resolveYieldDiagnostic(null, { requestId: "c-3" }).requestId).toBe("c-3");
    expect(
      resolveYieldDiagnostic({ requestId: "<script>" }, { requestId: "d-4" }).requestId,
    ).toBe("d-4");
    expect(resolveYieldDiagnostic({ requestId: "<script>" }).requestId).toBeUndefined();
  });

  it("recognises every catalog code", () => {
    for (const code of Object.keys(YIELD_DIAGNOSTIC_CATALOG) as YieldDiagnosticCode[]) {
      expect(isYieldDiagnosticCode(code)).toBe(true);
      expect(resolveYieldDiagnostic({ diagnostic: { code } }).code).toBe(code);
    }
    expect(isYieldDiagnosticCode("toString")).toBe(false);
  });
});
