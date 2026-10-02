/**
 * Tests for useProtectedWalletAction (issue #1152).
 *
 * Verifies the core state machine independent of any specific consumer
 * component: a protected action runs immediately when the session is
 * valid; is captured (not run) and surfaces recovery when the session is
 * expired or disconnected; resumes via reconnect or retry; and can be
 * cancelled without ever running.
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useProtectedWalletAction } from "../useProtectedWalletAction";

let mockIsConnected = true;
let mockIsSessionExpired = false;
const mockConnectWallet = vi.fn();

vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    isConnected: mockIsConnected,
    isSessionExpired: mockIsSessionExpired,
    connectWallet: mockConnectWallet,
    providerId: "freighter",
  }),
}));

describe("useProtectedWalletAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected = true;
    mockIsSessionExpired = false;
    mockConnectWallet.mockResolvedValue(true);
  });

  it("runs the action immediately when the session is valid", async () => {
    const { result } = renderHook(() => useProtectedWalletAction());
    const action = vi.fn();

    let ran = false;
    await act(async () => {
      ran = await result.current.runProtected("Test action", action);
    });

    expect(ran).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.pendingRecovery).toBeNull();
  });

  it("captures the action instead of running it when the session is expired", async () => {
    mockIsSessionExpired = true;
    const { result } = renderHook(() => useProtectedWalletAction());
    const action = vi.fn();

    let ran = true;
    await act(async () => {
      ran = await result.current.runProtected("Quote preview", action);
    });

    expect(ran).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(result.current.pendingRecovery).toEqual({ label: "Quote preview" });
  });

  it("captures the action instead of running it when the wallet is disconnected", async () => {
    mockIsConnected = false;
    const { result } = renderHook(() => useProtectedWalletAction());
    const action = vi.fn();

    await act(async () => {
      await result.current.runProtected("Transaction submission", action);
    });

    expect(action).not.toHaveBeenCalled();
    expect(result.current.pendingRecovery).toEqual({ label: "Transaction submission" });
  });

  it("resumes the captured action after a successful reconnect", async () => {
    mockIsSessionExpired = true;
    const { result } = renderHook(() => useProtectedWalletAction());
    const action = vi.fn();

    await act(async () => {
      await result.current.runProtected("Zap deposit", action);
    });
    expect(action).not.toHaveBeenCalled();

    mockConnectWallet.mockImplementation(async () => {
      mockIsSessionExpired = false;
      return true;
    });

    await act(async () => {
      await result.current.reconnectAndResume();
    });

    expect(mockConnectWallet).toHaveBeenCalledWith({ providerId: "freighter" });
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.pendingRecovery).toBeNull();
  });

  it("does not resume when reconnect fails", async () => {
    mockIsSessionExpired = true;
    const { result } = renderHook(() => useProtectedWalletAction());
    const action = vi.fn();

    await act(async () => {
      await result.current.runProtected("Zap deposit", action);
    });

    mockConnectWallet.mockResolvedValue(false);

    await act(async () => {
      await result.current.reconnectAndResume();
    });

    expect(action).not.toHaveBeenCalled();
    // Recovery state persists so the user can try again.
    expect(result.current.pendingRecovery).toEqual({ label: "Zap deposit" });
  });

  it("does not resume on retry while the session is still expired", async () => {
    mockIsSessionExpired = true;
    const { result } = renderHook(() => useProtectedWalletAction());
    const action = vi.fn();

    await act(async () => {
      await result.current.runProtected("Withdraw", action);
    });

    await act(async () => {
      await result.current.retryPending();
    });

    expect(action).not.toHaveBeenCalled();
    expect(result.current.pendingRecovery).toEqual({ label: "Withdraw" });
  });

  it("resumes on retry once the session becomes valid again without a reconnect call", async () => {
    mockIsSessionExpired = true;
    const { result, rerender } = renderHook(() => useProtectedWalletAction());
    const action = vi.fn();

    await act(async () => {
      await result.current.runProtected("Withdraw", action);
    });

    mockIsSessionExpired = false;
    rerender();

    await act(async () => {
      await result.current.retryPending();
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(mockConnectWallet).not.toHaveBeenCalled();
  });

  it("discards the captured action on cancel", async () => {
    mockIsSessionExpired = true;
    const { result } = renderHook(() => useProtectedWalletAction());
    const action = vi.fn();

    await act(async () => {
      await result.current.runProtected("Withdraw", action);
    });

    act(() => {
      result.current.cancelPending();
    });

    expect(result.current.pendingRecovery).toBeNull();

    mockIsSessionExpired = false;
    await act(async () => {
      await result.current.retryPending();
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("sets isReconnecting while a reconnect is in flight", async () => {
    mockIsSessionExpired = true;
    const { result } = renderHook(() => useProtectedWalletAction());
    await act(async () => {
      await result.current.runProtected("Withdraw", vi.fn());
    });

    let resolveConnect!: (value: boolean) => void;
    mockConnectWallet.mockImplementation(
      () => new Promise<boolean>((resolve) => (resolveConnect = resolve)),
    );

    act(() => {
      void result.current.reconnectAndResume();
    });

    await waitFor(() => expect(result.current.isReconnecting).toBe(true));

    await act(async () => {
      resolveConnect(true);
    });

    await waitFor(() => expect(result.current.isReconnecting).toBe(false));
  });
});
