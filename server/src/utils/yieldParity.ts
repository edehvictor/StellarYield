/**
 * Parity checks between market-feed normalization and portfolio summaries.
 *
 * Both sides are supposed to speak the yield normalization contract
 * (`yieldNormalizationContract.ts`). This module proves it for a concrete pair
 * of snapshots and, when they disagree, says *why* — a unit slip reads very
 * differently from a double-rounding slip, and the fix is different too.
 */

import {
  APY_ULP,
  USD_ULP,
  YIELD_NORMALIZATION_CONTRACT,
  decimalsOf,
  isAtApyPrecision,
  isAtUsdPrecision,
} from "./yieldNormalizationContract";

export type YieldParityCode =
  /** Protocol present in the feed but absent from the summary. */
  | "MISSING_IN_SUMMARY"
  /** Protocol present in the summary but absent from the feed. */
  | "MISSING_IN_FEED"
  /** One side is in bps (or a fraction) while the other is in percent. */
  | "UNIT_MISMATCH"
  /** A value carries more decimals than the contract allows. */
  | "PRECISION_MISMATCH"
  /** Values agree to within an ulp but are not equal — double/asymmetric rounding. */
  | "ROUNDING_MISMATCH"
  /** Values disagree by more than an ulp and units do not explain it. */
  | "VALUE_MISMATCH"
  /** One side is null/NaN/Infinity where the other carries a number. */
  | "NON_FINITE";

export type ParityMeasure = "apy" | "usd";

export interface YieldParityIssue {
  code: YieldParityCode;
  /** Protocol the disagreement belongs to. */
  protocol: string;
  /** Field compared, e.g. "totalApy". */
  field: string;
  measure: ParityMeasure;
  feedValue: number | null;
  summaryValue: number | null;
  /** summary - feed, or null when one side is missing. */
  delta: number | null;
  /** What disagrees, in numbers. */
  message: string;
  /** What a contributor should change to make it agree. */
  remediation: string;
}

export interface YieldParityReport {
  contractVersion: string;
  checkedAt: string;
  feedCount: number;
  summaryCount: number;
  comparedProtocols: string[];
  comparedFields: string[];
  inParity: boolean;
  issueCount: number;
  issues: YieldParityIssue[];
}

/**
 * The subset of a yield record that both the feed and a portfolio summary are
 * expected to agree on. Extra fields on either side are ignored.
 */
export interface ComparableYield {
  protocol: string;
  apy: number;
  rewardApy: number;
  totalApy: number;
  netApy: number;
  tvl?: number;
}

interface FieldSpec {
  field: keyof Omit<ComparableYield, "protocol">;
  measure: ParityMeasure;
  optional?: boolean;
}

const COMPARED_FIELDS: FieldSpec[] = [
  { field: "apy", measure: "apy" },
  { field: "rewardApy", measure: "apy" },
  { field: "totalApy", measure: "apy" },
  { field: "netApy", measure: "apy" },
  { field: "tvl", measure: "usd", optional: true },
];

const ULP: Record<ParityMeasure, number> = { apy: APY_ULP, usd: USD_ULP };
const TOLERANCE: Record<ParityMeasure, number> = {
  apy: YIELD_NORMALIZATION_CONTRACT.apy.tolerance,
  usd: YIELD_NORMALIZATION_CONTRACT.usd.tolerance,
};
const DECIMALS: Record<ParityMeasure, number> = {
  apy: YIELD_NORMALIZATION_CONTRACT.apy.decimals,
  usd: YIELD_NORMALIZATION_CONTRACT.usd.decimals,
};

const atPrecision = (measure: ParityMeasure, value: number): boolean =>
  measure === "apy" ? isAtApyPrecision(value) : isAtUsdPrecision(value);

/**
 * Recognises the scale factors that a unit slip actually produces:
 * percent read as bps (x100), percent read as a fraction (x0.01), and bps read
 * as a fraction (x0.0001) — plus their inverses.
 */
function detectUnitSlip(feedValue: number, summaryValue: number): string | null {
  if (feedValue === 0 || summaryValue === 0) return null;

  const ratio = summaryValue / feedValue;
  const candidates: Array<{ factor: number; describe: string }> = [
    { factor: 100, describe: "the summary is in basis points while the feed is in percent" },
    { factor: 0.01, describe: "the summary is a fraction (percent / 100) while the feed is in percent" },
    { factor: 10_000, describe: "the summary is in basis points while the feed is a fraction" },
    { factor: 0.0001, describe: "the summary is a fraction while the feed is in basis points" },
  ];

  for (const { factor, describe } of candidates) {
    // 1 % relative slack so a unit slip is still recognised when the two sides
    // also differ by a rounding step.
    if (Math.abs(ratio - factor) <= Math.abs(factor) * 0.01) return describe;
  }
  return null;
}

function compareField(
  protocol: string,
  spec: FieldSpec,
  feedValue: number | undefined,
  summaryValue: number | undefined,
): YieldParityIssue | null {
  const { field, measure } = spec;

  if (feedValue === undefined && summaryValue === undefined) return null;

  if (feedValue === undefined || summaryValue === undefined) {
    if (spec.optional) return null;
    const missingSide = feedValue === undefined ? "feed" : "summary";
    return {
      code: missingSide === "feed" ? "MISSING_IN_FEED" : "MISSING_IN_SUMMARY",
      protocol,
      field,
      measure,
      feedValue: feedValue ?? null,
      summaryValue: summaryValue ?? null,
      delta: null,
      message: `${protocol}.${field} is absent from the ${missingSide} snapshot.`,
      remediation: `Emit ${field} from the ${missingSide} path, or drop it from COMPARED_FIELDS if it is genuinely not part of the contract.`,
    };
  }

  if (!Number.isFinite(feedValue) || !Number.isFinite(summaryValue)) {
    return {
      code: "NON_FINITE",
      protocol,
      field,
      measure,
      feedValue: Number.isFinite(feedValue) ? feedValue : null,
      summaryValue: Number.isFinite(summaryValue) ? summaryValue : null,
      delta: null,
      message: `${protocol}.${field} is not finite (feed=${feedValue}, summary=${summaryValue}).`,
      remediation:
        "Guard the division or aggregation that produced NaN/Infinity — a zero TVL or an empty position set is the usual cause — and emit 0 or omit the protocol instead.",
    };
  }

  const decimals = DECIMALS[measure];
  const delta = summaryValue - feedValue;
  const absDelta = Math.abs(delta);

  // Units are checked before precision on purpose: a value that is still a
  // fraction (0.0776 instead of 7.76) also violates the precision rule, and
  // reporting it as "too many decimals" would send a contributor chasing the
  // rounding call instead of the missing conversion.
  const unitSlip =
    absDelta >= TOLERANCE[measure] ? detectUnitSlip(feedValue, summaryValue) : null;
  if (unitSlip) {
    return {
      code: "UNIT_MISMATCH",
      protocol,
      field,
      measure,
      feedValue,
      summaryValue,
      delta,
      message: `${protocol}.${field}: feed=${feedValue}, summary=${summaryValue} — ${unitSlip}.`,
      remediation: `Convert at the boundary with ${measure === "apy" ? "bpsToApyPercent()" : "normalizeUsd()"} instead of an inline factor, and keep the value in ${YIELD_NORMALIZATION_CONTRACT[measure].unit} for the whole pipeline.`,
    };
  }

  const feedPrecise = atPrecision(measure, feedValue);
  const summaryPrecise = atPrecision(measure, summaryValue);

  // Checked even when the two sides agree: emitting more decimals than the
  // contract allows is a violation on its own, and the next consumer to round
  // it is the one that will disagree.
  if (!feedPrecise || !summaryPrecise) {
    const offender = !feedPrecise ? "feed" : "summary";
    const offendingValue = !feedPrecise ? feedValue : summaryValue;
    return {
      code: "PRECISION_MISMATCH",
      protocol,
      field,
      measure,
      feedValue,
      summaryValue,
      delta,
      message: `${protocol}.${field} carries ${decimalsOf(offendingValue)} decimals on the ${offender} side (${offendingValue}); the contract allows ${decimals}.`,
      remediation: `Pass the ${offender} value through ${measure === "apy" ? "normalizeApyPercent()" : "normalizeUsd()"} before emitting it.`,
    };
  }

  if (absDelta < TOLERANCE[measure]) return null;

  if (absDelta <= ULP[measure] + 1e-9) {
    return {
      code: "ROUNDING_MISMATCH",
      protocol,
      field,
      measure,
      feedValue,
      summaryValue,
      delta,
      message: `${protocol}.${field}: feed=${feedValue}, summary=${summaryValue} — differ by ${absDelta.toFixed(decimals + 2)}, one step at ${decimals} decimals.`,
      remediation:
        "One side is rounding an already-rounded value, or is using Math.round (half-up) instead of the contract's half-away-from-zero. Aggregate at full precision and round once, at the point the value is emitted.",
    };
  }

  return {
    code: "VALUE_MISMATCH",
    protocol,
    field,
    measure,
    feedValue,
    summaryValue,
    delta,
    message: `${protocol}.${field}: feed=${feedValue}, summary=${summaryValue} — differ by ${delta > 0 ? "+" : ""}${delta.toFixed(decimals)}, beyond one rounding step.`,
    remediation:
      "The two paths are computing different quantities, not merely rounding them differently. Check that the summary is reading the same snapshot (same ledger sequence) and applying the same fee/reward components as the feed.",
  };
}

/**
 * Compares a market-feed snapshot against a portfolio-summary snapshot and
 * reports every field on which they disagree.
 */
export function checkYieldParity(
  feed: ReadonlyArray<ComparableYield>,
  summary: ReadonlyArray<ComparableYield>,
): YieldParityReport {
  const feedByProtocol = new Map(feed.map((entry) => [entry.protocol, entry]));
  const summaryByProtocol = new Map(summary.map((entry) => [entry.protocol, entry]));

  const protocols = Array.from(
    new Set([...feedByProtocol.keys(), ...summaryByProtocol.keys()]),
  ).sort();

  const issues: YieldParityIssue[] = [];

  for (const protocol of protocols) {
    const feedEntry = feedByProtocol.get(protocol);
    const summaryEntry = summaryByProtocol.get(protocol);

    if (!feedEntry || !summaryEntry) {
      const missingSide = feedEntry ? "summary" : "feed";
      issues.push({
        code: feedEntry ? "MISSING_IN_SUMMARY" : "MISSING_IN_FEED",
        protocol,
        field: "*",
        measure: "apy",
        feedValue: null,
        summaryValue: null,
        delta: null,
        message: `${protocol} appears in the ${feedEntry ? "feed" : "summary"} but not in the ${missingSide}.`,
        remediation: `Reconcile the protocol set before comparing: either the ${missingSide} filtered ${protocol} out (check freeze/allow-lists) or the two snapshots were taken at different times.`,
      });
      continue;
    }

    for (const spec of COMPARED_FIELDS) {
      const issue = compareField(
        protocol,
        spec,
        feedEntry[spec.field],
        summaryEntry[spec.field],
      );
      if (issue) issues.push(issue);
    }
  }

  return {
    contractVersion: YIELD_NORMALIZATION_CONTRACT.version,
    checkedAt: new Date().toISOString(),
    feedCount: feed.length,
    summaryCount: summary.length,
    comparedProtocols: protocols,
    comparedFields: COMPARED_FIELDS.map((s) => s.field),
    inParity: issues.length === 0,
    issueCount: issues.length,
    issues,
  };
}

/**
 * Renders a parity report as an assertion message. Used by the parity tests so
 * a failure names the protocol, the field, both values and the fix rather than
 * printing "expected true, received false".
 */
export function formatParityReport(report: YieldParityReport): string {
  if (report.inParity) {
    return `Yield parity OK (contract v${report.contractVersion}): ${report.comparedProtocols.length} protocol(s) x ${report.comparedFields.length} field(s) agree.`;
  }

  const lines = [
    `Yield normalization parity FAILED (contract v${report.contractVersion}) — ${report.issueCount} issue(s):`,
    "",
  ];

  for (const issue of report.issues) {
    lines.push(`  [${issue.code}] ${issue.message}`);
    lines.push(`      fix: ${issue.remediation}`);
  }

  lines.push("");
  lines.push("  Contract: server/docs/yield-normalization-contract.md");
  return lines.join("\n");
}
