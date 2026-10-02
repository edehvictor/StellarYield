import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WithdrawPanel from "./WithdrawPanel";
import { getUserShares, getVaultTotals, withdraw } from "../../services/soroban";

vi.mock("../../services/soroban", () => ({
  withdraw: vi.fn(),
  getUserShares: vi.fn(),
  getVaultTotals: vi.fn(),
}));

vi.mock("../zap/assets", () => ({
  getVaultTokenFromEnv: () => ({ symbol: "yVault", name: "Yield Vault", contractId: "CVAULT", decimals: 7 }),
}));

vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    isConnected: true,
    isSessionExpired: false,
    connectWallet: vi.fn().mockResolvedValue(true),
    providerId: "freighter",
  }),
}));

const mockGetUserShares = vi.mocked(getUserShares);
const mockGetVaultTotals = vi.mocked(getVaultTotals);

// A holder of 500 shares in a vault whose share price is 1.05.
const BALANCE = 500_0000000n;
const TOTALS = { totalAssets: 1_050_0000000n, totalShares: 1_000_0000000n };

const region = () => screen.getByRole("region", { name: "Share redemption preview" });
const preset = (name: string) => screen.getByRole("button", { name });
const amountInput = () => screen.getByLabelText("Shares to redeem");

async function renderLoaded() {
  render(<WithdrawPanel walletAddress="GABCDEF123" />);
  await waitFor(() => expect(screen.getByText(/Max: 500/)).toBeInTheDocument());
  await waitFor(() => expect(mockGetVaultTotals).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserShares.mockResolvedValue(BALANCE);
  mockGetVaultTotals.mockResolvedValue(TOTALS);
});

afterEach(cleanup);

describe("WithdrawPanel — partial withdrawal redemption preview (#1404)", () => {
  it("shows no redemption preview until an amount is entered", async () => {
    await renderLoaded();

    expect(screen.queryByRole("region", { name: "Share redemption preview" })).not.toBeInTheDocument();
  });

  it("offers 25%, 50%, 75% and 100% of the position", async () => {
    await renderLoaded();

    const group = screen.getByRole("group", { name: "Withdraw a portion of your position" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["25%", "50%", "75%", "100%"]);
  });

  it("fills the amount from a preset and previews the partial redemption", async () => {
    await renderLoaded();

    await userEvent.click(preset("25%"));

    expect(amountInput()).toHaveValue("125");
    const preview = within(region());
    expect(preview.getByText("125 (25% of position)")).toBeInTheDocument();
    expect(preview.getByText("131.25 yVault")).toBeInTheDocument();
    expect(preview.getByText("1.0500000 yVault")).toBeInTheDocument();
    expect(preview.getByText("375 shares (≈ 393.75 yVault)")).toBeInTheDocument();
  });

  it("marks the 100% preset as a full withdrawal", async () => {
    await renderLoaded();

    await userEvent.click(preset("100%"));

    expect(amountInput()).toHaveValue("500");
    expect(within(region()).getByText("Full withdrawal")).toBeInTheDocument();
  });

  it("updates the preview as the amount is typed", async () => {
    await renderLoaded();

    await userEvent.type(amountInput(), "100");
    expect(within(region()).getByText("100 (20% of position)")).toBeInTheDocument();

    await userEvent.clear(amountInput());
    await userEvent.type(amountInput(), "250");
    expect(within(region()).getByText("250 (50% of position)")).toBeInTheDocument();
    expect(within(region()).getByText("262.5 yVault")).toBeInTheDocument();
  });

  it("warns, with the maximum, when the amount exceeds the position", async () => {
    await renderLoaded();

    await userEvent.type(amountInput(), "600");

    const alert = await screen.findByText(/You can redeem at most 500 shares\./);
    expect(alert).toHaveTextContent("The request is larger than your position.");
    expect(screen.queryByRole("region", { name: "Share redemption preview" })).not.toBeInTheDocument();
  });

  it("does not preview an unparseable or non-positive amount", async () => {
    await renderLoaded();

    await userEvent.type(amountInput(), "abc");
    expect(screen.queryByRole("region", { name: "Share redemption preview" })).not.toBeInTheDocument();

    await userEvent.clear(amountInput());
    await userEvent.type(amountInput(), "0");
    expect(screen.queryByRole("region", { name: "Share redemption preview" })).not.toBeInTheDocument();
  });

  it("degrades to a notice, without blocking, when the vault totals cannot be read", async () => {
    mockGetVaultTotals.mockRejectedValue(new Error("rpc down"));
    render(<WithdrawPanel walletAddress="GABCDEF123" />);
    await waitFor(() => expect(screen.getByText(/Max: 500/)).toBeInTheDocument());

    await userEvent.type(amountInput(), "10");

    expect(await screen.findByText(/Share redemption preview unavailable: could not read the vault's share price\./)).toBeInTheDocument();
    expect(screen.queryByText(/rpc down/)).not.toBeInTheDocument();
    expect(amountInput()).toHaveValue("10");
  });

  it("disables the presets until the share balance is known, and for an empty position", async () => {
    mockGetUserShares.mockResolvedValue(0n);
    render(<WithdrawPanel walletAddress="GABCDEF123" />);
    await waitFor(() => expect(mockGetUserShares).toHaveBeenCalled());

    for (const name of ["25%", "50%", "75%", "100%"]) {
      await waitFor(() => expect(preset(name)).toBeDisabled());
    }
  });

  it("fills the withdrawal amount in shares from a preset without submitting", async () => {
    await renderLoaded();

    await userEvent.click(preset("50%"));

    expect(amountInput()).toHaveValue("250");
    // The redemption preview is informational; the amount field drives the withdrawal.
    expect(vi.mocked(withdraw)).not.toHaveBeenCalled();
  });
});
