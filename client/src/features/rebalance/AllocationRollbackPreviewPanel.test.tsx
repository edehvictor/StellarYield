/**
 * Tests for the allocation rollback preview panel (#1360).
 * Covers loading, empty, failure, and success render states.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AllocationRollbackPreviewPanel from "./AllocationRollbackPreviewPanel";
import {
  AllocationRollbackPreviewService,
  AllocationRollbackPreviewServiceError,
} from "../../services/allocationRollbackPreviewService";
import type { AllocationRollbackPreview } from "../../../../shared/types/allocationRollback";

vi.mock("../../services/allocationRollbackPreviewService", () => ({
  AllocationRollbackPreviewService: {
    fetchPendingPreview: vi.fn(),
  },
  AllocationRollbackPreviewServiceError: class extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.name = "AllocationRollbackPreviewServiceError";
      this.code = code;
      this.status = status;
    }
  },
}));

import * as serviceModule from "../../services/allocationRollbackPreviewService";

const ServiceError = serviceModule.AllocationRollbackPreviewServiceError;
const fetchPendingPreview = AllocationRollbackPreviewService
  .fetchPendingPreview as ReturnType<typeof vi.fn>;

const previewFixture: AllocationRollbackPreview = {
  vaultId: "vault-1",
  source: "pending-rebalance",
  currentAllocations: { Blend: 60, Soroswap: 40 },
  rollbackAllocations: { Blend: 40, Soroswap: 60 },
  changes: [
    { vaultId: "Blend", currentWeight: 60, rollbackWeight: 40, deltaWeight: -20 },
    { vaultId: "Soroswap", currentWeight: 40, rollbackWeight: 60, deltaWeight: 20 },
  ],
  totalDeltaWeight: 0,
  noOp: false,
  conflictingQueueEntryIds: [],
  safe: true,
  inputHash: "b".repeat(64),
};

describe("AllocationRollbackPreviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the idle state before any preview is requested", () => {
    render(<AllocationRollbackPreviewPanel vaultId="vault-1" />);
    expect(screen.getByTestId("allocation-rollback-preview-panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview rollback" })).toBeEnabled();
    expect(screen.queryByTestId("allocation-rollback-result")).not.toBeInTheDocument();
  });

  it("shows the loading state while a preview request is in flight", () => {
    fetchPendingPreview.mockImplementation(
      () => new Promise(() => undefined),
    );

    render(<AllocationRollbackPreviewPanel vaultId="vault-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview rollback" }));

    expect(screen.getByTestId("allocation-rollback-loading")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });

  it("renders the diff rows on success", async () => {
    fetchPendingPreview.mockResolvedValue(previewFixture);

    render(<AllocationRollbackPreviewPanel vaultId="vault-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview rollback" }));

    await waitFor(() => {
      expect(screen.getByTestId("allocation-rollback-result")).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("allocation-rollback-row")).toHaveLength(2);
    expect(screen.getByText(/No queue conflicts/)).toBeInTheDocument();
  });

  it("shows the empty state when there is no pending rebalance", async () => {
    fetchPendingPreview.mockRejectedValue(
      new ServiceError("NO_PENDING_REBALANCE", "No pending rebalance found.", 404),
    );

    render(<AllocationRollbackPreviewPanel vaultId="vault-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview rollback" }));

    await waitFor(() => {
      expect(screen.getByTestId("allocation-rollback-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("allocation-rollback-error")).not.toBeInTheDocument();
  });

  it("surfaces other typed failures via an alert", async () => {
    fetchPendingPreview.mockRejectedValue(
      new ServiceError("ALLOCATIONS_MUST_SUM_100", "weights must sum to 100", 400),
    );

    render(<AllocationRollbackPreviewPanel vaultId="vault-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview rollback" }));

    await waitFor(() => {
      expect(screen.getByTestId("allocation-rollback-error")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("weights must sum to 100");
    expect(screen.queryByTestId("allocation-rollback-empty")).not.toBeInTheDocument();
  });
});
