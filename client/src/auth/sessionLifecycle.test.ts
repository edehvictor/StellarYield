import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "./walletAdapters";
import {
  clearStoredSession,
  connectWalletSession,
  recoverSession,
  WalletLifecycleError,
} from "./session";
import type { WalletAdapter } from "./walletAdapters";

vi.mock("@albedo-link/intent", () => ({ default: {} }));
vi.mock("@stellar/freighter-api", () => ({
  getAddress: vi.fn(),
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));
vi.mock("@creit.tech/xbull-wallet-connect", () => ({
  xBullWalletConnect: vi.fn(),
}));
vi.mock("./walletAdapters", () => ({ getAdapter: vi.fn() }));

const STORAGE_KEY = "stellar-yield.wallet-session";
const walletAddress = "GBJKSX33PDI67V4CNWSIBRNDRLAV2HPWGOJJBNL5GK7WRVYSDS3WBHL7";
const previousWalletAddress = "GBK2O2DY4DRH2CITGJMXN5PIRFTJ5U5SV5UDLRV73Z7LAPLKRNCRJOBN";
const adapter: WalletAdapter = {
  id: "freighter",
  label: "Freighter",
  isAvailable: vi.fn().mockResolvedValue(true),
  getPublicKey: vi.fn().mockResolvedValue(walletAddress),
  signTransaction: vi.fn().mockResolvedValue("signed-xdr"),
};

function storedSession(address: string) {
  return {
    walletAddress: address,
    walletAddressType: "account",
    providerId: "freighter",
    providerLabel: "Freighter",
    verificationStatus: "verified",
  };
}

describe("wallet session lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(getAdapter).mockReturnValue(adapter);
    vi.mocked(adapter.isAvailable).mockResolvedValue(true);
    vi.mocked(adapter.getPublicKey).mockResolvedValue(walletAddress);
  });

  it("persists a validated connection after normal operation", async () => {
    const session = await connectWalletSession({ providerId: "freighter" });

    expect(session.walletAddress).toBe(walletAddress);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      walletAddress,
      providerId: "freighter",
    });
  });

  it("preserves the prior session and reports a safe stage when authorization fails", async () => {
    const previousSession = storedSession(previousWalletAddress);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(previousSession));
    vi.mocked(adapter.getPublicKey).mockRejectedValue(
      new Error("provider leaked account and request details"),
    );

    const error = await connectWalletSession({ providerId: "freighter" }).catch(
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({
      name: "WalletLifecycleError",
      stage: "wallet_authorization",
      remediation: expect.stringContaining("Approve the connection request"),
    });
    expect((error as Error).message).not.toContain("provider leaked");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(previousSession);
  });

  it("rejects an invalid public key without replacing the existing session", async () => {
    const previousSession = storedSession(previousWalletAddress);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(previousSession));
    vi.mocked(adapter.getPublicKey).mockResolvedValue("not-a-stellar-key");

    await expect(
      connectWalletSession({ providerId: "freighter" }),
    ).rejects.toMatchObject({
      name: "WalletLifecycleError",
      stage: "address_validation",
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(previousSession);
  });

  it("allows a safe retry after a failed wallet authorization", async () => {
    vi.mocked(adapter.getPublicKey)
      .mockRejectedValueOnce(new Error("wallet details"))
      .mockResolvedValueOnce(walletAddress);

    await expect(
      connectWalletSession({ providerId: "freighter" }),
    ).rejects.toBeInstanceOf(WalletLifecycleError);

    const session = await connectWalletSession({ providerId: "freighter" });
    expect(session.walletAddress).toBe(walletAddress);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null").walletAddress)
      .toBe(walletAddress);
  });

  it("rejects a stale concurrent connection and allows a fresh retry", async () => {
    let finishFirstConnection!: (address: string) => void;
    let markFirstConnectionStarted!: () => void;
    const firstConnectionStarted = new Promise<void>((resolve) => {
      markFirstConnectionStarted = resolve;
    });
    vi.mocked(adapter.getPublicKey)
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishFirstConnection = resolve;
            markFirstConnectionStarted();
          }),
      )
      .mockResolvedValueOnce(previousWalletAddress);

    const firstConnection = connectWalletSession({ providerId: "freighter" });
    await firstConnectionStarted;
    const winningConnection = await connectWalletSession({ providerId: "freighter" });
    finishFirstConnection(walletAddress);

    await expect(firstConnection).rejects.toMatchObject({
      name: "WalletLifecycleError",
      stage: "session_conflict",
    });
    expect(winningConnection.walletAddress).toBe(previousWalletAddress);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null").walletAddress)
      .toBe(previousWalletAddress);

    const retry = await connectWalletSession({ providerId: "freighter" });
    expect(retry.walletAddress).toBe(walletAddress);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null").walletAddress)
      .toBe(walletAddress);
  });

  it("does not restore a stale session after a concurrent disconnect", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storedSession(previousWalletAddress)));
    let finishAvailabilityCheck!: (available: boolean) => void;
    let markAvailabilityCheckStarted!: () => void;
    const availabilityCheckStarted = new Promise<void>((resolve) => {
      markAvailabilityCheckStarted = resolve;
    });
    vi.mocked(adapter.isAvailable).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishAvailabilityCheck = resolve;
          markAvailabilityCheckStarted();
        }),
    );

    const recovery = recoverSession();
    await availabilityCheckStarted;
    await clearStoredSession();
    finishAvailabilityCheck(true);

    await expect(recovery).resolves.toMatchObject({
      status: "superseded",
      session: null,
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("preserves the prior session when persistence fails", async () => {
    const previousSession = storedSession(previousWalletAddress);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(previousSession));
    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === STORAGE_KEY) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });

    try {
      await expect(
        connectWalletSession({ providerId: "freighter" }),
      ).rejects.toMatchObject({
        name: "WalletLifecycleError",
        stage: "session_persistence",
      });
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(previousSession);
    } finally {
      setItemSpy.mockRestore();
    }
  });
});
