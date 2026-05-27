import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AlertsModal from "./AlertsModal";
import * as api from "./alertsApi";
import type { UserAlert, WatchlistDigestPreference } from "./types";

vi.mock("./alertsApi");

const mockFetch = vi.mocked(api.fetchAlerts);
const mockCreate = vi.mocked(api.createAlert);
const mockDelete = vi.mocked(api.deleteAlert);
const mockFetchDigestPreference = vi.mocked(api.fetchDigestPreference);
const mockSaveDigestPreference = vi.mocked(api.saveDigestPreference);

const SAMPLE_ALERT: UserAlert = {
  id: "a1",
  walletAddress: "GTEST",
  vaultId: "Blend",
  condition: "above",
  thresholdValue: 10,
  email: "user@example.com",
  status: "active",
  triggeredAt: null,
  createdAt: new Date().toISOString(),
};

const VAULT_OPTIONS = ["Blend", "Soroswap"];

const DEFAULT_DIGEST_PREFERENCE: WatchlistDigestPreference = {
  enabled: false,
  scheduleMode: "weekly",
  eventThreshold: 2,
  watchedVaultIds: ["Blend"],
  minApyDeltaPct: 0.5,
  minRiskDelta: 5,
  maxFreshnessHours: 12,
};

function renderModal(isOpen = true) {
  const onClose = vi.fn();
  render(
    <AlertsModal
      isOpen={isOpen}
      onClose={onClose}
      walletAddress="GTEST"
      vaultOptions={VAULT_OPTIONS}
    />,
  );
  return { onClose };
}

describe("AlertsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue([]);
    mockCreate.mockResolvedValue(SAMPLE_ALERT);
    mockDelete.mockResolvedValue(undefined);
    mockFetchDigestPreference.mockResolvedValue(DEFAULT_DIGEST_PREFERENCE);
    mockSaveDigestPreference.mockResolvedValue(DEFAULT_DIGEST_PREFERENCE);
  });

  it("renders nothing when closed", () => {
    renderModal(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the modal when open", async () => {
    renderModal();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("APY Alerts")).toBeTruthy();
  });

  it("calls onClose when close button is clicked", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByLabelText("Close alerts"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on Escape key", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("loads alerts on open", async () => {
    mockFetch.mockResolvedValue([SAMPLE_ALERT]);
    renderModal();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("GTEST"));
    await waitFor(() => expect(mockFetchDigestPreference).toHaveBeenCalledWith("GTEST"));
    const blendItems = await screen.findAllByText("Blend");
    expect(blendItems.length).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state when no alerts", async () => {
    mockFetch.mockResolvedValue([]);
    renderModal();
    expect(await screen.findByText("No alerts yet")).toBeTruthy();
  });

  it("shows validation error when vault not selected", async () => {
    renderModal();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByText("Add Alert"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Select a vault");
  });

  it("shows validation error for invalid threshold", async () => {
    renderModal();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Select vault"), { target: { value: "Blend" } });
    fireEvent.change(screen.getByLabelText("APY threshold"), { target: { value: "9999" } });
    fireEvent.change(screen.getByLabelText("Notification email"), { target: { value: "user@example.com" } });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("threshold");
  });

  it("creates an alert with valid form data", async () => {
    renderModal();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Select vault"), { target: { value: "Blend" } });
    fireEvent.change(screen.getByLabelText("APY threshold"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Notification email"), { target: { value: "user@example.com" } });

    fireEvent.click(screen.getByText("Add Alert"));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      walletAddress: "GTEST",
      vaultId: "Blend",
      condition: "above",
      thresholdValue: 10,
      email: "user@example.com",
      preferences: expect.objectContaining({
        channel: "email",
        cooldownMinutes: 60,
      }),
    })));
  });

  it("deletes an alert when trash button is clicked", async () => {
    mockFetch.mockResolvedValue([SAMPLE_ALERT]);
    renderModal();

    const deleteBtn = await screen.findByLabelText("Delete alert for Blend");
    fireEvent.click(deleteBtn);

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("a1", "GTEST"));
  });

  it("shows triggered badge for triggered alerts", async () => {
    mockFetch.mockResolvedValue([{ ...SAMPLE_ALERT, status: "triggered" }]);
    renderModal();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(await screen.findByText("triggered")).toBeTruthy();
  });

  it("loads and displays watchlist digest preferences", async () => {
    mockFetchDigestPreference.mockResolvedValue({
      ...DEFAULT_DIGEST_PREFERENCE,
      enabled: true,
      watchedVaultIds: ["Blend", "Soroswap"],
    });

    renderModal();

    expect(await screen.findByLabelText("Enable watchlist digest")).toBeChecked();
    expect(screen.getByLabelText("Watch vault Blend")).toBeChecked();
    expect(screen.getByLabelText("Watch vault Soroswap")).toBeChecked();
  });

  it("saves watchlist digest preferences", async () => {
    renderModal();

    await waitFor(() => expect(mockFetchDigestPreference).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText("Enable watchlist digest"));
    fireEvent.change(screen.getByLabelText("Digest schedule mode"), {
      target: { value: "daily" },
    });
    fireEvent.change(screen.getByLabelText("Digest event threshold"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByLabelText("Watch vault Soroswap"));
    fireEvent.click(screen.getByText("Save Digest Preferences"));

    await waitFor(() =>
      expect(mockSaveDigestPreference).toHaveBeenCalledWith(
        "GTEST",
        expect.objectContaining({
          enabled: true,
          scheduleMode: "daily",
          eventThreshold: 4,
          watchedVaultIds: expect.arrayContaining(["Blend", "Soroswap"]),
        }),
      ),
    );
  });
});
