import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import VaultCard from "./VaultCard";

const MALFORMED_METADATA = { symbol: "bad symbol!!", decimals: -1, issuer: "" };

describe("VaultCard — fallback stability across variants", () => {
  it("renders the list variant without crashing on malformed metadata", () => {
    render(<VaultCard name="Broken Vault" metadata={MALFORMED_METADATA} variant="list" />);
    expect(screen.getByTestId("vault-card-list")).toBeInTheDocument();
    expect(screen.getByText("Broken Vault")).toBeInTheDocument();
    expect(screen.getByTestId("vault-icon-fallback")).toHaveTextContent("?");
  });

  it("renders the detail variant without crashing on malformed metadata", () => {
    render(
      <VaultCard name="Broken Vault" metadata={MALFORMED_METADATA} variant="detail" apy={4.2} />,
    );
    expect(screen.getByTestId("vault-card-detail")).toBeInTheDocument();
    expect(screen.getByText("Broken Vault")).toBeInTheDocument();
    expect(screen.getByText("APY 4.20%")).toBeInTheDocument();
    expect(screen.getByTestId("vault-icon-fallback")).toHaveTextContent("?");
  });

  it("renders the action variant without crashing on malformed metadata", () => {
    render(<VaultCard name="Broken Vault" metadata={MALFORMED_METADATA} variant="action" />);
    expect(screen.getByTestId("vault-card-action")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deposit" })).toBeInTheDocument();
    expect(screen.getByTestId("vault-icon-fallback")).toHaveTextContent("?");
  });

  it("renders the same fallback glyph across all three variants for the same metadata", () => {
    const metadata = { symbol: "" };
    const { unmount: u1 } = render(<VaultCard name="A" metadata={metadata} variant="list" />);
    const listGlyph = screen.getByTestId("vault-icon-fallback").textContent;
    u1();

    const { unmount: u2 } = render(<VaultCard name="A" metadata={metadata} variant="detail" />);
    const detailGlyph = screen.getByTestId("vault-icon-fallback").textContent;
    u2();

    render(<VaultCard name="A" metadata={metadata} variant="action" />);
    const actionGlyph = screen.getByTestId("vault-icon-fallback").textContent;

    expect(listGlyph).toBe(detailGlyph);
    expect(detailGlyph).toBe(actionGlyph);
  });

  it("renders an image icon in every variant when metadata is fully valid", () => {
    const metadata = {
      iconUrl: "https://cdn.example.com/usdc.png",
      symbol: "USDC",
      issuer: "GISSUER",
      decimals: 7,
    };
    render(<VaultCard name="USDC Vault" metadata={metadata} variant="list" />);
    expect(screen.getByAltText("USDC icon")).toBeInTheDocument();
  });

  it("defaults to the list variant", () => {
    render(<VaultCard name="Default Vault" metadata={null} />);
    expect(screen.getByTestId("vault-card-list")).toBeInTheDocument();
  });
});
