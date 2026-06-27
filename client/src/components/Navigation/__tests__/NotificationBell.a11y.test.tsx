/**
 * #729 — Accessibility regression coverage: NotificationBell navigation component.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import NotificationBell from "../NotificationBell";

const mockWallet = {
  isConnected: true,
  walletAddress: "GABC1234EXAMPLEWALLETADDRESS",
};

vi.mock("../../../context/useWallet", () => ({ useWallet: () => mockWallet }));
vi.mock("../../../hooks/useBackendStatus", () => ({ useBackendStatus: () => "available" }));
vi.mock("../../../lib/api", () => ({ apiUrl: (path: string) => `http://localhost:3001${path}` }));

const MOCK_NOTIFICATIONS = [
  { id: "n1", type: "DEPOSIT", title: "Deposit confirmed", message: "100 USDC confirmed.", isRead: false, createdAt: new Date().toISOString() },
  { id: "n2", type: "ANNOUNCEMENT", title: "Protocol upgrade", message: "Blend v2.", isRead: true, createdAt: new Date().toISOString() },
];

function mockFetchOk(data = MOCK_NOTIFICATIONS) {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(data), { status: 200 }),
  );
}

function mockFetchFail() {
  global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
}

describe("NotificationBell — accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWallet.isConnected = true;
  });

  it("renders nothing when wallet is disconnected", () => {
    mockWallet.isConnected = false;
    mockFetchOk([]);
    const { container } = render(<NotificationBell />);
    expect(container.firstChild).toBeNull();
  });

  it("bell toggle button is present and focusable", async () => {
    mockFetchOk([]);
    render(<NotificationBell />);
    const btn = await screen.findByRole("button");
    expect(btn).not.toHaveAttribute("tabindex", "-1");
  });

  it("bell button has a visible focus indicator class", async () => {
    mockFetchOk([]);
    render(<NotificationBell />);
    const btn = await screen.findByRole("button");
    expect(btn.className).toMatch(/focus:/);
  });

  it("opens notification panel on click", async () => {
    mockFetchOk(MOCK_NOTIFICATIONS);
    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole("button"));
    expect(await screen.findByText("Notifications")).toBeInTheDocument();
  });

  it("notification panel heading uses a heading element", async () => {
    mockFetchOk(MOCK_NOTIFICATIONS);
    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole("button"));
    const heading = await screen.findByText("Notifications");
    expect(heading.tagName).toMatch(/^H[1-6]$/i);
  });

  it("shows unread badge with correct count", async () => {
    mockFetchOk(MOCK_NOTIFICATIONS); // one unread
    render(<NotificationBell />);
    expect(await screen.findByText("1")).toBeInTheDocument();
  });

  it("notification titles are visible in open panel", async () => {
    mockFetchOk(MOCK_NOTIFICATIONS);
    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole("button"));
    expect(await screen.findByText("Deposit confirmed")).toBeInTheDocument();
    expect(await screen.findByText("Protocol upgrade")).toBeInTheDocument();
  });

  it("shows unavailable message when fetch fails", async () => {
    mockFetchFail();
    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole("button"));
    expect(await screen.findByText(/Notifications Unavailable/i)).toBeInTheDocument();
  });

  it("clear-all control has an accessible title", async () => {
    mockFetchOk(MOCK_NOTIFICATIONS);
    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole("button"));
    expect(await screen.findByTitle("Clear all")).toBeInTheDocument();
  });

  it("backdrop click closes the panel", async () => {
    mockFetchOk(MOCK_NOTIFICATIONS);
    render(<NotificationBell />);
    fireEvent.click(await screen.findByRole("button"));
    await screen.findByText("Notifications");
    const backdrop = document.querySelector(".fixed.inset-0.z-40") as HTMLElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop);
    expect(screen.queryByText("Notifications")).toBeNull();
  });
});
