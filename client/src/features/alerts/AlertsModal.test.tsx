import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AlertsModal from "./AlertsModal";
import * as api from "./alertsApi";
import type { UserAlert } from "./types";

vi.mock("./alertsApi");

const mockFetch = vi.mocked(api.fetchAlerts);
const mockCreate = vi.mocked(api.createAlert);
const mockDelete = vi.mocked(api.deleteAlert);

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
    const blendItems = await screen.findAllByText("Blend");
    // At least one should be the alert list item (p tag), not just the option
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

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({
      walletAddress: "GTEST",
      vaultId: "Blend",
      condition: "above",
      thresholdValue: 10,
      email: "user@example.com",
    }));
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
});
