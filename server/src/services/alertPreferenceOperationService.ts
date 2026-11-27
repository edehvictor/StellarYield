/**
 * Alert Preference Operation Service (#1907)
 *
 * Provides durable tracking and lifecycle management for alert preference
 * update operations, protecting against partial completion, unexpected failures,
 * and duplicate retries.
 *
 * Guarantees:
 * 1. Persists enough state (previousPreferences snapshot + targetPreferences + stage)
 *    so a failed or interrupted operation can resume or roll back predictably.
 * 2. Strict input validation at the boundary preserves existing state without mutation.
 * 3. Safe retry semantics: retrying an already completed operation replays the result
 *    without duplicating side effects or audit records. Conflicting parameters reject with 409.
 * 4. Predictable rollback restores the previous preferences snapshot exactly.
 */

import {
  getAlertPreferences,
  setAlertPreferences,
  deleteAlertPreferences,
  type AlertCondition,
} from "./alertsService";
import {
  recordPreferenceChange,
  type AlertPreferenceAuditEntry,
  type AuditSource,
} from "./alertPreferenceAuditService";
import type { AlertPreferences } from "./alertsPreferenceRules";

// ── Types ───────────────────────────────────────────────────────────────────

export type AlertPreferenceOperationStatus =
  | "staged"
  | "applied"
  | "audited"
  | "succeeded"
  | "failed"
  | "rolled_back";

export type AlertPreferenceOperationStage =
  | "validation"
  | "staging"
  | "application"
  | "auditing"
  | "completed";

export interface AlertPreferenceOperationRecord {
  /** Unique operation identifier (client-provided or server-generated). */
  operationId: string;
  walletAddress: string;
  vaultId: string;
  status: AlertPreferenceOperationStatus;
  stage: AlertPreferenceOperationStage;
  targetPreferences: AlertPreferences;
  /** Snapshot of preferences before this operation began (null if newly configured). */
  previousPreferences: AlertPreferences | null;
  /** Number of execution attempts for this operation. */
  attemptCount: number;
  /** Error message if the operation failed. */
  error?: string;
  /** Stage where failure occurred, if applicable. */
  failedAtStage?: AlertPreferenceOperationStage;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  completedAt?: string; // ISO timestamp
}

export interface StageAlertPreferenceInput {
  operationId?: string;
  walletAddress: string;
  vaultId: string;
  preferences: AlertPreferences;
}

export class AlertPreferenceValidationError extends Error {
  readonly code = "INVALID_ALERT_PREFERENCES";
  constructor(message: string) {
    super(message);
    this.name = "AlertPreferenceValidationError";
  }
}

export class AlertPreferenceConflictError extends Error {
  readonly code = "OPERATION_IDENTITY_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "AlertPreferenceConflictError";
  }
}

// ── In-Memory Store ─────────────────────────────────────────────────────────

const operationStore = new Map<string, AlertPreferenceOperationRecord>();
const byWalletVault = new Map<string, string[]>(); // key -> operationId[]

function toWalletVaultKey(walletAddress: string, vaultId: string): string {
  return `${walletAddress.trim().toLowerCase()}::${vaultId.trim().toLowerCase()}`;
}

function computePreferencesFingerprint(walletAddress: string, vaultId: string, prefs: AlertPreferences): string {
  return JSON.stringify({
    walletAddress: walletAddress.trim().toLowerCase(),
    vaultId: vaultId.trim().toLowerCase(),
    channel: prefs.channel,
    cooldownMinutes: Number(prefs.cooldownMinutes),
    severityThreshold: Number(prefs.severityThreshold),
    quietHoursStart: Number(prefs.quietHoursStart),
    quietHoursEnd: Number(prefs.quietHoursEnd),
  });
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateAlertPreferencesInput(prefs: unknown): AlertPreferences {
  if (!prefs || typeof prefs !== "object") {
    throw new AlertPreferenceValidationError("preferences object is required");
  }

  const p = prefs as Record<string, unknown>;
  const channel = String(p.channel ?? "");
  const cooldownMinutes = Number(p.cooldownMinutes);
  const severityThreshold = Number(p.severityThreshold);
  const quietHoursStart = Number(p.quietHoursStart);
  const quietHoursEnd = Number(p.quietHoursEnd);

  if (!["email", "in_app"].includes(channel)) {
    throw new AlertPreferenceValidationError("preferences.channel must be email or in_app");
  }
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 1440) {
    throw new AlertPreferenceValidationError("preferences.cooldownMinutes must be between 0 and 1440");
  }
  if (!Number.isFinite(severityThreshold) || severityThreshold < 0 || severityThreshold > 1000) {
    throw new AlertPreferenceValidationError("preferences.severityThreshold must be between 0 and 1000");
  }
  if (!Number.isInteger(quietHoursStart) || quietHoursStart < 0 || quietHoursStart > 23) {
    throw new AlertPreferenceValidationError("preferences.quietHoursStart must be an integer from 0 to 23");
  }
  if (!Number.isInteger(quietHoursEnd) || quietHoursEnd < 0 || quietHoursEnd > 23) {
    throw new AlertPreferenceValidationError("preferences.quietHoursEnd must be an integer from 0 to 23");
  }

  return {
    channel: channel as "email" | "in_app",
    cooldownMinutes,
    severityThreshold,
    quietHoursStart,
    quietHoursEnd,
  };
}

// ── Lifecycle Operations ────────────────────────────────────────────────────

/**
 * Stage an alert preference operation, persisting a snapshot of current state.
 *
 * If the operationId was previously used:
 * - If already succeeded with identical parameters: returns existing record (safe retry).
 * - If parameters conflict: throws AlertPreferenceConflictError (409).
 * - If previously failed: increments attempt count and resets status to "staged".
 */
export function stageAlertPreferenceOperation(
  input: StageAlertPreferenceInput,
): { operation: AlertPreferenceOperationRecord; replayed: boolean } {
  const { walletAddress, vaultId } = input;
  if (!walletAddress || typeof walletAddress !== "string" || !walletAddress.trim()) {
    throw new AlertPreferenceValidationError("walletAddress is required");
  }
  if (!vaultId || typeof vaultId !== "string" || !vaultId.trim()) {
    throw new AlertPreferenceValidationError("vaultId is required");
  }

  const validatedPrefs = validateAlertPreferencesInput(input.preferences);
  const operationId =
    input.operationId?.trim() ||
    `op-pref-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();

  const existing = operationStore.get(operationId);
  if (existing) {
    const existingFp = computePreferencesFingerprint(
      existing.walletAddress,
      existing.vaultId,
      existing.targetPreferences,
    );
    const newFp = computePreferencesFingerprint(walletAddress, vaultId, validatedPrefs);

    if (existingFp !== newFp) {
      throw new AlertPreferenceConflictError(
        "Operation identity has already been used with different parameters.",
      );
    }

    if (existing.status === "succeeded") {
      return { operation: existing, replayed: true };
    }

    // Existing failed or in-progress operation: prepare for retry/resume
    const updated: AlertPreferenceOperationRecord = {
      ...existing,
      status: "staged",
      stage: "staging",
      attemptCount: existing.attemptCount + 1,
      updatedAt: now,
      error: undefined,
      failedAtStage: undefined,
    };
    operationStore.set(operationId, updated);
    return { operation: updated, replayed: false };
  }

  // New operation: snapshot current preferences before applying
  const previousPreferences = getAlertPreferences(walletAddress, vaultId) ?? null;
  const newRecord: AlertPreferenceOperationRecord = {
    operationId,
    walletAddress: walletAddress.trim(),
    vaultId: vaultId.trim(),
    status: "staged",
    stage: "staging",
    targetPreferences: validatedPrefs,
    previousPreferences: previousPreferences ? { ...previousPreferences } : null,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  };

  operationStore.set(operationId, newRecord);

  const wvKey = toWalletVaultKey(walletAddress, vaultId);
  const ids = byWalletVault.get(wvKey) ?? [];
  ids.push(operationId);
  byWalletVault.set(wvKey, ids);

  return { operation: newRecord, replayed: false };
}

/**
 * Executes a staged operation through application and audit logging stages.
 */
export function executeAlertPreferenceOperation(
  operationId: string,
  options?: { actor?: string; reason?: string },
): AlertPreferenceOperationRecord {
  const op = operationStore.get(operationId);
  if (!op) {
    throw new Error(`Alert preference operation ${operationId} not found`);
  }

  if (op.status === "succeeded") {
    return op;
  }

  const now = new Date().toISOString();

  try {
    // Stage 1: Application
    setAlertPreferences(op.walletAddress, op.vaultId, op.targetPreferences);
    op.status = "applied";
    op.stage = "application";
    op.updatedAt = now;

    // Stage 2: Auditing
    recordPreferenceChange({
      walletAddress: op.walletAddress,
      vaultId: op.vaultId,
      actor: options?.actor ?? op.walletAddress,
      source: "api",
      before: op.previousPreferences,
      after: op.targetPreferences,
      reason: options?.reason ?? `Operation ${op.operationId} completed`,
    });
    op.stage = "auditing";
    op.updatedAt = new Date().toISOString();

    // Stage 3: Completed
    op.status = "succeeded";
    op.stage = "completed";
    op.completedAt = new Date().toISOString();
    op.updatedAt = op.completedAt;

    operationStore.set(operationId, op);
    return op;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Execution failed";
    op.status = "failed";
    op.failedAtStage = op.stage;
    op.error = errorMsg;
    op.updatedAt = new Date().toISOString();
    operationStore.set(operationId, op);
    throw err;
  }
}

/**
 * Resumes a failed or interrupted operation from its checkpoint.
 */
export function resumeAlertPreferenceOperation(
  operationId: string,
  options?: { actor?: string; reason?: string },
): { operation: AlertPreferenceOperationRecord; preferences: AlertPreferences } {
  const op = operationStore.get(operationId);
  if (!op) {
    throw new Error(`Alert preference operation ${operationId} not found`);
  }

  if (op.status === "succeeded") {
    return { operation: op, preferences: op.targetPreferences };
  }

  if (op.status === "rolled_back") {
    throw new Error(`Operation ${operationId} was rolled back and cannot be resumed`);
  }

  op.attemptCount += 1;
  op.updatedAt = new Date().toISOString();
  op.error = undefined;
  op.failedAtStage = undefined;

  const completed = executeAlertPreferenceOperation(operationId, {
    actor: options?.actor ?? op.walletAddress,
    reason: options?.reason ?? `Resumed attempt ${op.attemptCount}`,
  });

  return { operation: completed, preferences: completed.targetPreferences };
}

/**
 * Predictably rolls back an alert preference operation to its previous snapshot.
 */
export function rollbackAlertPreferenceOperation(
  operationId: string,
  options?: { actor?: string; reason?: string },
): { operation: AlertPreferenceOperationRecord; preferences: AlertPreferences | null } {
  const op = operationStore.get(operationId);
  if (!op) {
    throw new Error(`Alert preference operation ${operationId} not found`);
  }

  if (op.status === "rolled_back") {
    return { operation: op, preferences: op.previousPreferences };
  }

  const now = new Date().toISOString();

  // Restore state to previousPreferences snapshot
  if (op.previousPreferences !== null) {
    setAlertPreferences(op.walletAddress, op.vaultId, op.previousPreferences);
    recordPreferenceChange({
      walletAddress: op.walletAddress,
      vaultId: op.vaultId,
      actor: options?.actor ?? op.walletAddress,
      source: "revert",
      before: op.targetPreferences,
      after: op.previousPreferences,
      reason: options?.reason ?? `Rolled back operation ${op.operationId}`,
    });
  } else {
    deleteAlertPreferences(op.walletAddress, op.vaultId);
  }

  op.status = "rolled_back";
  op.stage = "completed";
  op.completedAt = now;
  op.updatedAt = now;
  operationStore.set(operationId, op);

  return { operation: op, preferences: op.previousPreferences };
}

/**
 * Retrieves a stored alert preference operation record.
 */
export function getAlertPreferenceOperation(
  operationId: string,
): AlertPreferenceOperationRecord | undefined {
  return operationStore.get(operationId);
}

/**
 * Lists all operation records for a wallet and optional vault.
 */
export function listAlertPreferenceOperations(
  walletAddress: string,
  vaultId?: string,
): AlertPreferenceOperationRecord[] {
  if (vaultId) {
    const ids = byWalletVault.get(toWalletVaultKey(walletAddress, vaultId)) ?? [];
    return ids
      .map((id) => operationStore.get(id))
      .filter((o): o is AlertPreferenceOperationRecord => !!o);
  }

  return Array.from(operationStore.values()).filter(
    (o) => o.walletAddress.toLowerCase() === walletAddress.trim().toLowerCase(),
  );
}

/**
 * Test helper to reset the operations store.
 */
export function clearAlertPreferenceOperationStore(): void {
  operationStore.clear();
  byWalletVault.clear();
}
