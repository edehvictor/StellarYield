import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import PortfolioBuilder from "./PortfolioBuilder";
import { deposit } from "../../services/soroban";

// Mock useWallet
const mockSignTransaction = vi.fn().mockResolvedValue("mock-signed-xdr");
const mockConnectWallet = vi.fn().mockResolvedValue(true);
const mockDisconnectWallet = vi.fn();
vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    isConnected: true,
    providerId: "freighter",
    signTransaction: mockSignTransaction,
    connectWallet: mockConnectWallet,
    disconnectWallet: mockDisconnectWallet,
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
    mockConnectWallet.mockResolvedValue(true);
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

    // Raw provider text is replaced by stable recovery copy (#1363).
    expect(
      await screen.findByTestId("signature-rejection-recovery"),
    ).toBeInTheDocument();
    expect(screen.getByText("Signature request declined")).toBeInTheDocument();
    expect(screen.queryByText("User rejected signing")).not.toBeInTheDocument();
  });

  it("resumes at the failed vault after a rejected signature instead of re-depositing", async () => {
    vi.mocked(deposit)
      .mockResolvedValueOnce({ success: true, hash: "0xfirst" })
      .mockResolvedValueOnce({ success: false, error: "User rejected signing" })
      .mockResolvedValueOnce({ success: true, hash: "0xsecond" });

    render(
      <PortfolioBuilder
        walletAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        availableVaults={mockAvailableVaults}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Enter amount to allocate"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByLabelText(/Execute transaction on-chain/i));
    fireEvent.click(
      screen.getByRole("button", { name: /Execute Multi-Vault Deposit/i }),
    );

    expect(
      await screen.findByTestId("signature-rejection-recovery"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("signature-rejection-progress")).toHaveTextContent(
      "1 of 2 steps already completed",
    );

    fireEvent.click(screen.getByRole("button", { name: /Retry deposit/i }));

    await waitFor(() => {
      expect(screen.getByText("Deposits completed successfully!")).toBeInTheDocument();
    });

    // First vault deposited once; the failed second vault is retried once.
    expect(deposit).toHaveBeenCalledTimes(3);
    expect(vi.mocked(deposit).mock.calls[1][1]).toBe(50n);
    expect(vi.mocked(deposit).mock.calls[2][1]).toBe(50n);
    expect(
      screen.queryByTestId("signature-rejection-recovery"),
    ).not.toBeInTheDocument();
  });

  it("reconnects the wallet and retries after a locked-wallet rejection", async () => {
    vi.mocked(deposit)
      .mockResolvedValueOnce({ success: false, error: "Wallet is locked" })
      .mockResolvedValueOnce({ success: true, hash: "0xfirst" })
      .mockResolvedValueOnce({ success: true, hash: "0xsecond" });

    render(
      <PortfolioBuilder
        walletAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        availableVaults={mockAvailableVaults}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Enter amount to allocate"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByLabelText(/Execute transaction on-chain/i));
    fireEvent.click(
      screen.getByRole("button", { name: /Execute Multi-Vault Deposit/i }),
    );

    expect(
      await screen.findByTestId("signature-rejection-recovery"),
    ).toBeInTheDocument();
    expect(screen.getByText("Wallet is locked")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reconnect wallet/i }));

    await waitFor(() => {
      expect(mockConnectWallet).toHaveBeenCalled();
      expect(screen.getByText("Deposits completed successfully!")).toBeInTheDocument();
    });
    expect(deposit).toHaveBeenCalledTimes(3);
  });
});
