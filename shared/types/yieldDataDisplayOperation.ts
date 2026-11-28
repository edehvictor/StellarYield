import { sha256Pure, stableStringify } from "./quoteAssumptionFingerprint";

export interface YieldDisplayAllocation {
  id: string;
  apyPct: number;
  weightPct: number;
}

export interface YieldCurveDisplayPayload {
  scope: "yield-curve";
  horizon: string;
  principalUsd: number;
  compounding: string;
  feeDragPct: number;
  allocations: YieldDisplayAllocation[];
  configVersion?: string;
}

export interface YieldDisplayAssumptionsPayload {
  protocolFeeBps?: number;
  vaultFeeBps?: number;
  rebalanceCostBps?: number;
  slippageBps?: number;
}

export interface YieldDisplayProtocol {
  protocol: string;
  grossApy: number;
}

export interface NetYieldDisplayPayload {
  scope: "net-yield";
  grossApy: number;
  protocols?: YieldDisplayProtocol[];
  assumptions?: YieldDisplayAssumptionsPayload;
  configVersion?: string;
}

export type YieldDisplayPayload = YieldCurveDisplayPayload | NetYieldDisplayPayload;

export interface YieldDisplayOperationIdentity {
  operationId: string;
  payloadFingerprint: string;
  shortId: string;
  createdAt: string;
}

export type YieldDisplayOperationStatus = "in_flight" | "committed" | "failed" | "rejected";

export interface YieldDisplayEffect {
  effectId: string;
  type: "YIELD_CURVE_SNAPSHOT_COMMITTED" | "NET_YIELD_COMPUTED";
  operationId: string;
  scope: YieldDisplayPayload["scope"];
  shortId: string;
  appliedAt: string;
}

export interface YieldDisplayOperationRecord {
  operationId: string;
  payloadFingerprint: string;
  scope: YieldDisplayPayload["scope"];
  status: YieldDisplayOperationStatus;
  result?: unknown;
  effects?: YieldDisplayEffect[];
  error?: string;
  errorCode?: YieldDisplayErrorCode;
  createdAt: string;
  committedAt?: string;
  replayedCount: number;
}

export type YieldDisplayErrorCode =
  | "YIELD_DISPLAY_VALIDATION_FAILED"
  | "YIELD_DISPLAY_EXECUTION_FAILED"
  | "YIELD_DISPLAY_OPERATION_IDENTITY_CONFLICT"
  | "DUPLICATE_YIELD_DISPLAY_IN_PROGRESS";

export interface SafeYieldDisplayOptions<TState, TResult> {
  payload: YieldDisplayPayload;
  operationIdentity: YieldDisplayOperationIdentity;
  currentState: TState;
  validate?: (payload: YieldDisplayPayload) => boolean | string;
  execute?: () => Promise<TResult> | TResult;
  onSuccessStateUpdate?: (
    currentState: TState,
    effect: YieldDisplayEffect,
    result: TResult | undefined,
  ) => TState;
}

export interface SafeYieldDisplayResult<TState, TResult> {
  success: boolean;
  state: TState;
  result?: TResult;
  effects?: YieldDisplayEffect[];
  replayed?: boolean;
  duplicate?: boolean;
  error?: string;
  errorCode?: YieldDisplayErrorCode;
  isRecoverable: boolean;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidYieldDisplayOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value);
}

function finiteNumber(value: unknown, decimals = 4): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(decimals))
    : null;
}

function canonicalizeAssumptions(value: YieldDisplayAssumptionsPayload | undefined) {
  return {
    protocolFeeBps: finiteNumber(value?.protocolFeeBps),
    rebalanceCostBps: finiteNumber(value?.rebalanceCostBps),
    slippageBps: finiteNumber(value?.slippageBps),
    vaultFeeBps: finiteNumber(value?.vaultFeeBps),
  };
}

export function canonicalizeYieldDisplayPayload(
  payload: YieldDisplayPayload,
): Record<string, unknown> {
  const configVersion = String(payload.configVersion ?? "").trim().toLowerCase();
  if (payload.scope === "net-yield") {
    const protocols = (payload.protocols ?? [])
      .map((entry) => ({
        grossApy: finiteNumber(entry.grossApy, 6),
        protocol: String(entry.protocol ?? "").trim().toLowerCase(),
      }))
      .sort((a, b) => a.protocol.localeCompare(b.protocol));
    return {
      assumptions: canonicalizeAssumptions(payload.assumptions),
      configVersion,
      grossApy: finiteNumber(payload.grossApy, 6),
      protocols,
      scope: "net-yield",
    };
  }

  const allocations = (payload.allocations ?? [])
    .map((leg) => ({
      apyPct: finiteNumber(leg.apyPct),
      id: String(leg.id ?? "").trim(),
      weightPct: finiteNumber(leg.weightPct),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    allocations,
    compounding: String(payload.compounding ?? "").trim().toLowerCase(),
    configVersion,
    feeDragPct: finiteNumber(payload.feeDragPct),
    horizon: String(payload.horizon ?? "").trim().toLowerCase(),
    principalUsd: finiteNumber(payload.principalUsd, 2),
    scope: "yield-curve",
  };
}

export function computeYieldDisplayPayloadFingerprint(payload: YieldDisplayPayload): {
  fingerprint: string;
  shortId: string;
  canonicalPayload: string;
} {
  const canonicalPayload = stableStringify(canonicalizeYieldDisplayPayload(payload));
  const fingerprint = sha256Pure(canonicalPayload);
  return {
    fingerprint,
    shortId: `ydisp-${fingerprint.slice(0, 6)}…${fingerprint.slice(-4)}`,
    canonicalPayload,
  };
}

function newOperationId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  const fallback = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `ydisp_${(random ?? fallback).replace(/[^A-Za-z0-9_-]/g, "")}`;
}

export function createYieldDisplayOperationIdentity(
  payload: YieldDisplayPayload,
  options: { operationId?: string; createdAt?: string } = {},
): YieldDisplayOperationIdentity {
  const { fingerprint, shortId } = computeYieldDisplayPayloadFingerprint(payload);
  return {
    operationId: isValidYieldDisplayOperationId(options.operationId)
      ? options.operationId
      : newOperationId(),
    payloadFingerprint: fingerprint,
    shortId,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

export function verifyYieldDisplayOperationIdentity(
  identity: YieldDisplayOperationIdentity,
  payload: YieldDisplayPayload,
): boolean {
  return identity.payloadFingerprint === computeYieldDisplayPayloadFingerprint(payload).fingerprint;
}

export function resolveYieldDisplayOperationIdentity(
  payload: YieldDisplayPayload,
  previous?: YieldDisplayOperationIdentity,
  options: { createdAt?: string } = {},
): YieldDisplayOperationIdentity {
  if (previous && verifyYieldDisplayOperationIdentity(previous, payload)) {
    return previous;
  }
  return createYieldDisplayOperationIdentity(payload, options);
}

export class YieldDisplayOperationManager {
  private readonly operations = new Map<string, YieldDisplayOperationRecord>();

  constructor(private readonly ttlMs: number = 24 * 60 * 60 * 1000) {}

  public getOperation(operationId: string): YieldDisplayOperationRecord | undefined {
    const record = this.operations.get(operationId);
    if (!record) return undefined;
    if (Date.now() - Date.parse(record.createdAt) > this.ttlMs) {
      this.operations.delete(operationId);
      return undefined;
    }
    return record;
  }

  public clear(): void {
    this.operations.clear();
  }

  private check<TState, TResult>(
    options: SafeYieldDisplayOptions<TState, TResult>,
  ): { early?: SafeYieldDisplayResult<TState, TResult>; fingerprint: string; effectType: YieldDisplayEffect["type"] } {
    const { payload, operationIdentity, currentState, validate } = options;
    const { operationId } = operationIdentity;
    const fingerprint = computeYieldDisplayPayloadFingerprint(payload).fingerprint;
    const conflict: SafeYieldDisplayResult<TState, TResult> = {
      success: false,
      state: currentState,
      error: "Operation identity conflict: yield display parameters changed after submission.",
      errorCode: "YIELD_DISPLAY_OPERATION_IDENTITY_CONFLICT",
      isRecoverable: false,
    };

    if (!verifyYieldDisplayOperationIdentity(operationIdentity, payload)) {
      return { early: conflict, fingerprint, effectType: this.effectType(payload) };
    }

    const existing = this.getOperation(operationId);
    if (existing) {
      if (existing.payloadFingerprint !== fingerprint) {
        return { early: conflict, fingerprint, effectType: this.effectType(payload) };
      }
      if (existing.status === "in_flight") {
        return {
          early: {
            success: false,
            state: currentState,
            error: "A yield display operation with this identity is already in progress.",
            errorCode: "DUPLICATE_YIELD_DISPLAY_IN_PROGRESS",
            isRecoverable: true,
          },
          fingerprint,
          effectType: this.effectType(payload),
        };
      }
      if (existing.status === "committed") {
        existing.replayedCount += 1;
        return {
          early: {
            success: true,
            state: currentState,
            result: existing.result as TResult | undefined,
            effects: existing.effects,
            replayed: true,
            duplicate: true,
            isRecoverable: false,
          },
          fingerprint,
          effectType: this.effectType(payload),
        };
      }
    }

    if (validate) {
      const verdict = validate(payload);
      if (verdict !== true) {
        const message = typeof verdict === "string" ? verdict : "Yield display validation failed.";
        this.operations.set(operationId, {
          operationId,
          payloadFingerprint: fingerprint,
          scope: payload.scope,
          status: "rejected",
          error: message,
          errorCode: "YIELD_DISPLAY_VALIDATION_FAILED",
          createdAt: operationIdentity.createdAt,
          replayedCount: 0,
        });
        return {
          early: {
            success: false,
            state: currentState,
            error: message,
            errorCode: "YIELD_DISPLAY_VALIDATION_FAILED",
            isRecoverable: true,
          },
          fingerprint,
          effectType: this.effectType(payload),
        };
      }
    }

    return { fingerprint, effectType: this.effectType(payload) };
  }

  private effectType(payload: YieldDisplayPayload): YieldDisplayEffect["type"] {
    return payload.scope === "net-yield" ? "NET_YIELD_COMPUTED" : "YIELD_CURVE_SNAPSHOT_COMMITTED";
  }

  private effect(
    options: SafeYieldDisplayOptions<unknown, unknown>,
    type: YieldDisplayEffect["type"],
  ): YieldDisplayEffect {
    const { operationId, shortId } = options.operationIdentity;
    return {
      effectId: `ydeff_${operationId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16)}`,
      type,
      operationId,
      scope: options.payload.scope,
      shortId,
      appliedAt: new Date().toISOString(),
    };
  }

  public async executeYieldDisplay<TState, TResult>(
    options: SafeYieldDisplayOptions<TState, TResult>,
  ): Promise<SafeYieldDisplayResult<TState, TResult>> {
    const { payload, operationIdentity, currentState, execute, onSuccessStateUpdate } = options;
    const prepared = this.check(options);
    if (prepared.early) return prepared.early;

    const { operationId } = operationIdentity;
    this.operations.set(operationId, {
      operationId,
      payloadFingerprint: prepared.fingerprint,
      scope: payload.scope,
      status: "in_flight",
      createdAt: operationIdentity.createdAt,
      replayedCount: 0,
    });

    try {
      const result = await execute?.();
      const effect = this.effect(
        options as unknown as SafeYieldDisplayOptions<unknown, unknown>,
        prepared.effectType,
      );
      this.operations.set(operationId, {
        operationId,
        payloadFingerprint: prepared.fingerprint,
        scope: payload.scope,
        status: "committed",
        result,
        effects: [effect],
        createdAt: operationIdentity.createdAt,
        committedAt: new Date().toISOString(),
        replayedCount: 0,
      });
      return {
        success: true,
        state: onSuccessStateUpdate ? onSuccessStateUpdate(currentState, effect, result) : currentState,
        result,
        effects: [effect],
        replayed: false,
        duplicate: false,
        isRecoverable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Yield display execution failed.";
      this.operations.set(operationId, {
        operationId,
        payloadFingerprint: prepared.fingerprint,
        scope: payload.scope,
        status: "failed",
        error: message,
        errorCode: "YIELD_DISPLAY_EXECUTION_FAILED",
        createdAt: operationIdentity.createdAt,
        replayedCount: 0,
      });
      return {
        success: false,
        state: currentState,
        error: message,
        errorCode: "YIELD_DISPLAY_EXECUTION_FAILED",
        isRecoverable: true,
      };
    }
  }

  public executeYieldDisplaySync<TState, TResult>(
    options: Omit<SafeYieldDisplayOptions<TState, TResult>, "execute"> & { execute?: () => TResult },
  ): SafeYieldDisplayResult<TState, TResult> {
    const { payload, operationIdentity, currentState, execute, onSuccessStateUpdate } = options;
    const prepared = this.check(options);
    if (prepared.early) return prepared.early;

    const { operationId } = operationIdentity;
    this.operations.set(operationId, {
      operationId,
      payloadFingerprint: prepared.fingerprint,
      scope: payload.scope,
      status: "in_flight",
      createdAt: operationIdentity.createdAt,
      replayedCount: 0,
    });

    try {
      const result = execute?.();
      const effect = this.effect(
        options as unknown as SafeYieldDisplayOptions<unknown, unknown>,
        prepared.effectType,
      );
      this.operations.set(operationId, {
        operationId,
        payloadFingerprint: prepared.fingerprint,
        scope: payload.scope,
        status: "committed",
        result,
        effects: [effect],
        createdAt: operationIdentity.createdAt,
        committedAt: new Date().toISOString(),
        replayedCount: 0,
      });
      return {
        success: true,
        state: onSuccessStateUpdate ? onSuccessStateUpdate(currentState, effect, result) : currentState,
        result,
        effects: [effect],
        replayed: false,
        duplicate: false,
        isRecoverable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Yield display execution failed.";
      this.operations.set(operationId, {
        operationId,
        payloadFingerprint: prepared.fingerprint,
        scope: payload.scope,
        status: "failed",
        error: message,
        errorCode: "YIELD_DISPLAY_EXECUTION_FAILED",
        createdAt: operationIdentity.createdAt,
        replayedCount: 0,
      });
      return {
        success: false,
        state: currentState,
        error: message,
        errorCode: "YIELD_DISPLAY_EXECUTION_FAILED",
        isRecoverable: true,
      };
    }
  }
}

export const defaultYieldDisplayOperationManager = new YieldDisplayOperationManager();
