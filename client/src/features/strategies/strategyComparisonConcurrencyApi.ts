/**
 * Strategy Comparison Concurrency Client API (#1919, #1925)
 *
 * Provides optimistic concurrency control, privacy-safe diagnostics,
 * version tracking, and safe retry behavior.
 */

import { apiUrl } from "../../lib/api";

export interface StrategyComparisonAssumptions {
  protocolFeeBps?: number;
  vaultFeeBps?: number;
  rebalanceCostBps?: number;
  slippageBps?: number;
}

export interface StrategyComparisonState {
  walletAddress: string;
  selectedStrategyId: string | null;
  pinnedStrategyIds: string[];
  customAssumptions: StrategyComparisonAssumptions;
  allocatedBalances: Record<string, number>;
  updatedAt: string;
  version: number;
}

export type StrategyComparisonStage =
  | "validation"
  | "fetch"
  | "conflict"
  | "update"
  | "selection"
  | "response"
  | "retry";

export interface StrategyComparisonDiagnostic {
  code: string;
  stage: StrategyComparisonStage;
  message: string;
  remediation: string;
  retryable: boolean;
  status?: number;
}

export class StrategyComparisonDiagnosticError extends Error {
  readonly code: string;
  readonly stage: StrategyComparisonStage;
  readonly remediation: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(diagnostic: StrategyComparisonDiagnostic) {
    super(diagnostic.message);

    this.name = "StrategyComparisonDiagnosticError";
    this.code = diagnostic.code;
    this.stage = diagnostic.stage;
    this.remediation = diagnostic.remediation;
    this.retryable = diagnostic.retryable;
    this.status = diagnostic.status;
  }

  toJSON(): StrategyComparisonDiagnostic {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      remediation: this.remediation,
      retryable: this.retryable,
      status: this.status,
    };
  }
}

export class StrategyComparisonConflictError
  extends StrategyComparisonDiagnosticError {
  constructor(
    _message: string,
    readonly currentVersion: number,
    readonly currentState: StrategyComparisonState,
  ) {
    super({
      code: "STRATEGY_COMPARISON_VERSION_CONFLICT",
      stage: "conflict",
      message: "Strategy comparison state changed concurrently.",
      remediation: "Reload the latest workspace state and retry.",
      retryable: true,
      status: 409,
    });

    this.name = "StrategyComparisonConflictError";
  }
}

type RequestStage = "fetch" | "update" | "selection";

function createRequestError(
  stage: RequestStage,
  status?: number,
): StrategyComparisonDiagnosticError {
  if (status === 400 || status === 422) {
    return new StrategyComparisonDiagnosticError({
      code: "INVALID_STRATEGY_COMPARISON_STATE",
      stage: "validation",
      message: "Strategy comparison input is invalid.",
      remediation:
        "Review strategy selections, allocation amounts, and fee assumptions before retrying.",
      retryable: false,
      status,
    });
  }

  if (status === 401 || status === 403) {
    return new StrategyComparisonDiagnosticError({
      code: "STRATEGY_COMPARISON_ACCESS_DENIED",
      stage,
      message: "Access to the strategy comparison workspace was denied.",
      remediation:
        "Verify your wallet connection and session permissions.",
      retryable: false,
      status,
    });
  }

  if (status === 404) {
    return new StrategyComparisonDiagnosticError({
      code: "STRATEGY_COMPARISON_NOT_FOUND",
      stage,
      message: "Not found: strategy comparison workspace is unavailable.",
      remediation: "Verify the workspace and refresh before retrying.",
      retryable: false,
      status,
    });
  }

  if (status === 409) {
    return new StrategyComparisonDiagnosticError({
      code: "STRATEGY_COMPARISON_CONFLICT",
      stage: "conflict",
      message: "Unknown conflict: the strategy comparison request conflicts with current state.",
      remediation:
        "Refresh the workspace and review its current state before retrying.",
      retryable: true,
      status,
    });
  }

  const codes: Record<RequestStage, string> = {
    fetch: "STRATEGY_COMPARISON_FETCH_FAILED",
    update: "STRATEGY_COMPARISON_UPDATE_FAILED",
    selection: "STRATEGY_SELECTION_FAILED",
  };

  const messages: Record<RequestStage, string> = {
    fetch: "Failed to fetch strategy comparison state.",
    update: "Failed to update strategy comparison state.",
    selection: "Failed to select strategy.",
  };

  return new StrategyComparisonDiagnosticError({
    code: codes[stage],
    stage,
    message: messages[stage],
    remediation:
      stage === "fetch"
        ? "Check your connection and refresh the workspace."
        : "Refresh the workspace to verify whether the operation completed before retrying.",
    retryable:
      status === undefined ||
      status === 408 ||
      status === 429 ||
      status >= 500,
    status,
  });
}

function createResponseError(): StrategyComparisonDiagnosticError {
  return new StrategyComparisonDiagnosticError({
    code: "INVALID_STRATEGY_COMPARISON_RESPONSE",
    stage: "response",
    message: "The strategy comparison service returned an invalid response.",
    remediation:
      "Refresh the workspace and verify its current state before retrying.",
    retryable: true,
  });
}

function readVersionFromResponse(
  res: Response,
): number | undefined {
  const raw =
    res.headers?.get("X-Comparison-Version") ??
    res.headers?.get("ETag")
      ?.replace(/^W\//, "")
      .replace(/^"(.*)"$/, "$1");

  if (raw === undefined || raw === null || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function isValidVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isComparisonState(
  value: unknown,
): value is StrategyComparisonState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.walletAddress === "string" &&
    (
      value.selectedStrategyId === null ||
      typeof value.selectedStrategyId === "string"
    ) &&
    Array.isArray(value.pinnedStrategyIds) &&
    value.pinnedStrategyIds.every(
      (id) => typeof id === "string",
    ) &&
    isRecord(value.customAssumptions) &&
    Object.values(value.customAssumptions).every(
      (fee) =>
        typeof fee === "number" &&
        Number.isFinite(fee) &&
        fee >= 0 &&
        fee <= 10000,
    ) &&
    isRecord(value.allocatedBalances) &&
    Object.values(value.allocatedBalances).every(
      (balance) =>
        typeof balance === "number" &&
        Number.isFinite(balance) &&
        balance >= 0,
    ) &&
    typeof value.updatedAt === "string" &&
    isValidVersion(value.version)
  );
}

interface ComparisonResponse {
  state: StrategyComparisonState;
  version: number;
  isReplay?: boolean;
}

async function parseComparisonResponse(
  res: Response,
): Promise<ComparisonResponse> {
  let data: unknown;

  try {
    data = await res.json();
  } catch {
    throw createResponseError();
  }

  if (!isRecord(data) || !isComparisonState(data.state)) {
    throw createResponseError();
  }

  const version =
    readVersionFromResponse(res) ?? data.version;

  if (!isValidVersion(version)) {
    throw createResponseError();
  }

  return {
    state: { ...data.state, version },
    version,
    isReplay:
      typeof data.isReplay === "boolean"
        ? data.isReplay
        : undefined,
  };
}

async function requestComparison(
  url: string,
  stage: RequestStage,
  init?: RequestInit,
): Promise<ComparisonResponse> {
  let res: Response;

  try {
    res = await fetch(url, init);
  } catch {
    // Never expose raw transport errors, request URLs,
    // wallet addresses, credentials, or request payloads.
    throw createRequestError(stage);
  }

  if (res.status === 409) {
    let body: unknown;

    try {
      body = await res.json();
    } catch {
      throw createRequestError(stage, 409);
    }

    if (
      isRecord(body) &&
      body.code === "STRATEGY_COMPARISON_VERSION_CONFLICT" &&
      isComparisonState(body.state)
    ) {
      const version =
        body.currentVersion ??
        readVersionFromResponse(res);

      if (
        isValidVersion(version) &&
        body.state.version === version
      ) {
        throw new StrategyComparisonConflictError(
          "Strategy comparison state changed concurrently.",
          version,
          body.state,
        );
      }
    }

    throw createRequestError(stage, 409);
  }

  if (!res.ok) {
    // Server error bodies are untrusted and may contain
    // sensitive values or internal implementation details.
    throw createRequestError(stage, res.status);
  }

  return parseComparisonResponse(res);
}

const STRATEGIES_BASE = apiUrl("/api/strategies");

export interface SaveComparisonOptions {
  expectedVersion?: number;
  operationIdentity?: string;
}

function buildHeaders(
  options: SaveComparisonOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.operationIdentity) {
    headers["X-Operation-Identity"] =
      options.operationIdentity;

    headers["Idempotency-Key"] =
      options.operationIdentity;
  }

  if (options.expectedVersion !== undefined) {
    headers["If-Match"] =
      `"${options.expectedVersion}"`;
  }

  return headers;
}

/**
 * Fetches the current comparison workspace and version.
 */
export async function fetchComparisonStateVersioned(
  walletAddress: string,
): Promise<{
  state: StrategyComparisonState;
  version: number;
}> {
  const result = await requestComparison(
    `${STRATEGIES_BASE}/comparison/state/${encodeURIComponent(walletAddress)}`,
    "fetch",
  );

  return {
    state: result.state,
    version: result.version,
  };
}

/**
 * Saves workspace state using optimistic concurrency control.
 */
export async function saveComparisonStateVersioned(
  walletAddress: string,
  state: Partial<StrategyComparisonState>,
  options: SaveComparisonOptions = {},
): Promise<ComparisonResponse> {
  const feeFields = ["protocolFeeBps", "vaultFeeBps", "rebalanceCostBps", "slippageBps"] as const;
  for (const field of feeFields) {
    const value = state.customAssumptions?.[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 10000)) {
      throw new StrategyComparisonDiagnosticError({
        code: "INVALID_STRATEGY_COMPARISON_STATE",
        stage: "validation",
        message: `${field} must be between 0 and 10000.`,
        remediation: "Correct the fee assumption before retrying.",
        retryable: false,
        status: 400,
      });
    }
  }
  return requestComparison(
    `${STRATEGIES_BASE}/comparison/state`,
    "update",
    {
      method: "PUT",
      headers: buildHeaders(options),
      body: JSON.stringify({
        ...state,
        walletAddress,
        expectedVersion: options.expectedVersion,
        operationIdentity: options.operationIdentity,
      }),
    },
  );
}

/**
 * Atomically selects a strategy and updates its allocation.
 */
export async function selectStrategySafely(
  walletAddress: string,
  strategyId: string,
  allocationUsd: number,
  options: SaveComparisonOptions = {},
): Promise<ComparisonResponse> {
  if (
    !Number.isFinite(allocationUsd) ||
    allocationUsd < 0 ||
    !strategyId.trim() ||
    !walletAddress.trim()
  ) {
    throw createRequestError("selection", 400);
  }

  return requestComparison(
    `${STRATEGIES_BASE}/comparison/select`,
    "selection",
    {
      method: "POST",
      headers: buildHeaders(options),
      body: JSON.stringify({
        walletAddress,
        strategyId,
        allocationUsd,
        expectedVersion: options.expectedVersion,
        operationIdentity: options.operationIdentity,
      }),
    },
  );
}

/**
 * Read-modify-write helper with bounded conflict retries.
 *
 * Only confirmed version conflicts are automatically retried.
 * Transport failures may represent an unknown execution outcome,
 * so they require reconciliation before another write.
 */
export async function updateComparisonSafely(
  walletAddress: string,
  changeFn: (
    current: StrategyComparisonState,
  ) => Partial<StrategyComparisonState>,
  maxAttempts = 3,
): Promise<{
  state: StrategyComparisonState;
  version: number;
}> {
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new StrategyComparisonDiagnosticError({
      code: "INVALID_STRATEGY_COMPARISON_RETRY_LIMIT",
      stage: "retry",
      message: "The comparison retry limit is invalid.",
      remediation: "Use a positive integer retry limit.",
      retryable: false,
    });
  }

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const { state: current, version } =
      await fetchComparisonStateVersioned(walletAddress);

    let updates: Partial<StrategyComparisonState>;

    try {
      updates = changeFn(current);
    } catch {
      throw new StrategyComparisonDiagnosticError({
        code: "STRATEGY_COMPARISON_CHANGE_FAILED",
        stage: "validation",
        message: "Unable to prepare the comparison update.",
        remediation:
          "Review the proposed changes before retrying.",
        retryable: false,
      });
    }

    try {
      return await saveComparisonStateVersioned(
        walletAddress,
        updates,
        {
          expectedVersion: version,
          operationIdentity:
            `cmp-op-${globalThis.crypto.randomUUID()}`,
        },
      );
    } catch (err) {
      if (
        err instanceof StrategyComparisonConflictError &&
        attempt < maxAttempts
      ) {
        continue;
      }

      throw err;
    }
  }

  throw new StrategyComparisonDiagnosticError({
    code: "STRATEGY_COMPARISON_RETRY_EXHAUSTED",
    stage: "retry",
    message: "Strategy comparison retry limit reached.",
    remediation:
      "Refresh the workspace before attempting another update.",
    retryable: true,
  });
}
