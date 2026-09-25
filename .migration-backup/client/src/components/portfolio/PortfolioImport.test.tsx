import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import PortfolioImport from "./PortfolioImport";

const HEADER = "protocol,asset,depositedUsd,currentValueUsd";

function csvFile(contents: string, name = "holdings.csv") {
  return new File([contents], name, { type: "text/csv" });
}

async function upload(contents: string, name?: string) {
  render(<PortfolioImport />);
  await userEvent.upload(screen.getByTestId("portfolio-import-input"), csvFile(contents, name));
}

describe("PortfolioImport", () => {
  it("renders the import button with nothing validated yet", () => {
    render(<PortfolioImport />);

    expect(screen.getByRole("button", { name: /import csv/i })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("previews a valid file and lists row issues", async () => {
    await upload(`${HEADER}\nBlend,USDC,1000,1012.5\nSoroswap,,abc,1`);

    expect(await screen.findByText(/1 of 2 holdings ready to import/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,012\.50 current value/)).toBeInTheDocument();
    const issues = screen.getByRole("list", { name: /import issues/i });
    expect(issues).toHaveTextContent("Row 3: asset is required.");
    expect(issues).toHaveTextContent("Row 3: depositedUsd must be a plain number.");
  });

  it("shows the file-level failure and the missing columns", async () => {
    await upload("protocol,asset\nBlend,USDC");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The header row is missing required columns");
    expect(alert).toHaveTextContent("Missing: depositedUsd, currentValueUsd");
  });

  it("reports an empty file", async () => {
    await upload("   ");

    expect(await screen.findByRole("alert")).toHaveTextContent("The file is empty.");
  });

  it("says when no row is importable", async () => {
    await upload(`${HEADER}\nBlend,USDC,-1,1`, "negative.csv");

    expect(await screen.findByText("No valid holdings in negative.csv.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /import issues/i })).toHaveTextContent(
      "Row 2: depositedUsd cannot be negative.",
    );
  });
});
