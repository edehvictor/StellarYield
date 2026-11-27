import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AlertsModal from "../AlertsModal";
import * as alertsApi from "../alertsApi";

vi.mock("../alertsApi", () => ({
  fetchAlerts: vi.fn(),
  createAlert: vi.fn(),
  deleteAlert: vi.fn(),
  fetchDigestPreference: vi.fn(),
  saveDigestPreference: vi.fn(),
}));

describe("AlertsModal Boundary-Value Validation & State Preservation", () => {
  const mockWallet = "GABC1234567890123456789012345678901234567890123456789012";
  const mockVaults = ["usdc-vault-1", "xlm-vault-1"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(alertsApi.fetchAlerts).mockResolvedValue([]);
    vi.mocked(alertsApi.fetchDigestPreference).mockResolvedValue({
      enabled: false,
      scheduleMode: "weekly",
      eventThreshold: 2,
      watchedVaultIds: [],
      minApyDeltaPct: 0.5,
      minRiskDelta: 5,
      maxFreshnessHours: 12,
    });
  });

  function getForm() {
    return screen.getByRole("dialog").querySelector("form")!;
  }

  it("rejects non-integer cooldown minutes and preserves entered form values", async () => {
    render(
      <AlertsModal
        isOpen={true}
        onClose={vi.fn()}
        walletAddress={mockWallet}
        vaultOptions={mockVaults}
      />,
    );
    await waitFor(() => expect(alertsApi.fetchAlerts).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Select vault"), { target: { value: "usdc-vault-1" } });
    fireEvent.change(screen.getByLabelText("APY threshold"), { target: { value: "8.5" } });
    fireEvent.change(screen.getByLabelText("Notification email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Cooldown minutes"), { target: { value: "45.5" } });

    fireEvent.submit(getForm());

    const alertBox = await screen.findByRole("alert");
    expect(alertBox.textContent).toContain("Cooldown must be an integer between 0 and 1440 minutes");

    // Invariant: Form state preserved for safe retry
    expect((screen.getByLabelText("APY threshold") as HTMLInputElement).value).toBe("8.5");
    expect((screen.getByLabelText("Notification email") as HTMLInputElement).value).toBe("test@example.com");
    expect((screen.getByLabelText("Cooldown minutes") as HTMLInputElement).value).toBe("45.5");
    expect(alertsApi.createAlert).not.toHaveBeenCalled();
  });

  it("rejects out-of-bounds quiet hours and preserves entered form values", async () => {
    render(
      <AlertsModal
        isOpen={true}
        onClose={vi.fn()}
        walletAddress={mockWallet}
        vaultOptions={mockVaults}
      />,
    );
    await waitFor(() => expect(alertsApi.fetchAlerts).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Select vault"), { target: { value: "usdc-vault-1" } });
    fireEvent.change(screen.getByLabelText("APY threshold"), { target: { value: "10.0" } });
    fireEvent.change(screen.getByLabelText("Notification email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Quiet hours start"), { target: { value: "25" } });

    fireEvent.submit(getForm());

    const alertBox = await screen.findByRole("alert");
    expect(alertBox.textContent).toContain("Quiet hours start must be an integer from 0 to 23");

    // Invariant: Form state preserved
    expect((screen.getByLabelText("APY threshold") as HTMLInputElement).value).toBe("10.0");
    expect((screen.getByLabelText("Quiet hours start") as HTMLInputElement).value).toBe("25");
    expect(alertsApi.createAlert).not.toHaveBeenCalled();
  });

  it("preserves form values when API call fails and allows safe retry", async () => {
    vi.mocked(alertsApi.createAlert)
      .mockRejectedValueOnce(new Error("Network gateway timeout"))
      .mockResolvedValueOnce({
        id: "alert-123",
        walletAddress: mockWallet,
        vaultId: "usdc-vault-1",
        condition: "above",
        thresholdValue: 12.0,
        email: "test@example.com",
        status: "active",
        triggeredAt: null,
        createdAt: new Date().toISOString(),
      });

    render(
      <AlertsModal
        isOpen={true}
        onClose={vi.fn()}
        walletAddress={mockWallet}
        vaultOptions={mockVaults}
      />,
    );
    await waitFor(() => expect(alertsApi.fetchAlerts).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Select vault"), { target: { value: "usdc-vault-1" } });
    fireEvent.change(screen.getByLabelText("APY threshold"), { target: { value: "12.0" } });
    fireEvent.change(screen.getByLabelText("Notification email"), { target: { value: "test@example.com" } });

    // First attempt fails
    fireEvent.submit(getForm());

    const alertBox = await screen.findByRole("alert");
    expect(alertBox.textContent).toContain("Network gateway timeout");

    // Invariant: Form inputs are preserved after network error
    expect((screen.getByLabelText("APY threshold") as HTMLInputElement).value).toBe("12.0");
    expect((screen.getByLabelText("Notification email") as HTMLInputElement).value).toBe("test@example.com");

    // Safe retry: Submit form again
    fireEvent.submit(getForm());

    await waitFor(() => {
      expect(alertsApi.createAlert).toHaveBeenCalledTimes(2);
    });
  });

  it("submits safely with rounded boundaries and 0 cooldown", async () => {
    vi.mocked(alertsApi.createAlert).mockResolvedValueOnce({
      id: "alert-456",
      walletAddress: mockWallet,
      vaultId: "usdc-vault-1",
      condition: "above",
      thresholdValue: 7.1235,
      email: "test@example.com",
      status: "active",
      triggeredAt: null,
      createdAt: new Date().toISOString(),
    });

    render(
      <AlertsModal
        isOpen={true}
        onClose={vi.fn()}
        walletAddress={mockWallet}
        vaultOptions={mockVaults}
      />,
    );
    await waitFor(() => expect(alertsApi.fetchAlerts).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Select vault"), { target: { value: "usdc-vault-1" } });
    fireEvent.change(screen.getByLabelText("APY threshold"), { target: { value: "7.123456" } });
    fireEvent.change(screen.getByLabelText("Notification email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Cooldown minutes"), { target: { value: "0" } });

    fireEvent.submit(getForm());

    await waitFor(() => {
      expect(alertsApi.createAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          thresholdValue: 7.1235, // rounded half-up to 4 decimals
          preferences: expect.objectContaining({
            cooldownMinutes: 0,
          }),
        }),
      );
    });
  });
});
