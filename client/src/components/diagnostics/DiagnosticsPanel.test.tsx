import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DiagnosticsPanel from "./DiagnosticsPanel";

// Mock the useWallet hook
vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    isConnected: true,
    walletAddress: "GAYOAUGI465BOMRPHU233EHR2C7Q6X3TGVH3D4U3N7RPA73GZ3A2T3W2",
  }),
}));

// Mock the contracts registry JSON
vi.mock("../../../../contracts/registry.json", () => ({
  default: {
    testnet: {
      vault: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
      zap: "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ",
      token: "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3",
      governance: "CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW",
      strategy: "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U",
      emissionController: "CADAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMSST",
      liquidStaking: "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR",
      stableswap: "CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ",
      vesting: "CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L",
    },
    mainnet: {},
    local: {},
  },
}));

describe("DiagnosticsPanel Component (#1037)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders diagnostics header and 4 dependency sections", () => {
    render(<DiagnosticsPanel />);

    expect(screen.getByText("System & Environment Diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Backend API")).toBeInTheDocument();
    expect(screen.getByText("Wallet Provider")).toBeInTheDocument();
    expect(screen.getByText("Stellar Network")).toBeInTheDocument();
    expect(screen.getByText("Contract Registry")).toBeInTheDocument();
    expect(screen.getByText("Registered Contracts Breakdown")).toBeInTheDocument();
  });

  it("handles copy report action", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<DiagnosticsPanel />);

    const copyBtn = screen.getByTitle("Copy sanitized diagnostics JSON for troubleshooting");
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    const jsonCopied = writeTextMock.mock.calls[0][0];
    expect(jsonCopied).toContain("overallStatus");
  });

  it("handles recheck refresh action", async () => {
    render(<DiagnosticsPanel />);

    const recheckBtn = screen.getByTitle("Refresh system diagnostics");
    fireEvent.click(recheckBtn);

    expect(screen.getByText("Checking...")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<DiagnosticsPanel onClose={onClose} />);

    const closeBtn = screen.getByLabelText("Close diagnostics");
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
