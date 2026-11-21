import { describe, it, expect } from "vitest";
import {
  buildExecutionDiagnostics,
  buildProposalBuildDiagnostics,
  buildWalletSigningDiagnostics,
} from "./governanceDiagnostics";
import {
  areGovernanceDiagnosticsPrivacySafe,
  getGovernanceStageLabel,
} from "../../../../shared/types/governanceDiagnostic";

describe("governanceDiagnostics (#1901)", () => {
  it("names the proposal build stage and preserves existing state on failure", () => {
    const diagnostics = buildProposalBuildDiagnostics();

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "STAGE_UNAVAILABLE",
      "STATE_PRESERVED",
    ]);
    expect(diagnostics[0].stage).toBe("proposal-build");
    expect(diagnostics[0].retryable).toBe(true);
    expect(diagnostics[1].stage).toBe("state-persistence");
    expect(diagnostics[1].affectedStages).toEqual(["proposal-build"]);
    expect(areGovernanceDiagnosticsPrivacySafe(diagnostics)).toBe(true);
  });

  it("names wallet signing when the wallet rejects the signature", () => {
    const diagnostics = buildWalletSigningDiagnostics();

    expect(diagnostics[0].stage).toBe("wallet-signing");
    expect(diagnostics[0].retryable).toBe(true);
    expect(diagnostics[1].code).toBe("STATE_PRESERVED");
    expect(
      diagnostics.some((diagnostic) => diagnostic.remediation.length > 0),
    ).toBe(true);
  });

  it("treats a submission failure as safely retryable", () => {
    const diagnostics = buildExecutionDiagnostics("submitting");

    expect(diagnostics[0].stage).toBe("submission");
    expect(diagnostics[0].retryable).toBe(true);
  });

  it("marks a confirmation failure as unsafe to retry blindly", () => {
    const diagnostics = buildExecutionDiagnostics("polling");

    expect(diagnostics[0].code).toBe("RETRY_UNSAFE");
    expect(diagnostics[0].stage).toBe("confirmation");
    expect(diagnostics[0].retryable).toBe(false);
    expect(diagnostics[0].remediation).toMatch(/hash|status/i);
    expect(areGovernanceDiagnosticsPrivacySafe(diagnostics)).toBe(true);
  });

  it("labels every stage for display", () => {
    for (const diagnostics of [
      buildProposalBuildDiagnostics(),
      buildWalletSigningDiagnostics(),
      buildExecutionDiagnostics("polling"),
    ]) {
      for (const diagnostic of diagnostics) {
        expect(getGovernanceStageLabel(diagnostic.stage).length).toBeGreaterThan(0);
      }
    }
  });
});
