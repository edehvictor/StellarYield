import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import RegistryDiffPage, { computeRegistryDiff } from "../RegistryDiff";

describe("RegistryDiff computeRegistryDiff", () => {
  it("handles null or undefined registry inputs gracefully without crashing", () => {
    const diffNull = computeRegistryDiff(null, null);
    expect(diffNull.testnet).toBeDefined();
    expect(diffNull.mainnet).toBeDefined();
    expect(diffNull.local).toBeDefined();
    expect(diffNull.testnet.every((entry) => entry.type === "unchanged")).toBe(true);

    const diffUndefined = computeRegistryDiff(undefined, undefined);
    expect(diffUndefined.testnet).toBeDefined();
  });

  it("produces deterministic alphabetical ordering of contract names", () => {
    const current = {
      testnet: {
        zap: "CDZAP123",
        vault: "CDVAULT123",
        customContract: "CDCUSTOM123",
      },
    };
    const previous = {
      testnet: {
        vault: "CDVAULT123",
        alphaContract: "CDALPHA123",
      },
    };

    const diff = computeRegistryDiff(current, previous);
    const names = diff.testnet.map((entry) => entry.name);
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));

    expect(names).toEqual(sortedNames);
    expect(names).toContain("alphaContract");
    expect(names).toContain("customContract");
  });

  it("accurately classifies added, removed, changed, and unchanged entries", () => {
    const current = {
      testnet: {
        vault: "CDVAULT_NEW",
        zap: "CDZAP_ADDED",
        token: "CDTOKEN_SAME",
        stableswap: "",
      },
    };
    const previous = {
      testnet: {
        vault: "CDVAULT_OLD",
        zap: "",
        token: "CDTOKEN_SAME",
        stableswap: "CDSTABLE_OLD",
      },
    };

    const diff = computeRegistryDiff(current, previous);
    const testnetMap = Object.fromEntries(
      diff.testnet.map((e) => [e.name, e]),
    );

    expect(testnetMap.vault.type).toBe("changed");
    expect(testnetMap.vault.oldAddr).toBe("CDVAULT_OLD");
    expect(testnetMap.vault.newAddr).toBe("CDVAULT_NEW");

    expect(testnetMap.zap.type).toBe("added");
    expect(testnetMap.zap.oldAddr).toBe("");
    expect(testnetMap.zap.newAddr).toBe("CDZAP_ADDED");

    expect(testnetMap.stableswap.type).toBe("removed");
    expect(testnetMap.stableswap.oldAddr).toBe("CDSTABLE_OLD");
    expect(testnetMap.stableswap.newAddr).toBe("");

    expect(testnetMap.token.type).toBe("unchanged");
    expect(testnetMap.token.oldAddr).toBe("CDTOKEN_SAME");
    expect(testnetMap.token.newAddr).toBe("CDTOKEN_SAME");
  });
});

describe("RegistryDiffPage rendering and snapshots", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders consistent badges and copy buttons for drift state", async () => {
    const fixtureCurrent = {
      testnet: {
        vault: "CDTESTVAULT_V2",
        zap: "CDTESTZAP_NEW",
        token: "CDTESTTOKEN",
        governance: "",
      },
      mainnet: {
        vault: "CDMAINVAULT",
      },
      local: {},
    };
    const fixturePrevious = {
      testnet: {
        vault: "CDTESTVAULT_V1",
        zap: "",
        token: "CDTESTTOKEN",
        governance: "CDGOV_REMOVED",
      },
      mainnet: {
        vault: "CDMAINVAULT",
      },
      local: {},
    };

    const { container } = render(
      <RegistryDiffPage
        currentRegistry={fixtureCurrent}
        previousRegistry={fixturePrevious}
      />,
    );

    // Verify badges
    expect(screen.getByTestId("network-panel-testnet")).toHaveTextContent("Drift Detected");
    expect(screen.getByTestId("network-panel-mainnet")).toHaveTextContent("In Sync");

    // Verify copy button works
    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    expect(copyButtons.length).toBeGreaterThan(0);

    fireEvent.click(copyButtons[0]);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
      expect(screen.getByText("Copied!")).toBeInTheDocument();
    });

    // Deterministic snapshot of rendered output
    expect(container).toMatchSnapshot();
  });

  it("renders deterministic snapshot for empty/missing registry state", () => {
    const { container } = render(
      <RegistryDiffPage
        currentRegistry={{ testnet: {}, mainnet: {}, local: {} }}
        previousRegistry={{ testnet: {}, mainnet: {}, local: {} }}
      />,
    );

    expect(screen.getByTestId("network-panel-testnet")).toHaveTextContent("In Sync");
    expect(container).toMatchSnapshot();
  });

  it("does not crash when one registry side is completely null or missing", () => {
    const { container } = render(
      <RegistryDiffPage
        currentRegistry={null}
        previousRegistry={{ testnet: { vault: "CDVAULT" } }}
      />,
    );

    expect(screen.getByTestId("network-panel-testnet")).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });
});
