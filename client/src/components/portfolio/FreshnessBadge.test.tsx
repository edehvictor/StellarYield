import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import FreshnessBadge from "./FreshnessBadge";

describe("FreshnessBadge", () => {
  it("renders a Fresh label for fresh status", () => {
    render(<FreshnessBadge status="fresh" ageSeconds={30} />);
    expect(screen.getByText(/Fresh/i)).toBeInTheDocument();
  });

  it("renders a Stale label for stale status", () => {
    render(<FreshnessBadge status="stale" ageSeconds={3600} />);
    expect(screen.getByText(/Stale/i)).toBeInTheDocument();
  });

  it("renders an Unknown label for unknown status", () => {
    render(<FreshnessBadge status="unknown" ageSeconds={null} />);
    expect(screen.getByText(/Unknown/i)).toBeInTheDocument();
  });

  it("includes the age in the label when provided", () => {
    render(<FreshnessBadge status="fresh" ageSeconds={45} />);
    expect(screen.getByText(/45s ago/i)).toBeInTheDocument();
  });

  it("omits an age suffix when ageSeconds is null", () => {
    render(<FreshnessBadge status="unknown" ageSeconds={null} />);
    expect(screen.queryByText(/ago/i)).not.toBeInTheDocument();
  });

  it("exposes an accessible status role", () => {
    render(<FreshnessBadge status="stale" ageSeconds={120} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});