import { describe, it, expect, beforeEach } from "vitest";
import {
  savePreferenceCheckpoint,
  getPreferenceCheckpoint,
  clearPreferenceCheckpoint,
  canResumeCheckpoint,
  canRollbackCheckpoint,
  getCheckpointStorageKey,
  type ClientAlertPreferenceCheckpoint,
} from "../alertPreferenceOperation";
import type { AlertPreferences } from "../types";

describe("alertPreferenceOperation client checkpointing", () => {
  const wallet = "GDEMO12345";
  const vault = "USDC-Vault";

  const targetPreferences: AlertPreferences = {
    walletAddress: wallet,
    vaultId: vault,
    emailAlertsEnabled: true,
    email: "trader@example.com",
    browserAlertsEnabled: false,
    severityThreshold: "medium",
    cooldownMinutes: 30,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
  };

  const previousPreferences: AlertPreferences = {
    walletAddress: wallet,
    vaultId: vault,
    emailAlertsEnabled: false,
    email: "",
    browserAlertsEnabled: true,
    severityThreshold: "low",
    cooldownMinutes: 15,
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("computes case-insensitive storage key", () => {
    const key1 = getCheckpointStorageKey("GDEMO", "VAULT-1");
    const key2 = getCheckpointStorageKey("gdemo", "vault-1");
    expect(key1).toBe(key2);
    expect(key1).toBe("stellar-yield.alert-pref-checkpoint.gdemo.vault-1");
  });

  it("persists checkpoint in localStorage and retrieves it", () => {
    const checkpoint: ClientAlertPreferenceCheckpoint = {
      operationId: "op-test-1",
      walletAddress: wallet,
      vaultId: vault,
      targetPreferences,
      previousPreferences,
      status: "staged",
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    savePreferenceCheckpoint(checkpoint);
    const retrieved = getPreferenceCheckpoint(wallet, vault);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.operationId).toBe("op-test-1");
    expect(retrieved?.status).toBe("staged");
    expect(retrieved?.targetPreferences.email).toBe("trader@example.com");
    expect(retrieved?.previousPreferences?.browserAlertsEnabled).toBe(true);
  });

  it("clears checkpoint successfully", () => {
    const checkpoint: ClientAlertPreferenceCheckpoint = {
      operationId: "op-test-2",
      walletAddress: wallet,
      vaultId: vault,
      targetPreferences,
      previousPreferences: null,
      status: "failed",
      attemptCount: 2,
      error: "Network timeout",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    savePreferenceCheckpoint(checkpoint);
    expect(getPreferenceCheckpoint(wallet, vault)).not.toBeNull();

    clearPreferenceCheckpoint(wallet, vault);
    expect(getPreferenceCheckpoint(wallet, vault)).toBeNull();
  });

  it("evaluates canResumeCheckpoint correctly for various statuses", () => {
    expect(canResumeCheckpoint(null)).toBe(false);

    const baseCheckpoint: ClientAlertPreferenceCheckpoint = {
      operationId: "op-3",
      walletAddress: wallet,
      vaultId: vault,
      targetPreferences,
      previousPreferences,
      status: "failed",
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(canResumeCheckpoint(baseCheckpoint)).toBe(true);
    expect(canResumeCheckpoint({ ...baseCheckpoint, status: "submitting" })).toBe(true);
    expect(canResumeCheckpoint({ ...baseCheckpoint, status: "staged" })).toBe(true);
    expect(canResumeCheckpoint({ ...baseCheckpoint, status: "succeeded" })).toBe(false);
    expect(canResumeCheckpoint({ ...baseCheckpoint, status: "rolled_back" })).toBe(false);
  });

  it("evaluates canRollbackCheckpoint correctly", () => {
    expect(canRollbackCheckpoint(null)).toBe(false);

    const baseCheckpoint: ClientAlertPreferenceCheckpoint = {
      operationId: "op-4",
      walletAddress: wallet,
      vaultId: vault,
      targetPreferences,
      previousPreferences,
      status: "failed",
      attemptCount: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(canRollbackCheckpoint(baseCheckpoint)).toBe(true);
    expect(canRollbackCheckpoint({ ...baseCheckpoint, status: "staged" })).toBe(true);
    expect(canRollbackCheckpoint({ ...baseCheckpoint, status: "succeeded" })).toBe(false);
    expect(canRollbackCheckpoint({ ...baseCheckpoint, status: "rolled_back" })).toBe(false);
  });
});
