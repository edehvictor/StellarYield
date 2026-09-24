/**
 * Treasury withdrawal cooldown enforcement (#1343).
 *
 * Treasury admins can request withdrawals through the API; a per-vault
 * cooldown prevents rapid-fire successive requests while one is still
 * pending review/settlement. Storage is in-memory, mirroring the treasury
 * scenario store pattern (no Prisma dependency, resettable in tests).
 *
 * Rules:
 * - Only `PENDING` records consume the cooldown. Cancelling a pending
 *   withdrawal frees its vault's cooldown immediately.
 * - A pending record blocks new submissions for its vault until
 *   `submittedAt + cooldownMs` elapses; after that it stops consuming the
 *   cooldown even if still pending.
 * - Default cooldown is 4 hours, overridable per vault via policy.
 *
 * All failures are typed (`TreasuryWithdrawalError`) with stable machine
 * codes and HTTP statuses so routes can map them without string parsing.
 */

import crypto from "crypto";

/** Default cooldown: 4 hours. */
export const DEFAULT_TREASURY_WITHDRAWAL_COOLDOWN_MS = 4 * 60 * 60 * 1000;

export type TreasuryWithdrawalStatus = "PENDING" | "CANCELLED";

export interface TreasuryWithdrawalRecord {
  id: string;
  vaultId: string;
  amountUsd: number;
  status: TreasuryWithdrawalStatus;
  /** Authenticated operator who submitted the request, when known. */
  requestedBy: string | null;
  memo: string | null;
  /** ISO timestamp of submission. */
  submittedAt: string;
  /** ISO timestamp when the cooldown for this record lapses. */
  cooldownUntil: string;
  /** ISO timestamp of cancellation, when cancelled. */
  cancelledAt: string | null;
}

export interface TreasuryWithdrawalCooldownPolicy {
  /** Fallback cooldown applied when the vault has no override. */
  defaultCooldownMs: number;
  /** Per-vault cooldown overrides, in milliseconds. */
  vaultCooldownMs: Record<string, number>;
}

export function defaultWithdrawalCooldownPolicy(): TreasuryWithdrawalCooldownPolicy {
  return {
    defaultCooldownMs: DEFAULT_TREASURY_WITHDRAWAL_COOLDOWN_MS,
    vaultCooldownMs: {},
  };
}

/**
 * Typed failure for withdrawal cooldown operations. Carries a stable machine
 * code and HTTP status so routes can map it without string parsing.
 */
export class TreasuryWithdrawalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TreasuryWithdrawalError";
  }
}

export interface TreasuryWithdrawalCooldownStatus {
  vaultId: string;
  /** True when a pending record still consumes the vault's cooldown. */
  cooldownActive: boolean;
  /** Effective cooldown for this vault (ms). */
  cooldownMs: number;
  /** Milliseconds until a new submission would be allowed (0 when free). */
  remainingMs: number;
  /** ISO timestamp when a new submission becomes allowed, if blocked. */
  availableAt: string | null;
  /** Pending record currently consuming the cooldown, if any. */
  blockingWithdrawalId: string | null;
  /** When this status was evaluated (ISO). */
  evaluatedAt: string;
}

export interface SubmitWithdrawalInput {
  vaultId: unknown;
  amountUsd: unknown;
  requestedBy?: unknown;
  memo?: unknown;
  /** Evaluation clock (epoch ms); defaults to `Date.now()`. */
  now?: number;
}

export interface ListWithdrawalsFilter {
  vaultId?: string;
}

export class TreasuryWithdrawalCooldownService {
  private readonly withdrawals = new Map<string, TreasuryWithdrawalRecord>();
  private policy: TreasuryWithdrawalCooldownPolicy;

  constructor(policy: TreasuryWithdrawalCooldownPolicy = defaultWithdrawalCooldownPolicy()) {
    this.policy = {
      defaultCooldownMs: policy.defaultCooldownMs,
      vaultCooldownMs: { ...policy.vaultCooldownMs },
    };
  }

  /** Effective cooldown for a vault (override or default). */
  getCooldownMs(vaultId: string): number {
    return this.policy.vaultCooldownMs[vaultId] ?? this.policy.defaultCooldownMs;
  }

  /** Replace the cooldown policy (tests / operator configuration). */
  setPolicy(policy: TreasuryWithdrawalCooldownPolicy): void {
    this.policy = {
      defaultCooldownMs: policy.defaultCooldownMs,
      vaultCooldownMs: { ...policy.vaultCooldownMs },
    };
  }

  /**
   * Evaluate the cooldown for a vault at `now`. Only `PENDING` records whose
   * `cooldownUntil` is still in the future consume the cooldown.
   */
  evaluateCooldown(
    vaultId: string,
    now: number = Date.now(),
  ): TreasuryWithdrawalCooldownStatus {
    const cooldownMs = this.getCooldownMs(vaultId);
    let blocking: TreasuryWithdrawalRecord | null = null;

    for (const record of this.withdrawals.values()) {
      if (record.vaultId !== vaultId || record.status !== "PENDING") continue;
      const until = new Date(record.cooldownUntil).getTime();
      if (now >= until) continue;
      if (
        blocking === null ||
        new Date(blocking.cooldownUntil).getTime() < until
      ) {
        blocking = record;
      }
    }

    if (blocking === null) {
      return {
        vaultId,
        cooldownActive: false,
        cooldownMs,
        remainingMs: 0,
        availableAt: null,
        blockingWithdrawalId: null,
        evaluatedAt: new Date(now).toISOString(),
      };
    }

    const availableMs = new Date(blocking.cooldownUntil).getTime();
    return {
      vaultId,
      cooldownActive: true,
      cooldownMs,
      remainingMs: Math.max(0, availableMs - now),
      availableAt: blocking.cooldownUntil,
      blockingWithdrawalId: blocking.id,
      evaluatedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Submit a withdrawal request for a vault, enforcing the cooldown.
   *
   * @throws {TreasuryWithdrawalError} INVALID_REQUEST (400) on bad input or
   *   COOLDOWN_ACTIVE (409) while the vault is still in cooldown.
   */
  submitWithdrawal(input: SubmitWithdrawalInput): TreasuryWithdrawalRecord {
    const vaultId = this.assertVaultId(input.vaultId);
    const amountUsd = this.assertAmount(input.amountUsd);
    const requestedBy = this.assertOptionalString(input.requestedBy, "requestedBy");
    const memo = this.assertOptionalString(input.memo, "memo", 500);
    const now = input.now ?? Date.now();

    const status = this.evaluateCooldown(vaultId, now);
    if (status.cooldownActive) {
      throw new TreasuryWithdrawalError(
        "COOLDOWN_ACTIVE",
        `Vault "${vaultId}" is in withdrawal cooldown; retry after ${status.availableAt}.`,
        409,
        {
          vaultId,
          cooldownMs: status.cooldownMs,
          remainingMs: status.remainingMs,
          availableAt: status.availableAt,
          blockingWithdrawalId: status.blockingWithdrawalId,
        },
      );
    }

    const submittedAt = now;
    const cooldownUntil = submittedAt + this.getCooldownMs(vaultId);
    const record: TreasuryWithdrawalRecord = {
      id: crypto.randomUUID(),
      vaultId,
      amountUsd,
      status: "PENDING",
      requestedBy,
      memo,
      submittedAt: new Date(submittedAt).toISOString(),
      cooldownUntil: new Date(cooldownUntil).toISOString(),
      cancelledAt: null,
    };

    this.withdrawals.set(record.id, record);
    return { ...record };
  }

  /**
   * Cancel a pending withdrawal, freeing its vault's cooldown immediately.
   *
   * @throws {TreasuryWithdrawalError} NOT_FOUND (404) unknown id or
   *   INVALID_STATE (409) when the record is not pending.
   */
  cancelWithdrawal(id: string, now: number = Date.now()): TreasuryWithdrawalRecord {
    const record = this.withdrawals.get(id);
    if (!record) {
      throw new TreasuryWithdrawalError(
        "NOT_FOUND",
        `Treasury withdrawal "${id}" not found.`,
        404,
        { id },
      );
    }
    if (record.status !== "PENDING") {
      throw new TreasuryWithdrawalError(
        "INVALID_STATE",
        `Treasury withdrawal "${id}" is ${record.status} and cannot be cancelled.`,
        409,
        { id, status: record.status },
      );
    }

    record.status = "CANCELLED";
    record.cancelledAt = new Date(now).toISOString();
    return { ...record };
  }

  /** Cooldown status for one vault (never throws). */
  getCooldownStatus(vaultId: string, now: number = Date.now()): TreasuryWithdrawalCooldownStatus {
    return this.evaluateCooldown(vaultId, now);
  }

  /** List withdrawals, newest first, optionally filtered by vault. */
  listWithdrawals(filter: ListWithdrawalsFilter = {}): TreasuryWithdrawalRecord[] {
    const records = [...this.withdrawals.values()].filter(
      (record) => filter.vaultId === undefined || record.vaultId === filter.vaultId,
    );
    records.sort((a, b) => {
      const aMs = new Date(a.submittedAt).getTime();
      const bMs = new Date(b.submittedAt).getTime();
      if (aMs !== bMs) return bMs - aMs;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    return records.map((record) => ({ ...record }));
  }

  /** Clear all records and restore the default policy (tests). */
  reset(): void {
    this.withdrawals.clear();
    this.policy = defaultWithdrawalCooldownPolicy();
  }

  private assertVaultId(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TreasuryWithdrawalError(
        "INVALID_REQUEST",
        "vaultId is required and must be a non-empty string.",
        400,
        { field: "vaultId" },
      );
    }
    return value.trim();
  }

  private assertAmount(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new TreasuryWithdrawalError(
        "INVALID_REQUEST",
        "amountUsd is required and must be a finite number greater than 0.",
        400,
        { field: "amountUsd" },
      );
    }
    return value;
  }

  private assertOptionalString(
    value: unknown,
    field: string,
    maxLength = 200,
  ): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
      throw new TreasuryWithdrawalError(
        "INVALID_REQUEST",
        `${field} must be a non-empty string of at most ${maxLength} characters.`,
        400,
        { field },
      );
    }
    return value.trim();
  }
}

/** Process-wide service used by the treasury routes. */
export const treasuryWithdrawalCooldownService = new TreasuryWithdrawalCooldownService();

/** Reset the process-wide service (tests). */
export function resetTreasuryWithdrawalCooldownService(): void {
  treasuryWithdrawalCooldownService.reset();
}
