import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import PortfolioBuilder from "./PortfolioBuilder";
import { deposit } from "../../services/soroban";

// Mock useWallet
const mockSignTransaction = vi.fn().mockResolvedValue("mock-signed-xdr");
vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    isConnected: true,
    signTransaction: mockSignTransaction,
  }),
}));

// Mock deposit service
vi.mock("../../services/soroban", () => ({
  deposit: vi.fn(),
}));

const mockAvailableVaults = [
  { contractId: "vault-1", name: "Blend Vault", apy: 12.5 },
  { contractId: "vault-2", name: "Soroswap Vault", apy: 8.4 },
];

describe("PortfolioBuilder Component", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("renders correctly with available vaults", () => {
    render(
      <PortfolioBuilder
        walletAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        availableVaults={mockAvailableVaults}
      />
    );

    expect(screen.getByText("Portfolio Allocation")).toBeInTheDocument();
    // Vault names also appear in the allocation delta preview.
    expect(screen.getAllByText("Blend Vault").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Soroswap Vault").length).toBeGreaterThan(0);
  });

  it("handles mock execution flow when opt-in checkbox is unchecked", async () => {
    render(
      <PortfolioBuilder
        walletAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        availableVaults={mockAvailableVaults}
      />
    );

    // Enter amount
    const amountInput = screen.getByPlaceholderText("Enter amount to allocate");
    fireEvent.change(amountInput, { target: { value: "100" } });

    // Execute button
    const executeBtn = screen.getByText("Execute Multi-Vault Deposit");
    fireEvent.click(executeBtn);

    // Should enter timeline phases without calling real deposit
    expect(screen.getByText("Building transaction")).toBeInTheDocument();
    expect(deposit).not.toHaveBeenCalled();
  });

  it("handles signed execution flow when opt-in checkbox is checked", async () => {
    vi.mocked(deposit).mockResolvedValue({
      success: true,
      hash: "0x123",
    });

    render(
      <PortfolioBuilder
        walletAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        availableVaults={mockAvailableVaults}
      />
    );

    // Enter amount
    const amountInput = screen.getByPlaceholderText("Enter amount to allocate");
    fireEvent.change(amountInput, { target: { value: "100" } });

    // Check opt-in checkbox
    const checkbox = screen.getByLabelText(/Execute transaction on-chain/i);
    fireEvent.click(checkbox);

    // Execute button
    const executeBtn = screen.getByText("Execute Multi-Vault Deposit");
    fireEvent.click(executeBtn);

    await waitFor(() => {
      expect(deposit).toHaveBeenCalled();
    });
  });

  it("handles signed execution failure correctly", async () => {
    vi.mocked(deposit).mockResolvedValue({
      success: false,
      error: "User rejected signing",
    });

    render(
      <PortfolioBuilder
        walletAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        availableVaults={mockAvailableVaults}
      />
    );

    // Enter amount
    const amountInput = screen.getByPlaceholderText("Enter amount to allocate");
    fireEvent.change(amountInput, { target: { value: "100" } });

    // Check opt-in checkbox
    const checkbox = screen.getByLabelText(/Execute transaction on-chain/i);
    fireEvent.click(checkbox);

    // Execute button
    const executeBtn = screen.getByText("Execute Multi-Vault Deposit");
    fireEvent.click(executeBtn);

    await waitFor(() => {
      expect(deposit).toHaveBeenCalled();
    });

    expect(screen.getAllByText("User rejected signing").length).toBeGreaterThan(0);
  });

  it("blocks execution and offers a rebalance when allocations would be dust", async () => {
    render(
      <PortfolioBuilder
        walletAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        availableVaults={mockAvailableVaults}
      />
    );

    // 1 USDC split 50/50 rounds the second vault to zero.
    fireEvent.change(screen.getByPlaceholderText("Enter amount to allocate"), {
      target: { value: "1" },
    });

    expect(await screen.findByTestId("dust-allocation-warning")).toBeInTheDocument();
    expect(screen.getByText("Dust allocations detected")).toBeInTheDocument();

    const executeBtn = screen.getByRole("button", {
      name: /Execute Multi-Vault Deposit/i,
    });
    expect(executeBtn).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Remove dust & rebalance/i }));

    await waitFor(() => {
      expect(screen.queryByTestId("dust-allocation-warning")).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /Execute Multi-Vault Deposit/i }),
    ).not.toBeDisabled();
  });
});
