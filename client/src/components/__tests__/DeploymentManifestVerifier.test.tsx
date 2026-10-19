import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DeploymentManifestVerifier from "../DeploymentManifestVerifier";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const baseData = {
  network: "testnet",
  manifestPath: "contracts/scripts/deployment-manifest.json",
  registrySource: "contracts/registry.json",
  schemaPath: "contracts/scripts/manifest-schema.json",
  schemaVersion: "1.0",
};

const verifiedData = {
  ...baseData,
  status: "verified",
  issues: [],
  contracts: [
    { name: "yield_vault", manifestAddress: "CAAA...SC4", registryAddress: "CAAA...SC4", status: "MATCH" },
    { name: "zap", manifestAddress: "CBBB...SC4", registryAddress: "CBBB...SC4", status: "MATCH" },
  ],
};

const staleData = {
  ...baseData,
  status: "drift",
  issues: [{ code: "DRIFT", message: "contract \"zap\": manifest has CCCC but registry has no address." }],
  contracts: [
    { name: "yield_vault", manifestAddress: "CAAA...SC4", registryAddress: "CAAA...SC4", status: "MATCH" },
    { name: "zap", manifestAddress: "CCCC...SC4", registryAddress: "", status: "STALE" },
  ],
};

const pendingData = {
  ...baseData,
  schemaVersion: null,
  status: "pending_generation",
  issues: [{ code: "MANIFEST_MALFORMED", message: "No deployment manifest found." }],
  contracts: [],
};

describe("DeploymentManifestVerifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: verifiedData }) });
  });

  it("renders the verified state with matching contracts", async () => {
    render(<DeploymentManifestVerifier />);
    await waitFor(() => expect(screen.getByText("Verified")).toBeInTheDocument());
    expect(screen.getByText("yield_vault")).toBeInTheDocument();
    expect(screen.getAllByText("Match").length).toBe(2);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/contracts/deployment-manifest/verify"));
  });

  it("renders drift issues when registry and manifest disagree", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: staleData }) });
    render(<DeploymentManifestVerifier />);
    await waitFor(() => expect(screen.getByText("Drift detected")).toBeInTheDocument());
    expect(screen.getByText("DRIFT")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("refetches when the network changes", async () => {
    render(<DeploymentManifestVerifier />);
    await waitFor(() => expect(screen.getByText("Verified")).toBeInTheDocument());
    fireEvent.click(screen.getByText("mainnet"));
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("network=mainnet")),
    );
  });

  it("surfaces fetch errors", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ ok: false }) });
    render(<DeploymentManifestVerifier />);
    await waitFor(() => expect(screen.getByText(/Server returned/)).toBeInTheDocument());
  });

  it("renders the pending_generation hint when no manifest exists", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: pendingData }) });
    render(<DeploymentManifestVerifier />);
    await waitFor(() => expect(screen.getByText("No manifest yet")).toBeInTheDocument());
    expect(screen.getByText(/No deployment manifest found/)).toBeInTheDocument();
  });
});