/**
 * Source-level APY confidence explanations (#1386).
 *
 * Pure typed builder that turns the predictor's raw confidence inputs
 * (`confidenceInputs` + `quorumStatus` from `predictApy`) into structured,
 * human-readable explanations for the dashboard. Every user-facing string
 * comes from a stable message template — raw reason codes and raw provider
 * output are never surfaced.
 *
 * All inputs are normalized defensively: malformed values degrade to typed
 * fallbacks ("unknown-provider", nulls, empty lists) instead of throwing,
 * so a bad upstream payload renders an "unknown" explanation panel rather
 * than crashing the request.
 */

import type { ConfidenceInputs } from "../analytics/apyPredictor";
import type { QuorumStatus } from "./yieldQuorumService";

export type ConfidenceLevel = "high" | "reduced" | "low" | "unknown";

export type ConfidenceSourceStatus =
  | "fresh"
  | "stale"
  | "failing"
  | "missing"
  | "unknown";

export type ConfidenceImpact = "positive" | "neutral" | "negative";

export interface ConfidenceSourceExplanation {
  provider: string;
  apy: number | null;
  status: ConfidenceSourceStatus;
  isValid: boolean;
  /** Stable human-readable sentence describing this source's contribution. */
  detail: string;
}

export interface ConfidenceFactorExplanation {
  key: string;
  label: string;
  /** Display-ready value (already formatted, e.g. "85%" or "1.20%"). */
  value: string;
  impact: ConfidenceImpact;
  /** Stable human-readable sentence explaining the factor. */
  detail: string;
}

export interface ApyConfidenceExplanation {
  protocol: string;
  level: ConfidenceLevel;
  /** Representative forecast confidence on a 0-1 scale, or null when unknown. */
  confidence: number | null;
  /** Representative forecast APY in percent, or null when unknown. */
  forecastApy: number | null;
  quorumMet: boolean;
  /** One-to-two sentence stable summary of the overall confidence. */
  summary: string;
  /** One row per evaluated source, stably sorted by provider name. */
  sources: ConfidenceSourceExplanation[];
  factors: ConfidenceFactorExplanation[];
}

export interface ConfidenceExplanationInput {
  protocol: unknown;
  confidenceInputs?: unknown;
  quorumStatus?: unknown;
  /** Representative forecast confidence (0-1 ratio). Unknown values → null. */
  confidence?: unknown;
  /** Representative forecast APY in percent. Unknown values → null. */
  forecastApy?: unknown;
}

// ── Normalizers ─────────────────────────────────────────────────────────────

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeRatio(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeApy(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatApyValue(apy: number | null): string {
  return apy === null ? "no APY" : `${apy.toFixed(2)}%`;
}

// ── Stable message templates ────────────────────────────────────────────────
// Reason codes are internal identifiers; the panel only ever shows these
// sentences.

const COVERAGE_REASON_MESSAGES: Record<string, string> = {
  no_history: "there is no usable APY history",
  sparse_history: "the APY history is sparse",
  gapped_history: "the APY history has a long gap",
  stale_history: "the most recent APY reading is stale",
};

function describeCoverageReasons(reasons: string[]): string | null {
  const known = reasons
    .map((reason) => COVERAGE_REASON_MESSAGES[reason])
    .filter((message): message is string => message !== undefined);
  if (known.length === 0) return null;
  if (known.length === 1) return known[0];
  return `${known.slice(0, -1).join(", ")} and ${known[known.length - 1]}`;
}

// ── Sources ─────────────────────────────────────────────────────────────────

function explainSource(
  source: QuorumStatus["evaluatedSources"][number],
  consensusApy: number | null,
): ConfidenceSourceExplanation {
  const provider = normalizeString(
    (source as { provider?: unknown }).provider,
    "unknown-provider",
  );
  const rawApy = (source as { apy?: unknown }).apy;
  const apy = typeof rawApy === "number" && !Number.isNaN(rawApy) ? rawApy : null;
  const isFailing = (source as { isFailing?: unknown }).isFailing === true;
  const isFresh = (source as { isFresh?: unknown }).isFresh === true;
  const isValid = (source as { isValid?: unknown }).isValid === true;

  let status: ConfidenceSourceStatus = "unknown";
  if (isFailing) status = "failing";
  else if (apy === null) status = "missing";
  else if (!isFresh) status = "stale";
  else status = "fresh";

  let detail: string;
  switch (status) {
    case "failing":
      detail =
        `${provider} is failing and excluded from the APY consensus ` +
        `(reported ${formatApyValue(apy)}).`;
      break;
    case "missing":
      detail = `${provider} reported no usable APY and is excluded from the consensus.`;
      break;
    case "stale":
      detail =
        `${provider} reported ${formatApyValue(apy)} but the reading is stale, ` +
        `so it is excluded from the APY consensus.`;
      break;
    default: {
      const deviation =
        apy !== null && consensusApy !== null && Math.abs(consensusApy) > 1e-6
          ? ` (${Math.abs(((apy - consensusApy) / consensusApy) * 100).toFixed(1)}% from consensus)`
          : "";
      detail =
        `${provider} reports ${formatApyValue(apy)} and counts toward the APY consensus${deviation}.`;
      break;
    }
  }

  return { provider, apy, status, isValid, detail };
}

// ── Factors ─────────────────────────────────────────────────────────────────

function explainFactors(
  inputs: ConfidenceInputs | null,
  quorum: QuorumStatus | null,
): ConfidenceFactorExplanation[] {
  const factors: ConfidenceFactorExplanation[] = [];

  if (inputs) {
    const volatility = Number.isFinite(inputs.volatilityPct) ? inputs.volatilityPct : null;
    factors.push({
      key: "volatility",
      label: "APY volatility",
      value: volatility === null ? "unknown" : `${volatility.toFixed(2)}%`,
      impact: volatility === null ? "neutral" : volatility < 1 ? "positive" : volatility < 3 ? "neutral" : "negative",
      detail:
        volatility === null
          ? "Volatility could not be measured for this forecast."
          : volatility < 1
            ? "APY moves within a tight range, which supports a steady forecast."
            : volatility < 3
              ? "APY moves moderately, so the forecast band is widened slightly."
              : "APY swings widely, so the forecast is treated with caution.",
    });

    const completeness =
      Number.isFinite(inputs.dataCompleteness)
        ? Math.max(0, Math.min(1, inputs.dataCompleteness))
        : null;
    factors.push({
      key: "data-completeness",
      label: "History depth",
      value: completeness === null ? "unknown" : `${Math.round(completeness * 100)}%`,
      impact:
        completeness === null ? "neutral" : completeness >= 0.8 ? "positive" : completeness >= 0.4 ? "neutral" : "negative",
      detail:
        completeness === null
          ? "History depth could not be measured for this forecast."
          : completeness >= 0.8
            ? "A full month of history backs this forecast."
            : completeness >= 0.4
              ? "History is partial, so the forecast leans on fewer data points."
              : "Very little history is available, so the forecast is mostly flat.",
    });

    const modelFit = Number.isFinite(inputs.modelFit) ? inputs.modelFit : null;
    factors.push({
      key: "model-fit",
      label: "Trend fit",
      value: modelFit === null ? "unknown" : modelFit.toFixed(2),
      impact: modelFit === null ? "neutral" : modelFit >= 0.7 ? "positive" : modelFit >= 0.4 ? "neutral" : "negative",
      detail:
        modelFit === null
          ? "Trend fit could not be measured for this forecast."
          : modelFit >= 0.7
            ? "Recent APY follows a clear trend the model can project."
            : modelFit >= 0.4
              ? "Recent APY follows a weak trend, so projections stay close to average."
              : "No reliable trend was found, so the forecast holds recent levels flat.",
    });

    const coverage =
      Number.isFinite(inputs.historyCoverage) && Number.isFinite(inputs.coverageDecay)
        ? {
            historyCoverage: Math.max(0, Math.min(1, inputs.historyCoverage)),
            decay: Math.max(0, Math.min(1, inputs.coverageDecay)),
            reasons: Array.isArray(inputs.coverageReasons)
              ? inputs.coverageReasons.filter((reason): reason is string => typeof reason === "string")
              : [],
          }
        : null;
    const coverageDetail = coverage
      ? (describeCoverageReasons(coverage.reasons) ?? "history coverage is complete")
      : "history coverage could not be measured";
    factors.push({
      key: "history-coverage",
      label: "History coverage",
      value: coverage === null ? "unknown" : `${Math.round(coverage.historyCoverage * 100)}%`,
      impact:
        coverage === null
          ? "neutral"
          : coverage.reasons.length === 0
            ? "positive"
            : coverage.decay >= 0.7
              ? "neutral"
              : "negative",
      detail:
        coverage === null
          ? "History coverage could not be measured for this forecast."
          : `Coverage check: ${coverageDetail}.`,
    });
  }

  if (quorum) {
    const valid = Number.isFinite(quorum.validSourceCount) ? quorum.validSourceCount : 0;
    const total = Number.isFinite(quorum.totalSourceCount) ? quorum.totalSourceCount : 0;
    const required = Number.isFinite(quorum.requiredMinSources) ? quorum.requiredMinSources : 0;
    const isMet = quorum.isMet === true;
    factors.push({
      key: "source-quorum",
      label: "Source quorum",
      value: `${valid}/${Math.max(total, required)} valid`,
      impact: isMet ? "positive" : "negative",
      detail: isMet
        ? `${valid} of ${total} sources are fresh and valid, meeting the quorum of ${required}.`
        : total === 0
          ? "No sources were provided, so quorum cannot be met."
          : `Only ${valid} of ${total} sources are valid (quorum needs ${required}).`,
    });
  }

  return factors;
}

// ── Level + summary ─────────────────────────────────────────────────────────

function deriveLevel(
  confidence: number | null,
  quorum: QuorumStatus | null,
  coverageReasons: string[],
): ConfidenceLevel {
  const totalSources = quorum?.totalSourceCount ?? 0;
  if (quorum && totalSources === 0) return "unknown";
  if (confidence === null && !quorum) return "unknown";
  if (quorum && quorum.isMet !== true) return "low";
  if (coverageReasons.includes("no_history")) return "low";
  if (confidence !== null && confidence < 0.35) return "low";
  if (
    coverageReasons.length > 0 ||
    (quorum && (quorum.staleSourceCount > 0 || quorum.failingSourceCount > 0)) ||
    (confidence !== null && confidence < 0.65)
  ) {
    return "reduced";
  }
  return "high";
}

function buildSummary(
  protocol: string,
  level: ConfidenceLevel,
  quorum: QuorumStatus | null,
  coverageReasons: string[],
): string {
  switch (level) {
    case "unknown":
      return `No source data is available for ${protocol}, so APY confidence cannot be assessed.`;
    case "low": {
      const coverage = describeCoverageReasons(coverageReasons);
      const quorumPart =
        quorum && quorum.isMet !== true
          ? `quorum is not met (${quorum.validSourceCount} of ${quorum.totalSourceCount} sources valid)`
          : null;
      const cause = [quorumPart, coverage ? `and ${coverage}` : null]
        .filter((part): part is string => part !== null)
        .join(" ")
        .trim();
      return `APY confidence is low for ${protocol}: ${cause === "" ? "too few reliable signals" : cause}. Treat the forecast as indicative only.`;
    }
    case "reduced": {
      const coverage = describeCoverageReasons(coverageReasons);
      const stalePart =
        quorum && quorum.staleSourceCount > 0
          ? `${quorum.staleSourceCount} stale source${quorum.staleSourceCount === 1 ? "" : "s"}`
          : null;
      const failingPart =
        quorum && quorum.failingSourceCount > 0
          ? `${quorum.failingSourceCount} failing source${quorum.failingSourceCount === 1 ? "" : "s"}`
          : null;
      const parts = [stalePart, failingPart, coverage].filter(
        (part): part is string => part !== null,
      );
      return `APY confidence is reduced for ${protocol}${parts.length > 0 ? `: ${parts.join("; ")}` : ""}. The forecast band is widened accordingly.`;
    }
    default: {
      const count =
        quorum && quorum.totalSourceCount > 0
          ? ` with ${quorum.validSourceCount} of ${quorum.totalSourceCount} sources in agreement`
          : "";
      return `APY confidence is high for ${protocol}${count}.`;
    }
  }
}

// ── Public builder ──────────────────────────────────────────────────────────

export function buildApyConfidenceExplanation(
  input: ConfidenceExplanationInput,
): ApyConfidenceExplanation {
  const protocol = normalizeString(input.protocol, "unknown-protocol");
  const confidence = normalizeRatio(input.confidence);
  const forecastApy = normalizeApy(input.forecastApy);

  const rawInputs = input.confidenceInputs as Partial<ConfidenceInputs> | null | undefined;
  const confidenceInputs: ConfidenceInputs | null =
    rawInputs !== null &&
    typeof rawInputs === "object" &&
    Number.isFinite((rawInputs as { volatilityPct?: unknown }).volatilityPct)
      ? {
          volatilityPct: Number(rawInputs.volatilityPct),
          dataCompleteness: Number.isFinite(rawInputs.dataCompleteness)
            ? Number(rawInputs.dataCompleteness)
            : 0,
          modelFit: Number.isFinite(rawInputs.modelFit) ? Number(rawInputs.modelFit) : 0,
          historyCoverage: Number.isFinite(rawInputs.historyCoverage)
            ? Number(rawInputs.historyCoverage)
            : 1,
          coverageDecay: Number.isFinite(rawInputs.coverageDecay)
            ? Number(rawInputs.coverageDecay)
            : 1,
          coverageReasons: Array.isArray(rawInputs.coverageReasons)
            ? rawInputs.coverageReasons.filter(
                (reason): reason is string => typeof reason === "string",
              )
            : [],
        }
      : null;

  const rawQuorum = input.quorumStatus as Partial<QuorumStatus> | null | undefined;
  const rawEvaluated = (rawQuorum as { evaluatedSources?: unknown } | null | undefined)
    ?.evaluatedSources;
  const evaluatedSources = Array.isArray(rawEvaluated)
    ? rawEvaluated.filter(
        (source): source is QuorumStatus["evaluatedSources"][number] =>
          source !== null && typeof source === "object",
      )
    : null;
  const quorum: QuorumStatus | null =
    rawQuorum !== null &&
    typeof rawQuorum === "object" &&
    evaluatedSources !== null
      ? {
          isMet: (rawQuorum as { isMet?: unknown }).isMet === true,
          protocol: normalizeString(
            (rawQuorum as { protocol?: unknown }).protocol,
            protocol,
          ),
          requiredMinSources: Number.isFinite(
            (rawQuorum as { requiredMinSources?: unknown }).requiredMinSources,
          )
            ? Number((rawQuorum as { requiredMinSources?: unknown }).requiredMinSources)
            : 0,
          validSourceCount: Number.isFinite(
            (rawQuorum as { validSourceCount?: unknown }).validSourceCount,
          )
            ? Number((rawQuorum as { validSourceCount?: unknown }).validSourceCount)
            : 0,
          totalSourceCount: evaluatedSources.length,
          freshSourceCount: Number.isFinite(
            (rawQuorum as { freshSourceCount?: unknown }).freshSourceCount,
          )
            ? Number((rawQuorum as { freshSourceCount?: unknown }).freshSourceCount)
            : 0,
          staleSourceCount: Number.isFinite(
            (rawQuorum as { staleSourceCount?: unknown }).staleSourceCount,
          )
            ? Number((rawQuorum as { staleSourceCount?: unknown }).staleSourceCount)
            : 0,
          failingSourceCount: Number.isFinite(
            (rawQuorum as { failingSourceCount?: unknown }).failingSourceCount,
          )
            ? Number((rawQuorum as { failingSourceCount?: unknown }).failingSourceCount)
            : 0,
          maxAllowedAgeSeconds: Number.isFinite(
            (rawQuorum as { maxAllowedAgeSeconds?: unknown }).maxAllowedAgeSeconds,
          )
            ? Number((rawQuorum as { maxAllowedAgeSeconds?: unknown }).maxAllowedAgeSeconds)
            : 0,
          reasons: Array.isArray((rawQuorum as { reasons?: unknown }).reasons)
            ? ((rawQuorum as { reasons?: unknown }).reasons as unknown[]).filter(
                (reason): reason is string => typeof reason === "string",
              )
            : [],
          evaluatedSources,
        }
      : null;

  const coverageReasons = confidenceInputs?.coverageReasons ?? [];
  const level = deriveLevel(confidence, quorum, coverageReasons);
  const quorumMet = quorum?.isMet === true;

  const sources = (quorum?.evaluatedSources ?? [])
    .map((source) => explainSource(source, forecastApy))
    .sort((a, b) => a.provider.localeCompare(b.provider));

  return {
    protocol,
    level,
    confidence,
    forecastApy,
    quorumMet,
    summary: buildSummary(protocol, level, quorum, coverageReasons),
    sources,
    factors: explainFactors(confidenceInputs, quorum),
  };
}
