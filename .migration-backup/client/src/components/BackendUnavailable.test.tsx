import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BackendUnavailable,
  BackendUnavailableAlert,
} from "./BackendUnavailable";

describe("BackendUnavailable", () => {
  it("renders with feature name", () => {
    render(
      <BackendUnavailable featureName="Strategy Comparison" />
    );
    expect(screen.getByText("Strategy Comparison Temporarily Unavailable")).toBeInTheDocument();
  });

  it("renders with custom reason", () => {
    const reason = "Custom error message";
    render(
      <BackendUnavailable featureName="Test Feature" reason={reason} />
    );
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("renders default reason when not provided", () => {
    render(
      <BackendUnavailable featureName="Test Feature" />
    );
    expect(
      screen.getByText(/The backend service is not currently available/)
    ).toBeInTheDocument();
  });

  it("renders with retry button when onRetry is provided", () => {
    const onRetry = vi.fn();
    render(
      <BackendUnavailable featureName="Test Feature" onRetry={onRetry} />
    );
    const button = screen.getByRole("button", { name: /Try Again/i });
    expect(button).toBeInTheDocument();
  });

  it("calls onRetry when retry button is clicked", async () => {
    const onRetry = vi.fn();
    render(
      <BackendUnavailable featureName="Test Feature" onRetry={onRetry} />
    );
    const button = screen.getByRole("button", { name: /Try Again/i });
    await userEvent.click(button);
    expect(onRetry).toHaveBeenCalled();
  });

  it("renders compact version when compact prop is true", () => {
    render(
      <BackendUnavailable featureName="Test Feature" compact={true} />
    );
    expect(screen.getByText("Test Feature unavailable")).toBeInTheDocument();
  });

  it("compact version shows feature name and unavailable message", () => {
    render(
      <BackendUnavailable featureName="Yield Data" compact={true} />
    );
    expect(screen.getByText("Yield Data unavailable")).toBeInTheDocument();
  });

  it("compact version with retry button", async () => {
    const onRetry = vi.fn();
    render(
      <BackendUnavailable featureName="Test Feature" onRetry={onRetry} compact={true} />
    );
    const buttons = screen.getAllByRole("button");
    await userEvent.click(buttons[0]); // Click the retry button in compact version
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("BackendUnavailableAlert", () => {
  it("renders with default message", () => {
    render(<BackendUnavailableAlert />);
    expect(
      screen.getByText("Backend service unavailable")
    ).toBeInTheDocument();
  });

  it("renders with custom message", () => {
    const message = "Yield data is temporarily unavailable";
    render(<BackendUnavailableAlert message={message} />);
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("renders dismiss button when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    render(<BackendUnavailableAlert onDismiss={onDismiss} />);
    const button = screen.getByRole("button", { name: "✕" });
    expect(button).toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    render(<BackendUnavailableAlert onDismiss={onDismiss} />);
    const button = screen.getByRole("button", { name: "✕" });
    await userEvent.click(button);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("has proper styling for alert", () => {
    const { container } = render(<BackendUnavailableAlert />);
    const alert = container.querySelector(".rounded-lg");
    expect(alert).toHaveClass("bg-amber-500/10");
    expect(alert).toHaveClass("border");
    expect(alert).toHaveClass("border-amber-500/20");
  });
});
