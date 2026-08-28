import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Vault from "../Vault";
import * as vaultData from "../../lib/vaultData";
import * as walletModule from "../../context/useWallet";
import * as availabilityModule from "../../hooks/useVaultActionAvailability";

// Mock hooks
vi.mock("../../context/useWallet", () => ({
  useWallet: vi.fn(() => ({ walletAddress: "G123..." })),
}));

vi.mock("../../hooks/useVaultOgMeta", () => ({
  useVaultOgMeta: vi.fn(() => ({ title: "Mock Title", tags: [] })),
}));

vi.mock("../../hooks/useBackendStatus", () => ({
  useBackendStatus: vi.fn(() => "available"),
}));

vi.mock("../../hooks/useVaultActionAvailability", () => ({
  useVaultActionAvailability: vi.fn(() => ({
    deposit: { available: true },
    withdraw: { available: true },
    zap: { available: true },
    claim: { available: true },
    rebalance: { available: true },
  })),
}));

// Mock child components
vi.mock("../AIAdvisor/RecoveryAdvisor", () => ({
  RecoveryAdvisor: () => <div data-testid="recovery-advisor" />,
}));

vi.mock("../../features/zap", () => ({
  ZapDepositPanel: ({ walletAddress }: { walletAddress: string | null }) => (
    <div data-testid="zap-panel">Zap panel - {walletAddress ?? "no wallet"}</div>
  ),
}));

vi.mock("../../features/withdraw", () => ({
  WithdrawPanel: ({ walletAddress }: { walletAddress: string | null }) => (
    <div data-testid="withdraw-panel">Withdraw panel - {walletAddress ?? "no wallet"}</div>
  ),
}));

vi.mock("../VaultCapacityWarning", () => ({
  default: ({ capacity }: { capacity: { status: string } }) => (
    <div data-testid="capacity-warning">Capacity: {capacity.status}</div>
  ),
}));

const mockUseWallet = vi.mocked(walletModule.useWallet);
const mockUseVaultActionAvailability = vi.mocked(availabilityModule.useVaultActionAvailability);

describe("Vault Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset wallet to default
    mockUseWallet.mockReturnValue({ walletAddress: "G123..." });

    // Reset to default: all actions available
    mockUseVaultActionAvailability.mockReturnValue({
      deposit: { available: true },
      withdraw: { available: true },
      zap: { available: true },
      claim: { available: true },
      rebalance: { available: true },
    });
  });

  it("shows loading state initially", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(null), 100)),
    );

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/Loading vault details.../i)).toBeInTheDocument();
  });

  it("shows not found state for unknown slug", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={["/vault/unknown-slug"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Vault Not Found/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/"unknown-slug"/i)).toBeInTheDocument();
  });

  it("shows unavailable state when live data is missing", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 0,
      tvl: 0,
      live: false,
    });

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Vault/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Live Data Unavailable/i)).toBeInTheDocument();
  });

  it("renders vault details when data is loaded successfully", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 12.5,
      tvl: 1000000,
      live: true,
    });

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Vault/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/12.50%/)).toBeInTheDocument();
    expect(screen.getByText(/\$1.00M/)).toBeInTheDocument();
    expect(screen.getByTestId("recovery-advisor")).toBeInTheDocument();
    expect(screen.getByTestId("zap-panel")).toBeInTheDocument();
    expect(screen.getByTestId("capacity-warning")).toBeInTheDocument();
  });

  it("renders withdraw panel when withdraw tab is clicked", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 5.0,
      tvl: 500000,
      live: true,
    });

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Vault/i)).toBeInTheDocument();
    });

    // Initially deposit panel is shown
    expect(screen.getByTestId("zap-panel")).toBeInTheDocument();

    // Click "Withdraw" tab
    const withdrawBtn = screen.getByText("Withdraw");
    withdrawBtn.click();

    expect(screen.getByTestId("withdraw-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("zap-panel")).not.toBeInTheDocument();
  });

  it("disables deposit button and shows reason when deposit is unavailable", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 5.0,
      tvl: 500000,
      live: true,
    });

    mockUseVaultActionAvailability.mockReturnValue({
      deposit: { available: false, reason: "Vault is paused" },
      withdraw: { available: true },
      zap: { available: false, reason: "Vault is paused" },
      claim: { available: true },
      rebalance: { available: true },
    });

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Vault/i)).toBeInTheDocument();
    });

    const depositBtn = screen.getByText("Deposit");
    expect(depositBtn).toBeDisabled();
    expect(depositBtn).toHaveAttribute("aria-disabled", "true");

    // The disabled reason banner should be visible because deposit is the active tab
    expect(screen.getByText("Vault is paused")).toBeInTheDocument();

    const withdrawBtn = screen.getByText("Withdraw");
    expect(withdrawBtn).not.toBeDisabled();
  });

  it("disables both buttons when wallet is not connected", async () => {
    mockUseWallet.mockReturnValue({ walletAddress: null });

    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 5.0,
      tvl: 500000,
      live: true,
    });

    mockUseVaultActionAvailability.mockReturnValue({
      deposit: { available: false, reason: "Connect your wallet to perform this action" },
      withdraw: { available: false, reason: "Connect your wallet to perform this action" },
      zap: { available: false, reason: "Connect your wallet to perform this action" },
      claim: { available: false, reason: "Connect your wallet to perform this action" },
      rebalance: { available: false, reason: "Connect your wallet to perform this action" },
    });

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Vault/i)).toBeInTheDocument();
    });

    const depositBtn = screen.getByText("Deposit");
    const withdrawBtn = screen.getByText("Withdraw");

    expect(depositBtn).toBeDisabled();
    expect(withdrawBtn).toBeDisabled();

    expect(screen.getByText("Connect your wallet to perform this action")).toBeInTheDocument();
  });
});
