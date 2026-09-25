/**
 * AlertsModal - Optimistic Update Rollback Tests
 *
 * Tests for rollback behavior when preference saves fail
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AlertsModal from "../AlertsModal";
import * as alertsApi from "../alertsApi";
import type { WatchlistDigestPreference } from "../types";

jest.mock("../alertsApi");

describe("AlertsModal - Optimistic Update Rollback", () => {
  const mockWalletAddress = "0x123abc";
  const mockVaultOptions = ["vault-a", "vault-b", "vault-c"];

  const mockAlerts = [
    {
      id: "alert-1",
      walletAddress: mockWalletAddress,
      vaultId: "vault-a",
      condition: "above" as const,
      thresholdValue: 10,
      status: "active" as const,
      email: "test@example.com",
      createdAt: new Date().toISOString(),
    },
  ];

  const mockDigestPreferences: WatchlistDigestPreference = {
    enabled: true,
    scheduleMode: "weekly",
    eventThreshold: 2,
    watchedVaultIds: ["vault-a"],
    minApyDeltaPct: 0.5,
    minRiskDelta: 5,
    maxFreshnessHours: 12,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (alertsApi.fetchAlerts as jest.Mock).mockResolvedValue(mockAlerts);
    (alertsApi.fetchDigestPreference as jest.Mock).mockResolvedValue(mockDigestPreferences);
  });

  describe("Alert Deletion - Optimistic Rollback", () => {
    it("should show alert as deleted optimistically", async () => {
      (alertsApi.deleteAlert as jest.Mock).mockResolvedValueOnce(undefined);

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("vault-a")).toBeInTheDocument();
      });

      const deleteButton = screen.getByLabelText(/Delete alert for vault-a/);
      fireEvent.click(deleteButton);

      // Alert should be removed optimistically
      await waitFor(() => {
        expect(screen.queryByText("vault-a")).not.toBeInTheDocument();
      });
    });

    it("should rollback alert when deletion fails", async () => {
      const deleteError = new Error("Network error");
      (alertsApi.deleteAlert as jest.Mock).mockRejectedValueOnce(deleteError);

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("vault-a")).toBeInTheDocument();
      });

      const deleteButton = screen.getByLabelText(/Delete alert for vault-a/);
      fireEvent.click(deleteButton);

      // Alert should be removed optimistically
      expect(screen.queryByText("vault-a")).not.toBeInTheDocument();

      // Then rollback when delete fails
      await waitFor(() => {
        expect(screen.getByText("vault-a")).toBeInTheDocument();
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });

    it("should show retry button for failed deletion", async () => {
      const deleteError = new Error("Failed to delete");
      (alertsApi.deleteAlert as jest.Mock)
        .mockRejectedValueOnce(deleteError)
        .mockResolvedValueOnce(undefined);

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("vault-a")).toBeInTheDocument();
      });

      const deleteButton = screen.getByLabelText(/Delete alert for vault-a/);
      fireEvent.click(deleteButton);

      // Wait for error and retry button
      await waitFor(() => {
        expect(screen.getByText("Retry delete")).toBeInTheDocument();
      });

      // Retry should succeed
      const retryButton = screen.getByText("Retry delete");
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(screen.queryByText("vault-a")).not.toBeInTheDocument();
      });
    });

    it("should clear delete error after retry succeeds", async () => {
      (alertsApi.deleteAlert as jest.Mock)
        .mockRejectedValueOnce(new Error("First attempt failed"))
        .mockResolvedValueOnce(undefined);

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("vault-a")).toBeInTheDocument();
      });

      // Delete fails
      const deleteButton = screen.getByLabelText(/Delete alert for vault-a/);
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByText("First attempt failed")).toBeInTheDocument();
      });

      // Retry succeeds
      const retryButton = screen.getByText("Retry delete");
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(screen.queryByText("First attempt failed")).not.toBeInTheDocument();
        expect(screen.queryByText("vault-a")).not.toBeInTheDocument();
      });
    });
  });

  describe("Digest Preferences Save - Optimistic Rollback", () => {
    it("should show digest preferences error when save fails", async () => {
      const saveError = new Error("Save failed");
      (alertsApi.saveDigestPreference as jest.Mock).mockRejectedValueOnce(saveError);

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      // Wait for digest preferences to load
      await waitFor(() => {
        expect(screen.getByText("Vault Watchlist Digest")).toBeInTheDocument();
      });

      // Try to save
      const saveButton = screen.getByText("Save Digest Preferences");
      fireEvent.click(saveButton);

      // Error should appear
      await waitFor(() => {
        expect(screen.getByText("Save failed")).toBeInTheDocument();
      });
    });

    it("should show retry button for failed digest preferences save", async () => {
      const saveError = new Error("Network error");
      (alertsApi.saveDigestPreference as jest.Mock)
        .mockRejectedValueOnce(saveError)
        .mockResolvedValueOnce(mockDigestPreferences);

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Vault Watchlist Digest")).toBeInTheDocument();
      });

      const saveButton = screen.getByText("Save Digest Preferences");
      fireEvent.click(saveButton);

      // Error with retry should appear
      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
        expect(screen.getByText("Retry")).toBeInTheDocument();
      });

      // Retry should succeed
      const retryButton = screen.getAllByText("Retry")[0];
      fireEvent.click(retryButton);

      // Error should disappear after successful retry
      await waitFor(() => {
        expect(screen.queryByText("Network error")).not.toBeInTheDocument();
      });
    });

    it("should preserve user changes when save fails", async () => {
      (alertsApi.saveDigestPreference as jest.Mock).mockRejectedValueOnce(
        new Error("Save failed")
      );

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Vault Watchlist Digest")).toBeInTheDocument();
      });

      // Find and toggle a vault checkbox
      const vaultCheckbox = screen.getByLabelText(/Watch vault vault-b/);
      fireEvent.click(vaultCheckbox);

      // Save should fail
      const saveButton = screen.getByText("Save Digest Preferences");
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText("Save failed")).toBeInTheDocument();
      });

      // User's changes should still be visible in the UI
      expect(vaultCheckbox).toBeChecked();
    });

    it("should successfully save after retry", async () => {
      const updatedPreferences: WatchlistDigestPreference = {
        ...mockDigestPreferences,
        watchedVaultIds: ["vault-a", "vault-b"],
      };

      (alertsApi.saveDigestPreference as jest.Mock)
        .mockRejectedValueOnce(new Error("First attempt failed"))
        .mockResolvedValueOnce(updatedPreferences);

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Vault Watchlist Digest")).toBeInTheDocument();
      });

      // Toggle a vault
      const vaultCheckbox = screen.getByLabelText(/Watch vault vault-b/);
      fireEvent.click(vaultCheckbox);

      // First save fails
      const saveButton = screen.getByText("Save Digest Preferences");
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText("First attempt failed")).toBeInTheDocument();
      });

      // Retry succeeds
      const retryButton = screen.getAllByText("Retry")[0];
      fireEvent.click(retryButton);

      // Error should clear and state should be saved
      await waitFor(() => {
        expect(screen.queryByText("First attempt failed")).not.toBeInTheDocument();
      });
    });
  });

  describe("Error Message UX", () => {
    it("should show actionable error messages with icons", async () => {
      (alertsApi.deleteAlert as jest.Mock).mockRejectedValueOnce(
        new Error("Failed to delete alert")
      );

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("vault-a")).toBeInTheDocument();
      });

      const deleteButton = screen.getByLabelText(/Delete alert for vault-a/);
      fireEvent.click(deleteButton);

      await waitFor(() => {
        // Should show error with icon and retry button
        expect(screen.getByText("Failed to delete alert")).toBeInTheDocument();
        expect(screen.getByText("Retry delete")).toBeInTheDocument();
      });
    });

    it("should display generic error message for unknown errors", async () => {
      (alertsApi.deleteAlert as jest.Mock).mockRejectedValueOnce("Unknown error");

      render(
        <AlertsModal
          isOpen={true}
          onClose={() => {}}
          walletAddress={mockWalletAddress}
          vaultOptions={mockVaultOptions}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("vault-a")).toBeInTheDocument();
      });

      const deleteButton = screen.getByLabelText(/Delete alert for vault-a/);
      fireEvent.click(deleteButton);

      // Should show a default error message
      await waitFor(() => {
        const errorText = screen.queryByText(/Unknown error/i) || screen.queryByText(/Failed/i);
        expect(errorText).toBeInTheDocument();
      });
    });
  });
});
