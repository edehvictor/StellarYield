import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExitImpactEstimator } from "./ExitImpactEstimator";
import React from "react";

describe("ExitImpactEstimator", () => {
  it("renders estimation for valid amount", () => {
    render(<ExitImpactEstimator amountUsd={1000} poolLiquidityUsd={100000} exitFeeBps={0} />);
    expect(screen.getByText("Exit Impact Estimate")).toBeDefined();
    // 1000 / (100000 + 1000) approx 0.99%
    expect(screen.getByText("0.99%")).toBeDefined();
  });

  it("shows high impact warning", () => {
    // 10,000 USD from 10,000 liquidity -> 50% impact
    render(<ExitImpactEstimator amountUsd={10000} poolLiquidityUsd={10000} exitFeeBps={0} />);
    expect(screen.getByText(/High price impact detected/)).toBeDefined();
    expect(screen.getByText("50.00%")).toBeDefined();
  });

  it("renders nothing for zero amount", () => {
    const { container } = render(<ExitImpactEstimator amountUsd={0} poolLiquidityUsd={10000} exitFeeBps={0} />);
    expect(container.firstChild).toBeNull();
  });
});
