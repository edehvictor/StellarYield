import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RouterUpgradePanel } from "../RouterUpgradePanel";
import * as routerService from "../routerUpgradeService";
import type { RouterUpgradeDryRunResult } from "../types";

jest.mock("../routerUpgradeService");

describe("RouterUpgradePanel Component", () => {
  const mockPerformDryRun = routerService.performRouterUpgradeDryRun as jest.MockedFunction<
    typeof routerService.performRouterUpgradeDryRun
  >;
  const mockFetchStatus = routerService.fetchRouterStatus as jest.MockedFunction<
    typeof routerService.fetchRouterStatus
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchStatus.mockResolvedValue({
      activeRouterAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      network: "testnet",
      rpcConfigured: true,
      simSourceConfigured: true,
      timestamp: "2026-10-18T12:00:00.000Z",
    });
  });

  it("renders empty state with guidance when no candidate address is entered", async () => {
    render(<RouterUpgradePanel />);

    expect(
      screen.getByText("Router Upgrade Verification & Dry-Run")
    ).toBeInTheDocument();
    expect(screen.getByTestId("dry-run-empty-state")).toBeInTheDocument();
    expect(
      screen.getByText(/Dry-Run Protocol Safety/i)
    ).toBeInTheDocument();
  });

  it("handles loading state during dry-run simulation", async () => {
    let resolveDryRun: (value: RouterUpgradeDryRunResult) => void;
    mockPerformDryRun.mockReturnValue(
      new Promise((resolve) => {
        resolveDryRun = resolve;
      })
    );

    render(<RouterUpgradePanel defaultCandidateAddress="CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM" />);

    const submitBtn = screen.getByTestId("dry-run-submit-btn");
    fireEvent.click(submitBtn);

    expect(screen.getByTestId("dry-run-loading-state")).toBeInTheDocument();
    expect(submitBtn).toBeDisabled();

    // Finish simulation
    resolveDryRun!({
      success: true,
      status: "READY",
      summary: "Router invocation dry-run succeeded.",
      candidateRouterAddress: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM",
      currentRouterAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      targetContract: "zap",
      checks: [
        {
          id: "address_format",
          label: "Address Format Validation",
          passed: true,
          message: "Valid contract ID",
        },
      ],
      timestamp: "2026-10-18T12:00:00.000Z",
    });

    await waitFor(() => {
      expect(screen.queryByTestId("dry-run-loading-state")).not.toBeInTheDocument();
    });
  });

  it("renders normal/success state with READY badge, checks, and simulation metrics", async () => {
    mockPerformDryRun.mockResolvedValue({
      success: true,
      status: "READY",
      summary: "Router invocation dry-run succeeded. Safe to proceed with router upgrade.",
      candidateRouterAddress: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM",
      currentRouterAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      targetContract: "zap",
      checks: [
        {
          id: "address_format",
          label: "Address Format Validation",
          passed: true,
          message: "Valid format",
        },
        {
          id: "different_address",
          label: "New Address Verification",
          passed: true,
          message: "Differs from active router",
        },
        {
          id: "interface_conformance",
          label: "Interface Conformance Check",
          passed: true,
          message: "Conforms to swap interface",
        },
        {
          id: "invocation_dry_run",
          label: "Simulated Contract Invocation",
          passed: true,
          message: "Simulated execution succeeded",
        },
      ],
      simulation: {
        expectedAmountOutStroops: "9800000",
        simulatedCpuInstructions: 1250000,
        simulatedMemoryBytes: 42000,
        simulatedFeeStroops: "100",
      },
      timestamp: "2026-10-18T12:00:00.000Z",
    });

    const onApprove = jest.fn();
    render(
      <RouterUpgradePanel
        defaultCandidateAddress="CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM"
        onUpgradeApproved={onApprove}
      />
    );

    fireEvent.click(screen.getByTestId("dry-run-submit-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("dry-run-status-badge")).toHaveTextContent("READY");
    });

    expect(screen.getByTestId("metric-expected-out")).toHaveTextContent("9800000 stroops");
    expect(screen.getByTestId("metric-cpu-instructions")).toHaveTextContent("1,250,000");
    expect(screen.getByTestId("check-item-address_format")).toBeInTheDocument();
    expect(screen.getByTestId("check-item-interface_conformance")).toBeInTheDocument();

    const approveBtn = screen.getByTestId("approve-upgrade-btn");
    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("renders failure state with stable typed error and remediation on invalid address", async () => {
    mockPerformDryRun.mockResolvedValue({
      success: false,
      status: "BLOCKED",
      summary: "Router upgrade blocked: candidate address format is invalid.",
      candidateRouterAddress: "invalid-id",
      currentRouterAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      targetContract: "zap",
      checks: [
        {
          id: "address_format",
          label: "Address Format Validation",
          passed: false,
          message: "Candidate address is not a valid 56-character Soroban contract ID.",
        },
      ],
      error: {
        code: "INVALID_ADDRESS_FORMAT",
        message: "Address 'invalid-id' is not a valid Stellar contract ID.",
        remediation: "Ensure the contract address is exactly 56 alphanumeric characters and begins with 'C'.",
      },
      timestamp: "2026-10-18T12:00:00.000Z",
    });

    render(<RouterUpgradePanel defaultCandidateAddress="invalid-id" />);

    fireEvent.click(screen.getByTestId("dry-run-submit-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("dry-run-status-badge")).toHaveTextContent("BLOCKED");
    });

    expect(screen.getByTestId("dry-run-error-card")).toBeInTheDocument();
    expect(screen.getByTestId("dry-run-error-code")).toHaveTextContent("INVALID_ADDRESS_FORMAT");
    expect(screen.getByTestId("dry-run-error-message")).toHaveTextContent("Address 'invalid-id' is not a valid Stellar contract ID.");
    expect(screen.getByTestId("dry-run-error-remediation")).toHaveTextContent("Ensure the contract address is exactly 56 alphanumeric characters");
    expect(screen.queryByTestId("approve-upgrade-btn")).not.toBeInTheDocument();
  });

  it("renders failure state on interface mismatch", async () => {
    mockPerformDryRun.mockResolvedValue({
      success: false,
      status: "BLOCKED",
      summary: "Router dry-run failed: Candidate router does not conform to the expected DEX router swap interface.",
      candidateRouterAddress: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM",
      currentRouterAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      targetContract: "zap",
      checks: [
        {
          id: "address_format",
          label: "Address Format Validation",
          passed: true,
          message: "Valid contract ID",
        },
        {
          id: "invocation_dry_run",
          label: "Simulated Contract Invocation",
          passed: false,
          message: "Candidate router does not conform to the expected DEX router swap interface.",
        },
      ],
      error: {
        code: "INTERFACE_MISMATCH",
        message: "Candidate router does not conform to the expected DEX router swap interface.",
        remediation: "Ensure the contract implements swap(from: Address, to: Address, amount_in: i128, min_out: i128) -> i128.",
      },
      timestamp: "2026-10-18T12:00:00.000Z",
    });

    render(<RouterUpgradePanel defaultCandidateAddress="CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM" />);

    fireEvent.click(screen.getByTestId("dry-run-submit-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("dry-run-error-code")).toHaveTextContent("INTERFACE_MISMATCH");
    });

    expect(screen.getByTestId("dry-run-error-remediation")).toHaveTextContent("Ensure the contract implements swap");
  });
});
