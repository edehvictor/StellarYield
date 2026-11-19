import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RedemptionPreviewPanel from "./RedemptionPreviewPanel";
import { buildRedemptionView } from "./redemptionPreview";

const TOTALS = { totalAssets: 1_050_0000000n, totalShares: 1_000_0000000n };

const view = (shares: bigint, userShares = 500_0000000n, minRemainingShares?: bigint) =>
  buildRedemptionView({ totals: TOTALS, userShares, shares, minRemainingShares });

const renderPanel = (props: Partial<Parameters<typeof RedemptionPreviewPanel>[0]> = {}) =>
  render(
    <RedemptionPreviewPanel view={null} loading={false} totalsError={null} decimals={7} symbol="yVault" {...props} />,
  );

afterEach(cleanup);

describe("RedemptionPreviewPanel", () => {
  it("renders nothing when there is nothing to preview", () => {
    const { container } = renderPanel();

    expect(container).toBeEmptyDOMElement();
  });

  it("shows shares burned, assets received, share price and the remaining position", () => {
    renderPanel({ view: view(125_0000000n) });

    const region = screen.getByRole("region", { name: "Share redemption preview" });
    expect(within(region).getByText("125 (25% of position)")).toBeInTheDocument();
    expect(within(region).getByText("131.25 yVault")).toBeInTheDocument();
    expect(within(region).getByText("1.0500000 yVault")).toBeInTheDocument();
    expect(within(region).getByText("375 shares (≈ 393.75 yVault)")).toBeInTheDocument();
    expect(within(region).queryByText("Full withdrawal")).not.toBeInTheDocument();
  });

  it("flags a full withdrawal", () => {
    renderPanel({ view: view(500_0000000n) });

    expect(screen.getByText("Full withdrawal")).toBeInTheDocument();
    expect(screen.getByText("None — full withdrawal")).toBeInTheDocument();
  });

  it("shows a dust warning with its remediation", () => {
    renderPanel({ view: view(499_9999000n, 500_0000000n, 10_000n) });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("below the 10000-share minimum position");
    expect(alert).toHaveTextContent("Redeem your whole position instead");
  });

  it("says how much can be redeemed when the amount is too large", () => {
    renderPanel({ view: view(600_0000000n) });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The request is larger than your position.");
    expect(alert).toHaveTextContent("You can redeem at most 500 shares.");
  });

  it("shows a busy state while the vault totals load", () => {
    renderPanel({ loading: true });

    expect(screen.getByText("Reading vault share price…")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("explains an unavailable preview without blocking, and prefers it over a stale view", () => {
    renderPanel({ totalsError: "could not read the vault's share price.", view: view(1n) });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Share redemption preview unavailable: could not read the vault's share price.",
    );
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("uses the token's decimals", () => {
    renderPanel({
      view: buildRedemptionView({
        totals: { totalAssets: 200_00n, totalShares: 100_00n },
        userShares: 100_00n,
        shares: 50_00n,
      }),
      decimals: 2,
      symbol: "USDC",
    });

    expect(screen.getByText("100 USDC")).toBeInTheDocument();
    expect(screen.getByText("2.0000000 USDC")).toBeInTheDocument();
  });
});
