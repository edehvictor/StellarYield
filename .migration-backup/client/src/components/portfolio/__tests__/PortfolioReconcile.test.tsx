import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PortfolioReconcile from "../PortfolioReconcile";
import type { ReconcileRow } from "../PortfolioReconcile";

const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

function makeRow(overrides: Partial<ReconcileRow> = {}): ReconcileRow {
  return {
    asset: "USDC",
    vault: "Blend",
    expected: 10_000,
    observed: 10_000,
    delta: 0,
    severity: "ok",
    anomalyType: "matched",
    status: "confirmed",
    evidence: {
      ledger: 12345,
      txHash: "abc123def456",
      vault: "Blend",
      anomalyId: "anomaly-001",
      projectionVersion: "v1.0",
      sourceEventId: "evt-001",
      isStaleCheckpoint: false,
    },
    ...overrides,
  };
}

function expandGroup(vaultName: string) {
  const btn = screen.getByText(vaultName).closest("button")!;
  fireEvent.click(btn);
}

describe("PortfolioReconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("empty state", () => {
    it("renders empty message when no rows", () => {
      render(<PortfolioReconcile rows={[]} />);
      expect(screen.getByText("No reconciliation data")).toBeTruthy();
    });
  });

  describe("healthy state", () => {
    it("renders all rows with ok severity", () => {
      const rows = [
        makeRow({ asset: "USDC", severity: "ok" }),
        makeRow({ asset: "XLM", severity: "ok", vault: "Soroswap" }),
      ];
      render(<PortfolioReconcile rows={rows} />);
      expandGroup("Blend");
      expandGroup("Soroswap");
      expect(screen.getByText("USDC")).toBeTruthy();
      expect(screen.getByText("XLM")).toBeTruthy();
      expect(screen.getByText("Blend")).toBeTruthy();
      expect(screen.getByText("Soroswap")).toBeTruthy();
    });

    it("shows match count in filter", () => {
      const rows = [makeRow({ severity: "ok" })];
      render(<PortfolioReconcile rows={rows} />);
      expect(screen.getByText("1 of 1 items")).toBeTruthy();
    });
  });

  describe("warning state", () => {
    it("renders rows with warning severity", () => {
      const rows = [
        makeRow({ asset: "USDC", severity: "warning", anomalyType: "stale" }),
      ];
      render(<PortfolioReconcile rows={rows} />);
      expandGroup("Blend");
      const warningCells = screen.getAllByText("Warning");
      expect(warningCells.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Stale")).toBeTruthy();
    });
  });

  describe("critical state", () => {
    it("renders rows with critical severity and alert icon", () => {
      const rows = [
        makeRow({ asset: "ETH", severity: "critical", anomalyType: "missing" }),
      ];
      render(<PortfolioReconcile rows={rows} />);
      expandGroup("Blend");
      const criticalCells = screen.getAllByText("Critical");
      expect(criticalCells.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Missing")).toBeTruthy();
    });
  });

  describe("grouping", () => {
    it("groups rows by vault", () => {
      const rows = [
        makeRow({ asset: "USDC", vault: "Blend" }),
        makeRow({ asset: "XLM", vault: "Soroswap" }),
        makeRow({ asset: "USDT", vault: "Blend" }),
      ];
      render(<PortfolioReconcile rows={rows} />);
      expect(screen.getByText("Blend")).toBeTruthy();
      expect(screen.getByText("Soroswap")).toBeTruthy();
      expect(screen.getByText("2 items")).toBeTruthy();
      expect(screen.getByText("1 items")).toBeTruthy();
    });

    it("expands and collapses vault groups", () => {
      const rows = [makeRow({ asset: "USDC", vault: "Blend" })];
      render(<PortfolioReconcile rows={rows} />);

      expandGroup("Blend");
      expect(screen.getByText("USDC")).toBeTruthy();

      expandGroup("Blend");
      expect(screen.queryByText("USDC")).toBeNull();
    });
  });

  describe("filters", () => {
    it("filters by severity", () => {
      const rows = [
        makeRow({ asset: "USDC", severity: "ok" }),
        makeRow({ asset: "ETH", severity: "critical", vault: "Other" }),
      ];
      render(<PortfolioReconcile rows={rows} />);

      const severitySelect = screen.getByLabelText("Filter by severity");
      fireEvent.change(severitySelect, { target: { value: "critical" } });

      expandGroup("Other");
      expect(screen.getByText("ETH")).toBeTruthy();
      expect(screen.queryByText("USDC")).toBeNull();
    });

    it("filters by status", () => {
      const rows = [
        makeRow({ asset: "USDC", status: "confirmed" }),
        makeRow({ asset: "ETH", status: "pending", vault: "Other" }),
      ];
      render(<PortfolioReconcile rows={rows} />);

      const statusSelect = screen.getByLabelText("Filter by status");
      fireEvent.change(statusSelect, { target: { value: "pending" } });

      expandGroup("Other");
      expect(screen.getByText("ETH")).toBeTruthy();
      expect(screen.queryByText("USDC")).toBeNull();
    });

    it("filters stale checkpoints only", () => {
      const rows = [
        makeRow({ asset: "USDC", evidence: { isStaleCheckpoint: false } }),
        makeRow({ asset: "ETH", vault: "Other", evidence: { isStaleCheckpoint: true } }),
      ];
      render(<PortfolioReconcile rows={rows} />);

      const staleCheckbox = screen.getByLabelText("Stale checkpoints only");
      fireEvent.click(staleCheckbox);

      expandGroup("Other");
      expect(screen.getByText("ETH")).toBeTruthy();
      expect(screen.queryByText("USDC")).toBeNull();
    });
  });

  describe("copy evidence", () => {
    it("copies evidence to clipboard on button click", async () => {
      const row = makeRow({ asset: "USDC" });
      render(<PortfolioReconcile rows={[row]} />);

      expandGroup("Blend");
      const copyBtn = screen.getByLabelText(/Copy reconciliation evidence/i);
      fireEvent.click(copyBtn);

      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining("Asset: USDC"),
      );
    });
  });

  describe("evidence display", () => {
    it("shows ledger and tx hash in evidence", () => {
      const row = makeRow({
        evidence: { ledger: 12345, txHash: "abc123def456" },
      });
      render(<PortfolioReconcile rows={[row]} />);
      expandGroup("Blend");
      expect(screen.getByText("L12345")).toBeTruthy();
      expect(screen.getByText(/abc123d/)).toBeTruthy();
    });

    it("shows stale badge when checkpoint is stale", () => {
      const row = makeRow({
        evidence: { isStaleCheckpoint: true },
      });
      render(<PortfolioReconcile rows={[row]} />);
      expandGroup("Blend");
      expect(screen.getByText("stale")).toBeTruthy();
    });
  });
});
