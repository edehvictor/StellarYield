/**
 * Client-Side Durable Alert Preference Checkpointing (#1907)
 *
 * Persists enough state to localStorage so an alert preference operation that
 * partially completes, fails, or is interrupted (e.g., page refresh, network drop)
 * can be resumed or rolled back predictably.
 */

import type { AlertPreferences } from "./types";

export type ClientAlertPreferenceOperationStatus =
  | "staged"
  | "submitting"
  | "failed"
  | "succeeded"
  | "rolled_back";

export interface ClientAlertPreferenceCheckpoint {
  operationId: string;
  walletAddress: string;
  vaultId: string;
  targetPreferences: AlertPreferences;
  previousPreferences: AlertPreferences | null;
  status: ClientAlertPreferenceOperationStatus;
  attemptCount: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const CHECKPOINT_PREFIX = "stellar-yield.alert-pref-checkpoint";

export function getCheckpointStorageKey(walletAddress: string, vaultId: string): string {
  return `${CHECKPOINT_PREFIX}.${walletAddress.trim().toLowerCase()}.${vaultId.trim().toLowerCase()}`;
}

export function savePreferenceCheckpoint(
  checkpoint: ClientAlertPreferenceCheckpoint,
): void {
  try {
    const key = getCheckpointStorageKey(checkpoint.walletAddress, checkpoint.vaultId);
    window.localStorage.setItem(key, JSON.stringify(checkpoint));
  } catch {
    // Ignore storage quota or disabled storage errors
  }
}

export function getPreferenceCheckpoint(
  walletAddress: string,
  vaultId: string,
): ClientAlertPreferenceCheckpoint | null {
  try {
    const key = getCheckpointStorageKey(walletAddress, vaultId);
    const data = window.localStorage.getItem(key);
    if (!data) return null;
    return JSON.parse(data) as ClientAlertPreferenceCheckpoint;
  } catch {
    return null;
  }
}

export function clearPreferenceCheckpoint(
  walletAddress: string,
  vaultId: string,
): void {
  try {
    const key = getCheckpointStorageKey(walletAddress, vaultId);
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export function canResumeCheckpoint(
  checkpoint: ClientAlertPreferenceCheckpoint | null,
): boolean {
  return Boolean(
    checkpoint &&
      (checkpoint.status === "failed" ||
        checkpoint.status === "staged" ||
        checkpoint.status === "submitting"),
  );
}

export function canRollbackCheckpoint(
  checkpoint: ClientAlertPreferenceCheckpoint | null,
): boolean {
  return Boolean(
    checkpoint &&
      checkpoint.status !== "succeeded" &&
      checkpoint.status !== "rolled_back",
  );
}
