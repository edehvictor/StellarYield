import { assessConversionRisk } from "./conversionRiskService";
import { ZapQuoteBody } from "./zapQuote";

export type ReasonCode =
  | "risk-tolerance-change"
  | "apy-shift"
  | "liquidity-change"
  | "volatility-change"
  | "initial-baseline"
  | "conversion-risk-alert";

export interface ReasonCodeDetail {
  code: ReasonCode;
  label: string;
  description: string;
  severity: "info" | "warning" | "critical";
  previousValue?: string | number;
  currentValue?: string | number;
}

export interface RecommendationInputSnapshot {
  riskTolerance: string;
  expectedApy: number;
  liquidityDepthUsd: number;
  volatilityPct: number;
  timeHorizon?: string;
  liquidityNeeds?: string;
}

export interface RecommendationTimelineEntry {
  id: string;
  recommendation: string;
  rationale: string;
  targetVault: string;
  changedInputs: string[];
  reasonCodes: ReasonCodeDetail[];
  inputSnapshot: RecommendationInputSnapshot;
  timestamp: string;
  conversionRisk?: unknown;
}

const MAX_ENTRIES_PER_USER = 20;
const historyStore = new Map<string, RecommendationTimelineEntry[]>();

export const REASON_CODE_LABELS: Record<
  ReasonCode,
  {
    label: string;
    description: string;
    severity: "info" | "warning" | "critical";
  }
> = {
  "risk-tolerance-change": {
    label: "Risk Tolerance Adjusted",
    description:
      "Your risk tolerance input changed, affecting the recommendation.",
    severity: "warning",
  },
  "apy-shift": {
    label: "APY Shift Detected",
    description:
      "Projected APY changed significantly, triggering a re-evaluation.",
    severity: "info",
  },
  "liquidity-change": {
    label: "Liquidity Depth Change",
    description: "Available liquidity depth changed, affecting routing safety.",
    severity: "warning",
  },
  "volatility-change": {
    label: "Volatility Shift",
    description: "Asset volatility changed, impacting risk assessment.",
    severity: "critical",
  },
  "initial-baseline": {
    label: "Initial Baseline",
    description: "First recommendation recorded as baseline.",
    severity: "info",
  },
  "conversion-risk-alert": {
    label: "Conversion Risk Alert",
    description: "Swap conversion risk detected for the recommended path.",
    severity: "critical",
  },
};

function sanitizeText(text: string): string {
  return text
    .replace(/(api[_-]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/_-]{24,}/g, "[redacted]")
    .slice(0, 500);
}

function generateReasonCodes(
  previous: RecommendationInputSnapshot | null,
  current: RecommendationInputSnapshot,
): ReasonCodeDetail[] {
  if (!previous) {
    return [
      {
        code: "initial-baseline",
        label: REASON_CODE_LABELS["initial-baseline"].label,
        description: REASON_CODE_LABELS["initial-baseline"].description,
        severity: REASON_CODE_LABELS["initial-baseline"].severity,
        currentValue: JSON.stringify(current),
      },
    ];
  }

  const codes: ReasonCodeDetail[] = [];

  if (previous.riskTolerance !== current.riskTolerance) {
    codes.push({
      code: "risk-tolerance-change",
      label: REASON_CODE_LABELS["risk-tolerance-change"].label,
      description: REASON_CODE_LABELS["risk-tolerance-change"].description,
      severity: REASON_CODE_LABELS["risk-tolerance-change"].severity,
      previousValue: previous.riskTolerance,
      currentValue: current.riskTolerance,
    });
  }

  if (Math.abs(previous.expectedApy - current.expectedApy) >= 0.5) {
    codes.push({
      code: "apy-shift",
      label: REASON_CODE_LABELS["apy-shift"].label,
      description: REASON_CODE_LABELS["apy-shift"].description,
      severity: REASON_CODE_LABELS["apy-shift"].severity,
      previousValue: previous.expectedApy,
      currentValue: current.expectedApy,
    });
  }

  if (
    Math.abs(previous.liquidityDepthUsd - current.liquidityDepthUsd) >= 50_000
  ) {
    codes.push({
      code: "liquidity-change",
      label: REASON_CODE_LABELS["liquidity-change"].label,
      description: REASON_CODE_LABELS["liquidity-change"].description,
      severity: REASON_CODE_LABELS["liquidity-change"].severity,
      previousValue: previous.liquidityDepthUsd,
      currentValue: current.liquidityDepthUsd,
    });
  }

  if (Math.abs(previous.volatilityPct - current.volatilityPct) >= 1) {
    codes.push({
      code: "volatility-change",
      label: REASON_CODE_LABELS["volatility-change"].label,
      description: REASON_CODE_LABELS["volatility-change"].description,
      severity: REASON_CODE_LABELS["volatility-change"].severity,
      previousValue: previous.volatilityPct,
      currentValue: current.volatilityPct,
    });
  }

  return codes;
}

function diffInputs(
  previous: RecommendationInputSnapshot | null,
  current: RecommendationInputSnapshot,
): string[] {
  if (!previous) return ["initial-baseline"];

  const changed: string[] = [];

  if (previous.riskTolerance !== current.riskTolerance) {
    changed.push("riskTolerance");
  }

  if (Math.abs(previous.expectedApy - current.expectedApy) >= 0.5) {
    changed.push("expectedApy");
  }

  if (
    Math.abs(previous.liquidityDepthUsd - current.liquidityDepthUsd) >= 50_000
  ) {
    changed.push("liquidityDepthUsd");
  }

  if (Math.abs(previous.volatilityPct - current.volatilityPct) >= 1) {
    changed.push("volatilityPct");
  }

  return changed;
}

export async function recordRecommendation(
  userId: string,
  payload: Omit<
    RecommendationTimelineEntry,
    "id" | "timestamp" | "changedInputs" | "conversionRisk" | "reasonCodes"
  > & {
    inputSnapshot: RecommendationInputSnapshot;
  },
  zapBody?: ZapQuoteBody,
  strategyId?: string,
): Promise<RecommendationTimelineEntry> {
  const existing = historyStore.get(userId) ?? [];
  const previous = existing[0]?.inputSnapshot ?? null;

  const conversionRisk =
    zapBody && strategyId
      ? await assessConversionRisk(zapBody, strategyId)
      : undefined;

  const reasonCodes = generateReasonCodes(previous, payload.inputSnapshot);

  if (conversionRisk) {
    reasonCodes.push({
      code: "conversion-risk-alert",
      label: REASON_CODE_LABELS["conversion-risk-alert"].label,
      description: REASON_CODE_LABELS["conversion-risk-alert"].description,
      severity: REASON_CODE_LABELS["conversion-risk-alert"].severity,
      currentValue: JSON.stringify(conversionRisk),
    });
  }

  const entry: RecommendationTimelineEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    recommendation: sanitizeText(payload.recommendation),
    rationale: sanitizeText(payload.rationale),
    targetVault: sanitizeText(payload.targetVault),
    changedInputs: diffInputs(previous, payload.inputSnapshot),
    reasonCodes,
    inputSnapshot: payload.inputSnapshot,
    timestamp: new Date().toISOString(),
    conversionRisk,
  };

  const next = [entry, ...existing].slice(0, MAX_ENTRIES_PER_USER);

  historyStore.set(userId, next);

  return entry;
}

export function getRecommendationTimeline(
  userId: string,
): RecommendationTimelineEntry[] {
  return historyStore.get(userId) ?? [];
}

/**
 * Cursor format: base64url(timestamp:index) where timestamp and index uniquely identify a position
 */
export interface PaginatedRecommendations {
  data: RecommendationTimelineEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

function encodeCursor(timestamp: string, index: number): string {
  const data = `${timestamp}:${index}`;
  return Buffer.from(data).toString("base64url");
}

function decodeCursor(
  cursor: string,
): { timestamp: string; index: number } | null {
  try {
    const data = Buffer.from(cursor, "base64url").toString("utf-8");
    const [timestamp, indexStr] = data.split(":");
    const index = parseInt(indexStr, 10);
    if (!timestamp || isNaN(index)) return null;
    return { timestamp, index };
  } catch {
    return null;
  }
}

export function getRecommendationTimelinePaginated(
  userId: string,
  cursor: string | null | undefined,
  limit: number = 20,
): PaginatedRecommendations {
  const timeline = historyStore.get(userId) ?? [];
  if (timeline.length === 0) {
    return {
      data: [],
      nextCursor: null,
      hasMore: false,
    };
  }

  let startIndex = 0;

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      // Invalid cursor format - return empty with no nextCursor
      return {
        data: [],
        nextCursor: null,
        hasMore: false,
      };
    }

    // Use the index directly. Cursor points to last item on previous page.
    // Start from the position after that item.
    startIndex = decoded.index + 1;

    // If we're past the end, return empty
    if (startIndex >= timeline.length) {
      return {
        data: [],
        nextCursor: null,
        hasMore: false,
      };
    }
  }

  // Get the page
  const page = timeline.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < timeline.length;

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    // nextCursor points to the last item on this page
    const lastItemIndex = startIndex + page.length - 1;
    const lastItem = page[page.length - 1];
    nextCursor = encodeCursor(lastItem.timestamp, lastItemIndex);
  }

  return {
    data: page,
    nextCursor,
    hasMore,
  };
}

export function resetRecommendationTimelineStore(): void {
  historyStore.clear();
}
