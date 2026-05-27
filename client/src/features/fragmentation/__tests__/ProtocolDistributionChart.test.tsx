import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import ProtocolDistributionChart from "../ProtocolDistributionChart";

describe("ProtocolDistributionChart empty state", () => {
  it("renders a plain-language no-data-yet message when the breakdown is empty", () => {
    render(<ProtocolDistributionChart protocolBreakdown={[]} />);
    const empty = screen.getByTestId("protocol-distribution-empty");
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/No protocol data yet/i);
    expect(empty).toHaveTextContent(
      /Distribution figures will appear once routing samples are available/i,
    );
  });
});
