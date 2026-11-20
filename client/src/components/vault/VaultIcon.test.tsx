import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import VaultIcon from "./VaultIcon";

describe("VaultIcon", () => {
  it("renders an <img> when metadata is complete and valid", () => {
    render(
      <VaultIcon
        metadata={{
          iconUrl: "https://cdn.example.com/usdc.png",
          symbol: "USDC",
          issuer: "GISSUER",
          decimals: 7,
        }}
      />,
    );
    const img = screen.getByAltText("USDC icon");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://cdn.example.com/usdc.png");
    expect(screen.getByTestId("vault-icon")).not.toHaveAttribute("title");
  });

  it("renders a fallback badge when metadata is null", () => {
    render(<VaultIcon metadata={null} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const fallback = screen.getByTestId("vault-icon-fallback");
    expect(fallback).toHaveTextContent("?");
  });

  it("renders a fallback badge with the symbol's first letter when iconUrl is missing", () => {
    render(<VaultIcon metadata={{ symbol: "XLM", issuer: "GISSUER", decimals: 7 }} />);
    const fallback = screen.getByTestId("vault-icon-fallback");
    expect(fallback).toHaveTextContent("X");
  });

  it("shows a tooltip explaining the fallback reason for missing decimals", () => {
    render(<VaultIcon metadata={{ symbol: "XLM", issuer: "GISSUER" }} />);
    const fallback = screen.getByTestId("vault-icon-fallback");
    expect(fallback.getAttribute("title")).toContain("decimals is missing or invalid");
  });

  it("shows a tooltip explaining a missing issuer", () => {
    render(<VaultIcon metadata={{ symbol: "XLM", decimals: 7, iconUrl: "https://cdn.example.com/xlm.png" }} />);
    // iconUrl is valid here so the image renders; the title still surfaces the issuer fallback.
    const icon = screen.getByTestId("vault-icon");
    expect(icon.getAttribute("title")).toContain("issuer is missing");
  });

  it("falls back to a badge with an invalid symbol replaced by the default placeholder", () => {
    render(<VaultIcon metadata={{ symbol: "!!!", issuer: "GISSUER", decimals: 7 }} />);
    const fallback = screen.getByTestId("vault-icon-fallback");
    expect(fallback).toHaveTextContent("?");
    expect(fallback.getAttribute("title")).toContain("symbol is missing or invalid");
  });

  it("swaps to the fallback badge when the <img> fails to load", () => {
    render(
      <VaultIcon
        metadata={{
          iconUrl: "https://cdn.example.com/broken.png",
          symbol: "USDC",
          issuer: "GISSUER",
          decimals: 7,
        }}
      />,
    );
    const img = screen.getByAltText("USDC icon");
    fireEvent.error(img);
    expect(screen.queryByAltText("USDC icon")).not.toBeInTheDocument();
    expect(screen.getByTestId("vault-icon-fallback")).toHaveTextContent("U");
  });

  it("applies the requested size to the rendered badge", () => {
    render(<VaultIcon metadata={null} size={64} />);
    const fallback = screen.getByTestId("vault-icon-fallback");
    expect(fallback.style.width).toBe("64px");
    expect(fallback.style.height).toBe("64px");
  });

  it("renders the same fallback color for the same symbol across renders (stable visuals)", () => {
    const { unmount } = render(<VaultIcon metadata={{ symbol: "XLM" }} />);
    const firstColor = screen.getByTestId("vault-icon-fallback").style.backgroundColor;
    unmount();

    render(<VaultIcon metadata={{ symbol: "XLM" }} />);
    const secondColor = screen.getByTestId("vault-icon-fallback").style.backgroundColor;

    expect(firstColor).toBe(secondColor);
  });
});
