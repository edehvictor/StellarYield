/**
 * Tests for the RequireOnboarding route guard.
 *
 * Covers:
 *  - Completed onboarding (connected + valid session) → renders children
 *  - Not connected → redirects to "/"
 *  - Session expired → redirects to "/"
 *  - Connecting in progress → renders null (deferred check)
 *  - "network" requirement with missing network → redirects
 *  - "profile" requirement with degraded verification → redirects
 *  - "profile" requirement fully met → renders children
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { WalletContext, type WalletContextValue } from "../context/WalletContextObject";
import RequireOnboarding from "../components/common/RequireOnboarding";

// ── Mock session module ──────────────────────────────────────────────────

vi.mock("../auth/session", () => ({
  loadStoredSession: vi.fn(),
  isSessionExpired: vi.fn(),
}));

import { loadStoredSession, isSessionExpired } from "../auth/session";

const mockLoadStoredSession = vi.mocked(loadStoredSession);
const mockIsSessionExpired = vi.mocked(isSessionExpired);

// ── Helpers ───────────────────────────────────────────────────────────────

const PROTECTED_CONTENT = "Protected Content";
const HOME_CONTENT = "Home Page";

/** Build a minimal WalletContextValue for testing. */
function makeWalletCtx(
  overrides: Partial<WalletContextValue> = {},
): WalletContextValue {
  return {
    walletAddress: "GABC123",
    walletAddressType: "account",
    providerLabel: "Freighter",
    providerId: "freighter",
    network: "mainnet",
    sessionKeyAddress: null,
    verificationStatus: "verified",
    connectedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    isConnected: true,
    isConnecting: false,
    isFreighterInstalled: true,
    errorMessage: null,
    connectWallet: vi.fn(),
    disconnectWallet: vi.fn(),
    clearError: vi.fn(),
    signTransaction: vi.fn(),
    ...overrides,
  };
}

/**
 * Render the guard inside a MemoryRouter so Navigate works.
 * The home route captures redirects so we can assert on them.
 */
function renderGuard(
  ctx: WalletContextValue,
  requirement?: "wallet" | "network" | "profile",
) {
  return render(
    <WalletContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/protected"]}>
        <Routes>
          <Route
            path="/protected"
            element={
              <RequireOnboarding require={requirement}>
                <div>{PROTECTED_CONTENT}</div>
              </RequireOnboarding>
            }
          />
          <Route path="/" element={<div>{HOME_CONTENT}</div>} />
        </Routes>
      </MemoryRouter>
    </WalletContext.Provider>,
  );
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  // By default return a valid, non-expired session
  mockLoadStoredSession.mockReturnValue({
    walletAddress: "GABC123",
    walletAddressType: "account",
    providerId: "freighter",
    providerLabel: "Freighter",
    verificationStatus: "verified",
    connectedAt: new Date().toISOString(),
  });
  mockIsSessionExpired.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("RequireOnboarding — completed onboarding", () => {
  it("renders children when wallet is connected and session is valid (default 'wallet' requirement)", () => {
    renderGuard(makeWalletCtx());
    expect(screen.getByText(PROTECTED_CONTENT)).toBeDefined();
  });

  it("renders children for 'network' requirement when network is set", () => {
    renderGuard(makeWalletCtx({ network: "mainnet" }), "network");
    expect(screen.getByText(PROTECTED_CONTENT)).toBeDefined();
  });

  it("renders children for 'profile' requirement when verified", () => {
    renderGuard(
      makeWalletCtx({ verificationStatus: "verified", network: "mainnet" }),
      "profile",
    );
    expect(screen.getByText(PROTECTED_CONTENT)).toBeDefined();
  });
});

describe("RequireOnboarding — missing wallet (not connected)", () => {
  it("redirects to '/' when isConnected is false", () => {
    renderGuard(makeWalletCtx({ isConnected: false, walletAddress: null }));
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
    expect(screen.queryByText(PROTECTED_CONTENT)).toBeNull();
  });

  it("redirects to '/' for 'network' requirement when not connected", () => {
    renderGuard(
      makeWalletCtx({ isConnected: false, walletAddress: null }),
      "network",
    );
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
  });

  it("redirects to '/' for 'profile' requirement when not connected", () => {
    renderGuard(
      makeWalletCtx({ isConnected: false, walletAddress: null }),
      "profile",
    );
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
  });
});

describe("RequireOnboarding — expired session", () => {
  it("redirects when stored session is expired even if context says connected", () => {
    mockIsSessionExpired.mockReturnValue(true);
    renderGuard(makeWalletCtx()); // isConnected=true but session expired
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
    expect(screen.queryByText(PROTECTED_CONTENT)).toBeNull();
  });

  it("redirects when no stored session exists", () => {
    mockLoadStoredSession.mockReturnValue(null);
    renderGuard(makeWalletCtx());
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
    expect(screen.queryByText(PROTECTED_CONTENT)).toBeNull();
  });
});

describe("RequireOnboarding — wallet connecting (deferred check)", () => {
  it("renders null while isConnecting is true (no redirect, no content)", () => {
    const { container } = renderGuard(
      makeWalletCtx({ isConnecting: true }),
    );
    // Nothing rendered in the container for the protected route
    expect(screen.queryByText(PROTECTED_CONTENT)).toBeNull();
    expect(screen.queryByText(HOME_CONTENT)).toBeNull();
    // The container itself exists but its output from the guard is empty
    expect(container.firstChild).toBeDefined();
  });
});

describe("RequireOnboarding — partial onboarding (network missing)", () => {
  it("redirects for 'network' requirement when network is null", () => {
    renderGuard(makeWalletCtx({ network: null }), "network");
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
    expect(screen.queryByText(PROTECTED_CONTENT)).toBeNull();
  });

  it("redirects for 'profile' requirement when network is null", () => {
    renderGuard(
      makeWalletCtx({ network: null, verificationStatus: "verified" }),
      "profile",
    );
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
  });
});

describe("RequireOnboarding — partial onboarding (profile unverified)", () => {
  it("redirects for 'profile' requirement when verificationStatus is 'degraded'", () => {
    renderGuard(
      makeWalletCtx({ verificationStatus: "degraded", network: "mainnet" }),
      "profile",
    );
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
    expect(screen.queryByText(PROTECTED_CONTENT)).toBeNull();
  });

  it("redirects for 'profile' requirement when verificationStatus is null", () => {
    renderGuard(
      makeWalletCtx({ verificationStatus: null, network: "mainnet" }),
      "profile",
    );
    expect(screen.getByText(HOME_CONTENT)).toBeDefined();
  });

  it("does NOT redirect for 'wallet' requirement when verification is degraded (wallet guard is looser)", () => {
    renderGuard(
      makeWalletCtx({ verificationStatus: "degraded" }),
      "wallet",
    );
    // wallet-only guard doesn't check verification
    expect(screen.getByText(PROTECTED_CONTENT)).toBeDefined();
  });
});

describe("RequireOnboarding — custom redirectTo", () => {
  it("respects a custom redirectTo path", () => {
    render(
      <WalletContext.Provider
        value={makeWalletCtx({ isConnected: false, walletAddress: null })}
      >
        <MemoryRouter initialEntries={["/protected"]}>
          <Routes>
            <Route
              path="/protected"
              element={
                <RequireOnboarding require="wallet" redirectTo="/setup">
                  <div>{PROTECTED_CONTENT}</div>
                </RequireOnboarding>
              }
            />
            <Route path="/setup" element={<div>Setup Page</div>} />
            <Route path="/" element={<div>{HOME_CONTENT}</div>} />
          </Routes>
        </MemoryRouter>
      </WalletContext.Provider>,
    );
    expect(screen.getByText("Setup Page")).toBeDefined();
    expect(screen.queryByText(PROTECTED_CONTENT)).toBeNull();
  });
});
