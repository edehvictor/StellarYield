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
    expect(screen.getByText("Blend Vault")).toBeInTheDocument();
    expect(screen.getByText("Soroswap Vault")).toBeInTheDocument();
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
});
