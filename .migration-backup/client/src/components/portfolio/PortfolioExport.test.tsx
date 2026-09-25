import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import PortfolioExport from "./PortfolioExport";

const STORAGE_KEY = "stellar_yield_portfolio_export_privacy_warning_dismissed";

describe("PortfolioExport", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("shows a privacy warning before export and persists dismissal when requested", async () => {
    const urlMock = vi.fn().mockReturnValue("blob:url");
    Object.defineProperty(window, "URL", {
      configurable: true,
      value: {
        ...window.URL,
        createObjectURL: urlMock,
        revokeObjectURL: vi.fn(),
      },
    });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    (globalThis.fetch as unknown) = vi.fn().mockResolvedValueOnce(
      new Response(new Blob(["col1,col2\nvalue1,value2"], { type: "text/csv" }), {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="portfolio-export.csv"' },
      }),
    );

    render(<PortfolioExport walletAddress="GDETESTWALLET123" />);

    fireEvent.click(screen.getByRole("button", { name: /export portfolio/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/don't show this warning again/i));
    fireEvent.click(screen.getByRole("button", { name: /confirm export/i }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(urlMock).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("skips the warning dialog when the warning has already been dismissed", async () => {
    localStorage.setItem(STORAGE_KEY, "true");

    Object.defineProperty(window, "URL", {
      configurable: true,
      value: {
        ...window.URL,
        createObjectURL: vi.fn().mockReturnValue("blob:url"),
        revokeObjectURL: vi.fn(),
      },
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    (globalThis.fetch as unknown) = vi.fn().mockResolvedValueOnce(
      new Response(new Blob(["col1,col2\nvalue1,value2"], { type: "text/csv" }), {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="portfolio-export.csv"' },
      }),
    );

    render(<PortfolioExport walletAddress="GDETESTWALLET123" />);

    fireEvent.click(screen.getByRole("button", { name: /export portfolio/i }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
