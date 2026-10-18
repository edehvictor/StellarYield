import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import VaultMigrationReadinessPanel from "../components/VaultMigrationReadinessPanel";
import type { MigrationReadinessReport } from "../services/migrationReadinessService";

const baseReport: MigrationReadinessReport = {
  vaultSlug: "usdc",
  vaultName: "USDC Yield Vault",
  network: "testnet",
  overallStatus: "not_ready",
  statusCounts: { pass: 3, warn: 1, fail: 1, unknown: 1 },
  gates: [
    {
      id: "registry-entry",
      title: "Vault contract registered",
      description: "Contract address present in registry",
      targetArea: "contract",
      evidenceType: "CONTRACT_ADDRESS",
      reference: "contracts/registry.json#vault",
      guidance: "Deploy and register.",
      status: "pass",
      evidence: ["Registry address present"],
    },
    {
      id: "backend-health",
      title: "Backend healthy",
      description: "Backend readiness",
      targetArea: "server",
      evidenceType: "BACKEND_HEALTH",
      reference: "GET /api/health",
      guidance: "Resolve degraded signals.",
      status: "fail",
      evidence: ["Backend yields feed is not healthy"],
    },
    {
      id: "yield-availability",
      title: "Yield feed live",
      description: "Yields entry present",
      targetArea: "server",
      evidenceType: "YIELD_STATS",
      reference: "GET /api/yields",
      guidance: "Index the pair.",
      status: "unknown",
      evidence: ["Yields feed did not return data"],
    },
  ],
};

describe("VaultMigrationReadinessPanel", () => {
  it("renders the report state with overall badge and gate list", async () => {
    render(<VaultMigrationReadinessPanel vaultSlug="usdc" report={baseReport} />);

    expect(screen.getByText("Vault Migration Readiness")).toBeTruthy();
    expect(screen.getByText("Not Ready")).toBeTruthy();

    expect(screen.getByTestId("migration-gate-registry-entry")).toBeTruthy();
    expect(screen.getByTestId("migration-gate-backend-health")).toBeTruthy();
    expect(screen.getByTestId("gate-count-fail").textContent).toContain("1");
    expect(screen.getByText("Registry address present")).toBeTruthy();
  });

  it("shows an empty state when no gates are configured", async () => {
    const empty = {
      ...baseReport,
      overallStatus: "unknown" as const,
      statusCounts: { pass: 0, warn: 0, fail: 0, unknown: 0 },
      gates: [],
    };
    render(<VaultMigrationReadinessPanel vaultSlug="usdc" report={empty} />);
    expect(
      screen.getByText("No migration readiness gates are configured."),
    ).toBeTruthy();
  });

  it("shows a success state when every gate passes", () => {
    const ready: MigrationReadinessReport = {
      ...baseReport,
      overallStatus: "ready",
      statusCounts: { pass: 3, warn: 0, fail: 0, unknown: 0 },
      gates: baseReport.gates.map((g) => ({ ...g, status: "pass" as const })),
    };
    render(<VaultMigrationReadinessPanel vaultSlug="usdc" report={ready} />);
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByTestId("migration-gate-backend-health")).toBeTruthy();
  });
});