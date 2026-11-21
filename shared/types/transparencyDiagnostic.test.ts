import { describe, it, expect } from "vitest";
import {
  areDiagnosticsPrivacySafe,
  buildTransparencyDiagnostic,
  getTransparencyStageLabel,
  isPrivacySafeDiagnosticText,
  redactDiagnosticText,
} from "./transparencyDiagnostic";

describe("redactDiagnosticText", () => {
  it("removes URLs, emails, Stellar addresses, hashes, and paths", () => {
    const raw =
      "fetch failed for https://horizon.example.com/path from GDXCN5BQ4RJXFTDMCTP3H7J6P5PT7PNZ4VP5G7F5VZ6B7K4Q7ZQ7ZQ7Z calling /home/runner/app/server/src/routes/transparency.ts";
    const redacted = redactDiagnosticText(raw);

    expect(redacted).not.toMatch(/https?:\/\//);
    expect(redacted).not.toMatch(/\/home\//);
    expect(isPrivacySafeDiagnosticText(redacted)).toBe(true);
  });

  it("strips stack frames and collapses whitespace", () => {
    const redacted = redactDiagnosticText("aggregation failed\n    at aggregate (/srv/app/x.ts:1:1)");
    expect(redacted).toBe("aggregation failed");
  });

  it("falls back when nothing safe remains", () => {
    expect(redactDiagnosticText("https://internal.example.com")).toBe("[redacted-url]");
    expect(redactDiagnosticText("", "fallback")).toBe("fallback");
  });
});

describe("buildTransparencyDiagnostic", () => {
  it("produces a privacy-safe diagnostic with stage and remediation", () => {
    const diagnostic = buildTransparencyDiagnostic("AGGREGATION_FAILED", {
      stage: "aggregation",
    });

    expect(diagnostic.code).toBe("AGGREGATION_FAILED");
    expect(diagnostic.stage).toBe("aggregation");
    expect(diagnostic.severity).toBe("critical");
    expect(diagnostic.retryable).toBe(true);
    expect(diagnostic.privacySafe).toBe(true);
    expect(diagnostic.remediation.length).toBeGreaterThan(0);
    expect(areDiagnosticsPrivacySafe([diagnostic])).toBe(true);
  });

  it("does not leak raw detail into the summary and dedupes affected stages", () => {
    const diagnostic = buildTransparencyDiagnostic("SUBSYSTEM_UNAVAILABLE", {
      stage: "indexer",
      severity: "warning",
      affectedStages: ["indexer", "indexer", "relayer"],
    });

    expect(diagnostic.summary).not.toMatch(/secret|token/i);
    expect(diagnostic.affectedStages).toEqual(["indexer", "relayer"]);
    expect(areDiagnosticsPrivacySafe([diagnostic])).toBe(true);
  });

  it("always marks diagnostics privacy-safe", () => {
    const codes = [
      "CONTEXT_INSUFFICIENT",
      "SUBSYSTEM_UNAVAILABLE",
      "STALE_LAST_KNOWN",
      "AGGREGATION_FAILED",
      "NO_DATA_AVAILABLE",
    ] as const;

    for (const code of codes) {
      const diagnostic = buildTransparencyDiagnostic(code, { stage: "cache" });
      expect(diagnostic.privacySafe).toBe(true);
      expect(isPrivacySafeDiagnosticText(diagnostic.remediation)).toBe(true);
    }
  });
});

describe("stage labels", () => {
  it("labels every known stage", () => {
    expect(getTransparencyStageLabel("indexer")).toBe("Indexer");
    expect(getTransparencyStageLabel("aggregation")).toBe("Metric aggregation");
    expect(getTransparencyStageLabel("context-validation")).toBe("Diagnostic context");
  });
});
